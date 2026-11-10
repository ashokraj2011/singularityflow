/** Adapt existing verified readers into the shared evidence account; never a new authority. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { projectEvidenceConsistency } from './evidence-consistency.mjs';
import { recordSha256 } from './records.mjs';

/**
 * Callers that already read execution evidence, witnesses or documents pass those observations.
 * No permanent memo: a subsequent invocation observes changed sources, revocations and expiry.
 * Heavy readers are lazy so importing a presentation adapter does not enlarge fast CLI closures.
 */
export async function readEvidenceConsistency(root, config, workflow, phase, options = {}) {
  const executionEvidence = Object.hasOwn(options, 'executionEvidence') ? options.executionEvidence
    : await (await import('./phase-execution-evidence.mjs')).phaseExecutionEvidence(root, config, workflow, phase);
  const visualReviews = Object.hasOwn(options, 'visualReviews') ? options.visualReviews
    : await (await import('./verification/witness-decisions.mjs')).phaseWitnessDecisions(root, workflow, phase);
  const { upstreamIssueStates } = await import('./upstream-routes.mjs');
  const issues = upstreamIssueStates(workflow, options.at ?? new Date().toISOString()).map(({ issue, decision, status, supersededBy }) => ({
    id: issue.id, phase: issue.phase, about: issue.about, problem: issue.problem,
    issueSha256: `sha256:${recordSha256(issue)}`, decisionSha256: decision ? `sha256:${recordSha256(decision)}` : null,
    status, supersededBy, decision: decision ? { outcome: decision.outcome, actor: decision.actor,
      authorityGroup: decision.authorityGroup, expiresAt: decision.expiresAt ?? null } : null
  }));
  const { phaseReadsWitnessDecisions } = await import('./verification/witness-decisions.mjs');
  const reporting = phaseReadsWitnessDecisions(workflow, phase);
  let documents = options.documents ?? null;
  const findings = [];
  const { isTestEvidencePhase } = await import('./kernel/phase-policy.mjs');
  for (const entry of executionEvidence?.entries ?? []) {
    if (entry.status !== 'no-governed-tests-in-this-packet' || !isTestEvidencePhase(workflow.phases?.[entry.phase])) continue;
    const reused = (executionEvidence.reusedTestEvidence ?? []).filter((item) => item.phase === entry.phase && item.state === 'active');
    findings.push({ code: 'evidence.execution-unretained', path: entry.path ?? null,
      message: `${entry.phase} generation ${entry.generation} has no retained test execution in its packet. `
        + (reused.length ? `Approved reuse: ${reused.map((item) => item.id).join(', ')}; those runs remain attributed to their producer.`
          : 'No approved reuse is established here. A narrative test-pass claim is not established by this packet.'),
      blocking: false });
  }
  if (!documents && reporting && phase.requiredArtifact?.path) {
    const relative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, phase.requiredArtifact.path);
    const { secureRepositoryPath } = await import('./util.mjs');
    try {
      const safe = await secureRepositoryPath(root, relative, { label: 'Evidence report', mustExist: false, type: 'file' });
      documents = safe.exists ? [{ path: relative, content: await readFile(safe.absolute, 'utf8') }] : [];
    } catch (error) {
      // An unavailable report is not evidence of consistency. Do not expose arbitrary path/error text.
      findings.push({ code: error.code ?? 'EVIDENCE_REPORT_UNAVAILABLE', path: relative,
        message: 'The report could not be inspected; no report-consistency claim is established.', blocking: false });
    }
  }
  const reportedVerdicts = [];
  const documentBindings = [];
  for (const document of documents ?? []) {
    const relative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, phase.requiredArtifact?.path ?? '');
    if (document.path !== relative) continue;
    if (document.error || document.truncated || document.binary || typeof document.content !== 'string') {
      findings.push({ code: 'EVIDENCE_REPORT_PARTIAL', path: document.path,
        message: 'The complete report was not available in this read; no report-consistency claim is established.', blocking: false });
      continue;
    }
    const { authoredArtifactText } = await import('./artifact-review-read.mjs');
    // Bind authored content, not volatile approval metadata or copies of earlier approved inputs.
    const authored = authoredArtifactText(document.content);
    documentBindings.push({ path: document.path,
      authoredSha256: createHash('sha256').update(authored).digest('hex') });
    if (!reporting) continue;
    const [{ conformanceTableRows }, { inspectConformanceVerdictAdvisories }, { witnessReportFindings }] = await Promise.all([
      import('./engine-compatibility/node-specification-policy.mjs'), import('./conformance-readiness.mjs'), import('./verification/witness-report-findings.mjs')]);
    // Those readers already blank managed content while preserving original file line numbers.
    reportedVerdicts.push(...conformanceTableRows(document.content).map((row) => ({ ...row, path: document.path, assurance: 'authored-claim' })));
    findings.push(...[...inspectConformanceVerdictAdvisories(document.content, { workflow, phaseId: phase.id,
      now: options.at, reused: (executionEvidence?.reusedTestEvidence ?? []).filter((entry) => entry.state === 'active') }),
    ...witnessReportFindings(document.content, visualReviews?.reviews ?? [])]
      .map((entry) => ({ ...entry, path: document.path })));
    const { upstreamDiscrepanciesFromMarkdown, discrepancySteps } = await import('./kernel/phase-upstream-discrepancies.mjs');
    const { discrepancyIssueRequests } = await import('./upstream-issues.mjs');
    const order = workflow.phaseOrder ?? [];
    const earlier = order.slice(0, Math.max(0, order.indexOf(phase.id)));
    const parsed = upstreamDiscrepanciesFromMarkdown(authored, discrepancySteps(workflow), { earlier });
    const discrepancies = discrepancyIssueRequests(workflow, parsed.map((item) => ({ path: document.path, item })));
    for (const request of discrepancies.requests.filter((item) => item.supersedes)) findings.push({
      code: 'evidence.discrepancy-owner-mismatch', path: document.path,
      message: `${request.supersedes} was filed against another phase, but the source item names ${request.phase}. `
        + 'Use upstream-issue raise --from-artifact to propose its superseding record; the original history and owner decision are preserved.',
      blocking: false
    });
    for (const item of discrepancies.unowned) findings.push({ code: 'evidence.discrepancy-owner-unresolved', path: document.path,
      message: `A discrepancy has no single earlier owning phase (${item.owner.status}); name its owner explicitly, never guess from incidental mentions.`, blocking: false });
  }
  return projectEvidenceConsistency({ workflow, phase, executionEvidence, visualReviews,
    issues, reportedVerdicts, documents: documentBindings,
    findings: findings.map((entry) => ({ code: entry.code, path: entry.path ?? null,
      clauseId: entry.clauseId ?? null, line: entry.line ?? null, message: entry.message,
      ...(entry.record ? { record: entry.record } : {}),
      blocking: false, requiredBefore: entry.requiredBefore ?? null })) });
}
