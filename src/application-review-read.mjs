/** ARA owner reads. One shared input snapshot per operation; finalizers always read again. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { trackedPathListing, untrackedFiles, gitCommonDir, gitDir, workingTreeChangedPaths } from './git.mjs';
import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { secureRepositoryPath } from './util.mjs';
import { workDirRelative } from './story-paths.mjs';
import { phaseRequiresCodeDelivery, applicationReviewPhase } from './code-delivery-policy.mjs';
import { araFail, applicationReviewPolicy, projectReview, reviewDigest, reviewSubject, reviewApplicability } from './application-review-contract.mjs';

export const bytesDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const reviewLocalRoot = root => path.join(gitCommonDir(root), 'singularity-flow', 'application-reviews');
export const localCheckoutIdentity = root => {
  const canonical = realpathSync.native(root);
  return reviewDigest(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
};

export function reviewSnapshotReference(config, workflow, snapshot) {
  return { kind: 'application-review-snapshot-reference', digest: snapshot.digest, files: snapshot.manifest.length,
    path: `${workDirRelative(config, workflow.workItem.id)}/context/application-reviews/snapshots/${snapshot.digest.slice(7)}.json` };
}

/** Keep authoritative case inventories in their existing immutable execution records, once. */
export function compactReviewResults(results) {
  return { ...results, attempts: results.attempts.map(attempt => ({ attemptId: attempt.attemptId, commandId: attempt.commandId,
    digest: reviewDigest(attempt), purpose: attempt.purpose, status: attempt.status, exitCode: attempt.exitCode, tests: attempt.tests,
    process: attempt.process, reportedCases: attempt.occurrences?.length ?? 0 })) };
}

/** The owner's application partition, including relevant configuration and every actual source byte. */
export async function applicationReviewSnapshot(root, config, workflow, { retainBytes = false } = {}) {
  const tracked = trackedPathListing(root);
  if (!tracked.complete) araFail('ARA_SNAPSHOT_INCOMPLETE', 'The source inventory exceeded its bound; no partial snapshot was admitted.');
  const context = applicationPathContext(config, workflow);
  const paths = [...new Set([...tracked.paths, ...untrackedFiles(root)])].filter(file => isApplicationChangePath(file, context)).sort();
  if (paths.length > 50000) araFail('ARA_SNAPSHOT_INCOMPLETE', 'The review snapshot supports at most 50,000 source files.');
  const manifest = [];
  const contents = new Map();
  let total = 0;
  for (const file of paths) {
    const secured = await secureRepositoryPath(root, file, { label: 'Application review input' });
    if (!secured.exists) continue; // A tracked deletion is represented by absence in the immutable manifest.
    const entry = await lstat(secured.absolute);
    if (!entry.isFile() || entry.isSymbolicLink()) araFail('ARA_SNAPSHOT_UNSUPPORTED', `Review source must be a regular file: ${file}.`);
    if (entry.size > 32 * 1024 * 1024 || total + entry.size > 256 * 1024 * 1024) araFail('ARA_SNAPSHOT_INCOMPLETE', 'Review source exceeds the supported snapshot size.');
    const bytes = await readFile(secured.absolute); total += bytes.length;
    manifest.push({ path: file, sha256: bytesDigest(bytes), bytes: bytes.length, executable: (entry.mode & 0o111) !== 0 });
    if (retainBytes) contents.set(file, bytes);
  }
  const snapshot = { schemaVersion: 1, kind: 'application-review-snapshot', manifest };
  return { ...snapshot, digest: reviewDigest(snapshot), contents, bytes: total };
}

/** Optional actual diagnostics. Never execute an environment resolver merely to render a report. */
async function retainedCaseMessages(root, receipt, workId) {
  if (receipt.boundEnvironment?.name || !receipt.rawReports?.length || !receipt.occurrences?.length) return null;
  const contents = [];
  let total = 0;
  for (const report of receipt.rawReports) {
    if (!/^[a-f0-9]{64}$/u.test(report.sha256 ?? '')) return null;
    let bytes = null;
    let issued;
    try { issued = (await secureRepositoryPath(root, report.path, { label: 'Retained case details', mustExist: true, type: 'file' })).absolute; } catch { /* local private receipt may be the only retained copy */ }
    for (const candidate of [issued, path.join(gitDir(root), 'singularity-flow', 'test-attempts', workId, 'raw', report.sha256)].filter(Boolean)) {
      try {
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) continue;
        const value = await readFile(candidate);
        if (bytesDigest(value) === `sha256:${report.sha256}`) { bytes = value; break; }
      } catch { /* explicitly unavailable when no unchanged retained report can be read */ }
    }
    if (!bytes || (total += bytes.length) > 16 * 1024 * 1024) return null;
    contents.push(bytes);
  }
  const { testCaseMessages } = await import('./test-case-messages.mjs');
  const { redactDiagnosticText } = await import('./git-remote-diagnostics.mjs');
  return testCaseMessages(receipt.adapter, contents, receipt.occurrences.length)?.map(message => message == null ? null : redactDiagnosticText(message)) ?? null;
}

/** Resolve exact immutable submission evidence, never an unrelated earlier/local test run. */
export async function applicationReviewResults(root, config, workflow, phaseId) {
  const phase = workflow.phases[phaseId];
  const submission = (workflow.lineage?.submissions ?? []).findLast(item => item.phase === phaseId && item.generation === phase.generation);
  if (!submission) return { digest: null, packet: null, attempts: [], ready: false, reason: 'Submit this generation to pin its authoritative test results; diagnostic inspection can start now.' };
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, submission.packetSha256);
  // One exact-tree diff, not commit history or one process per file. Include untracked source:
  // an old packet cannot verify a new, unplanned file that the phase candidate omitted.
  const context = applicationPathContext(config, workflow);
  const changedSource = [...new Set([...workingTreeChangedPaths(root, packet.sourceCommit), ...untrackedFiles(root)])]
    .filter(file => isApplicationChangePath(file, context)).sort();
  const sourceBinding = { sourceCommit: packet.sourceCommit, current: changedSource.length === 0, changedPaths: changedSource.slice(0, 50), omitted: Math.max(0, changedSource.length - 50) };
  const attempts = [];
  for (const reference of packet.submissionEvidence?.testExecutions ?? []) {
    if (reference.kind === 'phase-validation-observation') continue;
    const secured = await secureRepositoryPath(root, reference.path, { label: 'Submitted test evidence', mustExist: true, type: 'file' });
    const record = JSON.parse(await readFile(secured.absolute, 'utf8'));
    if (reviewDigest(record) !== `sha256:${String(reference.sha256).replace(/^sha256:/u, '')}`) araFail('ARA_TEST_EVIDENCE_STALE', 'The submitted test execution record changed.');
    if (record.commandId !== reference.commandId) araFail('ARA_TEST_EVIDENCE_STALE', 'Submitted test command identities differ.');
    attempts.push({ ...record, caseMessages: await retainedCaseMessages(root, record, workflow.workItem.id) });
  }
  const binding = { packet: submission.packetSha256, generation: phase.generation, sourceBinding, attempts: attempts.map(item => ({ id: item.attemptId ?? reviewDigest(item), digest: reviewDigest(item) })) };
  const confirmable = sourceBinding.current && attempts.length > 0 && attempts.every(item => item.terminal === true && Number.isFinite(Date.parse(item.process?.completedAt)));
  const ready = sourceBinding.current && attempts.length > 0 && attempts.every(item => item.status === 'passed' && Number(item.exitCode) === 0
    && Number(item.tests?.passed ?? 0) > 0 && Number(item.tests?.failed ?? 0) === 0 && Number(item.tests?.skipped ?? 0) === 0);
  return { ...binding, attempts, digest: reviewDigest(binding), ready, confirmable, reason: !sourceBinding.current
    ? 'Application source changed since the submitted test packet. Use the current phase’s authorized successor and submit its actual checks before final acceptance.'
    : ready ? null : 'Required submitted tests have not established a passing, executed result.' };
}

export async function applicationReviewPlan(root, config, workflow, { phaseId = applicationReviewPhase(workflow) } = {}) {
  const policy = applicationReviewPolicy(workflow);
  const subject = reviewSubject(workflow, phaseId);
  if (!phaseRequiresCodeDelivery(workflow.phases[phaseId])) araFail('ARA_SUBJECT_UNSUPPORTED', 'Application review becomes available for a delivered code-bearing phase, regardless of its name.',
    { nextAction: { command: 'singularity-flow nextsteps --for-agent --json', label: 'Continue the existing workflow until its code delivery is available.' } });
  if (!policy || policy.mode === 'off') return { subject, status: 'not-adopted', policy: null, required: false, items: [], capabilities: { review: 'unavailable', reason: 'This Story did not adopt application review. Existing pinned Stories are unchanged.' } };
  const snapshot = await applicationReviewSnapshot(root, config, workflow);
  const phase = workflow.phases[phaseId];
  const baseline = phase.generationIntent?.baseline?.commit ?? workflow.workItem.baseCommit;
  const changedSurfaces = [...new Set([...(phase.deliveryEvidence?.sourcePaths ?? []),
    ...(baseline ? workingTreeChangedPaths(root, baseline) : []), ...untrackedFiles(root)])]
    .filter(file => isApplicationChangePath(file, applicationPathContext(config, workflow))).sort();
  // A backend change in a mixed repository is not a UI change merely because an unchanged
  // frontend exists. New, deleted and unplanned UI paths still strengthen the adopted profile.
  const applicability = reviewApplicability(policy, changedSurfaces);
  const [{ evidenceGraphFromAggregate }, { mergedVerificationContracts }] = await Promise.all([import('./evidence/graph.mjs'), import('./verification/contracts.mjs')]);
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  const clauses = (graph.records?.indexes ?? []).flatMap(item => item.clauses ?? []).filter(item => item.kind === 'AC' || item.type === 'AC' || /:AC-\d{3}$/u.test(item.id ?? ''));
  const contracts = mergedVerificationContracts(graph.records?.planned ?? []);
  const items = [];
  for (const clause of clauses) {
    items.push({ id: `${clause.id}:functional`, dimension: 'functional', text: clause.body ?? clause.text ?? clause.id,
      source: { kind: 'approved-clause', id: clause.id, bodySha256: clause.contentSha256 ?? reviewDigest(clause.body ?? clause.text) } });
    if (applicability.surface === 'web') items.push({ id: `${clause.id}:visual`, dimension: 'visual', text: clause.body ?? clause.text ?? clause.id,
      source: { kind: 'approved-clause', id: clause.id, bodySha256: clause.contentSha256 ?? reviewDigest(clause.body ?? clause.text) },
      slots: (contracts.get(clause.id)?.slots ?? []).filter(slot => slot.method === 'visual').map(slot => ({ slot: slot.slot, target: slot.witness?.target ?? null })) });
  }
  for (const [index, text] of policy.quality.entries()) items.push({ id: `quality-${index}`, dimension: applicability.surface === 'web' ? 'visual' : 'functional', text,
    source: { kind: 'adopted-quality-profile', digest: reviewDigest(policy), index } });
  if (!items.length) items.push({ id: 'delivery-inspection', dimension: 'functional', text: workflow.workItem.title ?? workflow.workItem.id,
    source: { kind: 'work-request', digest: reviewDigest(workflow.workItem) } });
  const results = await applicationReviewResults(root, config, workflow, phaseId);
  const { phaseDocumentReadiness } = await import('./document-runtime.mjs');
  const documents = await phaseDocumentReadiness(root, config, workflow, phaseId, { includeReferences: true });
  return { schemaVersion: 1, kind: 'application-review-plan', subject, policy, required: policy.mode === 'required', status: applicability.resolved && documents.status === 'ready' ? 'available' : 'blocked', documents,
    snapshot: { digest: snapshot.digest, manifest: snapshot.manifest }, applicability, changedSurfaces, items, results,
    capabilities: { review: 'available', staticWeb: policy.preview ? 'available' : 'unavailable', testResults: 'available', executionRun: 'unsupported',
      attestedBrowser: 'unsupported', signedPersonPresence: 'unsupported', reviewExceptions: 'unsupported', feedbackImageUpload: 'unsupported',
      compositeRepositoryRepair: 'unsupported', freeTextAcceptance: 'unsupported' } };
}

export function findReviewSession(workflow, sessionId = null, phaseId = applicationReviewPhase(workflow)) {
  const sessions = workflow.applicationReviews ?? [];
  const session = sessionId ? sessions.find(item => item.id === sessionId) : sessions.findLast(item => item.subject.phaseId === phaseId);
  if (!session) araFail('ARA_SESSION_NOT_FOUND', 'Open a review for this delivery; no Story needs to be recreated.');
  return session;
}

export async function reviewTargetCurrent(root, config, workflow, target, { plan: observedPlan = null } = {}) {
  if (!target || target.subject.generation !== workflow.phases?.[target.subject.phaseId]?.generation) return false;
  if (target.binding?.checkout !== localCheckoutIdentity(root)) return false;
  const plan = observedPlan ?? await applicationReviewPlan(root, config, workflow, { phaseId: target.subject.phaseId });
  if (plan.documents?.status !== 'ready' || reviewDigest(plan.documents.references) !== target.referencesDigest) return false;
  if (target.applicability.surface === 'web' && target.assurance === 'host-bound'
      && (target.binding?.adapter !== 'static-web' || target.binding.sourceDigest !== target.snapshot.digest)) return false;
  if (plan.snapshot.digest !== target.snapshot.digest || plan.results.digest !== target.results.digest
      || reviewDigest(plan.items) !== target.plan.digest || reviewDigest(plan.applicability) !== reviewDigest(target.applicability)
      || reviewDigest(applicationReviewPolicy(workflow)) !== target.policyDigest) return false;
  if (target.binding?.commandDigest) {
    const { resolveCapabilityApplication } = await import('./capability-application-context.mjs');
    const { selectStartEntry, applicationCommandSha256 } = await import('./application-run.mjs');
    const context = await resolveCapabilityApplication(root, { capabilityId: workflow.resolution?.capability?.id ?? null });
    const entry = selectStartEntry(context, plan.policy.preview.entry);
    if (applicationCommandSha256(context, entry) !== target.binding.commandDigest) return false;
  }
  return true;
}

export async function reviewEvidenceAvailable(root, receipts) {
  if (!receipts.length) return false;
  for (const receipt of receipts) {
    if (receipt.checkout !== localCheckoutIdentity(root) || !/^sha256:[a-f0-9]{64}$/u.test(receipt.sha256 ?? '')) return false;
    const file = path.join(reviewLocalRoot(root), 'artifacts', receipt.sha256.slice(7) + '.png');
    try {
      const bytes = await readFile(file);
      if (bytes.length < 24 || bytesDigest(bytes) !== receipt.sha256
          || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || bytes.readUInt32BE(16) !== receipt.image?.width || bytes.readUInt32BE(20) !== receipt.image?.height) return false;
    } catch { return false; }
  }
  return true;
}

export async function applicationReviewStatus(root, config, workflow, sessionId = null, { includeResults = false } = {}) {
  const session = findReviewSession(workflow, sessionId);
  const view = projectReview(session);
  const plan = await applicationReviewPlan(root, config, workflow, { phaseId: view.subject.phaseId });
  const targetCurrent = await reviewTargetCurrent(root, config, workflow, view.target, { plan });
  if (!targetCurrent) view.dimensions = Object.fromEntries(Object.entries(view.dimensions).map(([dimension, status]) => [dimension, status === 'not-applicable' ? status : 'stale']));
  const evidenceAvailable = await reviewEvidenceAvailable(root, view.captures);
  const documents = plan.documents;
  if (includeResults && targetCurrent) view.target.results = plan.results;
  const { reviewCompletion } = await import('./application-review-contract.mjs');
  const decisionsCurrent = view.decisions.every(decision => (workflow.applicationAcceptanceRecords ?? []).some(record => record.id === decision.id
    && record.targetId === view.target.id && record.confirmation === decision.confirmation));
  const continuation = view.findings.some(finding => finding.repairRequested && finding.state === 'ready-for-repair')
    && (workflow.currentPhase !== view.subject.phaseId || !['in_progress', 'awaiting_approval'].includes(workflow.phases[view.subject.phaseId].status))
    ? await (await import('./application-review.mjs')).applicationRepairContinuation(workflow, view.subject.phaseId) : null;
  return { ...view, state: targetCurrent || !view.target ? view.state : 'stale', completion: reviewCompletion(view, { targetCurrent, evidenceAvailable, decisionsCurrent }),
    localEvidence: evidenceAvailable ? 'available' : view.captures.length ? 'missing-on-this-laptop' : 'not-captured',
    repositoryPath: root, currentPhase: workflow.currentPhase, phaseApproval: workflow.phases[session.subject.phaseId].status, documents, continuation,
    routes: { copilot: '/sf-app-review', shell: `singularity-flow app-review inspect ${session.id}`, vscode: null } };
}

/** Evidence-graph read without calling the graph again. Only adopted live decisions can witness UI. */
export async function applicationReviewWitnessResults(root, config, workflow) {
  if (!applicationReviewPolicy(workflow) || !workflow.applicationAcceptanceRecords?.length) return [];
  const { applicationReviewSlotResults, witnessContextBinding } = await import('./verification/witness-records.mjs');
  const views = (workflow.applicationReviews ?? []).map(projectReview).filter(view => view.decisions.length && view.target?.applicability.surface === 'web');
  if (!views.length) return [];
  const snapshot = await applicationReviewSnapshot(root, config, workflow);
  const output = [];
  for (const view of views) {
    if (view.target.binding?.checkout !== localCheckoutIdentity(root) || view.target.snapshot.digest !== snapshot.digest
        || view.target.subject.generation !== workflow.phases[view.subject.phaseId]?.generation
        || !workflow.applicationAcceptanceRecords.some(record => view.decisions.some(decision => decision.id === record.id)
          && record.contextBinding === witnessContextBinding(workflow))) continue;
    const results = await applicationReviewResults(root, config, workflow, view.subject.phaseId);
    const documents = await (await import('./document-runtime.mjs')).phaseDocumentReadiness(root, config, workflow, view.subject.phaseId, { includeReferences: true });
    const current = results.ready && results.digest === view.target.results.digest && documents.status === 'ready'
      && reviewDigest(documents.references) === view.target.referencesDigest;
    output.push(...applicationReviewSlotResults(workflow, view, { targetCurrent: current, evidenceAvailable: await reviewEvidenceAvailable(root, view.captures) }));
  }
  return output;
}
