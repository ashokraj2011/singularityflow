/**
 * What the decision list reads beyond what blocks a step (decision-list-facts.mjs): [decision list]
 *
 * - Reusable runs: each retained, passed attempt of an earlier step, checked by prepareEvidenceReuse
 *   for the step that recorded no run of its own, so a reuse is offered only when the person could
 *   record it now on unchanged source.
 * - Test-run risks, while the step is in progress: its test commands whose latest run stopped before
 *   any test executed, as `decision test-risk` sees them.
 * - Screen sizes: each verification profile enforced coverage still lacks at the visual step that
 *   holds this one, as visualProfileDecisionOptions words it.
 *
 * Reads only; loaded by the list alone, never on a hot path.
 */
import { blockingDecisionFacts } from './decision-list-facts.mjs';
import { workDir } from './story-paths.mjs';
import { SingularityFlowError } from './util.mjs';

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

/**
 * The step's test commands whose latest recorded run failed or was blocked before any test executed
 * and that no active decision covers: what `decision test-risk` would accept now, read the same way.
 */
async function testRisks(root, config, workflow, phase, at) {
  if (phase?.status !== 'in_progress') return [];
  const [{ latestStepAttempts }, { testRunRiskIneligibility, testRunRiskState }, { workDirRelative }] = await Promise.all([
    import('./verification/attempts.mjs'), import('./test-run-risk.mjs'), import('./story-paths.mjs')]);
  const latest = await latestStepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
  return [...latest.values()].map((attempt) => ({ attempt,
    state: testRunRiskState(workflow, { phaseId: phase.id, commandId: attempt.commandId, argvSha256: attempt.argvSha256 }, { at })?.state ?? null }))
    .filter(({ attempt, state }) => !testRunRiskIneligibility(attempt) && state !== 'active')
    .sort((left, right) => left.attempt.commandId.localeCompare(right.attempt.commandId))
    .map(({ attempt, state }) => ({ phase: phase.id, commandId: attempt.commandId, attemptId: attempt.attemptId ?? null, status: attempt.status,
      exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, argvSha256: attempt.argvSha256 ?? null, lapsed: state }));
}

/**
 * The screen sizes enforced visual coverage still lacks at the visual step that holds `phase` (the
 * step itself or one before it): one entry per profile, worded by visualProfileDecisionOptions.
 */
async function visualProfiles(root, config, workflow, phase) {
  if (!(workflow.resolution?.verification?.profiles ?? []).length) return [];
  const [{ evaluateVisualCoverage }, { visualProfileDecisionOptions }] = await Promise.all([
    import('./visual-coverage.mjs'), import('./visual-profile-decisions.mjs')]);
  let coverage;
  try { coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id), phaseId: phase.id }); }
  catch (error) { if (error instanceof SingularityFlowError) return []; throw error; }
  const order = workflow.phaseOrder ?? [];
  if (coverage.mode !== 'enforce' || !coverage.uncovered?.length || !coverage.phase || order.indexOf(coverage.phase) > order.indexOf(phase.id)) return [];
  return visualProfileDecisionOptions(workflow, coverage.phase, coverage);
}

/** Everything the decision list of `phaseId` is built from: what blocks it, plus the readers above. */
export async function decisionListFacts(root, config, workflow, { phaseId = workflow?.currentPhase ?? null, at = new Date().toISOString() } = {}) {
  const { phase, reports, ...blocking } = await blockingDecisionFacts(root, config, workflow, { phaseId, at });
  const reuse = await reuseCandidates(root, config, workflow, reports);
  return {
    ...blocking,
    candidates: reuse.candidates, reuseProblems: reuse.problems,
    testRisks: await testRisks(root, config, workflow, phase, at),
    visual: await visualProfiles(root, config, workflow, phase),
    state: {
      phases: Object.fromEntries((workflow.phaseOrder ?? []).map((id) => [id, `${workflow.phases?.[id]?.status}:${Number(workflow.phases?.[id]?.generation ?? 0)}`])),
      upstreamIssues: (workflow.upstreamIssues ?? []).length, upstreamIssueDecisions: (workflow.upstreamIssueDecisions ?? []).length,
      evidenceReuses: (workflow.evidenceReuses ?? []).length, testRunRisks: (workflow.testRunRisks ?? []).length,
      visualProfileDecisions: (workflow.visualProfileDecisions ?? []).length,
      reports: Object.fromEntries(reports.map((entry) => [entry.step.id, entry.digest])),
      runs: reuse.candidates.map((entry) => `${entry.attemptId}:${entry.consumer}:${entry.treeSha256}`)
    }
  };
}

