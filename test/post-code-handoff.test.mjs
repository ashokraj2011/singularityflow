import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { codeOutcomeReviewOffer } from '../src/code-delivery-policy.mjs';
import { afterPublication } from '../src/commands/phase-publish-if-ready.mjs';
import { agentAct, completeAgentResult } from '../src/agent-output.mjs';
import { buildOutcomeReview } from '../src/outcome-review.mjs';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
const { currentCodeOutcomeOffer } = await import('../apps/vscode/src/cli/snapshot.ts');

function delivery(id = 'implementation') {
  const phase = { id, status: 'in_progress', generation: 1, generationPolicy: { task: 'code' },
    generationIntent: { status: 'consumed', generation: 1 } };
  const workflow = { workItem: { id: 'TRY-1', createdAt: '2026-11-04T00:00:00Z' }, currentPhase: id,
    phases: { [id]: phase }, resolution: { applicationReview: null } };
  return { workflow, phase };
}

test('all code-producing phases offer human validation without adopting policy or creating consent', () => {
  for (const id of ['implementation', 'implement', 'custom-angular', 'repair-api', 'future-step']) {
    const { workflow, phase } = delivery(id);
    const before = structuredClone(workflow);
    const offer = codeOutcomeReviewOffer(workflow, phase);
    assert.equal(offer.command, 'singularity-flow outcome TRY-1');
    assert.equal(offer.copilotCommand, '/sf-outcome TRY-1');
    assert.equal(offer.agentCommand, 'singularity-flow outcome TRY-1 --for-agent --json');
    assert.equal(offer.phase, id);
    assert.equal(offer.generation, 1);
    assert.equal(offer.recordsAcceptance, false);
    assert.equal(offer.required, false);
    assert.deepEqual(workflow, before);
    phase.generationIntent.status = 'open';
    assert.equal(codeOutcomeReviewOffer(workflow, phase), null, 'an open replacement generation is not completed delivery');
  }
  const { workflow, phase } = delivery();
  phase.generationPolicy = { task: 'document' };
  assert.equal(codeOutcomeReviewOffer(workflow, phase), null);
  delete phase.generationPolicy;
  phase.requiredArtifact = { kind: 'implementation-summary' };
  assert.ok(codeOutcomeReviewOffer(workflow, phase), 'legacy code contracts keep the handoff');
  phase.generation = 0;
  assert.equal(codeOutcomeReviewOffer(workflow, phase), null);
  phase.generation = 1;
  phase.skillAmendmentRevalidation = { state: 'affected', generationAtAdoption: 1 };
  assert.equal(codeOutcomeReviewOffer(workflow, phase), null, 'an invalidated delivery is not offered as ready to inspect');
  delete phase.skillAmendmentRevalidation;
  workflow.status = 'cancelled';
  assert.equal(codeOutcomeReviewOffer(workflow, phase), null, 'cancelled Stories keep manual inspection but do not auto-open a handoff');
});

test('code publication hands to outcome review while preserving the unchanged submission route', () => {
  const { workflow, phase } = delivery();
  const offer = codeOutcomeReviewOffer(workflow, phase);
  const shown = { continuation: { copilotCommand: '/sf-submit', nextCommand: 'singularity-flow submit implementation --work-id TRY-1',
    modelFreeCommand: '@sflow /submit implementation --work-id TRY-1', nextAction: { reason: 'Submit the checked generation.' } } };
  const result = afterPublication({ outcomeReview: offer }, shown);
  assert.equal(result.next.commandGuidance.command, 'singularity-flow outcome TRY-1');
  assert.equal(result.afterReview.commandGuidance.command, shown.continuation.nextCommand);
  assert.equal(afterPublication({}, shown).next.commandGuidance.command, shown.continuation.nextCommand);
  const act = agentAct({ resultType: 'sflow-phase-publication', status: 'published', outcomeReview: offer });
  assert.equal(act.do.copilot, '/sf-outcome TRY-1');
  assert.equal(act.do.shell, offer.agentCommand, 'Copilot reads the structured packet rather than terminal prose');
  const combined = agentAct({ publishIfReady: { published: true, ...result } });
  assert.equal(combined.do.shell, offer.agentCommand);
  assert.deepEqual(combined.read, ['publishIfReady.outcomeReview', 'publishIfReady.afterReview'],
    'the handoff does not ask Copilot to reread the publication artifacts');
  const human = agentAct({ data: { outcome: { resultType: 'sflow-outcome-review' } } });
  assert.equal(human.state, 'await-human');
  assert.equal(human.do, null, 'reading cannot start an app or advance the Story');
  const outcome = buildOutcomeReview({ workflow });
  const question = agentAct({ data: { outcome } });
  assert.equal(question.ask.kind, 'choice');
  assert.equal(question.ask.question, outcome.validation.question);
  assert.deepEqual(question.ask.tool, { name: 'sflowDeliveryValidation', input: { workId: 'TRY-1' } });
  assert.deepEqual(question.ask.choices.map(choice => choice.id), outcome.validation.choices.map(choice => choice.id));
  assert.equal(question.do, null, 'the model cannot select a runtime action by reading the result');
  const scoped = buildOutcomeReview({ workflow, application: { status: 'none-declared', capability: 'api' } });
  assert.deepEqual(agentAct({ data: { outcome: scoped } }).ask.tool.input, { workId: 'TRY-1', capability: 'api' });
});

test('VS Code offers only the exact engine-selected delivery and rejects stale, future and completed targets', () => {
  const { workflow, phase } = delivery('custom-code');
  const offer = codeOutcomeReviewOffer(workflow, phase);
  const snapshot = { workflow, outcomeReview: offer };
  assert.strictEqual(currentCodeOutcomeOffer(snapshot), offer);
  assert.equal(currentCodeOutcomeOffer({ workflow }), null, 'older CLI output is not guessed');
  for (const patch of [{ workId: 'OTHER' }, { phase: 'other-phase' }, { generation: 2 }, { key: '' }]) {
    assert.equal(currentCodeOutcomeOffer({ workflow, outcomeReview: { ...offer, ...patch } }), null);
  }
  phase.status = 'awaiting_approval';
  assert.ok(currentCodeOutcomeOffer(snapshot));
  workflow.status = 'cancelled';
  assert.equal(currentCodeOutcomeOffer(snapshot), null);
  workflow.status = 'in_progress';
  phase.status = 'approved';
  assert.equal(currentCodeOutcomeOffer(snapshot), null, 'old approved phases never reopen the panel');
});

test('submitted and approved deliveries never offer direct source-generation admission', () => {
  for (const status of ['awaiting_approval', 'approved', 'not_started']) {
    const { workflow, phase } = delivery();
    phase.status = status;
    const before = structuredClone(workflow);
    const review = buildOutcomeReview({ workflow });
    assert.equal(review.routes.repair.argv[0], 'recover', status);
    assert.equal(review.routes.repair.copilotCommand, '/sf-recover');
    assert.deepEqual(workflow, before);
  }
});

test('real code publication offers the review and its snapshot without starting anything or changing approval policy', async t => {
  const repo = await repository(t, { implementCommands: false });
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 — return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  repo.sflow('prepare', 'implement');
  const publication = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(publication.status, 0, JSON.stringify(publication));
  assert.equal(publication.value.outcomeReview.phase, 'implement');
  assert.equal(publication.value.outcomeReview.copilotCommand, '/sf-outcome QF-1');
  assert.equal(publication.value.applicationReview, undefined, 'a handoff does not adopt ARA');
  const workflowFile = path.join(repo.root, 'singularity/work-items/QF-1/workflow.json');
  const workflowBytes = await readFile(workflowFile);
  const workflow = JSON.parse(workflowBytes);
  assert.equal(workflow.phases.implement.status, 'in_progress', 'publication did not submit or approve');
  assert.equal(workflow.applicationReviews?.length ?? 0, 0);
  const beforeHead = repo.must('git', ['rev-parse', 'HEAD']);
  const beforeStatus = repo.must('git', ['status', '--porcelain']);
  const snapshot = repo.sflowJson('snapshot', '--include', 'lifecycle');
  assert.equal(snapshot.status, 0, JSON.stringify(snapshot));
  assert.equal(snapshot.value.lifecycle.outcomeReview.phase, 'implement');
  const outcome = repo.sflowJson('outcome', 'QF-1');
  assert.equal(outcome.status, 0, JSON.stringify(outcome));
  assert.equal(outcome.value.effects.externalSystemsChanged, false);
  assert.equal(outcome.value.data.outcome.validation.schemaVersion, 1);
  assert.equal(outcome.value.data.outcome.validation.binding.phase, 'implement');
  assert.ok(outcome.value.data.outcome.validation.choices.some(choice => choice.id === 'configure'));
  const criterion = outcome.value.data.outcome.criteria.find(row => row.id === 'QF-1:AC-001');
  assert.ok(criterion, 'the person receives the approved acceptance criterion');
  assert.ok(criterion.tests.some(result => result.outcome === 'passed'), JSON.stringify(criterion));
  // This fixture normally requests raw, full JSON. Exercise the actual native agent projection too.
  const display = repo.env.SINGULARITY_FLOW_AGENT_OUTPUT;
  let agentReview;
  try {
    delete repo.env.SINGULARITY_FLOW_AGENT_OUTPUT;
    agentReview = completeAgentResult(repo.sflow('outcome', 'QF-1', '--for-agent', '--json'));
  } finally { repo.env.SINGULARITY_FLOW_AGENT_OUTPUT = display; }
  assert.equal(agentReview.act.state, 'await-human');
  assert.equal(agentReview.act.do, null);
  assert.equal(agentReview.act.ask.kind, 'choice', 'the bounded Copilot output still contains the explicit question');
  assert.equal(agentReview.act.ask.tool.input.workId, 'QF-1');
  assert.equal(agentReview.data.outcome.workId, 'QF-1');
  assert.equal(outcome.value.data.outcome.routes.continue.command, 'singularity-flow nextsteps QF-1 --for-agent --json');
  assert.equal(outcome.value.data.outcome.routes.repair.command, 'singularity-flow phase begin implement --work-id QF-1 --json');
  assert.equal(outcome.value.data.outcome.routes.repair.copilotCommand, '/sf-code');
  assert.deepEqual(await readFile(workflowFile), workflowBytes);
  assert.equal(repo.must('git', ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(repo.must('git', ['status', '--porcelain']), beforeStatus);
  const mismatched = repo.sflowJson('phase', 'begin', 'implement', '--work-id', 'NOT-THIS-STORY');
  assert.notEqual(mismatched.status, 0, 'a repair admission cannot silently ignore the requested Story');
  assert.deepEqual(await readFile(workflowFile), workflowBytes);
  const admitted = repo.sflowJson('phase', 'begin', 'implement', '--work-id', 'QF-1');
  assert.equal(admitted.status, 0, JSON.stringify(admitted));
  const successor = JSON.parse(await readFile(workflowFile));
  assert.equal(successor.phases.implement.generationIntent.status, 'open');
  assert.equal(successor.phases.implement.generationIntent.generation, 2);
  assert.equal(successor.phases.implement.generation, 1, 'the first publication is preserved');
});
