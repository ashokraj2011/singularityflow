/**
 * What the decision list reads beyond what blocks a step (decision-list-facts.mjs): [decision list]
 *
 * - Reusable runs: each retained, passed attempt of an earlier step, checked by prepareEvidenceReuse
 *   for the step that recorded no run of its own, so a reuse is offered only when the person could
 *   record it now on unchanged source.
 * - Test-run risks, while the step is in progress: its test commands whose latest run the
 *   environment stopped, by its classified cause, as `decision test-risk` sees them; and those whose
 *   latest run passed narrowed with no acceptance covering it, as `decision test-narrowing` sees them.
 * - Screen sizes: each verification profile enforced coverage still lacks at the visual step that
 *   holds this one, as visualProfileDecisionOptions words it.
 * - Everything else that waits for a person (SPEC-OAP M3): the routing decision, intent and forward
 *   amendments, appeals of the step, sign-offs and scope items owed to the ending, what did not
 *   publish, and, while the step awaits approval, the approval check itself.
 *
 * Reads only. `decisions` reads all of it; readiness and next steps read it for the list's count
 * and first item, without reusable runs (readPendingList).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { blockingDecisionFacts, evidenceDecisionFacts, phaseEndsStory } from './decision-list-facts.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
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
 * The step's test commands whose latest recorded run the environment stopped and that no active
 * decision on its cause class covers: what `decision test-risk` would accept now, read the same way;
 * and, from the same runs, the narrowed ones `decision test-narrowing` would accept.
 */
async function testRisks(root, config, workflow, phase, at) {
  if (phase?.status !== 'in_progress') return { risks: [], narrowings: [] };
  const [{ latestStepAttempts }, { testRunCause, testRunRiskIneligibility, testRunRiskStateFor }, { workDirRelative }, { pendingTestNarrowings }] = await Promise.all([
    import('./verification/attempts.mjs'), import('./test-run-risk.mjs'), import('./story-paths.mjs'), import('./test-narrowing.mjs')]);
  const latest = await latestStepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
  return { narrowings: pendingTestNarrowings(workflow, phase.id, latest.values(), { at }), risks: [...latest.values()].map((attempt) => ({ attempt,
    state: testRunRiskStateFor(workflow, { phaseId: phase.id, attempt }, { at })?.state ?? null }))
    .filter(({ attempt, state }) => !testRunRiskIneligibility(attempt) && state !== 'active')
    .sort((left, right) => left.attempt.commandId.localeCompare(right.attempt.commandId))
    .map(({ attempt, state }) => ({ phase: phase.id, commandId: attempt.commandId, attemptId: attempt.attemptId ?? null, status: attempt.status,
      exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, argvSha256: attempt.argvSha256 ?? null, lapsed: state,
      causeClass: testRunCause(attempt).class })) };
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

/** The pending routing decision, with the earlier steps it lets a person reopen. */
async function routingFacts(workflow) {
  const { reopenableSteps } = await import('./workflow-decisions.mjs');
  return { ...workflow.pendingDecision, reopen: reopenableSteps(workflow, workflow.pendingDecision) };
}

/**
 * The clauses a person may name for a statement, as `decision scope` reads them. Only when the list
 * is read to answer it: a count never asks for a clause.
 */
async function scopeClauses(root, config, workflow) {
  const { evidenceGraphFromAggregate, scopeDecisionPreview } = await import('./evidence/graph.mjs');
  const [graph, preview] = await Promise.all([evidenceGraphFromAggregate(root, config, workflow), scopeDecisionPreview(root, config, workflow)]);
  return [...new Set([...(graph.records.indexes ?? []).flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)), ...preview.clauseIds])];
}

/**
 * What `decision completeness` would review now, when nothing has yet: every statement has an answer,
 * and nobody has looked for what is missing. Nothing waits on it, so an unreadable inventory is just not offered.
 */
async function completenessFacts(root, config, workflow) {
  try {
    const [{ evidenceGraphFromAggregate }, { scopeAuthorities }, { CHECKLIST_DECISIONS, STARTER_CHECKLIST }] = await Promise.all([
      import('./evidence/graph.mjs'), import('./scope/decisions.mjs'), import('./specification-quality.mjs')]);
    const graph = await evidenceGraphFromAggregate(root, config, workflow);
    const groups = scopeAuthorities(workflow);
    if (!graph.scope?.structurallyComplete || !graph.scope.items.length || graph.completenessReview || !groups.length) return null;
    return { inventorySha256: graph.scope.inventorySha256, statements: graph.scope.items.length, groups,
      articles: STARTER_CHECKLIST.articles.map(({ id, title, question }) => ({ id, title, question })), decisions: [...CHECKLIST_DECISIONS] };
  } catch (error) { if (error instanceof SingularityFlowError) return null; throw error; }
}

/**
 * While a code step is open: the changed files publication would refuse to leave out, and the rows each
 * may join. Only when the list is read to answer it, since a file a person is still writing is no count.
 */
async function excludedChangeFacts(root, config, workflow, phase) {
  if (phase.status !== 'in_progress' || phase.id !== workflow.currentPhase) return null;
  try {
    const { unreconciledCandidatePaths } = await import('./candidate-scope.mjs');
    const paths = await unreconciledCandidatePaths(root, config, workflow, phase);
    if (!paths.length) return null;
    const [{ loadActiveSpecRecords, mergePlannedClaimRecords }, { planRowsOf }] = await Promise.all([import('./specifications.mjs'), import('./plan-amendments.mjs')]);
    return { unclaimedPaths: paths, planRows: planRowsOf(mergePlannedClaimRecords((await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).planned ?? [])),
      waits: 'publishing this step would leave it out', keepOut: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json` };
  } catch (error) { if (error instanceof SingularityFlowError) return null; throw error; }
}

/**
 * A code step's departures that wait for a person [CQF:REQ-024], each with who decides it, the plan's rows
 * a file may join, the own-terminal command a row, test or clause is accepted with, and the steps a clause
 * change reopens. Null when there are none.
 */
async function departureFacts(root, config, workflow, phase) {
  if (!(workflow.departures ?? []).some((entry) => entry.phase === phase.id)) return null;
  try {
    const [{ departureReadings, departureAuthorities, acceptanceCommand }, { acceptAllEligible, departureHolds, departureWords }] = await Promise.all([
      // From the CLI source: the VS Code bundles that read this list load the departures only for a Story that has one.
      import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'departure-records.mjs')).href), import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'departures.mjs')).href)]);
    const readings = (await departureReadings(root, workflow, phase.id)).filter((entry) => departureHolds(entry.status) && entry.status !== 'rejected');
    if (!readings.length) return null;
    const [{ loadActiveSpecRecords, mergePlannedClaimRecords }, { planRowsOf }] = await Promise.all([import('./specifications.mjs'), import('./plan-amendments.mjs')]);
    const planRows = planRowsOf(mergePlannedClaimRecords((await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).planned ?? []));
    // The register's words for each item a fix on the way carries, quoted [CQF:REQ-066]; one it cannot read shows its ID alone.
    const fixed = [...new Set(readings.flatMap((entry) => entry.departure.findings ?? []))];
    const findingTitles = fixed.length
      ? await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'findings', 'register', 'on-the-way.mjs')).href)).itemTitles(root, config, fixed) : {};
    const order = workflow.phaseOrder ?? [];
    const reopens = (departure) => order.slice(order.indexOf(departure.target?.phase) + 1, order.indexOf(departure.phase) + 1)
      .filter((id) => ['approved', 'awaiting_approval'].includes(workflow.phases?.[id]?.status) || id === departure.phase);
    return {
      phase: phase.id, planRows, codeStepOpen: workflow.currentPhase === phase.id && phase.status === 'in_progress', findingTitles,
      entries: await Promise.all(readings.map(async (entry) => ({ ...entry, groups: await departureAuthorities(workflow, entry.departure),
        words: departureWords(entry.departure), acceptAll: acceptAllEligible(entry.departure) }))),
      acceptance: Object.fromEntries(readings.filter((entry) => ['plan-row', 'test', 'clause'].includes(entry.departure.kind))
        .map((entry) => [entry.departure.id, acceptanceCommand(workflow, entry.departure)])),
      reopens: Object.fromEntries(readings.filter((entry) => entry.departure.kind === 'clause').map((entry) => [entry.departure.id, reopens(entry.departure)])),
      // A clause change is shown with every test changed under the same clause [CQF:REQ-024].
      tests: Object.fromEntries(readings.filter((entry) => entry.departure.kind === 'clause').map((entry) => [entry.departure.id,
        (workflow.departures ?? []).filter((other) => other.kind === 'test' && other.clauses.some((clause) => entry.departure.clauses.includes(clause))).map((other) => other.id)]))
    };
  } catch (error) { if (error instanceof SingularityFlowError) return null; throw error; }
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
  const { applicabilityStatus } = await import('./evidence/applicability.mjs');
  const applicability = applicabilityStatus(workflow).filter((entry) => !entry.satisfied && entry.authority);
  let owedEntries = [];
  const owedRead = owed !== undefined ? owed
    : await (async () => { const { owedDecisions, stepsThrough } = await import('./owed-decisions.mjs'); return owedDecisions(root, config, workflow, stepsThrough(workflow, phase.id), { limit: 1000 }); })();
  if (owedRead?.status === 'owed') {
    // Each with the groups its own command checks, so the list says who takes it.
    const [{ riskAuthorities }, { scopeAuthorities }] = await Promise.all([import('./evidence/risk-decisions.mjs'), import('./scope/decisions.mjs')]);
    owedEntries = [...(owedRead.witnesses ?? []).map((entry) => ({ kind: 'witness', ...entry, contextBinding: owedRead.contextBinding, groups: riskAuthorities(workflow, { owningSteps: entry.owners }) })),
      ...(owedRead.scopeItems ?? []).map((entry) => ({ ...entry, kind: 'scope', groups: scopeAuthorities(workflow) }))];
  }
  if (owedRead?.status === 'unavailable') unavailable.push({ phase: phase.id, reason: owedRead.reason ?? 'owed-decisions-unavailable' });
  if (owedRead?.more?.witnesses || owedRead?.more?.scopeItems) unavailable.push({ phase: phase.id, reason: 'owed-decisions-truncated' });
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
      ...(workflow.pendingDecision ? { routing: await routingFacts(workflow) } : {}),
      intentAmendments, forwardAmendments, appeals, owed: owedEntries, applicability, transport
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
  // Like reusable runs, a count skips these: they change what a person answers, never how many items there are.
  const answering = offerReuse && workflow.status === 'in_progress';
  if (answering && state.pending.owed.some((entry) => entry.kind === 'scope')) {
    const clauses = await scopeClauses(root, config, workflow).catch((error) => { if (error instanceof SingularityFlowError) return []; throw error; });
    state.pending.owed = state.pending.owed.map((entry) => (entry.kind === 'scope' ? { ...entry, clauses } : entry));
  }
  let evidence = [];
  const tests = await testRisks(root, config, workflow, phase, at);
  const requests = (workflow.testCommandDecisions ?? []).length
    ? (await import('./story-test-commands.mjs')).pendingStoryTestCommands(workflow, phase.id) : [];
  const commandReviews = requests.some(request => request.repin)
    ? await (await import('./test-command-pins.mjs')).pendingTestCommandReviews(root, config, workflow, phase, requests)
    : { pending: requests, inactive: [], bindings: [], unavailable: [] };
  blocking.unavailable = [...(blocking.unavailable ?? []), ...commandReviews.unavailable];
  // A count reads no test command unless a run failed: then the pin is what the step waits on, and it is counted.
  const nodePin = await (await import('./node-pin.mjs')).storyNodePin(root, config, workflow, phase, { failedOnly: !answering }).catch(() => null);
  try { evidence = await evidenceDecisionFacts(root, config, workflow, phase); }
  catch (error) { blocking.unavailable = [...(blocking.unavailable ?? []), { phase: phase.id, reason: error.code ?? 'evidence-unavailable' }]; }
  return {
    ...blocking,
    ...state,
    repositoryPath: root,
    evidence,
    candidates: reuse.candidates, reuseProblems: reuse.problems,
    nodePin,
    testRisks: tests.risks,
    testNarrowings: tests.narrowings,
    testCommands: commandReviews.pending,
    inactiveTestCommands: commandReviews.inactive,
    visual: await visualProfiles(root, config, workflow, phase),
    completeness: answering ? await completenessFacts(root, config, workflow) : null,
    excludedChanges: answering ? await excludedChangeFacts(root, config, workflow, phase) : null,
    departures: workflow.status === 'in_progress' ? await departureFacts(root, config, workflow, phase) : null,
    state: {
      phases: Object.fromEntries((workflow.phaseOrder ?? []).map((id) => [id, `${workflow.phases?.[id]?.status}:${Number(workflow.phases?.[id]?.generation ?? 0)}`])),
      upstreamIssues: (workflow.upstreamIssues ?? []).length, upstreamIssueDecisions: (workflow.upstreamIssueDecisions ?? []).length,
      evidenceReuses: (workflow.evidenceReuses ?? []).length, testRunRisks: (workflow.testRunRisks ?? []).length,
      testNarrowings: (workflow.testNarrowings ?? []).length,
      testCommandDecisions: (workflow.testCommandDecisions ?? []).length,
      testCommandReviewBindings: commandReviews.bindings,
      planAmendments: (workflow.planAmendments ?? []).length,
      departures: `${(workflow.departures ?? []).length}:${(workflow.departureDecisions ?? []).length}`,
      witnessRecords: (workflow.witnessRecords ?? []).length,
      scopeDispositions: (workflow.scopeDispositions ?? []).length, completenessReviews: (workflow.completenessReviews ?? []).length,
      applicability: (workflow.applicability ?? []).length,
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
  offline = false, card = true, ...known } = {}) {
  const [{ decisionPacket }, { actionActor }, { identity }] = await Promise.all([import('./decision-list.mjs'), import('./commands/kernel.mjs'), import('./git.mjs')]);
  const facts = await decisionListFacts(root, config, workflow, { phaseId: phaseId ?? workflow.currentPhase, at, ...known });
  const actor = offline && !process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? identity(root, { offline: true }) : actionActor(root);
  const authorities = workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities;
  const packet = decisionPacket(workflow, facts, { authorities, actor, at, requestedPhase, card });
  return { ...packet, sheet: await sheetOf(root, workflow, packet, { approvalCheck: facts.approvalCheck, authorities, actor, card }) };
}

/** The step sheet beside the list; the list stands whatever happens here. */
async function sheetOf(root, workflow, packet, context) {
  try {
    const [{ stepSheet }, { presenceCountsFor }] = await Promise.all([import('./step-sheet.mjs'),
      workflow.resolution?.presence ? import('./presence/person-records.mjs') : { presenceCountsFor: async () => null }]);
    return stepSheet(workflow, packet, { ...context, counts: await presenceCountsFor(root, workflow) });
  } catch { return null; }
}
