/**
 * The five verbs, and the property that makes a small vocabulary safe. `[SPK:AC-001]`
 *
 * `[SPK:REQ-180]` asks that a fast-path execution and the corresponding advanced operations produce
 * identical authoritative state. In P1 the CLI form of a verb is a planner: it names the registered
 * operations and hands off rather than fabricating generated content `[SPK:CON-015]`. So the
 * equivalence that can honestly be asserted here is the stronger, simpler one — **the verb proposes
 * exactly the operations the advanced interface proposes**, because both read the same planner.
 *
 * That is worth pinning precisely because it is the thing that rots. The moment a verb starts
 * computing its own idea of what is legal, it becomes a second lifecycle engine wearing a friendly
 * name, which `[SPK:CON-002]` exists to forbid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKPOINT_KINDS, FAST_PATH_VERBS, fastPathProfile, milestoneReached, nextVerb, planFastPath,
  verbForPhase
} from '../src/fast-path.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { COMMAND_REGISTRY } from '../src/command-registry.mjs';

const PHASES = ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release'];

const DEFINITION = {
  workTypes: {
    'spec-driven-standard': {
      phases: PHASES,
      fastPath: {
        specify: { milestone: 'specification-approved' },
        plan: { milestone: 'planning-approved' },
        implement: { milestone: 'implementation-published' },
        converge: { milestone: 'convergence-advanced' },
        verify: { milestone: 'verification-approved' }
      }
    },
    // A work type that says nothing about the fast path must not silently acquire it.
    feature: { phases: ['intake', 'requirements'] }
  }
};

function story(current, statuses = {}) {
  const workflow = {
    workItem: { id: 'SPK-1', workType: 'spec-driven-standard', workTypeLabel: 'Spec-Driven Standard' },
    status: 'in_progress',
    currentPhase: current,
    phaseOrder: PHASES,
    phases: Object.fromEntries(PHASES.map((id) => [id, {
      id, label: id, generation: 0, status: statuses[id] ?? (id === current ? 'in_progress' : 'pending')
    }]))
  };
  workflow.phases.convergence.generationPolicy = {
    requirement: 'required', defaultProducer: 'deterministic',
    allowedProducers: ['deterministic'], producer: 'deterministic'
  };
  return workflow;
}

function deterministicStory(current = 'convergence') {
  const workflow = story(current);
  workflow.phases[current].generationPolicy = {
    requirement: 'required',
    defaultProducer: 'deterministic',
    allowedProducers: ['deterministic'],
    producer: 'deterministic'
  };
  return workflow;
}

test('a verb proposes exactly what the advanced planner proposes', () => {
  // The equivalence that matters. Both sides read `workflowGuide`, and this asserts they have not
  // drifted — a verb that answered from its own rules would show up here as a different command.
  for (const [phase, verb] of [
    ['specification', 'specify'], ['planning', 'plan'], ['implementation', 'implement'],
    ['convergence', 'converge'], ['verification', 'verify']
  ]) {
    for (const status of ['in_progress', 'awaiting_approval']) {
      const workflow = story(phase, { [phase]: status });
      const advanced = workflowGuide(workflow).nextActions.map((entry) => entry.command);
      const fast = planFastPath(workflow, DEFINITION, verb).next.map((entry) => entry.command);
      assert.deepEqual(fast, advanced, `${verb} at ${phase}/${status} proposed different commands`);
    }
  }
});

test('the underlying kernel operations are named, never hidden', () => {
  const plan = planFastPath(story('specification'), DEFINITION, 'specify');
  assert.deepEqual(plan.underlyingOperations, ['prepare.specification']);
  // A friendly verb that concealed which governed operation it stood for would be the whole risk of
  // this feature in one field.
  assert.ok(plan.underlyingOperations.every((id) => typeof id === 'string' && id.length));
});

test('deterministic-only convergence is never presented as model or agent generation', () => {
  for (const modelMode of [{ enabled: true }, { enabled: false }]) {
    const plan = planFastPath(
      deterministicStory(), DEFINITION, 'converge', { modelMode }
    );
    assert.equal(plan.checkpoint.kind, 'deterministic-generation');
    assert.equal(plan.checkpoint.reason, 'The next step runs the configured deterministic generator.');
    assert.doesNotMatch(JSON.stringify(plan), /\b(?:model|agent)\b/i);
    assert.deepEqual(plan.underlyingOperations, ['prepare.convergence']);
    assert.equal(plan.next[0].command, 'singularity-flow prepare convergence');
  }
});

test('a published generation awaiting submit is a review checkpoint, never model generation', () => {
  for (const [phaseId, verb] of [['specification', 'specify'], ['convergence', 'converge']]) {
    const workflow = phaseId === 'convergence' ? deterministicStory() : story(phaseId);
    workflow.phases[phaseId].generation = 1;
    const plan = planFastPath(workflow, DEFINITION, verb);
    assert.equal(
      plan.next[0].command,
      phaseId === 'convergence'
        ? 'singularity-flow story advance --work-id SPK-1'
        : `singularity-flow submit ${phaseId}`
    );
    assert.equal(plan.checkpoint.kind, 'human-review');
    assert.doesNotMatch(plan.checkpoint.reason, /model|author/i);
  }
});

test('legacy deterministic generation policy is classified without relying on the prepare verb alone', () => {
  const workflow = deterministicStory();
  workflow.phases.convergence.generationPolicy = { requirement: 'required', producer: 'deterministic' };
  const plan = planFastPath(workflow, DEFINITION, 'converge');
  assert.equal(plan.checkpoint.kind, 'deterministic-generation');

  workflow.phases.convergence.generationPolicy = {
    requirement: 'none', defaultProducer: 'deterministic', allowedProducers: ['deterministic']
  };
  assert.notEqual(planFastPath(workflow, DEFINITION, 'converge').checkpoint.kind, 'deterministic-generation');
});

test('every result carries the full contract', () => {
  // `[SPK:REQ-020]`. Consumers across CLI, skills, VS Code and review packets read one shape, so a
  // missing field is a broken surface somewhere else.
  const required = [
    'verb', 'milestone', 'checkpoint', 'underlyingOperations', 'outcome', 'why', 'preserved',
    'stateEffects', 'next'
  ];
  for (const verb of FAST_PATH_VERBS) {
    const plan = planFastPath(story('specification'), DEFINITION, verb);
    for (const field of required) assert.ok(field in plan, `${verb} result is missing ${field}`);
    assert.ok(CHECKPOINT_KINDS.includes(plan.checkpoint.kind), `${verb} used an unknown checkpoint kind`);
  }
});

test('a milestone is proved by state, never by a command returning', () => {
  const profile = fastPathProfile(DEFINITION, 'spec-driven-standard');
  // `[SPK:CON-011]`. Awaiting approval is the exact state where it is tempting to claim completion.
  assert.equal(milestoneReached(story('specification', { specification: 'awaiting_approval' }), profile, 'specify'), false);
  assert.equal(milestoneReached(story('specification', { specification: 'in_progress' }), profile, 'specify'), false);
  assert.equal(milestoneReached(story('planning', { specification: 'approved' }), profile, 'specify'), true);
});

test('reaching a milestone hands over to the next verb', () => {
  const plan = planFastPath(story('planning', { specification: 'approved' }), DEFINITION, 'specify');
  assert.equal(plan.outcome, 'milestone-reached');
  // `[SPK:REQ-022]`: after the milestone the next verb is the primary continuation.
  assert.equal(plan.next[0].command, 'sflow plan');
  const profile = fastPathProfile(DEFINITION, 'spec-driven-standard');
  // Journey order, which is the phase order: convergence closes before verification runs.
  assert.equal(nextVerb(profile, 'implement'), 'converge', 'implement must not skip convergence');
  assert.equal(nextVerb(profile, 'converge'), 'verify');
  assert.equal(nextVerb(profile, 'verify'), null, 'the last verb must not invent a successor');
});

test('a pending publication outranks everything, including an apparent milestone', () => {
  // `[SPK:CON-016]`. Proposing new lifecycle work while a retained commit has not reached its remote
  // is how a Story ends up with two truths.
  const plan = planFastPath(
    story('planning', { specification: 'approved' }), DEFINITION, 'specify', { publicationPending: true }
  );
  assert.equal(plan.checkpoint.kind, 'recovery');
  assert.equal(plan.outcome, 'blocked');
  assert.equal(plan.next[0].command, 'sflow sync');
});

test('a verb stops at the human boundary rather than crossing it', () => {
  // `[SPK:CON-014]`. Approval needs an authorized human identity; the verb may only teach it.
  const plan = planFastPath(story('specification', { specification: 'awaiting_approval' }), DEFINITION, 'specify');
  assert.equal(plan.checkpoint.kind, 'approval');
  assert.match(plan.next[0].command, /^singularity-flow approve specification/);
  assert.notEqual(plan.outcome, 'milestone-reached');
});

test('a verb refuses a phase it does not route, and names the one that does', () => {
  const plan = planFastPath(story('specification'), DEFINITION, 'plan');
  assert.equal(plan.outcome, 'blocked');
  assert.equal(plan.checkpoint.kind, 'not-routed');
  assert.equal(plan.next[0].command, 'sflow specify');
  const profile = fastPathProfile(DEFINITION, 'spec-driven-standard');
  assert.equal(verbForPhase(story('convergence'), profile, 'convergence'), 'converge');
});

test('the fast path is a profile property, not an engine branch', () => {
  // `[SPK:CON-020]`. A work type that does not configure it does not get it, and says so usefully.
  assert.equal(fastPathProfile(DEFINITION, 'feature'), null);
  const featureStory = { ...story('specification'), workItem: { id: 'F-1', workType: 'feature' } };
  assert.throws(() => planFastPath(featureStory, DEFINITION, 'specify'), /does not configure the fast path/);
  assert.throws(() => planFastPath(story('specification'), DEFINITION, 'nope'), /Unknown fast-path verb/);
});

test('planning a verb changes nothing and says so', () => {
  const plan = planFastPath(story('specification'), DEFINITION, 'specify');
  assert.ok(plan.preserved.includes('governed state'));
  assert.deepEqual(plan.stateEffects, []);
});

test('all five verbs are registered read-only, model-free commands', () => {
  // `[SPK:REQ-010]` plus the tripwire contract: a never-model operation needs a fixture, and the
  // registry test enumerates them, so registering here is what puts the verbs under that guard.
  for (const verb of FAST_PATH_VERBS) {
    const entry = COMMAND_REGISTRY.find((item) => item.name === verb);
    assert.ok(entry, `${verb} is not registered`);
    assert.equal(entry.classification, 'read', `${verb} must not be classified as a mutation`);
    assert.equal(entry.modelPolicy, 'never', `${verb} must not invoke a model in the dispatcher`);
    assert.ok(entry.operation.noModelFixture, `${verb} has no no-model tripwire fixture`);
  }
});
