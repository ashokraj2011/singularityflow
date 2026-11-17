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

import { phaseRequiresCodeDelivery, successorSkillForPhase } from './code-delivery-policy.mjs';
import { requestedSuccessorAction, requestedSuccessorEligible } from './guide.mjs';
import { authorCommand } from './action-command-map.mjs';

export { requestedSuccessorAction, requestedSuccessorEligible };

// The asked-for record loads only where it is read: every next-steps read builds the guide's routes.
const askedFor = () => import('./asked-for.mjs');
const subject = (workflow, phase, { askedForGeneration }) => ({ workId: workflow.workItem.id, phase: phase.id, generation: askedForGeneration(phase) });

/** What the person asked to change for the next generation, in the order typed: each turn's redacted words. */
export async function requestedChanges(root, workflow, phase) {
  if (!requestedSuccessorEligible(workflow, phase)) return [];
  const { gitDir } = await import('./git.mjs');
  return (await askedFor()).waitingWords(gitDir(root), workflow, phase);
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

/**
 * The route to the version an instruction left unaccounted is accounted for in, once the step's own version is published
 * [SCS:REQ-042]: a reopened step's preview of its next version, as the kernel names it, else the preview of a change the
 * person asks for. Each opens only on the person's yes [D3, OSA:REQ-030]; null when neither applies.
 */
export async function nextVersionRoute(root, workflow, phase) {
  const { decision, route } = await (await import('./commands/phase-opening.mjs')).kernelRoute(root, workflow, phase);
  if (['open-version', 'build-version'].includes(decision?.next?.operation) && route?.command) return { command: route.command, skill: route.skill ?? null };
  const requested = requestedSuccessorAction(workflow, phase);
  return requested?.command ? { command: requested.command, skill: requested.skill ?? null } : null;
}

/**
 * Whether `version` of the step is already asked as its own question: its preview's proposal waits for the person's yes
 * on this Story as it stands, or their yes is kept for it (story-version-consent.mjs) [D3, OSA:REQ-030, Stage 4]. The
 * decisions list then asks it once, as that question, on every card and in the terminal.
 */
export async function successorAsked(root, workflow, phase, version) {
  const [{ gitDirectories }, { pendingProposalRecord }, { head }] = await Promise.all([import('./story-version-acceptance.mjs'),
    import('./story-version-consent.mjs'), import('./git.mjs')]);
  const directories = gitDirectories(root);
  const record = directories ? await pendingProposalRecord(directories.commonDir, { workId: workflow.workItem.id, phase: phase.id, lifecycleRevision: head(root) }) : null;
  return Boolean(record) && record.proposal.consent === 'required' && Number(record.proposal.version) === Number(version);
}

/**
 * The person's yes on the decisions card, kept on this clone for the step's waiting proposal on the Story as it stands:
 * `{ version, surface, expiresAt }`, or null. The step's work command then goes straight to its preview and confirmation,
 * which that yes lets through (the edit guard admits a card's yes with no question in the turn), and asks nothing again
 * [D3, OSA:REQ-030]. A yes answered to the question tool belongs to the turn that asked it.
 */
export async function keptYes(root, workflow, phase) {
  const [{ gitDirectories }, consent, { head }] = await Promise.all([import('./story-version-acceptance.mjs'),
    import('./story-version-consent.mjs'), import('./git.mjs')]);
  const directories = gitDirectories(root);
  const record = directories ? await consent.pendingProposalRecord(directories.commonDir, { workId: workflow.workItem.id, phase: phase.id, lifecycleRevision: head(root) }) : null;
  if (record?.proposal?.consent !== 'required') return null;
  const grant = await consent.readGrant(directories.commonDir, record.digest);
  return grant?.surface === 'decisions-card' ? { version: Number(record.proposal.version), surface: grant.surface, expiresAt: grant.expiresAt } : null;
}

/** The version question's third answer, in the words both cards and the question tool show (owner, 2026-11-18). */
export const JUST_A_QUESTION = 'No, it was just a question';

/**
 * The person's "No, it was just a question" to a published step's version question, for the proposal `record` they were
 * shown (owner, 2026-11-18): what they typed is kept, accounted for as a question answered with nothing to change
 * (asked-for-records.mjs answerAsQuestion), no version opens and nothing else is asked. Only for a version proposed for
 * words the person typed (`requested-change`); a review's corrections or a return is never "just a question". Returns
 * the kernel's next for the step, which is what a No goes on with now that nothing waits (`declined`).
 */
export async function answerJustAQuestion(root, config, workflow, phase, { proposal, surface, actor, agent = null }) {
  const { SingularityFlowError } = await import('./util.mjs');
  if (proposal?.reason !== 'requested-change') throw new SingularityFlowError(`Version ${proposal?.version ?? 'N'} of ${phase.label ?? phase.id} was proposed for something other than words the person typed, so it cannot be answered as just a question; nothing was recorded.`, {
    code: 'VERSION_QUESTION_NOT_TYPED', details: { nextAction: (await (await import('./commands/phase-opening.mjs')).kernelRoute(root, workflow, phase, { config })).route } });
  const answered = await (await import('./asked-for-records.mjs')).answerAsQuestion(root, config, workflow, phase, { actor, agent, surface, version: proposal.version });
  const { route } = await (await import('./commands/phase-opening.mjs')).kernelRoute(root, workflow, phase, { config });
  const name = phase.label ?? phase.id;
  const words = `It was just a question: version ${proposal.version} of ${name} was not started. What you typed is kept with the step, accounted for as a question with nothing to change; its approver sees that and can return the step if it was really a change.${route?.label ? ` ${route.label}` : ''}`;
  return { answered, words, next: route?.command ? { command: route.command, copilotCommand: route.copilotCommand ?? null, skill: route.skill ?? route.copilotCommand?.split(' ')[0] ?? null } : null };
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
export async function requestedSuccessorRollover(root, config, workflow, phase, options, { correction = null } = {}) {
  const [{ typedFocusOff }, { optionBoolean, optionString, SingularityFlowError }, { generationResultMatches, generationResultDigest },
    { safeCommandGuidance }, { nextPhaseGeneration }, { printCommandRoutes }] = await Promise.all([
    askedFor(), import('./util.mjs'), import('./state-stores.mjs'), import('./safe-command-guidance.mjs'), import('./phase-generation.mjs'),
    import('./commands/shared/print-command-routes.mjs')]);
  // A retained review asking corrections opens the next version on the person's yes, also on a step a person's return
  // once reopened and that has published since (its change request stays open until approval) [OSA:REQ-030].
  const [{ versionFactsOf }, { beingWritten }] = await Promise.all([import('./phase-generation-need.mjs'), import('./kernel/step-versions.mjs')]);
  const published = Number(phase.generation ?? 0) >= 1 && !beingWritten(versionFactsOf(workflow, phase));
  const reviewed = requestedSuccessorEligible(workflow, phase) || !published ? null : await reviewCorrectionRequest(root, config, workflow, phase);
  // Nothing to roll over: the step's next action as the kernel decides it, never a refusal with no route (review, 2026-11-17).
  if (!requestedSuccessorEligible(workflow, phase) && !reviewed) throw new SingularityFlowError(
    `Phase '${phase.id}' has no changed consumed generation to roll over.`, { code: 'GENERATION_ROLLOVER_UNAVAILABLE',
      details: { phase: phase.id, nextAction: (await (await import('./commands/phase-opening.mjs')).kernelRoute(root, workflow, phase, { config })).route } });
  let supplied = optionString(options, 'confirm');
  // The author's own correction is a change the author names; it is asked like any other (owner, 2026-11-17).
  const given = correction ?? optionString(options, 'reason', null);
  // The author's correction is its own words, never recorded as what the person asked for: it is the proposal's request alone.
  const reason = given === null ? null : correction ? (await (await askedFor()).redactedWords(String(given)))?.text ?? null
    : await noteRequestedChange(root, workflow, phase, given);
  if (given !== null && reason === null) throw new SingularityFlowError('--reason needs the words that say what to change; nothing was left after redaction.', {
    code: 'GENERATION_CHANGE_REASON_REQUIRED' });
  const review = await reviewCorrectionRequest(root, config, workflow, phase);
  const requests = correction ? (reason ? [reason] : []) : [...new Set([...await requestedChanges(root, workflow, phase), ...(reason && typedFocusOff(workflow) ? [reason] : []),
    ...(review ? [review] : [])])];
  const next = nextPhaseGeneration(phase);
  const code = phaseRequiresCodeDelivery(phase);
  // A published document edited since, with nothing else asked: the edit is the reason, in SFlow's words, never kept as the
  // person's typed words; before, the preview refused and an agent made up words of its own (review, 2026-11-17).
  const edited = !correction && !code && !requests.length
    ? await (await import('./phase-publication-unchanged.mjs')).documentEditedSincePublication(root, config, workflow, phase) : null;
  if (edited) requests.push(`${edited} was edited after version ${phase.generation} was published.`);
  const skill = successorSkillForPhase(phase, workflow);
  if (!requests.length) throw new SingularityFlowError(
    `${phase.id} generation ${phase.generation} is published and unchanged; its next generation opens for a change the person asks for. `
    + `Say what to change: ${skill} ${phase.id} <what to change>, or singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json. Or submit it as it is.`,
    { code: 'GENERATION_CHANGE_NOT_REQUESTED', details: { phase: phase.id, generation: phase.generation, toGeneration: next,
      nextAction: { command: `singularity-flow phase rollover ${phase.id} --reason "<what to change>" --json`, skill,
        label: `Say what to change (or type it after ${skill} ${phase.id}); generation ${phase.generation} stays as published.` } } });
  // A document's published draft is bound by its authored text: the next draft opens over exactly what the person saw.
  const resultDigest = !code ? await documentDraftDigest(root, config, workflow, phase)
    : await generationResultMatches(root, config, workflow, phase)
      ? phase.generationIntent.publication.resultDigest : generationResultDigest(root, config, workflow, phase);
  const expected = requestedSuccessorConfirmation(workflow, phase, resultDigest, requests);
  const confirmArgv = ['phase', 'rollover', phase.id, ...(correction ? ['--correction', correction] : reason && typedFocusOff(workflow) ? ['--reason', reason] : []),
    '--confirm', expected];
  const route = safeCommandGuidance({ argv: confirmArgv, skill });
  // The proposal the person answers [OSA §7.1]: its exact version, the publication it keeps and the question asked.
  const opening = await import('./commands/phase-opening.mjs');
  const kind = correction ? 'own-correction' : edited ? 'changed-after-publication' : review && requests.length === 1 ? 'review-corrections' : 'requested-change';
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: kind, confirmation: expected });
  // Words the person typed may have been only a question: its third answer keeps them as one, and opens nothing (owner, 2026-11-18).
  // The yes's own confirmation, answered as a question: the same proposal, the same confirmation.
  const questionArgv = kind === 'requested-change' && !typedFocusOff(workflow) ? [...confirmArgv.slice(0, 3), '--as-question', ...confirmArgv.slice(3), '--json'] : null;
  if (optionBoolean(options, 'as-question')) {
    if (!questionArgv) throw new SingularityFlowError(`Version ${proposed.proposal.version} of ${phase.label ?? phase.id} is proposed for something other than words the person typed, so it cannot be answered as just a question; nothing was recorded.`, {
      code: 'VERSION_QUESTION_NOT_TYPED', details: { phase: phase.id, nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route } });
    if (!supplied) throw new SingularityFlowError('--as-question needs --confirm with the confirmation the preview showed, so the answer is bound to the question the person saw; nothing was recorded.', {
      code: 'GENERATION_ROLLOVER_STALE', details: { phase: phase.id, nextAction: (await opening.kernelRoute(root, workflow, phase, { config })).route } });
    await opening.staleRollover(supplied, expected,
      'The confirmation is not the current one: what was asked for or the published bytes changed since the preview. Preview again and ask the person again; nothing was recorded.', null);
    const [{ actionActor }, { loadSession }] = await Promise.all([import('./git.mjs'), import('./session.mjs')]);
    const session = await loadSession(root, { required: false }).catch(() => null);
    const answer = await answerJustAQuestion(root, config, workflow, phase, { proposal: proposed.proposal, surface: 'question-tool', actor: actionActor(root),
      agent: session?.workId === workflow.workItem.id ? session.agent ?? null : null });
    const result = { schemaVersion: 1, resultType: 'sflow-version-question-answered', workId: workflow.workItem.id, phase: phase.id, version: proposed.proposal.version,
      answer: JUST_A_QUESTION, opened: null, instructions: answer.answered.instructions, words: answer.words, nextAction: answer.next, mutates: true };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(answer.words);
  }
  const questionRoute = questionArgv ? safeCommandGuidance({ argv: questionArgv, skill }) : null;
  const preview = {
    schemaVersion: 1, resultType: 'sflow-generation-rollover', kind: kind === 'review-corrections' ? 'requested-change' : kind,
    workId: workflow.workItem.id, phase: phase.id, fromGeneration: phase.generation, toGeneration: proposed.proposal.version, question: proposed.question,
    requestedChange: { requests, keptAs: edited ? 'the edited document itself; nothing is kept as typed words' : typedFocusOff(workflow) ? 'this command only'
      : `typed words of generation ${next} ("Asked for" once it is prepublished)` },
    confirmation: expected, currentResultDigest: resultDigest,
    preserved: code ? `Generation ${phase.generation}, its evidence and its test results stay as published.`
      : `Generation ${phase.generation} and its review stay as published.`,
    command: route?.command ?? null, executable: route?.executable ?? null, argv: route?.argv ?? null, skill: route?.skill ?? null,
    copilotCommand: route?.copilotCommand ?? null, platformCommands: route?.platformCommands ?? null,
    nextAction: route ? { command: route.command, copilotCommand: route.copilotCommand,
      reason: `Show the person what they asked to change and this confirmation; only on their explicit yes open generation ${next}.` } : null,
    // The question's third answer, beside Yes and No: on the person's own "No, it was just a question", its command keeps what
    // they typed as a question with nothing to change and opens nothing (owner, 2026-11-18).
    ...(questionRoute ? { justAQuestion: { answer: JUST_A_QUESTION, command: questionRoute.command, argv: questionRoute.argv,
      reason: `Offer it as the question's third answer. Only on the person's own "${JUST_A_QUESTION}" run it: what they typed is kept as a question, nothing changes and no version opens.` } } : {}),
    mutates: Boolean(supplied)
  };
  let typed = false;
  if (!supplied) {
    // Kept here, sealed, so the hook that hears the person's answer binds it to this exact proposal.
    await opening.recordPreview(root, { ...proposed, confirmation: expected });
    // The person's yes on the decisions card is kept for this exact proposal: its confirmation opens it, asked nothing again.
    const kept = await opening.keptConsent(root, proposed.digest);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(kept && preview.nextAction
      ? { ...preview, consent: kept, nextAction: { ...preview.nextAction, reason: opening.keptReason(proposed.proposal.version) } } : preview, null, 2));
    console.log(`Start ${phase.id} version ${next} for a change (version ${phase.generation} stays as published):`);
    for (const request of requests) console.log(`  · "${request.replace(/\s+/gu, ' ')}"`);
    // A person confirms the step and generation they just read, never a digest [no hashes shown]: in their own
    // terminal this same process asks, and binds the digest it derived above; `--json` keeps it for an agent.
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      // Their own terminal offers the same third answer as the cards: "question" keeps it as one and opens nothing (owner, 2026-11-18).
      const said = questionArgv ? await terminalAnswer(proposed.question) : await opening.askAtTerminal(proposed.question) ? 'yes' : '';
      if (said === 'question') {
        const { actionActor } = await import('./git.mjs');
        return console.log((await answerJustAQuestion(root, config, workflow, phase, { proposal: proposed.proposal, surface: 'terminal', actor: actionActor(root) })).words);
      }
      if (said !== 'yes') return console.log('Nothing was changed.');
      supplied = expected;
      typed = true;
    } else {
      printCommandRoutes(safeCommandGuidance({ argv: confirmArgv.slice(0, confirmArgv.indexOf('--confirm')), skill }),
        { label: 'To start it, run this in your own terminal, which asks you to confirm, or ask Copilot' });
      return console.log('Nothing was changed.');
    }
  }
  await opening.staleRollover(supplied, expected,
    'The rollover confirmation is not the current one: what was asked for or the published bytes changed since the preview. Preview again (its JSON carries the current confirmation).', preview);
  // One opening operation on the person's yes: the reservation, the opening record and their receipt, shared [OSA:REQ-030, REQ-031].
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed, typed,
    open: code ? opening.codeOpening(root, config) : opening.documentOpening() });
  if (!code) {
    const result = { ...preview, mutates: true, nextAction: (await opening.kernelRoute(root, workflow, phase)).route, opened: { generation: next, status: 'open' }, opening: opened.outcome, replayed: opened.replayed,
      next: { command: authorCommand(phase.id), copilotCommand: `${skill} ${phase.id}`,
        reason: `Author draft ${next} for what was asked in this step; it is checked${(await import('./source-review-policy.mjs')).sourceReviewRequired(workflow, phase.id) ? ' and reviewed' : ''} again before it is published.` } };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`Opened ${phase.id} version ${next} for the change asked for. Version ${phase.generation} stays as published.`);
    return;
  }
  const intent = phase.generationIntent;
  // What follows is the kernel's next for the open version: writing it, in this same turn.
  const result = { ...preview, mutates: true, nextAction: (await opening.kernelRoute(root, workflow, phase)).route, generationIntent: intent, opening: opened.outcome, replayed: opened.replayed,
    next: { command: authorCommand(phase.id), copilotCommand: `/sf-code ${phase.id}`,
      reason: `Author generation ${intent.generation} for what was asked; its tests run again before it is published.` } };
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`Opened ${phase.id} version ${intent.generation} for the change asked for. Version ${phase.generation} stays as published.`);
}

/** The person's answer at their own terminal: `yes`, `question` (it was just a question), or anything else, which starts nothing. */
async function terminalAnswer(question) {
  const { createInterface } = await import('node:readline/promises');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`${question} Type yes to start it, question if it was just a question, or press Enter to cancel: `)).trim().toLowerCase(); }
  finally { terminal.close(); }
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
 * level 2]: its blocking findings, from the review of that generation, are the reason generation N+1 opens in the same step.
 * The person still confirms the rollover, as for any other.
 */
export async function reviewCorrectionRequest(root, config, workflow, phase) {
  const { sourceReviewRequired } = await import('./source-review-policy.mjs');
  if (!sourceReviewRequired(workflow, phase.id)) return null;
  const lifecycle = await import('./source-review-lifecycle.mjs');
  let status;
  try { status = await lifecycle.readSourceReviewStatus(root, config, workflow, phase.id); }
  catch { status = null; }
  let blocking;
  if (status?.status === 'correction-required' && status.reportSha256 && Number(status.generation) === Number(phase.generation)) {
    blocking = (status.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required');
  } else if (!status || status.status === 'stale') {
    // A person who edited the published document after its review asked for corrections changed what that review is bound
    // to, not what it asked: the retained report of this version still asks for its corrections, so the next version is
    // still to fix them, asked as the review's question [stage5b.md section 5, decision 5].
    const report = await lifecycle.retainedReviewReport(root, config, workflow, phase.id);
    blocking = (report?.findings ?? []).filter((entry) => entry?.severity === 'blocking' && String(entry.message ?? '').trim()
      && (!entry.ownerPhase || entry.ownerPhase === phase.id)).map((entry) => ({ message: `Reviewer finding '${entry.id}': ${entry.message}` }));
    if (!blocking.length) return null;
  } else return null;
  const words = blocking.slice(0, 5).map((entry) => String(entry.message ?? entry.code).replace(/\s+/gu, ' ').slice(0, 300));
  // Named by its version, never its digest: these words are shown and kept as "Asked for" [no hashes shown; the person's word is "version"].
  return `Correct what the review of version ${phase.generation} found: ${words.join(' | ') || 'its blocking findings'}`.slice(0, 2000);
}
