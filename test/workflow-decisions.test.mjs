import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import {
  chooseRoute, decisionOutcome, describeOutcome, describeWhen, normalizeDecisionInputValues,
  parseDecisionAssignments, pendingDecisionRecord, resolveDecisionChoice, routeReach,
  assertChoiceKeepsDependencies, obligationsDroppedBySkips
} from '../src/workflow-decisions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASES = ['intake', 'requirements', 'design', 'implementation-spec'];

async function definitionWith(decisions, { overrides = {}, workType = {} } = {}) {
  const raw = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  raw.workTypes['decide-demo'] = {
    label: 'Decision demo',
    phases: PHASES,
    phaseOverrides: {
      requirements: { inputs: ['intake'] },
      design: { inputs: ['intake', { phase: 'requirements', optional: true }] },
      'implementation-spec': { inputs: ['intake', 'design'] },
      ...overrides
    },
    ...workType,
    ...(decisions === undefined ? {} : { decisions })
  };
  return validateDefinition(raw);
}

const BRANCH = {
  id: 'needs-requirements', after: 'intake', kind: 'branch', label: 'Does this need full requirements?',
  inputs: [{ name: 'risk', label: 'Risk', values: ['low', 'medium', 'high'] }],
  routes: [
    { id: 'risky', label: 'Risky', when: { risk: ['medium', 'HIGH'] }, to: 'requirements' },
    { id: 'simple', label: 'Simple', to: 'design' }
  ]
};
const LOOP = {
  id: 'until-ready', after: 'design', kind: 'loop', label: 'Rework until the design is ready',
  inputs: [{ name: 'ready', values: ['yes', 'no'] }], goal: { ready: 'yes' }, back: 'requirements', maxRounds: 2
};
const ASK = {
  id: 'direction', after: 'requirements', kind: 'ask', label: 'Where next?',
  routes: [
    { id: 'continue', label: 'Continue', to: 'next' },
    { id: 'again', label: 'Another round', to: 'requirements' },
    { id: 'stop', label: 'Finish here', to: 'end' }
  ]
};

function story(definition, phaseStates = {}) {
  const resolved = resolveWorkType(definition, 'decide-demo');
  const phases = Object.fromEntries(resolved.phases.map((phase) => [phase.id, {
    id: phase.id, label: phase.label, status: 'not_started', inputs: phase.inputs, ...(phaseStates[phase.id] ?? {})
  }]));
  return { phaseOrder: resolved.phases.map((phase) => phase.id), phases, resolution: { ...resolved }, decisionRounds: {} };
}

test('decisions resolve into one canonical shape and are pinned only when declared', async () => {
  const definition = await definitionWith([BRANCH, LOOP, ASK]);
  const resolved = resolveWorkType(definition, 'decide-demo');
  assert.deepEqual(resolved.decisions.map((decision) => [decision.id, decision.kind, decision.mode]), [
    ['needs-requirements', 'branch', 'auto'], ['until-ready', 'loop', 'auto'], ['direction', 'ask', 'ask']
  ]);
  const [branch, loop, ask] = resolved.decisions;
  assert.deepEqual(branch.routes[0].when, { risk: { in: ['medium', 'high'] } }, 'choices take their declared spelling');
  assert.equal(branch.routes[1].when, null);
  assert.equal(branch.maxRounds, null, 'a branch that never goes back has no round limit');
  assert.deepEqual(branch.by, ['product-approvers'], 'the deciding phase\'s approvers decide by default');
  assert.deepEqual(loop.routes.map((route) => [route.id, route.to]), [['goal-met', 'next'], ['again', 'requirements']]);
  assert.equal(loop.maxRounds, 2);
  assert.deepEqual(loop.goal, { ready: { in: ['yes'] } });
  assert.equal(ask.anyStep, false);
  assert.equal(Object.hasOwn(resolveWorkType(definition, 'feature'), 'decisions'), false,
    'a workflow without decisions resolves exactly as before');
});

test('configuration refuses decisions that cannot be followed', async () => {
  const refused = async (decisions, pattern, options) => {
    await assert.rejects(definitionWith(decisions, options), (error) => {
      assert.equal(error.code, 'WORKFLOW_DECISION_INVALID', error.message);
      assert.match(error.message, pattern);
      return true;
    });
  };
  await refused([{ ...BRANCH, unexpected: true }], /unknown field 'unexpected'/);
  await refused([{ ...BRANCH, after: 'release' }], /after must name a phase/);
  await refused([BRANCH, { ...ASK, id: 'second', after: 'intake' }], /already has a decision after it/);
  await refused([{ ...BRANCH, routes: [BRANCH.routes[0], { ...BRANCH.routes[1], when: { risk: 'low' } }] }], /last route/);
  await refused([{ ...BRANCH, routes: [{ ...BRANCH.routes[0], when: undefined }, BRANCH.routes[1]] }], /must say which recorded values/);
  await refused([{ ...BRANCH, routes: [{ ...BRANCH.routes[0], when: { size: 'big' } }, BRANCH.routes[1]] }], /not one of this decision's inputs/);
  await refused([{ ...BRANCH, routes: [{ ...BRANCH.routes[0], when: { risk: 'severe' } }, BRANCH.routes[1]] }], /not one of Risk's choices/);
  await refused([{ ...LOOP, back: 'implementation-spec' }], /back must name 'design' or an earlier phase/);
  await refused([{ ...LOOP, maxRounds: 0 }], /maxRounds must be a whole number/);
  await refused([{ ...BRANCH, maxRounds: 2 }], /maxRounds needs a route that goes back/);
  await refused([{ ...ASK, inputs: BRANCH.inputs }], /records no inputs/);
  await refused([{ ...ASK, maxRounds: 2 }], /a person chooses every round/);
  await refused([{ ...ASK, by: ['nobody'] }], /unknown approval group 'nobody'/);
  await refused([{ ...LOOP, kind: 'branch', routes: [{ id: 'x', label: 'X', when: { ready: 'no' }, to: 'requirements' }, { id: 'y', label: 'Y', to: 'next' }], goal: undefined, back: undefined }],
    /A rule may send work back only after a phase a person signs off/, { overrides: { design: { inputs: ['intake'], approval: 'none' } } });
  await refused([BRANCH], /skips 'requirements', which people sign off/, { overrides: { intake: { approval: 'none' } } });
  await refused([BRANCH], /skips 'requirements', which 'design' reads/, { overrides: { design: { inputs: ['intake', 'requirements'] } } });
  await refused([{ ...ASK, after: 'intake', by: undefined }], /needs by/, { overrides: { intake: { approval: 'none' } } });
});

test('a skipped planning phase must not strand the code phase whose claims it plans', async () => {
  const raw = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  raw.workTypes.feature.phaseOverrides.implementation.inputs = ['design'];
  raw.workTypes.feature.phaseOverrides.verification.inputs = ['implementation'];
  raw.workTypes.feature.phaseOverrides.conformance.inputs = ['implementation', 'verification'];
  raw.workTypes.feature.decisions = [{
    id: 'skip-spec', after: 'design', kind: 'branch', label: 'Skip the implementation spec?',
    inputs: [{ name: 'size', values: ['small', 'large'] }],
    routes: [{ id: 'large', label: 'Large', when: { size: 'large' }, to: 'implementation-spec' }, { id: 'small', label: 'Small', to: 'implementation' }]
  }];
  assert.throws(() => validateDefinition(raw), /skips 'implementation-spec', which plan the claims 'implementation' must meet/);
});

test('a route cannot finish a Story whose accepted requirements or planned claims were never implemented', async () => {
  const featureWith = async (decisions) => {
    const raw = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
    raw.workTypes.feature.decisions = decisions;
    return validateDefinition(raw);
  };
  const stopAfter = (after) => [{
    id: 'stop-early', after, kind: 'ask', label: 'Stop here?',
    routes: [{ id: 'continue', label: 'Continue', to: 'next' }, { id: 'stop', label: 'Finish here', to: 'end' }]
  }];
  await assert.rejects(featureWith(stopAfter('requirements')), (error) => {
    assert.equal(error.code, 'WORKFLOW_DECISION_INVALID');
    assert.match(error.message, /skips every code phase after 'requirements' \('implementation'\)/);
    return true;
  });
  await assert.rejects(featureWith(stopAfter('implementation-spec')),
    /skips 'implementation', which must meet the claims 'implementation-spec' plans/);
  // Ending after the code phase drops no requirement: the decision still validates.
  const allowed = await featureWith(stopAfter('implementation'));
  assert.deepEqual(resolveWorkType(allowed, 'feature').decisions.map((decision) => decision.id), ['stop-early']);
});

test('the terminal gate is told which obligations a skipped phase dropped', () => {
  const plannedClaims = { mode: 'required', clausePhases: ['requirements', 'implementation-spec'], owners: { implementation: 'implementation-spec' } };
  const storyWith = (statuses) => ({
    phaseOrder: Object.keys(statuses),
    resolution: { plannedClaims },
    phases: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, {
      id, status, ...(id === 'implementation' ? { generationPolicy: { task: 'code' } } : {})
    }]))
  });
  assert.deepEqual(obligationsDroppedBySkips(storyWith({
    requirements: 'approved', 'implementation-spec': 'skipped', implementation: 'skipped', verification: 'skipped'
  })), [{ phase: 'implementation', reason: "the requirements 'requirements' defines were never implemented" }]);
  assert.deepEqual(obligationsDroppedBySkips(storyWith({
    requirements: 'approved', 'implementation-spec': 'approved', implementation: 'skipped'
  })), [{ phase: 'implementation', reason: "the claims 'implementation-spec' planned for it were never implemented" }]);
  assert.deepEqual(obligationsDroppedBySkips(storyWith({
    requirements: 'approved', 'implementation-spec': 'approved', implementation: 'approved', verification: 'skipped'
  })), []);
  assert.deepEqual(obligationsDroppedBySkips({ ...storyWith({ implementation: 'skipped' }), resolution: {} }), []);
});

test('rules choose routes from recorded values, and a loop stops for a person at its limit', async () => {
  const definition = await definitionWith([BRANCH, LOOP, ASK]);
  const workflow = story(definition, {
    intake: { status: 'approved', decisionInputs: { decision: 'needs-requirements', values: { risk: 'low' } } }
  });
  const skip = decisionOutcome(workflow, workflow.phases.intake);
  assert.deepEqual([skip.kind, skip.route, skip.target, skip.skipped], ['forward', 'simple', 'design', ['requirements']]);
  assert.match(describeOutcome(workflow, skip), /continues to Architecture and design, skipping Requirements/);

  workflow.phases.intake.decisionInputs.values = { risk: 'high' };
  const full = decisionOutcome(workflow, workflow.phases.intake);
  assert.deepEqual([full.kind, full.target, full.because], ['next', 'requirements', 'Risk is medium or high']);

  workflow.phases.design.decisionInputs = { decision: 'until-ready', values: { ready: 'no' } };
  const again = decisionOutcome(workflow, workflow.phases.design);
  assert.deepEqual([again.kind, again.target, again.round, again.maxRounds], ['loop', 'requirements', 1, 2]);
  workflow.decisionRounds['until-ready'] = { count: 2 };
  const limit = decisionOutcome(workflow, workflow.phases.design);
  assert.deepEqual([limit.kind, limit.reason], ['pause', 'limit']);
  workflow.phases.design.decisionInputs.values = { ready: 'yes' };
  assert.equal(decisionOutcome(workflow, workflow.phases.design).kind, 'next', 'a met goal moves on even after rounds were used');

  assert.deepEqual(decisionOutcome(workflow, workflow.phases.requirements), {
    decision: 'direction', label: 'Where next?', after: 'requirements', kind: 'pause', reason: 'ask', by: 'person'
  });
  assert.equal(decisionOutcome(workflow, workflow.phases['implementation-spec']), null, 'no decision keeps the linear path');
  delete workflow.phases.intake.decisionInputs;
  assert.throws(() => decisionOutcome(workflow, workflow.phases.intake), (error) => error.code === 'DECISION_INPUTS_MISSING');
});

test('recorded values are checked against the decision before anything is stored', async () => {
  const decision = resolveWorkType(await definitionWith([BRANCH]), 'decide-demo').decisions[0];
  assert.deepEqual(normalizeDecisionInputValues(decision, parseDecisionAssignments(['risk=HIGH'])), { risk: 'high' });
  assert.throws(() => normalizeDecisionInputValues(decision, {}), (error) => error.code === 'DECISION_INPUTS_MISSING'
    && /--decision risk=<low\|medium\|high>/.test(error.message));
  assert.throws(() => normalizeDecisionInputValues(decision, { risk: 'severe' }), (error) => error.code === 'DECISION_INPUT_INVALID');
  assert.throws(() => normalizeDecisionInputValues(decision, { risk: 'low', size: 'big' }), (error) => error.code === 'DECISION_INPUT_UNKNOWN');
  assert.throws(() => parseDecisionAssignments(['risk']), /expects name=value/);
  assert.throws(() => parseDecisionAssignments(['risk=low', 'risk=high']), /more than once/);
  const scored = { inputs: [{ name: 'coverage', label: 'Coverage', type: 'number', minimum: 0, maximum: 100 }] };
  assert.deepEqual(normalizeDecisionInputValues(scored, { coverage: '82.5' }), { coverage: 82.5 });
  assert.throws(() => normalizeDecisionInputValues(scored, { coverage: '120' }), /up to 100/);
  assert.equal(describeWhen({ coverage: { atLeast: 80, below: 95 } }, scored.inputs), 'Coverage is at least 80 and below 95');
  assert.equal(chooseRoute({ inputs: scored.inputs, routes: [
    { id: 'good', when: { coverage: { atLeast: 80 } } }, { id: 'more', when: null }
  ] }, { coverage: 79 }).id, 'more');
});

test('a pending decision is bound to its exact question, and a choice resolves where it leads', async () => {
  const definition = await definitionWith([BRANCH, LOOP, { ...ASK, anyStep: true }]);
  const workflow = story(definition, { requirements: { status: 'approved' } });
  const outcome = decisionOutcome(workflow, workflow.phases.requirements);
  const pending = pendingDecisionRecord(workflow, workflow.phases.requirements, outcome, { at: '2026-10-01T10:00:00.000Z' });
  assert.match(pending.key, /^[a-f0-9]{16}$/);
  assert.deepEqual(pending.options.map((option) => option.id), ['continue', 'again', 'stop']);
  assert.equal(pendingDecisionRecord(workflow, workflow.phases.requirements, outcome, { at: '2026-10-01T10:00:00.000Z' }).key, pending.key);
  assert.notEqual(pendingDecisionRecord(workflow, workflow.phases.requirements, outcome, { at: '2026-10-01T10:00:01.000Z' }).key, pending.key);

  assert.deepEqual(resolveDecisionChoice(workflow, pending, { option: 'stop' }).reach,
    { kind: 'end', target: null, skipped: ['design', 'implementation-spec'] });
  assert.deepEqual(resolveDecisionChoice(workflow, pending, { to: 'implementation-spec' }).reach.skipped, ['design']);
  assert.throws(() => resolveDecisionChoice(workflow, pending, {}), (error) => error.code === 'DECISION_CHOICE_REQUIRED');
  assert.throws(() => resolveDecisionChoice(workflow, pending, { option: 'later' }), (error) => error.code === 'DECISION_OPTION_UNKNOWN');
  assert.throws(() => resolveDecisionChoice(workflow, { ...pending, anyStep: false }, { to: 'design' }), (error) => error.code === 'DECISION_STEP_NOT_ALLOWED');
  const skipDesign = resolveDecisionChoice(workflow, pending, { to: 'implementation-spec' }).reach;
  assert.throws(() => assertChoiceKeepsDependencies(workflow, pending, skipDesign), /skips 'design', which 'implementation-spec' reads/);
  assert.throws(() => resolveDecisionChoice(workflow, null, { option: 'stop' }), (error) => error.code === 'DECISION_NOT_PENDING');
  assert.deepEqual(routeReach(PHASES, 'implementation-spec', 'next'), { kind: 'end', target: null, skipped: [] });
});
