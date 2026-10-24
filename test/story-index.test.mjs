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
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

import { applyWorkIdOperand, namedWorkId, rebaseFileOptions, workIdOperandIndex } from '../src/story-routing.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const canonical = (file) => realpathSync.native(file);

test('a command names its Story by --work-id or by the operand it declares, never both differently', () => {
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

      // The current Story by name, and by none, is unchanged.
      assert.equal(f.json(['status', '--work-id', 'S-1'], { cwd: one.checkoutPath }).value.workItem.id, 'S-1');
      assert.equal(f.json(['status'], { cwd: one.checkoutPath }).value.workItem.id, 'S-1');
      assert.equal(f.json(['status', 'S-2'], { cwd: one.checkoutPath }).value.workItem.id, 'S-2', 'the operand routes too');
      // Routing reads no model: the same answer with model mode on (no Copilot is reachable here).
      const modelOn = f.json(['status', '--work-id', 'S-2'], { cwd: one.checkoutPath, extra: { SINGULARITY_FLOW_NO_MODEL: '' } });
      assert.equal(modelOn.value.workItem.id, 'S-2');
    });

    await t.test('file arguments are rebased to where the command was run', async () => {
      const [one] = await f.entry('S-1');
      const [two] = await f.entry('S-2');
      f.cli(['report', 'S-2', '--format', 'md', '--out', 'routed-report.md'], { cwd: one.checkoutPath });
      assert.match(await readFile(path.join(one.checkoutPath, 'routed-report.md'), 'utf8'), /S-2/u);
      assert.equal(existsSync(path.join(two.checkoutPath, 'routed-report.md')), false);
      await rm(path.join(one.checkoutPath, 'routed-report.md'));
    });

    await t.test('a Copilot turn bound to one Story cannot run a command for another', async () => {
      const [one] = await f.entry('S-1');
      const boundaries = path.join(f.state, 'copilot-boundaries');
      await mkdir(boundaries, { recursive: true });
      const record = path.join(boundaries, `${'a'.repeat(64)}.mutation.json`);
      await writeFile(record, JSON.stringify({ schemaVersion: 1, kind: 'copilot-mutation-contract', recordedAt: Date.now(),
        contract: { workId: 'S-1', repositoryRoot: canonical(one.checkoutPath) } }));
      const refused = f.cli(['status', '--work-id', 'S-2', '--json'], { cwd: one.checkoutPath, allowFailure: true });
      await rm(record);
      assert.notEqual(refused.status, 0);
      const error = JSON.parse(refused.stdout).error;
      assert.equal(error.code, 'ACTIVE_SUBJECT_MISMATCH', refused.stdout);
      assert.match(error.message, /bound to Story S-1, so it cannot run a command for S-2/u);
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
        /Go there\. Copilot: \/sf-workspace, then \/sf-session S-3; Shell: singularity-flow workspace use local--wsb, then singularity-flow session open S-3; VS Code \(model-free\): not available for this action\./u);
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
