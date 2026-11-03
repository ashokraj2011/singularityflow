/** Persistent local inspection host. No model invocation; every human choice arrives in native forms. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { applicationReviewPlan, applicationReviewStatus, findReviewSession, reviewTargetCurrent, localCheckoutIdentity, compactReviewResults, reviewSnapshotReference, reviewLocalRoot, bytesDigest } from './application-review-read.mjs';
import { createApplicationReviewHumanServer, applicationReviewPage } from './application-review-human.mjs';
import { mutateApplicationReview, recordApplicationFeedback, confirmApplicationReview, finalizeApplicationReview, prepareApplicationRepair } from './application-review.mjs';
import { araFail, projectReview, reviewDigest, reviewReportPages, findingRoot, validateReviewCaptureSet } from './application-review-contract.mjs';
import { captureApplicationReview, prepareStaticReview, reviewedPageFingerprint, applicationResultHtml } from './application-review-preview.mjs';
import { workDirRelative } from './story-paths.mjs';
import { readRecord } from './schema-migrations.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

const safeErrorMessage = error => redactDiagnosticText(error.message ?? String(error), { multiline: true }).slice(0, 4000);

export async function createApplicationReviewHost(root, { workId = null, sessionId, onClose = () => {} } = {}) {
  const identity = { kind: 'application-review-host-identity', instance: randomUUID(), sessionId, checkout: localCheckoutIdentity(root), pid: process.pid };
  let preview = null;
  let closed = false;
  let busy = false;
  let lifecycleWatch = null;
  let lifecycleTimer = null;
  const read = async () => {
    const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
    if (!lifecycleWatch && !['completed', 'cancelled', 'archived'].includes(workflow.status)) {
      const directory = path.join(root, workDirRelative(config, workflow.workItem.id));
      try {
        lifecycleWatch = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename && String(filename) !== 'workflow.json') return;
          clearTimeout(lifecycleTimer);
          lifecycleTimer = setTimeout(async () => {
            try {
              const current = readRecord('story-workflow', await readFile(path.join(directory, 'workflow.json'), 'utf8')).record;
              if (['completed', 'cancelled', 'archived'].includes(current.status)) await close();
            } catch (error) { if (error.code === 'ENOENT') await close(); }
          }, 100); lifecycleTimer.unref();
        });
        lifecycleWatch.on('error', () => { void close(); });
      } catch { /* A non-filesystem provider keeps the existing finite host lifetime. */ }
    }
    return applicationReviewStatus(root, config, workflow, sessionId, { includeResults: true });
  };
  const options = (view, actionId, input = {}) => ({ workId, sessionId, actionId, expectedRevision: view.revision, input });
  const refresh = async ({ launch, actionId }) => {
    const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
    const session = findReviewSession(workflow, sessionId);
    let view = projectReview(session);
    if (!launch && view.state !== 'cancelled' && await reviewTargetCurrent(root, config, workflow, view.target)) return;
    await mutateApplicationReview(root, { ...options(view, actionId, { launch }), type: 'target-preparing', prepare: () => ({ operationId: actionId, effect: launch ? 'declared-build-and-controlled-preview' : 'refresh-bindings' }) });
    try {
      const plan = await applicationReviewPlan(root, config, workflow, { phaseId: session.subject.phaseId });
      if (preview && preview.binding.sourceDigest !== plan.snapshot.digest) { await preview.close(); preview = null; }
      if (launch && plan.applicability.surface === 'web') {
        await preview?.close(); preview = null;
        preview = await prepareStaticReview(root, config, workflow, session);
      }
      const target = { subject: plan.subject, snapshot: reviewSnapshotReference(config, workflow, plan.snapshot), results: compactReviewResults(plan.results), applicability: plan.applicability, changedSurfaces: plan.changedSurfaces,
        references: plan.documents.references, referencesDigest: reviewDigest(plan.documents.references),
        plan: { items: plan.items, digest: reviewDigest(plan.items) }, policyDigest: reviewDigest(plan.policy),
        assurance: plan.applicability.surface === 'web' ? preview ? 'host-bound' : 'unverified' : 'host-bound',
        binding: preview?.binding ?? { adapter: 'test-results', checkout: localCheckoutIdentity(root), instance: null } };
      target.id = reviewDigest(target);
      view = await read();
      await mutateApplicationReview(root, { ...options(view, `${actionId}-ready`, { targetId: target.id }), type: 'target-ready',
        prepare: () => ({ target, snapshotRecord: { ...plan.snapshot, schemaVersion: 1, kind: 'application-review-snapshot' } }) });
    } catch (error) {
      view = await read();
      await mutateApplicationReview(root, { ...options(view, `${actionId}-blocked`, { code: error.code ?? 'ARA_BUILD_FAILED' }), type: 'target-blocked',
        prepare: () => ({ code: error.code ?? 'ARA_BUILD_FAILED', message: safeErrorMessage(error), operationId: actionId }) });
      throw error;
    }
  };
  const capture = async actionId => {
    let view = await read();
    if (view.state === 'accepted' && view.completion.reviewSatisfied) return { message: 'Application accepted. Phase approval remains separate.' };
    if (!view.confirmation) araFail('ARA_HUMAN_ACTION_REQUIRED', 'Say All good for the current reviewed result before final capture.');
    const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
    const session = findReviewSession(workflow, sessionId);
    if (!await reviewTargetCurrent(root, config, workflow, view.target)) araFail('ARA_REVIEW_STALE', 'Source or results changed. The old confirmation stays historical; inspect the replacement result.');
    const currentReceipts = view.captures.filter(item => item.confirmation === view.confirmation.id);
    if (currentReceipts.length && view.localEvidence === 'available') {
      validateReviewCaptureSet(view, currentReceipts, session.policy);
      await finalizeApplicationReview(root, options(view, `${actionId}-finalized`));
      return { message: 'Acceptance finalized using the retained confirmation and admitted evidence. Nothing was relaunched, rerun or recaptured.' };
    }
    await mutateApplicationReview(root, { ...options(view, `${actionId}-started`), type: 'capture-started', prepare: () => ({ confirmation: view.confirmation.id }) });
    let admitted = false;
    try {
      const receipts = await captureApplicationReview(root, view, session.policy, preview);
      view = await read();
      await mutateApplicationReview(root, { ...options(view, `${actionId}-admitted`, { receiptIds: receipts.map(item => item.id) }), type: 'capture-admitted', prepare: () => ({ receipts }) });
      admitted = true;
      view = await read();
      await finalizeApplicationReview(root, options(view, `${actionId}-finalized`));
      return { message: 'Application accepted. Evidence was captured and admitted locally after your confirmation. Phase approval remains a separate action.' };
    } catch (error) {
      view = await read();
      await mutateApplicationReview(root, { ...options(view, `${actionId}-failed`, { code: error.code ?? 'ARA_CAPTURE_FAILED' }), type: admitted ? 'acceptance-blocked' : 'capture-blocked',
        prepare: () => ({ code: error.code ?? 'ARA_CAPTURE_FAILED', message: safeErrorMessage(error), confirmation: view.confirmation.id }) });
      throw error;
    }
  };
  const perform = async ({ actionId, expectedRevision, input, grant }) => {
    // Feedback may arrive during a build/capture. Keep the inspected target from its original
    // card; the Story CAS serializes the write and makes a racing acceptance recheck freshness.
    if (['report-only', 'report-and-fix'].includes(input.action)) {
      const view = await read();
      const feedback = { observed: input.observed, expected: input.expected, intent: input.action, targetId: input.targetId };
      await recordApplicationFeedback(root, { ...options(view, actionId, feedback), expectedRevision, human: grant(feedback) });
      return { message: input.action === 'report-and-fix' ? 'Problem retained with your repair instruction. Continue through /sf-code; mapping and scope are checked before source edits.' : 'Observation retained. No repair was authorized.' };
    }
    if (busy) araFail('ARA_OPERATION_PENDING', 'The current review operation is still running. Keep feedback and refresh when it finishes.');
    busy = true;
    try {
      const view = await read();
      if (view.revision !== expectedRevision) araFail('ARA_REVISION_CONFLICT', 'The review changed. Refresh before acting; your unsaved feedback is preserved in the browser.');
      if (input.action === 'preview') { await refresh({ launch: true, actionId }); return { message: 'Verified preview opened. Try the application in its controlled browser window, then return here.' }; }
      if (input.action === 'refresh') { await refresh({ launch: false, actionId }); return { message: 'Delivery and submitted results refreshed. Inspect the current result before accepting it.' }; }
      if (input.action === 'request-repair') {
        const payload = { findingId: input.findingId };
        await mutateApplicationReview(root, { ...options(view, actionId, payload), type: 'finding-repair-requested', human: grant(payload), prepare: () => {
          const finding = view.findings.find(item => item.id === input.findingId);
          if (!finding || ['repairing', 'ready-for-repair', 'resolved', 'dismissed', 'duplicate'].includes(finding.state)) araFail('ARA_REPAIR_NOT_READY', 'Continue the existing attempt or recheck; no duplicate repair was created.');
          return payload;
        } });
        return { message: 'Repair requested for the same finding. Continue through /sf-code; its existing attempt budget and scope remain in force.' };
      }
      if (input.action === 'recheck') {
        if (!['fixed', 'still-failing', 'cannot-reproduce', 'blocked'].includes(input.result) || input.reason.trim().length < 10) araFail('ARA_RECHECK_INVALID', 'Choose your observed result and explain what you tried in at least 10 characters.');
        const payload = { findingId: input.findingId, result: input.result, reason: input.reason, targetId: input.targetId };
        await mutateApplicationReview(root, { ...options(view, actionId, payload), type: 'finding-rechecked', human: grant(payload), prepare: async ({ config, workflow }) => {
          const finding = view.findings.find(item => item.id === input.findingId);
          if (!finding || !await reviewTargetCurrent(root, config, workflow, view.target)) araFail('ARA_REVIEW_STALE', 'Recheck the current delivery; this finding or target changed.');
          if (input.result === 'fixed' && !view.target.results.ready) araFail('ARA_RECHECK_EVIDENCE_REQUIRED', 'A fixed recheck needs the applicable authoritative test results.');
          return payload;
        } });
        return { message: input.result === 'fixed' ? 'Your fixed recheck was recorded. Overall acceptance remains separate.' : 'Your observation was recorded; the finding remains open.' };
      }
      if (['dismiss', 'duplicate'].includes(input.action)) {
        if (input.reason.trim().length < 10) araFail('ARA_DISPOSITION_REASON_REQUIRED', 'Explain the actual disposition in at least 10 characters.');
        const payload = { findingId: input.findingId, disposition: input.action === 'duplicate' ? 'duplicate' : 'dismissed',
          duplicateOf: input.action === 'duplicate' ? input.duplicateOf : null, reason: input.reason.trim() };
        await mutateApplicationReview(root, { ...options(view, actionId, payload), type: 'finding-dispositioned', human: grant(payload), prepare: () => {
          if (!view.findings.some(item => item.id === payload.findingId)) araFail('ARA_FINDING_NOT_FOUND', 'This finding no longer belongs to the review.');
          const proposed = view.findings.map(item => item.id === payload.findingId ? { ...item, duplicateOf: payload.duplicateOf } : item);
          findingRoot(proposed, payload.findingId);
          return payload;
        } });
        return { message: input.action === 'duplicate' ? 'Duplicate recorded. The original problem and its consumed repair budget remain owed.' : 'Your explicit disposition was recorded; it does not waive another criterion or a failing check.' };
      }
      if (input.action === 'accept') {
        if (view.target.applicability.surface === 'web' && (!preview || reviewDigest(preview.binding) !== reviewDigest(view.target.binding))) {
          araFail('ARA_TARGET_UNVERIFIED', 'This host has not established the target’s exact browser instance. Start its verified preview and inspect that result before confirmation.');
        }
        const { workflow } = await loadAcceptedStoryExecution(root, workId);
        const session = findReviewSession(workflow, sessionId);
        const report = reviewReportPages(view.target.results, session.policy.capture);
        const capturePlan = { applicationUi: view.target.applicability.surface === 'web', reportDigest: reviewDigest(report),
          resultPages: report.pages.map(item => item.id), limits: session.policy.capture,
          pageFingerprint: view.target.applicability.surface === 'web' ? await reviewedPageFingerprint(preview) : null };
        const payload = { dimensions: input.dimensions, coverage: input.coverage, capturePlan };
        await confirmApplicationReview(root, { ...options(view, actionId, payload), human: grant(payload) });
        return capture(`${actionId}-capture`);
      }
      if (input.action === 'capture') return capture(actionId);
      if (input.action === 'defer' || input.action === 'close') {
        await mutateApplicationReview(root, { ...options(view, actionId), type: input.action === 'defer' ? 'review-deferred' : 'review-cancelled', prepare: () => ({}) });
        if (input.action === 'close') setTimeout(() => close(), 100).unref();
        return { message: input.action === 'defer' ? 'Review deferred. Required acceptance remains owed.' : 'Review closed; only its owned preview is stopped. Your edits and evidence are preserved.' };
      }
      araFail('ARA_ACTION_INVALID', 'Choose an action shown by the current review.');
    } finally { busy = false; }
  };
  const renderReport = async (view, index) => {
    if (view.state === 'stale') araFail('ARA_REVIEW_STALE', 'Refresh the review before inspecting replacement test results.');
    const { workflow } = await loadAcceptedStoryExecution(root, workId);
    const pages = reviewReportPages(view.target.results, findReviewSession(workflow, sessionId).policy.capture);
    if (!pages.pages[index]) araFail('ARA_REPORT_PAGE_UNAVAILABLE', 'This result page does not exist. Return to the review and refresh.');
    const warning = !pages.complete ? `<p>The retained report is incomplete at the adopted limit: ${pages.missingCases} missing case records; ${pages.omittedPages} omitted pages. No missing case is assumed passed.</p>` : '';
    return { html: applicationResultHtml(pages.pages[index], view.target).replace('<h1>', `${warning}<h1>`), pages: pages.pages.length };
  };
  const renderImage = async digest => {
    const bytes = await readFile(path.join(reviewLocalRoot(root), 'artifacts', `${digest}.png`));
    if (bytesDigest(bytes) !== `sha256:${digest}` || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) araFail('ARA_EVIDENCE_UNAVAILABLE', 'The admitted image is missing or changed. Its receipt is retained.');
    return bytes;
  };
  const server = await createApplicationReviewHumanServer({ root, sessionId, read, render: applicationReviewPage, perform, renderReport, renderImage, identity });
  const close = async () => {
    if (closed) return; closed = true; clearTimeout(lifecycleTimer); lifecycleWatch?.close(); server.close(); await preview?.close();
    onClose();
  };
  return { ...server, close, read, identity };
}
