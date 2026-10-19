/**
 * One read-only account of retained evidence, shared by prompts, reports and review surfaces.
 *
 * This is a projection, not another evidence store or evaluator. Its inputs have already been
 * checked by phaseExecutionEvidence, the witness reader and the conformance/issue readers. In
 * particular a passed command is not a clause verdict, an approval is not a test execution, and
 * an approved reuse is never presented as a run recorded by its consumer. No clock or I/O here.
 */
import { recordSha256 } from './records.mjs';

export const EVIDENCE_CONSISTENCY_REVISION = 'evidence-consistency-v1';
export const EVIDENCE_CONSISTENCY_HEADING = '# Evidence consistency';
export const MAX_EVIDENCE_CONSISTENCY_BYTES = 32 * 1024;
export const EVIDENCE_CONSISTENCY_INSTRUCTION = 'Use this read-only account for evidence provenance and outstanding decisions. A missing retained execution record does not prove tests never ran; it means that run is not established by the retained packet. Earlier runs remain attributed to their producer, even after approved reuse. Reported clause verdicts are author claims, not verdicts established by this projection. Keep gaps and exceptions visible; never infer approval, invent results, or edit approved records to make a report consistent.';
const PHASE_LIMIT = 32;
const ITEM_LIMIT = 50;

function projectRun(check, entry) {
  const execution = (entry.executions ?? []).find((item) => item.commandId === check.commandId);
  return {
    attemptId: execution?.attemptId ?? null, commandId: check.commandId, outcome: check.outcome, binding: check.binding,
    sourceCommit: check.sourceCommit ?? null,
    receiptPath: execution?.path ?? null, receiptSha256: execution?.sha256 ?? null,
    counts: execution?.counts ?? null, assurance: execution?.assurance ?? null,
    structuredTestsReusable: check.structuredTestsReusable === true,
    criterionVerdict: 'not-established-by-suite-counts'
  };
}

function phaseFacts(workflow, phase, executionEvidence) {
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  const position = order.indexOf(phase?.id);
  const ids = position < 0 ? [] : order.slice(0, position + 1);
  return ids.map((id) => {
    const step = workflow.phases[id];
    const packet = executionEvidence?.entries?.find((entry) => entry.phase === id
      && Number(entry.generation) === Number(step.generation));
    const diagnostics = (executionEvidence?.diagnostics ?? []).filter((item) => item.phase === id);
    const submitted = (workflow.lineage?.submissions ?? []).some((entry) => entry.phase === id
      && Number(entry.generation) === Number(step.generation));
    const status = step.status === 'skipped' ? 'skipped'
      : packet ? packet.status : diagnostics.length ? 'unavailable'
        : submitted ? 'not-projected' : 'no-retained-submission';
    return {
      phase: id, generation: Number(step.generation ?? 0), phaseStatus: step.status,
      status, packetSha256: packet?.packetSha256 ?? null, packetPath: packet?.path ?? null,
      sourceTreeSha256: packet?.sourceTreeSha256 ?? null,
      runs: (packet?.checks ?? []).map((check) => projectRun(check, packet)),
      omittedChecks: packet?.omittedChecks ?? 0, omittedExecutions: packet?.omittedExecutions ?? 0,
      diagnostics: diagnostics.map((item) => ({ code: item.code, status: item.status }))
    };
  });
}

function ownEvidenceLine(entry) {
  const who = `${entry.phase} generation ${entry.generation}`;
  if (entry.status === 'no-governed-tests-in-this-packet') return `${who}: no test execution is retained in this packet; this does not establish a separate test run.`;
  if (!entry.runs.length) return `${who}: ${entry.status}; no passing execution is established by this projection.`;
  return `${who}: ${entry.runs.map((run) => {
    const counts = run.counts ? `${run.counts.passed} passed, ${run.counts.failed} failed, ${run.counts.skipped} skipped` : 'no structured counts';
    return `${run.commandId}: ${run.outcome}, ${counts}; source binding ${run.binding}`;
  }).join('; ')}. Suite counts alone do not establish a clause verdict.`;
}

/** All human-facing adapters render these same lines instead of interpreting evidence again. */
export function evidenceConsistencyLines(snapshot) {
  if (!snapshot) return [];
  const lines = [
    'Read-only retained facts; not a new run, clause acceptance, publication or approval.',
    ...snapshot.phases.map(ownEvidenceLine),
    ...snapshot.reuses.map((entry) => `${entry.state === 'active' ? 'Approved reuse' : 'Reuse not active'}: ${entry.label}`),
    ...snapshot.visualReviews.map((entry) => `${entry.id}: ${entry.clauseId}, slot ${entry.slot}: ${entry.valid ? 'recorded human review satisfies this slot' : 'review does not currently satisfy this slot'}; file binding ${entry.binding}, candidate ${entry.candidate}.`),
    ...snapshot.issues.map((entry) => `${entry.id}: owned by ${entry.phase}; ${entry.status}${entry.decision ? ` (${entry.decision.outcome})` : '; human decision outstanding'}${entry.supersededBy ? `; superseded by ${entry.supersededBy}, original history retained` : ''}.`),
    ...snapshot.findings.map((entry) => `Reconcile ${entry.code}: ${entry.message}`)
  ];
  const omitted = Object.entries(snapshot.omitted).filter(([, count]) => count > 0);
  if (omitted.length) lines.push(`Not shown: ${omitted.map(([kind, count]) => `${count} ${kind}`).join(', ')}. Omission is not passing evidence.`);
  return lines;
}

/** Build from verified observations. It does not promote a narrative claim or make any decision. */
export function projectEvidenceConsistency({ workflow, phase, executionEvidence = null, visualReviews = null,
  reportedVerdicts = [], findings = [], issues = [], documents = [] }) {
  const allPhases = phaseFacts(workflow, phase, executionEvidence);
  const allReviews = visualReviews?.reviews ?? [];
  const allReuses = executionEvidence?.reusedTestEvidence ?? [];
  const core = {
    revision: EVIDENCE_CONSISTENCY_REVISION, readOnly: true,
    workId: workflow.workItem.id, phase: phase.id, generation: Number(phase.generation ?? 0),
    // Keep the individual input identities so this digest can be reconstructed, not trusted alone.
    inputs: { executionEvidenceSha256: executionEvidence?.projectionSha256 ?? null,
      visualReviewsSha256: visualReviews?.projectionSha256 ?? null, documents },
    current: executionEvidence?.current ?? null,
    phases: allPhases.slice(-PHASE_LIMIT),
    reuses: allReuses.slice(0, ITEM_LIMIT).map((entry) => ({
      id: entry.id, phase: entry.phase, recordedBy: entry.recordedBy, attemptId: entry.attemptId,
      state: entry.state, clauses: entry.clauses ?? [], label: entry.label,
      runRecordedByConsumer: false
    })),
    visualReviews: allReviews.slice(0, ITEM_LIMIT).map((entry) => ({
      id: entry.id, clauseId: entry.clauseId, slot: entry.slot, method: entry.method,
      file: entry.file, sha256: entry.sha256, actor: entry.actor ?? null,
      authorityGroup: entry.authorityGroup ?? null, binding: entry.binding,
      candidate: entry.candidate, valid: entry.valid === true
    })),
    reportedVerdicts: reportedVerdicts.slice(0, ITEM_LIMIT).map((row) => ({
      clauseId: row.clauseId, verdict: /^(matched|partial|missing|deviated|unplanned)(?:\s|\(|$)/u.exec(row.verdict)?.[1] ?? 'unrecognized',
      verdictSha256: `sha256:${recordSha256(row.verdict)}`, path: row.path, line: row.line,
      assurance: 'authored-claim'
    })),
    issues: issues.slice(0, ITEM_LIMIT).map((entry) => ({
      id: entry.id, phase: entry.phase, about: entry.about,
      issueSha256: entry.issueSha256 ?? null,
      decisionSha256: entry.decisionSha256 ?? null,
      problemSha256: `sha256:${recordSha256(entry.problem ?? null)}`,
      status: entry.status, supersededBy: entry.supersededBy ?? null,
      decision: entry.decision ?? null
    })),
    findings: findings.slice(0, ITEM_LIMIT),
    omitted: {
      phases: Math.max(0, allPhases.length - PHASE_LIMIT),
      packets: executionEvidence?.omittedPackets ?? 0,
      reuses: Math.max(0, allReuses.length - ITEM_LIMIT),
      visualReviews: Math.max(0, allReviews.length - ITEM_LIMIT) + (visualReviews?.omittedReviews ?? 0),
      reportedVerdicts: Math.max(0, reportedVerdicts.length - ITEM_LIMIT),
      issues: Math.max(0, issues.length - ITEM_LIMIT), findings: Math.max(0, findings.length - ITEM_LIMIT)
    },
    instruction: EVIDENCE_CONSISTENCY_INSTRUCTION
  };
  core.summary = evidenceConsistencyLines(core);
  // Bounded handoff, not another copy of the full artifact/issue database. Drop only whole
  // observations, explicitly counted. No instruction, permission or decision is sliced.
  while (Buffer.byteLength(JSON.stringify(core)) > MAX_EVIDENCE_CONSISTENCY_BYTES - 100) {
    const kind = ['reportedVerdicts', 'issues', 'findings', 'visualReviews', 'reuses', 'phases']
      .find((name) => core[name].length);
    if (!kind) break;
    core[kind].pop(); core.omitted[kind] += 1;
    core.summary = evidenceConsistencyLines(core);
  }
  return { ...core, projectionSha256: `sha256:${recordSha256(core)}` };
}

/** This account explains retained facts; normal fresh lifecycle/authority gates still decide. */
export function renderEvidenceConsistency(snapshot) {
  return snapshot ? [EVIDENCE_CONSISTENCY_HEADING, '', snapshot.instruction, '',
    `Projection: ${snapshot.projectionSha256}`, ...snapshot.summary.map((line) => `- ${line}`)].join('\n') : '';
}

/** Deliver new facts beside a historical prompt without rewriting its approved/persisted bytes. */
export function withEvidenceConsistencyRefresh(text, record, snapshot) {
  if (!snapshot || record?.promptBudget?.evidenceConsistency?.projectionSha256 === snapshot.projectionSha256) return text;
  return `${text.trimEnd()}\n\n# Current evidence-consistency refresh\n\nThis read-only account supersedes earlier evidence summaries only. Retained prompts, artifacts and approvals remain unchanged.\n\n${renderEvidenceConsistency(snapshot)}\n`;
}
