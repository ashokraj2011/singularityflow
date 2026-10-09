import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { recreateAndSyncConfiguration } from '../src/configuration-recreate-sync.mjs';
import { replayConfigurationIntent, replayConfigurationJson, replayConfigurationYaml } from '../src/configuration-intent-replay.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { run } from '../src/util.mjs';

test('intent replay keeps new approved policy and ignores old YAML formatting churn', () => {
  const result = replayConfigurationYaml('description: >-\n  Old text\nworkTypes: {}\n',
    'description: Old text\nworkTypes:\n  demo:\n    phases: [testing, verification]\n',
    '# keep this comment\ndescription: New text\nworkTypes:\n  other: {phases: [testing]}\n');
  assert.equal(result.value.description, 'New text');
  assert.deepEqual(Object.keys(result.value.workTypes), ['other', 'demo']);
  assert.match(result.text, /# keep this comment/u);
  assert.deepEqual(result.replacements, []);
});

test('explicit proposal edits win at changed leaves, not entire settings or sibling workflows', () => {
  const result = replayConfigurationIntent({ settings: { a: 1, b: 1 }, list: [1] },
    { settings: { a: 2, b: 1 }, list: [2] }, { settings: { a: 3, b: 4, c: 5 }, list: [3] });
  assert.deepEqual(result.value, { settings: { a: 2, b: 4, c: 5 }, list: [2] });
  assert.deepEqual(result.replacements, ['/settings/a', '/list']);
});

test('deletions, null, false, arrays and prototype-shaped keys retain their exact meaning', () => {
  const result = replayConfigurationIntent(JSON.parse('{"remove":1,"false":true,"null":1}'),
    JSON.parse('{"false":false,"null":null,"__proto__":{"safe":true}}'), { remove: 2, false: true, null: 1, extra: 5 });
  assert.equal(Object.hasOwn(result.value, 'remove'), false);
  assert.equal(result.value.false, false);
  assert.equal(result.value.null, null);
  assert.equal(result.value.extra, 5);
  assert.deepEqual(Object.getOwnPropertyDescriptor(result.value, '__proto__').value, { safe: true });
  assert.equal({}.safe, undefined);
});

test('JSON replay requires exact JSON syntax and retains unrelated current fields', () => {
  assert.deepEqual(replayConfigurationJson('{"a":1}', '{"a":2}', '{"a":3,"b":4}').value, { a: 2, b: 4 });
  assert.throws(() => replayConfigurationJson('{}', 'a: 2', '{}'), SyntaxError);
});

async function fixture(t, { filtered = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-recreate-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const seed = path.join(base, 'seed');
  const remote = path.join(base, 'authority.git');
  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Configuration Owner'], { cwd: seed });
  run('git', ['config', 'user.email', 'owner@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  await writeFile(path.join(seed, 'app.txt'), 'application source must not change\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote]);
  if (filtered) run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  const baseline = run('git', ['rev-parse', 'HEAD'], { cwd: seed }).stdout.trim();
  const branch = 'sflow/config-change/workflow/create-workflow-demo-old';
  const file = path.join(seed, 'singularity/workflow.yml');
  const original = YAML.parse(await readFile(file, 'utf8'));
  const proposed = structuredClone(original);
  proposed.workTypes.demo = { label: 'Demo', phases: ['testing', 'verification'] };
  await writeFile(file, YAML.stringify(proposed));
  run('git', ['add', file], { cwd: seed });
  run('git', ['commit', '-qm', 'pending demo'], { cwd: seed });
  const proposal = run('git', ['rev-parse', 'HEAD'], { cwd: seed }).stdout.trim();
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: seed });
  // A separate new approved commit modifies the same YAML insertion point.
  run('git', ['switch', '-q', '-c', 'approved-current', baseline], { cwd: seed });
  const current = structuredClone(original);
  current.workTypes.newer = { label: 'Newer', phases: ['testing', 'verification'] };
  await writeFile(file, YAML.stringify(current));
  run('git', ['add', file], { cwd: seed });
  run('git', ['commit', '-qm', 'new approved workflow'], { cwd: seed });
  const approved = run('git', ['rev-parse', 'HEAD'], { cwd: seed }).stdout.trim();
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  const caller = path.join(base, 'caller');
  run('git', ['clone', '-q', '-b', 'main', remote, caller]);
  run('git', ['config', 'user.name', 'Configuration Owner'], { cwd: caller });
  run('git', ['config', 'user.email', 'owner@example.test'], { cwd: caller });
  await writeFile(path.join(caller, 'app.txt'), 'dirty application bytes\n');
  run('git', ['add', 'app.txt'], { cwd: caller });
  return { base, seed, remote, caller, branch, proposal, approved, original };
}

const remoteHead = (item, ref = 'sflow/config') => run('git', ['--git-dir', item.remote, 'rev-parse', ref]).stdout.trim();
const callerState = item => [run('git', ['rev-parse', 'HEAD'], { cwd: item.caller }).stdout,
  run('git', ['write-tree'], { cwd: item.caller }).stdout,
  run('git', ['status', '--porcelain=v1'], { cwd: item.caller }).stdout];

test('preview reconstructs conflicting intent without updating any remote ref or caller bytes', async t => {
  const item = await fixture(t);
  const before = callerState(item);
  const result = await recreateAndSyncConfiguration(item.caller);
  assert.equal(result.status, 'preview');
  assert.ok(result.files.includes('singularity/workflow.yml'));
  assert.equal(remoteHead(item), item.approved);
  assert.equal(remoteHead(item, item.branch), item.proposal);
  assert.deepEqual(callerState(item), before);
  assert.equal(await readFile(path.join(item.caller, 'app.txt'), 'utf8'), 'dirty application bytes\n');
});

test('one apply fast-forwards without a merge, atomically archives and retires proposals, and retries safely', async t => {
  const item = await fixture(t);
  const before = callerState(item);
  const result = await recreateAndSyncConfiguration(item.caller, { apply: true });
  assert.equal(result.status, 'synced', JSON.stringify(result));
  assert.equal(remoteHead(item), result.targetCommit);
  const parents = run('git', ['--git-dir', item.remote, 'show', '-s', '--format=%P', 'sflow/config']).stdout.trim();
  assert.equal(parents, item.approved, 'one descendant commit, not a Git merge');
  const definition = YAML.parse(run('git', ['--git-dir', item.remote, 'show', 'sflow/config:singularity/workflow.yml']).stdout);
  assert.deepEqual(definition.workTypes.demo.phases, ['testing', 'verification']);
  assert.ok(definition.workTypes.newer);
  assert.notEqual(run('git', ['--git-dir', item.remote, 'show-ref', '--verify', `refs/heads/${item.branch}`], { allowFailure: true }).status, 0);
  for (const backup of result.backupRefs) assert.equal(remoteHead(item, backup.ref), backup.commit);
  assert.deepEqual(callerState(item), before);
  assert.equal(run('git', ['--git-dir', item.remote, 'show', 'sflow/config:app.txt']).stdout, 'application source must not change\n');
  const second = await recreateAndSyncConfiguration(item.caller, { apply: true });
  assert.equal(second.status, 'current');
  assert.equal(second.targetCommit, result.targetCommit);
});

test('server rejection preserves config, original proposal and caller; no misleading success', async t => {
  const item = await fixture(t);
  const before = callerState(item);
  const result = await recreateAndSyncConfiguration(item.caller, { apply: true,
    runRemoteCommand: (args, options) => args[0] === 'push'
      ? Promise.resolve({ status: 1, failure: { advice: 'Branch protection requires server review.' } })
      : runRemoteGitAsync(args, options) });
  assert.equal(result.status, 'not-synced');
  assert.equal(remoteHead(item), item.approved);
  assert.equal(remoteHead(item, item.branch), item.proposal);
  assert.deepEqual(callerState(item), before);
  assert.match(result.failure.message, /Branch protection/u);
});

test('partial recreation never downloads application blobs or runs worktree filters', async t => {
  const item = await fixture(t, { filtered: true });
  const applicationBlob = run('git', ['--git-dir', item.remote, 'rev-parse', 'sflow/config:app.txt']).stdout.trim();
  let stillMissing = false;
  const result = await recreateAndSyncConfiguration(item.caller, { apply: true,
    runRemoteCommand: async (args, options) => {
      if (args[0] === 'push') {
        const objects = run('git', ['rev-list', '--objects', '--missing=print', 'HEAD'], { cwd: options.cwd }).stdout;
        stillMissing = objects.split('\n').includes(`?${applicationBlob}`);
      }
      return runRemoteGitAsync(args, options);
    } });
  assert.equal(result.status, 'synced');
  assert.equal(stillMissing, true, 'no application blob was read, materialized, staged or validated');
});

test('the public CLI previews in JSON without starting a separate approval or mutation flow', async t => {
  const item = await fixture(t);
  const before = callerState(item);
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const output = run(process.execPath, [cli, 'configuration', 'recreate-sync', '--json'],
    { cwd: item.caller, timeoutMs: 30_000 });
  const result = JSON.parse(output.stdout);
  assert.equal(result.resultType, 'sflow-configuration-recreate-sync');
  assert.equal(result.status, 'preview');
  assert.equal(remoteHead(item), item.approved);
  assert.deepEqual(callerState(item), before);
});

test('a concurrent proposal update rejects the entire atomic transaction, including backup installation', async t => {
  const item = await fixture(t);
  const before = callerState(item);
  const result = await recreateAndSyncConfiguration(item.caller, { apply: true,
    runRemoteCommand: async (args, options) => {
      if (args[0] === 'push') run('git', ['--git-dir', item.remote, 'update-ref',
        `refs/heads/${item.branch}`, item.approved, item.proposal]);
      return runRemoteGitAsync(args, options);
    } });
  assert.equal(result.status, 'not-synced');
  assert.equal(remoteHead(item), item.approved);
  assert.equal(remoteHead(item, item.branch), item.approved, 'concurrent owner edit preserved');
  for (const backup of result.backupRefs) assert.notEqual(run('git', ['--git-dir', item.remote,
    'show-ref', '--verify', backup.ref], { allowFailure: true }).status, 0, 'no partial backup update');
  assert.deepEqual(callerState(item), before);
});

test('lost push acknowledgement reconciles exact remote config, backups and retirement', async t => {
  const item = await fixture(t);
  const result = await recreateAndSyncConfiguration(item.caller, { apply: true,
    runRemoteCommand: async (args, options) => {
      const result = await runRemoteGitAsync(args, options);
      return args[0] === 'push' ? { ...result, status: 1 } : result;
    } });
  assert.equal(result.status, 'synced');
  assert.equal(result.reconciled, true);
});

test('a proposal containing application changes is refused without any remote updates', async t => {
  const item = await fixture(t);
  run('git', ['switch', '-q', '-c', 'unsafe-proposal', item.proposal], { cwd: item.seed });
  await writeFile(path.join(item.seed, 'app.txt'), 'must never replay this\n');
  run('git', ['add', 'app.txt'], { cwd: item.seed });
  run('git', ['commit', '-qm', 'out of scope'], { cwd: item.seed });
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${item.branch}`], { cwd: item.seed });
  await assert.rejects(recreateAndSyncConfiguration(item.caller, { apply: true }), /non-configuration path/u);
  assert.equal(remoteHead(item), item.approved);
});

test('unsafe symlinks are refused before any configuration bytes or refs can be replaced', async t => {
  const item = await fixture(t);
  run('git', ['switch', '-q', '-c', 'symlink-proposal', item.proposal], { cwd: item.seed });
  const { symlink } = await import('node:fs/promises');
  await symlink('app.txt', path.join(item.seed, 'singularity/unsafe-link.md'));
  run('git', ['add', 'singularity/unsafe-link.md'], { cwd: item.seed });
  run('git', ['commit', '-qm', 'unsafe link'], { cwd: item.seed });
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${item.branch}`], { cwd: item.seed });
  await assert.rejects(recreateAndSyncConfiguration(item.caller, { apply: true }), /regular file/u);
  assert.equal(remoteHead(item), item.approved);
});

test('all proposal kinds and custom skill/instruction assets survive recreation together', async t => {
  const item = await fixture(t);
  run('git', ['switch', '-q', '-c', 'custom-assets', item.approved], { cwd: item.seed });
  await mkdir(path.join(item.seed, 'singularity/instruction-library/demo'), { recursive: true });
  await writeFile(path.join(item.seed, 'singularity/instruction-library/demo/INSTRUCTIONS.md'),
    '---\nname: demo\ndescription: Demo conventions\n---\n\nPreserve the custom instructions.\n');
  run('git', ['add', 'singularity/instruction-library'], { cwd: item.seed });
  run('git', ['commit', '-qm', 'custom capability assets'], { cwd: item.seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config-change/capability/custom-assets'], { cwd: item.seed });
  const result = await recreateAndSyncConfiguration(item.caller, { apply: true });
  assert.equal(result.status, 'synced', JSON.stringify(result));
  assert.equal(result.proposals.length, 2);
  assert.match(run('git', ['--git-dir', item.remote, 'show',
    'sflow/config:singularity/instruction-library/demo/INSTRUCTIONS.md']).stdout, /Preserve the custom instructions/u);
});
