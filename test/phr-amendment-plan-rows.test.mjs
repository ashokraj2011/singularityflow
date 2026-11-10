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

import { separatePlanGaps } from '../src/state.mjs';
import { CLI, specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'PHR-AMD-1';
const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

/** The approved specification with one more criterion and one revised requirement, planned by the specification itself as before. */
function amended() {
  return specification(WORK, 1)
    .replace(`- The application returns the value 1. [${WORK}:REQ-002]`, `- The application returns the value 1 on every read. [${WORK}:REQ-002]`)
    .replace(`[${WORK}:REQ-002]`, `[${WORK}:REQ-002]\n- The value is shown once per read. [${WORK}:AC-003]`)
    .replace(`| \`${WORK}:REQ-002\` | S1 | success |`, `| \`${WORK}:REQ-002\` | S1 | success |\n| \`${WORK}:AC-003\` | S1 | success |`)
    .replace(`| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
      `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |\n| \`${WORK}:AC-003\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`);
}

test('[PHR:REQ-008] owner decision 4: an amendment carries the separate plan\'s row, signed by the plan\'s approvers; the plan keeps its approval', { timeout: 600_000 }, async (t) => {
  const { run, cli, item, candidate } = await submittedPlanningStory(t, WORK);
  cli('approve', 'planning', '--yes');
  const before = await workflowOf(item);
  assert.equal(before.phases.planning.status, 'approved');
  assert.ok(before.phases.planning.claimMaps?.planned?.sha256, 'planning is a separate plan with its own rows');
  await writeFile(candidate, amended());
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

  // One person approves both the scope and the plan here: their decision approves the amendment and signs the row.
  const decided = JSON.parse(cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'approve', '--confirm', 'AMD-001', '--json').stdout);
  assert.equal(decided.transition.applied, true);
  const after = await workflowOf(item);
  assert.equal(after.phases.planning.status, 'approved', `the plan keeps its approval: ${JSON.stringify(decided.transition.proposal.application)}`);
  assert.equal(after.phases.planning.retention?.rule, 'E8');
  assert.ok(after.phases.planning.approvals.some((entry) => entry.decision === 'approved' && !entry.invalidatedAt));
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
  const root = path.resolve(item, '../../..');
  assert.deepEqual(await separatePlanGaps(root, config, after, [`${WORK}:AC-001`, `${WORK}:REQ-002`, added]), []);
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  const entered = run(process.execPath, [CLI, '--no-model', 'prepare', 'implementation'], { allowFailure: true });
  assert.doesNotMatch(`${entered.stdout}\n${entered.stderr}`, /SPEC_PLANNED_CLAIM_MAP_REQUIRED|has no planned test|SPEC_CLAIM_MAP_UNKNOWN_CLAUSE/u);
  assert.equal(entered.status, 0, `${entered.stdout}\n${entered.stderr}`);
});
