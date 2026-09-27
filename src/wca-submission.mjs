/** An exact terminal-reviewed candidate goes to the existing proposal owner, never active config. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { workflowDraftPackageProposalFiles, revalidateWorkflowDraftPackage,
  workflowDraftSkillSubmissionReview, finalizeWorkflowDraftSkillProposal,
  revalidateFinalizedWorkflowDraftSkillProposal } from './wca-compiler.mjs';
import { consumeActionAuthorization } from './action-authorization.mjs';
import { proposeConfigurationChange } from './configuration-proposal.mjs';
import { isConfigurationReadPath } from './configuration-read-scope.mjs';
import { configurationAssetPolicy, DEFAULT_CONFIGURATION_ASSET_POLICY } from './configuration-assets.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';
import { validateWorkflowSkillFinalizationRecord } from './wca-skp-finalization.mjs';
import { validateDefinition, resolveWorkType } from './config.mjs';
import { simulateResolvedWorkflowLifecycle } from './workflow-lifecycle-simulation.mjs';

const FAMILY = 'workflow-authoring-submission-snapshot';
const SKILL_FAMILY = 'workflow-authoring-skill-submission-snapshot';
const SKILL_REPLACEMENT_FAMILY = 'workflow-authoring-skill-replacement-submission-snapshot';
const SKILL_GROUP_REPLACEMENT_FAMILY = 'workflow-authoring-skill-group-replacement-submission-snapshot';
const LIMIT = 16 * 1024 * 1024;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const digest = (value) => `sha256:${recordSha256(value)}`;
const bytesDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fail(message, code = 'WCA_SUBMISSION_INVALID') { throw new SingularityFlowError(message, { code }); }
function retainedAssetPolicy(policy) {
  if (!policy || Object.keys(policy).sort().join('\0') !== 'files\0roots\0runtimeRoots') {
    fail('The retained approved asset policy is invalid.');
  }
  for (const field of ['roots', 'files', 'runtimeRoots']) {
    const values = policy[field];
    if (!Array.isArray(values) || values.length > 128 || values.some((value) => typeof value !== 'string')
        || canonicalJson([...new Set(values)].sort()) !== canonicalJson(values)) fail('The retained asset policy is not canonical.');
    for (const value of values) {
      // The same closed path parser validates custom roots; a retained policy is evidence,
      // never permission to execute or a substitute for freshly approved writer capture.
      try { configurationAssetPolicy(field === 'files' ? { worldModel: { promptSource: value } }
        : field === 'runtimeRoots' ? { workItemRoot: value } : { templatesRoot: value }); }
      catch { fail('The retained asset policy contains an unsafe path.'); }
    }
  }
  if (DEFAULT_CONFIGURATION_ASSET_POLICY.runtimeRoots.some((root) => !policy.runtimeRoots.includes(root))) {
    fail('The retained policy cannot remove framework runtime exclusions.');
  }
  return policy;
}
function planCore(preview, files, inputs) {
  return { schemaVersion: 1, kind: 'workflow-authoring-submission-plan',
    subject: { kind: 'workflow-draft', id: preview.source.draftId, repository: preview.source.repository },
    selection: { draft: preview.source.revision, lifecycleEpoch: preview.source.lifecycleEpoch,
      revisionSha256: preview.source.revisionSha256, head: preview.source.head, approvedSource: preview.approvedSource },
    revision: digest({ source: preview.source, approvedSource: preview.approvedSource }),
    effect: 'create-configuration-review-proposal',
    candidate: { source: preview.source, approvedSource: preview.approvedSource,
      planSha256: preview.planSha256, files, inputs },
    publication: 'review-required', approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
}

/** Compiler branding is required here; a JSON review card is not a candidate-file capability. */
export function workflowDraftSubmissionPlan(preview) {
  if (preview?.skillFinalization?.status === 'requires-exact-terminal-consent') {
    return workflowDraftSkillSubmissionReview(preview);
  }
  const captured = workflowDraftPackageProposalFiles(preview);
  const immutable = { source: preview.source, approvedSource: preview.approvedSource,
    planSha256: preview.planSha256, files: captured.files, inputs: captured.snapshotInputs ?? null };
  if (Buffer.byteLength(canonicalJson({ preview, immutable })) > LIMIT) {
    fail('The immutable review snapshot exceeds its 16 MiB budget.', 'WCA_SUBMISSION_LIMIT');
  }
  const core = planCore(preview, captured.files, captured.snapshotInputs);
  const planHash = recordSha256(core);
  const plan = { ...core, planId: planHash.slice(0, 24), planHash };
  const action = { actionId: `workflow-submit-${planHash.slice(0, 24)}`,
    label: 'Create review proposal', effect: 'create-configuration-review-proposal',
    confirmation: { required: true, mode: 'one-time-authorization' } };
  return { plan, action };
}

function snapshot(captured, review, authorization) {
  const core = { schemaVersion: currentSchemaVersion(FAMILY), kind: FAMILY,
    snapshotId: review.plan.planHash, sourceDraft: captured.preview.source,
    approvedSource: captured.preview.approvedSource, planSha256: captured.preview.planSha256,
    actionPlanSha256: `sha256:${review.plan.planHash}`,
    candidateTreeSha256: captured.preview.candidateAssetManifestSha256,
    inputs: captured.snapshotInputs, preview: captured.preview, files: captured.files,
    operationRef: { owner: 'configuration-proposal', operation: 'author',
      subject: review.plan.planHash.slice(0, 24) },
    confirmation: { authorizationId: authorization.authorizationId,
      questionId: authorization.questionId, channel: authorization.channel,
      assurance: authorization.assurance, actor: authorization.actor,
      authenticatedNativeHost: false }, approval: 'not-granted', activation: 'inactive' };
  if (!core.inputs) fail('The compiler did not retain the complete submission input closure.');
  return { ...core, snapshotSha256: digest(core) };
}

/** Inspect retained evidence; it cannot be interpreted as an approval or live execution grant. */
export function validateWorkflowDraftSubmissionSnapshot(value) {
  if ([SKILL_FAMILY, SKILL_REPLACEMENT_FAMILY, SKILL_GROUP_REPLACEMENT_FAMILY].includes(value?.kind)) return validateWorkflowDraftSkillSubmissionSnapshot(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== ['schemaVersion', 'kind', 'snapshotId', 'sourceDraft',
        'approvedSource', 'planSha256', 'actionPlanSha256', 'candidateTreeSha256', 'inputs', 'preview',
        'files', 'operationRef', 'confirmation', 'approval', 'activation', 'snapshotSha256'].sort().join('\0')
      || Buffer.byteLength(canonicalJson(value)) > LIMIT
      || readRecord(FAMILY, value).storedVersion !== 1 || value.kind !== FAMILY
      || !SHA.test(value.snapshotSha256 ?? '') || !SHA.test(value.planSha256 ?? '')
      || !SHA.test(value.actionPlanSha256 ?? '') || !Array.isArray(value.files)
      || !value.inputs || !value.preview || !Array.isArray(value.preview.assets)
      || !Array.isArray(value.inputs.assets) || value.approval !== 'not-granted'
      || value.activation !== 'inactive') fail('The retained submission snapshot is invalid.');
  const assetPolicy = retainedAssetPolicy(value.preview.approvedAssetPolicy);
  if (Object.keys(value.inputs).sort().join('\0') !== 'assets\0request'
      || !value.inputs.request || typeof value.inputs.request !== 'object'
      || Array.isArray(value.inputs.request)) fail('The retained input closure is invalid.');
  const { snapshotSha256, ...core } = value;
  const { planSha256: previewHash, ...previewCore } = value.preview;
  if (digest(core) !== snapshotSha256
      || digest(previewCore) !== previewHash
      || value.planSha256 !== value.preview.planSha256
      || canonicalJson(value.sourceDraft) !== canonicalJson(value.preview.source)
      || canonicalJson(value.approvedSource) !== canonicalJson(value.preview.approvedSource)
      || value.candidateTreeSha256 !== value.preview.candidateAssetManifestSha256
      || digest(value.inputs.request) !== value.preview.requestSha256
      || digest(value.inputs.request) !== value.sourceDraft.payloadSha256
      || value.actionPlanSha256 !== digest(planCore(value.preview, value.files, value.inputs))
      || value.snapshotId !== value.actionPlanSha256.slice(7)
      || canonicalJson(value.operationRef) !== canonicalJson({ owner: 'configuration-proposal',
        operation: 'author', subject: value.snapshotId.slice(0, 24) })
      || value.confirmation?.authenticatedNativeHost !== false) {
    fail('The retained submission snapshot failed its exact-input bindings.');
  }
  if (value.files.length !== value.preview.assets.length || value.files.length > 256
      || value.inputs.assets.length > 64) fail('The retained submission closure is incomplete.');
  for (const [index, file] of value.files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).sort().join('\0') !== 'bytes\0contentBase64\0mode\0path\0sha256'
        || typeof file.contentBase64 !== 'string' || typeof file.path !== 'string'
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !SHA.test(file.sha256 ?? '')) {
      fail('A retained candidate file is malformed.');
    }
    const bytes = Buffer.from(file.contentBase64, 'base64');
    const asset = value.preview.assets[index];
    if (!asset || typeof asset !== 'object' || typeof asset.content !== 'string') fail('A retained preview asset is malformed.');
    if (file.mode !== '100644' || bytes.length !== file.bytes || bytesDigest(bytes) !== file.sha256
        || bytes.toString('base64') !== file.contentBase64 || !isConfigurationReadPath(file.path, assetPolicy)
        || path.posix.normalize(file.path) !== file.path || file.path.includes('\\')
        || canonicalJson({ path: file.path, bytes: file.bytes, sha256: file.sha256 }) !== canonicalJson({
          path: asset.path, bytes: asset.bytes, sha256: asset.sha256 })
        || bytes.toString('utf8') !== asset.content) {
      fail('The retained submission file closure is invalid.');
    }
  }
  if (digest(value.files.map(({ path: file, bytes, sha256 }) => ({ path: file, bytes, sha256 })))
      !== value.candidateTreeSha256) fail('The candidate manifest is inconsistent.');
  const inputAssets = value.inputs.assets.map((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
        || Object.keys(asset).sort().join('\0') !== 'bytes\0contentBase64\0path\0sha256'
        || typeof asset.contentBase64 !== 'string' || typeof asset.path !== 'string'
        || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || !SHA.test(asset.sha256 ?? '')) {
      fail('A retained input asset is malformed.');
    }
    const bytes = Buffer.from(asset.contentBase64, 'base64');
    if (bytes.length !== asset.bytes || bytesDigest(bytes) !== asset.sha256
        || bytes.toString('base64') !== asset.contentBase64) fail('A retained input asset is inconsistent.');
    return { path: asset.path, sha256: asset.sha256, bytes: asset.bytes };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifestCore = { schemaVersion: 1, kind: 'workflow-authoring-asset-manifest', assets: inputAssets };
  if (digest({ ...manifestCore, assetManifestSha256: digest(manifestCore) }) !== value.sourceDraft.assetManifestSha256) {
    fail('The retained input asset manifest differs from the saved revision.');
  }
  return value;
}

function skillSnapshot(captured, pendingPreview) {
  const record = captured.preview.skillFinalization?.record;
  if (!record) fail('The compiler did not retain exact terminal-consumed finalization.');
  const family = record.kind === 'workflow-authoring-skp-group-replacement-finalization' ? SKILL_GROUP_REPLACEMENT_FAMILY
    : record.kind === 'workflow-authoring-skp-replacement-finalization' ? SKILL_REPLACEMENT_FAMILY : SKILL_FAMILY;
  const core = { schemaVersion: currentSchemaVersion(family), kind: family,
    snapshotId: record.finalizationSha256.slice(7), sourceDraft: captured.preview.source,
    approvedSource: captured.preview.approvedSource, preConsentPreview: pendingPreview,
    preview: captured.preview, inputs: captured.snapshotInputs, files: captured.files,
    confirmation: record.confirmation, finalizationSha256: record.finalizationSha256,
    operationRef: { owner: 'configuration-proposal', operation: 'author', subject: record.finalizationSha256.slice(7, 31) },
    approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
  return { ...core, snapshotSha256: digest(core) };
}

/** A retained local-review record proves consistency, never fresh consent or host enforcement. */
export function validateWorkflowDraftSkillSubmissionSnapshot(value) {
  const family = value?.kind === SKILL_GROUP_REPLACEMENT_FAMILY ? SKILL_GROUP_REPLACEMENT_FAMILY
    : value?.kind === SKILL_REPLACEMENT_FAMILY ? SKILL_REPLACEMENT_FAMILY : SKILL_FAMILY;
  const fields = ['schemaVersion', 'kind', 'snapshotId', 'sourceDraft', 'approvedSource', 'preConsentPreview',
    'preview', 'inputs', 'files', 'confirmation', 'finalizationSha256', 'operationRef', 'approval', 'activation', 'execution', 'snapshotSha256'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== fields.sort().join('\0')
      || readRecord(family, value).storedVersion !== 1
      || value.kind !== family || Buffer.byteLength(canonicalJson(value)) > LIMIT
      || !SHA.test(value.snapshotSha256 ?? '') || !SHA.test(value.finalizationSha256 ?? '')
      || value.approval !== 'not-granted' || value.activation !== 'inactive' || value.execution !== 'not-started') fail('The retained skill submission is invalid.');
  const { snapshotSha256, ...core } = value;
  const pending = value.preConsentPreview; const preview = value.preview;
  if (!pending || !preview || !value.inputs || !Array.isArray(value.files) || value.files.length > 256
      || !Array.isArray(preview.assets) || preview.assets.length > 256
      || !Array.isArray(value.inputs.assets) || value.inputs.assets.length > 64
      || Object.keys(value.inputs).sort().join('\0') !== 'assets\0request') fail('The retained skill input closure is incomplete.');
  const { planSha256: pendingHash, ...pendingCore } = pending;
  const { planSha256: previewHash, ...previewCore } = preview;
  const subject = preview.skillFinalization?.subject; const finalization = preview.skillFinalization?.record;
  if ((family === SKILL_REPLACEMENT_FAMILY) !== (subject?.kind === 'workflow-authoring-skp-replacement-preconsent-subject')
      || (family === SKILL_GROUP_REPLACEMENT_FAMILY)
        !== (subject?.kind === 'workflow-authoring-skp-group-replacement-preconsent-subject')) {
    fail('The retained snapshot cannot downgrade or substitute its replacement dialect.');
  }
  if (family === SKILL_FAMILY && (value.inputs.request?.intent !== 'create'
      || pending.sharedObjectChanges !== undefined || preview.sharedObjectChanges !== undefined)) {
    fail('An ordinary skill submission cannot retain a shared replacement request or its reverse impact.');
  }
  const review = pending.skillFinalization?.review;
  if (digest(core) !== snapshotSha256 || digest(pendingCore) !== pendingHash || digest(previewCore) !== previewHash
      || preview.skillFinalization?.status !== 'finalized-inactive-proposal'
      || pending.skillFinalization?.status !== 'requires-exact-terminal-consent'
      || canonicalJson(subject) !== canonicalJson(pending.skillFinalization.subject)
      || canonicalJson(value.sourceDraft) !== canonicalJson(preview.source)
      || canonicalJson(value.sourceDraft) !== canonicalJson(pending.source)
      || canonicalJson(value.approvedSource) !== canonicalJson(preview.approvedSource)
      || canonicalJson(value.approvedSource) !== canonicalJson(pending.approvedSource)
      || digest(value.inputs.request) !== value.sourceDraft.payloadSha256
      || digest(value.inputs.request) !== pending.requestSha256 || pending.requestSha256 !== preview.requestSha256
      || digest(value.inputs) !== subject?.retainedInputsSha256
      || value.finalizationSha256 !== finalization?.finalizationSha256
      || canonicalJson(value.confirmation) !== canonicalJson(finalization?.confirmation)
      || value.confirmation?.actionPlanSha256 !== `sha256:${review?.plan?.planHash}`
      || value.snapshotId !== value.finalizationSha256.slice(7)
      || canonicalJson(value.operationRef) !== canonicalJson({ owner: 'configuration-proposal', operation: 'author', subject: value.snapshotId.slice(0, 24) })) fail('The retained skill submission failed its subject, source or consent bindings.');
  const { planHash: reviewHash, planId: reviewId, ...reviewCore } = review.plan;
  if (recordSha256(reviewCore) !== reviewHash || reviewId !== `wca-skp-${reviewHash.slice(0, 24)}`
      || canonicalJson(reviewCore.subject) !== canonicalJson(subject)) fail('The retained skill review card is inconsistent.');
  const assetPolicy = retainedAssetPolicy(preview.approvedAssetPolicy);
  for (const file of value.files) if (!isConfigurationReadPath(file.path, assetPolicy)) fail('A retained skill file is outside the approved asset scope.');
  validateWorkflowSkillFinalizationRecord({ subject, record: finalization, definition: preview.candidateDefinition, files: value.files, retainedInputs: value.inputs });
  if ([SKILL_REPLACEMENT_FAMILY, SKILL_GROUP_REPLACEMENT_FAMILY].includes(family)) {
    const impact = pending.sharedObjectChanges;
    const replacement = family === SKILL_GROUP_REPLACEMENT_FAMILY ? subject.replacementGroup : subject.replacement;
    const workflows = replacement.affectedWorkflowIds;
    if (replacement.consumerImpactSha256 !== digest(impact)
        || canonicalJson(impact) !== canonicalJson(preview.sharedObjectChanges)
        || canonicalJson(workflows) !== canonicalJson(impact.impact.affectedWorkflows.map((workflow) => workflow.id))
        || preview.simulation?.status !== 'complete-for-profile' || preview.simulation.workflows?.length !== workflows.length) {
      fail('The replacement omitted or substituted its reviewed transitive consumer impact or simulation closure.');
    }
    const normalized = validateDefinition(structuredClone(preview.candidateDefinition));
    const simulations = workflows.map((workflowId) => simulateResolvedWorkflowLifecycle(resolveWorkType(normalized, workflowId)));
    if (simulations.some((report) => report.status !== 'complete-for-profile')
        || canonicalJson(simulations) !== canonicalJson(preview.simulation.workflows)) fail('The replacement simulations differ from its exact confirmed prospective definition.');
  }
  if (value.files.length !== preview.assets.length || value.files.some((file, index) => {
    const asset = preview.assets[index];
    return !asset || file.path !== asset.path || file.bytes !== asset.bytes || file.sha256 !== asset.sha256
      || Buffer.from(file.contentBase64, 'base64').toString('utf8') !== asset.content;
  }) || digest(value.files.map(({ path: file, bytes, sha256 }) => ({ path: file, bytes, sha256 }))) !== preview.candidateAssetManifestSha256) fail('The retained skill emitted closure differs from its preview.');
  const assets = value.inputs.assets.map((asset) => {
    if (!asset || Object.keys(asset).sort().join('\0') !== 'bytes\0contentBase64\0path\0sha256'
        || typeof asset.contentBase64 !== 'string') fail('A retained skill input asset is malformed.');
    const bytes = Buffer.from(asset.contentBase64, 'base64');
    if (bytes.length !== asset.bytes || bytesDigest(bytes) !== asset.sha256 || bytes.toString('base64') !== asset.contentBase64) fail('A retained skill input asset changed.');
    return { path: asset.path, bytes: asset.bytes, sha256: asset.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { schemaVersion: 1, kind: 'workflow-authoring-asset-manifest', assets };
  if (digest({ ...manifest, assetManifestSha256: digest(manifest) }) !== value.sourceDraft.assetManifestSha256) fail('The retained skill attachment closure changed.');
  return value;
}

async function writeCandidateFile(root, relative, bytes, assetPolicy) {
  if (!isConfigurationReadPath(relative, assetPolicy) || path.posix.normalize(relative) !== relative
      || relative.includes('\\') || relative.startsWith('/') || relative.split('/').includes('..')) {
    fail('The reviewed candidate attempted an unsupported output path.');
  }
  const parts = relative.split('/'); let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    await mkdir(parent, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('A candidate output parent is not an ordinary directory.');
  }
  const file = path.join(root, relative);
  const before = await lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (before && (!before.isFile() || before.isSymbolicLink())) fail('A candidate output is not an ordinary file.');
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (before && (before.dev !== info.dev || before.ino !== info.ino))) {
      fail('A candidate output changed during capture.');
    }
    await handle.truncate(0); await handle.writeFile(bytes); await handle.chmod(0o644); await handle.sync();
  } finally { await handle.close(); }
  if (bytesDigest(await readFile(file)) !== bytesDigest(bytes)) fail('Candidate output bytes changed before staging.');
}

/** Only called after live exact terminal presentation; public issuer/JSON tokens alone fail. */
export async function createWorkflowDraftReviewProposal(root, options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).some((key) => !['draftId', 'revision', 'expectedPlanSha256', 'confirmation'].includes(key))
      || typeof options.draftId !== 'string' || !Number.isSafeInteger(options.revision)
      || typeof options.expectedPlanSha256 !== 'string' || !SHA.test(options.expectedPlanSha256)
      || typeof options.confirmation !== 'string') fail('Review one exact saved draft before submission.');
  const request = Object.freeze({ ...options });
  const selection = { draftId: request.draftId, revision: request.revision,
    expectedPlanSha256: request.expectedPlanSha256 };
  const pendingPreview = await revalidateWorkflowDraftPackage(root, selection);
  const skill = pendingPreview.skillFinalization?.status === 'requires-exact-terminal-consent';
  const review = workflowDraftSubmissionPlan(pendingPreview);
  const captured = skill ? await finalizeWorkflowDraftSkillProposal(root, request)
    : workflowDraftPackageProposalFiles(pendingPreview);
  const authorization = skill ? null : await consumeActionAuthorization(root, request.confirmation, review.plan,
    review.action, { requireTerminalPresentation: true });
  const retained = validateWorkflowDraftSubmissionSnapshot(skill ? skillSnapshot(captured, pendingPreview) : snapshot(captured, review, authorization));
  const subjectId = skill ? retained.snapshotId.slice(0, 24) : review.plan.planHash.slice(0, 24);
  const retainedPath = skill ? `singularity/${retained.kind === SKILL_GROUP_REPLACEMENT_FAMILY
    ? 'workflow-authoring-skill-group-replacements' : retained.kind === SKILL_REPLACEMENT_FAMILY
      ? 'workflow-authoring-skill-replacements' : 'workflow-authoring-skill-submissions'}/${retained.snapshotId}.json`
    : `singularity/workflow-authoring-submissions/${review.plan.planHash}.json`;
  // The proposal owner freshly verifies the exact pre-change authority again and handles push
  // recovery. Any changed draft/catalog/base invalidates the reviewed card before candidate I/O.
  return proposeConfigurationChange(root, { operation: 'author',
    subject: subjectId, expectedAuthority: captured.expectedAuthority,
    message: `Propose workflow package ${captured.preview.source.draftId} revision ${request.revision}`,
    verifyStaged: ({ verifyFiles }) => verifyFiles([...captured.files, {
      path: retainedPath, mode: '100644', bytes: Buffer.byteLength(canonicalJson(retained)),
      sha256: bytesDigest(Buffer.from(canonicalJson(retained)))
    }]),
    mutate: async (scratch) => {
      const current = skill ? await revalidateFinalizedWorkflowDraftSkillProposal(root, captured.preview)
        : workflowDraftPackageProposalFiles(await revalidateWorkflowDraftPackage(root, selection));
      if (current.preview.planSha256 !== captured.preview.planSha256) {
        fail('The exact submission plan changed; review the newer package.', 'WCA_PREVIEW_STALE');
      }
      for (const file of current.files) await writeCandidateFile(scratch, file.path,
        Buffer.from(file.contentBase64, 'base64'), current.assetPolicy);
      await writeCandidateFile(scratch, retainedPath, Buffer.from(canonicalJson(retained)), current.assetPolicy);
      return { resultType: 'workflow-authoring-submission', status: 'proposed',
        sourceDraft: retained.sourceDraft, snapshotPath: retainedPath,
        snapshotSha256: retained.snapshotSha256, planSha256: current.preview.planSha256,
        reviewedFiles: current.files.map(({ path: file, mode, bytes, sha256 }) => ({ path: file, mode, bytes, sha256 })),
        approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
    }
  });
}
