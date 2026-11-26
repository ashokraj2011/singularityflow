/**
 * A task change's snapshot work [ITW:REQ-009, docs/WFA-WORKFLOW-SNAPSHOTS.md]: the bytes a step added to a started task
 * brings, the next accepted revision with them, and the replay of an accepted change on every later load. Loaded only
 * for a task change or a Story that has one; the snapshot internals it uses are handed to it by workflow-snapshots.mjs,
 * which alone marks a revision as a transaction's own until its commit is accepted.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { sanitizeRemote } from './git-remote-diagnostics.mjs';
import { secureRepositoryPath, writeJson } from './util.mjs';

/** A task change's decision binds its exact accepted parent and the policy with its one step added. */
export async function validateTaskChangeDecision({ fail, taskChangeDecisionPath }, config, workId, decision, { previous, next, decisionPath }) {
  const { assertTaskChangeScope, validateTaskChangeDecisionRecord } = await import('./task-change-contracts.mjs');
  validateTaskChangeDecisionRecord(decision);
  if (decision.workId !== workId || taskChangeDecisionPath(config, workId, decision.id) !== decisionPath
      || decision.from.revision !== previous.reference.revision || decision.from.snapshotHash !== previous.reference.snapshotHash
      || decision.from.policySha256 !== previous.policy.policySha256 || decision.to.policySha256 !== next.policy.policySha256
      || next.reference.revision !== decision.to.revision) fail('Task change decision differs from its exact accepted parent and changed policy.', 'WFA_AMENDMENT_INVALID');
  assertTaskChangeScope(previous.policy, next.policy, decision);
}

/**
 * The closure a task change keeps: every accepted asset with its exact bytes, plus only the added step's template and
 * the agents it brings, each with no dependency of its own. Identity, dependencies and interpretation stay the same.
 */
export function assertTaskChangeClosureScope({ fail }, previous, current, decision) {
  const priorManifest = previous.manifest;
  const nextManifest = current.manifest;
  const nextSource = current.policy.configurationSource;
  const strip = (value, keys) => { const copy = structuredClone(value ?? {}); for (const key of keys) delete copy[key]; return copy; };
  if (canonicalJson(priorManifest.story) !== canonicalJson(nextManifest.story)
      || canonicalJson(priorManifest.executionDependencies) !== canonicalJson(nextManifest.executionDependencies)
      || (priorManifest.skillPackages ?? []).length || (nextManifest.skillPackages ?? []).length
      || canonicalJson(priorManifest.provenance) !== canonicalJson(nextManifest.provenance)
      || canonicalJson(nextManifest.provenance?.configuration ?? null) !== canonicalJson(nextSource ? {
        repository: sanitizeRemote(nextSource.repository) || null, commit: nextSource.commit ?? null, filesSha256: nextSource.filesSha256 ?? null
      } : priorManifest.provenance?.configuration ?? null)
      || canonicalJson(strip(priorManifest.semantics, ['snapshot', 'amendment'])) !== canonicalJson(strip(nextManifest.semantics, ['snapshot', 'amendment']))) {
    fail('A task change changed the Story\'s retained identity, dependencies or interpretation.', 'WFA_AMENDMENT_INVALID');
  }
  const prior = new Map(priorManifest.assets.map((asset) => [asset.logicalId, asset]));
  for (const [logicalId, asset] of prior) {
    const next = nextManifest.assets.find((entry) => entry.logicalId === logicalId);
    const oldBytes = previous.assetBytes.get(logicalId);
    const newBytes = current.assetBytes.get(logicalId);
    if (!next || canonicalJson(asset) !== canonicalJson(next) || !oldBytes || !newBytes || !oldBytes.equals(newBytes)) {
      fail(`A task change changed the retained asset '${logicalId}'.`, 'WFA_AMENDMENT_INVALID');
    }
  }
  const added = nextManifest.assets.filter((asset) => !prior.has(asset.logicalId));
  if (canonicalJson(added.map((asset) => asset.logicalId).sort()) !== canonicalJson([...decision.addedAssets].sort())) {
    fail('A task change added assets other than its step\'s.', 'WFA_AMENDMENT_INVALID');
  }
  for (const asset of added) {
    const template = asset.logicalId === `template:${decision.step.id}`;
    const agent = decision.addedAgents.some((id) => asset.logicalId === `agent:${id}`);
    if ((template && (asset.purpose !== 'phase-template' || asset.blob.path !== current.policy.templates?.[decision.step.id]?.path))
        || (agent && asset.purpose !== 'governed-agent') || (!template && !agent) || (asset.dependencies ?? []).length) {
      fail(`A task change's asset '${asset.logicalId}' is not its step's template or agent.`, 'WFA_AMENDMENT_INVALID');
    }
  }
}

/**
 * The bytes a step added to a started task needs [ITW:REQ-009]: its template, and each agent the Story did not have,
 * captured into the Story's content-addressed store as a Story start captures them. Returns the assets and the template
 * reference the Story's policy keeps for the step; writes no manifest, state or commit.
 */
export async function captureTaskStepAssets(internals, root, config, workflow, { phaseId, template, agents = [] } = {}) {
  const { fail, captureRepositoryAsset, captureInstalledAgent, digestHex, posix } = internals;
  const workId = workflow.workItem.id;
  const sourcePath = template?.source === 'workflow-snapshot' ? template.sourcePath : template?.path;
  if (!sourcePath || !template?.sha256) fail(`Phase '${phaseId}' has no capturable template dependency.`, 'WFA_DEPENDENCY_UNAVAILABLE');
  const asset = await captureRepositoryAsset(root, config, workId, {
    logicalId: `template:${phaseId}`, purpose: 'phase-template', relativePath: sourcePath, expectedSha256: template.sha256
  });
  const captured = { ...template, source: 'workflow-snapshot', sourcePath: posix(sourcePath), path: asset.blob.path,
    sha256: digestHex(asset.blob.sha256, `Template '${phaseId}'`) };
  const assets = [asset];
  for (const agent of agents) assets.push(await captureInstalledAgent(root, config, workId, agent));
  return { assets, template: captured };
}

/**
 * The next accepted revision for a step added to a started task: the same closure with the step's template and new
 * agents added, and the policy with its one step inserted (task-change-contracts.mjs). Every retained asset keeps its
 * exact bytes. Writes the manifest only; the caller's Story transaction commits it with the decision and the state.
 */
export async function captureWorkflowTaskChange(internals, root, config, currentWorkflow,
  proposedWorkflow, { taskChangeDecision, addedAssets = [] } = {}) {
  const { fail, verifyWorkflowSnapshot, stableFile, installBlob, validateBlobReference, storyRelative, domainHash, manifestCore, digestHex,
    qualified, sha256, taskChangeDecisionId, QUALIFIED_SHA256, SNAPSHOT_FAMILY, SNAPSHOT_REFERENCE_FAMILY, TASK_CHANGE_DIALECT } = internals;
  const { MAXIMUM_AMENDMENT_REVISIONS, MAXIMUM_AMENDMENT_DECISION_BYTES, MAXIMUM_ASSETS, MAXIMUM_BUNDLE_BYTES } = internals.limits;
  const workId = currentWorkflow?.workItem?.id;
  if (!workId || proposedWorkflow?.workItem?.id !== workId || !taskChangeDecision?.path
      || !QUALIFIED_SHA256.test(taskChangeDecision.sha256 ?? '')) fail('A task change needs one exact Story and decision.', 'WFA_AMENDMENT_INVALID');
  const previous = await verifyWorkflowSnapshot(root, config, currentWorkflow, { requireAccepted: true, retainBytes: true });
  if (!previous.enrolled || previous.revision >= MAXIMUM_AMENDMENT_REVISIONS
      || canonicalJson(currentWorkflow.resolution) !== canonicalJson(previous.policy)) fail('A task change has no exact accepted parent closure.', 'WFA_AMENDMENT_INVALID');
  if ((previous.manifest.skillPackages ?? []).length) fail('A task change cannot be made to a Story that runs skill packages.', 'WFA_AMENDMENT_UNSUPPORTED');
  const decisionId = taskChangeDecisionId(config, workId, taskChangeDecision.path);
  const decisionFile = await secureRepositoryPath(root, taskChangeDecision.path, { label: 'Task change decision', mustExist: true, type: 'file' });
  const saved = await stableFile(decisionFile.absolute, 'Task change decision');
  if (saved.size > MAXIMUM_AMENDMENT_DECISION_BYTES || qualified(saved.sha256) !== taskChangeDecision.sha256) fail('Task change decision bytes differ from their binding.', 'WFA_AMENDMENT_INVALID');
  let decision;
  try { decision = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes)); }
  catch { fail('Task change decision is not valid JSON.', 'WFA_AMENDMENT_INVALID'); }
  if (decision.id !== decisionId) fail('Task change decision identity differs from its path.', 'WFA_AMENDMENT_INVALID');
  const revision = previous.revision + 1;
  await validateTaskChangeDecision(internals, config, workId, decision, {
    previous: { reference: currentWorkflow.workflowSnapshot, policy: previous.policy },
    next: { reference: { revision }, policy: proposedWorkflow.resolution }, decisionPath: taskChangeDecision.path });
  const manifestPath = storyRelative(config, workId, `config/wfa/snapshots/${String(revision).padStart(6, '0')}/manifest.json`);
  const target = await secureRepositoryPath(root, manifestPath, { label: 'New task change snapshot manifest' });
  if (target.exists) fail(`Workflow snapshot revision ${revision} already exists.`, 'WFA_REVISION_CONFLICT');
  const assets = structuredClone(previous.manifest.assets);
  for (const asset of assets) {
    const bytes = previous.assetBytes.get(asset.logicalId);
    if (!bytes || bytes.byteLength !== asset.blob.bytes) fail('Accepted dependency bytes are unavailable.', 'WFA_DEPENDENCY_UNAVAILABLE');
    const blob = await installBlob(root, config, workId, { bytes, size: bytes.byteLength,
      sha256: digestHex(asset.blob.sha256, asset.logicalId), mediaType: asset.blob.mediaType });
    if (canonicalJson(blob) !== canonicalJson(asset.blob)) fail('A task change changed a retained dependency.');
  }
  const retained = new Set(assets.map((asset) => asset.logicalId));
  for (const asset of addedAssets) {
    if (retained.has(asset.logicalId) || !decision.addedAssets.includes(asset.logicalId)) fail(`Task change asset '${asset.logicalId}' is not one its decision adds.`, 'WFA_AMENDMENT_INVALID');
    const { expectedPath } = validateBlobReference(config, workId, asset.blob, `Task change asset '${asset.logicalId}'`);
    const file = await secureRepositoryPath(root, expectedPath, { label: `Task change asset '${asset.logicalId}'`, mustExist: true, type: 'file' });
    const captured = await stableFile(file.absolute, `Task change asset '${asset.logicalId}'`);
    if (qualified(captured.sha256) !== asset.blob.sha256 || captured.size !== asset.blob.bytes) fail(`Task change asset '${asset.logicalId}' bytes changed.`, 'WFA_SOURCE_STALE');
    retained.add(asset.logicalId);
    assets.push(structuredClone(asset));
  }
  if (!decision.addedAssets.every((id) => retained.has(id))) fail('A task change is missing an asset its decision adds.', 'WFA_AMENDMENT_INVALID');
  assets.sort((left, right) => left.logicalId.localeCompare(right.logicalId));
  if (assets.length > MAXIMUM_ASSETS) fail('Workflow snapshot has too many assets.', 'WFA_LIMIT_REACHED');
  const policyBytes = Buffer.from(canonicalJson(proposedWorkflow.resolution));
  if (policyBytes.byteLength > MAXIMUM_BUNDLE_BYTES) fail('Changed policy exceeds its retained limit.', 'WFA_LIMIT_REACHED');
  const policyBlob = await installBlob(root, config, workId, { bytes: policyBytes,
    size: policyBytes.byteLength, sha256: sha256(policyBytes), mediaType: 'application/json; profile=singularity-flow-effective-policy-v1' });
  const totalBytes = policyBlob.bytes + assets.reduce((sum, asset) => sum + asset.blob.bytes, 0);
  if (totalBytes > MAXIMUM_BUNDLE_BYTES) fail('Changed snapshot exceeds its retained limit.', 'WFA_LIMIT_REACHED');
  const manifest = { schemaVersion: currentSchemaVersion(SNAPSHOT_FAMILY), kind: SNAPSHOT_FAMILY,
    story: structuredClone(previous.manifest.story), revision, parentSnapshotHash: currentWorkflow.workflowSnapshot.snapshotHash,
    policy: policyBlob, assets, executionDependencies: structuredClone(previous.manifest.executionDependencies),
    skillPackages: [],
    amendment: { schemaVersion: currentSchemaVersion('workflow-snapshot-amendment'), decisionPath: taskChangeDecision.path, decisionSha256: taskChangeDecision.sha256 },
    provenance: structuredClone(previous.manifest.provenance),
    semantics: { ...structuredClone(previous.manifest.semantics), snapshot: 'wfa-snapshot-v3', amendment: TASK_CHANGE_DIALECT },
    configFoldHash: domainHash('wfa.fold.v1', proposedWorkflow.resolution), createdAt: decision.approvedAt,
    limits: { assets: assets.length, bytes: totalBytes }, snapshotHash: null };
  manifest.snapshotHash = domainHash('wfa.snapshot.v3', manifestCore(manifest));
  await mkdir(path.dirname(target.absolute), { recursive: true });
  await writeJson(target.absolute, manifest);
  const reference = { enrollment: 'wfa', schemaVersion: currentSchemaVersion(SNAPSHOT_REFERENCE_FAMILY), revision,
    snapshotHash: manifest.snapshotHash, manifestPath, genesisSnapshotHash: currentWorkflow.workflowSnapshot.genesisSnapshotHash };
  return reference;
}

/**
 * Replay of one accepted task change [ITW:REQ-009]: its parent is the exact preceding accepted authority, the policy is
 * that parent's with exactly the recorded step added after the step that was current, the Story's done and current
 * steps are unchanged and the added one has not started, the commit changes no application source, and the Story
 * keeps the change's exact append-only summary.
 */
export async function validateAcceptedTaskChangeEvidence({ fail, readCommittedJson }, root, config, workId, {
  workflow, workflowRelative, previousReference, previousCommit, acceptanceCommit, decision, decisionPath, decisionSha256
}) {
  const { addsStep, assertTaskChangeScope, relabeledStep, stableTaskStepState, taskChangeSummary, validateTaskChangeDecisionRecord } = await import('./task-change-contracts.mjs');
  validateTaskChangeDecisionRecord(decision);
  const parent = readCommittedJson(root, `${acceptanceCommit}^1`, workflowRelative,
    'Story immediately before its task change').record;
  const acceptedParent = readCommittedJson(root, previousCommit, workflowRelative,
    'Story at the accepted authority before its task change').record;
  if (canonicalJson(parent.workflowSnapshot) !== canonicalJson(previousReference)
      || canonicalJson(parent.resolution) !== canonicalJson(acceptedParent.resolution)) fail('A task change did not keep its immediately preceding snapshot authority.', 'WFA_AMENDMENT_INVALID');
  assertTaskChangeScope(parent.resolution, workflow.resolution, decision);
  // The kept steps as every reader sees them, so defaults the reader fills in are no change.
  const { normalizeCurrentWorkflow } = await import('./story-state-normalization.mjs');
  const steps = (record) => { try { return normalizeCurrentWorkflow(structuredClone(record)).phases; } catch { return null; } };
  const [parentSteps, changedSteps] = [steps(parent), steps(workflow)];
  if (!parentSteps || !changedSteps) fail('A task change\'s Story records cannot be read.', 'WFA_AMENDMENT_INVALID');
  // A kind change that keeps the steps keeps every step's state too, but the label it gives the step it keeps [ITW:REQ-015].
  const position = addsStep(decision) ? decision.position : workflow.resolution.phases.length;
  const order = workflow.resolution.phases.map((phase) => phase.id);
  const kept = (id) => { const state = stableTaskStepState(parentSteps[id]); const now = canonicalJson(stableTaskStepState(changedSteps[id]));
    return canonicalJson(state) === now || canonicalJson(relabeledStep(state, decision)) === now; };
  if (decision.workId !== workId || parent.currentPhase !== decision.afterPhase || workflow.currentPhase !== parent.currentPhase
      || parent.status !== 'in_progress' || canonicalJson(workflow.phaseOrder) !== canonicalJson(order)
      || canonicalJson(parent.phaseOrder.slice(0, position)) !== canonicalJson(order.slice(0, position))
      || parent.phaseOrder.slice(0, position).some((id) => !kept(id))
      || (addsStep(decision) && workflow.phases[decision.step.id]?.status !== 'not_started')) fail('A task change changed a done or current step, or started the one it added.', 'WFA_AMENDMENT_INVALID');
  const { applicationPathContext, isApplicationChangeEntry } = await import('./application-paths.mjs');
  const { buildRepositoryTreeChangeSet } = await import('./repository-change-set.mjs');
  const changes = buildRepositoryTreeChangeSet(root, { baseTree: `${acceptanceCommit}^1`, targetTree: acceptanceCommit,
    env: { ...withoutGitProcessOverrides(), GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' } });
  if (changes.entries.some((entry) => isApplicationChangeEntry(entry, applicationPathContext(config, workflow)))) fail('A task change changed application source bytes.', 'WFA_AMENDMENT_INVALID');
  const expected = taskChangeSummary(decision, { decisionPath, decisionSha256 });
  const matches = (workflow.taskChanges ?? []).filter((entry) => entry.id === decision.id);
  if (matches.length !== 1 || canonicalJson(matches[0]) !== canonicalJson(expected)
      || (parent.taskChanges ?? []).some((entry) => entry.id === decision.id)) fail('A task change\'s acceptance does not keep its exact append-only summary.', 'WFA_AMENDMENT_INVALID');
}

