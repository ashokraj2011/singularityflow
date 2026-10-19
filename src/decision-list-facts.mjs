/**
 * The recorded facts the decision list is built from, read with the same readers approval and the
 * gates use, so the list and a refusal never disagree about what is open. [decision list]
 *
 * - Conformance gaps: every partial or missing verdict of the step itself (when it writes a
 *   conformance report) and of every approved conformance step, read from the report and decided by
 *   conformanceGapDecisions with the evidence reuses that still hold, exactly as approval reads them.
 * - Upstream issues: upstreamIssueStates; a superseded issue is not open.
 * - Reusable runs (only when asked): each retained, passed attempt of an earlier step checked by
 *   prepareEvidenceReuse for the step that recorded no run of its own, so a reuse is offered only
 *   when the person could record it now on unchanged source.
 * - Test-run risks (only when asked, while the step is in progress): its test commands whose latest
 *   run stopped before any test executed, as `decision test-risk` sees them.
 *
 * Reads only; heavy readers load on first use. The pending-decision summary used by next steps and
 * refusals reads nothing when no conformance report or open issue exists.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { conformancePhasesOf, isConformancePhase } from './phase-roles.mjs';
import { OPEN_UPSTREAM_ISSUE_STATUSES, conformanceGapDecisions, upstreamIssueStates } from './upstream-routes.mjs';
import { workDir } from './story-paths.mjs';
import { SingularityFlowError } from './util.mjs';

const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Whether completing `phase` would end the Story: every later step is skipped. */
export function phaseEndsStory(workflow, phase) {
  const order = workflow?.phaseOrder ?? [];
  const index = order.indexOf(phase?.id);
  return index >= 0 && order.slice(index + 1).every((id) => workflow.phases?.[id]?.status === 'skipped');
}

function writesConformanceReport(phase) {
  return phase?.requiredArtifact?.kind === 'conformance-report' || isConformancePhase(phase);
}

/** The conformance steps whose gaps hold `phase` back: its own report, and every approved one. */
function blockingReportSteps(workflow, phase) {
  const steps = new Map();
  for (const candidate of conformancePhasesOf(workflow)) {
    if (candidate.status === 'approved' && Number(candidate.generation) > 0) steps.set(candidate.id, candidate);
  }
  if (writesConformanceReport(phase) && Number(phase.generation) > 0 && phase.status !== 'skipped') steps.set(phase.id, phase);
  const order = workflow?.phaseOrder ?? [];
  return [...steps.values()].filter((step) => step.requiredArtifact?.path).sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}

/** Whether anything could be open for `phase` without reading a file. */
export function decisionsMayBePending(workflow, phase) {
  if (!phase) return false;
  if (blockingReportSteps(workflow, phase).length) return true;
  return phaseEndsStory(workflow, phase)
    && upstreamIssueStates(workflow).some((state) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(state.status));
}

async function reportGaps(root, config, workflow, step, at) {
  const [{ conformanceVerdictGaps }, { conformanceEvidenceReuse }] = await Promise.all([
    import('./conformance-verdicts.mjs'), import('./conformance-readiness.mjs')]);
  const file = path.join(workDir(root, config, workflow.workItem.id), step.requiredArtifact.path);
  const report = await readFile(file, 'utf8');
  const reused = await conformanceEvidenceReuse(root, config, workflow, step.id, at);
  const gaps = conformanceGapDecisions(workflow, step.id, conformanceVerdictGaps(report), { now: at, reused })
    .filter((gap) => gap.status !== 'decided')
    .map((gap) => ({ report: step.id, clauseId: gap.clauseId, verdict: gap.verdict, line: gap.line ?? null, owner: gap.owner,
      status: gap.status, issue: gap.issue, expiresAt: gap.expiresAt ?? null, choices: gap.choices }));
  return { gaps, digest: sha256(report), reused };
}

/** The step that would stand on a reused run: the first after the producer with no run of its own, else the report's step. */
function reuseConsumer(workflow, producerId, reportId) {
  const order = workflow.phaseOrder ?? [];
  for (const id of order.slice(order.indexOf(producerId) + 1, order.indexOf(reportId) + 1)) {
    const step = workflow.phases?.[id];
    if (!step || step.status === 'skipped' || !(Number(step.generation) > 0)) continue;
    if (!(step.deliveryEvidence?.testExecutions ?? []).some((entry) => entry?.attemptId)) return id;
  }
  return reportId;
}

/** Retained, passed attempts recorded by steps before `reportId`, each with the step that would reuse it. */
function recordedAttempts(workflow, reportId) {
  const order = workflow.phaseOrder ?? [];
  const attempts = [];
  for (const id of order.slice(0, Math.max(0, order.indexOf(reportId)))) {
    const step = workflow.phases?.[id];
    if (step?.status !== 'approved') continue;
    for (const execution of step.deliveryEvidence?.testExecutions ?? []) {
      if (!execution?.attemptId || execution.status !== 'passed' || execution.kind === 'phase-validation-observation' || execution.testRunRisk) continue;
      attempts.push({ attemptId: execution.attemptId, producer: id, consumer: reuseConsumer(workflow, id, reportId) });
    }
  }
  return attempts;
}

function reuseProblemWords(workflow, producer, code) {
  const name = workflow.phases?.[producer]?.label ?? producer;
  if (code === 'EVIDENCE_REUSE_SOURCE_CHANGED') return `The code changed after ${name}'s recorded run, so that run cannot stand for it; a fresh recorded run or a return is needed.`;
  if (code === 'EVIDENCE_REUSE_SOURCE_UNAVAILABLE') return `The current code could not be compared with ${name}'s recorded run, so it is not offered for reuse.`;
  return `${name}'s recorded run does not qualify for reuse here.`;
}

async function reuseCandidates(root, config, workflow, reports) {
  const candidates = [];
  const problems = [];
  const seen = new Set();
  for (const report of reports.filter((entry) => entry.gaps.length)) {
    const attempts = recordedAttempts(workflow, report.step.id);
    if (!attempts.length) {
      problems.push({ producer: null, code: 'NO_RECORDED_RUN', clauses: [], words: 'No earlier step retained a recorded test run that could stand for it.' });
      continue;
    }
    const { prepareEvidenceReuse } = await import('./evidence-reuse.mjs');
    for (const attempt of attempts) {
      const key = `${attempt.attemptId}\u0000${attempt.consumer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const prepared = await prepareEvidenceReuse(root, config, workflow, { phaseId: attempt.consumer, attemptId: attempt.attemptId });
        candidates.push({ attemptId: attempt.attemptId, producer: attempt.producer, consumer: attempt.consumer,
          tests: prepared.attempt.tests ?? null, clauses: prepared.clauses ?? [], sourceCommit: prepared.source.commit,
          treeSha256: prepared.source.treeSha256 });
      } catch (error) {
        if (!(error instanceof SingularityFlowError)) throw error;
        problems.push({ producer: attempt.producer, code: error.code ?? 'EVIDENCE_REUSE_NOT_ELIGIBLE', clauses: [],
          words: reuseProblemWords(workflow, attempt.producer, error.code), detail: error.message });
      }
    }
  }
  return { candidates, problems };
}

async function testRisks(root, config, workflow, phase, at) {
  if (phase?.status !== 'in_progress') return [];
  const [{ testRunRiskCandidates }, { testRunRiskState }] = await Promise.all([
    import('./commands/decision-test-risk.mjs'), import('./test-run-risk.mjs')]);
  return (await testRunRiskCandidates(root, config, workflow, phase.id, { at })).map((attempt) => ({
    phase: phase.id, commandId: attempt.commandId, attemptId: attempt.attemptId ?? null, status: attempt.status,
    exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, argvSha256: attempt.argvSha256 ?? null,
    lapsed: testRunRiskState(workflow, { phaseId: phase.id, commandId: attempt.commandId, argvSha256: attempt.argvSha256 }, { at })?.state ?? null
  }));
}

/**
 * Everything the decision list of `phaseId` is built from. `candidates` adds reusable runs and
 * `testRisks` the step's tests that could not run; both are off for a count.
 */
export async function decisionListFacts(root, config, workflow, { phaseId = workflow?.currentPhase ?? null, at = new Date().toISOString(),
  candidates = true, includeTestRisks = true } = {}) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  if (!phase) {
    throw new SingularityFlowError(phaseId ? `Story ${workflow?.workItem?.id} has no step ${phaseId}.` : `Story ${workflow?.workItem?.id} has no current step.`,
      { code: 'DECISIONS_PHASE_UNKNOWN' });
  }
  const reports = [];
  const unavailable = [];
  for (const step of blockingReportSteps(workflow, phase)) {
    try { reports.push({ step, ...await reportGaps(root, config, workflow, step, at) }); }
    catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SingularityFlowError)) throw error;
      unavailable.push({ phase: step.id, reason: error.code ?? 'unreadable' });
    }
  }
  const issues = upstreamIssueStates(workflow, at);
  const reuse = candidates ? await reuseCandidates(root, config, workflow, reports) : { candidates: [], problems: [] };
  const activeReuse = [...new Map(reports.flatMap((entry) => entry.reused ?? []).map((entry) => [entry.id, entry])).values()];
  return {
    phaseId: phase.id, at, endsStory: phaseEndsStory(workflow, phase),
    gaps: reports.flatMap((entry) => entry.gaps),
    issues, activeReuse,
    candidates: reuse.candidates, reuseProblems: reuse.problems,
    testRisks: includeTestRisks ? await testRisks(root, config, workflow, phase, at) : [],
    unavailable,
    state: {
      phases: Object.fromEntries((workflow.phaseOrder ?? []).map((id) => [id, `${workflow.phases?.[id]?.status}:${Number(workflow.phases?.[id]?.generation ?? 0)}`])),
      upstreamIssues: (workflow.upstreamIssues ?? []).length, upstreamIssueDecisions: (workflow.upstreamIssueDecisions ?? []).length,
      evidenceReuses: (workflow.evidenceReuses ?? []).length, testRunRisks: (workflow.testRunRisks ?? []).length,
      reports: Object.fromEntries(reports.map((entry) => [entry.step.id, entry.digest])),
      runs: reuse.candidates.map((entry) => `${entry.attemptId}:${entry.consumer}:${entry.treeSha256}`)
    }
  };
}

/**
 * How many decisions hold `phase` back from approval or the Story's end, and the one route to them:
 * Copilot `/sf-decide WORK-ID`, Shell `singularity-flow decisions WORK-ID`. Null when none.
 */
export async function pendingDecisionSummary(root, config, workflow, phase, { at = new Date().toISOString() } = {}) {
  if (!decisionsMayBePending(workflow, phase)) return null;
  const [facts, { decisionGroups }, { decisionHeadline }] = await Promise.all([
    decisionListFacts(root, config, workflow, { phaseId: phase.id, at, candidates: false, includeTestRisks: false }),
    import('./decision-list.mjs'), import('./upstream-routes.mjs')]);
  const count = decisionGroups(workflow, { gaps: facts.gaps, issues: facts.issues, includeAllIssues: facts.endsStory }).length;
  if (!count) return null;
  const workId = workflow.workItem.id;
  return { count, headline: decisionHeadline(workflow, phase.id, count), command: `singularity-flow decisions ${workId}`,
    skill: '/sf-decide', copilotCommand: `/sf-decide ${workId}` };
}
