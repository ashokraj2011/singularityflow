/**
 * What the decision list reads beyond what blocks a step (decision-list-facts.mjs): [decision list]
 *
 * - Reusable runs: each retained, passed attempt of an earlier step, checked by prepareEvidenceReuse
 *   for the step that recorded no run of its own, so a reuse is offered only when the person could
 *   record it now on unchanged source.
 * - Test-run risks, while the step is in progress: its test commands whose latest run stopped before
 *   any test executed, as `decision test-risk` sees them; and those whose latest run passed narrowed
 *   with no acceptance covering it, as `decision test-narrowing` sees them.
 * - Screen sizes: each verification profile enforced coverage still lacks at the visual step that
 *   holds this one, as visualProfileDecisionOptions words it.
 * - Everything else that waits for a person (SPEC-OAP M3): the routing decision, intent and forward
 *   amendments, appeals of the step, sign-offs and scope items owed to the ending, what did not
 *   publish, and, while the step awaits approval, the approval check itself.
 *
 * Reads only. `decisions` reads all of it; readiness and next steps read it for the list's count
 * and first item, without reusable runs (readPendingList).
 */
import { blockingDecisionFacts, evidenceDecisionFacts, phaseEndsStory } from './decision-list-facts.mjs';
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
 * and that no active decision covers: what `decision test-risk` would accept now, read the same way;
 * and, from the same runs, the narrowed ones `decision test-narrowing` would accept.
 */
async function testRisks(root, config, workflow, phase, at) {
  if (phase?.status !== 'in_progress') return { risks: [], narrowings: [] };
  const [{ latestStepAttempts }, { testRunRiskIneligibility, testRunRiskState }, { workDirRelative }, { pendingTestNarrowings }] = await Promise.all([
    import('./verification/attempts.mjs'), import('./test-run-risk.mjs'), import('./story-paths.mjs'), import('./test-narrowing.mjs')]);
  const latest = await latestStepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
  return { narrowings: pendingTestNarrowings(workflow, phase.id, latest.values(), { at }), risks: [...latest.values()].map((attempt) => ({ attempt,
    state: testRunRiskState(workflow, { phaseId: phase.id, commandId: attempt.commandId, argvSha256: attempt.argvSha256 }, { at })?.state ?? null }))
    .filter(({ attempt, state }) => !testRunRiskIneligibility(attempt) && state !== 'active')
    .sort((left, right) => left.attempt.commandId.localeCompare(right.attempt.commandId))
    .map(({ attempt, state }) => ({ phase: phase.id, commandId: attempt.commandId, attemptId: attempt.attemptId ?? null, status: attempt.status,
      exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, argvSha256: attempt.argvSha256 ?? null, lapsed: state })) };
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

const FAILED_UPLOAD = Object.freeze(['needs-user', 'attempt-budget-exhausted', 'outcome-unknown']);

/**
 * This repository's uploads whose automatic attempt failed and wait for the person's
 * `sync <INTENT-ID>`. The machine's intent store is read first; only a failed upload costs the
 * repository match, which asks Git for the push remote.
 */
async function failedUploads(root) {
  const { listTransportIntents, transportFaultSummary, transportIntentsForRepository } = await import('./transport-intents.mjs');
  if (!(await listTransportIntents()).some((intent) => FAILED_UPLOAD.includes(intent.status))) return [];
  return (await transportIntentsForRepository(root)).filter((intent) => FAILED_UPLOAD.includes(intent.status))
    .map((intent) => {
      const fault = transportFaultSummary(intent);
      return { intentId: intent.intentId, status: intent.status, cause: fault ? `Git refused it (${fault.reason}).${fault.advice ? ` ${fault.advice}` : ''}` : null };
    });
}

/**
 * What else waits for a person on this Story [SPEC-OAP M3], each from the reader its own command
 * uses. A source that cannot be read is named in `unavailable`, never read as nothing pending.
 * `approvalCheck`, `owed` and `publication` may arrive already read (readiness has them).
 */
async function pendingStateFacts(root, config, workflow, phase, { approvalCheck, owed, publication, unavailable }) {
  const workId = workflow.workItem.id;
  const awaiting = phase.status === 'awaiting_approval' && phase.id === workflow.currentPhase;
  const intentAmendments = (workflow.intentAmendments ?? [])
    .filter((entry) => entry.status === 'proposed' || (entry.status === 'approved' && entry.acknowledgementRequired === true && !entry.acknowledgedAt));
  let forwardAmendments = [];
  if ((workflow.forwardAmendments ?? []).length) {
    const { pendingAmendmentRevalidations, pendingForwardAmendments, revalidateCommand } = await import('./forward-amendments.mjs');
    forwardAmendments = [
      ...pendingForwardAmendments(workflow).map((proposal) => ({ code: 'FORWARD_AMENDMENT_PENDING', amendment: proposal.id, phase: proposal.phase,
        message: `${proposal.id} proposes a corrected ${proposal.phase}; ${proposal.phase}'s approvers have not decided it.`,
        command: `singularity-flow upstream-issue decide-amendment ${proposal.id} --work-id ${workId} --decision approve|reject --reason "<why>" --confirm ${proposal.id}` })),
      ...pendingAmendmentRevalidations(workflow).map((entry) => ({ code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: entry.amendment, phase: entry.phase,
        message: `${entry.phase} read ${entry.producer} before ${entry.amendment} amended it; ${entry.phase}'s approvers have not revalidated it.`,
        command: revalidateCommand(workId, entry) }))
    ];
  }
  let appeals = [];
  if ((workflow.phaseAppeals ?? []).length) {
    try {
      const { phaseAppealStatus } = await import('./phase-appeals.mjs');
      appeals = (await phaseAppealStatus(root, config, workflow, phase)).items
        .filter((entry) => entry.relevant && ['needs-human', 'correction-required', 'needs-reattestation'].includes(entry.status));
    } catch (error) { unavailable.push({ phase: phase.id, reason: error.code ?? 'appeals-unreadable' }); }
  }
  let owedEntries = [];
  const owedRead = owed !== undefined ? owed : awaiting && !phaseEndsStory(workflow, phase)
    ? await (async () => { const { owedDecisions, stepsThrough } = await import('./owed-decisions.mjs'); return owedDecisions(root, config, workflow, stepsThrough(workflow, phase.id)); })()
    : null;
  if (owedRead?.status === 'owed') {
    owedEntries = [...(owedRead.witnesses ?? []).map((entry) => ({ kind: 'witness', ...entry })), ...(owedRead.scopeItems ?? []).map((entry) => ({ kind: 'scope', ...entry }))];
  }
  const check = approvalCheck !== undefined ? approvalCheck : awaiting
    ? (await (await import('./approval-check.mjs')).approvalAdvisories(root, config, workflow, phase))?.approvalCheck ?? null : null;
  let retained = publication ?? null;
  if (retained === null) {
    const { storyPublicationPending } = await import('./story-publication-read.mjs');
    retained = await storyPublicationPending(root, config, workId, { migrate: false }).catch(() => false);
  }
  const transport = await failedUploads(root).catch(() => []);
  const { scopeStepOf } = await import('./phase-roles.mjs');
  return {
    scopePhase: scopeStepOf(workflow)?.id ?? null,
    approvalCheck: check,
    pending: {
      ...(retained ? { publication: { commit: null, cause: 'A commit was recorded here but its publication did not land.' } } : {}),
      ...(workflow.pendingDecision ? { routing: workflow.pendingDecision } : {}),
      intentAmendments, forwardAmendments, appeals, owed: owedEntries, transport
    }
  };
}

/** Everything the decision list of `phaseId` is built from: what blocks it, plus the readers above. */
export async function decisionListFacts(root, config, workflow, { phaseId = workflow?.currentPhase ?? null, at = new Date().toISOString(),
  reuse: offerReuse = true, ...known } = {}) {
  const { phase, reports, ...blocking } = await blockingDecisionFacts(root, config, workflow, { phaseId, at });
  // Reusable runs change an item's options, never how many items there are: a count skips them.
  const reuse = offerReuse ? await reuseCandidates(root, config, workflow, reports) : { candidates: [], problems: [] };
  const state = await pendingStateFacts(root, config, workflow, phase, { ...known, unavailable: blocking.unavailable });
  let evidence = [];
  const tests = await testRisks(root, config, workflow, phase, at);
  try { evidence = await evidenceDecisionFacts(root, config, workflow, phase); }
  catch (error) { blocking.unavailable = [...(blocking.unavailable ?? []), { phase: phase.id, reason: error.code ?? 'evidence-unavailable' }]; }
  return {
    ...blocking,
    ...state,
    evidence,
    candidates: reuse.candidates, reuseProblems: reuse.problems,
    testRisks: tests.risks,
    testNarrowings: tests.narrowings,
    testCommands: (workflow.testCommandDecisions ?? []).length
      ? (await import('./story-test-commands.mjs')).pendingStoryTestCommands(workflow, phase.id) : [],
    visual: await visualProfiles(root, config, workflow, phase),
    state: {
      phases: Object.fromEntries((workflow.phaseOrder ?? []).map((id) => [id, `${workflow.phases?.[id]?.status}:${Number(workflow.phases?.[id]?.generation ?? 0)}`])),
      upstreamIssues: (workflow.upstreamIssues ?? []).length, upstreamIssueDecisions: (workflow.upstreamIssueDecisions ?? []).length,
      evidenceReuses: (workflow.evidenceReuses ?? []).length, testRunRisks: (workflow.testRunRisks ?? []).length,
      testNarrowings: (workflow.testNarrowings ?? []).length,
      testCommandDecisions: (workflow.testCommandDecisions ?? []).length,
      visualProfileDecisions: (workflow.visualProfileDecisions ?? []).length,
      evidence: evidence.map((entry) => `${entry.criterion}:${entry.result}:${entry.witnesses.map((witness) => witness.slot).join(',')}:${entry.risks.length}`),
      reports: Object.fromEntries(reports.map((entry) => [entry.step.id, entry.digest])),
      intentAmendments: (workflow.intentAmendments ?? []).map((entry) => `${entry.id}:${entry.status}:${entry.acknowledgedAt ? 1 : 0}`),
      forwardAmendments: (workflow.forwardAmendmentDecisions ?? []).length + (workflow.amendmentRevalidations ?? []).length,
      pendingDecision: workflow.pendingDecision?.key ?? null,
      runs: reuse.candidates.map((entry) => `${entry.attemptId}:${entry.consumer}:${entry.treeSha256}`)
    }
  };
}

/**
 * The one list as it stands now, for the current Git identity [SPEC-OAP M3]: what `decisions`
 * prints, and what readiness, next steps and every editor surface count from. `known` passes facts
 * a caller already read (`approvalCheck`, `owed`, `publication`); `reuse: false` skips reusable runs,
 * which change options but never the count. `offline: true` (readiness, next steps) names the
 * identity from what this machine knows, never dialling GitHub on a read path.
 */
export async function readPendingList(root, config, workflow, { phaseId = null, at = new Date().toISOString(), requestedPhase = phaseId,
  offline = false, ...known } = {}) {
  const [{ decisionPacket }, { actionActor }, { identity }] = await Promise.all([import('./decision-list.mjs'), import('./commands/kernel.mjs'), import('./git.mjs')]);
  const facts = await decisionListFacts(root, config, workflow, { phaseId: phaseId ?? workflow.currentPhase, at, ...known });
  const actor = offline && !process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? identity(root, { offline: true }) : actionActor(root);
  return decisionPacket(workflow, facts, {
    authorities: workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, actor, at, requestedPhase
  });
}
