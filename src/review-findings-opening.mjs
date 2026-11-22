/**
 * The next version for a review's findings, started by SFlow when only the reviewer has seen the version it reviewed
 * (owner, 2026-11-19, ceremony cut 10).
 *
 * `phase rollover <step> --review-findings --json`: the review of the published version asked for corrections, and no
 * person has seen that version yet (no answer on its review, no approval or return, no words they typed for it, no file
 * changed after it was published). Asking "Start version N to fix the review's findings?" then only asked the person to
 * agree with a reviewer they had not read. SFlow starts version N itself, through the one opening operation, records it as
 * settled for the person with its evidence, in the opening's own commit, and the decisions card lists it with an undo. The
 * author fixes the findings in the same turn. An undo never withdraws the version it opened (no route withdraws an open
 * version); it only makes every later start of that step for a review's findings the person's question again. A person who
 * disagrees with a finding disputes it (review-finding-dispute.mjs): the author is then told not to make that fix.
 * Anything a person touched keeps the question theirs: the refusal names the preview that asks it. So do as many starts in
 * a row as the workflow allows (sourceReview.autoFixVersions, 2 unless set), and a finding back after SFlow's fix
 * (source-review-continuation.mjs reviewFindingsHold).
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
  const [{ optionBoolean, optionString }, { phaseRequiresCodeDelivery }, { reviewerAloneSaw, reviewFindingsHold, reviewFindingKeys, reviewUpstreamRoute }, { versionPreviewCommand }] = await Promise.all([
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
        nextAction: { command: versionPreviewCommand(phase.id), label: `Ask to start version ${from + 1} of ${phase.label ?? phase.id} for its review` } } });
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
  // Findings an earlier step owns (a planning finding about the specification, or one on a document SFlow wrote from that
  // step's records): a new version here would meet them again, so their raise is the way on and nothing opens (2026-11-22).
  const upstream = reviewUpstreamRoute(workflow, phase, review);
  if (upstream) {
    throw new SingularityFlowError(`${upstream.reason ?? upstream.label} Nothing was opened.`, {
      code: 'REVIEW_FINDINGS_UPSTREAM', details: { phase: phase.id, nextAction: { command: upstream.command, label: upstream.label, skill: upstream.skill } } });
  }
  // The workflow's number of starts in a row (2 unless set), or a finding back after a fix: the person decides (owner, 2026-11-19).
  const held = reviewFindingsHold(workflow, phase, review);
  if (held) ask(held.words);
  if (!reviewerAloneSaw(workflow, phase, review)) ask(`Someone besides the reviewer has seen version ${from} of ${phase.label ?? phase.id}, or its review asks for no corrections.`);
  if (await reviewFindingsUndone(workflow, phase)) ask(`A person undid an earlier start of ${phase.label ?? phase.id} for a review's findings.`);
  const successor = await import('./requested-successor.mjs');
  if ((await successor.requestedChanges(root, workflow, phase)).length) ask(`The person also typed a change for version ${from}.`);
  const request = await successor.reviewCorrectionRequest(root, config, workflow, phase);
  if (!request) ask(`The review of version ${from} names no correction to make.`);
  const code = phaseRequiresCodeDelivery(phase);
  const findings = (review?.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required').length;
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: 'review-corrections' });
  const next = proposed.proposal.version;
  const [{ actionActor }, { actorKey }] = await Promise.all([import('./git.mjs'), import('./state-stores.mjs')]);
  // Recorded in the opening's own commit, so a start that fails leaves no settlement for a version nobody opened.
  const settlement = { kind: 'review-corrections', by: 'sflow', phase: phase.id, subject: reviewFindingsSubject(phase),
    answer: `Started version ${next} of ${phase.id} to fix the review's findings on version ${from}`,
    evidence: [
      { what: `the review of version ${from} asks for ${findings || 'its'} correction${findings === 1 ? '' : 's'}`, where: `${phase.id} review of version ${from}` },
      { what: `nobody answered that review, approved, returned or asked to change version ${from}`, where: `${phase.id} review, approval and request records` }
    ],
    // The reviewer's findings it was started for: one back after this fix asks the person (reviewFindingsHold).
    effect: { generation: from, toGeneration: next, findings: reviewFindingKeys(review) } };
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed,
    settled: { kind: 'review-corrections', settlement, actor: actorKey(actionActor(root)) },
    open: code ? opening.codeOpening(root, config) : opening.documentOpening() });
  const settled = opened.settled ?? (workflow.settledDecisions ?? []).findLast((entry) => entry?.kind === 'review-corrections' && entry.subject === settlement.subject) ?? null;
  const workId = workflow.workItem.id;
  const line = `Only the reviewer had seen version ${from} of ${phase.label ?? phase.id}, so SFlow started version ${next} to fix its findings. `
    + `Version ${next} stays open; an undo on the decisions card (/sf-decide ${workId}) only makes SFlow ask you before it starts another.`;
  const result = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'review-corrections', workId, phase: phase.id,
    fromGeneration: from, toGeneration: next, mutates: true, requestedChange: { requests: [request] }, line,
    settled: settled ? { id: settled.id, kind: settled.kind, answer: settled.answer, evidence: settled.evidence,
      undo: { copilotCommand: `/sf-decide ${workId}`, words: `An undo does not withdraw version ${next}: it stays open. It makes SFlow ask you before it starts another version of this step for a review's findings. To disagree with a finding, dispute it on the decisions card: its author is then told not to make that fix.` } } : null,
    preserved: code ? `Version ${from}, its evidence and its test results stay as published.` : `Version ${from} and its review stay as published.`,
    opened: { generation: next, status: 'open' }, opening: opened.outcome, replayed: opened.replayed,
    // What follows is the kernel's next for the open version: writing it, in this same turn.
    nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(line);
}
