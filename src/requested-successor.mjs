/**
 * A change the person asks for after an authored step published, before it is submitted: the step's next
 * generation opens in the same step, from a reviewed rollover the person confirms (owner, 2026-11-10; every
 * authored step, document or code, 2026-11-12).
 *
 * Before, a successor opened only once the published bytes had changed, after a returned submission or
 * after a review asking for corrections. The guard keeps the published generation locked, so its bytes
 * never changed and a person's own request ("the screen size keeps changing") had no route in the step:
 * only submit. Now the words they typed after /sf-code or /sf-phase (asked-for.mjs keeps them for the
 * generation the step makes next), or given to `phase rollover --reason`, open generation N+1 once the
 * person confirms them. Generation N, its evidence and its test results stay as published; the words
 * reach "Asked for" through the same path, when N+1 is prepublished.
 *
 * Never automatic: the rollover's confirmation is the person's, as for any rollover (/sf-confirm).
 */
import { createHash } from 'node:crypto';

import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import { requestedSuccessorAction, requestedSuccessorEligible } from './guide.mjs';

export { requestedSuccessorAction, requestedSuccessorEligible };

// The asked-for record loads only where it is read: every next-steps read builds the guide's routes.
const askedFor = () => import('./asked-for.mjs');
const subject = (workflow, phase, { askedForGeneration }) => ({ workId: workflow.workItem.id, phase: phase.id, generation: askedForGeneration(phase) });

/** What the person asked to change for the next generation, in the order typed: each turn's redacted words. */
export async function requestedChanges(root, workflow, phase) {
  if (!requestedSuccessorEligible(workflow, phase)) return [];
  const record = await askedFor();
  const { localAskedFor, needsAccount, typedFocusOff } = record;
  if (typedFocusOff(workflow)) return [];
  const { gitDir } = await import('./git.mjs');
  const local = await localAskedFor(gitDir(root), subject(workflow, phase, record));
  return local.turns.filter((turn) => needsAccount(turn) && typeof turn.text === 'string' && turn.text.trim())
    .map((turn) => turn.text);
}

/**
 * Keep `--reason` words as typed words of the next generation, once: redacted and cut like any typed
 * words. Returns the kept text, or null when nothing is left after redaction.
 */
export async function noteRequestedChange(root, workflow, phase, reason) {
  const record = await askedFor();
  const { localAskedFor, noteAskedFor, redactedWords, typedFocusOff } = record;
  const words = await redactedWords(String(reason ?? ''));
  if (!words) return null;
  if (typedFocusOff(workflow)) return words.text;
  const { gitDir } = await import('./git.mjs');
  const where = subject(workflow, phase, record);
  const kept = await localAskedFor(gitDir(root), where);
  if (!kept.turns.some((turn) => turn.text === words.text)) {
    await noteAskedFor(gitDir(root), { ...where, text: words.text, ...(words.truncated ? { truncated: true } : {}), skill: 'phase-rollover',
      turnId: `rollover-${createHash('sha256').update(words.text).digest('hex').slice(0, 16)}`, at: new Date().toISOString() });
  }
  return words.text;
}

/** The value the person confirms: the published generation, its exact bytes and the words that ask for the change. */
export function requestedSuccessorConfirmation(workflow, phase, resultDigest, requests) {
  return `sha256:${createHash('sha256').update(JSON.stringify({ kind: 'requested-successor', workId: workflow.workItem.id,
    phase: phase.id, generation: Number(phase.generation), resultDigest, requests })).digest('hex')}`;
}

/**
 * `phase rollover` for a published, unchanged code generation (requested-successor.mjs): preview the next
 * generation for what the person asked to change, and open it only on their exact confirmation.
 */
export async function requestedSuccessorRollover(root, config, workflow, phase, options) {
  const [{ typedFocusOff }, { optionBoolean, optionString, SingularityFlowError }, { generationResultMatches, generationResultDigest, beginPhaseGeneration, saveStoryDraft },
    { safeCommandGuidance }, { nextPhaseGeneration }, { printCommandRoutes }, { storyDraftTransaction }, { verifyOpenGenerationIntent }] = await Promise.all([
    askedFor(), import('./util.mjs'), import('./state-stores.mjs'), import('./safe-command-guidance.mjs'), import('./phase-generation.mjs'),
    import('./commands/shared/print-command-routes.mjs'), import('./commands/shared/story-draft-transaction.mjs'), import('./generation-boundary.mjs')]);
  if (!requestedSuccessorEligible(workflow, phase)) throw new SingularityFlowError(
    `Phase '${phase.id}' has no changed consumed generation to roll over.`, { code: 'GENERATION_ROLLOVER_UNAVAILABLE', details: null });
  const supplied = optionString(options, 'confirm');
  const given = optionString(options, 'reason', null);
  const reason = given === null ? null : await noteRequestedChange(root, workflow, phase, given);
  if (given !== null && reason === null) throw new SingularityFlowError('--reason needs the words that say what to change; nothing was left after redaction.', {
    code: 'GENERATION_CHANGE_REASON_REQUIRED' });
  const review = await reviewCorrectionRequest(root, config, workflow, phase);
  const requests = [...new Set([...await requestedChanges(root, workflow, phase), ...(reason && typedFocusOff(workflow) ? [reason] : []),
    ...(review ? [review] : [])])];
  const next = nextPhaseGeneration(phase);
  const code = phaseRequiresCodeDelivery(phase);
  const skill = code ? '/sf-code' : directCopilotSkill(generationSkillForPhase(phase, workflow)) ?? '/sf-phase';
  if (!requests.length) throw new SingularityFlowError(
    `${phase.id} generation ${phase.generation} is published and unchanged; its next generation opens for a change the person asks for. `
    + `Say what to change: ${skill} ${phase.id} <what to change>, or singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json. Or submit it as it is.`,
    { code: 'GENERATION_CHANGE_NOT_REQUESTED', details: { phase: phase.id, generation: phase.generation, toGeneration: next,
      nextAction: { command: `singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json`, skill: '/sf-recover',
        label: `Say what to change (or type it after ${skill} ${phase.id}); generation ${phase.generation} stays as published.` } } });
  // A document's published draft is bound by its authored text: the next draft opens over exactly what the person saw.
  const resultDigest = !code ? await documentDraftDigest(root, config, workflow, phase)
    : await generationResultMatches(root, config, workflow, phase)
      ? phase.generationIntent.publication.resultDigest : generationResultDigest(root, config, workflow, phase);
  const expected = requestedSuccessorConfirmation(workflow, phase, resultDigest, requests);
  const confirmArgv = ['phase', 'rollover', phase.id, ...(reason && typedFocusOff(workflow) ? ['--reason', reason] : []), '--confirm', expected];
  const route = safeCommandGuidance({ argv: confirmArgv, skill: '/sf-recover' });
  const preview = {
    schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'requested-change',
    workId: workflow.workItem.id, phase: phase.id, fromGeneration: phase.generation, toGeneration: next,
    requestedChange: { requests, keptAs: typedFocusOff(workflow) ? 'this command only' : `typed words of generation ${next} ("Asked for" once it is prepublished)` },
    confirmation: expected, currentResultDigest: resultDigest,
    preserved: code ? `Generation ${phase.generation}, its evidence and its test results stay as published.`
      : `Generation ${phase.generation} and its review stay as published.`,
    command: route?.command ?? null, executable: route?.executable ?? null, argv: route?.argv ?? null, skill: route?.skill ?? null,
    copilotCommand: route?.copilotCommand ?? null, platformCommands: route?.platformCommands ?? null,
    nextAction: route ? { command: route.command, copilotCommand: route.copilotCommand,
      reason: `Show the person what they asked to change and this confirmation; only on their explicit yes open generation ${next}.` } : null,
    mutates: Boolean(supplied)
  };
  if (!supplied) {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(preview, null, 2));
    else {
      console.log(`Start ${phase.id} generation ${next} for a change (generation ${phase.generation} stays as published):`);
      for (const request of requests) console.log(`  · "${request.replace(/\s+/gu, ' ')}"`);
      console.log(`Confirm: ${expected}`);
      if (route) printCommandRoutes(route, { label: 'Continue' });
      console.log('Nothing was changed.');
    }
    return;
  }
  if (supplied !== expected) throw new SingularityFlowError(
    `The rollover confirmation must equal ${expected}: what was asked for or the published bytes changed since the preview. Preview again.`,
    { code: 'GENERATION_ROLLOVER_STALE', details: preview });
  if (!code) {
    // A document step's next draft: the same reservation an explicit prepare makes (prepared-document-successor.mjs).
    const { reservePreparedDocumentSuccessor } = await import('./prepared-document-successor.mjs');
    const { nowIso } = await import('./util.mjs');
    await storyDraftTransaction(root, config, workflow, `phase-rollover:${phase.id}`, async () => {
      if (!reservePreparedDocumentSuccessor(workflow, phase, nowIso())) throw new SingularityFlowError(
        `Phase '${phase.id}' has no published draft to start the next one from.`, { code: 'GENERATION_ROLLOVER_UNAVAILABLE', details: null });
      await saveStoryDraft(root, config, workflow);
    });
    const result = { ...preview, mutates: true, nextAction: null, opened: { generation: next, status: 'open' },
      next: { command: `singularity-flow prepare ${phase.id}`, copilotCommand: `${skill} ${phase.id}`,
        reason: `Author draft ${next} for what was asked in this step; it is checked${(await import('./source-review-policy.mjs')).sourceReviewRequired(workflow, phase.id) ? ' and reviewed' : ''} again before it is published.` } };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`Opened ${phase.id} draft ${next} for the change asked for. Draft ${phase.generation} stays as published.`);
    return;
  }
  const intent = await storyDraftTransaction(root, config, workflow, `phase-rollover:${phase.id}`, async () => {
    const opened = await beginPhaseGeneration(root, config, workflow, { phaseId: phase.id });
    await saveStoryDraft(root, config, workflow);
    await verifyOpenGenerationIntent(root, workflow, phase);
    return opened;
  });
  const result = { ...preview, mutates: true, nextAction: null, generationIntent: intent,
    next: { command: `singularity-flow prepare ${phase.id}`, copilotCommand: `/sf-code ${phase.id}`,
      reason: `Author generation ${intent.generation} for what was asked; its tests run again before it is published.` } };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`Opened ${phase.id} generation ${intent.generation} for the change asked for. Generation ${phase.generation} stays as published.`);
}

/** A document step's published draft as the person saw it: its generation, commit and authored text. */
async function documentDraftDigest(root, config, workflow, phase) {
  const [{ requiredRepoPath }, { authoredArtifactFingerprint }, { readFile }, path] = await Promise.all([
    import('./story-state-validation.mjs'), import('./artifact-review-read.mjs'), import('node:fs/promises'), import('node:path')]);
  const relative = requiredRepoPath(config, workflow, phase);
  const text = relative ? await readFile(path.join(root, relative), 'utf8').catch(() => null) : null;
  return `sha256:${createHash('sha256').update(JSON.stringify({ phase: phase.id, generation: Number(phase.generation),
    commit: phase.generationCommit ?? null, authored: text === null ? null : authoredArtifactFingerprint(text) })).digest('hex')}`;
}

/**
 * A retained review of this generation that asks for corrections is a change the step itself asks for [review
 * level 2]: its report, by SHA-256, and its blocking findings are the reason generation N+1 opens in the same step.
 * The person still confirms the rollover, as for any other.
 */
export async function reviewCorrectionRequest(root, config, workflow, phase) {
  const { sourceReviewRequired } = await import('./source-review-policy.mjs');
  if (!sourceReviewRequired(workflow, phase.id)) return null;
  let status;
  try { status = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id); }
  catch { return null; }
  if (status?.status !== 'correction-required' || !status.reportSha256 || Number(status.generation) !== Number(phase.generation)) return null;
  const blocking = (status.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required').slice(0, 5)
    .map((entry) => String(entry.message ?? entry.code).replace(/\s+/gu, ' ').slice(0, 300));
  return `Correct what review ${status.reportSha256.slice(0, 12)} of generation ${phase.generation} found: ${blocking.join(' | ') || 'its blocking findings'}`.slice(0, 2000);
}
