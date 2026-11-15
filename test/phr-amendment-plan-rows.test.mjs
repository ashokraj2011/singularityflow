/**
 * Phase responsibility, owner decision 4 (2026-11-10) [PHR:REQ-008]: an intent amendment that would leave a
 * separate approved plan without a row for a clause it adds, or with a row for a clause it revises, carries
 * that row itself. The amendment's step made the gap, so the proposal is refused there until it carries each
 * row; the plan's approvers sign them by deciding the same amendment; the plan keeps its approval, its rows
 * stay current across the scope revision, and nothing runs again; the code step meets no gap afterwards.
 * Through a real Story: spec-driven-standard, specification and planning approved.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { amendmentPlanCorrection, amendmentReason, carriedRowSigning, planSignOffAuthorities } from '../src/amendment-plan-corrections.mjs';
import { intentAmendmentEffect, separatePlanGaps } from '../src/state.mjs';
import { CLI, specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

/** The approved specification with one more criterion and one revised requirement, planned by the specification itself as before. */
function amended(WORK) {
  return specification(WORK, 1)
    .replace(`- The application returns the value 1. [${WORK}:REQ-002]`, `- The application returns the value 1 on every read. [${WORK}:REQ-002]`)
    .replace(`[${WORK}:REQ-002]`, `[${WORK}:REQ-002]\n- The value is shown once per read. [${WORK}:AC-003]`)
    .replace(`| \`${WORK}:REQ-002\` | S1 | success |`, `| \`${WORK}:REQ-002\` | S1 | success |\n| \`${WORK}:AC-003\` | S1 | success |`)
    .replace(`| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
      `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |\n| \`${WORK}:AC-003\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`);
}

test('[PHR:REQ-008] owner decision 4: an amendment carries the separate plan\'s row, signed by the plan\'s approvers; the plan keeps its approval', { timeout: 600_000 },
  (t) => decisionFour(t, 'PHR-AMD-1', 'off'));

// Under change impact (the default since 2026-11-15) the person-written plan has no complete record; the rows its approvers sign
// are its own answer, so it keeps its approval all the same: signed rows win (owner, 2026-11-15).
test('[PHR:REQ-008] owner decision 4 with change impact on: signed rows win over an incomplete record; an uncounted signature, or no carried rows, resets the plan',
  { timeout: 900_000 }, (t) => decisionFour(t, 'PHR-AMD-2', 'on'));

test('whether a plan\'s carried rows are signed: by one of its own approval groups, counted, or not yet [owner, 2026-11-15]', () => {
  const proposal = { id: 'AMD-001', planCorrections: [{ ownerPhase: 'planning' }] };
  const story = (records, presence = undefined) => ({ workItem: { id: 'W-1' }, resolution: { ...(presence ? { presence } : {}) },
    phases: { planning: { approvalPolicy: { authorities: ['technical-approvers'] } } }, planAmendments: records });
  const row = (fields) => ({ kind: 'plan-row-correction', intentAmendment: 'AMD-001', ownerPhase: 'planning', authorityGroup: 'technical-approvers', ...fields });
  assert.equal(carriedRowSigning(story([]), proposal).get('planning'), 'unsigned');
  assert.equal(carriedRowSigning(story([row({})]), proposal).get('planning'), 'signed');
  assert.equal(carriedRowSigning(story([row({ authorityGroup: 'product-approvers' })]), proposal).get('planning'), 'not-counted', 'a signer outside the plan\'s approvers');
  assert.equal(carriedRowSigning(story([row({ intentAmendment: 'AMD-002' })]), proposal).get('planning'), 'unsigned', 'another amendment\'s rows sign nothing here');
  // SF Guard requires the Story's person steps and this process verified no signature: the signature does not count.
  assert.equal(carriedRowSigning(story([row({})], { status: 'required' }), proposal).get('planning'), 'not-counted');
});

async function decisionFour(t, WORK, changeImpact) {
  const { run, cli, item, candidate } = await submittedPlanningStory(t, WORK, { changeImpact });
  cli('approve', 'planning', '--yes');
  const before = await workflowOf(item);
  assert.equal(before.phases.planning.status, 'approved');
  assert.ok(before.phases.planning.claimMaps?.planned?.sha256, 'planning is a separate plan with its own rows');
  await writeFile(candidate, amended(WORK));
  const added = `${WORK}:AC-003`;
  const propose = (...extra) => run(process.execPath, [CLI, '--no-model', 'story', 'intent-amendment', 'propose', '--work-id', WORK,
    '--file', candidate, '--reason', 'Review showed each read shows the value once.', ...extra, '--json'], { allowFailure: true });

  // Without the row, the amendment's own step is refused, with the command that carries it.
  const bare = propose();
  assert.notEqual(bare.status, 0, bare.stdout);
  const { error, remediationPlan } = JSON.parse(bare.stdout);
  assert.equal(error.code, 'INTENT_AMENDMENT_PLAN_UNCORRECTED', bare.stdout);
  const revised = `${WORK}:REQ-002`;
  assert.match(error.message, new RegExp(`planning has no row for ${added}`, 'u'));
  assert.match(error.message, new RegExp(`has rows for [^.]*${revised}[^.]*, which it revises`, 'u'));
  assert.match(error.details.nextAction, new RegExp(`^singularity-flow story intent-amendment propose --work-id ${WORK} .*--add-row ${added}=<PATH> --test <TEST>.* --keep-row ${revised}`, 'u'));
  // Each revised clause the plan has a row for, and each that depends on one, as the scope revision will say.
  const keep = [...error.details.nextAction.matchAll(/--keep-row (\S+)/gu)].map((match) => match[1]);
  assert.ok(keep.includes(revised), error.details.nextAction);
  assert.ok(remediationPlan.steps.some((step) => step.command === error.details.nextAction), bare.stdout);
  assert.equal((await workflowOf(item)).intentAmendments?.length ?? 0, 0, 'nothing was proposed');
  // A row no plan lacks is refused too: the amendment carries only the rows it makes necessary.
  const stray = propose('--add-row', `${added}=src/value.mjs`, '--test', 'test/value.test.mjs', '--remove-row', `${WORK}:AC-001`);
  assert.equal(JSON.parse(stray.stdout).error.code, 'INTENT_AMENDMENT_PLAN_CORRECTION_INVALID', stray.stdout);

  const proposed = propose('--add-row', `${added}=src/value.mjs`, '--test', 'test/value.test.mjs', ...keep.flatMap((clause) => ['--keep-row', clause]));
  assert.equal(proposed.status, 0, `${proposed.stdout}\n${proposed.stderr}`);
  const { proposal } = JSON.parse(proposed.stdout);
  assert.deepEqual(proposal.planCorrections.map((entry) => [entry.ownerPhase, entry.operations.map((operation) => [operation.op, operation.clauseId])]),
    [['planning', [['add-row', added], ...keep.map((clause) => ['keep-row', clause])]]]);
  assert.deepEqual(proposal.planCorrections[0].operations[0].claim.tests, ['test/value.test.mjs']);

  const root = path.resolve(item, '../../..');
  if (changeImpact === 'on') {
    // The plan was written by a person with no composed prompt: its record is incomplete. Before its approvers sign the rows it is
    // not widened, and the preview says it keeps its approval once they do.
    const { definition, workflow } = await loadAcceptedStoryExecution(root, WORK);
    const record = JSON.parse(await readFile(path.join(item, 'context/intent-amendments/AMD-001.json'), 'utf8'));
    const proposedText = await readFile(path.join(root, record.specification.proposedPath), 'utf8');
    const planning = async (story, proposal = record) => (await intentAmendmentEffect(root, definition, story, proposal, { proposedText }))
      .steps.find((step) => step.phase === 'planning');
    const pending = await planning(workflow);
    assert.deepEqual([pending.outcome, pending.signedRows, pending.reasons.map((reason) => reason.kind)], ['kept', 'unsigned', []]);
    const preview = JSON.parse(cli('story', 'intent-amendment', 'preview', 'AMD-001', '--json').stdout);
    assert.ok(preview.summary.some((line) => /^Planning keeps its approval \(rule E8\): it cites none of the changed clauses; what it depended on is not fully recorded, so it keeps its approval once its approvers sign the rows the amendment carries for it\.$/u.test(line)),
      preview.summary.join('\n'));
    // A signature that does not count answers for nothing: the plan runs again, widened. Here SF Guard requires the Story's person
    // steps and verified no signature on the rows. (A signer outside the plan's own groups is refused outright when the rows are read:
    // PLAN_ROW_CORRECTION_INTEGRITY; carriedRowSigning's own check is the unit test above.)
    const unverified = structuredClone(workflow);
    unverified.planAmendments = [...(unverified.planAmendments ?? []), amendmentPlanCorrection(unverified, { carried: record.planCorrections[0],
      reason: amendmentReason(record.id, record.reason), actor: 'history.tester@example.test', authorityGroup: planSignOffAuthorities(unverified, 'planning')[0],
      at: new Date().toISOString(), intentAmendment: 'AMD-001' })];
    assert.equal(carriedRowSigning(unverified, record).get('planning'), 'signed', 'signed, as the Story stands');
    unverified.resolution = { ...unverified.resolution, presence: { status: 'required' } };
    assert.equal(carriedRowSigning(unverified, record).get('planning'), 'not-counted');
    assert.deepEqual(await planning(unverified).then((step) => [step.outcome, step.reasons.map((reason) => reason.kind)]), ['reopened', ['unresolved-record']]);
    // Without carried rows the person-written plan answers for nothing either: fail closed, as before.
    const bare = await planning(workflow, { ...record, planCorrections: [] });
    assert.equal(bare.outcome, 'reopened');
    assert.ok(bare.reasons.some((reason) => reason.kind === 'unresolved-record'), JSON.stringify(bare.reasons));
  }
  // One person approves both the scope and the plan here: their decision approves the amendment and signs the row.
  const decided = JSON.parse(cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--json').stdout);
  assert.equal(decided.transition.applied, true);
  const after = await workflowOf(item);
  assert.equal(after.phases.planning.status, 'approved', `the plan keeps its approval: ${JSON.stringify(decided.transition.proposal.application)}`);
  assert.equal(after.phases.planning.retention?.rule, 'E8');
  assert.ok(after.phases.planning.approvals.some((entry) => entry.decision === 'approved' && !entry.invalidatedAt));
  if (changeImpact === 'on') {
    // Recorded as carried by the signed rows, not widened.
    assert.deepEqual(decided.transition.proposal.application.impactCounts, { schema: 'impact-counts/v1', widened: [], setAside: [],
      carried: [{ phase: 'planning', reason: 'signed-plan-rows' }] });
    assert.deepEqual(after.intentAmendments[0].impactCounts, decided.transition.proposal.application.impactCounts);
  }
  const [row] = after.planAmendments.filter((entry) => entry.intentAmendment === 'AMD-001');
  assert.equal(row.ownerPhase, 'planning');
  assert.equal(row.reviewAssurance, 'intent-amendment-decision');
  assert.deepEqual(decided.transition.proposal.decisions.at(-1).planCorrections, [row.id]);
  assert.equal(after.currentPhase, 'implementation');
  // The plan's rows for the added and the revised clause hold across the scope revision: its approvers signed them.
  const matrix = JSON.parse(cli('evidence', 'matrix', '--json').stdout).data.matrix;
  for (const clause of [added, revised]) {
    const row = matrix.page.rows.find((entry) => entry.id === clause);
    const plan = row.obligations.find((entry) => entry.responsibility === 'plan');
    assert.notEqual(plan.facets?.freshness, 'stale', `${clause}'s plan evidence went stale: ${JSON.stringify(row.findings)}`);
    assert.ok(!row.findings.some((entry) => entry.code === 'EVIDENCE_STALE_AFTER_SCOPE_REVISION' && (entry.obligationIds ?? []).includes(plan.id)), clause);
  }

  // Every plan reader now reads the row: the code step meets no gap.
  const config = { workItemRoot: 'singularity/work-items' };
  assert.deepEqual(await separatePlanGaps(root, config, after, [`${WORK}:AC-001`, `${WORK}:REQ-002`, added]), []);
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  const entered = run(process.execPath, [CLI, '--no-model', 'prepare', 'implementation'], { allowFailure: true });
  assert.doesNotMatch(`${entered.stdout}\n${entered.stderr}`, /SPEC_PLANNED_CLAIM_MAP_REQUIRED|has no planned test|SPEC_CLAIM_MAP_UNKNOWN_CLAUSE/u);
  assert.equal(entered.status, 0, `${entered.stdout}\n${entered.stderr}`);
}
