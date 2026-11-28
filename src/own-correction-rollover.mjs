/**
 * The author's own correction of its own published draft, before anyone reviewed or approved it.
 *
 * `phase rollover <step> --correction "<what contradicts what>"`: Copilot found a mistake in its own work on the step, not
 * from a review or a person. SFlow starts the next version for it itself, through the one opening operation, settled with an
 * undo on the decisions card, and says in one line what was found and which version fixes it [owner, 2026-11-28, reversing
 * 2026-11-17's "asked like every successor", itself superseding 2026-11-13]. At most as many in a row as the review's fixes
 * (`sourceReview.autoFixVersions`, 2 unless set): after them, or once a person undid such a start, the next is the person's
 * question, with its why, through the same preview, consent and opening as a change the person asks for [D3, OSA:REQ-030].
 * Once a review report or an approval exists for the version, it is no longer the author's own correction: the preview for a
 * change the person asks for is the route. The same for every step, whatever its workflow.
 */
import { SingularityFlowError } from './util.mjs';

const MINIMUM = 20;
const MAXIMUM = 1000;

const refuse = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

/** Why a correction of `phase` is not the author's own (so it is previewed as a change asked for), or null when it is; read-only. */
export async function ownCorrectionHold(root, config, workflow, phase) {
  const { requestedSuccessorEligible } = await import('./guide.mjs');
  const generation = Number(phase?.generation ?? 0);
  if (!requestedSuccessorEligible(workflow, phase)) return { code: 'GENERATION_ROLLOVER_UNAVAILABLE', words: `${phase?.id ?? 'This step'} has no published, unchanged generation of its own to correct here.` };
  const authorship = [...(phase.authorship ?? [])].reverse().find((entry) => Number(entry.generation) === generation);
  if (authorship?.producer !== 'governed-agent') {
    return { code: 'GENERATION_OWN_CORRECTION_NOT_OWN', words: `${phase.id} generation ${generation} was not published by its agent, so it is not the author's own correction: preview it as a change the person asks for.` };
  }
  if ((phase.approvals ?? []).some((entry) => !entry.invalidatedAt && Number(entry.generation) === generation)) {
    return { code: 'GENERATION_OWN_CORRECTION_REVIEWED', words: `${phase.id} generation ${generation} has an approval decision, so it is not the author's own correction: preview it as a change the person asks for.` };
  }
  const { sourceReviewRequired } = await import('./source-review-policy.mjs');
  if (sourceReviewRequired(workflow, phase.id)) {
    let status = null;
    try { status = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id); }
    catch { status = null; }
    // A review that cannot be read is not known to be absent: the correction is not known to be the author's own then.
    if (!status) return { code: 'GENERATION_OWN_CORRECTION_REVIEWED', words: `Whether ${phase.id} generation ${generation} was reviewed cannot be read, so it is not the author's own correction: preview it as a change the person asks for.` };
    if (status.reportSha256 && Number(status.generation) === generation) {
      return { code: 'GENERATION_OWN_CORRECTION_REVIEWED', words: `An independent review of ${phase.id} generation ${generation} is retained, so it is not the author's own correction: preview it as a change the person asks for.` };
    }
  }
  return null;
}

/**
 * `phase rollover <step> --correction TEXT`: preview version N+1 for the author's own correction and ask the person, or,
 * with the `--confirm` value of that preview after their yes, open it; refuse with the person's route when it is not the
 * author's own correction. Nothing opens without the person's yes [owner, 2026-11-17].
 */
export async function ownCorrectionRollover(root, config, workflow, phase, options) {
  const [{ optionString }, { successorSkillForPhase }] = await Promise.all([import('./util.mjs'), import('./code-delivery-policy.mjs')]);
  const correction = String(optionString(options, 'correction') ?? '').replace(/\s+/gu, ' ').trim();
  if (correction.length < MINIMUM || correction.length > MAXIMUM) {
    refuse(`--correction says what the published draft gets wrong and what it contradicts, in ${MINIMUM} to ${MAXIMUM} characters.`, 'GENERATION_CORRECTION_REASON_REQUIRED');
  }
  if (optionString(options, 'reason', null) !== null) {
    refuse('--correction is the author\'s own correction and takes no --reason: a change the person asks for is previewed with --reason.', 'GENERATION_ROLLOVER_OPTIONS_INVALID');
  }
  const hold = await ownCorrectionHold(root, config, workflow, phase);
  if (hold) refuse(`${hold.words} Preview the next generation for it and ask the person: singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json.`, hold.code, {
    phase: phase.id, generation: phase.generation,
    nextAction: { command: `singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json`, skill: successorSkillForPhase(phase, workflow),
      label: `Preview generation ${Number(phase.generation) + 1} of ${phase.id} for the correction, then ask the person to confirm it.` } });
  // Started by SFlow, settled with an undo; a confirmation, or a hold, is the person's question, with its why.
  const asked = optionString(options, 'confirm') ? null : await ownCorrectionStartHold(workflow, phase);
  if (!optionString(options, 'confirm') && !asked) return settledOwnCorrection(root, config, workflow, phase, options, correction);
  return (await import('./requested-successor.mjs')).requestedSuccessorRollover(root, config, workflow, phase, options, { correction, because: asked?.words ?? null });
}

const clean = (value, maximum) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum);

/**
 * Why Copilot's next correction of `phase` is the person's to start, or null: the workflow asks every time, a person undid
 * an earlier such start, or SFlow already started as many in a row as the workflow lets it (2 unless set). Pure.
 */
export async function ownCorrectionStartHold(workflow, phase) {
  const { autoFixVersionsOf } = await import('./source-review-policy.mjs');
  const step = phase.label ?? phase.id;
  const limit = autoFixVersionsOf(workflow, phase.id);
  if (limit === 0) return { reason: 'setting', words: `This workflow asks you before every version that fixes Copilot's own work on ${step}.` };
  const list = workflow.settledDecisions ?? [];
  const undone = new Set(list.map((entry) => entry?.undoes).filter(Boolean));
  const starts = list.filter((entry) => entry?.kind === 'own-correction' && entry.phase === phase.id && !entry.undoes);
  if (starts.some((entry) => undone.has(entry.id))) return { reason: 'undone', words: `A person undid an earlier start of ${step} for Copilot's own correction, so each one is yours to start now.` };
  // The starts in a row: each version SFlow started for one, back from the published one.
  let run = 0;
  for (let version = Number(phase.generation ?? 0); run < limit;) {
    const start = starts.findLast((entry) => Number(entry.effect?.toGeneration) === version);
    if (!start || !(Number(start.effect.generation) < version)) break;
    run += 1;
    version = Number(start.effect.generation);
  }
  return run >= limit ? { reason: 'rounds', words: `Copilot has corrected its own work on ${step} ${run} times in a row, so the next correction is yours to start.` } : null;
}

/** The next version for Copilot's own correction, started by SFlow, settled with an undo, in the opening's own commit. */
async function settledOwnCorrection(root, config, workflow, phase, options, correction) {
  const [{ optionBoolean }, { phaseRequiresCodeDelivery }, { stepEntryCommand }, opening, { actionActor }, { actorKey }] = await Promise.all([
    import('./util.mjs'), import('./code-delivery-policy.mjs'), import('./action-command-map.mjs'), import('./commands/phase-opening.mjs'),
    import('./git.mjs'), import('./state-stores.mjs')]);
  const from = Number(phase.generation ?? 0);
  const step = phase.label ?? phase.id;
  const code = phaseRequiresCodeDelivery(phase);
  const found = clean((await (await import('./asked-for.mjs')).redactedWords(correction))?.text ?? correction, 400);
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: 'own-correction' });
  const next = proposed.proposal.version;
  const settlement = { kind: 'own-correction', by: 'sflow', phase: phase.id, subject: `${phase.id} version ${from}: Copilot's own correction`,
    answer: `Started version ${next} of ${phase.id} for Copilot's own correction of version ${from}`,
    evidence: [
      { what: `Copilot found in its own work: ${found}`, where: `${phase.id} version ${from}` },
      { what: `nobody reviewed or approved version ${from}, and it is unchanged since it was published`, where: `${phase.id} review and approval records` }
    ],
    effect: { generation: from, toGeneration: next, correction: found } };
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed,
    settled: { kind: 'own-correction', settlement, actor: actorKey(actionActor(root)) },
    open: code ? opening.codeOpening(root, config) : opening.documentOpening() });
  const settled = opened.settled ?? (workflow.settledDecisions ?? []).findLast((entry) => entry?.kind === 'own-correction' && entry.subject === settlement.subject) ?? null;
  const workId = workflow.workItem.id;
  const line = `Copilot found "${found}" in its own work; version ${next} of ${step} fixes it.`;
  const nextAction = (await opening.kernelRoute(root, workflow, phase, { config })).route;
  const result = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'own-correction', workId, phase: phase.id,
    fromGeneration: from, toGeneration: next, mutates: true, line, correction: found,
    settled: settled ? { id: settled.id, kind: settled.kind, answer: settled.answer, evidence: settled.evidence,
      undo: { copilotCommand: `/sf-decide ${workId}`, words: `An undo does not withdraw version ${next}: it stays open. It makes SFlow ask you before it starts another version of ${step} for Copilot's own correction.` } } : null,
    preserved: code ? `Version ${from}, its evidence and its test results stay as published.` : `Version ${from} stays as published.`,
    opened: { generation: next, status: 'open' }, opening: opened.outcome, replayed: opened.replayed, nextAction,
    // In this same turn the entry is read once, which admits the fix.
    next: { command: stepEntryCommand(phase.id, workId), skill: nextAction?.skill ?? null,
      copilotCommand: nextAction?.copilotCommand ?? (nextAction?.skill ? `${nextAction.skill} ${phase.id}` : null),
      reason: `Fix it in version ${next} of ${step} now, in this same turn: read the entry once, then fix it.` } };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(line);
}
