/**
 * Models off, ask once, remember [owner, 2026-11-28; stuck points, dead end 10].
 *
 * With models off, a test command that declares no modelPolicy was skipped, and the same check skipped it again on every
 * run. Now the person is asked once per repository, "Does `<command>` call an AI model?", with one line on why it matters.
 * The answer is kept with the repository's other SFlow records in its shared Git folder. No: the tests run. Yes: models
 * are off, and the way on is one button that runs the same check with models on for that run. Never the same skip again.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandModelKey, MODEL_USE_WHY, modelUseAnswer, modelUseQuestion, readModelUse, recordModelUse, TEST_MODEL_USE_FILE } from '../src/test-model-use.mjs';
import { evaluateExternalCommandForModelMode } from '../src/external-command-policy.mjs';
import { resolveModelMode, stripGlobalModelOptions } from '../src/model-mode.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';

const SUITE = { id: 'unit', kind: 'test', argv: ['npm', 'test'], workingDirectory: 'web' };

test('an answer is kept for the repository, for the exact command, and a changed command is asked again', async (t) => {
  const common = await mkdtemp(path.join(os.tmpdir(), 'sflow-model-use-'));
  t.after(() => rm(common, { recursive: true, force: true }));
  assert.deepEqual(readModelUse(common), {}, 'nothing answered yet');
  const key = commandModelKey(SUITE);
  assert.equal(key.commandId, 'unit');
  assert.match(key.argvSha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(commandModelKey({ ...SUITE, argv: ['npm', 'run', 'test:all'] }).argvSha256, key.argvSha256, 'other words, another command');
  assert.notEqual(commandModelKey({ ...SUITE, workingDirectory: 'api' }).argvSha256, key.argvSha256, 'another folder, another command');
  assert.throws(() => recordModelUse(common, { ...key, calls: 'maybe' }), { code: 'TEST_MODEL_USE_INVALID' });
  const entry = recordModelUse(common, { ...key, calls: 'no', by: 'ana' });
  assert.deepEqual([entry.calls, entry.by], ['no', 'ana']);
  assert.ok(TEST_MODEL_USE_FILE.startsWith('singularity-flow'), 'with the repository\'s other SFlow records in its shared Git folder');
  assert.equal(modelUseAnswer(readModelUse(common), SUITE), 'no');
  assert.equal(modelUseAnswer(readModelUse(common), { ...SUITE, argv: ['npm', 'run', 'test:all'] }), null, 'a changed command is asked again');
  recordModelUse(common, { ...key, calls: 'yes' });
  assert.equal(modelUseAnswer(readModelUse(common), SUITE), 'yes', 'a later answer replaces the earlier one');
  const asked = modelUseQuestion(SUITE);
  assert.equal(asked.question, 'Does `npm test` call an AI model?');
  assert.equal(asked.why, MODEL_USE_WHY);
});

test('models off: No runs the tests, Yes keeps them off, unknown asks; models on or a declared policy never ask', () => {
  const off = (answer) => evaluateExternalCommandForModelMode(SUITE, { modelEnabled: false, modelUseOf: () => answer });
  assert.deepEqual([off('no').action, off('no').modelUse, off('no').reason], ['run', 'no', null]);
  assert.deepEqual([off('yes').action, off('yes').modelUse], ['skip', 'yes']);
  assert.match(off('yes').reason, /calls an AI model \(as you said\), and models are off for this run/u);
  assert.deepEqual([off(null).action, off(null).modelUse], ['skip', 'unknown']);
  assert.equal(evaluateExternalCommandForModelMode(SUITE, { modelEnabled: true, modelUseOf: () => 'yes' }).action, 'run', 'models on: it runs');
  assert.equal(evaluateExternalCommandForModelMode({ ...SUITE, modelPolicy: 'never' }, { modelEnabled: false, modelUseOf: () => 'yes' }).action, 'run',
    'a command that declares it calls none is never asked');
  assert.equal(evaluateExternalCommandForModelMode(SUITE, { modelEnabled: false }).modelUse, undefined, 'a caller that reads no answers is as before');
});

test('models on for one run: --models-on overrides models being off from the environment, never --no-model', () => {
  assert.deepEqual(resolveModelMode(['phase', 'prepublish', 'code', '--models-on'], { SINGULARITY_FLOW_NO_MODEL: '1' }), { enabled: true, source: 'run' });
  assert.equal(resolveModelMode(['phase', 'prepublish', 'code'], { SINGULARITY_FLOW_NO_MODEL: '1' }).enabled, false);
  assert.throws(() => resolveModelMode(['--no-model', '--models-on'], {}), { code: 'MODEL_MODE_CONFLICT' });
  assert.deepEqual(stripGlobalModelOptions(['phase', 'prepublish', 'code', '--models-on']), ['phase', 'prepublish', 'code']);
});

const skipped = (modelUse) => Object.assign(new Error('Required test command \'unit\' was skipped before publication.'), { code: 'CODE_TEST_SKIPPED',
  details: { workId: 'W-1', phase: 'code', phaseId: 'code', requiredTestExecution: { commandId: 'unit', argv: ['npm', 'test'], provenance: 'inferred', cwd: '/repo/web',
    resultPath: '/repo/web/report.xml', workingDirectory: 'web', status: 'skipped-warning', failure: { kind: 'model-policy-skipped' }, modelUse } } });

test('the skipped run asks its one question with its why; once answered yes, one route runs the check with models on', () => {
  const question = { ...modelUseQuestion(SUITE), answer: 'unknown' };
  const argv = ['phase', 'prepublish', 'code', '--work-id', 'W-1'];
  const asked = refusalRemediationPlan(skipped(question), argv);
  assert.deepEqual(asked.steps.slice(0, 2).map((entry) => [entry.id, entry.command]), [
    ['model-use-no', `singularity-flow tests model-use --command unit --argv-sha256 ${question.argvSha256} --calls no`],
    ['model-use-yes', `singularity-flow tests model-use --command unit --argv-sha256 ${question.argvSha256} --calls yes`]]);
  assert.ok(asked.steps[0].label.startsWith(`${question.question} ${MODEL_USE_WHY}`), asked.steps[0].label);
  assert.ok(!asked.steps.some((entry) => entry.command === 'singularity-flow phase prepublish code --work-id W-1'), 'never the same skipped check again');
  // Answered yes: models are off, and one route turns them on for this run.
  const on = refusalRemediationPlan(skipped({ ...question, answer: 'yes' }), [...argv, '--no-model']);
  assert.deepEqual([on.steps[0].id, on.steps[0].command, on.steps[0].changes],
    ['models-on-for-run', 'singularity-flow phase prepublish code --work-id W-1 --models-on', 'models are on for this run']);
  // The prepublish finding routes the same way.
  const workflow = { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'code', phaseOrder: ['code'],
    phases: { code: { id: 'code', status: 'in_progress', generation: 1, generationPolicy: { defaultProducer: 'governed-agent', task: 'code' } } }, resolution: { phases: [] } };
  const finding = (modelUse) => ({ code: 'CODE_TEST_SKIPPED', category: 'tests', details: { requiredTestExecution: { failure: { kind: 'model-policy-skipped' }, modelUse } } });
  const [lead] = phaseResolutionChoices(workflow, workflow.phases.code, finding(question)).choices;
  assert.deepEqual([lead.kind, lead.argv.slice(0, 2)], ['model-use-question', ['tests', 'model-use']]);
  const [yes] = phaseResolutionChoices(workflow, workflow.phases.code, finding({ ...question, answer: 'yes' })).choices;
  assert.deepEqual([yes.kind, yes.argv.at(-1), yes.changes], ['models-on-for-run', '--models-on', 'models are on for this run']);
});

test('the answers are the person\'s: no Copilot turn records one or turns models on', () => {
  const turn = { contract: { workId: 'W-1', phaseId: 'code' }, decisionEnded: false };
  for (const mode of ['decision-only', 'read', 'authoring']) {
    assert.equal(argvAllowed(['tests', 'model-use', '--command', 'unit', '--argv-sha256', 'a'.repeat(64), '--calls', 'no'], mode, turn), false, mode);
    assert.equal(argvAllowed(['phase', 'prepublish', 'code', '--for-agent', '--json', '--models-on'], mode, turn), false, mode);
  }
});
