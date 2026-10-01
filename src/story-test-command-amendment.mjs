/** Governed command-only migration for the current, nonterminal code-delivery phase. */
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireApprovalAuthority } from './approval-authority.mjs';
import { applyCapabilityPolicyToWorkResolution, capabilityWorldModelGrounding } from './capability-context.mjs';
import { captureTerminalActionAuthorization } from './action-authorization.mjs';
import { approvedStoryApprovalAuthorities, resolveApprovedStoryWorkType } from './configuration-branch.mjs';
import { isTestQualityCommand, phaseRequiresCodeDelivery } from './delivery-evidence.mjs';
import { normalizeRequiredTestCommand } from './code-delivery-tests.mjs';
import { exactFileAtObject, head, identity } from './git.mjs';
import { publishedGenerationCommit, verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { canonicalJson } from './records.mjs';
import { buildRepositoryChangeSet } from './repository-change-set.mjs';
import { captureSkillConfigurationAncestry } from './skp-amendment-audit.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { assertTestCommandRunnerRepairScope, publishedTestCommandRevalidation, testCommandRevalidationRequirement } from './test-command-amendment-contracts.mjs';
import { trpSelectionPublicPreview } from './trp-delivery-selection.mjs';
import { applicationPathContext, ensureWorkIntervalBaseline, isApplicationChangeEntry, verifyWorkIntervalBaseline } from './work-intervals.mjs';
import { verifyWorkflowSnapshot } from './workflow-snapshots.mjs';
import { nowIso, secureRepositoryPath, SingularityFlowError, writeText } from './util.mjs';

const PROSPECTIVE = new WeakMap();
const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const bytesDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = (message, code = 'TCA_AMENDMENT_UNSUPPORTED') => { throw new SingularityFlowError(message, { code }); };
const actorKey = actor => String(actor?.email || actor?.login || '').trim().toLowerCase();
const identityKeys = actor => [['email', actor?.email], ['login', actor?.login]]
  .filter(([, value]) => String(value ?? '').trim()).map(([kind, value]) => `${kind}:${String(value).trim().toLowerCase()}`);
const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const workRelative = (config, workflow) => path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
const recordPath = (config, workflow, id, suffix) => `${workRelative(config, workflow)}/context/test-recovery/command-amendments/${id}-${suffix}.json`;
const policyDigest = resolution => { const value = structuredClone(resolution); delete value.policySha256; return digest(value); };

/** Only the locked application owner may supply a prospective policy to ordinary validation. */
export function prospectiveTestCommandAmendment(workflow) { return PROSPECTIVE.get(workflow) ?? null; }

function reviewPolicy(policy) {
  if (policy?.mode !== 'required' || policy.minimum !== 1
    || !Array.isArray(policy.authorities) || !policy.authorities.length
    || (policy.requiredAuthorities?.length ?? 0) > 1) {
    fail('This bounded amendment requires an explicit single-human approval in both the original Story and approved candidate configuration.', 'TCA_AMENDMENT_AUTHORITY_UNSUPPORTED');
  }
  return { ...policy, authorities: policy.requiredAuthorities?.length ? policy.requiredAuthorities : policy.authorities };
}

/** Replace test commands only; retain the whole remaining Story policy, including safety. */
export function testCommandAmendmentPolicy(workflow, candidateResolution, candidateAuthorities) {
  if (!same(candidateResolution.phases?.map(phase => phase.id), workflow.phaseOrder)) {
    fail('The approved candidate changes phase topology; a test-command amendment cannot adopt it.');
  }
  const phaseId = workflow.currentPhase;
  const original = workflow.resolution.phases.find(phase => phase.id === phaseId);
  const candidate = candidateResolution.phases.find(phase => phase.id === phaseId);
  if (!original || !candidate || original.kind !== candidate.kind
    || !same(original.approval, candidate.approval)
    || !same(workflow.resolution.approvalAuthorities, candidateAuthorities)) {
    fail('The bounded runner amendment cannot change phase identity or its original and candidate approval authorities.', 'TCA_AMENDMENT_AUTHORITY_CHANGED');
  }
  // Compare source-resolved global policy too, not just the portion we would copy.
  // Creation captures a few capability-tightened projections; reproduce those
  // transformations without treating Story-specific provenance as source policy.
  const candidateGlobals = structuredClone(candidateResolution);
  const retained = workflow.resolution;
  const capability = retained.capability;
  if (Object.hasOwn(candidateGlobals, 'worldModelGrounding')) candidateGlobals.worldModelGrounding = candidateGlobals.intelligence?.worldModel === 'off'
    ? 'off' : capabilityWorldModelGrounding(candidateGlobals.worldModelGrounding, capability);
  if (Object.hasOwn(candidateGlobals, 'worldModelStaleness')) candidateGlobals.worldModelStaleness ??= retained.worldModelPolicy?.staleness ?? 'warn';
  if (capability?.policy?.maxDocumentBytes && candidateGlobals.documents) {
    candidateGlobals.documents.maxFileBytes = Math.min(candidateGlobals.documents.maxFileBytes
      ?? capability.policy.maxDocumentBytes, capability.policy.maxDocumentBytes);
  }
  const globalKeys = new Set([...Object.keys(candidateGlobals).filter(key => Object.hasOwn(retained, key)),
    'testRecovery', 'reworkLoops', 'decisions']);
  globalKeys.delete('phases');
  const globalChanges = [...globalKeys].filter(key => !same(retained[key] ?? null, candidateGlobals[key] ?? null));
  if ((retained.workType != null && candidateGlobals.id !== retained.workType)
    || (retained.workTypeLabel != null && candidateGlobals.label !== retained.workTypeLabel)) globalChanges.push('workType');
  if (globalChanges.length) fail(`The approved candidate changes global policy outside the test commands (${globalChanges.join(', ')}); publish a command-only configuration revision.`);
  const oldCommands = original.qualityCommands ?? [];
  const newCommands = candidate.qualityCommands ?? [];
  const oldTests = oldCommands.filter(isTestQualityCommand);
  const explicitAddition = !oldTests.length && phaseRequiresCodeDelivery(original)
    && oldCommands.every(command => command && typeof command === 'object' && !Array.isArray(command)
      && Array.isArray(command.argv) && command.argv.length
      && command.argv.every(part => typeof part === 'string' && part.length));
  if ((!oldTests.length && !explicitAddition) || oldTests.some(command => !command || typeof command !== 'object'
    || Array.isArray(command) || command.kind !== 'test' || !Array.isArray(command.argv) || !command.argv.length)) {
    fail('This bounded amendment repairs structured tests or adds the missing explicit test contract to an existing code phase; conversion of legacy inferred runners is not supported.');
  }
  if (!same(oldCommands.filter(command => !isTestQualityCommand(command)), newCommands.filter(command => !isTestQualityCommand(command)))) {
    fail('A test-command amendment cannot add, remove, or change non-test quality commands.');
  }
  const withoutSelectedTests = phases => phases.map(phase => {
    const value = structuredClone(phase);
    // Captured dependency bytes are retained from the original WFA closure, not
    // re-resolved from today's approved template catalog by this runner dialect.
    delete value.templateSnapshot;
    if (value.id === phaseId) value.qualityCommands = value.qualityCommands.filter(command => !isTestQualityCommand(command));
    return value;
  });
  if (!same(withoutSelectedTests(workflow.resolution.phases), withoutSelectedTests(candidateResolution.phases))) {
    const differences = workflow.resolution.phases.flatMap((phase, index) => [...new Set([...Object.keys(phase), ...Object.keys(candidateResolution.phases[index])])]
      .filter(key => !['qualityCommands', 'templateSnapshot'].includes(key) && !same(phase[key], candidateResolution.phases[index][key])).map(key => `${phase.id}.${key}`));
    fail(`The approved candidate changes phase policy outside the selected test commands (${differences.join(', ')}); publish a command-only configuration revision.`);
  }
  const tests = newCommands.filter(isTestQualityCommand);
  if (!tests.length) fail('The candidate must retain at least one structured required test command.');
  const ids = new Set();
  for (const command of tests) {
    const normalized = normalizeRequiredTestCommand(command);
    if (ids.has(normalized.id)) fail('Candidate test command IDs must be unambiguous.');
    ids.add(normalized.id);
  }
  try { assertTestCommandRunnerRepairScope(oldCommands, newCommands); }
  catch (error) {
    if (error?.code !== 'WFA_AMENDMENT_INVALID') throw error;
    fail(error.message);
  }
  if (same(oldCommands, newCommands)) fail('The candidate does not change the pinned test command.', 'TCA_AMENDMENT_NO_CHANGE');
  reviewPolicy(original.approval); reviewPolicy(candidate.approval);
  const proposed = structuredClone(workflow.resolution);
  proposed.phases.find(phase => phase.id === phaseId).qualityCommands = structuredClone(newCommands);
  return { proposed, original, candidate, oldCommands, newCommands };
}

async function boundedFile(root, relative, label) {
  const safe = await secureRepositoryPath(root, relative, { label, mustExist: true, type: 'file' });
  if (safe.entry.size > 16 * 1024 * 1024) fail(`${label} exceeds the bounded review size.`, 'TCA_AMENDMENT_INPUT_INVALID');
  return readFile(safe.absolute);
}

async function candidateFor(root, config, workflow, { approvedConfigurationSnapshot, reason, phaseId = null } = {}) {
  const { generationResultMatches, sourceTreeHash, storyPublicationPending } = await import('./state.mjs');
  if (await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false })) {
    fail('Recover the exact pending Story publication before amending its runner.', 'TCA_PUBLICATION_PENDING');
  }
  if (phaseId != null && phaseId !== workflow.currentPhase) fail('Only the current code-delivery phase may be amended.');
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!phase || !phaseRequiresCodeDelivery(phase) || !Number.isSafeInteger(phase.generation) || phase.generation < 0
    || !['in_progress', 'awaiting_approval'].includes(phase.status) || workflow.status !== 'in_progress') {
    fail('Only the active current code phase can adopt a runner amendment. Completed phases and terminal Stories retain their historical approvals; use the owning reopen process.', 'TCA_PRIOR_PUBLICATION_UNSUPPORTED');
  }
  const revalidation = phase.generation > 0 ? publishedTestCommandRevalidation(phase) : null;
  if (!revalidation && (phase.status !== 'in_progress' || phase.deliveryEvidence || phase.generationCommit
    || (workflow.lineage?.submissions ?? []).some(entry => entry.phase === phase.id))) fail('Generation-zero amendment state contains historical publication or submission evidence.', 'TCA_AMENDMENT_STALE');
  if (revalidation && (!await generationResultMatches(root, config, workflow, phase)
    || phase.generationIntent?.status !== 'consumed')) fail('Published source or authored content changed. Preserve this draft and publish its successor through the existing repair route before amending policy.', 'TCA_PUBLISHED_CONTENT_CHANGED');
  const text = String(reason ?? '').trim();
  if (text.length < 15 || text.length > 2000 || /[\x00-\x1f\x7f]/u.test(text)) {
    fail('Provide a substantive amendment reason of 15–2000 ordinary characters.', 'TCA_AMENDMENT_REASON_REQUIRED');
  }
  const accepted = await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true, retainBytes: true });
  if (!accepted.enrolled || !same(accepted.policy, workflow.resolution)) fail('The current Story policy is not its exact accepted snapshot.', 'TCA_AMENDMENT_STALE');
  const source = workflow.resolution.configurationSource;
  if (!approvedConfigurationSnapshot || approvedConfigurationSnapshot.authority?.remote !== source?.repository
    || approvedConfigurationSnapshot.sourceCommit === source?.commit) {
    fail('Select a newer approved configuration at the original pinned authority.', 'TCA_AMENDMENT_AUTHORITY_CHANGED');
  }
  const resolved = applyCapabilityPolicyToWorkResolution(
    resolveApprovedStoryWorkType(approvedConfigurationSnapshot, workflow.workItem.workType), workflow.resolution.capability);
  const authorities = approvedStoryApprovalAuthorities(approvedConfigurationSnapshot);
  const policy = testCommandAmendmentPolicy(workflow, resolved, authorities);
  if (!same(phase.qualityCommands, policy.oldCommands)) fail('The runtime phase differs from its pinned command contract.', 'TCA_AMENDMENT_STALE');
  const liveActor = identity(root);
  if (!actorKey(liveActor)) fail('A named original and candidate reviewer is required.', 'TCA_AMENDMENT_AUTHORITY_REQUIRED');
  const originalAuthority = requireApprovalAuthority(workflow.resolution.approvalAuthorities, reviewPolicy(policy.original.approval), liveActor);
  const candidateAuthority = requireApprovalAuthority(authorities, reviewPolicy(policy.candidate.approval), liveActor);
  const actor = { name: liveActor.name, email: liveActor.email ?? null, login: liveActor.login ?? null };
  const interval = workflow.workIntervals?.current;
  if (!interval || interval.phaseId !== phase.id || !(interval.status === 'open'
    || (revalidation && interval.status === 'reconciled'))) fail('Prepare this phase under its existing pin before reviewing a runner amendment.', 'TCA_AUTHORING_BOUNDARY_REQUIRED');
  await verifyWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id,
    itemDirectory: path.join(root, workRelative(config, workflow)), allowReconciled: Boolean(revalidation) });
  const intent = revalidation ? phase.generationIntent : await verifyOpenGenerationIntent(root, workflow, phase);
  if (!intent?.path) fail('The original authoring boundary is required and will be preserved.', 'TCA_AUTHORING_BOUNDARY_REQUIRED');
  const currentHead = head(root);
  const changes = await buildRepositoryChangeSet(root, { baseCommit: currentHead, subject: { kind: 'test-command-amendment', workId: workflow.workItem.id } });
  if (changes.entries.some(entry => isApplicationChangeEntry(entry, applicationPathContext(config, workflow)))) {
    fail('Commit only the reviewed application source/test draft before amending its runner. The amendment never stages or discards those bytes.', 'TCA_SOURCE_DRAFT_UNCOMMITTED');
  }
  const intentBytes = await boundedFile(root, intent.path, 'Original generation intent');
  if (revalidation) {
    const originalBytes = exactFileAtObject(root, publishedGenerationCommit(root, workflow, phase), intent.path, { maximumBytes: 16 * 1024 * 1024 });
    if (!originalBytes || !Buffer.from(originalBytes).equals(intentBytes)) fail('The published authoring intent is not its immutable original receipt.', 'TCA_AMENDMENT_STALE');
  }
  const originalIntent = JSON.parse(intentBytes.toString('utf8'));
  let author = originalIntent.startedBy?.actor;
  if (!actorKey(author)) {
    const creationBytes = accepted.creationCommit
      ? exactFileAtObject(root, accepted.creationCommit, `${workRelative(config, workflow)}/workflow.json`, { maximumBytes: 16 * 1024 * 1024 }) : null;
    if (creationBytes) author = JSON.parse(creationBytes.toString('utf8')).workItem?.createdBy;
  }
  if (!actorKey(author)) fail('The original authoring identity cannot be authenticated for this amendment.', 'TCA_AMENDMENT_AUTHOR_UNAVAILABLE');
  if ((policy.original.approval.allowSelfApproval === false || policy.candidate.approval.allowSelfApproval === false)
    && identityKeys(author).some(key => identityKeys(actor).includes(key))) {
    fail('The original authoring identity cannot review this amendment under the pinned no-self-approval policy.', 'TCA_AMENDMENT_SELF_APPROVAL');
  }
  const artifactPath = path.posix.join(workRelative(config, workflow), phase.requiredArtifact.path);
  const artifactBytes = await boundedFile(root, artifactPath, 'Authored phase draft');
  const preserved = { intentSha256: digest(originalIntent), sourceBaseCommit: interval.sourceBaseCommit,
    sourceTreeSha256: await sourceTreeHash(root, config, workflow), draftSha256: bytesDigest(artifactBytes) };
  const epoch = workflow.resolution.testRecoveryValidationEpoch ?? 1;
  if (!Number.isSafeInteger(epoch) || epoch < 1 || (workflow.testRecovery && workflow.testRecovery.validationEpoch !== epoch)) {
    fail('The current validation epoch differs from its accepted runner policy.', 'TCA_AMENDMENT_STALE');
  }
  policy.proposed.testRecoveryValidationEpoch = epoch + 1;
  policy.proposed.configurationSource = { ...structuredClone(source), commit: approvedConfigurationSnapshot.sourceCommit, filesSha256: null };
  policy.proposed.policySha256 = policyDigest(policy.proposed);
  const from = { revision: workflow.workflowSnapshot.revision, snapshotHash: workflow.workflowSnapshot.snapshotHash,
    policySha256: workflow.resolution.policySha256, configurationCommit: source.commit,
    commandInventorySha256: digest(policy.oldCommands), validationEpoch: epoch };
  const to = { revision: from.revision + 1, policySha256: policy.proposed.policySha256,
    configurationCommit: approvedConfigurationSnapshot.sourceCommit, commandInventorySha256: digest(policy.newCommands), validationEpoch: epoch + 1 };
  const configurationAncestry = await captureSkillConfigurationAncestry(approvedConfigurationSnapshot, source);
  const id = `TCA-${String((workflow.testCommandAmendments ?? []).length + 1).padStart(3, '0')}`;
  const role = match => ({ authorityGroup: match.authorityGroup, identityAssurance: match.identityAssurance });
  const core = { id, workId: workflow.workItem.id, phaseId: phase.id, reason: text, from, to, actor,
    originalAuthority: role(originalAuthority), candidateAuthority: role(candidateAuthority), preserved,
    sourceHead: currentHead, configurationAncestrySha256: digest(configurationAncestry),
    ...(revalidation ? { revalidation } : {}) };
  const planSha256 = digest(core);
  return { ...core, planSha256, phase, proposedResolution: policy.proposed, configurationAncestry,
    oldCommands: policy.oldCommands, newCommands: policy.newCommands, accepted };
}

export async function previewStoryTestCommandAmendment(root, config, workflow, options = {}) {
  const candidate = await candidateFor(root, config, workflow, options);
  return publicPreview(candidate);
}

function publicPreview(candidate) {
  return { schemaVersion: 1, resultType: 'test-command-amendment-preview', status: 'ready',
    amendmentId: candidate.id, workId: candidate.workId, phaseId: candidate.phaseId, planSha256: candidate.planSha256,
    reason: candidate.reason, from: candidate.from, to: candidate.to, preserved: candidate.preserved,
    originalAuthority: candidate.originalAuthority, candidateAuthority: candidate.candidateAuthority,
    oldCommands: trpSelectionPublicPreview({ commands: candidate.oldCommands }).commands,
    newCommands: trpSelectionPublicPreview({ commands: candidate.newCommands }).commands,
    executed: false, stateChanged: false, sourceChanged: false,
    prerequisites: { originalApproval: { mode: 'required', minimum: 1, authorityGroup: candidate.originalAuthority.authorityGroup },
      candidateApproval: { mode: 'required', minimum: 1, authorityGroup: candidate.candidateAuthority.authorityGroup },
      originalAuthoringBoundary: candidate.revalidation ? 'published-and-preserved' : 'open-and-preserved', sourceAndTests: 'already-committed',
      authoredArtifact: 'exact-bytes-preserved-including-dirty-draft',
      confirmation: 'exact-plan-and-live-terminal-review', supportedOriginalRunner: 'structured-kind-test-or-no-declared-tests' },
    ...(candidate.revalidation ? { revalidation: candidate.revalidation, impact: 'published-generation-retained-new-epoch-requires-fresh-submission' } : {}),
    limitations: ['active-current-phase-only', 'single-human-dual-authority', 'no-risk-or-scope-change'],
    legalActions: [{ id: 'apply-test-command-amendment', command: 'story', args: ['test-policy', 'amend', '--work-id', candidate.workId,
      '--reason', candidate.reason, '--apply', '--confirm', candidate.planSha256] }] };
}

async function writeReviewRecord(root, relative, record) {
  const safe = await secureRepositoryPath(root, relative, { label: 'Immutable test-command amendment record', type: 'file' });
  if (safe.exists) fail('The immutable amendment record already exists. Recover its pending transaction instead.', 'TCA_AMENDMENT_CONFLICT');
  await mkdir(path.dirname(safe.absolute), { recursive: true });
  await writeText(safe.absolute, canonicalJson(record));
}

export async function applyStoryTestCommandAmendment(root, config, workflow, options = {}) {
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, () =>
    applyLockedStoryTestCommandAmendment(root, config, workflow, options));
}

async function applyLockedStoryTestCommandAmendment(root, config, workflow, options) {
  const initial = await candidateFor(root, config, workflow, options);
  if (options.confirm !== initial.planSha256) fail('Review and confirm the current exact test-command amendment plan.', 'TCA_AMENDMENT_CONFIRMATION_REQUIRED');
  const origin = await import('./test-command-amendment-origin.mjs');
  const at = nowIso();
  const reviewCore = { schemaVersion: initial.revalidation ? 2 : 1, kind: 'test-command-adoption-review', id: initial.id,
    workId: initial.workId, phaseId: initial.phaseId, decision: 'approve', at,
    planSha256: initial.planSha256, from: initial.from, to: initial.to, actor: initial.actor,
    originalAuthority: initial.originalAuthority, candidateAuthority: initial.candidateAuthority,
    preserved: initial.preserved, ...(initial.revalidation ? { revalidation: initial.revalidation } : {}) };
  const card = origin.testCommandReviewAuthorization(reviewCore);
  // The immutable card binds exact command hashes. Show the concrete redacted change alongside
  // it; configured secrets never need to be repeated to establish the reviewed plan identity.
  if (process.stdout.isTTY) process.stdout.write(`${JSON.stringify(publicPreview(initial), null, 2)}\n`);
  const grant = await captureTerminalActionAuthorization(root, card.plan, card.action, { label: 'Amend test command' });
  if (!grant) return { status: 'cancelled', applied: false, stateChanged: false, executed: false, sourceChanged: false };
  const { StoryStateStore, storyPublicationPending } = await import('./state-stores.mjs');
  const { captureWorkflowTestCommandAmendment } = await import('./workflow-snapshots.mjs');
  const store = new StoryStateStore(root, config);
  try {
    const transaction = await store.transact(workflow, { type: LIFECYCLE_EVENT.TEST_COMMAND_AMENDED, phaseId: initial.phaseId,
      payload: { amendmentId: initial.id, planSha256: initial.planSha256, previousEpoch: initial.from.validationEpoch,
        nextEpoch: initial.to.validationEpoch } }, `Amend test command for ${workflow.workItem.id}`, async current => {
      const fresh = await candidateFor(root, config, current, options);
      if (fresh.planSha256 !== initial.planSha256) fail('The Story, source, author, or approved command changed during review. Review a fresh plan.', 'TCA_AMENDMENT_STALE');
      const prior = structuredClone(current);
      const review = await origin.consumeTestCommandReviewAuthorization(root, path.join(root, workRelative(config, current)), { review: reviewCore, token: grant.token });
      const reviewPath = recordPath(config, current, fresh.id, 'review-001');
      const reviewSha256 = digest(review);
      const decision = { schemaVersion: fresh.revalidation ? 2 : 1, kind: 'test-command-adoption-decision', id: fresh.id,
        workId: fresh.workId, status: 'approved', phaseId: fresh.phaseId, approvedAt: at, reason: fresh.reason,
        from: fresh.from, to: fresh.to, configurationAncestry: fresh.configurationAncestry,
        review: { path: reviewPath, sha256: reviewSha256 }, ...(fresh.revalidation ? { revalidation: fresh.revalidation } : {}) };
      const decisionPath = recordPath(config, current, fresh.id, 'decision');
      const decisionSha256 = digest(decision);
      await writeReviewRecord(root, reviewPath, review);
      await writeReviewRecord(root, decisionPath, decision);
      current.resolution = fresh.proposedResolution;
      const phase = current.phases[fresh.phaseId];
      phase.qualityCommands = structuredClone(fresh.newCommands);
      if (current.testRecovery) current.testRecovery.validationEpoch = fresh.to.validationEpoch;
      phase.checks = [];
      phase.validationVerdict = null;
      if (fresh.revalidation) {
        phase.testCommandRevalidation = testCommandRevalidationRequirement(decision);
        phase.testCommandValidation = null;
        phase.status = 'in_progress';
      }
      current.testCommandAmendments ??= [];
      current.testCommandAmendments.push({ schemaVersion: fresh.revalidation ? 2 : 1, kind: 'test-command-adoption-summary', id: fresh.id,
        phaseId: fresh.phaseId, status: 'approved', decisionPath, decisionSha256, reviewPath, reviewSha256,
        from: fresh.from, to: fresh.to, decidedAt: at, ...(fresh.revalidation ? { revalidation: fresh.revalidation } : {}) });
      current.workIntervals.current = null;
      await ensureWorkIntervalBaseline(root, config, current, { phaseId: phase.id,
        itemDirectory: path.join(root, workRelative(config, current)), itemRelative: workRelative(config, current),
        sourceBaseCommit: fresh.preserved.sourceBaseCommit, baselineTag: fresh.id.toLowerCase() });
      const reference = await captureWorkflowTestCommandAmendment(root, config, prior, current, {
        approvedConfigurationSnapshot: options.approvedConfigurationSnapshot,
        amendmentDecision: { path: decisionPath, sha256: decisionSha256 } });
      current.workflowSnapshot = reference;
      PROSPECTIVE.set(current, { reference: structuredClone(reference), policySha256: current.resolution.policySha256 });
      current.history.push({ at, actor: actorKey(fresh.actor), agent: null, event: 'test_command_amended', phase: phase.id,
        detail: `${fresh.id}: runner policy revision ${reference.revision}; validation epoch ${fresh.to.validationEpoch}; original authoring boundary preserved` });
      const { sourceTreeHash } = await import('./state.mjs');
      const artifact = await boundedFile(root, path.posix.join(workRelative(config, current), phase.requiredArtifact.path), 'Preserved phase draft');
      if (await sourceTreeHash(root, config, current) !== fresh.preserved.sourceTreeSha256 || bytesDigest(artifact) !== fresh.preserved.draftSha256
        || !same(phase.generationIntent, prior.phases[phase.id].generationIntent)) {
        fail('Amendment changed preserved source, draft, or authoring intent; publication refused.', 'TCA_PRESERVATION_FAILED');
      }
      return { amendmentId: fresh.id, workflowSnapshot: reference, validationEpoch: fresh.to.validationEpoch };
    }, { expectedLocalHead: initial.sourceHead });
    const pending = await storyPublicationPending(root, config, workflow.workItem.id, { migrate: false });
    return { schemaVersion: 1, resultType: 'test-command-amendment', status: pending ? 'publication-pending' : 'applied',
      applied: true, stateChanged: true, executed: false, sourceChanged: false, ...transaction.value,
      publication: transaction.publication, pending: pending ?? null,
      legalActions: pending ? [{ id: 'recover-publication', command: 'recover', args: [workflow.workItem.id, '--json'] }]
        : [{ id: initial.revalidation ? 'revalidate-amended-phase' : 'prepare-amended-phase',
          command: initial.revalidation ? 'submit' : 'prepare', args: [initial.phaseId, '--work-id', initial.workId] }] };
  } finally { PROSPECTIVE.delete(workflow); }
}

/** Protect direct domain callers as well as CLI readers after an accepted amendment. */
export async function verifyAcceptedTestCommandAmendment(root, config, workflow, verified = null) {
  if (PROSPECTIVE.has(workflow)) return;
  const epoch = workflow.resolution?.testRecoveryValidationEpoch;
  if (Number(workflow.workflowSnapshot?.revision ?? 1) <= 1 && epoch == null && !(workflow.testCommandAmendments ?? []).length) return;
  verified ??= await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true, retainBytes: true });
  const relative = `${workRelative(config, workflow)}/workflow.json`;
  const bytes = exactFileAtObject(root, verified.acceptanceCommit, relative, { maximumBytes: 16 * 1024 * 1024 });
  if (!bytes) fail('The accepted runner amendment cannot be read from its publication commit.', 'TCA_AMENDMENT_STALE');
  const accepted = JSON.parse(bytes.toString('utf8'));
  if (accepted.resolution?.testRecoveryValidationEpoch == null && !(accepted.testCommandAmendments ?? []).length
    && epoch == null && !(workflow.testCommandAmendments ?? []).length) return;
  if (!same(accepted.testCommandAmendments, workflow.testCommandAmendments)
    || accepted.resolution.testRecoveryValidationEpoch !== epoch
    || (workflow.testRecovery && workflow.testRecovery.validationEpoch !== epoch)) {
    fail('The runner amendment or validation epoch differs from its committed accepted state.', 'TCA_AMENDMENT_STALE');
  }
  for (const summary of workflow.testCommandAmendments ?? []) {
    const phase = workflow.phases?.[summary.phaseId];
    const pinned = workflow.resolution.phases.find(entry => entry.id === summary.phaseId);
    if (!phase || !pinned || !same(phase.qualityCommands, pinned.qualityCommands)) {
      fail('An amended runtime command differs from its accepted policy.', 'TCA_AMENDMENT_STALE');
    }
    if (!same(phase.testCommandRevalidation ?? null, accepted.phases?.[summary.phaseId]?.testCommandRevalidation ?? null)) {
      fail('The current epoch requirement differs from its immutable amendment boundary.', 'TCA_AMENDMENT_STALE');
    }
  }
}
