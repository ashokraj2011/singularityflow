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

test('code publication keeps its submission next; the outcome review is one optional line, never a question (owner, 2026-11-19)', () => {
  const { workflow, phase } = delivery();
  const offer = codeOutcomeReviewOffer(workflow, phase);
  assert.equal(offer.line, 'Optional: /sf-outcome TRY-1 shows each requirement with its tests, and the application to try.');
  const shown = { continuation: { copilotCommand: '/sf-submit', nextCommand: 'singularity-flow submit implementation --work-id TRY-1',
    modelFreeCommand: '@sflow /submit implementation --work-id TRY-1', nextAction: { reason: 'Submit the checked generation.' } } };
  const result = afterPublication({ outcomeReview: offer }, shown);
  assert.equal(result.next.commandGuidance.command, shown.continuation.nextCommand, 'the submission stays the next step');
  assert.equal(result.afterReview.commandGuidance.command, shown.continuation.nextCommand);
  assert.equal(afterPublication({}, shown).next.commandGuidance.command, shown.continuation.nextCommand);
  // No review owed: the author's turn submits it once, by /sf-submit's own entry, with no separate submit turn.
  const inTurn = { command: 'singularity-flow status TRY-1 --submission-readiness --for-agent --json --submit-if-ready', skill: '/sf-submit', reason: 'Submit now.' };
  const submitting = afterPublication({ outcomeReview: offer }, shown, null, inTurn);
  assert.deepEqual(submitting.next.inTurn, inTurn);
  assert.equal(afterPublication({}, shown, { instruction: 'Start the reviewer.' }, inTurn).next.inTurn, undefined, 'a review owed comes first');
  const act = agentAct({ publishIfReady: { published: true, ...submitting } });
  assert.equal(act.state, 'submit');
  assert.equal(act.do.shell, inTurn.command);
  assert.equal(act.show, offer.line, 'the outcome is said in one line, never asked');
  assert.equal(act.ask, undefined);
  const relayed = agentAct({ publishIfReady: { published: true, ...result } });
  assert.equal(relayed.state, 'next');
  assert.equal(relayed.do.shell, shown.continuation.nextCommand);
  assert.equal(relayed.show, offer.line);
  // /sf-outcome itself: the checks in one line of optional choices; nothing is asked and nothing runs by reading it.
  const outcome = buildOutcomeReview({ workflow });
  assert.equal(outcome.validation.asked, 'optional');
  assert.match(outcome.validation.line, /^Check version 1 yourself \(optional\): Run tests · /u);
  const read = agentAct({ data: { outcome } });
  assert.equal(read.state, 'read');
  assert.equal(read.ask, undefined);
  assert.equal(read.show, outcome.validation.line);
  assert.equal(read.do, null, 'the model cannot select a runtime action by reading the result');
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
  // Submitted, its approvers return it to its author; approved or not started, there is nothing to repair here. Recovery
  // found nothing to repair in either [review 2026-11-17, routes #2].
  for (const [status, expected] of [['awaiting_approval', ['reject', '/sf-reject']], ['approved', null], ['not_started', null]]) {
    const { workflow, phase } = delivery();
    phase.status = status;
    const before = structuredClone(workflow);
    const repair = buildOutcomeReview({ workflow }).routes.repair;
    assert.deepEqual(repair && [repair.argv[0], repair.copilotCommand], expected, status);
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
  // One line of optional choices, never a question (owner, 2026-11-19).
  assert.equal(agentReview.act.state, 'read');
  assert.equal(agentReview.act.do, null);
  assert.equal(agentReview.act.ask, undefined);
  assert.match(agentReview.act.show, /^Check version 1 yourself \(optional\): /u, 'the bounded Copilot output still carries the choices');
  assert.equal(agentReview.data.outcome.workId, 'QF-1');
  assert.equal(outcome.value.data.outcome.routes.continue.command, 'singularity-flow nextsteps QF-1 --for-agent --json');
  // A published step's repair is its next version, opened on the person's yes for what they say to repair [OSA:REQ-030].
  assert.equal(outcome.value.data.outcome.routes.repair.command, 'singularity-flow phase rollover implement --reason "<what to change>" --json');
  assert.equal(outcome.value.data.outcome.routes.repair.copilotCommand, '/sf-code implement <what to change>');
  assert.deepEqual(await readFile(workflowFile), workflowBytes);
  assert.equal(repo.must('git', ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(repo.must('git', ['status', '--porcelain']), beforeStatus);
  const mismatched = repo.sflowJson('phase', 'rollover', 'implement', '--work-id', 'NOT-THIS-STORY');
  assert.notEqual(mismatched.status, 0, 'a repair admission cannot silently ignore the requested Story');
  assert.deepEqual(await readFile(workflowFile), workflowBytes);
  // A repair is version 2, which opens only on the person's yes [D3, OSA:REQ-030]: `phase begin` alone opens nothing and
  // names the preview; the preview asks the person, and their yes opens it.
  const begun = repo.sflowJson('phase', 'begin', 'implement', '--work-id', 'QF-1');
  assert.equal(begun.value.error?.code, 'VERSION_CONSENT_REQUIRED', JSON.stringify(begun.value).slice(0, 1500));
  assert.match(JSON.stringify(begun.value.error.details.nextAction), /singularity-flow phase rollover implement --json/u);
  assert.equal(begun.value.remediationPlan.steps[0].command, 'singularity-flow phase rollover implement --json');
  assert.deepEqual(await readFile(workflowFile), workflowBytes);
  const preview = repo.sflowJson('phase', 'rollover', 'implement', '--work-id', 'QF-1', '--reason', 'Say in the code why the value is two');
  assert.equal(preview.status, 0, JSON.stringify(preview.value).slice(0, 1500));
  assert.equal(preview.value.mutates, false);
  assert.equal(preview.value.question, 'Start version 2 of Implement? Published version 1 and its recorded tests will stay unchanged.');
  const admitted = repo.sflowJson(...preview.value.argv);
  assert.equal(admitted.status, 0, JSON.stringify(admitted.value).slice(0, 1500));
  const successor = JSON.parse(await readFile(workflowFile));
  assert.equal(successor.phases.implement.generationIntent.status, 'open');
  assert.equal(successor.phases.implement.generationIntent.generation, 2);
  assert.equal(successor.phases.implement.generation, 1, 'the first publication is preserved');
  assert.equal(successor.phases.implement.versionOpening.version, 2);
  assert.equal(successor.phases.implement.versionOpening.consent.surface, 'terminal', 'the person\'s own yes, at their terminal');
});
