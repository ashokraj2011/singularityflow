/**
 * Recovery is for real damage only (owner decision 4, 2026-11-16). The review of 2026-11-17 (findings 4 to 8) found
 * refusals that still sent a healthy step to `recover`, which found nothing to repair and sent it back to the same
 * refusal. Each now names the step's real way on, from the action map: an approver's return in an approval turn, the
 * step's next version on the person's yes, the owning step's republication, the Story's own next action, or the
 * developer's finalize.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { approvalHold } from '../src/approval-check.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { recordWitness, WITNESS_CHECKLIST } from '../src/verification/witness-records.mjs';
import { preparePhaseAppeal } from '../src/phase-appeals.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { epicReviewStory } from '../src/epic-review.mjs';
import { createInitiative, initiativeDir, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

const RECOVER = /singularity-flow recover\b/u;
const firstRoute = (plan) => plan.steps.find((entry) => entry.command || entry.skill);

test('an approval turn refused for failing tests or findings ends with the approver\'s return, never recovery (finding 4)', () => {
  const execution = { commandId: 'unit', cwd: '.', resultPath: '.sflow/results/unit.xml', provenance: 'configured', failure: { kind: 'assertion' } };
  for (const [code, details] of [['CODE_TEST_FAILED', { requiredTestExecution: execution }],
    ['CODE_QUALITY_FINDINGS', { qualityFindings: { mode: 'warn', attempt: 1, maximumAttempts: 3, findings: [] } }]]) {
    const error = new SingularityFlowError('refused', { code, details: { workId: 'W-1', ...details } });
    const approving = refusalRemediationPlan(error, ['approve', 'implementation', '--work-id', 'W-1']);
    assert.equal(approving.repairContinuation.currentTurnRepair, false, code);
    assert.equal(approving.repairContinuation.nextCommand,
      'singularity-flow reject implementation --work-id W-1 --fetch --to implementation --reason <reason>', code);
    // The authoring turn keeps its own repair loop: the same check again.
    const authoring = refusalRemediationPlan(error, ['phase', 'prepublish', 'implementation', '--work-id', 'W-1']);
    assert.equal(authoring.repairContinuation.nextCommand, 'singularity-flow phase prepublish implementation --for-agent --json --publish-if-ready', code);
  }
});

test('an approval hold Singularity Flow finishes, or one nothing here knows, goes to the Story\'s next action, never recovery (finding 4)', () => {
  const workflow = { workItem: { id: 'W-1' }, currentPhase: 'implementation', phases: { implementation: { id: 'implementation', label: 'Implementation', status: 'awaiting_approval' } }, resolution: {} };
  const phase = workflow.phases.implementation;
  for (const code of ['TCA_AMENDMENT_STALE', 'CONVERGENCE_STALE', 'A_CODE_NOBODY_LISTED']) {
    const hold = approvalHold(new SingularityFlowError('refused', { code }), workflow, phase);
    assert.doesNotMatch(hold.action.command, RECOVER, code);
    assert.equal(hold.action.command, 'singularity-flow nextsteps W-1', code);
    // A refusal nobody can attribute still offers no return.
    assert.doesNotMatch(hold.action.command, /singularity-flow reject /u, code);
  }
  // This checkout's own changes stay recovery's, which shows them and sets them aside.
  assert.match(approvalHold(new SingularityFlowError('refused', { code: 'READ_ONLY_AGENT_CANNOT_MUTATE' }), workflow, phase).action.command, RECOVER);
});

const AC = 'WS-1:AC-001';
const FILE = 'singularity/work-items/WS-1/evidence/screen.png';
function witnessStory({ implementation = 'approved', current = 'verification', verification = 'in_progress' } = {}) {
  return {
    workItem: { id: 'WS-1' }, status: 'in_progress', currentPhase: current, phaseOrder: ['implementation', 'verification'],
    phases: {
      implementation: { id: 'implementation', status: implementation, generation: 1, generationCommit: 'a'.repeat(40),
        approvalPolicy: { rejectTo: ['implementation'] },
        deliveryEvidence: { fulfillment: [{ clauseId: AC, fulfillment: 'evidence', paths: [{ path: FILE, state: 'missing' }] }] } },
      verification: { id: 'verification', status: verification, generation: 1, generationCommit: 'c'.repeat(40),
        approvalPolicy: { rejectTo: ['implementation', 'verification'] } }
    }
  };
}

test('a witness of evidence its step recorded but never published names that step\'s republication, never recovery (finding 6)', () => {
  const input = { clauseId: AC, slot: { slot: 'screen', method: 'visual', witness: { target: FILE } }, file: FILE, sha256: `sha256:${'d'.repeat(64)}`,
    plannedClaim: { fulfillment: 'evidence', expectedPaths: [FILE] }, answers: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes'])),
    reason: 'Compared the screen with the reference.', actor: 'carol', authorityGroup: 'quality-reviewers', at: '2026-11-17T00:00:00.000Z' };
  const refused = (workflow) => { try { recordWitness(workflow, input); } catch (error) { return error; } return assert.fail('witnessed'); };
  // At verification, implementation (approved) owns the image: its approvers hear of it through an upstream issue.
  const later = refused(witnessStory());
  assert.equal(later.code, 'WITNESS_EVIDENCE_UNPUBLISHED');
  const plan = refusalRemediationPlan(later, ['decision', 'witness', 'WS-1', '--criterion', AC]);
  assert.doesNotMatch(JSON.stringify(plan.steps), RECOVER);
  assert.equal(firstRoute(plan).id, 'raise-upstream-issue');
  assert.match(firstRoute(plan).command, /^singularity-flow upstream-issue raise --work-id WS-1 --phase implementation --about WS-1:AC-001/u);
  // At the owning step, published and in progress: its next version, previewed for the person's yes.
  const own = refused(witnessStory({ implementation: 'in_progress', current: 'implementation', verification: 'not_started' }));
  const ownPlan = refusalRemediationPlan(own, ['decision', 'witness', 'WS-1', '--criterion', AC]);
  assert.equal(firstRoute(ownPlan).command, 'singularity-flow phase rollover implementation --json');
  assert.doesNotMatch(JSON.stringify(ownPlan.steps), RECOVER);
  // Submitted: an approver returns it to itself.
  const submitted = refused(witnessStory({ implementation: 'awaiting_approval', current: 'implementation', verification: 'not_started' }));
  assert.match(firstRoute(refusalRemediationPlan(submitted, ['decision', 'witness', 'WS-1'])).command, /^singularity-flow reject implementation --work-id WS-1 --to implementation/u);
  // No step's delivery records it: the code step that owes it publishes it with its delivery, by its own work command.
  const nobody = refused({ workItem: { id: 'WS-1' }, status: 'in_progress', currentPhase: 'implementation', phases: {} });
  const nobodyPlan = refusalRemediationPlan(nobody, ['decision', 'witness', 'WS-1']);
  assert.equal(firstRoute(nobodyPlan).skill, '/sf-code');
  assert.doesNotMatch(JSON.stringify(nobodyPlan.steps), RECOVER);
});

async function appealRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-appeal-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'APPEAL-9', root]);
  return root;
}
const appealWorkflow = (status, extra = {}) => ({ workItem: { id: 'APPEAL-9', branch: 'APPEAL-9' }, status: 'in_progress', currentPhase: 'implementation',
  phaseOrder: ['implementation'], phases: { implementation: { id: 'implementation', status, generation: 1, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code' }, generationIntent: { status: 'consumed', generation: 1 }, approvalPolicy: { rejectTo: ['implementation'] }, ...extra } } });

test('a scope appeal on a published or submitted code step names its next version or its return, never recovery (finding 7)', async (t) => {
  const root = await appealRepository(t);
  const refusal = async (workflow) => preparePhaseAppeal(root, {}, workflow, { phaseId: 'implementation', changes: [], reason: 'x' })
    .then(() => assert.fail('prepared'), (error) => error);
  const published = await refusal(appealWorkflow('in_progress'));
  assert.equal(published.code, 'PHASE_APPEAL_LIFECYCLE');
  assert.equal(published.details.nextAction.command, 'singularity-flow phase rollover implementation --reason "<what to change>" --json');
  assert.equal(published.details.nextAction.skill, '/sf-code');
  const argv = ['appeal', 'prepare', '--phase', 'implementation', '--add-location', 'APPEAL-9:AC-001=src/a.mjs', '--reason', 'why'];
  let plan = refusalRemediationPlan(published, argv);
  assert.equal(firstRoute(plan).command, published.details.nextAction.command);
  assert.doesNotMatch(JSON.stringify(plan.steps), RECOVER);
  const submitted = await refusal(appealWorkflow('awaiting_approval'));
  assert.equal(submitted.details.nextAction.command, 'singularity-flow reject implementation --work-id APPEAL-9 --fetch --to implementation --reason <reason>');
  plan = refusalRemediationPlan(submitted, argv);
  assert.equal(firstRoute(plan).command, submitted.details.nextAction.command);
  assert.doesNotMatch(JSON.stringify(plan.steps), RECOVER);
  // A refusal that names no state (from an older build) is still not sent to recovery first.
  const older = new SingularityFlowError('refused', { code: 'PHASE_APPEAL_LIFECYCLE', details: { recoveryCommand: 'singularity-flow recover APPEAL-9 --phase implementation --json' } });
  assert.doesNotMatch(firstRoute(refusalRemediationPlan(older, argv)).command ?? '', RECOVER);
});

/** An Epic with one planned Story in a delivery repository (test/epic-review-transport.test.mjs). */
async function epicWithDeliveryRepository(t) {
  const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-review-route-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const remote = path.join(parent, 'delivery.git');
  const lead = path.join(parent, 'lead');
  await mkdir(source);
  await mkdir(lead);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Review Tester']);
  git(source, ['config', 'user.email', 'review@example.com']);
  await writeFile(path.join(source, 'README.md'), '# Delivery\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Delivery']);
  git(parent, ['init', '--bare', '-b', 'main', remote]);
  git(source, ['push', remote, 'main']);
  git(lead, ['init', '-b', 'main']);
  git(lead, ['config', 'user.name', 'Review Tester']);
  git(lead, ['config', 'user.email', 'review@example.com']);
  await initializeDefinition(lead);
  const portfolioPath = path.join(lead, 'singularity/portfolio.yml');
  const configured = YAML.parse(await readFile(portfolioPath, 'utf8'));
  configured.repositories = { delivery: { url: remote, defaultBranch: 'main', required: true } };
  configured.git.publish = 'off';
  for (const authority of Object.values(configured.approvalAuthorities ?? {})) authority.members = [{ name: 'Review Tester', email: 'review@example.com' }];
  await writeFile(portfolioPath, YAML.stringify(configured));
  git(lead, ['add', '.']);
  git(lead, ['commit', '-m', 'Initialize']);
  git(lead, ['switch', '-c', 'EPIC-ROUTE']);
  const { portfolio, initiative } = await createInitiative(lead, { id: 'EPIC-ROUTE', title: 'Review route test', profile: 'epic-planning', agent: 'product-owner' });
  await writeFile(path.join(initiativeDir(lead, portfolio, 'EPIC-ROUTE'), 'breakdown.yml'), YAML.stringify({ version: 2, initiativeId: 'EPIC-ROUTE',
    epics: [{ planId: 'EPIC-001', title: 'Delivery', stories: [{ planId: 'STORY-001', workId: 'WRK-ROUTE', title: 'Inspect delivery', repository: 'delivery',
      requirements: ['REQ-001'], acceptanceCriteria: ['AC-001'], dependsOn: [] }] }] }));
  await saveInitiative(lead, portfolio, initiative);
  git(lead, ['add', '.']);
  git(lead, ['commit', '-m', 'Plan story']);
  return { lead };
}

test('an Epic review of a Story with no finalized packet names the developer\'s finalize, never recovery from the Epic checkout (finding 8)', async (t) => {
  const { lead } = await epicWithDeliveryRepository(t);
  const error = await epicReviewStory(lead, 'EPIC-ROUTE', 'WRK-ROUTE').then(() => assert.fail('reviewed'), (refused) => refused);
  assert.match(error.message, /is not finalized for review on any published branch/u);
  assert.deepEqual(error.details.nextAction.argv, ['finalize', '--parent', 'WRK-ROUTE']);
  const plan = refusalRemediationPlan(error, ['epic', 'review', 'WRK-ROUTE', '--epic', 'EPIC-ROUTE']);
  assert.equal(firstRoute(plan).command, 'singularity-flow finalize --parent WRK-ROUTE');
  assert.ok(plan.steps.some((entry) => entry.command === 'singularity-flow epic status EPIC-ROUTE'));
  assert.doesNotMatch(JSON.stringify(plan.steps), RECOVER);
});
