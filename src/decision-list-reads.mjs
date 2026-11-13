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
 * - Convergence items, at an open convergence step: the table `story adjudications` reads [SCS:REQ-030].
 * - With a deviated or unplanned row, the Story's intent-amendment draft: where Update the spec writes
 *   it, and the clauses a draft already there holds for the scope as it is now [SCS:REQ-020].
 * - For each intent amendment on the list, what it changes and reaches and whether the Story moved under
 *   it: what its approver decides on the card [owner, 2026-11-13].
 * - A published step whose files changed after publication, or whose person asked for a change since: the
 *   next generation it needs, once only asked in chat, on the card too [owner, 2026-11-13].
 *
 * Reads only. `decisions` reads all of it; readiness and next steps read it for the list's count
 * and first item, without reusable runs (readPendingList).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DIFFERENCE_VERDICTS } from './conformance-differences.mjs';
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
    // Offered only while the step that defines the scope is the current one: the review belongs to that step, and
    // a later step (code, verification) opening the list for its own decision is not asked six scope questions
    // [PHR:REQ-006]. `decision completeness` itself stays available to a person at any time.
    const { finalScopeStep } = await import('./scope/authoring.mjs');
    if (!workflow.currentPhase || finalScopeStep(workflow)?.id !== workflow.currentPhase) return null;
    const [{ evidenceGraphFromAggregate }, { scopeAuthorities }, { CHECKLIST_DECISIONS, STARTER_CHECKLIST }] = await Promise.all([
      import('./evidence/graph.mjs'), import('./scope/decisions.mjs'), import('./specification-quality.mjs')]);
    const graph = await evidenceGraphFromAggregate(root, config, workflow);
    const groups = scopeAuthorities(workflow);
    if (!graph.scope?.structurallyComplete || !graph.scope.items.length || graph.completenessReview || !groups.length) return null;
    // A Story that pins no constitution has no articles to agree with: the question asks only what it can.
    const constitution = Boolean(workflow.resolution?.constitutionPin);
    const asked = (article) => (constitution || article.id !== 'consistency' ? article.question
      : 'Do the requirements agree with each other and with the scenarios?');
    return { inventorySha256: graph.scope.inventorySha256, statements: graph.scope.items.length, groups,
      articles: STARTER_CHECKLIST.articles.map((article) => ({ id: article.id, title: article.title, question: asked(article) })), decisions: [...CHECKLIST_DECISIONS] };
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
 * At an open convergence step, what a person adjudicates [SCS:REQ-030]: the same table `story adjudications`
 * reads, with its digest, which `decisions record` writes through `story adjudicate --answers` bound to.
 * Null anywhere else, and before the step is prepared; a table that cannot be read is named in `unavailable`.
 */
async function convergenceFacts(root, config, workflow, phase, unavailable) {
  if (workflow.status !== 'in_progress' || phase.id !== workflow.currentPhase || phase.status !== 'in_progress') return null;
  // From the CLI source, as the departures are: the VS Code bundles that read this list load the table only at an open convergence step.
  const { adjudicationList, openConvergencePhase } = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'convergence-adjudications.mjs')).href);
  if (openConvergencePhase(workflow)?.id !== phase.id) return null;
  try {
    const list = await adjudicationList(root, config, workflow, { actor: null });
    return list.status === 'open' ? list : null;
  } catch (error) {
    // Read from the CLI source, a refusal is that copy's class: known by its name.
    if (!(error instanceof SingularityFlowError) && error?.name !== 'SingularityFlowError') throw error;
    unavailable.push({ phase: phase.id, reason: error.code ?? 'convergence-unreadable' });
    return null;
  }
}

/**
 * A code step's instructions the person typed that are not accounted for yet [SCS:REQ-042], quoted; null when none.
 */
async function askedForFacts(workflow, phase) {
  if (!(workflow.askedFor ?? []).some((entry) => entry.phase === phase.id)) return null;
  const [{ phaseRequiresCodeDelivery }, { instructionAccounting }, { typedFocusOff }] = await Promise.all([import('./code-delivery-policy.mjs'),
    // From the CLI source, as the departures are: the VS Code bundles load it only for a Story that has one.
    import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'asked-for-records.mjs')).href), import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'asked-for.mjs')).href)]);
  if (!phaseRequiresCodeDelivery(phase) || typedFocusOff(workflow)) return null;
  const entries = instructionAccounting(workflow, phase.id).filter((entry) => !entry.account);
  return entries.length ? { phase: phase.id, open: workflow.currentPhase === phase.id && phase.status === 'in_progress' && phase.generationIntent?.status === 'open', entries } : null;
}

/**
 * The next generation a published step needs [owner, 2026-11-13]: its files changed after publication (a code
 * step's changes-after-publication), or the person asked for a change since (requested-successor.mjs). Before, only
 * the step's own skill asked it, in chat. Null when neither, when the step is not published and open, or when Git or
 * the asked-for record cannot say: the gates themselves still check. Both readers load from the CLI source, out of
 * the VS Code bundles that read this list.
 */
async function rolloverFacts(root, config, workflow, phase) {
  if (phase.status !== 'in_progress' || phase.id !== workflow.currentPhase || !(Number(phase.generation ?? 0) > 0)) return null;
  try {
    const source = (name) => import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', name)).href);
    const [changed, requested, { phaseRequiresCodeDelivery }] = await Promise.all([source('changes-after-publication.mjs'), source('requested-successor.mjs'),
      import('./code-delivery-policy.mjs')]);
    if (!requested.requestedSuccessorEligible(workflow, phase)) return null;
    const after = await changed.changesAfterPublication(root, config, workflow, phase).catch(() => null);
    const requests = await requested.requestedChanges(root, workflow, phase).catch(() => []);
    // Never the author's own correction [owner, 2026-11-13]: that is of a published generation whose bytes are unchanged
    // and that nobody asked to change, which this item never covers (neither files nor a request); `phase rollover
    // --correction` refuses changed files, and once a review or an approval exists it routes to the preview, whose
    // request this item then asks about (own-correction-rollover.mjs).
    if (!after && !requests.length) return null;
    const action = requested.requestedSuccessorAction(workflow, phase, { requested: requests.length > 0, changedPaths: after?.paths ?? [] });
    const chatRoute = phaseRequiresCodeDelivery(phase) ? `/sf-code ${phase.id}` : action?.copilotCommand?.replace(/ <what to change>$/u, '') ?? null;
    return { phase: phase.id, generation: Number(phase.generation), next: Math.max(Number(phase.generation), Number(phase.generationHighWatermark ?? 0)) + 1,
      paths: after?.paths ?? [], uncommitted: after?.uncommitted ?? [], requests: requests.map((text) => String(text).replace(/\s+/gu, ' ').trim().slice(0, 200)),
      command: `singularity-flow phase rollover ${phase.id}`, keepOut: after?.uncommitted?.length ? `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json` : null,
      chatRoute, code: phaseRequiresCodeDelivery(phase) };
  } catch { return null; }
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
  // An intent amendment that updated the spec to the code lists its steps the same way [SCS:REQ-022].
  if ((workflow.forwardAmendments ?? []).length || (workflow.intentAmendments ?? []).some((entry) => entry.revalidate?.length)) {
    const { pendingAmendmentRevalidations, pendingForwardAmendments, revalidateCommand } = await import('./forward-amendments.mjs');
    forwardAmendments = [
      ...pendingForwardAmendments(workflow).map((proposal) => ({ code: 'FORWARD_AMENDMENT_PENDING', amendment: proposal.id, phase: proposal.phase,
        message: `${proposal.id} proposes a corrected ${proposal.phase}; ${proposal.phase}'s approvers have not decided it.`,
        command: `singularity-flow upstream-issue decide-amendment ${proposal.id} --work-id ${workId} --decision approve|reject --reason "<why>" --confirm ${proposal.id}` })),
      ...pendingAmendmentRevalidations(workflow).map((entry) => ({ code: 'AMENDMENT_REVALIDATION_REQUIRED', amendment: entry.amendment, phase: entry.phase,
        producer: entry.producer, message: `${entry.phase} read ${entry.producer} before ${entry.amendment} amended it; ${entry.phase}'s approvers have not revalidated it.`,
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

/**
 * The Story's intent-amendment draft: its path, and the clauses it holds when it was drafted from the
 * approved scope as it is now and is still there. A draft from before an approved amendment holds none.
 */
async function intentAmendmentDraftFacts(root, config, workflow) {
  const [{ gitDir }, { intentAmendmentDraftPath }, { scopeStepOf }] = await Promise.all([
    import('./git.mjs'), import('./phase-staging-paths.mjs'), import('./phase-roles.mjs')]);
  const file = intentAmendmentDraftPath(gitDir(root), workflow);
  // What the drafter wrote beside it (commands/story.mjs draftIntentAmendment).
  const state = await readFile(file.replace(/\.md$/u, '.json'), 'utf8').then(JSON.parse).catch(() => null);
  const present = state ? await readFile(file).then(() => true, () => false) : false;
  const scope = scopeStepOf(workflow)?.requiredArtifact?.path;
  const text = present && scope ? await readFile(path.join(workDir(root, config, workflow.workItem.id), scope), 'utf8').catch(() => null) : null;
  const current = text !== null && state?.workId === workflow.workItem.id && Array.isArray(state.clauses)
    && state.specificationSha256 === createHash('sha256').update(text).digest('hex');
  return { path: file, clauses: current ? state.clauses.map(String) : [] };
}

const CARD_CHANGES = 20;
const CARD_NAMES = 12;

/** A file of this Story's own, or null: a record never names a file outside the Story to read. */
function storyFile(root, config, workflow, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  const item = path.resolve(workDir(root, config, workflow.workItem.id));
  const file = path.resolve(root, relative);
  return file.startsWith(`${item}${path.sep}`) ? readFile(file, 'utf8').catch(() => null) : null;
}

/**
 * What the decisions card shows of an intent amendment [owner, 2026-11-13, D1]: a scope approver decides it there,
 * so the card shows what they decide. From the amendment's own record and its before and proposed files: each
 * clause it adds, revises or removes with its statement, who proposed it and who wrote the wording, what it reaches
 * (the blast radius it recorded, and the steps after the scope that have begun), the approvals recorded so far, and
 * whether the Story moved under a pending one, by the check its approval makes (state.mjs intentAmendmentStaleness),
 * which is when the card offers Refresh (D3). Facts only: decision-list.mjs words them. Null when the record is unread.
 * Every module it loads is already in the bundles that read the list.
 */
async function intentAmendmentCardFacts(root, config, workflow, amendment) {
  const record = await storyFile(root, config, workflow, amendment.recordPath);
  if (record == null) return null;
  const proposal = JSON.parse(record);
  const [{ radiusSummary }, { extractClauses }, { scopeStepOf }] = await Promise.all([import('./amendment.mjs'), import('./specifications.mjs'), import('./phase-roles.mjs')]);
  const sourcePath = proposal.specification?.artifact ?? null;
  const statements = (text) => {
    if (text == null) return new Map();
    try { return new Map(extractClauses(text, { sourcePath }).map((clause) => [String(clause.id).toUpperCase(), String(clause.body ?? '').slice(0, 600)])); }
    catch { return new Map(); }
  };
  const [beforeText, proposedText] = await Promise.all([proposal.specification?.beforePath, proposal.specification?.proposedPath]
    .map((relative) => storyFile(root, config, workflow, relative)));
  const [was, now] = [beforeText, proposedText].map(statements);
  const diff = proposal.diff ?? {};
  const changed = [...(diff.added ?? []).map((clause) => [clause, 'added']), ...(diff.revised ?? []).map((clause) => [clause, 'revised']),
    ...(diff.removed ?? []).map((clause) => [clause, 'removed'])];
  const radius = proposal.radius;
  const scope = scopeStepOf(workflow)?.id ?? null;
  const order = workflow.phaseOrder ?? [];
  const pending = amendment.status === 'proposed';
  const state = await import('./state.mjs');
  const stale = pending ? await state.intentAmendmentStaleness(root, config, workflow, proposal) : null;
  // What approving it does, by the computation approval applies [CIC:REQ-012, CON-007]; one it cannot be
  // approved as is has none, and an unreadable Story says nothing rather than guessing.
  const effect = pending && !stale && proposedText != null
    ? await state.intentAmendmentEffect(root, config, workflow, proposal, { proposedText }).catch(() => null) : null;
  // What an approved one did, from its own record: the steps it kept, reopened and asked.
  const application = amendment.status === 'approved' ? proposal.application ?? null : null;
  const later = scope ? order.slice(order.indexOf(scope) + 1).filter((id) => workflow.phases?.[id]?.status !== 'skipped') : [];
  const kept = application?.retainedPhases ?? [];
  const reopened = application && !application.settles ? later.find((id) => !kept.includes(id)) ?? null : null;
  const by = proposal.proposedBy ?? amendment.proposedBy ?? null;
  return {
    proposer: by?.name ?? by?.login ?? by?.email ?? null,
    authored: proposal.authorship?.producer ?? null,
    reason: proposal.reason ?? null,
    changes: changed.slice(0, CARD_CHANGES).map(([clause, change]) => ({ clause, change,
      before: change === 'added' ? null : was.get(String(clause).toUpperCase()) ?? null, after: change === 'removed' ? null : now.get(String(clause).toUpperCase()) ?? null })),
    moreChanges: Math.max(0, changed.length - CARD_CHANGES),
    radius: radius?.totals ? { summary: radiusSummary(radius),
      artifacts: (radius.artifacts ?? []).slice(0, CARD_NAMES), moreArtifacts: Math.max(0, (radius.artifacts ?? []).length - CARD_NAMES),
      tests: (radius.tests ?? []).slice(0, CARD_NAMES), moreTests: Math.max(0, (radius.tests ?? []).length - CARD_NAMES) } : null,
    effect: effect ? { firstReset: effect.firstReset, dependents: effect.dependents, repeats: effect.repeats,
      steps: effect.steps.map(({ phase, outcome, status, generation, reasons, inPrompt, groups }) => ({ phase, outcome, status, generation, reasons,
        ...(inPrompt ? { inPrompt } : {}), ...(groups ? { groups } : {}) })) } : null,
    applied: application ? { kept, reopened, asked: (application.revalidate ?? []).map((entry) => entry.phase),
      reset: reopened ? later.slice(later.indexOf(reopened) + 1).filter((id) => Number(workflow.phases?.[id]?.generation ?? 0) > 0) : [] } : null,
    ...(pending ? { decisions: (proposal.decisions ?? []).map((entry) => ({ decision: entry.decision, actor: entry.actor ?? null })) } : {}),
    stale: stale ? { cause: stale.cause, phase: stale.phase } : null
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
  // A scope approver decides a pending intent amendment on the card with what it changes and reaches in front of
  // them, and Refresh is offered once the Story moved under it [owner, 2026-11-13]. A count needs none of it.
  if (answering && state.pending.intentAmendments.length) {
    state.pending.intentAmendments = await Promise.all(state.pending.intentAmendments.map(async (amendment) => {
      try { return { ...amendment, card: await intentAmendmentCardFacts(root, config, workflow, amendment) }; } catch { return amendment; }
    }));
  }
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
  const offeredPin = await (await import('./node-pin.mjs')).storyNodePin(root, config, workflow, phase, { failedOnly: !answering }).catch(() => null);
  // A Node the repository names is settled before the tests run, never asked [owner, 2026-11-13]; undone, it is asked again.
  const nodePin = offeredPin?.source && (await import('./settled-decisions.mjs')).settleableNodePin(workflow, phase, offeredPin) ? null : offeredPin;
  try { evidence = await evidenceDecisionFacts(root, config, workflow, phase); }
  catch (error) { blocking.unavailable = [...(blocking.unavailable ?? []), { phase: phase.id, reason: error.code ?? 'evidence-unavailable' }]; }
  blocking.unavailable = blocking.unavailable ?? [];
  const convergence = await convergenceFacts(root, config, workflow, phase, blocking.unavailable);
  // Only a difference offers Update the spec; an unreadable draft is one not written yet.
  const intentAmendmentDraft = (blocking.gaps ?? []).some((gap) => DIFFERENCE_VERDICTS.includes(gap.verdict))
    ? await intentAmendmentDraftFacts(root, config, workflow).catch(() => null) : null;
  return {
    ...blocking,
    ...state,
    intentAmendmentDraft,
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
    rollover: answering ? await rolloverFacts(root, config, workflow, phase) : null,
    departures: workflow.status === 'in_progress' ? await departureFacts(root, config, workflow, phase) : null,
    convergence,
    askedFor: workflow.status === 'in_progress' ? await askedForFacts(workflow, phase) : null,
    state: {
      phases: Object.fromEntries((workflow.phaseOrder ?? []).map((id) => [id, `${workflow.phases?.[id]?.status}:${Number(workflow.phases?.[id]?.generation ?? 0)}`])),
      upstreamIssues: (workflow.upstreamIssues ?? []).length, upstreamIssueDecisions: (workflow.upstreamIssueDecisions ?? []).length,
      evidenceReuses: (workflow.evidenceReuses ?? []).length, testRunRisks: (workflow.testRunRisks ?? []).length,
      testNarrowings: (workflow.testNarrowings ?? []).length,
      testCommandDecisions: (workflow.testCommandDecisions ?? []).length,
      testCommandReviewBindings: commandReviews.bindings,
      planAmendments: (workflow.planAmendments ?? []).length,
      departures: `${(workflow.departures ?? []).length}:${(workflow.departureDecisions ?? []).length}`,
      askedFor: `${(workflow.askedFor ?? []).length}:${(workflow.instructionAccounts ?? []).length}`,
      witnessRecords: (workflow.witnessRecords ?? []).length,
      scopeDispositions: (workflow.scopeDispositions ?? []).length, completenessReviews: (workflow.completenessReviews ?? []).length,
      applicability: (workflow.applicability ?? []).length,
      visualProfileDecisions: (workflow.visualProfileDecisions ?? []).length,
      evidence: evidence.map((entry) => `${entry.criterion}:${entry.result}:${entry.witnesses.map((witness) => witness.slot).join(',')}:${entry.risks.length}`),
      reports: Object.fromEntries(reports.map((entry) => [entry.step.id, entry.digest])),
      intentAmendments: (workflow.intentAmendments ?? []).map((entry) => `${entry.id}:${entry.status}:${entry.acknowledgedAt ? 1 : 0}`),
      forwardAmendments: (workflow.forwardAmendmentDecisions ?? []).length + (workflow.amendmentRevalidations ?? []).length,
      pendingDecision: workflow.pendingDecision?.key ?? null,
      // The convergence table's own digest: an answer recorded meanwhile, or a new iteration, changes the list.
      convergence: convergence?.digest ?? null,
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
  const storyNext = packet.items?.length ? null : await storyNextStep(workflow);
  return { ...packet, ...(storyNext ? { next: storyNext } : {}),
    sheet: await sheetOf(root, workflow, packet, { approvalCheck: facts.approvalCheck, authorities, actor, card }) };
}

/**
 * An empty list ends on the Story's next step, the first one the guide (and so next steps) gives: a
 * /sf-decide turn that ended on "nothing to decide" left the person with no next action (owner, 2026-11-10).
 */
async function storyNextStep(workflow) {
  try {
    const { workflowGuide } = await import('./guide.mjs');
    const action = workflowGuide(workflow).nextActions.find((entry) => !entry.optional && entry.command);
    return action ? { kind: 'story-next', title: action.reason ?? 'The Story\'s next step.', command: action.command,
      copilotCommand: action.copilotCommand ?? null, skill: action.skill ?? null } : null;
  } catch { return null; }
}

/** The step sheet beside the list; the list stands whatever happens here. */
async function sheetOf(root, workflow, packet, context) {
  try {
    const [{ stepSheet }, { presenceCountsFor }] = await Promise.all([import('./step-sheet.mjs'),
      workflow.resolution?.presence ? import('./presence/person-records.mjs') : { presenceCountsFor: async () => null }]);
    return stepSheet(workflow, packet, { ...context, counts: await presenceCountsFor(root, workflow) });
  } catch { return null; }
}
