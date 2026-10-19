/**
 * `decision visual-profile`: a configured screen size that does not apply to a Story.
 *
 * A phone-only app could never pass enforced coverage of a workflow that also lists a tablet
 * profile. A person who approves the visual step records why the tablet does not apply; coverage
 * then lists it as not applicable, with the reason, who decided and the decision ID, and never as
 * passed. At least one profile must still be evidenced, and a revocation restores the requirement.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encodePngRgba8 } from '../src/png-rgba8.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { assertVisualCoverage, evaluateVisualCoverage } from '../src/visual-coverage.mjs';
import { recordNativeVisualCapture } from '../src/visual-native-capture.mjs';
import {
  assertVisualProfileDecidable, recordVisualProfileDecision, recordVisualProfileRevocation, visualProfileDecisionOptions
} from '../src/visual-profile-decisions.mjs';

const PHONE = { id: 'phone-390x844', label: 'Phone 390 × 844', width: 390, height: 844, deviceScaleFactor: 1 };
const TABLET = { id: 'tablet-834x1194', label: 'Tablet 834 × 1194', width: 834, height: 1194, deviceScaleFactor: 1 };
const AT = '2026-10-19T10:00:00.000Z';
const WHO = { actor: 'design.reviewer@example.invalid', authorityGroup: 'design-reviewers', identityAssurance: 'configured-local', at: AT };
const REASON = 'This app ships to phones only; there is no tablet layout to verify.';

async function fixture(t, { profiles = [PHONE, TABLET], coverage = 'enforce' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-visual-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const itemDirectory = path.join(root, 'singularity/work-items/MOB-1');
  await mkdir(itemDirectory, { recursive: true });
  const workflow = {
    workItem: { id: 'MOB-1', workType: 'figma-mobile' }, status: 'in_progress', currentPhase: 'visual-verification',
    phaseOrder: ['implementation', 'visual-verification', 'conformance'],
    phases: {
      implementation: { id: 'implementation', status: 'approved', generation: 1, approvalPolicy: { authorities: ['engineering-reviewers'] } },
      'visual-verification': { id: 'visual-verification', status: 'in_progress', generation: 0, requiredArtifact: { kind: 'visual-test-evidence' },
        approvalPolicy: { authorities: ['design-reviewers', 'quality-reviewers'] } },
      conformance: { id: 'conformance', status: 'not_started', generation: 0, approvalPolicy: { authorities: ['quality-reviewers'] } }
    },
    resolution: { workItemRoot: 'singularity/work-items', verification: { coverage, profiles,
      comparison: { mode: 'warn', channelTolerance: 8, maxDifferingPixelRatio: 0.02, maxDifferingPixels: null, maxPixels: 40_000_000 } } },
    history: []
  };
  return { root, itemDirectory, workflow };
}

async function capturePhone(root, workflow, itemDirectory) {
  await writeFile(path.join(root, 'phone.png'), encodePngRgba8({ width: 390, height: 844, data: Buffer.alloc(390 * 844 * 4, 255) }));
  return recordNativeVisualCapture(root, workflow, { phase: 'visual-verification', profileId: PHONE.id, screenId: 'checkout', stateId: 'default',
    file: 'phone.png', source: 'simulator', device: 'iPhone 15', osVersion: '17.5', actor: { name: 'QA', email: 'qa@example.invalid' }, agent: 'qa', itemDirectory });
}

test('a not-applicable profile is listed with its reason and decider, never as passed', async (t) => {
  const { root, itemDirectory, workflow } = await fixture(t);
  await capturePhone(root, workflow, itemDirectory);
  const before = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.equal(before.status, 'fail');
  assert.deepEqual(before.uncovered, [TABLET.id]);
  assert.equal(Object.hasOwn(before, 'notApplicable'), false, 'no key without a decision, so existing projections keep their bytes');

  const decision = recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: REASON, ...WHO });
  assert.deepEqual(decision, { id: 'VPD-001', phase: 'visual-verification', profileId: TABLET.id, profileLabel: TABLET.label,
    disposition: 'not-applicable', reason: REASON, ...WHO });
  const after = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.uncovered, []);
  assert.deepEqual(after.covered.map((entry) => entry.profileId), [PHONE.id], 'the tablet is never counted as covered');
  assert.deepEqual(after.notApplicable, [{ profileId: TABLET.id, decisionId: 'VPD-001', reason: REASON,
    actor: WHO.actor, authorityGroup: 'design-reviewers', at: AT }]);
  assert.equal(after.status, 'warn', 'an exception never reads as a clean pass');
  assert.ok(after.warnings.some((entry) => entry.includes('VPD-001') && entry.includes('This is an exception, not passing evidence.')));
  assert.equal((await assertVisualCoverage(root, workflow, { itemDirectory })).status, 'warn', 'enforced coverage lets the Story through');

  // Revoking it makes the tablet required again.
  const revocation = recordVisualProfileRevocation(workflow, { decisionId: 'VPD-001', reason: 'The tablet layout ships in this release after all.', ...WHO });
  assert.deepEqual(revocation, { revokes: 'VPD-001', phase: 'visual-verification', profileId: TABLET.id,
    reason: 'The tablet layout ships in this release after all.', ...WHO });
  const restored = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.equal(restored.status, 'fail');
  assert.deepEqual(restored.uncovered, [TABLET.id]);
  assert.equal(Object.hasOwn(restored, 'notApplicable'), false);
  assert.throws(() => recordVisualProfileRevocation(workflow, { decisionId: 'VPD-001', reason: REASON, ...WHO }), { code: 'VISUAL_PROFILE_DECISION_REVOKED' });
  // A new decision is VPD-002; the history keeps both and the revocation.
  assert.equal(recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: REASON, ...WHO }).id, 'VPD-002');
  assert.deepEqual(workflow.visualProfileDecisions.map((entry) => entry.id ?? `revokes ${entry.revokes}`), ['VPD-001', 'revokes VPD-001', 'VPD-002']);
});

test('the decision is refused for a profile the step does not check, twice, or for the last profile left to evidence', async (t) => {
  const { workflow } = await fixture(t);
  assert.throws(() => assertVisualProfileDecidable(workflow, { phaseId: 'visual-verification', profileId: 'watch-198x242' }),
    (error) => error.code === 'VISUAL_PROFILE_UNKNOWN' && /checks phone-390x844, tablet-834x1194/u.test(error.message));
  assert.throws(() => recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: 'too short', ...WHO }),
    { code: 'VISUAL_PROFILE_DECISION_INVALID' });
  assert.equal(workflow.visualProfileDecisions, undefined, 'a refused decision writes nothing');
  recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: REASON, ...WHO });
  assert.throws(() => recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: REASON, ...WHO }),
    { code: 'VISUAL_PROFILE_ALREADY_DECIDED' });
  assert.throws(() => recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: PHONE.id, reason: 'The phone is not a target of this Story either.', ...WHO }),
    (error) => error.code === 'VISUAL_PROFILE_LAST_REQUIRED' && /at least one screen size must have a screenshot/u.test(error.message));
  assert.equal(workflow.visualProfileDecisions.length, 1);

  // A single-profile workflow has nothing to decide away.
  const single = await fixture(t, { profiles: [PHONE] });
  assert.throws(() => assertVisualProfileDecidable(single.workflow, { phaseId: 'visual-verification', profileId: PHONE.id }), { code: 'VISUAL_PROFILE_LAST_REQUIRED' });
});

test('decisions that would leave no profile to evidence do not apply, even when written by hand', async (t) => {
  const { root, itemDirectory, workflow } = await fixture(t);
  workflow.visualProfileDecisions = [PHONE, TABLET].map((profile, index) => ({ id: `VPD-00${index + 1}`, phase: 'visual-verification',
    profileId: profile.id, profileLabel: profile.label, disposition: 'not-applicable', reason: REASON, ...WHO }));
  const result = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.uncovered, [PHONE.id, TABLET.id]);
  assert.equal(Object.hasOwn(result, 'notApplicable'), false);
  assert.ok(result.errors.some((entry) => /at least one must be evidenced, so none of those decisions applies/u.test(entry)));
});

test('a refusal for a missing profile names capturing it and the not-applicable decision as routes', async (t) => {
  const { root, itemDirectory, workflow } = await fixture(t);
  await capturePhone(root, workflow, itemDirectory);
  const refusal = await assertVisualCoverage(root, workflow, { itemDirectory }).then(() => null, (error) => error);
  assert.equal(refusal?.code, 'VISUAL_COVERAGE_FAILED');
  const commands = refusal.details.recoveryCommands.map((entry) => entry.command);
  assert.deepEqual(commands, [
    'singularity-flow visual record --phase visual-verification --profile-id tablet-834x1194 --screen-id <SCREEN-ID> --state-id <STATE-ID> --file <PNG-PATH> --source <simulator|emulator|device> --device "<DEVICE>"',
    'singularity-flow decision visual-profile MOB-1 --phase visual-verification --profile tablet-834x1194 --not-applicable --reason "<why this screen size does not apply to this Story>"'
  ]);
  assert.match(refusal.message, /decision visual-profile/u);
  const plan = refusalRemediationPlan(refusal, ['submit']);
  for (const command of commands) assert.ok(plan.steps.some((step) => step.command === command), `${command}\n${JSON.stringify(plan.steps, null, 2)}`);

  // With the phone the last profile left, its refusal offers only the capture.
  recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: REASON, ...WHO });
  workflow.phases['visual-verification'].generation = 2;
  const stale = await assertVisualCoverage(root, workflow, { itemDirectory }).then(() => null, (error) => error);
  assert.deepEqual(stale.details.uncovered, [PHONE.id], 'the earlier generation\'s capture is stale');
  assert.deepEqual(stale.details.recoveryCommands.map((entry) => entry.command.split(' ').slice(0, 3).join(' ')), ['singularity-flow visual record']);
});

test('the decision list gets each missing profile as a plain choice with the exact command for each option', async (t) => {
  const { root, itemDirectory, workflow } = await fixture(t);
  const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory });
  const choices = visualProfileDecisionOptions(workflow, 'visual-verification', coverage);
  assert.deepEqual(choices.map((choice) => choice.profileId), [PHONE.id, TABLET.id]);
  const [, tablet] = choices;
  assert.equal(tablet.title, 'No screenshot yet for Tablet 834 × 1194');
  assert.match(tablet.why, /has no current screenshot at 834 × 1194 pixels/u);
  assert.deepEqual(tablet.options.map((option) => [option.id, option.needsReason, option.available]), [['capture', false, true], ['not-applicable', true, true]]);
  assert.match(tablet.options[0].command, /^singularity-flow visual record --phase visual-verification --profile-id tablet-834x1194 /u);
  assert.match(tablet.options[0].alternativeCommands[0], /^singularity-flow mcp record <SERVER> --kind visual-artifact /u);
  assert.equal(tablet.options[1].command, 'singularity-flow decision visual-profile MOB-1 --phase visual-verification --profile tablet-834x1194 --not-applicable --reason "<why this screen size does not apply to this Story>"');
  assert.deepEqual(tablet.options[1].decidedBy, ['design-reviewers', 'quality-reviewers']);
  for (const text of JSON.stringify(choices).match(/"(?:title|why|detail)":"[^"]*"/gu)) assert.doesNotMatch(text, /governed/iu);

  // Once the tablet does not apply, the phone is the last screen size: deciding it away is unavailable.
  recordVisualProfileDecision(workflow, { phaseId: 'visual-verification', profileId: TABLET.id, reason: REASON, ...WHO });
  const [phone] = visualProfileDecisionOptions(workflow, 'visual-verification', await evaluateVisualCoverage(root, workflow, { itemDirectory }));
  assert.equal(phone.profileId, PHONE.id);
  assert.equal(phone.options[1].available, false);
  assert.equal(phone.options[1].command, null);
  assert.match(phone.options[1].detail, /only screen size left to check/u);
  assert.deepEqual(visualProfileDecisionOptions(workflow, 'visual-verification', { ...coverage, uncovered: [] }), []);
});
