import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run } from '../src/util.mjs';
import { recordSha256, canonicalJson } from '../src/records.mjs';
import { EvidenceAmendmentSchema, applyPlanEvidenceAmendments, verifyPlanEvidenceAmendments } from '../src/plan-evidence-amendments.mjs';
import { prepareEvidenceContractCorrection, evidenceContractRecoveryActions } from '../src/phase-evidence-amendment.mjs';
import { recoveryActionGuidance } from '../src/recovery-action-guidance.mjs';
import { contractRequiresTestTag, mergedVerificationContracts } from '../src/verification/contracts.mjs';
import { derivePlannedClaimMap, readBoundSpecificationClaimMap } from '../src/specifications.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { resolveOperation, operationById } from '../src/command-registry.mjs';

const WORK = 'EVIDENCE-1';
const AC = `${WORK}:AC-001`;
const REQ = `${WORK}:REQ-001`;
const rootPath = `team/stories/${WORK}`;
const file = `${rootPath}/evidence/screen.png`;
const pointerPath = `${rootPath}/context/claims/decide-gen1-planned.json`;
const previous = { expectedPaths: ['src/ui.jsx'], tests: ['test/ui.test.mjs'], testDisposition: 'applicable',
  fulfillment: 'modified', steps: ['future-render'] };
function subject() {
  const record = { schemaVersion: currentSchemaVersion('specification-claim-map'), kind: 'planned', workId: WORK,
    phase: 'decide', generation: 1, recordedAt: '2026-10-08T00:00:00.000Z',
    claims: { [AC]: structuredClone(previous), [REQ]: { ...structuredClone(previous), steps: [] } } };
  const workflow = { workItem: { id: WORK, branch: WORK }, currentPhase: 'future-render', status: 'in_progress',
    phaseOrder: ['decide', 'future-render'], resolution: { plannedClaims: { mode: 'required', owners: { 'future-render': 'decide' } } },
    phases: { decide: { id: 'decide', status: 'approved', generation: 1, approvalPolicy: { authorities: ['design-reviewers'] },
      claimMaps: { planned: { path: pointerPath, sha256: recordSha256(record), generation: 1 } } },
    'future-render': { id: 'future-render', status: 'in_progress', generation: 0 } } };
  const amendment = { id: `PEA-${'a'.repeat(24)}`, kind: 'evidence-contract-correction', ownerPhase: 'decide', ownerGeneration: 1,
    ownerMapSha256: recordSha256(record), clauseId: AC, previousClaimSha256: recordSha256(previous), path: file, method: 'visual',
    reason: 'The approved screenshot obligation was incorrectly typed as product source.', actor: 'reviewer@example.test',
    authorityGroup: 'design-reviewers', authorizationId: 'authorization-1', reviewAssurance: 'live-terminal-exact-evidence-review',
    at: '2026-10-08T00:00:00.000Z', recordPath: `${rootPath}/appeals/evidence/PEA-${'a'.repeat(24)}.json`,
    reviewedFile: { sha256: 'b'.repeat(64), size: 123 }, testsWaived: false, phaseApproved: false };
  return { record, workflow, amendment };
}

test('a correction replaces only its exact owner row, retaining other clauses and test commands', () => {
  const { record, workflow, amendment } = subject();
  workflow.planAmendments = [amendment];
  const original = canonicalJson({ record, workflow });
  const result = applyPlanEvidenceAmendments(record, workflow, { evidenceRoot: `${rootPath}/evidence` });
  assert.equal(result.claims[AC].fulfillment, 'evidence');
  assert.deepEqual(result.claims[AC].expectedPaths, [file]);
  assert.deepEqual(result.claims[AC].tests, previous.tests);
  assert.deepEqual(result.claims[REQ], record.claims[REQ]);
  const contract = mergedVerificationContracts([result]).get(AC);
  assert.equal(contractRequiresTestTag(contract), false);
  assert.deepEqual(contract.slots.map(slot => [slot.method, slot.role]), [['visual', 'primary'], ['test', 'supporting']]);
  assert.equal(contract.slots[0].requiredAssurance, 'source-bound');
  assert.equal(canonicalJson({ record, workflow }), original, 'no approved record is rewritten');
  assert.equal(applyPlanEvidenceAmendments({ ...record, phase: 'different-owner' }, workflow).claims[AC].fulfillment, 'modified');
  const successor = { ...record, generation: 2 };
  assert.equal(applyPlanEvidenceAmendments(successor, workflow), successor, 'a new approved plan supersedes old typing');
});

test('corrections refuse forged authority, wrong owner/row/path, duplicates and waivers', () => {
  for (const mutate of [
    value => { value.ownerMapSha256 = '0'.repeat(64); },
    value => { value.previousClaimSha256 = '0'.repeat(64); },
    value => { value.clauseId = `${WORK}:AC-999`; },
    value => { value.path = 'team/stories/OTHER/evidence/screen.png'; },
    value => { value.path = `${rootPath}/evidence/../escape`; },
    value => { value.authorityGroup = 'unapproved-group'; },
    value => { value.testsWaived = true; },
    value => { delete value.authorizationId; },
    value => { value.reviewAssurance = 'agent'; }
  ]) {
    const { record, workflow, amendment } = subject(); mutate(amendment); workflow.planAmendments = [amendment];
    assert.throws(() => applyPlanEvidenceAmendments(record, workflow, { evidenceRoot: `${rootPath}/evidence` }), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
  }
  const { record, workflow, amendment } = subject(); workflow.planAmendments = [amendment, amendment];
  assert.throws(() => applyPlanEvidenceAmendments(record, workflow), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
  for (const name of ['../a', '/tmp/a', 'C:/a', 'a\\b', 'a/CON.png', 'a/*', 'a/name.']) {
    assert.equal(EvidenceAmendmentSchema.safeParse({ ...amendment, path: name }).success, false, name);
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-evidence-correction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  const write = async (relative, bytes) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), bytes); };
  git('init', '-q', '-b', WORK); git('config', 'user.name', 'Evidence Reviewer'); git('config', 'user.email', 'reviewer@example.test');
  const data = subject(); await write(pointerPath, canonicalJson(data.record));
  git('add', '.'); git('commit', '-qm', 'Approved owner map'); await write(file, 'reviewed screen');
  return { root, git, write, ...data, config: { workItemRoot: 'team/stories' } };
}

test('preview works with future phase names/custom roots, is read-only, exact-byte-bound and routed in Copilot', async t => {
  const f = await fixture(t);
  const options = { clauseId: AC.toLowerCase(), evidencePath: file, reason: f.amendment.reason };
  const before = f.git('status', '--porcelain=v1', '--untracked-files=all');
  const preview = await prepareEvidenceContractCorrection(f.root, f.config, f.workflow, options);
  assert.equal(preview.clauseId, AC); assert.equal(preview.testsWaived, false); assert.equal(preview.phaseApproved, false);
  assert.equal(preview.proposedClaim.fulfillment, 'evidence');
  assert.deepEqual(preview.proposedClaim.expectedPaths, [file]);
  assert.equal(preview.proposedContract.slots[0].method, 'visual');
  assert.match(preview.acceptance.copilotCommand, /^\/sf-appeal evidence-accept --phase future-render/u);
  assert.match(preview.guidedReview.copilotCommand, /^\/sf-appeal evidence-accept --phase future-render.*--review-ui/u);
  assert.equal(preview.guidedReview.argv.includes('--review-ui'), true);
  assert.equal(f.git('status', '--porcelain=v1', '--untracked-files=all'), before);
  const actions = await evidenceContractRecoveryActions(f.root, f.config, f.workflow, f.workflow.phases['future-render'], { unexpectedPaths: [file, 'other-story/screen.png'] });
  assert.equal(actions.length, 1); assert.equal(actions[0].automatic, false);
  assert.match(recoveryActionGuidance(actions[0]).copilotCommand, /^\/sf-appeal evidence-prepare --phase future-render/u);
  await f.write(file, 'new screen');
  const changed = await prepareEvidenceContractCorrection(f.root, f.config, f.workflow, options);
  assert.notEqual(changed.packetSha256, preview.packetSha256);
  f.workflow.phases['future-render'].status = 'awaiting_approval';
  await assert.rejects(prepareEvidenceContractCorrection(f.root, f.config, f.workflow, options), { code: 'PLAN_EVIDENCE_CORRECTION_LIFECYCLE' });
});

test('another plan reviewer cannot amend the clause owner in a multi-plan workflow', () => {
  const { record, workflow, amendment } = subject();
  workflow.phaseOrder.unshift('other-plan');
  workflow.resolution.plannedClaims.owners['other-code'] = 'other-plan';
  workflow.phases['other-plan'] = { id: 'other-plan', approvalPolicy: { authorities: ['other-reviewers'] } };
  amendment.authorityGroup = 'other-reviewers'; workflow.planAmendments = [amendment];
  assert.throws(() => applyPlanEvidenceAmendments(record, workflow), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
});

test('approved-document tampering and unsafe evidence cannot be classified into ownership', async t => {
  const f = await fixture(t); const options = { clauseId: AC, evidencePath: file, reason: f.amendment.reason };
  const plan = `${rootPath}/artifacts/decide/plan.md`; const bytes = Buffer.from('Approved plan');
  await f.write(plan, bytes); f.git('add', plan); f.git('commit', '-qm', 'Approved governed document');
  f.workflow.phases.decide.artifacts = [{ path: plan, size: bytes.length, sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }];
  await f.write(plan, 'tampered approved plan');
  await assert.rejects(prepareEvidenceContractCorrection(f.root, f.config, f.workflow, options), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
  await f.write(plan, bytes);
  await assert.rejects(prepareEvidenceContractCorrection(f.root, f.config, f.workflow, { ...options, evidencePath: 'team/stories/OTHER/evidence/a.png' }), { code: 'PLAN_EVIDENCE_CORRECTION_INVALID' });
  await assert.rejects(prepareEvidenceContractCorrection(f.root, { ...f.config, governance: { protectedPaths: [`${rootPath}/evidence`] } }, f.workflow, options), { code: 'PLAN_EVIDENCE_CORRECTION_PROTECTED' });
  await f.write(file, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(prepareEvidenceContractCorrection(f.root, f.config, f.workflow, options));
});

test('bound readers require the exact committed correction, and never overwrite the original map', async t => {
  const f = await fixture(t); f.workflow.planAmendments = [f.amendment];
  await f.write(f.amendment.recordPath, canonicalJson(f.amendment));
  await assert.rejects(verifyPlanEvidenceAmendments(f.root, f.workflow, rootPath), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
  f.git('add', f.amendment.recordPath); f.git('commit', '-qm', 'Retain exact reviewed correction');
  const bytes = await readFile(path.join(f.root, pointerPath));
  const result = await readBoundSpecificationClaimMap(f.root, path.join(f.root, rootPath), f.workflow, f.workflow.phases.decide, 'planned', { requireCommitted: true });
  assert.equal(result.claims[AC].fulfillment, 'evidence');
  assert.deepEqual(await readFile(path.join(f.root, pointerPath)), bytes);
  await f.write(f.amendment.recordPath, canonicalJson({ ...f.amendment, reason: 'Different reason not reviewed by the human.' }));
  await assert.rejects(verifyPlanEvidenceAmendments(f.root, f.workflow, rootPath), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
  await rm(path.join(f.root, f.amendment.recordPath));
  try { await symlink(path.join(f.root, pointerPath), path.join(f.root, f.amendment.recordPath)); }
  catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Symlink unavailable'); return; } throw error; }
  await assert.rejects(verifyPlanEvidenceAmendments(f.root, f.workflow, rootPath));
});

test('new appeal operations are model-free and recovery presentation never invents a route', () => {
  for (const action of ['evidence-prepare', 'evidence-accept']) {
    const operation = resolveOperation({ requestedCommand: 'appeal', positionals: ['appeal', action], options: {} });
    assert.deepEqual(operation, operationById(`appeal.${action}`));
    assert.equal(operation.classification, action === 'evidence-prepare' ? 'read' : 'mutation');
  }
  assert.equal(recoveryActionGuidance({ command: 'singularity-flow phase show future-render --show-artifact' }).copilotCommand, '/sf-phase-documents future-render');
  assert.equal(recoveryActionGuidance({ command: `singularity-flow recover ${WORK} --phase future-render --json`, skill: '/sf-approve' }).copilotCommand, null);
  assert.equal(recoveryActionGuidance({ command: 'curl https://example.test/execute' }).commandGuidance, null);
});

test('the shared planner refuses prose-only visual contracts before publishing any workflow plan', () => {
  const tick = String.fromCharCode(96);
  const prose = `Primary visual verification contract for [${AC}]. Retain ${tick}${file}${tick}.`;
  const mapping = ['# Plan', '## Planned implementation evidence', '| Clause | Expected paths | Planned tests | Fulfillment | Steps |', '|---|---|---|---|---|',
    `| ${tick}${AC}${tick} | ${tick}src/ui.jsx${tick} | ${tick}test/ui.test.mjs${tick} | modified | future-render |`, prose].join('\n');
  const options = { workId: WORK, phase: 'decide', generation: 1, clauseIds: [AC], evidenceRoot: `${rootPath}/evidence` };
  assert.throws(() => derivePlannedClaimMap(mapping, options), { code: 'SPEC_VERIFICATION_CONTRACT_INVALID' });
  const corrected = mapping.replace(`${tick}src/ui.jsx${tick}`, `${tick}${file}${tick}`).replace('| modified |', '| evidence |')
    + `\n## Verification contracts\n| Criterion | Slot | Method | Witness |\n|---|---|---|---|\n| ${tick}${AC}${tick} | screen | visual | ${tick}Scientific screen${tick} |\n`;
  const derived = derivePlannedClaimMap(corrected, options).claimMap;
  assert.equal(derived.claims[AC].fulfillment, 'evidence');
  assert.equal(derived.verificationContracts[0].slots[0].method, 'visual');
});
