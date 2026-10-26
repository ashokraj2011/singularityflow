/**
 * One Story, one checkout on this computer, found from anywhere.
 *
 * Seen on a Mac (2026-10-24): `status --work-id hex-2018`, run in Story hex-106's checkout, printed
 * hex-106. One workspace held two clones of its repository; a Story started in one was attached
 * again in the other, and the two copies drifted 21 commits apart. A second workspace cloned the
 * same repository and nothing stopped a Story being opened in both. The Story index
 * (src/story-index.mjs) records which checkout holds each workspace Story; every read checks it
 * against Git, and commands that name a Story run in its checkout or refuse (src/story-routing.mjs).
 *
 * The fixture: two workspaces cloning one bare remote, model-free lifecycle commands, and isolated
 * machine state (registry, selection, index) under the test's own directory.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { STORY_OPERAND_COMMANDS } from '../src/cli-entry.mjs';
import {
  applyWorkIdOperand, fileOperandIndexes, namedWorkId, rebaseFileOperands, rebaseFileOptions, STORY_OPERAND_COMMAND_NAMES,
  workIdOperandIndex
} from '../src/story-routing.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const canonical = (file) => realpathSync.native(file);

test('a command names its Story by --work-id or by the operand it declares, never both differently', () => {
  // The root dispatcher loads routing only for these commands (or --work-id); the two lists agree.
  assert.deepEqual([...STORY_OPERAND_COMMANDS].sort(), [...new Set(STORY_OPERAND_COMMAND_NAMES)].sort());
  assert.equal(workIdOperandIndex('status', ['status']), 1);
  assert.equal(workIdOperandIndex('decisions', ['decisions', 'record', 'S-1']), 2);
  assert.equal(workIdOperandIndex('decisions', ['decisions', 'S-1']), 1);
  assert.equal(workIdOperandIndex('story', ['story', 'test-policy', 'show', 'S-1']), 3);
  assert.equal(workIdOperandIndex('decision', ['decision', 'show', 'S-1']), 2);
  assert.equal(workIdOperandIndex('phase', ['phase', 'enter', 'design']), null, 'a phase operand is not a Story');
  assert.equal(workIdOperandIndex('submit', ['submit', 'design']), null);
  assert.deepEqual(namedWorkId('status', ['status'], { 'work-id': 'S-2' }), { workId: 'S-2', index: 1, fromOption: true });
  assert.deepEqual(namedWorkId('submit', ['submit', 'design'], { 'work-id': 'S-2' }), { workId: 'S-2', index: null, fromOption: true });
  assert.equal(namedWorkId('phase', ['phase', 'enter', 'design'], {}), null);
  assert.throws(() => namedWorkId('status', ['status', 'S-1'], { 'work-id': 'S-2' }), { code: 'WORK_ID_CONFLICT' });

  // `status` read only its operand, so --work-id was ignored. It gets the operand too, after the command.
  const positionals = ['status'];
  const argv = ['--json', 'status', '--work-id', 'S-2'];
  applyWorkIdOperand(namedWorkId('status', positionals, { 'work-id': 'S-2' }), positionals, argv);
  assert.deepEqual(positionals, ['status', 'S-2']);
  assert.deepEqual(argv, ['--json', 'status', 'S-2', '--work-id', 'S-2']);
  // A subcommand form gets it after the subcommand.
  const impact = ['impact', 'status'];
  const impactArgv = ['impact', 'status', '--work-id', 'S-2', '--json'];
  applyWorkIdOperand(namedWorkId('impact', impact, { 'work-id': 'S-2' }), impact, impactArgv);
  assert.deepEqual(impactArgv, ['impact', 'status', 'S-2', '--work-id', 'S-2', '--json']);
  const submit = ['submit'];
  applyWorkIdOperand(namedWorkId('submit', submit, { 'work-id': 'S-2' }), submit, ['submit']);
  assert.deepEqual(submit, ['submit'], 'a command that reads --work-id itself is left alone');
});

test('the Story index lives beside the workspace registry, wherever that is redirected', async () => {
  const { storyIndexFile } = await import('../src/story-index.mjs');
  assert.equal(storyIndexFile({ SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(path.sep, 'state', 'workspaces.json') }),
    path.resolve(path.sep, 'state', 'story-index.json'));
  assert.equal(storyIndexFile({ SINGULARITY_FLOW_STORY_INDEX: path.join(path.sep, 'other', 'index.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(path.sep, 'state', 'workspaces.json') }), path.resolve(path.sep, 'other', 'index.json'));
  assert.equal(storyIndexFile({}, path.join(path.sep, 'home', 'person')), path.resolve(path.sep, 'home', 'person', '.singularity-flow', 'story-index.json'));
});

test('file options are made absolute before a command moves to another checkout', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-rebase-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'draft.md'), 'draft\n');
  const options = { file: 'draft.md', out: 'report.md', path: 'src/value.mjs', document: ['draft.md', 'missing.md'] };
  const argv = ['documents', 'restore', 'D-1', '--file', 'draft.md', '--out=report.md', '--path', 'src/value.mjs'];
  await rebaseFileOptions(options, argv, directory);
  assert.equal(options.file, path.join(directory, 'draft.md'));
  assert.equal(options.out, path.join(directory, 'report.md'), 'an output lands where the person ran the command');
  assert.equal(options.path, 'src/value.mjs', 'a repository-relative path stays relative');
  assert.deepEqual(options.document, [path.join(directory, 'draft.md'), 'missing.md'],
    'an input that is not where the command was run may be repository-relative');
  assert.deepEqual(argv, ['documents', 'restore', 'D-1', '--file', path.join(directory, 'draft.md'),
    `--out=${path.join(directory, 'report.md')}`, '--path', 'src/value.mjs']);
});

test('file operands are made absolute before a command moves to another checkout, as file options are', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-operands-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'my notes'));
  await writeFile(path.join(directory, 'my notes', 'brief one.md'), 'brief\n');
  await writeFile(path.join(directory, 'draft.json'), '{}\n');
  await writeFile(path.join(directory, 'previous.json'), '{}\n');
  // Each command declares where its file operands sit; a repository path that names a Story file is not one.
  assert.deepEqual(fileOperandIndexes('documents', ['documents', 'upload', 'a.md', 'b.md']), [2, 3]);
  assert.deepEqual(fileOperandIndexes('impact', ['impact', 'evidence', 'collect', 'junit', 'r.xml', 'S-1']), [4]);
  assert.deepEqual(fileOperandIndexes('comprehension', ['comprehension', 'walkthrough', 'revalidate', 'd.json', 'p.json']), [3, 4]);
  assert.deepEqual(fileOperandIndexes('impact', ['impact', 'expansion', 'S-1', 'src/value.mjs']), []);
  assert.deepEqual(fileOperandIndexes('artifact', ['artifact', 'add', 'src/value.mjs']), []);
  assert.equal(workIdOperandIndex('impact', ['impact', 'evidence', 'import', 'r.json', 'S-1']), 4);
  assert.equal(workIdOperandIndex('impact', ['impact', 'evidence', 'collect', 'junit', 'r.xml', 'S-1']), 5);
  assert.equal(workIdOperandIndex('impact', ['impact', 'exposure', 'attest', 'S-1']), 3);

  // `--name` takes a value that happens to equal an operand; only the operand moves.
  const positionals = ['documents', 'upload', 'my notes/brief one.md', 'missing.md'];
  const argv = ['--no-model', 'documents', 'upload', '--name', 'my notes/brief one.md', 'my notes/brief one.md', 'missing.md',
    '--work-id', 'S-2', '--json'];
  await rebaseFileOperands('documents', positionals, argv, directory);
  const absolute = path.join(directory, 'my notes', 'brief one.md');
  assert.deepEqual(positionals, ['documents', 'upload', absolute, 'missing.md'],
    'an operand that is not where the command was run may be repository-relative');
  assert.deepEqual(argv, ['--no-model', 'documents', 'upload', '--name', 'my notes/brief one.md', absolute, 'missing.md',
    '--work-id', 'S-2', '--json']);
  const revalidate = ['comprehension', 'walkthrough', 'revalidate', './draft.json', 'previous.json'];
  const revalidateArgv = ['comprehension', 'walkthrough', 'revalidate', './draft.json', '--', 'previous.json'];
  await rebaseFileOperands('comprehension', revalidate, revalidateArgv, directory);
  assert.deepEqual(revalidate.slice(3), [path.join(directory, 'draft.json'), path.join(directory, 'previous.json')]);
  assert.deepEqual(revalidateArgv.slice(3), [path.join(directory, 'draft.json'), '--', path.join(directory, 'previous.json')]);
  const untouched = ['status', 'draft.json'];
  await rebaseFileOperands('status', untouched, ['status', 'draft.json'], directory);
  assert.deepEqual(untouched, ['status', 'draft.json'], 'a Work ID operand is never a file');
  const options = { answers: 'draft.json', checklist: 'missing.json' };
  await rebaseFileOptions(options, [], directory);
  assert.deepEqual(options, { answers: path.join(directory, 'draft.json'), checklist: 'missing.json' });
});

function specification(workId) {
  return [
    `# ${workId} — Specification`, '',
    '## Agent brief', '', 'The exported value must be 1, with a matching executable test.', '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '', '### S1 — Read the value', '',
    '- **Given** a ready application', '  **When** a user reads the value', '  **Then** 1 is displayed.', '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '',
    `- The user sees the value 1. [${workId}:AC-001]`,
    `- The application returns the value 1. [${workId}:REQ-002]`, '',
    '## Scenario coverage', '',
    '| Clause | Scenario | Outcome |', '|---|---|---|',
    `| \`${workId}:AC-001\` | S1 | success |`, `| \`${workId}:REQ-002\` | S1 | success |`, '',
    '## Boundary and non-functional requirements', '', 'Do not expose private data; invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns deterministically without a network call.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${workId}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${workId}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '',
    '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n');
}

/**
 * A bare remote whose `main` carries an initialized workflow, and two registered workspaces that
 * each clone it. Machine state lives under the fixture directory.
 */
async function twoWorkspaces(t, { model = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-index-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = path.join(directory, 'machine');
  await mkdir(state);
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Index Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(state, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(state, 'leads.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(state, 'copilot-mode.json'),
    SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off'
  };
  delete env.SINGULARITY_FLOW_STORY_INDEX;
  if (model) delete env.SINGULARITY_FLOW_NO_MODEL; else env.SINGULARITY_FLOW_NO_MODEL = '1';
  const run = (command, args, { cwd = directory, allowFailure = false, extra = {} } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...env, ...extra }, timeout: childTimeout(180_000) });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const cli = (args, options = {}) => run(process.execPath, [CLI, ...args], options);
  const json = (args, options = {}) => {
    const result = cli([...args, '--json'], options);
    try { return { ...result, value: JSON.parse(result.stdout) }; }
    catch { assert.fail(`not JSON: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); }
  };
  const git = (cwd, ...args) => run('git', args, { cwd }).stdout.trim();

  const seed = path.join(directory, 'seed');
  const remote = path.join(directory, 'origin.git');
  run('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.name', 'Index Tester');
  git(seed, 'config', 'user.email', 'index.tester@example.invalid');
  await writeFile(path.join(seed, '.gitattributes'), '* text eol=lf\n');
  await writeFile(path.join(seed, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  cli(['--no-model', 'init'], { cwd: seed });
  const configurationPath = path.join(seed, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'Initialize the Story index fixture');
  run('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(seed, 'push', '-q', remote, 'main:main');

  const workspaces = {};
  for (const id of ['wsa', 'wsb']) {
    const created = json(['workspace', 'create', '--local', '--id', id, '--lead', 'application',
      '--repository', `application=${pathToFileURL(remote).href}`, '--base', path.join(directory, `workspaces-${id}`), '--confirm', id]);
    const workspacePath = created.value.workspace.path;
    cli(['workspace', 'repair', workspacePath, '--json']);
    const clone = path.join(workspacePath, 'repos', 'application');
    git(clone, 'config', 'user.name', 'Index Tester');
    git(clone, 'config', 'user.email', 'index.tester@example.invalid');
    workspaces[id] = { path: workspacePath, clone };
  }
  const use = (id) => cli(['workspace', 'use', id, '--json']);
  /** Start a Story from its workspace's clone; it gets an isolated checkout of its own. */
  const start = (id, workId, cwd = workspaces[id].clone) => {
    use(id);
    cli(['--no-model', 'start', workId, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
      '--title', `Value ${workId}`, '--description', 'Return an approved value.'], { cwd });
    const checkout = path.join(state, 'unused');
    return checkout;
  };
  const indexFile = path.join(state, 'story-index.json');
  const index = async () => JSON.parse(await readFile(indexFile, 'utf8'));
  const entry = async (workId) => (await index()).entries.filter((item) => item.workId === workId);
  return { directory, state, env, run, cli, json, git, remote, workspaces, use, start, index, entry, indexFile };
}

test('one Story has one checkout across workspaces, and a Work ID decides where a command runs',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await twoWorkspaces(t);

    await t.test('start records the Story, its workspace, checkout, branch and phase', async () => {
      f.start('wsa', 'S-1');
      const [recorded] = await f.entry('S-1');
      assert.ok(recorded, JSON.stringify(await f.index()));
      assert.equal(recorded.workspace.id, 'local--wsa');
      assert.equal(recorded.branch, 'S-1');
      assert.equal(recorded.phase, 'specification');
      assert.equal(canonical(path.dirname(path.dirname(recorded.checkoutPath))),
        canonical(path.join(f.workspaces.wsa.path, '.singularity-flow')), 'an isolated Story worktree');
      assert.equal(f.git(recorded.checkoutPath, 'branch', '--show-current'), 'S-1');
      f.start('wsa', 'S-2');
      f.start('wsb', 'S-3');
      f.use('wsa');
    });

    await t.test('opening or attaching the Story in another workspace is refused, naming the first', async () => {
      const [first] = await f.entry('S-1');
      for (const args of [['session', 'attach', 'S-1'], ['session', 'open', 'S-1']]) {
        const refused = f.cli([...args, '--workspace', f.workspaces.wsb.path, '--repository', 'application', '--json'], { allowFailure: true });
        assert.notEqual(refused.status, 0, refused.stdout);
        const text = `${refused.stdout}${refused.stderr}`;
        assert.match(text, /STORY_CHECKOUT_ELSEWHERE/u, text);
        assert.ok(text.includes(first.checkoutPath), text);
        assert.match(text, /singularity-flow workspace use local--wsa/u, text);
      }
      assert.equal(f.git(f.workspaces.wsb.clone, 'branch', '--list', 'S-1'), '', 'workspace B checked nothing out');
      const started = f.cli(['--no-model', 'start', 'S-1', '--from-branch', 'main', '--work-type', 'spec-driven-standard',
        '--title', 'Again'], { cwd: f.workspaces.wsb.clone, allowFailure: true });
      assert.notEqual(started.status, 0);
      assert.match(`${started.stdout}${started.stderr}`, /S-1 already has its checkout in workspace 'wsa'/u);
    });

    await t.test('status --work-id runs in that Story\'s checkout, or refuses, never answering about this one', async () => {
      const [one] = await f.entry('S-1');
      const [two] = await f.entry('S-2');
      const routed = f.json(['status', '--work-id', 'S-2'], { cwd: one.checkoutPath });
      assert.equal(routed.value.workItem.id, 'S-2');
      assert.equal(routed.value.storyRoute.workId, 'S-2');
      assert.equal(canonical(routed.value.storyRoute.checkoutPath), canonical(two.checkoutPath));
      const text = f.cli(['status', '--work-id', 'S-2'], { cwd: one.checkoutPath });
      assert.match(text.stderr, new RegExp(`S-2 → ${two.checkoutPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
      assert.match(text.stdout, /S-2/u);
      assert.doesNotMatch(text.stdout, /\bS-1\b/u);

      const other = f.cli(['status', '--work-id', 'S-3', '--json'], { cwd: one.checkoutPath, allowFailure: true });
      assert.notEqual(other.status, 0);
      assert.equal(JSON.parse(other.stdout).error.code, 'STORY_CHECKOUT_ELSEWHERE');
      assert.match(other.stdout, /workspace use local--wsb/u);

      const missing = f.cli(['status', '--work-id', 'NOPE-1', '--json'], { cwd: one.checkoutPath, allowFailure: true });
      assert.notEqual(missing.status, 0);
      const refusal = JSON.parse(missing.stdout).error;
      assert.equal(refusal.code, 'STORY_CHECKOUT_REQUIRED');
      assert.match(refusal.message, /session open NOPE-1/u);

      // Opening a Story that has no checkout yet is not refused for it: that makes its one checkout.
      const resumed = f.cli(['resume', 'NOPE-1', '--json'], { cwd: one.checkoutPath, allowFailure: true });
      assert.notEqual(JSON.parse(resumed.stdout).error?.code, 'STORY_CHECKOUT_REQUIRED', resumed.stdout);
      // The current Story by name, and by none, is unchanged.
      assert.equal(f.json(['status', '--work-id', 'S-1'], { cwd: one.checkoutPath }).value.workItem.id, 'S-1');
      assert.equal(f.json(['status'], { cwd: one.checkoutPath }).value.workItem.id, 'S-1');
      assert.equal(f.json(['status', 'S-2'], { cwd: one.checkoutPath }).value.workItem.id, 'S-2', 'the operand routes too');
      // Routing reads no model: the same answer with model mode on (no Copilot is reachable here).
      const modelOn = f.json(['status', '--work-id', 'S-2'], { cwd: one.checkoutPath, extra: { SINGULARITY_FLOW_NO_MODEL: '' } });
      assert.equal(modelOn.value.workItem.id, 'S-2');

      // `session context --work-id` reads the named Story's checkout and refuses the same way.
      const context = f.json(['session', 'context', '--work-id', 'S-2'], { cwd: one.checkoutPath }).value;
      assert.equal(context.work.id, 'S-2');
      assert.equal(canonical(context.storyRoute.checkoutPath), canonical(two.checkoutPath));
      assert.match(f.cli(['session', 'context', '--work-id', 'S-2'], { cwd: one.checkoutPath }).stderr, /^S-2 → /mu);
      for (const [workId, code] of [['S-3', 'STORY_CHECKOUT_ELSEWHERE'], ['NOPE-1', 'STORY_CHECKOUT_REQUIRED']]) {
        const refused = f.cli(['session', 'context', '--work-id', workId, '--json'], { cwd: one.checkoutPath, allowFailure: true });
        assert.notEqual(refused.status, 0);
        assert.equal(JSON.parse(refused.stdout).error.code, code, refused.stdout);
      }
      const own = f.json(['session', 'context', '--work-id', 'S-1'], { cwd: one.checkoutPath }).value;
      assert.equal(own.work.id, 'S-1');
      assert.equal(own.storyRoute, undefined);
      // A bound checkout wins: it is not routed away from.
      const bound = f.cli(['session', 'context', '--work-id', 'S-2', '--context-root', one.checkoutPath, '--json'],
        { cwd: f.directory, allowFailure: true });
      const boundValue = JSON.parse(bound.stdout);
      assert.equal(boundValue.storyRoute, undefined, bound.stdout);
      assert.notEqual(boundValue.work?.id, 'S-2', bound.stdout);
    });

    await t.test('a Story whose branch is not its Work ID is found through its recorded branch', async () => {
      f.use('wsa');
      f.cli(['--no-model', 'start', 'S-5', '--from-branch', 'main', '--ref', 'feature/s5', '--work-type', 'spec-driven-standard',
        '--title', 'Value S-5', '--description', 'Return an approved value.'], { cwd: f.workspaces.wsa.clone });
      const [five] = await f.entry('S-5');
      assert.equal(five.branch, 'feature/s5');
      const [one] = await f.entry('S-1');
      const routed = f.json(['status', '--work-id', 'S-5'], { cwd: one.checkoutPath }).value;
      assert.equal(routed.workItem.id, 'S-5');
      assert.equal(routed.storyRoute.branch, 'feature/s5');
    });

    await t.test('file arguments are rebased to where the command was run', async () => {
      const [one] = await f.entry('S-1');
      const [two] = await f.entry('S-2');
      f.cli(['report', 'S-2', '--format', 'md', '--out', 'routed-report.md'], { cwd: one.checkoutPath });
      assert.match(await readFile(path.join(one.checkoutPath, 'routed-report.md'), 'utf8'), /S-2/u);
      assert.equal(existsSync(path.join(two.checkoutPath, 'routed-report.md')), false);
      await rm(path.join(one.checkoutPath, 'routed-report.md'));
      // A file operand too, with a space in its name and from outside any repository: the upload
      // reads the person's file, not a same-named one in S-2's checkout.
      const launch = path.join(f.directory, 'launch dir');
      await mkdir(launch, { recursive: true });
      await writeFile(path.join(launch, 'my notes.md'), 'Notes written where the command was run.\n');
      const uploaded = f.json(['--no-model', 'documents', 'upload', './my notes.md', '--name', 'Launch notes',
        '--work-id', 'S-2'], { cwd: launch }).value;
      assert.equal(canonical(uploaded.storyRoute.checkoutPath), canonical(two.checkoutPath));
      const [record] = uploaded.documents;
      assert.equal(record.sha256, createHash('sha256').update('Notes written where the command was run.\n').digest('hex'),
        JSON.stringify(record));
      assert.equal(f.git(two.checkoutPath, 'branch', '--show-current'), 'S-2');
    });

    await t.test('a Copilot turn bound to one Story cannot run a command for another', async () => {
      const [one] = await f.entry('S-1');
      const boundaries = path.join(f.state, 'copilot-boundaries');
      await mkdir(boundaries, { recursive: true });
      const record = path.join(boundaries, `${'a'.repeat(64)}.mutation.json`);
      await writeFile(record, JSON.stringify({ schemaVersion: 1, kind: 'copilot-mutation-contract', recordedAt: Date.now(),
        contract: { workId: 'S-1', repositoryRoot: canonical(one.checkoutPath) } }));
      const refused = f.cli(['status', '--work-id', 'S-2', '--json'], { cwd: one.checkoutPath, allowFailure: true });
      const context = f.cli(['session', 'context', '--work-id', 'S-2', '--json'], { cwd: one.checkoutPath, allowFailure: true });
      await rm(record);
      assert.notEqual(refused.status, 0);
      const error = JSON.parse(refused.stdout).error;
      assert.equal(error.code, 'ACTIVE_SUBJECT_MISMATCH', refused.stdout);
      assert.match(error.message, /bound to Story S-1, so it cannot run a command for S-2/u);
      assert.notEqual(context.status, 0);
      assert.equal(JSON.parse(context.stdout).error.code, 'ACTIVE_SUBJECT_MISMATCH', context.stdout);
      assert.equal(f.json(['status', '--work-id', 'S-2'], { cwd: one.checkoutPath }).value.workItem.id, 'S-2', 'after the turn, it routes');
    });

    await t.test('the full lifecycle walk updates phase and status, and a routed mutation runs in the Story checkout', async () => {
      const [one] = await f.entry('S-1');
      const [two] = await f.entry('S-2');
      const item = path.join(one.checkoutPath, 'singularity/work-items/S-1');
      await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification('S-1'));
      f.cli(['--no-model', 'artifact', 'scan', '--phase', 'specification'], { cwd: one.checkoutPath });
      f.cli(['--no-model', 'phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place'], { cwd: one.checkoutPath });
      // Uncommitted S-1 files in another copy stop a routed mutation, so they are not left behind.
      await mkdir(path.join(two.checkoutPath, 'singularity/work-items/S-1'), { recursive: true });
      await writeFile(path.join(two.checkoutPath, 'singularity/work-items/S-1/notes.md'), 'edited in the wrong copy\n');
      const held = f.cli(['--no-model', 'submit', 'specification', '--skip-checks', '--work-id', 'S-1', '--json'],
        { cwd: two.checkoutPath, allowFailure: true });
      assert.notEqual(held.status, 0);
      assert.equal(JSON.parse(held.stdout).error.code, 'STORY_CHANGES_IN_OTHER_COPY', held.stdout);
      await rm(path.join(two.checkoutPath, 'singularity/work-items/S-1'), { recursive: true });
      // From S-2's checkout, the mutation runs in S-1's.
      f.cli(['--no-model', 'submit', 'specification', '--skip-checks', '--work-id', 'S-1'], { cwd: two.checkoutPath });
      const [submitted] = await f.entry('S-1');
      assert.equal(submitted.phase, 'specification');
      assert.equal(submitted.phaseStatus, 'awaiting_approval', JSON.stringify(submitted));
      assert.equal(f.git(two.checkoutPath, 'branch', '--show-current'), 'S-2', 'S-2 stayed on its branch');
      f.cli(['--no-model', 'approve', 'specification', '--yes'], { cwd: one.checkoutPath });
      const [approved] = await f.entry('S-1');
      const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
      assert.equal(approved.phase, workflow.currentPhase);
      assert.notEqual(approved.phase, 'specification', JSON.stringify(approved));
      assert.equal(approved.phaseStatus, workflow.phases[workflow.currentPhase].status);
      assert.equal(approved.storyStatus, workflow.status);
      const listed = f.json(['workspace', 'stories', 'S-1'], { cwd: f.directory }).value;
      assert.equal(listed.found, true);
      assert.equal(listed.stories[0].phase, workflow.currentPhase);
      assert.deepEqual(listed.routes.commands, ['singularity-flow session open S-1']);
      const table = f.cli(['workspace', 'stories'], { cwd: f.directory }).stdout;
      for (const expected of ['STORY', 'WORKSPACE', 'PHASE', 'S-1', 'S-2', 'S-3', 'wsa *', 'wsb', workflow.currentPhase]) {
        assert.ok(table.includes(expected), `${expected}\n${table}`);
      }
      assert.match(f.cli(['workspace', 'stories', 'S-3'], { cwd: f.directory }).stdout,
        /Go there\.\n- Copilot: \/sf-workspace\n- Shell: singularity-flow workspace use local--wsb\n- VS Code \(model-free\): not available for this action\n\n- Copilot: \/sf-session S-3\n- Shell: singularity-flow session open S-3\n- VS Code \(model-free\): not available for this action/u);
    });

    await t.test('a stale entry is dropped, and Stories that predate the index are found again', async () => {
      const [two] = await f.entry('S-2');
      f.git(f.workspaces.wsa.clone, 'worktree', 'remove', '--force', two.checkoutPath);
      const listed = f.json(['workspace', 'stories'], { cwd: f.directory }).value;
      assert.ok(listed.dropped.some((entry) => entry.workId === 'S-2'), JSON.stringify(listed.dropped));
      assert.equal(listed.stories.some((entry) => entry.workId === 'S-2'), false);
      assert.deepEqual((await f.entry('S-2')), [], 'the stale entry is gone from the file');
      // An index lost (or written before these Stories existed) is rebuilt from the workspaces' clones.
      await rm(f.indexFile);
      const [one] = [(await f.json(['workspace', 'stories', '--rebuild'], { cwd: f.directory })).value.stories
        .find((entry) => entry.workId === 'S-1')];
      assert.ok(one, 'S-1 found again from git worktree list');
      await rm(f.indexFile);
      const routed = f.json(['status', '--work-id', 'S-3'], { cwd: one.checkoutPath, allowFailure: true });
      assert.equal(routed.value.error.code, 'STORY_CHECKOUT_ELSEWHERE', 'found by the lazy backfill of a missed lookup');
      assert.equal(canonical(routed.value.error.details.storyCheckout.checkoutPath), canonical((await f.entry('S-3'))[0].checkoutPath));
    });

    await t.test('concurrent writers keep every entry', async () => {
      await rm(f.indexFile, { force: true });
      const checkouts = [];
      const module = pathToFileURL(fileURLToPath(new URL('../src/story-index.mjs', import.meta.url))).href;
      const listed = f.git(f.workspaces.wsa.clone, 'worktree', 'list', '--porcelain').split('\n')
        .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
        .concat(f.git(f.workspaces.wsb.clone, 'worktree', 'list', '--porcelain').split('\n')
          .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length)))
        .filter((file) => file.includes('story-worktrees'));
      assert.ok(listed.length >= 2, listed.join('\n'));
      checkouts.push(...listed);
      const writer = (checkout) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e',
          `const { recordStoryCheckout } = await import(${JSON.stringify(module)}); const result = await recordStoryCheckout(${JSON.stringify(checkout)}); if (!result.recorded) { console.error(JSON.stringify(result)); process.exit(1); }`],
        { env: f.env, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      await Promise.all([...checkouts, ...checkouts, ...checkouts].map(writer));
      const recorded = (await f.index()).entries;
      assert.equal(recorded.length, checkouts.length, JSON.stringify(recorded.map((entry) => entry.checkoutPath)));
      for (const checkout of checkouts) assert.ok(recorded.some((entry) => canonical(entry.checkoutPath) === canonical(checkout)), checkout);
    });
  });

test('attach and open reuse the Story checkout in another clone of the same workspace', slowLane({ timeout: 900_000 }), async (t) => {
  const f = await twoWorkspaces(t);
  const { readWorkspace } = await import('../src/workspace-manifest.mjs');
  const { prepareWorkspaceBranch } = await import('../src/workspace-branch-checkout.mjs');
  // The second clone a Story start downloads for a branch ("repos/main--<hash>/application").
  const second = await prepareWorkspaceBranch(await readWorkspace(f.workspaces.wsa.path), 'application', 'main', { reuse: true, env: f.env });
  f.git(second.repositoryPath, 'config', 'user.name', 'Index Tester');
  f.git(second.repositoryPath, 'config', 'user.email', 'index.tester@example.invalid');
  f.git(second.repositoryPath, 'checkout', '-q', 'main');
  f.start('wsa', 'S-4', second.repositoryPath);
  const [story] = await f.entry('S-4');
  assert.ok(story, JSON.stringify(await f.index()));
  assert.equal(canonical(story.commonDir), canonical(path.join(second.repositoryPath, '.git')), 'the Story hangs off the second clone');
  const first = f.workspaces.wsa.clone;

  const attached = f.json(['session', 'attach', 'S-4'], { cwd: first }).value;
  assert.equal(canonical(attached.repositoryPath), canonical(story.checkoutPath), 'attach reused the existing worktree');
  assert.equal(f.git(first, 'branch', '--show-current'), 'main', 'the first clone was not switched to the Story branch');
  assert.doesNotMatch(f.git(first, 'worktree', 'list'), /S-4/u, 'no second checkout in the first clone');

  const opened = f.json(['session', 'open-local', 'S-4'], { cwd: first }).value;
  assert.equal(canonical(opened.repositoryPath), canonical(story.checkoutPath));
  const composed = f.json(['session', 'open', 'S-4'], { cwd: first }).value;
  assert.equal(composed.status, 'ready');
  assert.equal(canonical(composed.repositoryPath), canonical(story.checkoutPath));

  // Starting it again from the first clone is refused, naming the checkout and the way there.
  const again = f.cli(['--no-model', 'start', 'S-4', '--from-branch', 'main', '--work-type', 'spec-driven-standard', '--title', 'Again', '--json'],
    { cwd: first, allowFailure: true });
  assert.notEqual(again.status, 0);
  const envelope = JSON.parse(again.stdout);
  assert.equal(envelope.error.code, 'STORY_CHECKOUT_ELSEWHERE');
  assert.match(envelope.error.message, /another clone of workspace 'wsa'/u);
  assert.equal(canonical(envelope.error.details.storyCheckout.checkoutPath), canonical(story.checkoutPath));
  assert.equal(envelope.error.details.storyCheckout.sameWorkspace, true);
  assert.ok(envelope.remediationPlan.steps.some((step) => step.command === 'singularity-flow session open S-4'),
    JSON.stringify(envelope.remediationPlan));
});

/**
 * One workspace whose capability delivers in two repositories, app and api, each with its own bare
 * remote; app carries the approved configuration that names both (as in execution-context.test.mjs).
 */
async function twoRepositoryWorkspace(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-index-multi-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const state = path.join(base, 'machine');
  await mkdir(state);
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Index Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(state, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(state, 'leads.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(state, 'copilot-mode.json'),
    SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off'
  };
  delete env.SINGULARITY_FLOW_STORY_INDEX;
  const run = (command, args, { cwd = base, allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000), maxBuffer: 64 * 1024 * 1024 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const cli = (args, options = {}) => run(process.execPath, [CLI, ...args], options);
  const json = (args, options = {}) => JSON.parse(cli([...args, '--json'], options).stdout);
  const git = (cwd, ...args) => run('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd }).stdout.trim();
  const workspacePath = path.join(base, 'workspace');
  const app = path.join(workspacePath, 'repos', 'app');
  const api = path.join(workspacePath, 'repos', 'api');
  const remote = path.join(base, 'app.git');
  const apiRemote = path.join(base, 'api.git');
  await mkdir(app, { recursive: true });
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'config', 'user.name', 'Index Tester');
  git(app, 'config', 'user.email', 'index.tester@example.invalid');
  await writeFile(path.join(app, 'README.md'), 'Two-repository Story index fixture\n');
  cli(['--no-model', 'init'], { cwd: app });
  const definitionPath = path.join(app, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(definitionPath, YAML.stringify(definition));
  const portfolioPath = path.join(app, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.repositories = { app: { url: remote, defaultBranch: 'main', required: true },
    api: { url: apiRemote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  await writeFile(path.join(app, 'singularity/capabilities.yml'), YAML.stringify({ version: 1, capabilities: {
    enterprise: { kind: 'collection', parent: null, policy: {} },
    product: { kind: 'collection', parent: 'enterprise', policy: {} },
    delivery: { kind: 'delivery', parent: 'product', repositories: ['app', 'api'], policy: {} }
  } }));
  git(app, 'add', '.');
  git(app, 'commit', '-qm', 'Approved two-repository configuration');
  git(app, 'branch', 'sflow/config');
  for (const bare of [remote, apiRemote]) git(base, 'init', '--bare', '-q', '-b', 'main', bare);
  git(app, 'remote', 'add', 'origin', remote);
  git(app, 'push', '-q', '-u', 'origin', 'main', 'sflow/config');
  git(base, 'clone', '--no-local', '-q', remote, api);
  git(api, 'remote', 'set-url', 'origin', apiRemote);
  git(api, 'push', '-q', '-u', 'origin', 'main');
  for (const clone of [app, api]) {
    git(clone, 'config', 'user.name', 'Index Tester');
    git(clone, 'config', 'user.email', 'index.tester@example.invalid');
  }
  const now = new Date().toISOString();
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({ version: 1, id: 'multi', name: 'Multi',
    createdAt: now, updatedAt: now, anchor: { provider: 'workspace', key: 'multi', title: 'Multi', fetchedAt: now },
    leadRepository: 'app', capabilities: ['delivery'], repositories: {
      app: { url: remote, path: 'repos/app', defaultBranch: 'main', required: true, capabilities: ['delivery'] },
      api: { url: apiRemote, path: 'repos/api', defaultBranch: 'main', required: true, capabilities: ['delivery'] }
    } }));
  const { readWorkspace, rememberWorkspace } = await import('../src/workspace.mjs');
  await rememberWorkspace(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(workspacePath));
  cli(['workspace', 'use', workspacePath, '--repository', 'app', '--json']);
  const index = async () => JSON.parse(await readFile(path.join(state, 'story-index.json'), 'utf8'));
  const worktreeOn = (clone, branch) => git(clone, 'worktree', 'list', '--porcelain').split('\n\n')
    .find((block) => block.includes(`branch refs/heads/${branch}`))?.split('\n')[0].slice('worktree '.length) ?? null;
  return { base, env, run, cli, json, git, workspacePath, app, api, remote, apiRemote, index, worktreeOn, readWorkspace };
}

test('a Story that delivers in two repositories has its checkout of each in the index', slowLane({ timeout: 900_000 }), async (t) => {
  const f = await twoRepositoryWorkspace(t);
  const started = f.json(['start', 'MULTI-1', '--isolated-worktree', '--from-branch', 'main', '--capability', 'delivery',
    '--work-type', 'feature', '--title', 'Shared delivery'], { cwd: f.app });
  const lifecycle = (started.data ?? started).repositoryPath;
  f.git(lifecycle, 'push', '-q', '-u', 'origin', 'MULTI-1');
  if (!f.git(f.api, 'branch', '--list', 'MULTI-1')) f.git(f.api, 'branch', 'MULTI-1');
  f.git(f.api, 'push', '-q', 'origin', 'MULTI-1');
  const apiCheckout = f.worktreeOn(f.api, 'MULTI-1');
  assert.ok(apiCheckout, f.git(f.api, 'worktree', 'list'));

  // The start records both: the checkout holding the Story, and api's, which only carries its branch.
  const entries = (await f.index()).entries.filter((entry) => entry.workId === 'MULTI-1');
  assert.deepEqual(entries.map((entry) => [entry.repository.id, entry.role ?? 'story']).sort(), [['api', 'secondary'], ['app', 'story']],
    JSON.stringify(entries, null, 2));
  const secondary = entries.find((entry) => entry.role === 'secondary');
  assert.equal(canonical(secondary.checkoutPath), canonical(apiCheckout));
  assert.equal(canonical(secondary.lifecycle.checkoutPath), canonical(lifecycle));
  const listed = f.json(['workspace', 'stories', 'MULTI-1'], { cwd: f.base });
  assert.deepEqual(listed.stories.map((story) => story.role).sort(), ['secondary', 'story']);
  assert.deepEqual(listed.routes.commands, ['singularity-flow session open MULTI-1']);
  assert.doesNotMatch(f.cli(['workspace', 'stories', 'MULTI-1'], { cwd: f.base }).stdout, /more than one checkout/u);

  // From api's checkout, a command for the Story runs where its record is, never in api.
  const routed = f.json(['status', '--work-id', 'MULTI-1'], { cwd: apiCheckout });
  assert.equal(routed.workItem.id, 'MULTI-1');
  assert.equal(canonical(routed.storyRoute.checkoutPath), canonical(lifecycle));

  // api's checkout moves to another clone of the workspace (a branch download); a rebuild finds it there.
  const { prepareWorkspaceBranch } = await import('../src/workspace-branch-checkout.mjs');
  const second = (await prepareWorkspaceBranch(await f.readWorkspace(f.workspacePath), 'api', 'main', { reuse: true, env: f.env })).repositoryPath;
  f.git(f.api, 'worktree', 'remove', apiCheckout);
  f.git(second, 'fetch', '-q', 'origin', 'MULTI-1:MULTI-1');
  const moved = path.join(f.workspacePath, '.singularity-flow', 'story-worktrees', 'api-second');
  f.git(second, 'worktree', 'add', '-q', moved, 'MULTI-1');
  const rebuilt = f.json(['workspace', 'stories', 'MULTI-1', '--rebuild'], { cwd: f.base });
  assert.deepEqual(rebuilt.stories.filter((story) => story.role === 'secondary').map((story) => canonical(story.checkoutPath)),
    [canonical(moved)], JSON.stringify(rebuilt, null, 2));

  // Takeover uses that checkout instead of checking api's branch out a second time in the declared clone.
  const taken = f.json(['session', 'takeover', 'MULTI-1'], { cwd: f.app });
  assert.equal(taken.ready, true, JSON.stringify(taken));
  assert.deepEqual(taken.repositories.map((context) => context.repository.id), ['app', 'api']);
  assert.equal(f.worktreeOn(f.api, 'MULTI-1'), null, f.git(f.api, 'worktree', 'list'));
  assert.equal(canonical(f.worktreeOn(second, 'MULTI-1')), canonical(moved));
  assert.equal(f.git(f.api, 'branch', '--show-current'), 'main');
});

test('workspace consolidate moves the Story checkouts a second clone owns onto the declared clone, and refuses the rest',
  slowLane({ timeout: 1_200_000 }), async (t) => {
    const f = await twoWorkspaces(t);
    const { readWorkspace } = await import('../src/workspace-manifest.mjs');
    const { prepareWorkspaceBranch } = await import('../src/workspace-branch-checkout.mjs');
    const workspace = f.workspaces.wsa.path;
    const declared = f.workspaces.wsa.clone;
    // The second clone a branch download makes ("repos/main--<hash>/application"), owning three Stories.
    const second = (await prepareWorkspaceBranch(await readWorkspace(workspace), 'application', 'main', { reuse: true, env: f.env })).repositoryPath;
    f.git(second, 'config', 'user.name', 'Index Tester');
    f.git(second, 'config', 'user.email', 'index.tester@example.invalid');
    f.git(second, 'checkout', '-q', 'main');
    for (const id of ['S-4', 'S-5', 'S-6']) f.start('wsa', id, second);
    const checkoutOf = async (id) => (await f.entry(id))[0].checkoutPath;
    const [four, five, six] = [await checkoutOf('S-4'), await checkoutOf('S-5'), await checkoutOf('S-6')];
    const commonDir = (checkout) => canonical(f.git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    for (const checkout of [four, five, six]) assert.equal(commonDir(checkout), canonical(path.join(second, '.git')));
    // S-6 keeps a document on this machine only (in the second clone's store), then gains a commit the remote lacks.
    await writeFile(path.join(f.directory, 'brief.md'), 'A brief kept on this machine.\n');
    f.cli(['--no-model', 'documents', 'upload', path.join(f.directory, 'brief.md'), '--name', 'Brief', '--store', 'local'], { cwd: six });
    f.git(six, 'commit', '-q', '--allow-empty', '-m', 'Local only');
    await writeFile(path.join(five, 'scratch.txt'), 'not committed\n');

    const lists = () => [f.git(declared, 'worktree', 'list', '--porcelain'), f.git(second, 'worktree', 'list', '--porcelain')];
    const before = lists();
    const preview = f.json(['workspace', 'consolidate', workspace], { cwd: f.directory }).value;
    assert.equal(preview.status, 'partial', JSON.stringify(preview, null, 2));
    assert.match(preview.planId, /^wcp-[a-f0-9]{32}$/u);
    const [repository] = preview.repositories;
    assert.equal(canonical(repository.canonical.path), canonical(declared), 'the clone the workspace declares');
    assert.deepEqual(repository.moves.map((move) => move.workId), ['S-4']);
    assert.deepEqual(repository.refused.map((item) => [item.workId, item.reason]).sort(),
      [['S-5', 'untracked-files'], ['S-6', 'unpushed-commits']]);
    assert.deepEqual(repository.pointers, [], 'the second clone still owns checkouts, so it keeps serving its branch');
    assert.deepEqual(lists(), before, 'the preview changed nothing');
    const text = f.cli(['workspace', 'consolidate', workspace], { cwd: f.directory }).stdout;
    for (const expected of [`canonical clone ${canonical(declared)}`, 'Moves S-4 on S-4', 'Stays S-5', 'it has untracked files',
      'Stays S-6', 'not on the remote', `--confirm-plan ${preview.planId}`]) {
      assert.ok(text.includes(expected), `${expected}\n${text}`);
    }

    // A plan ID that is not one, or that no longer matches the workspace, moves nothing.
    const invalid = f.cli(['workspace', 'consolidate', workspace, '--confirm-plan', 'wcp-1', '--json'], { cwd: f.directory, allowFailure: true });
    assert.equal(JSON.parse(invalid.stdout).error.code, 'WORKSPACE_CONSOLIDATE_PLAN_INVALID', invalid.stdout);
    await writeFile(path.join(four, 'package.json'), '{"edited":"after the preview"}\n');
    assert.deepEqual(f.json(['workspace', 'consolidate', workspace], { cwd: f.directory }).value.repositories[0].refused
      .filter((item) => item.workId === 'S-4').map((item) => item.reason), ['local-changes']);
    const stale = f.cli(['workspace', 'consolidate', workspace, '--confirm-plan', preview.planId, '--json'], { cwd: f.directory, allowFailure: true });
    assert.equal(JSON.parse(stale.stdout).error.code, 'WORKSPACE_CONSOLIDATE_PLAN_STALE', stale.stdout);
    assert.deepEqual(lists(), before, 'a stale plan moved nothing');
    f.git(four, 'checkout', '--', 'package.json');

    const applied = f.json(['workspace', 'consolidate', workspace, '--confirm-plan', preview.planId], { cwd: f.directory }).value;
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.moved.map((move) => move.workId), ['S-4']);
    assert.equal(commonDir(four), canonical(path.join(declared, '.git')), 'S-4 now hangs off the declared clone');
    assert.match(f.git(declared, 'worktree', 'list', '--porcelain'), new RegExp(`branch refs/heads/S-4\\b`, 'u'));
    assert.doesNotMatch(f.git(second, 'worktree', 'list', '--porcelain'), /refs\/heads\/S-4\b/u);
    assert.equal(f.git(four, 'status', '--porcelain'), '');
    assert.equal(f.git(four, 'branch', '--show-current'), 'S-4');
    assert.equal(f.git(four, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'), 'origin/S-4');
    assert.equal(f.json(['status'], { cwd: four }).value.workItem.id, 'S-4');
    assert.equal(canonical((await f.entry('S-4'))[0].commonDir), canonical(path.join(declared, '.git')), 'the Story index follows');
    assert.ok(existsSync(path.join(five, 'scratch.txt')), 'a refused checkout is left exactly as it was');
    assert.equal(commonDir(five), canonical(path.join(second, '.git')));

    // A copy of the Story in the declared clone, or a bound Copilot turn, also keeps a checkout where it is.
    await rm(path.join(five, 'scratch.txt'));
    const duplicate = path.join(f.directory, 'duplicate S-5');
    f.git(declared, 'fetch', '-q', 'origin', 'S-5:S-5');
    f.git(declared, 'worktree', 'add', '-q', duplicate, 'S-5');
    f.git(six, 'push', '-q', 'origin', 'S-6');
    const boundaries = path.join(f.state, 'copilot-boundaries');
    await mkdir(boundaries, { recursive: true });
    const record = path.join(boundaries, `${'b'.repeat(64)}.mutation.json`);
    await writeFile(record, JSON.stringify({ schemaVersion: 1, kind: 'copilot-mutation-contract', recordedAt: Date.now(),
      contract: { workId: 'S-6', repositoryRoot: canonical(six) } }));
    const held = f.json(['workspace', 'consolidate', workspace], { cwd: f.directory }).value;
    assert.equal(held.status, 'blocked');
    assert.deepEqual(held.repositories[0].refused.map((item) => [item.workId, item.reason]).sort(),
      [['S-5', 'checked-out-in-canonical'], ['S-6', 'live-lease']]);
    assert.equal(held.planId, null);
    await rm(record);
    f.git(declared, 'worktree', 'remove', duplicate);
    // An unfinished publication the old clone records for a Story keeps it there too.
    const pending = path.join(second, '.git', 'singularity-flow', 'pending-publication', 'story--S-6.json');
    await mkdir(path.dirname(pending), { recursive: true });
    await writeFile(pending, '{}\n');
    assert.deepEqual(f.json(['workspace', 'consolidate', workspace], { cwd: f.directory }).value.repositories[0].refused
      .map((item) => [item.workId, item.reason]), [['S-6', 'unfinished-records']]);
    await rm(pending);

    // Nothing stops them now: both move, and the second clone, owning nothing, stops serving its branch.
    const last = f.json(['workspace', 'consolidate', workspace], { cwd: f.directory }).value;
    assert.equal(last.status, 'ready', JSON.stringify(last, null, 2));
    assert.deepEqual(last.repositories[0].moves.map((move) => move.workId).sort(), ['S-5', 'S-6']);
    assert.equal(last.repositories[0].pointers.length, 1);
    const done = f.json(['workspace', 'consolidate', workspace, '--confirm-plan', last.planId], { cwd: f.directory }).value;
    assert.deepEqual(done.moved.map((move) => move.workId).sort(), ['S-5', 'S-6']);
    for (const checkout of [five, six]) assert.equal(commonDir(checkout), canonical(path.join(declared, '.git')));
    assert.equal(f.git(six, 'log', '-1', '--format=%s'), 'Local only', 'the checkout kept its history');
    const [retired] = done.pointersRetired;
    assert.equal(existsSync(retired.pointer), false);
    assert.ok(existsSync(retired.retiredTo), 'the pointer is set aside, not deleted');
    assert.ok(existsSync(path.join(second, '.git', 'objects')), 'the second clone and its objects stay');
    assert.match(done.nextAction, /workspace cleanup/u);
    const documents = f.json(['documents', 'list'], { cwd: six }).value;
    const brief = (Array.isArray(documents) ? documents : documents.documents).find((document) => document.name === 'Brief');
    assert.equal(brief.availability, 'available', 'its machine-local document came with it');
    assert.equal(f.json(['workspace', 'consolidate', workspace], { cwd: f.directory }).value.status, 'current');
  });
