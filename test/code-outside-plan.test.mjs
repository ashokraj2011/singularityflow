/**
 * Code outside the plan [WCB, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md]: which files no gate counts, who changed a file
 * (from SFlow's own hook records), the reason Copilot wrote in its document, and the settlement that takes it up.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isWorkspaceLocalPath } from '../src/workspace-local-paths.mjs';
import { codeWriters, outsidePlanReasons, outsidePlanSettlement } from '../src/code-outside-plan.mjs';
import { captureToolWrites, settleToolWrites } from '../src/comprehension/xpl2/observed-write-recorder.mjs';
import { outsidePlanSettled } from '../src/plan-amendments.mjs';
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
