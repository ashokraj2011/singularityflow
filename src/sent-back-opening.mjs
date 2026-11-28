/**
 * The next version of a step a person sent back, started on that send-back (ask once, owner 2026-11-28).
 *
 * `phase rollover <step> --sent-back --json`: a person returned the step, with their reason, and nothing of its next version
 * is open yet. Asking "Start version N?" then asked them again what their send-back had already said, and asked it twice
 * ("Start Release version 5?", then "Do you confirm opening version 5?", d-story, 2026-11-23). SFlow starts version N itself,
 * through the one opening operation, records it as settled on the person's own send-back with their words as its evidence,
 * in the opening's own commit, and says which answer it used. The author writes it in the same turn, for their reason. An
 * undo never withdraws the version it opened (no route withdraws an open version); it only makes every later start of that
 * step after a send-back the person's question again. The same for every step, whatever its workflow or work type.
 *
 * Files changed after the published version keep the question the person's: the preview that asks it is named.
 */
import { SingularityFlowError } from './util.mjs';

const clean = (value, maximum = 300) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);

/** The one line that says which answer SFlow used, so the person sees why nothing was asked. */
export function sentBackLine(workflow, phase, answer, next) {
  const step = phase.label ?? phase.id;
  const from = workflow.phases?.[answer.from.phase]?.label ?? answer.from.phase;
  const said = answer.reason ? `"${clean(answer.reason, 300)}"` : 'send it back';
  return `Using your answer from ${from} version ${answer.from.version || 'before'}: ${said}${/[.!?]"?$/u.test(said) ? '' : '.'} SFlow started version ${next} of ${step} on it, so nothing is asked.`;
}

export async function sentBackRollover(root, config, workflow, phase, options, { changedFiles = false } = {}) {
  const [{ optionBoolean, optionString }, { phaseRequiresCodeDelivery }, { sentBackAnswer }, { versionPreviewCommand }] = await Promise.all([
    import('./util.mjs'), import('./code-delivery-policy.mjs'), import('./phase-generation-need.mjs'), import('./action-command-map.mjs')]);
  if (optionString(options, 'confirm') || optionString(options, 'reason', null) !== null || options.correction !== undefined) {
    throw new SingularityFlowError('--sent-back starts the next version on the person\'s send-back and takes no --confirm, --reason or --correction.',
      { code: 'GENERATION_ROLLOVER_OPTIONS_INVALID' });
  }
  const from = Number(phase.generation ?? 0);
  const opening = await import('./commands/phase-opening.mjs');
  // Not settled: the person's own question, through the preview that asks it. Never the same command again.
  const ask = (words) => {
    throw new SingularityFlowError(`${words} Starting version ${from + 1} is the person's yes: preview it and ask them its question.`, {
      code: 'VERSION_SENT_BACK_ASK', details: { phase: phase.id, version: from + 1,
        nextAction: { command: versionPreviewCommand(phase.id), label: `Ask to start version ${from + 1} of ${phase.label ?? phase.id}` } } });
  };
  // Only while the kernel's next for the step is opening a version for a return: once it is open (or the step moved on),
  // this opens nothing and names the step's own next action instead.
  const { next: kernelNext } = (await import('./step-decision.mjs')).stepDecisionOf(workflow, phase);
  if (!['open-version', 'build-version'].includes(kernelNext.operation) || kernelNext.inputs?.consent !== 'required' || !['rework', 'rejected'].includes(kernelNext.inputs?.reason)) {
    throw new SingularityFlowError(`${phase.label ?? phase.id} has no version waiting to start for a send-back; nothing was opened.`, {
      code: 'GENERATION_ROLLOVER_UNAVAILABLE', details: { phase: phase.id, nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route } });
  }
  if (changedFiles) ask(`Files changed after version ${from} of ${phase.label ?? phase.id} was published.`);
  const answer = sentBackAnswer(workflow, phase);
  if (!answer) ask(`No send-back by a person stands for ${phase.label ?? phase.id}, or a person undid an earlier start of it after one.`);
  const code = phaseRequiresCodeDelivery(phase);
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: await opening.successorReason(workflow, phase) });
  const next = proposed.proposal.version;
  const [{ actionActor }, { actorKey }] = await Promise.all([import('./git.mjs'), import('./state-stores.mjs')]);
  const source = workflow.phases?.[answer.from.phase]?.label ?? answer.from.phase;
  // Recorded in the opening's own commit, so a start that fails leaves no settlement for a version nobody opened.
  const settlement = { kind: 'sent-back', by: 'sflow', phase: phase.id, subject: `${phase.id} version ${from}: sent back (${answer.changeRequest})`,
    answer: `Started version ${next} of ${phase.id} on the person's send-back`,
    evidence: [
      { what: `a person sent ${source} version ${answer.from.version} back${answer.reason ? `: ${clean(answer.reason, 400)}` : ''}`, where: `${answer.from.phase} change request ${answer.changeRequest}` },
      { what: `a send-back asks for ${phase.id}'s next version, so asking again would only repeat it`, where: `${phase.id} version need (${kernelNext.inputs.reason})` }
    ],
    effect: { generation: from, toGeneration: next, changeRequest: answer.changeRequest, fromPhase: answer.from.phase, fromGeneration: answer.from.version } };
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed,
    settled: { kind: 'sent-back', settlement, actor: actorKey(actionActor(root)) },
    open: code ? opening.codeOpening(root, config) : opening.documentOpening() });
  const settled = opened.settled ?? (workflow.settledDecisions ?? []).findLast((entry) => entry?.kind === 'sent-back' && entry.subject === settlement.subject) ?? null;
  const workId = workflow.workItem.id;
  const line = sentBackLine(workflow, phase, answer, next);
  const result = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'sent-back', workId, phase: phase.id,
    fromGeneration: from, toGeneration: next, mutates: true, line,
    answerUsed: { changeRequest: answer.changeRequest, from: answer.from, reason: answer.reason },
    settled: settled ? { id: settled.id, kind: settled.kind, answer: settled.answer, evidence: settled.evidence,
      undo: { copilotCommand: `/sf-decide ${workId}`, words: `An undo does not withdraw version ${next}: it stays open. It makes SFlow ask you before it starts another version of this step after a send-back.` } } : null,
    preserved: code ? `Version ${from}, its evidence and its test results stay as published.` : `Version ${from} stays as published.`,
    opened: { generation: next, status: 'open' }, opening: opened.outcome, replayed: opened.replayed,
    // What follows is the kernel's next for the open version: writing it, in this same turn.
    nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(line);
}
