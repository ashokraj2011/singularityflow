/**
 * SPEC-OAP M3, owner decision 5: `push retry` folds into `sync`. One command finishes what was not
 * published: the Story's retained commit, then every saved push of the repository that can still
 * land. `sync <INTENT-ID>` retries exactly one; `push retry <INTENT-ID>` stays as its alias.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { createTransportIntent, readTransportIntent, retryTransportIntent } from '../src/transport-intents.mjs';
import { skillForCommandLine } from '../src/command-skills.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');

function run(command, args, cwd, { env = process.env, fail = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A repository and its bare remote, with a private outbox for this test's saved pushes. */
async function repository(prefix) {
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '-q', '--bare', remote], base);
  run('git', ['init', '-q', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Publisher'], root);
  run('git', ['config', 'user.email', 'publisher@example.test'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# sync\n');
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Publisher',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox')
  };
  const flow = (args, options = {}) => run(process.execPath, [bin, '--no-model', ...args], options.cwd ?? root, { env, ...options });
  return { base, root, remote, env, flow, options: { env, home: os.homedir() } };
}

/** A commit that lives only in this checkout, as a configuration proposal's does. */
function looseCommit(root, message) {
  const tree = run('git', ['write-tree'], root).stdout.trim();
  return run('git', ['commit-tree', tree, '-m', message], root).stdout.trim();
}

async function savedPush(item, targetRef, operation, sourceCommit = looseCommit(item.root, targetRef)) {
  return createTransportIntent({
    repositoryRoot: item.root, sourceCommit, targetRef, expectedRemote: null, scope: { operation }
  }, item.options);
}

const remoteHead = (item, ref) => run('git', ['--git-dir', item.remote, 'rev-parse', '--verify', '--quiet', ref], item.base, { fail: true }).stdout.trim();

test('sync publishes the Story\'s retained commit, then the repository\'s saved push, in one run', async (t) => {
  const item = await repository('sflow-oap-m3-sync-');
  t.after(() => rm(item.base, { recursive: true, force: true }));
  item.flow(['init']);
  const configPath = path.join(item.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], item.root);
  run('git', ['commit', '-qm', 'init'], item.root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], item.root);
  item.flow(['start', 'SYNC-1', '--from-branch', 'main']);
  const artifact = path.join(item.root, 'singularity/work-items/SYNC-1/artifacts/intake/intake.md');
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Publish the retained commit and the saved proposal together.'));
  // The remote refuses the Story's push, so its commit is retained on this computer.
  const refuse = path.join(item.remote, 'hooks/pre-receive');
  await writeFile(refuse, '#!/bin/sh\nexit 1\n');
  await chmod(refuse, 0o755);
  assert.notEqual(item.flow(['phase', 'publish', 'intake'], { fail: true }).status, 0);
  const retained = run('git', ['rev-parse', 'HEAD'], item.root).stdout.trim();
  assert.notEqual(remoteHead(item, 'refs/heads/SYNC-1'), retained, 'the Story commit is not on the remote yet');
  // A workflow proposal saved on this computer whose upload never ran.
  const proposal = await savedPush(item, 'refs/heads/sflow/config-change/sync-demo', 'sflow.configuration.workflow.propose');
  assert.equal(proposal.status, 'pending');
  await rm(refuse);

  const synced = item.flow(['sync']).stdout;
  assert.match(synced, new RegExp(`Pushed ${retained.slice(0, 8)} to origin/SYNC-1\\.`, 'u'));
  assert.match(synced, new RegExp(`Published the workflow proposal to sflow/config-change/sync-demo \\(commit ${proposal.sourceCommit.slice(0, 12)}, ${proposal.intentId}\\)\\.`, 'u'));
  assert.ok(synced.indexOf('Pushed ') < synced.indexOf('Published the '), 'the Story first, then the saved pushes');
  assert.equal(remoteHead(item, 'refs/heads/SYNC-1'), retained);
  assert.equal(remoteHead(item, 'refs/heads/sflow/config-change/sync-demo'), proposal.sourceCommit);
  assert.equal((await readTransportIntent(proposal.intentId, item.options)).status, 'succeeded');

  // Nothing left: the next sync says so, and a landed push is not tried again.
  const again = JSON.parse(item.flow(['sync', '--json']).stdout);
  assert.equal(again.resultType, 'command-result');
  assert.equal(again.operation.id, 'sync');
  assert.equal(again.outcome.status, 'noop');
  assert.equal(again.data.story.workId, 'SYNC-1');
  assert.equal(again.data.story.status, 'no-op');
  assert.deepEqual(again.data.transports.retried, []);
});

test('sync <INTENT-ID> retries exactly that saved push, from any folder, and push retry is its alias', async (t) => {
  const item = await repository('sflow-oap-m3-one-');
  t.after(() => rm(item.base, { recursive: true, force: true }));
  run('git', ['add', '.'], item.root);
  run('git', ['commit', '-qm', 'first'], item.root);
  const first = await savedPush(item, 'refs/heads/sflow/config', 'sflow.configuration.people.add-current-identity');
  const second = await savedPush(item, 'refs/heads/sflow/config-change/second', 'sflow.configuration.workflow.import');
  const third = await savedPush(item, 'refs/heads/sflow/config-change/third', 'sflow.configuration.workflow.import');

  const one = JSON.parse(item.flow(['sync', first.intentId, '--json']).stdout);
  assert.equal(one.data.intent.intentId, first.intentId);
  assert.equal(one.data.intent.status, 'succeeded');
  assert.equal(remoteHead(item, 'refs/heads/sflow/config'), first.sourceCommit);
  for (const other of [second, third]) {
    assert.equal((await readTransportIntent(other.intentId, item.options)).status, 'pending', 'only the named push is retried');
    assert.equal(remoteHead(item, other.targetRef), '');
  }

  // No repository needs to be open: the push runs in the checkout it was saved in.
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'sflow-oap-m3-elsewhere-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  const outside = item.flow(['sync', second.intentId], { cwd: elsewhere }).stdout;
  assert.match(outside, new RegExp(`Transport ${second.intentId} is succeeded after the authorized retry\\.`, 'u'));
  assert.equal(remoteHead(item, second.targetRef), second.sourceCommit);

  // Scripts that call the older form keep working, with the same result.
  const alias = JSON.parse(item.flow(['push', 'retry', third.intentId, '--json']).stdout);
  assert.equal(alias.data.intent.intentId, third.intentId);
  assert.equal(alias.data.intent.status, 'succeeded');
  assert.equal(remoteHead(item, third.targetRef), third.sourceCommit);
});

test('outside a Story, sync retries the saved pushes; one that does not land names its one cause and sync <ID> as the fix', async (t) => {
  const item = await repository('sflow-oap-m3-fail-');
  t.after(() => rm(item.base, { recursive: true, force: true }));
  run('git', ['add', '.'], item.root);
  run('git', ['commit', '-qm', 'first'], item.root);
  // A pre-push check refuses application branches, as an office repository's husky hook does.
  const hook = path.join(item.root, '.git', 'hooks', 'pre-push');
  await writeFile(hook, '#!/bin/sh\necho "husky - pre-push hook exited with code 1 (npm run lint)" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  const hooked = await savedPush(item, 'refs/heads/feature/hooked', 'sflow.configuration.editor.publish');
  // A push the branch moved past can never land: sync leaves it alone.
  const moved = await savedPush(item, 'refs/heads/sflow/moved', 'sflow.initialize');
  run('git', ['push', '-q', '--no-verify', 'origin', `${looseCommit(item.root, 'someone else')}:refs/heads/sflow/moved`], item.root);
  assert.equal((await retryTransportIntent(moved.intentId, item.options)).status, 'remote-diverged');
  // An automatic caller stops at a refusal only a person can clear, and is routed to sync <ID>.
  assert.equal((await retryTransportIntent(hooked.intentId, item.options)).status, 'needs-user');
  await assert.rejects(retryTransportIntent(hooked.intentId, item.options), (error) => error.code === 'TRANSPORT_INTENT_NEEDS_USER'
    && error.details.nextAction.command === `singularity-flow sync ${hooked.intentId}`);

  // A plain sync, which agents run for a pending publication, never pushes it again: it names the
  // one cause and the person's own retry, sync <ID>, and spends no attempt.
  const human = item.flow(['sync']).stdout;
  assert.match(human, /No Story publication is pending here\./u);
  assert.match(human, new RegExp(`Waiting for you: the configuration change to feature/hooked \\(commit ${hooked.sourceCommit.slice(0, 12)}, ${hooked.intentId}\\) `
    + 'is needs-user\\. Git refused it \\(local-hook-failed: husky - pre-push hook exited with code 1 \\(npm run lint\\)\\)\\. Review the local Git hook output', 'u'));
  assert.match(human, new RegExp(`Once that is fixed, retry it:\\n\\s+- Copilot: /sf-push\\n\\s+- Shell: singularity-flow sync ${hooked.intentId}\\n`, 'u'));
  assert.doesNotMatch(human, /Nothing else is waiting to be published/u);
  assert.doesNotMatch(human, new RegExp(moved.intentId, 'u'), 'a push that can no longer land is not retried or listed');
  assert.equal((await readTransportIntent(hooked.intentId, item.options)).attempts.length, 1, 'a plain sync spent no attempt on it');

  const json = JSON.parse(item.flow(['sync', '--json']).stdout);
  assert.equal(json.subject, null);
  assert.equal(json.data.story.status, 'none');
  assert.deepEqual(json.data.transports.retried, []);
  assert.deepEqual(json.next.map((entry) => entry.command), [`singularity-flow sync ${hooked.intentId}`]);
  assert.equal(json.next[0].copilotCommand, '/sf-push');
  assert.deepEqual(json.data.transports.skipped.map((entry) => [entry.intentId, entry.status, entry.nextAction?.command ?? null]).sort(),
    [[hooked.intentId, 'needs-user', `singularity-flow sync ${hooked.intentId}`], [moved.intentId, 'remote-diverged', null]].sort());

  // The person's own retry, sync <ID>, carries the authority: still refused while the hook fails...
  const refused = JSON.parse(item.flow(['sync', hooked.intentId, '--json'], { fail: true }).stdout);
  assert.equal(refused.data.intent.status, 'needs-user', JSON.stringify(refused).slice(0, 600));
  assert.equal((await readTransportIntent(hooked.intentId, item.options)).attempts.length, 2, 'the person\'s retry spent one more attempt');
  // ...and once the hook is fixed, it publishes the same commit.
  await rm(hook);
  item.flow(['sync', hooked.intentId]);
  assert.equal(remoteHead(item, 'refs/heads/feature/hooked'), hooked.sourceCommit);
});

test('sync <INTENT-ID> is the saved-push retry on every surface: Copilot routes it to /sf-push, a Work ID stays /sf-next', () => {
  const intent = 'psh_7e94aa00-1111-2222-3333-444455556666';
  assert.equal(skillForCommandLine(`singularity-flow sync ${intent}`), 'sf-push');
  assert.equal(skillForCommandLine('singularity-flow sync PMC-1'), 'sf-next');
  assert.equal(skillForCommandLine('singularity-flow sync'), 'sf-next');
  assert.equal(safeCommandGuidance({ command: `singularity-flow sync ${intent}`, skill: '/sf-push' })?.copilotCommand, '/sf-push');
});

/**
 * Every place that tells a person how to retry a saved push names `sync <INTENT-ID>`. The alias keeps
 * only its own help (the synopsis line and the sentence saying it is the same command) and the
 * remediation planner's recognition of older saved records that still name it.
 */
test('no guidance names push retry except the alias\'s own help', async () => {
  const allowed = new Map([
    ['src/help-text.mjs', /^\s*singularity-flow push retry <INTENT-ID> \[--json\]$/u],
    ['src/help-pages.mjs', /push retry <INTENT-ID> is the',$/u],
    ['src/refusal-remediation.mjs', /^const RETAINED_RETRIES = Object\.freeze\(\[\['push', 'retry'\], \['sync'\]/u]
  ]);
  const found = [];
  for (const directory of ['src', 'apps/vscode/src', 'plugin/skills']) {
    const files = (await readdir(path.join(packageRoot, directory), { recursive: true }))
      .filter((name) => /\.(?:mjs|ts|md)$/u.test(name));
    for (const name of files) {
      const relative = `${directory}/${name.split(path.sep).join('/')}`;
      const lines = (await readFile(path.join(packageRoot, relative), 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (!/push retry|['"]push['"],\s*['"]retry['"]/u.test(line)) return;
        if (allowed.get(relative)?.test(line)) return;
        found.push(`${relative}:${index + 1}: ${line.trim()}`);
      });
    }
  }
  assert.deepEqual(found, []);
});
