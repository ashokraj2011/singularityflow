/**
 * Code outside the plan [WCB, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md]: which files no gate counts, who changed a file
 * (from SFlow's own hook records), the reason Copilot wrote in its document, and the settlement that takes it up.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { isWorkspaceLocalPath } from '../src/workspace-local-paths.mjs';
import { codeWriters, outsidePlanReasons, outsidePlanSettlement } from '../src/code-outside-plan.mjs';
import { captureToolWrites, settleToolWrites } from '../src/comprehension/xpl2/observed-write-recorder.mjs';
import { readObservedWrites } from '../src/comprehension/xpl2/observed-writes.mjs';
import { attributeLineWriter } from '../src/comprehension/xpl2/writer-attribution.mjs';
import { readSfGuardShellRecords, sfGuardNotePrompt, sfGuardNoteToolCall, sfGuardNoteToolResult, sfGuardRepository, sfGuardRunningCall }
  from '../src/comprehension/xpl2/sf-guard-recorder.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationPostToolGuard, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { outsidePlanSettled } from '../src/plan-amendments.mjs';
import { outsidePlanWho } from '../src/person-change-class.mjs';
import { outsidePlanWords } from '../src/decision-list.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

test('workspace-local files are an editor\'s, a machine\'s own or a test runner\'s output, never the code base [WCB:REQ-002]', () => {
  for (const file of ['.vscode/settings.json', 'service/.idea/workspace.xml', '.classpath', 'service/.settings/org.eclipse.jdt.core.prefs',
    '.env', 'config/.env.local', 'config/app.local.json', 'src/main/resources/application-local.yml', 'test-results/.last-run.json',
    'web/playwright-report/index.html']) assert.equal(isWorkspaceLocalPath(file), true, file);
  for (const file of ['src/value.mjs', 'config/settings.json', '.env.example', '.eslintrc.json', '.editorconfig', 'package.json',
    '.github/workflows/ci.yml', 'test/value.test.mjs', 'docs/results.md']) assert.equal(isWorkspaceLocalPath(file), false, file);
});

test('the reasons Copilot wrote under "Changes outside the plan", as a list or a table, at any heading level [WCB:REQ-012]', () => {
  const text = [
    '# W-1 — Implementation Summary', '', '## Changed components and decisions', '', '- `src/value.mjs`: returns the approved value.', '',
    '### Changes outside the plan', '', '<!-- sflow:guidance one line each -->',
    '- `src/format.mjs`: the value is shown with two decimals, which the summary page needs.',
    '- `./config/app.json` — the new flag defaults to off', '* `README.md`', '',
    '| File | Why |', '|---|---|', '| `scripts/build.sh` | the build copies the new asset |', '',
    '## Tests and operational notes', '', '- `test/other.mjs`: not a change outside the plan.'
  ].join('\n');
  const reasons = outsidePlanReasons(text);
  assert.deepEqual(Object.fromEntries(reasons), {
    'src/format.mjs': 'the value is shown with two decimals, which the summary page needs.',
    'config/app.json': 'the new flag defaults to off',
    'scripts/build.sh': 'the build copies the new asset'
  });
  assert.equal(outsidePlanReasons('## Changed components\n\n- `src/a.mjs`: why').size, 0, 'only under its own heading');
});

test('who changed a file: Copilot when its recorded write left the bytes it holds now, else "you", with the basis [WCB:REQ-011]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wcb-writers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitDir = path.join(root, '.git');
  await mkdir(gitDir, { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  const workflow = { workItem: { id: 'W-1', createdAt: new Date(Date.now() - 60_000).toISOString() } };

  // No hook ever ran in this checkout: every file is "by you".
  await writeFile(path.join(root, 'src/mine.mjs'), 'export const mine = 1;\n');
  let writers = await codeWriters(root, workflow, ['src/mine.mjs']);
  assert.deepEqual(writers.get('src/mine.mjs'), { writer: 'person', basis: 'no-hook-records' });

  // Copilot's edit, as the guard records it: captured before it runs, settled after.
  const pendingFile = path.join(root, 'pending-writes.json');
  const writer = { kind: 'copilot-turn', session: 'abc', turn: 'turn-1', skill: 'sf-code', agent: 'sflow-workflow' };
  await captureToolWrites({ pendingFile, root, gitDirectory: gitDir, writer, subject: { workId: 'W-1', phase: 'implementation', generation: 1 },
    calls: [{ name: 'create_file', args: { filePath: 'src/copilot.mjs', content: 'export const copilot = 1;\n' }, targets: ['src/copilot.mjs'] },
      { name: 'create_file', args: { filePath: 'src/edited.mjs', content: 'export const edited = 1;\n' }, targets: ['src/edited.mjs'] }] });
  await writeFile(path.join(root, 'src/copilot.mjs'), 'export const copilot = 1;\n');
  await writeFile(path.join(root, 'src/edited.mjs'), 'export const edited = 1;\n');
  await settleToolWrites(pendingFile, { final: true });
  // A person changed one of them again afterwards.
  await writeFile(path.join(root, 'src/edited.mjs'), 'export const edited = 2;\n');

  writers = await codeWriters(root, workflow, ['src/copilot.mjs', 'src/edited.mjs', 'src/mine.mjs']);
  assert.equal(writers.get('src/copilot.mjs').writer, 'copilot');
  assert.equal(writers.get('src/copilot.mjs').basis, 'recorded-write');
  assert.equal(writers.get('src/copilot.mjs').agent, 'sflow-workflow');
  assert.deepEqual(writers.get('src/edited.mjs'), { writer: 'person', basis: 'changed-after-copilot' });
  assert.deepEqual(writers.get('src/mine.mjs'), { writer: 'person', basis: 'not-recorded' });

  // A write recorded before the Story began is not this Story's.
  const later = { workItem: { id: 'W-2', createdAt: new Date(Date.now() + 60_000).toISOString() } };
  assert.equal((await codeWriters(root, later, ['src/copilot.mjs'])).get('src/copilot.mjs').writer, 'person');
  assert.equal(sha('export const copilot = 1;\n').length, 64);
});

test('the settlement takes a file up with the step, with its writer and reason, and the approval words it [WCB:REQ-010, REQ-014]', () => {
  const phase = { id: 'implementation' };
  const copilot = outsidePlanSettlement('src/format.mjs', { phase, stepName: 'Implementation', writer: { writer: 'copilot', basis: 'recorded-write', agent: 'sflow-workflow' },
    reason: 'the summary page needs two decimals', document: 'singularity/work-items/W-1/artifacts/implementation/implementation-summary.md' });
  assert.equal(copilot.kind, 'plan-accounting');
  assert.equal(copilot.subject, 'file:src/format.mjs');
  assert.deepEqual(copilot.effect, { file: 'src/format.mjs', class: 'out-of-plan', writer: 'copilot', basis: 'recorded-write',
    reason: 'the summary page needs two decimals', kind: 'behaviour', agent: 'sflow-workflow' });
  assert.match(copilot.answer, /by Copilot: the summary page needs two decimals/u);
  assert.ok(copilot.evidence.some((entry) => /Copilot says/u.test(entry.what)));
  const silent = outsidePlanSettlement('src/other.mjs', { phase, writer: { writer: 'copilot', basis: 'recorded-write' } });
  assert.match(silent.answer, /by Copilot: no reason written/u);
  const yours = outsidePlanSettlement('config/settings.json', { phase, writer: { writer: 'person', basis: 'no-hook-records' }, reason: 'ignored for a person', kind: 'build' });
  assert.equal(yours.effect.writer, 'person');
  assert.equal(yours.effect.reason, null, 'no reason is asked of a person');
  assert.match(yours.answer, /by you\.$/u);

  const record = (id, settlement, extra = {}) => ({ id, ...settlement, at: '2026-11-27T10:00:00.000Z', ...extra });
  const workflow = { settledDecisions: [record('STL-001', copilot), record('STL-002', yours), record('STL-003', silent, { phase: 'other' }),
    { id: 'STL-004', undoes: 'STL-003', actor: 'person', at: '2026-11-27T11:00:00.000Z' }] };
  const listed = outsidePlanSettled(workflow, 'implementation');
  assert.deepEqual(listed.map((entry) => [entry.file, entry.writer]), [['src/format.mjs', 'copilot'], ['config/settings.json', 'person']]);
  assert.deepEqual(listed.map(outsidePlanWords), ['src/format.mjs: by Copilot: the summary page needs two decimals', 'config/settings.json: by you']);
  assert.deepEqual(outsidePlanSettled(workflow).map((entry) => entry.id), ['STL-001', 'STL-002'], 'an undone one is not listed');
});

test('a supporting change that says who made it is listed with the files outside the plan: a scratch note "by you" [owner, 2026-11-28]', () => {
  const workflow = { settledDecisions: [
    { id: 'STL-001', kind: 'plan-accounting', by: 'sflow', phase: 'implementation', subject: 'file:NOTES.md', answer: 'Listed NOTES.md as a supporting change.',
      effect: { file: 'NOTES.md', class: 'documentation', writer: 'person', basis: 'no-hook-records' }, at: '2026-11-28T00:00:00.000Z' },
    { id: 'STL-002', kind: 'plan-accounting', by: 'sflow', phase: 'implementation', subject: 'file:test/helpers/fixture.mjs', answer: 'Listed it as test support.',
      effect: { file: 'test/helpers/fixture.mjs', class: 'test-support', writer: 'copilot', basis: 'recorded-write' }, at: '2026-11-28T00:00:01.000Z' },
    // Settled before this rule, with no writer: the plan's, and not listed here.
    { id: 'STL-003', kind: 'plan-accounting', by: 'sflow', phase: 'implementation', subject: 'file:README.md', answer: 'Listed README.md.',
      effect: { file: 'README.md', class: 'documentation' }, at: '2026-11-28T00:00:02.000Z' }] };
  const listed = outsidePlanSettled(workflow, 'implementation');
  assert.deepEqual(listed.map((entry) => [entry.file, entry.writer, entry.supporting]),
    [['NOTES.md', 'person', 'documentation'], ['test/helpers/fixture.mjs', 'copilot', 'test-support']]);
  assert.deepEqual(listed.map(outsidePlanWords), ['NOTES.md: by you, as a supporting change', 'test/helpers/fixture.mjs: by Copilot, as a supporting change']);
});

// The three ways a file was read "by you" when it was not [owner, 2026-11-28: "do all the gaps"]: Copilot's terminal
// writes, the base branch merged in, and a checkout reached through a link.

const run = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function machine(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-wcb-gaps-')));
  const saved = Object.fromEntries(['SINGULARITY_FLOW_COPILOT_MODE_FILE', 'SINGULARITY_FLOW_VSCODE_USER_DATA'].map((name) => [name, process.env[name]]));
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  // VS Code's own folder list is this test's, empty unless a case writes one.
  process.env.SINGULARITY_FLOW_VSCODE_USER_DATA = path.join(directory, 'vscode');
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, boundaries: path.join(directory, 'machine', 'copilot-boundaries') };
}

test('a terminal command Copilot runs in an SFlow turn: the turn\'s guard keeps what it changed, so the file is Copilot\'s, not "by you" [WCB:REQ-011]', async (t) => {
  const { directory } = await machine(t);
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.name', 'Gap Tester');
  run(root, 'config', 'user.email', 'gap.tester@example.invalid');
  await writeFile(path.join(root, 'src/App.jsx'), 'export const value = 1;\n');
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code' }, generationIntent: { status: 'open', generation: 1 } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const workflow = { workItem: { id: 'GAP-1', createdAt: new Date(Date.now() - 60_000).toISOString() }, currentPhase: phase.id,
    phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'GAP-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  run(root, 'add', 'src', 'singularity');
  run(root, 'commit', '-qm', 'fixture');
  const payload = { cwd: root, sessionId: 'gap-shell', prompt: '/sf-phase' };
  await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => root, load: async () => ({ definition, workflow }) }) });

  // Copilot runs a generator: the guard allows it, it writes a file no plan row names, and the guard after it says nothing.
  const call = { ...payload, toolName: 'bash', toolArgs: { command: 'npm test', cwd: root } };
  assert.deepEqual(await mutationToolGuard(call), {});
  await writeFile(path.join(root, 'src/generated.mjs'), 'export const table = [1, 2, 3];\n');
  assert.deepEqual(await mutationPostToolGuard(call), {});
  // Later the person writes a file of their own, outside any Copilot call.
  await writeFile(path.join(root, 'src/mine.mjs'), 'export const mine = true;\n');

  const { records } = await readObservedWrites(path.join(root, '.git'), { paths: ['src/generated.mjs'] });
  assert.deepEqual(records.map((record) => [record.tool, record.writer.kind, record.subject.workId, record.files.map((file) => [file.path, file.verified])]),
    [['shell', 'copilot-turn', 'GAP-1', [['src/generated.mjs', false]]]]);
  assert.equal(records[0].files[0].after, sha('export const table = [1, 2, 3];\n'));
  const writers = await codeWriters(root, workflow, ['src/generated.mjs', 'src/mine.mjs']);
  assert.deepEqual([writers.get('src/generated.mjs').writer, writers.get('src/generated.mjs').basis], ['copilot', 'shell-write']);
  assert.deepEqual(writers.get('src/mine.mjs'), { writer: 'person', basis: 'not-recorded' });
  // Never a line's writer: the record carries no line steps, so line attribution leaves it out.
  assert.equal(attributeLineWriter({ records, path: 'src/generated.mjs', end: sha('export const table = [1, 2, 3];\n'), line: 1 }).status, 'unestablished');
  const settlement = outsidePlanSettlement('src/generated.mjs', { phase, stepName: 'Code', writer: writers.get('src/generated.mjs'), reason: 'the table is generated from the schema' });
  assert.equal(settlement.answer, 'Took src/generated.mjs up with Code: changed outside the plan by Copilot, through a terminal command: the table is generated from the schema.');
  assert.ok(settlement.evidence.some((entry) => entry.what === 'SFlow\'s hook saw a Copilot terminal command leave it as it is now'));
});

test('with SF Guard on, a Copilot terminal command recorded running when the file last changed makes it Copilot\'s; an edit outside the call stays "by you" [WCB:REQ-011]', async (t) => {
  const { directory, boundaries } = await machine(t);
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  run(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'singularity/presence.json'), JSON.stringify({ schema: 'sflow-presence-chain@1', events: [{ seq: 0, kind: 'enable' }] }));
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ workId: 'GAP-2', phaseId: 'implementation' }));
  const workflow = { workItem: { id: 'GAP-2', createdAt: new Date(Date.now() - 60_000).toISOString() } };
  const payload = { sessionId: 'gap-guard', cwd: root };
  await sfGuardNotePrompt({ ...payload, prompt: 'Regenerate the table.' }, { directory: boundaries });
  const call = { ...payload, toolName: 'bash', toolArgs: { command: 'sed -i "" s/1/2/ src/table.mjs' } };
  await sfGuardNoteToolCall(call, {}, { directory: boundaries });
  await writeFile(path.join(root, 'src/table.mjs'), 'export const table = [2];\n');
  await sfGuardNoteToolResult(call, { directory: boundaries });
  // A file the person changed a minute before the call.
  await writeFile(path.join(root, 'src/mine.mjs'), 'export const mine = true;\n');
  const before = new Date(Date.now() - 60_000);
  await utimes(path.join(root, 'src/mine.mjs'), before, before);

  const [shell] = await readSfGuardShellRecords(root);
  assert.deepEqual([shell.ran, shell.subject.workId, shell.writer.kind], [true, 'GAP-2', 'copilot-session']);
  const writers = await codeWriters(root, workflow, ['src/table.mjs', 'src/mine.mjs']);
  assert.deepEqual([writers.get('src/table.mjs').writer, writers.get('src/table.mjs').basis], ['copilot', 'shell-call']);
  assert.deepEqual(writers.get('src/mine.mjs'), { writer: 'person', basis: 'not-recorded' }, 'the hooks ran here, and no call explains it');
  // Another Story's call is not this Story's.
  const other = { workItem: { id: 'GAP-OTHER', createdAt: workflow.workItem.createdAt } };
  assert.equal((await codeWriters(root, other, ['src/table.mjs'])).get('src/table.mjs').writer, 'person');
  assert.equal(outsidePlanWords({ file: 'src/table.mjs', writer: 'copilot', basis: 'shell-call', reason: null }), 'src/table.mjs: by Copilot, through a terminal command: no reason written');
});

test('a checkout reached through a link finds the records its hooks wrote there, and says plainly when no hook ran [WCB:REQ-011]', async (t) => {
  const { directory, boundaries } = await machine(t);
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  run(root, 'init', '-q', '-b', 'main');
  await writeFile(path.join(root, 'singularity/presence.json'), JSON.stringify({ schema: 'sflow-presence-chain@1', events: [{ seq: 0, kind: 'enable' }] }));
  const linked = path.join(directory, 'linked');
  await symlink(root, linked);
  const workflow = { workItem: { id: 'GAP-3', createdAt: new Date(Date.now() - 60_000).toISOString() } };

  // Copilot CLI runs its hooks from the link: the session's checkout is the real one, so every reader finds it.
  const payload = { sessionId: 'gap-link', cwd: linked };
  await sfGuardNotePrompt({ ...payload, prompt: 'Format the table.' }, { directory: boundaries });
  const call = { ...payload, toolName: 'bash', toolArgs: { command: 'npx prettier --write src/table.mjs' } };
  await sfGuardNoteToolCall(call, {}, { directory: boundaries });
  assert.ok(await sfGuardRunningCall(root, { directory: boundaries }), 'the running call is found from the real path');
  assert.ok(await sfGuardRunningCall(linked, { directory: boundaries }), 'and from the link');
  await writeFile(path.join(linked, 'src/table.mjs'), 'export const table = [1];\n');
  await sfGuardNoteToolResult(call, { directory: boundaries });
  assert.equal((await sfGuardRepository(linked)).root, root);
  const [shell] = await readSfGuardShellRecords(linked);
  assert.equal(shell.cwd, '.', 'the call ran at the checkout\'s top, named by its real path');
  for (const at of [root, linked]) {
    const writers = await codeWriters(at, workflow, ['src/table.mjs']);
    assert.deepEqual([writers.get('src/table.mjs').writer, writers.get('src/table.mjs').basis], ['copilot', 'shell-call'], at);
  }

  // VS Code opened a second checkout through a link, where Copilot runs no hooks: nothing was recorded, and the basis says why.
  const quiet = path.join(directory, 'quiet');
  await mkdir(path.join(quiet, 'src'), { recursive: true });
  run(quiet, 'init', '-q', '-b', 'main');
  await writeFile(path.join(quiet, 'src/value.mjs'), 'export const value = 2;\n');
  const quietWorkflow = { workItem: { id: 'GAP-4', createdAt: workflow.workItem.createdAt } };
  assert.deepEqual((await codeWriters(quiet, quietWorkflow, ['src/value.mjs'])).get('src/value.mjs'), { writer: 'person', basis: 'no-hook-records' });
  const opened = path.join(directory, 'quiet-link');
  await symlink(quiet, opened);
  const storage = path.join(process.env.SINGULARITY_FLOW_VSCODE_USER_DATA, 'User', 'workspaceStorage', 'window-1');
  await mkdir(storage, { recursive: true });
  await writeFile(path.join(storage, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(opened).href }));
  const writer = (await codeWriters(quiet, quietWorkflow, ['src/value.mjs'])).get('src/value.mjs');
  assert.deepEqual(writer, { writer: 'person', basis: 'linked-folder' });
  const settlement = outsidePlanSettlement('src/value.mjs', { phase: { id: 'implementation' }, stepName: 'Code', writer });
  assert.equal(settlement.answer, 'Took src/value.mjs up with Code: changed outside the plan by you (no SFlow hooks ran here: VS Code opened this folder through a link).');
  assert.ok(settlement.evidence.some((entry) => entry.what === 'no hooks ran here: VS Code opened this folder through a link, and Copilot runs no hooks there'));
  assert.ok(!JSON.stringify(settlement).includes(directory), 'no path of this machine goes into the Story\'s record');
});

test('main merged in during a document step: its files hold what main has, so they are main\'s, never "by you"; a file the Story changed stays its own [WCB]', async (t) => {
  const { directory } = await machine(t);
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.name', 'Gap Tester');
  run(root, 'config', 'user.email', 'gap.tester@example.invalid');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'src/shared.mjs'), 'export const shared = 1;\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'base');
  const baseCommit = run(root, 'rev-parse', 'HEAD');
  run(root, 'checkout', '-q', '-b', 'GAP-5');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  run(root, 'commit', '-qam', 'the Story\'s own change');
  // main moves on: a new file and a change to a shared one; the Story merges it in, then changes the shared file again.
  run(root, 'checkout', '-q', 'main');
  await writeFile(path.join(root, 'src/feature.mjs'), 'export const feature = true;\n');
  await writeFile(path.join(root, 'src/shared.mjs'), 'export const shared = 2;\n');
  run(root, 'add', '.');
  run(root, 'commit', '-qm', 'main moves on');
  const merged = run(root, 'rev-parse', 'HEAD');
  run(root, 'checkout', '-q', 'GAP-5');
  run(root, 'merge', '-q', '--no-edit', 'main');
  await writeFile(path.join(root, 'src/shared.mjs'), 'export const shared = 3;\n');
  const workflow = { workItem: { id: 'GAP-5', baseBranch: 'main', baseCommit, createdAt: new Date(Date.now() - 60_000).toISOString() } };

  const writers = await codeWriters(root, workflow, ['src/feature.mjs', 'src/shared.mjs', 'src/value.mjs'], { config: { git: { remote: 'origin' } } });
  assert.deepEqual(writers.get('src/feature.mjs'), { writer: 'base', basis: 'merged-from-base', branch: 'main', commit: merged });
  assert.equal(writers.get('src/shared.mjs').writer, 'person', 'changed again in the Story after the merge');
  assert.equal(writers.get('src/value.mjs').writer, 'person');
  // No merge newer than the Story's start: nothing is the base branch's.
  assert.equal((await codeWriters(root, { workItem: { ...workflow.workItem, baseCommit: merged } }, ['src/feature.mjs'])).get('src/feature.mjs').writer, 'person');

  const phase = { id: 'implementation' };
  const settlement = outsidePlanSettlement('src/feature.mjs', { phase, stepName: 'Code', writer: writers.get('src/feature.mjs'), reason: 'ignored' });
  assert.equal(settlement.answer, 'Took src/feature.mjs up with Code: it came from main, merged in: not changed in this Story.');
  assert.deepEqual(settlement.effect, { file: 'src/feature.mjs', class: 'out-of-plan', writer: 'base', basis: 'merged-from-base', reason: null,
    kind: 'behaviour', branch: 'main', commit: merged });
  assert.ok(settlement.evidence.some((entry) => entry.what === `it holds exactly what main has at ${merged.slice(0, 12)}: it came in when that branch was merged, not from this Story`));
  const listed = outsidePlanSettled({ settledDecisions: [{ id: 'STL-001', ...settlement, at: '2026-11-28T00:00:00.000Z' }] }, 'implementation');
  assert.deepEqual(listed.map((entry) => [entry.file, entry.writer, entry.branch]), [['src/feature.mjs', 'base', 'main']]);
  assert.deepEqual(listed.map(outsidePlanWords), ['src/feature.mjs: from main, merged in: not changed in this Story']);
  assert.equal(outsidePlanWho({ writer: 'base', branch: 'main', supporting: 'documentation' }), 'from main, merged in: not changed in this Story');
});
