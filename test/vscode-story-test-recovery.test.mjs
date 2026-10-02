import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { testRecoveryPreviewArgs, testRecoveryReviewActions } from '../apps/vscode/src/views/story-test-recovery.ts';
import { terminalCommand } from '../apps/vscode/src/cli/runner.ts';

const subject = { workId: 'example-story', phaseId: 'implementation' };
const reason = 'Repair the approved test runner';
const hash = `sha256:${'a'.repeat(64)}`;
const preview = { schemaVersion: 1, resultType: 'test-command-amendment-preview',
  status: 'ready', ...subject, planSha256: hash, stateChanged: false, executed: false };

test('Story test recovery previews are fixed read-only invocations', () => {
  assert.deepEqual(testRecoveryPreviewArgs('show', subject), ['story', 'test-policy', 'show', '--work-id', subject.workId, '--json']);
  assert.deepEqual(testRecoveryPreviewArgs('attest', subject), ['story', 'test-policy', 'attest', '--work-id', subject.workId, '--json']);
  assert.deepEqual(testRecoveryPreviewArgs('amend', subject, reason), ['story', 'test-policy', 'amend', '--work-id', subject.workId,
    '--phase', subject.phaseId, '--reason', reason, '--json']);
  for (const bad of ['', 'short', 'long explanation\nwith control', 'a'.repeat(2001)]) assert.throws(() => testRecoveryPreviewArgs('amend', subject, bad));
  for (const bad of ['../elsewhere', '-another', 'x;sh', 'x..y']) assert.throws(() => testRecoveryPreviewArgs('show', { ...subject, workId: bad }));
  assert.throws(() => testRecoveryPreviewArgs('accept-risk', subject));
});

test('only the exact current Story preview provides a terminal review selection', () => {
  const actions = testRecoveryReviewActions(preview, 'amend', subject, reason);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0].args.slice(-3), ['--apply', '--confirm', hash]);
  assert.deepEqual(testRecoveryReviewActions({ resultType: 'command-result', data: preview }, 'amend', subject, reason), actions);
  for (const change of [
    { workId: 'other' }, { phaseId: 'testing' }, { schemaVersion: 2 }, { status: 'applied' },
    { resultType: 'unrelated' }, { stateChanged: true }, { executed: true }, { planSha256: 'not-a-digest' }
  ]) assert.deepEqual(testRecoveryReviewActions({ ...preview, ...change }, 'amend', subject, reason), []);
  assert.deepEqual(testRecoveryReviewActions({ ...preview, legalActions: [{ command: 'sh', args: ['-c', 'unsafe'] }] }, 'amend', subject, reason), actions);
});

test('re-attestation prepares only missing reviews bound to the selected Story', () => {
  const row = { sha256: hash, originPresent: false, review: { workId: subject.workId } };
  const result = { workId: subject.workId, stateChanged: false, executed: false, reviews: [row,
    { ...row, sha256: `sha256:${'b'.repeat(64)}`, originPresent: true },
    { ...row, review: { workId: 'other' } }, { ...row, sha256: 'arbitrary' }] };
  assert.deepEqual(testRecoveryReviewActions(result, 'attest', subject).map(item => item.args), [[
    'story', 'test-policy', 'attest', '--work-id', subject.workId, '--apply', '--confirm', hash
  ]]);
  assert.deepEqual(testRecoveryReviewActions(result, 'show', subject), []);
});

test('review commands quote shell-sensitive reasons on Windows and POSIX', () => {
  const text = 'Fix runner; $(touch nope) `calc` \'quote\'';
  const args = testRecoveryReviewActions(preview, 'amend', subject, text)[0].args;
  const windows = terminalCommand('C:\\project with spaces', args, 'win32', { executable: 'C:\\Node\\node.exe', cli: 'C:\\app\\cli.mjs' });
  assert.match(windows, /^Set-Location -LiteralPath 'C:/u);
  assert.ok(windows.includes("'Fix runner; $(touch nope) `calc` ''quote'''"));
  const posix = terminalCommand('/tmp/project with spaces', args, 'darwin');
  assert.ok(posix.includes("'Fix runner; $(touch nope) `calc` '" + '"\'"' + "'quote'" + '"\'"' + "''"));
});

test('VS Code exposes recovery without executing or accepting a decision on a click', async () => {
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const start = extension.indexOf("'singularityFlow.reviewStoryTestRecovery': async");
  const route = extension.slice(start, extension.indexOf("'singularityFlow.prefillStoryPhaseGeneration':", start));
  assert.match(route, /client\.run<unknown>\(args\)/u);
  assert.match(route, /testRecoveryPreviewArgs\(choice.action/u);
  assert.match(route, /repositoryEpoch\.isCurrent\(scope\)/u);
  assert.match(route, /const attachedPhaseId = workflow.currentPhase/u);
  assert.match(route, /currentPhase === attachedPhaseId/u);
  assert.match(route, /terminal\.sendText\(terminalCommand\([^\n]+, false\)/u);
  assert.match(route, /'powershell.exe' : '\/bin\/sh'/u);
  assert.match(route, /ELECTRON_RUN_AS_NODE: '1'/u);
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(item => item.command === 'singularityFlow.reviewStoryTestRecovery'));
  const tree = await readFile(new URL('../apps/vscode/src/views/tree-model.ts', import.meta.url), 'utf8');
  assert.match(tree, /label: 'Test policy and recovery'/u);
});
