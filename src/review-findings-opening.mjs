/**
 * The next version for a review's findings, started by SFlow when only the reviewer has seen the version it reviewed
 * (owner, 2026-11-19, ceremony cut 10).
 *
 * `phase rollover <step> --review-findings --json`: the review of the published version asked for corrections, and no
 * person has seen that version yet (no answer on its review, no approval or return, no words they typed for it, no file
 * changed after it was published). Asking "Start version N to fix the review's findings?" then only asked the person to
 * agree with a reviewer they had not read. SFlow starts version N itself, through the one opening operation, records it as
 * settled for the person with its evidence, and the decisions card lists it with an undo. The author fixes the findings in
 * the same turn. An undo hands the question back: every later version of that step for a review's findings is asked again.
 * Anything a person touched keeps the question theirs: the refusal names the preview that asks it.
 */
import { SingularityFlowError } from './util.mjs';

/** The settlement's subject: one per version it started from, so each start is listed on its own. */
export const reviewFindingsSubject = (phase) => `${phase.id} version ${Number(phase.generation)}: the review's findings`;

/** Whether a person undid an earlier start of this step for a review's findings: the question is theirs from then on. */
export async function reviewFindingsUndone(workflow, phase) {
  const { settledDecisions } = await import('./settled-decisions.mjs');
  return settledDecisions(workflow).some((entry) => entry.kind === 'review-corrections' && entry.phase === phase.id && entry.undone);
}

export async function reviewFindingsRollover(root, config, workflow, phase, options, { changedFiles = false } = {}) {
  const [{ optionBoolean, optionString }, { phaseRequiresCodeDelivery }, { reviewerAloneSaw }, { versionPreviewCommand }] = await Promise.all([
    import('./util.mjs'), import('./code-delivery-policy.mjs'), import('./source-review-continuation.mjs'), import('./action-command-map.mjs')]);
  if (optionString(options, 'confirm') || optionString(options, 'reason', null) !== null || options.correction !== undefined) {
    throw new SingularityFlowError('--review-findings starts the next version for the review\'s findings and takes no --confirm, --reason or --correction.',
      { code: 'GENERATION_ROLLOVER_OPTIONS_INVALID' });
  }
  const from = Number(phase.generation ?? 0);
  // Not settled: the person's own question, through the preview that asks it (its work command, by the command's own
  // crosswalk). Never the same command again.
  const ask = (words) => {
    throw new SingularityFlowError(`${words} Starting version ${from + 1} is the person's yes: preview it and ask them its question.`, {
      code: 'VERSION_REVIEW_FINDINGS_ASK', details: { phase: phase.id, version: from + 1,
        nextAction: { command: versionPreviewCommand(phase.id), label: `Ask the person to start version ${from + 1} of ${phase.label ?? phase.id} for the review's findings` } } });
  };
  if (changedFiles) ask(`Files changed after version ${from} of ${phase.label ?? phase.id} was published.`);
  let review = null;
  try { review = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id); }
  catch { review = null; }
  const opening = await import('./commands/phase-opening.mjs');
  // Only while the kernel's next for the step is opening a version for its review's corrections: once it is open (or the
  // step moved on), this opens nothing and names the step's own next action instead.
  const { next: kernelNext } = (await import('./step-decision.mjs')).stepDecisionOf(workflow, phase, { review });
  if (kernelNext.operation !== 'open-version' || kernelNext.inputs?.reason !== 'review-corrections') {
    throw new SingularityFlowError(`${phase.label ?? phase.id} has no published version waiting to be corrected for its review; nothing was opened.`, {
      code: 'GENERATION_ROLLOVER_UNAVAILABLE', details: { phase: phase.id, nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route } });
  }
  if (!reviewerAloneSaw(workflow, phase, review)) ask(`Someone besides the reviewer has seen version ${from} of ${phase.label ?? phase.id}, or its review asks for no corrections.`);
  if (await reviewFindingsUndone(workflow, phase)) ask(`A person undid an earlier start of ${phase.label ?? phase.id} for a review's findings.`);
  const successor = await import('./requested-successor.mjs');
  if ((await successor.requestedChanges(root, workflow, phase)).length) ask(`The person also typed a change for version ${from}.`);
  const request = await successor.reviewCorrectionRequest(root, config, workflow, phase);
  if (!request) ask(`The review of version ${from} names no correction to make.`);
  const code = phaseRequiresCodeDelivery(phase);
  const findings = (review?.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required').length;
  const [{ commitSettledDecision }, { actionActor }, { loadSession }] = await Promise.all([
    import('./settled-decisions.mjs'), import('./git.mjs'), import('./session.mjs')]);
  const session = await loadSession(root, { required: false }).catch(() => null);
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const { record: settled } = await commitSettledDecision(root, config, workflow, {
    kind: 'review-corrections', by: 'sflow', phase: phase.id, subject: reviewFindingsSubject(phase),
    answer: `Started version ${from + 1} of ${phase.id} to fix the review's findings on version ${from}`,
    evidence: [
      { what: `the review of version ${from} asks for ${findings || 'its'} correction${findings === 1 ? '' : 's'}`, where: `${phase.id} review of version ${from}` },
      { what: `nobody answered that review, approved, returned or asked to change version ${from}`, where: `${phase.id} review, approval and request records` }
    ],
    effect: { generation: from, toGeneration: from + 1 }
  }, { actor: actionActor(root), agent });
  // The one opening operation, as a confirmed rollover opens it: the settlement stands in for the person's yes [owner, 2026-11-19].
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: 'review-corrections' });
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed, settled: { kind: 'review-corrections', id: settled.id },
    open: code ? opening.codeOpening(root, config) : opening.documentOpening() });
  const next = proposed.proposal.version;
  const line = `Only the reviewer had seen version ${from} of ${phase.label ?? phase.id}, so SFlow started version ${next} to fix its findings; undo it on the decisions card (/sf-decide ${workflow.workItem.id}).`;
  const result = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'review-corrections', workId: workflow.workItem.id, phase: phase.id,
    fromGeneration: from, toGeneration: next, mutates: true, requestedChange: { requests: [request] }, line,
    settled: { id: settled.id, kind: settled.kind, answer: settled.answer, evidence: settled.evidence,
      undo: { copilotCommand: `/sf-decide ${workflow.workItem.id}`, words: 'Undo on the decisions card: SFlow then asks before it starts a version of this step for a review\'s findings.' } },
    preserved: code ? `Version ${from}, its evidence and its test results stay as published.` : `Version ${from} and its review stay as published.`,
    opened: { generation: next, status: 'open' }, opening: opened.outcome, replayed: opened.replayed,
    // What follows is the kernel's next for the open version: writing it, in this same turn.
    nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(line);
}
