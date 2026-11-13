/**
 * The author's own correction of its own published draft, before anyone reviewed or approved it [owner, 2026-11-13].
 *
 * "Would you like me to open generation 2 to correct the summary?" was asked of a person about a draft only the agent
 * had seen: its summary contradicted a decision the engine recorded. The answer is the author's, and clear: correct
 * it. So `phase rollover <step> --correction "<what contradicts what>"` opens the next generation without the
 * person's confirmation, and records it as settled with its evidence: the generation the agent published, that no
 * independent review report and no approval exists for it, and the contradiction the author names. The decisions card
 * lists it with an undo. Once a review report or an approval exists for the generation, or a person undid an earlier
 * correction of it, the rollover is the person's again, as before: preview it and ask (requested-successor.mjs).
 */
import { SingularityFlowError } from './util.mjs';

const MINIMUM = 20;
const MAXIMUM = 1000;

const refuse = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

/** Why the author may not correct `phase` on its own now, or null when it may; read-only. */
export async function ownCorrectionHold(root, config, workflow, phase) {
  const [{ requestedSuccessorEligible }, { settlementState }] = await Promise.all([import('./guide.mjs'), import('./settled-decisions.mjs')]);
  const generation = Number(phase?.generation ?? 0);
  if (!requestedSuccessorEligible(workflow, phase)) return { code: 'GENERATION_ROLLOVER_UNAVAILABLE', words: `${phase?.id ?? 'This step'} has no published, unchanged generation of its own to correct here.` };
  const authorship = [...(phase.authorship ?? [])].reverse().find((entry) => Number(entry.generation) === generation);
  if (authorship?.producer !== 'governed-agent') {
    return { code: 'GENERATION_OWN_CORRECTION_NOT_OWN', words: `${phase.id} generation ${generation} was not published by its agent, so correcting it is the person's to confirm.` };
  }
  if ((phase.approvals ?? []).some((entry) => !entry.invalidatedAt && Number(entry.generation) === generation)) {
    return { code: 'GENERATION_OWN_CORRECTION_REVIEWED', words: `${phase.id} generation ${generation} has an approval decision, so correcting it is the person's to confirm.` };
  }
  const { sourceReviewRequired } = await import('./source-review-policy.mjs');
  if (sourceReviewRequired(workflow, phase.id)) {
    let status = null;
    try { status = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id); }
    catch { status = null; }
    // A review that cannot be read is not known to be absent: nothing settles then.
    if (!status) return { code: 'GENERATION_OWN_CORRECTION_REVIEWED', words: `Whether ${phase.id} generation ${generation} was reviewed cannot be read, so correcting it is the person's to confirm.` };
    if (status.reportSha256 && Number(status.generation) === generation) {
      return { code: 'GENERATION_OWN_CORRECTION_REVIEWED', words: `An independent review of ${phase.id} generation ${generation} is retained, so correcting it is the person's to confirm.` };
    }
  }
  if (settlementState(workflow, 'own-correction', subjectOf(phase)) === 'undone') {
    return { code: 'GENERATION_OWN_CORRECTION_UNDONE', words: `A person undid an earlier own correction of ${phase.id} generation ${generation}, so the next one is theirs to confirm.` };
  }
  return null;
}

const subjectOf = (phase) => `${phase.id} generation ${Number(phase.generation)}`;

/**
 * `phase rollover <step> --correction TEXT`: open generation N+1 for the author's own correction, settled, or refuse
 * with the person's route when it is not the author's alone.
 */
export async function ownCorrectionRollover(root, config, workflow, phase, options) {
  const [{ optionBoolean, optionString }, { phaseRequiresCodeDelivery }] = await Promise.all([import('./util.mjs'), import('./code-delivery-policy.mjs')]);
  const correction = String(optionString(options, 'correction') ?? '').replace(/\s+/gu, ' ').trim();
  if (correction.length < MINIMUM || correction.length > MAXIMUM) {
    refuse(`--correction says what the published draft gets wrong and what it contradicts, in ${MINIMUM} to ${MAXIMUM} characters.`, 'GENERATION_CORRECTION_REASON_REQUIRED');
  }
  if (optionString(options, 'confirm') || optionString(options, 'reason', null) !== null) {
    refuse('--correction is the author\'s own correction and takes no --confirm or --reason: a change the person asks for is previewed with --reason and confirmed by them.', 'GENERATION_ROLLOVER_OPTIONS_INVALID');
  }
  const hold = await ownCorrectionHold(root, config, workflow, phase);
  if (hold) refuse(`${hold.words} Preview the next generation for it and ask the person: singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json.`, hold.code, {
    phase: phase.id, generation: phase.generation,
    nextAction: { command: `singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json`, skill: '/sf-recover',
      label: `Preview generation ${Number(phase.generation) + 1} of ${phase.id} for the correction, then ask the person to confirm it.` } });
  const code = phaseRequiresCodeDelivery(phase);
  const from = Number(phase.generation);
  const next = from + 1;
  const [{ commitSettledDecision }, { actionActor }, { loadSession }] = await Promise.all([
    import('./settled-decisions.mjs'), import('./commands/kernel.mjs'), import('./session.mjs')]);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const { record: settled } = await commitSettledDecision(root, config, workflow, {
    kind: 'own-correction', by: 'agent', phase: phase.id, subject: subjectOf(phase),
    answer: `Opened ${phase.id} ${code ? 'generation' : 'draft'} ${next} to correct the agent's own ${code ? 'generation' : 'draft'} ${from}: ${correction}`,
    evidence: [
      { what: `${code ? 'generation' : 'draft'} ${from} of ${phase.id} was published by its agent`, where: `${phase.id} ${code ? 'generation' : 'draft'} ${from}` },
      { what: 'no independent review report and no approval exist for it', where: `${phase.id} review and approval records` },
      { what: correction, where: 'the author\'s own correction' }
    ],
    effect: { generation: from, toGeneration: next }
  }, { actor: actionActor(root), agent });
  const opened = await openNext(root, config, workflow, phase, code);
  const result = { schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: 'own-correction', workId: workflow.workItem.id, phase: phase.id,
    fromGeneration: from, toGeneration: next, mutates: true, correction,
    settled: { id: settled.id, kind: settled.kind, answer: settled.answer, evidence: settled.evidence,
      words: `Settled for the person (nobody was asked); the decisions card lists it with an undo: /sf-decide ${workflow.workItem.id}.` },
    preserved: `${code ? 'Generation' : 'Draft'} ${from} stays as published.`, ...opened,
    next: { command: `singularity-flow prepare ${phase.id}`, copilotCommand: code ? `/sf-code ${phase.id}` : `/sf-phase ${phase.id}`,
      reason: `Author ${code ? 'generation' : 'draft'} ${next} with the correction; it is checked again before it is published.` } };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Opened ${phase.id} ${code ? 'generation' : 'draft'} ${next} to correct ${code ? 'generation' : 'draft'} ${from}: ${correction}`);
  console.log(`Settled for the person as ${settled.id}; the decisions card lists it with an undo (/sf-decide ${workflow.workItem.id}).`);
}

/** The next generation, as a confirmed rollover opens it (requested-successor.mjs): a code intent, or a document's reservation. */
async function openNext(root, config, workflow, phase, code) {
  const [{ beginPhaseGeneration, saveStoryDraft }, { storyDraftTransaction }, { verifyOpenGenerationIntent }, { nowIso }] = await Promise.all([
    import('./state-stores.mjs'), import('./commands/shared/story-draft-transaction.mjs'), import('./generation-boundary.mjs'), import('./util.mjs')]);
  if (!code) {
    const { reservePreparedDocumentSuccessor } = await import('./prepared-document-successor.mjs');
    await storyDraftTransaction(root, config, workflow, `phase-rollover:${phase.id}`, async () => {
      if (!reservePreparedDocumentSuccessor(workflow, phase, nowIso())) refuse(`Phase '${phase.id}' has no published draft to start the next one from.`, 'GENERATION_ROLLOVER_UNAVAILABLE');
      await saveStoryDraft(root, config, workflow);
    });
    return { opened: { generation: Number(phase.generation) + 1, status: 'open' } };
  }
  const intent = await storyDraftTransaction(root, config, workflow, `phase-rollover:${phase.id}`, async () => {
    const begun = await beginPhaseGeneration(root, config, workflow, { phaseId: phase.id });
    await saveStoryDraft(root, config, workflow);
    await verifyOpenGenerationIntent(root, workflow, phase);
    return begun;
  });
  return { generationIntent: intent };
}
