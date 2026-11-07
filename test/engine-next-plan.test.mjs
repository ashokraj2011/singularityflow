import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createEngine, createStoryNextEngine, ENGINE_OPERATIONS } from '../src/engine-sdk/index.mjs';
import { workflowNextManifest, workflowNextPlan } from '../src/kernel/next-plan.mjs';
import { nextStepsSnapshot, nextStepsText, nextStepObservations } from '../src/nextsteps.mjs';
import { nextPlanCases } from './helpers/next-plan-cases.mjs';

function fixture(name = 'document-unpublished') {
  const entry = nextPlanCases().find(entry => entry.name === name), { workflow } = entry.options;
  const observations = nextStepObservations(workflow, entry.options).facts;
  return { entry, context: { subject: { kind: 'story', id: workflow.workItem.id }, workflow, observations } };
}

test('50 native next-step snapshots and text retain their original serialized bytes', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-next-plan/native-v1.json', import.meta.url), 'utf8'));
  for (const [index, entry] of nextPlanCases().entries()) {
    const snapshot = nextStepsSnapshot(entry.options), value = JSON.stringify({ snapshot, text: nextStepsText(snapshot) });
    assert.equal(entry.name, baseline.cases[index].name);
    assert.equal(createHash('sha256').update(value).digest('hex'), baseline.cases[index].sha256, entry.name);
  }
});

test('the registered query and narrow native composition execute the same coordinator and captured plan', async () => {
  for (const entry of nextPlanCases().filter(entry => entry.options.workflow)) {
    const { workflow } = entry.options, before = structuredClone(workflow);
    const observations = nextStepObservations(workflow, entry.options).facts;
    let calls = 0;
    const ports = { storyNext: { async load() { calls++; return { subject: { kind: 'story', id: workflow.workItem.id }, workflow, observations }; } } };
    const engine = createEngine({ ports }), narrow = createStoryNextEngine({ ports });
    const result = await engine.run('story.next', { workId: workflow.workItem.id });
    assert.deepEqual(await narrow.run('story.next', { workId: workflow.workItem.id }), result, entry.name);
    assert.equal(calls, 2); assert.deepEqual(workflow, before);
    assert.deepEqual(nextStepsSnapshot({ ...entry.options, nextPlan: result.manifest.actions }), nextStepsSnapshot(entry.options));
    assert.equal(result.manifest.contract, 'sflow-next-steps/v1');
    assert.equal(result.manifest.authorityGranted, false); assert.equal(result.manifest.finalBindingChecked, false);
    assert.equal(result.manifest.automaticAdvance, false); assert.equal(result.effects.modelInvocations, 0);
    assert.equal(result.effects.approvalRecorded, false); assert.equal(result.effects.committed, false);
    assert.ok(Object.isFrozen(result.manifest.actions));
    assert.doesNotMatch(JSON.stringify(result), /singularity-flow|\/sf-|\/sflow-|"(?:command|argv|skill|reason|instruction|prompt)":/u);
    for (const action of result.manifest.actions) if (action.operation) {
      const descriptor = ENGINE_OPERATIONS.find(operation => operation.id === action.operation.id);
      assert.ok(descriptor, action.kind); assert.equal(descriptor.port, action.operation.port);
      assert.ok(Object.keys(action.operation.inputs).every(field => descriptor.inputFields.includes(field)));
      if (action.operation.id !== 'story.next') await assert.rejects(narrow.run(action.operation.id, action.operation.inputs), { code: 'ENGINE_PORT_UNAVAILABLE' });
    }
  }
});

test('semantic holds replace approval or completing submission without suppressing current repair work', () => {
  for (const name of ['personal-decision', 'pending-decisions', 'approval-holds', 'step-sheet']) {
    const { context } = fixture(name), plan = workflowNextManifest(context.workflow, context.observations);
    assert.equal(plan.actions.some(action => action.kind === 'approve-phase'), false, name);
  }
  const { context } = fixture('document-no-approval');
  context.observations.decisionHold = true;
  const held = workflowNextPlan(context.workflow, context.observations);
  assert.equal(held.some(action => action.kind === 'submit-phase'), false);
  assert.ok(held.some(action => action.kind === 'pending-decisions'));
  context.observations.publicationPending = true; context.observations.recoveryRequired = true;
  assert.deepEqual(workflowNextPlan(context.workflow, context.observations).map(action => action.kind), ['retry-publication', 'recalculate-next']);
});

test('captured presentation avoids repeated facts and priority recovery does not inspect lower rules', () => {
  const { entry } = fixture('approval-holds'), { workflow } = entry.options;
  const observed = nextStepObservations(workflow, entry.options), manifest = workflowNextManifest(workflow, observed.facts);
  Object.defineProperty(entry.options.approvalCheck, 'holds', { get() { throw new Error('must not inspect twice'); } });
  const shown = nextStepsSnapshot({ ...entry.options, nextPlan: manifest.actions, nextPresentation: observed.presentation });
  assert.ok(shown.actions.some(action => action.route === 'approval-hold'));
  const blocked = fixture().entry;
  Object.defineProperty(blocked.options.workflow.resolution, 'decisions', { get() { throw new Error('lower-priority rules'); } });
  assert.equal(nextStepsSnapshot({ ...blocked.options, publicationPending: true }).actions[0].command, 'singularity-flow sync');
  assert.equal(nextStepsSnapshot({ ...blocked.options, recovery: { requiresRecovery: true } }).actions[0].route, 'recovery');
});

test('ports cannot inject actions, host commands, unbounded observations or another Story', async () => {
  const { context } = fixture(), port = { async load() { return context; } }, engine = createEngine({ ports: { storyNext: port } });
  for (const bad of [{ actions: [] }, { command: 'ignored' }, { approvalRecorded: true }, { modelEnabled: undefined },
    { mcpActionCount: Infinity }, { mcpActionCount: -1 }, { visualRouteCount: 4097 },
    { prerequisites: [{ timing: 'now', preparesPhase: false, argv: [] }] },
    { authoringState: { available: true, stage: 'draft', prompt: 'PRIVATE' } }]) {
    const original = context.observations; context.observations = { ...original, ...bad };
    await assert.rejects(engine.run('story.next'), error => error.code === 'ENGINE_PORT_RESULT_INVALID' && error.cause.code === 'ENGINE_INPUT_INVALID');
    context.observations = original;
  }
  await assert.rejects(engine.run('story.next', { workId: 'OTHER' }), { code: 'ACTIVE_SUBJECT_MISMATCH' });
  for (const input of [{ root: '/other' }, { workId: 9 }, { workId: '' }, []]) await assert.rejects(engine.run('story.next', input), { code: 'ENGINE_INPUT_INVALID' });
  const invalid = createEngine({ ports: { storyNext: { async load() { return { subject: context.subject, workflow: {} }; } } } });
  await assert.rejects(invalid.run('story.next'), { code: 'ENGINE_PORT_RESULT_INVALID' });
});

test('cancellation and native read errors retain their actual identity and cause', async () => {
  const { context } = fixture(), original = new Error('actual repository read failure', { cause: new Error('original transport error') });
  let calls = 0;
  const engine = createEngine({ ports: { storyNext: { async load() { calls++; throw original; } } } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(engine.run('story.next', {}, { signal: controller.signal }), { code: 'ENGINE_OPERATION_CANCELLED' });
  assert.equal(calls, 0); await assert.rejects(engine.run('story.next'), error => error === original);
  const late = new AbortController(), bound = createEngine({ ports: { storyNext: { async load() { late.abort(); return context; } } } });
  await assert.rejects(bound.run('story.next', {}, { signal: late.signal }), { code: 'ENGINE_OPERATION_CANCELLED' });
});

test('planning and the narrow registered executor run with every infrastructure import and executable refused', () => {
  const { context } = fixture();
  const source = `
    import {registerHooks} from 'node:module';
    const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:'))throw new Error(specifier);return next(specifier,context);}});
    const sdk=await import(${JSON.stringify(new URL('../src/engine-sdk/index.mjs', import.meta.url).href)});
    const context=${JSON.stringify(context)};
    const engine=sdk.createStoryNextEngine({ports:{storyNext:{async load(){return context;}}}});
    const result=await engine.run('story.next',{workId:context.subject.id});
    if(result.manifest.actions[0].kind!=='prepare-phase'||result.effects.committed)throw new Error('wrong plan');
    hooks.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
