/**
 * The author's own correction of its own published draft, before anyone reviewed or approved it.
 *
 * `phase rollover <step> --correction "<what contradicts what>"` proposes the next version for the author's own
 * correction, with the reason `own-correction`, and asks the person "Start version N …?" like every other successor: it
 * opens only on their yes, through the same proposal, consent and opening operation (owner, 2026-11-17, superseding the
 * settled-with-an-undo rule of 2026-11-13) [D3, OSA:REQ-030]. Once a review report or an approval exists for the
 * generation, it is no longer the author's own correction: the preview for a change the person asks for is the route.
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
  // The same preview, question and confirmation as a change the person asks for, with the reason `own-correction`.
  return (await import('./requested-successor.mjs')).requestedSuccessorRollover(root, config, workflow, phase, options, { correction });
}
