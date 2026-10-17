import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fixture, propose, stageAcceptedReview, acceptAmendment } from '../scripts/amended-read-fixture.mjs';

import {
  CONFIGURATION_BRANCH, ensureConfigurationBranch, inspectApprovedSkillPackage,
  loadStoryConfigurationSnapshot
} from '../src/configuration-branch.mjs';
import { canonicalJson } from '../src/records.mjs';
import { run } from '../src/util.mjs';
import {
  captureWorkflowSnapshot, captureWorkflowSnapshotAmendment, verifyWorkflowSnapshot
} from '../src/workflow-snapshots.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const qualified = (bytes) => `sha256:${digest(bytes)}`;
const domainHash = (domain, value) => qualified(Buffer.concat([
  Buffer.from(`${domain}\0`), Buffer.from(canonicalJson(value))
]));





test('accepted skill revision cannot be rolled back by restoring a genesis Story', async (t) => {
  const value = await propose(t);
  await acceptAmendment(value);
  const rollback = structuredClone(value.workflow);
  await writeFile(value.workflowPath, `${JSON.stringify(rollback, null, 2)}\n`);
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, rollback,
    { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'attempt to restore superseded Story revision'],
    { cwd: value.storyRoot });
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, rollback,
    { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
});

test('accepted reader rejects a proposal committed with different Story policy', async (t) => {
  const value = await propose(t, { proposalResolutionTamper: true });
  await acceptAmendment(value);
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
});

async function acceptWithIntermediateReview(value, tamper) {
  value.decision.approvals.push({
    actor: { email: 'second-reviewer@example.invalid' },
    authorityGroup: 'reviewers', identityAssurance: 'configured-local',
    at: '2026-09-26T00:59:30.000Z'
  });
  const decisionBytes = Buffer.from(`${JSON.stringify(value.decision, null, 2)}\n`);
  await writeFile(path.join(value.storyRoot, value.decisionPath), decisionBytes);
  value.decisionSha256 = qualified(decisionBytes);
  const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    });
  value.proposed.workflowSnapshot = reference;

  const first = value.decision.approvals[0];
  const prefix = `${value.config.workItemRoot}/${value.workflow.workItem.id}/context/skill-amendments/SAM-001`;
  const firstPath = `${prefix}-review-001.json`;
  const firstReview = {
    schemaVersion: 1, kind: 'skill-version-adoption-review', id: 'SAM-001',
    workId: value.workflow.workItem.id, decision: 'approve', actor: first.actor,
    authorityGroup: first.authorityGroup, identityAssurance: first.identityAssurance,
    at: first.at, reason: null, proposalSha256: value.decision.proposalSha256,
    impactSha256: value.decision.impactSha256
  };
  const firstBytes = Buffer.from(canonicalJson(firstReview));
  await writeFile(path.join(value.storyRoot, firstPath), firstBytes);
  const firstApproval = { ...first, reviewPath: firstPath, reviewSha256: qualified(firstBytes) };
  value.workflow.skillVersionAmendments[0].approvals = [firstApproval];
  const interim = structuredClone(value.workflow);
  if (tamper === 'resolution') interim.resolution.phases[0].approval.minimum += 1;
  if (tamper === 'reference') interim.workflowSnapshot.snapshotHash = H('9');
  if (!tamper) interim.history = [{
    at: '2026-09-26T00:59:10.000Z', event: 'phase_progress',
    phase: 'threat-model', detail: 'Unrelated review-period activity.'
  }];
  await writeFile(value.workflowPath, `${JSON.stringify(interim, null, 2)}\n`);
  run('git', ['add', '--', path.relative(value.storyRoot, value.workflowPath), firstPath],
    { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'record first human review'], { cwd: value.storyRoot });

  const second = value.decision.approvals[1];
  const secondPath = `${prefix}-review-002.json`;
  const secondReview = {
    ...firstReview, actor: second.actor, authorityGroup: second.authorityGroup,
    identityAssurance: second.identityAssurance, at: second.at
  };
  const secondBytes = Buffer.from(canonicalJson(secondReview));
  await writeFile(path.join(value.storyRoot, secondPath), secondBytes);
  const summary = value.proposed.skillVersionAmendments[0];
  summary.status = 'approved';
  summary.approvals = [firstApproval, {
    ...second, reviewPath: secondPath, reviewSha256: qualified(secondBytes)
  }];
  summary.decidedAt = value.decision.approvedAt;
  summary.decisionPath = value.decisionPath;
  summary.decisionSha256 = value.decisionSha256;
  value.proposed.schemaVersion = 10;
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'accept second human review and skill amendment'],
    { cwd: value.storyRoot });
}

for (const tamper of ['resolution', 'reference']) {
  test(`accepted reader rejects an intermediate review with altered Story ${tamper}`,
    async (t) => {
      const value = await propose(t, { approvalMinimum: 2 });
      await acceptWithIntermediateReview(value, tamper);
      await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
        value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
    });
}

test('accepted reader retains a valid two-review sequence with unrelated phase progress',
  async (t) => {
    const value = await propose(t, { approvalMinimum: 2 });
    await acceptWithIntermediateReview(value, null);
    const accepted = await verifyWorkflowSnapshot(value.storyRoot, value.config,
      value.proposed, { requireAccepted: true });
    assert.equal(accepted.revision, 2);
  });

test('accepted reader allows unrelated Story progress at the proposal commit', async (t) => {
  const value = await propose(t, { proposalLifecycleProgress: true });
  await acceptAmendment(value);
  const accepted = await verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true });
  assert.equal(accepted.revision, 2);
});

test('accepted reader refuses approved-summary edits after acceptance', async (t) => {
  const value = await propose(t);
  await acceptAmendment(value);
  value.proposed.skillVersionAmendments[0].proposedAt = '2026-09-26T00:40:00.000Z';
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'attempt to edit accepted review summary'],
    { cwd: value.storyRoot });
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
});

test('reviewed v3 amendment retains a separate accepted parent-linked skill snapshot', async (t) => {
  const value = await propose(t);
  const genesisPath = path.join(value.storyRoot,
    value.workflow.workflowSnapshot.manifestPath);
  const genesisBytes = await readFile(genesisPath);
  const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    });
  assert.equal(reference.schemaVersion, 2);
  assert.equal(reference.revision, 2);
  assert.equal(reference.genesisSnapshotHash,
    value.workflow.workflowSnapshot.genesisSnapshotHash);
  assert.deepEqual(await readFile(genesisPath), genesisBytes);
  const manifest = JSON.parse(await readFile(path.join(value.storyRoot,
    reference.manifestPath), 'utf8'));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.parentSnapshotHash, value.workflow.workflowSnapshot.snapshotHash);
  assert.equal(manifest.amendment.decisionSha256, value.decisionSha256);
  value.proposed.workflowSnapshot = reference;
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config, value.proposed,
    { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });

  await stageAcceptedReview(value);
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'accept reviewed skill version amendment'],
    { cwd: value.storyRoot });
  const accepted = await verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true, retainBytes: true });
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.creationCommit,
    run('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: value.storyRoot }).stdout.trim());
  assert.equal(accepted.skillPackages[0].packageSha256,
    value.selected.manifest.packageSha256);
  assert.deepEqual(await readFile(genesisPath), genesisBytes);

  // A later commit cannot rewrite the immutable human decision while keeping the same Story ref.
  const changedDecision = { ...value.decision, proposalSha256: H('3') };
  await writeFile(path.join(value.storyRoot, value.decisionPath),
    `${JSON.stringify(changedDecision, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'attempt to replace accepted decision'],
    { cwd: value.storyRoot });
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
});

test('amendment capture cannot change generation policy outside its selected binding', async (t) => {
  const value = await propose(t);
  value.proposed.resolution.phases[0].generation = { requirement: 'none' };
  await assert.rejects(captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    }), { code: 'WFA_AMENDMENT_UNSUPPORTED' });
});

test('one changed skill keeps another selected package and its source bytes pinned', async (t) => {
  const value = await propose(t, { secondSkill: true });
  const genesis = await verifyWorkflowSnapshot(value.storyRoot, value.config, value.workflow,
    { requireAccepted: true, retainBytes: true });
  const priorOther = genesis.manifest.skillPackages.find((entry) =>
    entry.skillId === 'risk-register');
  const priorOtherAssets = genesis.manifest.assets.filter((asset) =>
    asset.source?.skillId === 'risk-register');
  const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    });
  const manifest = JSON.parse(await readFile(path.join(value.storyRoot,
    reference.manifestPath), 'utf8'));
  assert.deepEqual(manifest.skillPackages.find((entry) => entry.skillId === 'risk-register'),
    priorOther);
  assert.deepEqual(manifest.assets.filter((asset) => asset.source?.skillId === 'risk-register'),
    priorOtherAssets);
  assert.notEqual(priorOtherAssets[0].source.configurationCommit,
    manifest.provenance.configuration.commit);
  value.proposed.workflowSnapshot = reference;
  await stageAcceptedReview(value);
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'accept one of two reviewed package versions'],
    { cwd: value.storyRoot });
  const accepted = await verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true, retainBytes: true });
  assert.equal(accepted.skillPackages.length, 2);
  assert.equal(accepted.skillPackages.find((entry) => entry.skillId === 'risk-register')
    .packageSha256, value.retainedOther.manifest.packageSha256);
  assert.deepEqual(accepted.assetBytes.get(priorOtherAssets[0].logicalId),
    genesis.assetBytes.get(priorOtherAssets[0].logicalId));
});

test('unrelated selected skill binding cannot be changed with a reviewed package update', async (t) => {
  const value = await propose(t, { secondSkill: true });
  value.proposed.resolution.phases[1].skillBinding.bindingRefs.contractSha256 = H('9');
  await assert.rejects(captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    }), { code: 'WFA_AMENDMENT_UNSUPPORTED' });
});

test('accepted reader rejects self-rehashed provenance changes to the untouched skill', async (t) => {
  const value = await propose(t, { secondSkill: true });
  const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    });
  const manifestPath = path.join(value.storyRoot, reference.manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const untouched = manifest.assets.find((asset) =>
    asset.source?.skillId === 'risk-register');
  untouched.source.configurationCommit = value.approved.sourceCommit;
  const manifestCore = structuredClone(manifest);
  delete manifestCore.snapshotHash;
  manifest.snapshotHash = domainHash('wfa.snapshot.v3', manifestCore);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  value.proposed.workflowSnapshot = { ...reference, snapshotHash: manifest.snapshotHash };
  await stageAcceptedReview(value);
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'attempt to rebind unchanged skill provenance'],
    { cwd: value.storyRoot });
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
});

for (const evidence of ['proposal', 'impact', 'review']) {
  test(`accepted reader rejects a post-accept ${evidence} rewrite`, async (t) => {
    const value = await propose(t);
    const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
      value.workflow, value.proposed, {
        approvedConfigurationSnapshot: value.approved,
        amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
      });
    value.proposed.workflowSnapshot = reference;
    await stageAcceptedReview(value);
    await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
    run('git', ['add', '-A'], { cwd: value.storyRoot });
    run('git', ['commit', '-qm', 'accept exact reviewed evidence'],
      { cwd: value.storyRoot });
    await verifyWorkflowSnapshot(value.storyRoot, value.config, value.proposed,
      { requireAccepted: true });
    const summary = value.proposed.skillVersionAmendments[0];
    const relative = evidence === 'proposal' ? summary.proposalPath
      : evidence === 'impact' ? summary.impactPath : summary.approvals[0].reviewPath;
    const file = path.join(value.storyRoot, relative);
    const original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from(' \n')]));
    run('git', ['add', '-A'], { cwd: value.storyRoot });
    run('git', ['commit', '-qm', `attempt to rewrite immutable ${evidence}`],
      { cwd: value.storyRoot });
    await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
      value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
    if (evidence === 'proposal') {
      // Restoring the original bytes does not erase the intervening mutation from Git history.
      await writeFile(file, original);
      run('git', ['add', '-A'], { cwd: value.storyRoot });
      run('git', ['commit', '-qm', 'attempt to restore rewritten proposal'],
        { cwd: value.storyRoot });
      await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
        value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
    }
  });
}

test('accepted reader rejects a review rehashed to a different human', async (t) => {
  const value = await propose(t);
  const reference = await captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    });
  value.proposed.workflowSnapshot = reference;
  await stageAcceptedReview(value);
  const approval = value.proposed.skillVersionAmendments[0].approvals[0];
  const reviewPath = path.join(value.storyRoot, approval.reviewPath);
  const review = JSON.parse(await readFile(reviewPath, 'utf8'));
  review.actor = { email: 'different-reviewer@example.invalid' };
  const altered = Buffer.from(canonicalJson(review));
  await writeFile(reviewPath, altered);
  approval.reviewSha256 = qualified(altered);
  await writeFile(value.workflowPath, `${JSON.stringify(value.proposed, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: value.storyRoot });
  run('git', ['commit', '-qm', 'attempt to bind a different reviewer'],
    { cwd: value.storyRoot });
  await assert.rejects(verifyWorkflowSnapshot(value.storyRoot, value.config,
    value.proposed, { requireAccepted: true }), { code: 'WFA_AMENDMENT_INVALID' });
});

test('amendment capture refuses an unreviewed second package without rewriting genesis', async (t) => {
  const value = await propose(t);
  const genesisPath = path.join(value.storyRoot,
    value.workflow.workflowSnapshot.manifestPath);
  const genesisBytes = await readFile(genesisPath);
  value.proposed.resolution.phases.push({
    id: 'other-phase', kind: 'skill', defaultAgent: 'developer',
    skillBinding: {
      schemaVersion: 1, compiler: 'skp-contract/v1', compilationSha256: H('c'),
      parserProfile: 'skp-skill-text/v1',
      bindingRefs: { skill: { id: 'other-package', packageSha256: H('5') },
        contractSha256: H('6'), inputs: [], outputs: [] }
    }
  });
  await assert.rejects(captureWorkflowSnapshotAmendment(value.storyRoot, value.config,
    value.workflow, value.proposed, {
      approvedConfigurationSnapshot: value.approved,
      amendmentDecision: { path: value.decisionPath, sha256: value.decisionSha256 }
    }), { code: 'WFA_AMENDMENT_UNSUPPORTED' });
  assert.deepEqual(await readFile(genesisPath), genesisBytes);
});
