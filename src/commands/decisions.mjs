import { formatCommandRouteLines, modelFreeCommandForCommand, VSCODE_DECIDE_CARD } from '../model-free-commands.mjs';
/**
 * `decisions [WORK-ID]` and `decisions record [WORK-ID]`: everything people must decide before a
 * step can move, in plain words, as choices, recorded with one confirmation. [decision list]
 *
 *   singularity-flow decisions [WORK-ID] [--phase PHASE] [--json]
 *   singularity-flow decisions [WORK-ID] --choose d1=reuse [--reason d1=TEXT] [--expires d1=YYYY-MM-DD] [--json]   (preview)
 *   singularity-flow decisions record [WORK-ID] --choose d1=reuse ... --confirm sha256:<DIGEST>   (or --answers FILE)
 *   singularity-flow decisions record [WORK-ID]   (an interactive terminal asks, then confirms)
 *
 * The list reads only. Recording re-reads the list and refuses when its digest no longer matches,
 * checks each chosen item against the current identity's approval groups (an item the person may
 * not decide is refused with who may, and nothing is written for it), then writes each record
 * through the function its own command uses, in a stable order, and reports what was recorded. A
 * failure part way names what was recorded and what remains; listing again shows only what remains.
 *
 * The Copilot guard lets an agent record here only options that write upstream-issue records, in a
 * /sf-decide turn; everything else is the person's own step, on a host's card or in their own terminal,
 * as for `decision evidence-reuse`, `decision test-risk`, `decision test-command` and a convergence adjudication.
 *
 * Update the spec on a deviated or unplanned row writes no record: it drafts the intent amendment beside
 * the checkout's Git data, as `story intent-amendment draft` does, and the result says where (`drafted`)
 * and that writing and proposing it is next [SCS:REQ-020].
 *
 * A pending intent amendment is approved, rejected or refreshed here, and an approved one acknowledged,
 * through `story intent-amendment`'s own functions with every check they make, each alone in its run and
 * said to come from the card when an answers file carries it [owner, 2026-11-13].
 *
 *   singularity-flow decisions undo [WORK-ID] --settled STL-001 [--reason TEXT] [--json]
 *
 * What the agent or SFlow settled for the person is listed as "Settled for you" with its evidence; undoing one,
 * here or with the card's Undo, makes it a question for the person again on its own route [owner, 2026-11-13].
 * Only a person undoes: the Copilot guard refuses it in every turn (person-step-catalog.mjs).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stdin as processInput, stdout as processOutput } from 'node:process';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import { action, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { assertConfirmation, copySlip } from '../text-lines.mjs';
import { nowIso, optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const SHOW_OPTIONS = Object.freeze(['json', 'help', 'no-model', 'work-id', 'phase', 'choose', 'reason', 'expires', 'cause', 'clause', 'card', 'probe', 'probe-wait']);
const RECORD_OPTIONS = Object.freeze([...SHOW_OPTIONS, 'confirm', 'answers', 'fetch', 'version-consent', 'just-a-question', 'expect']);
const UNDO_OPTIONS = Object.freeze(['json', 'help', 'no-model', 'work-id', 'settled', 'reason', 'fetch']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const DECISIONS_USAGE = [
  'Usage: singularity-flow decisions [WORK-ID] [--phase PHASE] [--no-card] [--probe|--no-probe] [--probe-wait SECONDS] [--json]',
  '       singularity-flow decisions [WORK-ID] --choose ITEM=OPTION [--reason ITEM=TEXT] [--expires ITEM=YYYY-MM-DD] [--cause ITEM=TEXT] [--clause ITEM=IDS] [--json]',
  '       singularity-flow decisions record [WORK-ID] --choose ITEM=OPTION [...]   (your own terminal shows the summary and asks)',
  '       singularity-flow decisions record [WORK-ID] --choose ITEM=OPTION [...] --confirm sha256:DIGEST [--json]   (a script or a /sf-decide turn)',
  '       singularity-flow decisions record [WORK-ID] --answers FILE',
  '       singularity-flow decisions record [WORK-ID]   (interactive terminal)',
  '       singularity-flow decisions undo [WORK-ID] --settled STL-ID [--reason TEXT]   (what was settled for you becomes your question again)',
  'Lists what people must decide before the step can move, in plain words with choices, and records the',
  'choices with one confirmation. Each choice is checked against the deciding person\'s approval group and',
  'written as the same records its own command writes. Options with a recommendation are shown first.',
  'Where the right answer depends on a check SFlow can run itself (whether the tests pass on another Node), it runs',
  'that check first, read-only and for at most --probe-wait seconds (60 by default), and recommends from the result.',
  'Your own terminal checks by default; --json checks only with --probe.'
].join('\n');

function refused(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

async function storyContext(root, workId, { record, fetch }) {
  const [{ loadAcceptedStoryExecution }, { loadConfig }] = await Promise.all([
    import('../accepted-story-execution.mjs'), import('../state-stores.mjs')]);
  if (record && workId) {
    // The Story's own branch, which need not be named after its ID; the records commit there.
    const { checkoutStoryBranch } = await import('../story-branch-name.mjs');
    await checkoutStoryBranch(root, await loadConfig(root), workId, { fetch });
  }
  const accepted = await loadAcceptedStoryExecution(root, workId ?? undefined);
  return { config: accepted.definition, workflow: accepted.workflow };
}

/**
 * The step's coverage, criterion proof, findings, vulnerable-dependency hold and required checks beside the
 * list, for the card and the Copilot CLI table to show [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]. Loaded from
 * the CLI source, out of the VS Code gateway bundle; evidence only, so an unreadable one is left out.
 */
async function approvalEvidenceOf(root, config, workflow, packet, at) {
  try {
    const [{ approvalEvidence }, { actionActor }] = await Promise.all([
      import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'approval-evidence.mjs')).href), import('./kernel.mjs')]);
    return await approvalEvidence(root, config, workflow, packet.phase, { actor: actionActor(root),
      authorities: workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, at });
  } catch { return null; }
}

/** The list as it stands now, for the current Git identity. */
export async function readDecisionPacket(root, config, workflow, { phaseId = null, at = nowIso(), card = true } = {}) {
  return (await import('../decision-list-reads.mjs')).readPendingList(root, config, workflow, { phaseId, at, card });
}

/** Whether anything on the list waits on this person now: a question they answer, or the approval they may give. */
export function waitsOnPerson(packet) {
  return [...(packet.items ?? []), ...(packet.offered ?? [])].some((item) => !item.settled && item.decidedBy?.allowed && item.plain?.question
    && (item.kind !== 'approval' || item.details?.ready !== false));
}

/**
 * The Story's own next step when nothing on the list waits on this person now, from the deterministic planner
 * (`nextsteps`' "now", its label and its Copilot, Shell and VS Code forms) [owner, 2026-11-18: "why no next action
 * here"]. Every screen ends with a next action: the list said "Nothing waits on you now." with no way on. Null when
 * something here waits on them, when the planner's next step is this list itself, or when it cannot be read.
 */
export async function storyNextOf(root, workId, packet, { opening = null } = {}) {
  if (opening || waitsOnPerson(packet)) return null;
  try {
    const [{ loadAcceptedStoryExecution }, { resolveStorySnapshot }] = await Promise.all([import('../accepted-story-execution.mjs'), import('./nextsteps.mjs')]);
    const accepted = await loadAcceptedStoryExecution(root, workId);
    return storyNextFrom((await resolveStorySnapshot(root, accepted)).actions?.find((entry) => entry.timing === 'now'), accepted.workflow);
  } catch { return null; }
}

/** The planner's "now" action as the list's next step: its plain label and routes; null for none, or for the list itself. */
export async function storyNextFrom(now, workflow = null) {
  if (!now) return null;
  const [{ nextActionLabel }, { safeCommandGuidance }] = await Promise.all([import('../nextsteps.mjs'), import('../safe-command-guidance.mjs')]);
  const guidance = safeCommandGuidance(now);
  const copilotCommand = guidance?.copilotCommand ?? now.copilotCommand ?? null;
  if (!guidance?.command && !copilotCommand) return null;
  // The list itself is no next step from the list.
  if (/^\/sf-decide\b/u.test(copilotCommand ?? '') || /^singularity-flow decisions\b/u.test(guidance?.command ?? '')) return null;
  return { kind: 'story-next', title: nextActionLabel(now, workflow), command: guidance?.command ?? null, copilotCommand,
    ...(guidance?.modelFreeCommand ? { modelFreeCommand: guidance.modelFreeCommand } : {}) };
}

/**
 * The Decide card as the list's next step [owner, 2026-11-18, office laptop: inside /sf-decide the reply ended
 * "Next — Resolve the remaining decisions: /sf-decide <WORK-ID>"]. Never the command the person is already in: what
 * is left is answered on the card, named as such, by each host's way to it: Copilot CLI's /decide, VS Code's Command
 * Palette entry, and the terminal's own walkthrough.
 */
export function decideCardNext(workId, item = null) {
  return { kind: 'decide-card', ...(item ? { item } : {}), title: 'Open the Decide card', command: `singularity-flow decisions record ${workId}`,
    copilotCommand: `/decide ${workId}`, modelFreeCommand: VSCODE_DECIDE_CARD };
}

/** Whether a route is the list itself for this Story: /sf-decide, or `decisions` with nothing more to do. */
export function routesToList(route, workId) {
  const copilot = String(route?.copilotCommand ?? '').trim().split(/\s+/u);
  const shell = String(route?.command ?? '').trim().split(/\s+/u);
  return (copilot[0] === '/sf-decide' && copilot.length <= 2 && (copilot.length === 1 || copilot[1] === workId))
    || (!route?.copilotCommand && shell[0] === 'singularity-flow' && shell[1] === 'decisions' && shell.length <= 3 && (shell.length === 2 || shell[2] === workId));
}

/**
 * The packet as a decisions screen ends it: with the Story's next step beside it (`storyNext`, and `next` too where the
 * list had only "see nextsteps" or itself), and never with itself as its next step: the Decide card instead.
 */
export function withStoryNext(packet, storyNext) {
  const loops = routesToList(packet.next, packet.workId);
  // With nothing here for this person and no next step read, no next step at all: never the list itself.
  if (!storyNext) return loops ? { ...packet, next: waitsOnPerson(packet) ? decideCardNext(packet.workId, packet.next.item ?? null) : null } : packet;
  // The list's own pointer when it has nothing to start: "see the next steps", or the list itself.
  const generic = !packet.next || loops || packet.next.copilotCommand === `/sf-next ${packet.workId}` || /^singularity-flow decisions\b/u.test(packet.next.command ?? '');
  return { ...packet, storyNext, ...(generic ? { next: storyNext } : {}) };
}

/** "Next: …" with its routes, as every surface ends a list: the Story's next step, or the Decide card. */
export function storyNextLines(storyNext) {
  return storyNext ? [`Next: ${storyNext.title}`, ...formatCommandRouteLines({ command: storyNext.command, copilotCommand: storyNext.copilotCommand,
    modelFreeCommand: storyNext.modelFreeCommand ?? null }, { indent: '  ' })] : [];
}

/**
 * The list after SFlow ran the checks its items' answers depend on (decision-probes.mjs), within `seconds`, read
 * again when any ran [owner, 2026-11-16]: the card recommends from what they found. The checks record nothing.
 */
async function checkedPacket(root, config, workflow, packet, { seconds, phaseId, card = true, say }) {
  const probes = await import('../decision-probes.mjs');
  if (!probes.itemsToCheck(packet).length) return packet;
  const { ran } = await probes.runDecisionProbes(root, packet, { seconds: probes.probeSeconds(seconds), say });
  return ran.length ? readDecisionPacket(root, config, workflow, { phaseId, at: nowIso(), card }) : packet;
}

/** Whether this read runs the checks: a person's own terminal does unless told not to, a script only when asked. */
const probing = (options, { json }) => optionBoolean(options, 'probe', !json);
const toStderr = (line) => process.stderr.write(`${line}\n`);

async function answersFrom(options) {
  const file = optionString(options, 'answers');
  const { parseDecisionAnswers } = await import('../decision-list.mjs');
  if (!file) {
    return parseDecisionAnswers({ choose: optionStrings(options, 'choose'), reason: optionStrings(options, 'reason'),
      expires: optionStrings(options, 'expires'), cause: optionStrings(options, 'cause'), clause: optionStrings(options, 'clause') });
  }
  for (const flag of ['choose', 'reason', 'expires', 'cause', 'clause', 'confirm']) {
    if (options[flag] !== undefined) refused(`--answers carries the choices and the confirmation; do not combine it with --${flag}.`, 'DECISIONS_OPTIONS_INVALID');
  }
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { refused(`The answers file ${file} could not be read as JSON (${error.code ?? error.message}).`, 'DECISIONS_ANSWER_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) refused('The answers file holds one JSON object: { "choose": { "d1": "reuse" }, "confirm": "sha256:..." }.', 'DECISIONS_ANSWER_INVALID');
  const unknown = Object.keys(value).filter((key) => !['choose', 'reason', 'expires', 'cause', 'clause', 'article', 'confirm'].includes(key));
  if (unknown.length) refused(`The answers file has unknown field(s): ${unknown.join(', ')}.`, 'DECISIONS_ANSWER_INVALID');
  return { ...parseDecisionAnswers(value), confirm: typeof value.confirm === 'string' ? value.confirm : null };
}

const answered = (answers) => answers.choose.size > 0;

/** An item of the list, or one it offers beside what it waits on. */
const listedItem = (packet, id) => [...packet.items, ...(packet.offered ?? []), ...(packet.settled ?? [])].find((item) => item.id === id);

/** The values a person changed from the defaults, so the exact record command carries only those. */
function changedValues(packet, plan) {
  const values = { reason: {}, expires: {}, cause: {}, clause: {} };
  for (const step of plan.steps) {
    const option = listedItem(packet, step.item).options.find((entry) => entry.id === step.option);
    for (const flag of ['reason', 'expires', 'cause']) {
      if (step.values[flag] != null && step.values[flag] !== option.needs[flag]?.default) values[flag][step.item] = step.values[flag];
    }
    if (step.values.clause) values.clause[step.item] = step.values.clause.join(',');
  }
  return values;
}

async function previewOf(workflow, packet, plan) {
  const [{ decisionApprovalFlags, decisionChatSteps, decisionRecordCommand, effectWords, ISSUE_ONLY_OPTIONS }, { recordableInApproval }] = await Promise.all([
    import('../decision-list.mjs'), import('../approval-decisions.mjs')]);
  // A draft is written, never recorded: say so.
  const summary = plan.steps.map((step) => `${step.item}. ${listedItem(packet, step.item).title}: ${step.label}. `
    + `${step.effects.every((effect) => effect.kind === 'intent-amendment-draft') ? 'Writes' : 'Records'}: ${step.effects.map((effect) => effectWords(workflow, effect, step.values)).join('; then ')}.`);
  const chosen = { choices: plan.steps.map((step) => [step.item, step.option]), digest: packet.packetSha256, values: changedValues(packet, plan) };
  const command = plan.steps.length ? decisionRecordCommand(packet.workId, {
    phaseId: packet.record.interactive.includes(' --phase ') ? packet.phase : null, ...chosen
  }) : null;
  // An agent may record only options that write upstream-issue records, in a /sf-decide turn; under SF Guard none [owner, 2026-11-14].
  const recordInChat = plan.steps.every((step) => ISSUE_ONLY_OPTIONS.includes(step.option) && !listedItem(packet, step.item).guardSigns);
  // Choices that each hold the step's approval, made by one of its approvers, go in the approval commit [SPEC-OAP M4].
  const approval = packet.items.find((item) => item.kind === 'approval');
  const withApproval = command && approval?.decidedBy?.allowed && !plan.refused.length && plan.steps.every((step) => {
    const item = listedItem(packet, step.item);
    return item.holdsApproval && recordableInApproval(item.options.find((option) => option.id === step.option));
  }) ? (() => {
    const inChat = recordInChat && plan.steps.every((step) => step.option !== 'return');
    // A person's own approval derives the list's digest itself and asks them to confirm; only a turn passes it on.
    const flags = decisionApprovalFlags(inChat ? chosen : { ...chosen, digest: null });
    return { phase: packet.phase, flags, recordInChat: inChat, command: `singularity-flow approve ${packet.phase} --work-id ${packet.workId} --fetch ${flags}` };
  })() : null;
  const chatSteps = decisionChatSteps(packet, plan.steps);
  return {
    steps: plan.steps, refused: plan.refused, summary,
    record: command ? {
      command,
      recordInChat,
      ...(chatSteps.length ? { chatSteps } : {}),
      // A choice no /sf-decide turn may record is the person's on the Decide card, which /sf-decide opens where the host
      // shows it [owner, 2026-11-15]; a host with no card has no Copilot route for it.
      copilotCommand: recordInChat ? `/sf-decide ${packet.workId}` : packet.record.copilotCommand ?? null,
      terminal: 'Run it in your own terminal to record these decisions; nothing is recorded until then.'
    } : null,
    withApproval
  };
}

/**
 * An item's words on every host [owner, 2026-11-16]: its question, why in one sentence and "Recommended: …", from the
 * engine's `plain` (decision-plain.mjs). A packet from an engine before it, or built by hand, reads its own title, the
 * first sentence of its why and its recommendation instead.
 */
export function plainWords(item) {
  if (item.plain && (item.plain.question || item.plain.later || item.plain.settled)) return item.plain;
  const why = String(item.why ?? '').replace(/\s+/gu, ' ').trim();
  if (item.settled) return { settled: `${String(item.title ?? '').replace(/[.!?]+$/u, '')}. Undo if wrong.` };
  return { question: item.title, why: why.split(/(?<=[.!?])\s+/u)[0] ?? why, recommended: item.recommended?.words ?? null };
}

/** The check an item's answer waits on, offered first, or null once SFlow has its result. */
export const checkOf = (item) => (item.check && item.check.status !== 'checked' ? item.check : null);

/** An item nobody can answer yet: one "Later:" line, never a question [owner, 2026-11-16]. */
export const laterOf = (item) => plainWords(item).later ?? null;

function itemLines(item, index, { numbered = false } = {}) {
  const plain = plainWords(item);
  // An intent amendment shows what it changes and reaches, so a person decides it from the same words on every host [owner, 2026-11-13].
  const amendment = [...(item.details?.lines ?? []).map((line) => `     - ${line}`), ...(item.details?.proposedBy ? [`   ${item.details.proposedBy}`] : []),
    ...(item.details?.reach ? [`   ${item.details.reach}`] : [])];
  if (item.settled) {
    // What was settled for the person is no question: one line, and its Undo.
    const undo = item.options.find((option) => option.available !== false);
    return [`${numbered ? `${index + 1}. ` : `${item.id}. `}${plain.settled}`,
      ...(undo && !numbered ? [`   ${undo.id}: ${undo.label}`, ...(undo.terminal ? [`      or in your own terminal: ${undo.terminal}`] : [])] : [])];
  }
  const lines = [`${numbered ? `${index + 1}. ` : `${item.id}. `}${plain.question}`, ...(plain.why ? [`   ${plain.why}`] : []), ...amendment,
    ...(plain.recommended ? [`   ${plain.recommended}`] : [])];
  if (!item.decidedBy.allowed) lines.push(`   ${item.decidedBy.words}${item.decidedBy.share ? ` Share this with them: ${item.decidedBy.share}` : ''}`);
  // Where else it is answered: yes or no in chat, or the person's own terminal when SF Guard signs it.
  if (item.decidedBy.allowed && item.answer?.also) lines.push(`   ${item.answer.also}`);
  const check = checkOf(item);
  // The check SFlow runs itself, first: never a command the person is told to run [owner, 2026-11-16].
  if (check) lines.push(`   ${numbered ? '1)' : 'check:'} ${check.label}${item.recommended?.check ? '  [recommended]' : ''}`, `      ${check.does}`);
  const offset = check ? 1 : 0;
  item.options.forEach((option, position) => {
    // An author's own step (accounting for what the person typed) is never the reader's to do.
    const yours = option.action ? (option.decidedBy?.author ? '  (its author\'s step; never recorded here)' : '  (yours to do; never recorded here)')
      : option.available === false ? '  (not available)' : '';
    // The label alone: the option's outcome is data for every host, and beside the label it only repeated it in other words.
    const recommended = option.recommended || item.recommended?.option === option.id;
    lines.push(`   ${numbered ? `${position + 1 + offset})` : `${option.id}:`} ${option.label}${recommended ? '  [recommended]' : ''}${yours}`);
    // What the choice does to the Story, in one line [owner, 2026-11-13].
    if (option.does) lines.push(`      ${option.does}`);
    // The option's own command, for a person who decides it in their terminal instead.
    if (option.terminal && option.available !== false && !numbered) lines.push(`      or in your own terminal: ${option.terminal}`);
  });
  return lines;
}

/** Every item SFlow settled for the person, from the list and anything it carries beside it. */
export function settledItems(packet) {
  const all = [...packet.items, ...(packet.offered ?? []), ...(packet.settled ?? [])];
  return all.filter((item, at) => item?.settled === true && all.findIndex((other) => other.id === item.id) === at);
}

/** The VS Code command that opens the decisions card, as its Command Palette shows it. */
const VSCODE_DECISIONS_CARD = VSCODE_DECIDE_CARD;

/** The list as a terminal prints it. Exported for its test. */
export function packetText(packet) {
  // The headline in plain words when the engine gives them: what is asked, counted, never what holds what.
  const headline = packet.plain?.headline ? `Decide ${packet.workId} · ${packet.phaseLabel ?? packet.phase}. ${packet.plain.headline}` : packet.headline;
  const lines = [headline, ...(packet.recorded?.length ? ['', 'Recorded plan accounting (separate from visual sign-off):',
    ...packet.recorded.map(entry => `  ${entry.id}: ${entry.summary}`)] : [])];
  // A step's next version waiting for the person's yes, asked once as both cards ask it; here, the step's own preview asks
  // them in their terminal [D3, OSA:REQ-030]. Its older list row keeps only leaving the change out.
  const opening = packet.versionOpening;
  if (opening) lines.push('', opening.question, 'Answer it in your own terminal, which asks you, or on the Decide card:',
    ...formatCommandRouteLines({ command: opening.terminal ?? null, copilotCommand: packet.record?.share ?? null, modelFreeCommand: VSCODE_DECISIONS_CARD }));
  if (!packet.items.length && !packet.offered?.length && !packet.settled?.length) return `${[...lines, ...(packet.storyNext ? ['', ...storyNextLines(packet.storyNext)] : [])].join('\n')}\n`;
  lines.push('');
  const settled = settledItems(packet);
  const later = [];
  for (const [index, item] of [...packet.items, ...(packet.offered ?? [])].entries()) {
    if (settled.includes(item)) continue;
    if (laterOf(item)) later.push(laterOf(item));
    else lines.push(...itemLines(item, index), '');
  }
  // What nobody can answer yet, one line each, never a question of its own.
  // What waits on someone or something else, one line each [owner, 2026-11-18].
  if (later.length) lines.push(...later.map((line) => `Waiting: ${line}`), '');
  // Nothing open is this person's to act on now: why, and what its approval waits for, as both cards say it [owner, 2026-11-18].
  if (packet.plain?.nothingToRecord) lines.push(packet.plain.nothingToRecord, '');
  if (settled.length) {
    lines.push('Settled for you:', '');
    for (const [index, item] of settled.entries()) lines.push(...itemLines(item, index), '');
  }
  if (packet.items.some((item) => ['conformance-gap', 'upstream-issue'].includes(item.kind))) lines.push(packet.rule);
  if ([...packet.items, ...(packet.offered ?? [])].some((item) => item.options.some((option) => option.recordable !== false))) {
    // VS Code's decisions card records the same choices with no model (paid run, 8 November: the
    // route said "not available", and the model repeated it to the person).
    lines.push('Decide them in this terminal:', ...formatCommandRouteLines({ command: packet.record.interactive, copilotCommand: packet.record.copilotCommand,
      modelFreeCommand: VSCODE_DECISIONS_CARD }));
    if (packet.record.recommended) lines.push('Or record the recommended choices:', ...formatCommandRouteLines({ command: packet.record.recommended, copilotCommand: packet.record.copilotCommand }));
    if (packet.inApproval) lines.push('Or answer them in the approval, in one commit:', ...formatCommandRouteLines(packet.inApproval));
    // Always the last line: what happens once the person answers [owner, 2026-11-18].
    if (packet.plain?.afterAnswer) lines.push(`Next: ${packet.plain.afterAnswer}`);
  // The next step's own model-free route when it has one (@sflow /approve for the approval), never "not available" beside it.
  } else if (['story-next', 'decide-card'].includes(packet.next?.kind)) lines.push(...storyNextLines(packet.next));
  else if (packet.next) lines.push('Next:', ...formatCommandRouteLines({ ...packet.next, modelFreeCommand: packet.next.modelFreeCommand ?? modelFreeCommandForCommand(packet.next.command) }));
  // Only what was settled for the person: its Undo is on the Decide card, never "not available" [owner, 2026-11-13].
  else if (settled.length) {
    lines.push('Undo one on the Decide card:', ...formatCommandRouteLines({ copilotCommand: packet.record.share, modelFreeCommand: VSCODE_DECISIONS_CARD,
      command: settled.length === 1 ? settled[0].details?.commands?.[0] ?? null : `singularity-flow decisions undo ${packet.workId} --settled <STL-ID>` }));
  } else lines.push(...formatCommandRouteLines({ copilotCommand: packet.record.share }));
  return `${lines.join('\n')}\n`;
}

/**
 * When every decision holding the approval is one this approver can answer in it, the approval
 * route that asks them in place and records them in its commit [SPEC-OAP M4]; else null.
 */
async function inApproval(packet) {
  const approval = packet.items.find((item) => item.kind === 'approval');
  if (!approval?.decidedBy?.allowed) return null;
  const answerable = (await import('../approval-decisions.mjs')).approvalDecisionItems(packet);
  const holding = packet.items.filter((item) => item.kind !== 'approval' && item.holdsApproval);
  return answerable && answerable.length === holding.length ? { items: answerable.map((item) => item.id),
    options: Object.fromEntries(answerable.map((item) => [item.id, item.options.map((option) => option.id)])),
    command: `singularity-flow approve ${packet.phase} --work-id ${packet.workId}` } : null;
}

function emitShow(packet, options, workflow, extra = {}) {
  const preview = extra.preview ?? null;
  emitCommandResult(commandResult({
    operation: { id: 'decisions.show', classification: 'read' },
    subject: { kind: 'story', id: packet.workId },
    outcome: succeeded(preview ? 'decisions.preview.succeeded' : 'decisions.show.succeeded',
      { headline: packet.headline, count: String(packet.open ?? packet.items.length), chosen: String(preview?.steps.length ?? 0) }),
    effects: noEffects(),
    next: [],
    restState: 'informational',
    data: { ...packet, ...(preview ? { preview } : {}) }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

/** Lines read on request; a line that arrives before its question waits for it. Null at the end of input. */
export function lineReader(input) {
  const reader = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
  const lines = [];
  const waiting = [];
  let ended = false;
  reader.on('line', (line) => { const resolve = waiting.shift(); if (resolve) resolve(line); else lines.push(line); });
  reader.on('close', () => { ended = true; while (waiting.length) waiting.shift()(null); });
  return {
    next: () => (lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise((resolve) => waiting.push(resolve))),
    close: () => reader.close()
  };
}

/**
 * Ask, item by item (recommended option first, Enter keeps it), for any date, cause or reason with
 * its default, then return the answers and a confirm step that shows the one-screen summary and
 * asks y/N. Items the person may not decide are shown with who decides and the line to share. Null
 * when nothing was chosen or the input ended; nothing is recorded then. `ask` reads one more answer
 * on the same input, as the approval's typed phase does [SPEC-OAP M4]; `nothingChosen` is said when
 * no item was chosen.
 */
export async function promptDecisionAnswers(packet, { input = processInput, output = processOutput,
  nothingChosen = 'Nothing chosen; nothing was recorded.' } = {}) {
  const { parseDecisionAnswers } = await import('../decision-list.mjs');
  const reader = lineReader(input);
  const say = (line) => output.write(`${line}\n`);
  const ask = async (question) => {
    output.write(question);
    const line = await reader.next();
    if (line === null) throw Object.assign(new Error('input ended'), { ended: true });
    return line.trim();
  };
  const values = { choose: {}, reason: {}, expires: {}, cause: {}, clause: {}, article: {} };
  const together = new Set();
  const later = [];
  try {
    say(packet.plain?.headline ? `Decide ${packet.workId} · ${packet.phaseLabel ?? packet.phase}. ${packet.plain.headline}` : packet.headline);
    // Departures one answer may accept, files and wording that names no clause [CQF:REQ-024]: asked once.
    // The rest, and each of these when the person says no, are asked one by one below.
    const accepting = packet.items.filter((item) => item.kind === 'departure' && item.details?.acceptAll === true && item.decidedBy.allowed
      && item.options.some((option) => option.id === 'accept' && !option.oneByOne && option.recordable !== false && option.available !== false && option.decidedBy.allowed));
    if (accepting.length > 1) {
      say('');
      say(`Accept all ${accepting.length} departures (${accepting.map((item) => item.details.departure).join(', ')}) with one reason?`);
      if (/^(?:y|yes)$/iu.test(await ask('   [y/N]: '))) {
        const reason = await ask('   One reason for all of them: ');
        for (const item of accepting) {
          together.add(item.id);
          values.choose[item.id] = 'accept';
          if (reason) values.reason[item.id] = reason;
        }
      }
    }
    for (const [index, item] of [...packet.items, ...(packet.offered ?? [])].entries()) {
      if (together.has(item.id)) continue;
      // Nobody can answer it yet: one line at the end, never a question.
      if (laterOf(item)) { later.push(laterOf(item)); continue; }
      say('');
      for (const line of itemLines(item, index, { numbered: true })) say(line);
      if (!item.decidedBy.allowed) continue;
      // A visual sign-off's screenshot is the person's own step, and they are here: asked, then taken and signed off
      // by the caller (decisions-screenshot.mjs) [owner, 2026-11-18]. Never a check: it waits for them at a browser.
      const shot = checkOf(item)?.kind === 'screenshot' ? checkOf(item) : null;
      const signable = item.details?.capture?.status === 'taken'
        && item.options.some((option) => option.action?.humanReview && option.available !== false && option.decidedBy?.allowed);
      if (shot || signable) {
        const yes = /^(?:y|yes)$/iu.test(await ask(shot ? '   Take the screenshot now? It opens your app in a browser [y/N]: '
          : '   Look at the screenshot and sign it off now? [y/N]: '));
        if (yes) {
          reader.close();
          return { screenshot: { item: item.id, subject: item.subject ?? null, take: Boolean(shot) } };
        }
        if (shot) say(`   Take it later yourself: ${shot.command}`);
        continue;
      }
      // Only the person's own steps: nothing to choose here, so each command is shown, not asked.
      if (item.options.every((option) => option.recordable === false)) {
        for (const option of item.options.filter((entry) => entry.action?.command)) say(`   Run it yourself: ${option.action.command}`);
        continue;
      }
      // The check SFlow runs itself comes first [owner, 2026-11-16]: chosen, it runs and the list is asked again.
      const check = checkOf(item) ? 1 : 0;
      const skip = item.options.length + check + 1;
      say(`   ${skip}) Not now`);
      const preferred = check && item.recommended?.check ? 1 : (item.options.findIndex((entry) => entry.recommended && entry.decidedBy.allowed) + 1 + check) || skip;
      let chosen = null;
      while (chosen === null) {
        const pick = await ask(`   Choose 1-${skip} [${preferred > item.options.length + check ? skip : preferred}]: `);
        const number = pick === '' ? (preferred > item.options.length + check ? skip : preferred) : Number(pick);
        if (Number.isInteger(number) && number >= 1 && number <= skip) chosen = number;
        else say(`   Type a number from 1 to ${skip}.`);
      }
      if (chosen === skip) continue;
      if (check && chosen === 1) {
        reader.close();
        return { check: item.id };
      }
      const option = item.options[chosen - 1 - check];
      if (option.recordable === false) {
        say(`   ${option.words}${option.action?.command ? ` Run it yourself: ${option.action.command}` : ''}`);
        continue;
      }
      if (!option.decidedBy.allowed) {
        say(`   ${option.decidedBy.words} Share this with them: ${option.decidedBy.share}`);
        continue;
      }
      values.choose[item.id] = option.id;
      if (option.needs.expires) {
        const value = await ask(`   Until (YYYY-MM-DD, at most ${option.needs.expires.latest}) [${option.needs.expires.default}]: `);
        if (value) values.expires[item.id] = value;
      }
      if (option.needs.cause) {
        const value = await ask(`   What stops the tests [${option.needs.cause.default}]: `);
        if (value) values.cause[item.id] = value;
      }
      if (option.needs.clause) {
        const known = option.needs.clause.known ?? [];
        values.clause[item.id] = await ask(`   ${option.needs.clause.words ?? 'The clauses that carry it'}, separated by commas${known.length ? ` (${known.slice(0, 8).join(', ')})` : ''}: `);
      }
      if (option.needs.article) {
        const { articles, decisions } = option.needs.article;
        values.article[item.id] = [];
        for (const { id, title, question } of articles) {
          say(`   ${title}: ${question}`);
          let decision = null;
          while (!decision) {
            const pick = Number(await ask(`   ${decisions.map((entry, at) => `${at + 1}) ${entry}`).join('  ')}: `));
            decision = decisions[pick - 1] ?? null;
            if (!decision) say(`   Type a number from 1 to ${decisions.length}.`);
          }
          values.article[item.id].push({ article: id, decision, ...(decision === 'satisfied' ? {} : { reason: await ask('   Why: ') }) });
        }
      }
      if (option.needs.reason) {
        // With no suggested wording, only the person's own reason answers it.
        const value = await ask(`   Reason${option.needs.reason.default ? ` [${option.needs.reason.default}]` : ''}: `);
        if (value) values.reason[item.id] = value;
      }
    }
  } catch (error) {
    reader.close();
    if (error.ended) { say('\nInput ended; nothing was recorded.'); return null; }
    throw error;
  }
  for (const line of later) say(`\nWaiting: ${line}`);
  if (!Object.keys(values.choose).length) {
    reader.close();
    say(`\n${nothingChosen}`);
    return null;
  }
  return {
    answers: parseDecisionAnswers(values),
    confirm: async (summary) => {
      say('\nSummary');
      for (const line of summary) say(`  ${line}`);
      try { return /^(?:y|yes)$/iu.test(await ask('Record these decisions? [y/N]: ')); }
      catch (error) { if (error.ended) return false; throw error; }
    },
    ask: async (question) => {
      try { return await ask(question); }
      catch (error) { if (error.ended) return null; throw error; }
    },
    close: () => reader.close()
  };
}

/** Only the y/N over the summary, for choices given on the command line in a person's own terminal. */
function confirmDecisionAnswers({ input = processInput, output = processOutput } = {}) {
  const reader = lineReader(input);
  return {
    confirm: async (summary) => {
      output.write('Summary\n');
      for (const line of summary) output.write(`  ${line}\n`);
      output.write('Record these decisions? [y/N]: ');
      return /^(?:y|yes)$/iu.test(String(await reader.next() ?? '').trim());
    },
    close: () => reader.close()
  };
}

const phaseWords = (workflow, id) => workflow.phases?.[id]?.label ?? id;

/** What one decision on an intent amendment did, in words a person reads: never a digest or a commit. Exported for its test. */
export function intentAmendmentOutcome(workflow, transition) {
  const { proposal } = transition;
  if (!transition.reached) {
    const { reached = 0, required = 1, planSignOffsMissing = [] } = proposal.approvals ?? {};
    return { id: proposal.id, decision: 'approved', reached: false, approvals: proposal.approvals ?? null,
      words: `Your approval of ${proposal.id} is recorded: ${reached} of ${required} approvals${planSignOffsMissing.length
        ? `, and an approver of ${planSignOffsMissing.map((id) => phaseWords(workflow, id)).join(', ')} still signs the plan rows it carries by deciding it` : ''}. It waits for the rest before it changes anything` };
  }
  if (!transition.applied) return { id: proposal.id, decision: 'rejected', words: `${proposal.id} is rejected: the approved clauses stay as they are, and every submission stays valid` };
  const application = proposal.application ?? {};
  // Approved as editorial [CIC:REQ-014]: nothing was reset or asked, so there is nothing to acknowledge.
  if (application.carried === 'editorial') {
    return { id: proposal.id, decision: 'approved', applied: true, generation: application.toSpecificationGeneration ?? null, carried: 'editorial',
      words: `${proposal.id} is approved as editorial: the amended wording is in force, no step runs again or is asked, and the evidence of the reworded clauses is carried` };
  }
  return { id: proposal.id, decision: 'approved', applied: true, generation: application.toSpecificationGeneration ?? null,
    words: `${proposal.id} is approved: the amended scope is in force${application.revalidate?.length
      ? `, nothing was reset, and ${application.revalidate.map((entry) => phaseWords(workflow, entry.phase)).join(', ')} ${application.revalidate.length === 1 ? 'has a row' : 'each have a row'} on this list for its approvers`
      : '. Acknowledge it next, on this list or in a terminal'}${application.stillHolds?.length
      ? `; ${application.stillHolds.map((entry) => phaseWords(workflow, entry.phase)).join(', ')} ${application.stillHolds.length === 1 ? 'keeps its' : 'keep their'} approval, and ${application.stillHolds.length === 1 ? 'its approvers say' : 'their approvers each say'} on this list whether it still holds`
      : ''}` };
}

/**
 * A decision on an intent amendment from the list [owner, 2026-11-13]: only for the proposal the list showed. The
 * list's digest binds it already; a proposal decided or replaced since is named here too, before anything is written.
 */
function sameProposal(workflow, effect) {
  const summary = (workflow.intentAmendments ?? []).find((entry) => entry.id === effect.amendment);
  if (summary?.status === 'proposed' && summary.proposalSha256 === effect.proposalSha256) return;
  refused(`${effect.amendment} is not the pending proposal this list showed any more, so nothing was recorded. Review the current list and choose again.`,
    'DECISIONS_PACKET_CHANGED', { amendment: effect.amendment, nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, skill: '/sf-decide', label: 'Review the current decision list.' } });
}

/** Write one effect with the function its own command uses; returns the record it wrote. */
async function applyEffect(root, config, workflow, effect, step, produced, { actor, agent, channel = 'terminal' }) {
  if (effect.kind === 'settled-undo') {
    // The card's Undo: the same function as `decisions undo`, said to come from the card [owner, 2026-11-13].
    const { undoSettledDecision } = await import('../settled-decisions.mjs');
    const { undo, reraised } = await undoSettledDecision(root, config, workflow, effect.settled, { actor, agent, reason: step.values.reason || null, channel });
    return { id: undo.id, undoes: undo.undoes, reraised, words: `${undo.undoes} is undone: ${reraised.words}` };
  }
  if (effect.kind === 'intent-amendment-decision' || effect.kind === 'intent-amendment-refresh') {
    // The same functions as `story intent-amendment decide`, with every check they make, said to come from the card.
    sameProposal(workflow, effect);
    const story = await import('./story.mjs');
    if (effect.kind === 'intent-amendment-refresh') {
      const refreshed = await story.refreshIntentAmendment(root, config, workflow, effect.amendment, { channel });
      return { id: effect.amendment, refreshedAs: refreshed.proposed,
        words: `${effect.amendment} is rejected and proposed again as ${refreshed.proposed}, against the step as it is now; the scope's approvers decide ${refreshed.proposed}` };
    }
    const { transition } = await story.recordIntentAmendmentDecision(root, config, workflow, effect.amendment,
      { decision: effect.decision, reason: step.values.reason || null, channel, ...(effect.raise ? { raise: effect.raise } : {}) });
    return intentAmendmentOutcome(workflow, transition);
  }
  if (effect.kind === 'intent-amendment-acknowledge') {
    const { acknowledgeApprovedIntentAmendment } = await import('./story.mjs');
    const { acknowledgement } = await acknowledgeApprovedIntentAmendment(root, config, workflow, effect.amendment, { channel });
    return { id: acknowledgement.id, acknowledged: true, words: `${acknowledgement.id} is acknowledged; the steps it reopened can be revalidated` };
  }
  if (effect.kind === 'intent-amendment-draft') {
    // The draft command's own function, at the Story's own draft path: never one carried in the list.
    const { draftIntentAmendment } = await import('./story.mjs');
    return draftIntentAmendment(root, config, workflow, {}, { rows: effect.rows ?? [], reason: step.values.reason, keepEdits: true });
  }
  if (effect.kind === 'amendment-revalidation') {
    const { commitAmendmentRevalidation } = await import('./upstream-issue.mjs');
    return commitAmendmentRevalidation(root, config, workflow, { amendmentId: effect.amendment, phaseId: effect.phase, outcome: effect.outcome,
      reason: step.values.reason }, { actor, agent });
  }
  if (effect.kind === 'upstream-issue') {
    const { commitUpstreamIssue } = await import('./upstream-issue.mjs');
    return commitUpstreamIssue(root, config, workflow, { phase: effect.phase, about: effect.about, problem: effect.problem,
      assumption: null, impact: null, proposed: 'unknown', source: null, supersedes: null }, { actor, agent });
  }
  if (effect.kind === 'evidence-reuse') {
    const { recordEvidenceReuseDecision } = await import('./decision-evidence-reuse.mjs');
    return (await recordEvidenceReuseDecision(root, config, workflow, { phaseId: effect.phase, attemptId: effect.attemptId,
      reason: step.values.reason }, { actor, agent })).record;
  }
  if (effect.kind === 'plan-amendment') {
    const { commitPlanAmendment } = await import('./decision-plan-amendment.mjs');
    const changes = (effect.changes ?? [effect.change]).map((change) => (change.kind === 'add-supporting' ? { ...change, reason: step.values.reason } : change));
    return (await commitPlanAmendment(root, config, workflow, { changes, reason: step.values.reason }, { actor, agent })).amendment;
  }
  if (effect.kind === 'departure') {
    const { commitDepartureDecision } = await import('../departure-records.mjs');
    return (await commitDepartureDecision(root, config, workflow, { departures: effect.departures ?? [effect.departure], decision: effect.decision,
      reason: step.values.reason, changes: effect.changes ?? null }, { actor, agent })).record;
  }
  if (effect.kind === 'node-pin') {
    const { commitNodePin } = await import('./decision-plan-amendment.mjs');
    return commitNodePin(root, config, workflow, { version: effect.version, replaces: effect.replaces ?? null, reason: step.values.reason }, { actor, agent });
  }
  if (effect.kind === 'obligation-risk') {
    const { commitRiskDecision } = await import('./decision-obligation-risk.mjs');
    return (await commitRiskDecision(root, config, workflow, { obligationId: effect.obligation, category: effect.category,
      expires: step.values.expires, reason: step.values.reason }, { actor, agent })).record;
  }
  if (effect.kind === 'visual-profile') {
    const { recordVisualProfileDecisionFor } = await import('./decision-visual-profile.mjs');
    return (await recordVisualProfileDecisionFor(root, config, workflow, { phaseId: effect.phase, profileId: effect.profileId,
      reason: step.values.reason }, { actor, agent })).record;
  }
  if (['scope-disposition', 'completeness-review', 'applicability', 'routing'].includes(effect.kind)) {
    const records = await import('./decision-story-records.mjs');
    if (effect.kind === 'scope-disposition') return (await records.commitScopeDecision(root, config, workflow, { item: effect.item, disposition: effect.disposition,
      clauseIds: step.values.clause ?? [], reason: step.values.reason }, { actor, agent })).decision;
    if (effect.kind === 'completeness-review') return (await records.commitCompletenessReview(root, config, workflow, { confirm: effect.inventorySha256,
      checklist: step.values.article, reason: step.values.reason }, { actor, agent })).review;
    if (effect.kind === 'applicability') return (await records.commitApplicabilityDecision(root, config, workflow, { responsibility: effect.responsibility,
      reason: step.values.reason }, { actor, agent })).decision;
    return (await records.commitRoutingChoice(root, config, workflow, { option: effect.option ?? null, to: effect.to ?? null, reason: step.values.reason, expected: effect.key },
      { actor, agent })).result.outcome;
  }
  if (effect.kind === 'convergence-adjudication') {
    // The one write of an adjudication, as `story adjudicate --answers FILE --expect DIGEST` makes it [SCS:REQ-030].
    const [{ recordConvergenceAnswers }, { adjudicationAnswersOf }] = await Promise.all([import('./story.mjs'), import('../decision-list.mjs')]);
    return recordConvergenceAnswers(root, config, { workId: workflow.workItem.id, answers: effect.answers ?? adjudicationAnswersOf(step), expect: effect.expect });
  }
  if (effect.kind === 'test-command') {
    const { recordStoryTestCommand } = await import('./decision-test-command.mjs');
    return (await recordStoryTestCommand(root, config, workflow, { accept: effect.request, reason: step.values.reason ?? '' }, { actor, agent })).record;
  }
  if (effect.kind === 'test-narrowing') {
    const { recordTestNarrowingDecision } = await import('./decision-test-narrowing.mjs');
    return (await recordTestNarrowingDecision(root, config, workflow, { phaseId: effect.phase, commandId: effect.commandId,
      reason: step.values.reason }, { actor, agent })).record;
  }
  if (effect.kind === 'test-run-risk') {
    const { recordTestRunRiskDecision } = await import('./decision-test-risk.mjs');
    return (await recordTestRunRiskDecision(root, config, workflow, { phaseId: effect.phase, commandId: effect.commandId,
      cause: step.values.cause, reason: step.values.reason, expires: step.values.expires }, { actor, agent })).record;
  }
  const { decideUpstreamIssueRecord } = await import('./upstream-issue.mjs');
  const issueId = effect.issue ?? produced.issue;
  const { value } = await decideUpstreamIssueRecord(root, config, workflow, issueId, { outcome: effect.outcome, reason: step.values.reason,
    expires: effect.outcome === 'accept-risk' ? step.values.expires : null }, { actor, agent });
  const { changeRequest, ...decision } = value;
  return { ...decision, ...(changeRequest ? { changeRequestId: changeRequest.id } : {}) };
}

function recordId(kind, record) {
  if (kind === 'settled-undo') return `${record?.undoes} undone`;
  if (kind === 'intent-amendment-decision') return `${record?.id} ${record?.reached === false ? 'approval recorded' : record?.decision}`;
  if (kind === 'intent-amendment-refresh') return `${record?.id} refreshed as ${record?.refreshedAs}`;
  if (kind === 'intent-amendment-acknowledge') return `${record?.id} acknowledged`;
  if (kind === 'amendment-revalidation') return `${record?.phase} ${record?.outcome} after ${record?.amendment}${record?.link ? ` (${record.link})` : ''}`;
  if (kind === 'upstream-issue-decision') return `${record?.issue} ${record?.outcome}`;
  if (kind === 'scope-disposition') return `${record?.item} ${record?.disposition}`;
  if (kind === 'completeness-review') return 'completeness review';
  if (kind === 'applicability') return `${record?.responsibility} does not apply`;
  if (kind === 'routing') return `route ${record?.route}`;
  if (kind === 'convergence-adjudication') return (record?.recorded ?? []).join(', ') || 'unchanged';
  return record?.id ?? record?.accepts ?? record?.revokes ?? null;
}

function changedList(packet, confirm, phaseId) {
  const nextAction = { command: `singularity-flow decisions ${packet.workId}${phaseId ? ` --phase ${phaseId}` : ''}`, skill: '/sf-decide', label: 'Review the current decision list.' };
  // A digest copied with a slip is not a changed list: say so, with the exact digest (a person's
  // confirmation stays theirs; nothing is recorded on a near miss) [copied values].
  assertConfirmation(confirm, packet.packetSha256, { code: 'DECISIONS_PACKET_CHANGED', fail: refused,
    message: 'The decision list changed since it was reviewed. Nothing was recorded. Review the current list and choose again.',
    details: { packet, packetSha256: packet.packetSha256, nextAction } });
}

/**
 * The step's next version a preview proposed on this clone, on the Story as it is, waiting for the person's yes: what the
 * decisions card asks [D3, OSA:REQ-030, Stage 4]. Null when there is none, the kernel no longer asks it, or a yes is given.
 */
async function versionOpeningOf(root, workflow) {
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!phase || workflow.status !== 'in_progress') return null;
  // An approved amendment is acknowledged first: its item asks, and the version question comes on the next read (owner, 2026-11-17).
  if ((await import('../source-review-policy.mjs')).pendingIntentAmendmentAcknowledgement(workflow)) return null;
  const [{ gitDirectories }, consent, { head }, { askingRoute, kernelRoute }] = await Promise.all([import('../story-version-acceptance.mjs'),
    import('../story-version-consent.mjs'), import('../git.mjs'), import('./phase-opening.mjs')]);
  const directories = gitDirectories(root);
  if (!directories) return null;
  const record = await consent.pendingProposalRecord(directories.commonDir, { workId: workflow.workItem.id, phase: phase.id, lifecycleRevision: head(root) });
  if (!record || record.proposal.consent !== 'required' || await consent.readGrant(directories.commonDir, record.digest)) return null;
  // Any successor its preview proposed (a return, a review's corrections, a change the person asked for): still the next
  // number, with nothing open; the opening operation checks the proposal again when it runs.
  const { decision } = await kernelRoute(root, workflow, phase);
  if (phase.status !== 'in_progress' || decision.version.writing !== null || Number(decision.version.proposedNext) !== Number(record.proposal.version)) return null;
  // In a terminal, the step's own preview asks it (`terminal`): what the decisions text shows [D3]. A version proposed for words
  // the person typed has a third answer, "No, it was just a question" (`justAQuestion`, owner 2026-11-18).
  return { workId: workflow.workItem.id, phase: phase.id, version: record.proposal.version, question: record.question, confirmation: record.confirmation, digest: record.digest,
    ...(record.proposal.reason === 'requested-change' && workflow.resolution?.capability?.policy?.typedFocus !== 'off' ? { justAQuestion: true } : {}), terminal: (await askingRoute(phase.id))?.command ?? null };
}

/**
 * A yes for Story `workId` is kept only in a checkout of that Story. One that holds another Story keeps nothing and is never
 * switched to `workId` (the record's own branch checkout would switch it, under a person who moved on): the refusal names
 * the Story's own checkout, as the machine's Story index knows it, and the route that opens it [stage5b.md section 5].
 */
async function versionConsentCheckout(root, workId) {
  const index = await import('../story-index.mjs');
  const facts = await index.checkoutGitFacts(root).catch(() => null);
  const current = facts ? await index.storyInCheckout(root, { facts }).catch(() => null) : null;
  if (!current || current.workId === workId || (current.aliases ?? []).includes(workId)) return;
  const found = await index.lookupStoryCheckouts(workId).catch(() => ({ valid: [] }));
  const own = found.valid.filter(index.isLifecycle)[0]?.checkoutPath ?? null;
  const open = `singularity-flow session open ${workId}`;
  refused(`This checkout holds Story ${current.workId}, so the yes for ${workId} was not kept here and the checkout was not switched. `
    + `Answer it in ${workId}'s own checkout${own ? `, ${own}` : ''}: open it with ${open}, then ask again.`, 'VERSION_CONSENT_WRONG_TARGET',
  { workId, actualWorkId: current.workId, storyCheckout: { workId, checkoutPath: own }, nextAction: { command: open, skill: '/sf-session' } });
}

/**
 * `decisions record [WORK-ID] --version-consent <confirmation> --expect <digest>`: the person's yes on the decisions card to
 * the exact proposal it showed. It keeps the same sealed grant the question tool's answer and a typed /sf-confirm code keep,
 * so the step's own confirmation turns it into the same `VersionOpeningConsent/v1` receipt (surface `decisions-card`). A
 * changed proposal, another step or a moved Story opens nothing. Like every `decisions record`, a chat turn never runs it.
 */
async function recordVersionConsent(root, options, workId) {
  if (workId) await versionConsentCheckout(root, workId);
  const { config, workflow } = await storyContext(root, workId, { record: true, fetch: false });
  const confirmation = optionString(options, 'version-consent');
  const expect = optionString(options, 'expect');
  if (!expect) refused('--version-consent needs --expect with the proposal digest the card showed.', 'DECISIONS_OPTIONS_INVALID');
  const [{ gitDirectories }, consent, { head }, { kernelRoute }] = await Promise.all([import('../story-version-acceptance.mjs'),
    import('../story-version-consent.mjs'), import('../git.mjs'), import('./phase-opening.mjs')]);
  const directories = gitDirectories(root);
  const record = directories ? await consent.readProposalRecord(directories.commonDir, confirmation) : null;
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!record || record.proposal.workId !== workflow.workItem.id || record.proposal.phase !== phase?.id || record.digest !== expect) {
    refused('This yes is for another proposal than the one waiting now; nothing was recorded. Read the decisions card again.', 'VERSION_CONSENT_WRONG_TARGET',
      { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, skill: '/sf-decide' } });
  }
  if (record.proposal.lifecycleRevision !== head(root)) {
    refused(`The Story moved since version ${record.proposal.version} of ${phase.id} was proposed; nothing was recorded. Its work command proposes it again.`,
      'VERSION_OPENING_STALE', { nextAction: (await kernelRoute(root, workflow, phase, { config })).route });
  }
  const grant = await consent.grantConsent(directories.commonDir, { record, surface: 'decisions-card', question: record.question, answer: 'yes', host: 'decisions-card' });
  if (!grant) refused('This clone has no key to keep the yes with; nothing was recorded.', 'VERSION_CONSENT_UNVERIFIED');
  // What opens it: the kernel's next for the step, read with its task fact and review as every view reads them, which is
  // the step's own preview through its work command; that preview's confirmation lets this kept yes through, asking
  // nothing again. Read without them, it named /sf-submit, which submitted the old version (review, 2026-11-17).
  const { decision, route } = await kernelRoute(root, workflow, phase, { config });
  const opens = ['open-version', 'build-version'].includes(decision.next.operation) && decision.next.inputs.consent === 'required' && route?.command;
  const chat = route?.copilotCommand ?? route?.skill ?? null;
  const then = decision.next.operation === 'build-version' ? 'builds it'
    : { 'change-requested': 'makes the change', 'review-corrections': 'fixes what the review found' }[decision.next.inputs.reason] ?? 'writes it';
  // The step by the name the card showed it under, never its ID beside that name.
  const kept = `Your yes to start version ${record.proposal.version} of ${phase.label ?? phase.id} is kept for 30 minutes.`;
  const words = opens && chat ? `${kept} Next, ${chat} starts it with this yes, without asking you again, and ${then}.` : `${kept}${route?.label ? ` ${route.label}` : ''}`;
  const next = route?.command ? { command: route.command, copilotCommand: route.copilotCommand ?? null, skill: route.skill ?? route.copilotCommand?.split(' ')[0] ?? null } : null;
  emitCommandResult(commandResult({
    operation: { id: 'decisions.version-consent', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('decisions.version-consent.recorded', { phase: phase.id, version: String(record.proposal.version) }),
    effects: effects({ stateChanged: false, filesChanged: false }),
    next: next ? [action({ id: 'version-opening.confirm', label: words, command: next.command, skill: next.skill, rank: 'NOW', kind: 'workflow' })] : [],
    data: { consent: { surface: 'decisions-card', phase: phase.id, version: record.proposal.version, proposalDigest: record.digest, expiresAt: grant.expiresAt }, words,
      ...(next ? { next } : {}) }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

/**
 * `decisions record [WORK-ID] --just-a-question <confirmation> --expect <digest>`: the person's "No, it was just a question"
 * on the decisions card to the exact version question it showed (owner, 2026-11-18). What they typed is kept, accounted for
 * as a question with nothing to change; no version opens and nothing else is asked. Like every `decisions record`, a chat
 * turn never runs it (person-step-catalog.mjs `decision-list-record`): the card's extension runs it outside the chat.
 */
async function recordJustAQuestion(root, options, workId) {
  if (workId) await versionConsentCheckout(root, workId);
  const { config, workflow } = await storyContext(root, workId, { record: true, fetch: false });
  const confirmation = optionString(options, 'just-a-question');
  const expect = optionString(options, 'expect');
  if (!expect) refused('--just-a-question needs --expect with the proposal digest the card showed.', 'DECISIONS_OPTIONS_INVALID');
  const [{ gitDirectories }, consent, { head, actionActor }, { kernelRoute }, { answerJustAQuestion }] = await Promise.all([import('../story-version-acceptance.mjs'),
    import('../story-version-consent.mjs'), import('../git.mjs'), import('./phase-opening.mjs'), import('../requested-successor.mjs')]);
  const directories = gitDirectories(root);
  const record = directories ? await consent.readProposalRecord(directories.commonDir, confirmation) : null;
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!record || record.proposal.workId !== workflow.workItem.id || record.proposal.phase !== phase?.id || record.digest !== expect) {
    refused('This answer is for another question than the one waiting now; nothing was recorded. Read the decisions card again.', 'VERSION_CONSENT_WRONG_TARGET',
      { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, skill: '/sf-decide' } });
  }
  if (record.proposal.lifecycleRevision !== head(root)) {
    refused(`The Story moved since version ${record.proposal.version} of ${phase.id} was proposed; nothing was recorded. Its work command asks again.`,
      'VERSION_OPENING_STALE', { nextAction: (await kernelRoute(root, workflow, phase, { config })).route });
  }
  const answer = await answerJustAQuestion(root, config, workflow, phase, { proposal: record.proposal, surface: 'decisions-card', actor: actionActor(root) });
  emitCommandResult(commandResult({
    operation: { id: 'decisions.just-a-question', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('decisions.just-a-question.recorded', { phase: phase.id, version: String(record.proposal.version) }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    next: answer.next ? [action({ id: 'version-question.declined', label: answer.words, command: answer.next.command, skill: answer.next.skill, rank: 'NOW', kind: 'workflow' })] : [],
    data: { answer: 'just-a-question', phase: phase.id, version: record.proposal.version, opened: null, instructions: answer.answered.instructions, words: answer.words,
      ...(answer.next ? { next: answer.next } : {}) }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

async function record(root, options, workId, io) {
  if (optionString(options, 'version-consent')) return recordVersionConsent(root, options, workId);
  if (optionString(options, 'just-a-question')) return recordJustAQuestion(root, options, workId);
  let { config, workflow } = await storyContext(root, workId, { record: true, fetch: optionBoolean(options, 'fetch') });
  if (workflow.status !== 'in_progress') {
    refused(`Story ${workflow.workItem.id} is ${workflow.status}; decisions are recorded while it is in progress.`, 'DECISIONS_STORY_CLOSED');
  }
  const phaseId = optionString(options, 'phase') ?? null;
  const at = nowIso();
  let packet = await readDecisionPacket(root, config, workflow, { phaseId, at });
  let answers = await answersFrom(options);
  let confirm = answers.confirm ?? optionString(options, 'confirm') ?? null;
  const terminal = !confirm && !optionBoolean(options, 'json') && io.input.isTTY === true && io.output.isTTY === true;
  const interactive = terminal && !answered(answers);
  // A person asked in their own terminal sees what SFlow's checks found first, as on the card [owner, 2026-11-16].
  if (interactive && probing(options, { json: false })) {
    packet = await checkedPacket(root, config, workflow, packet, { seconds: optionString(options, 'probe-wait', null), phaseId, say: (line) => io.output.write(`${line}\n`) });
  }
  const { decisionRecordPlan, runDecisionPlan, effectWords, ISSUE_ONLY_OPTIONS: chatOptions } = await import('../decision-list.mjs');
  let prompt = null;
  // Choices named on the command line, in a person's own terminal: the summary and a y/N, bound to the
  // list this process read, as the interactive form is, so a person never copies a digest [no hashes shown].
  // Choices a /sf-decide turn records keep the digest that turn passes on (the guard holds it to the person's yes).
  if (terminal && answered(answers) && ![...answers.choose.values()].every((option) => chatOptions.includes(option))) {
    prompt = confirmDecisionAnswers(io);
  }
  if (interactive) {
    if (!packet.items.length && !packet.offered?.length) {
      console.log(packet.headline);
      return;
    }
    prompt = await promptDecisionAnswers(packet, io);
    // A visual sign-off's screenshot, taken here with the person at the browser, then signed off; the list is asked again.
    // Only this person's terminal reaches it (input and output are a TTY); a chat turn is refused `decisions record`.
    for (let round = 0; prompt?.screenshot && round < 5; round += 1) {
      const { screenshotWalkthrough } = await import('./decisions-screenshot.mjs');
      const id = workflow.workItem.id;
      const reread = async () => {
        ({ config, workflow } = await storyContext(root, id, { record: true, fetch: false }));
        return readDecisionPacket(root, config, workflow, { phaseId, at: nowIso() });
      };
      await screenshotWalkthrough(root, { workId: id, packet, request: prompt.screenshot, reread, io });
      packet = await reread();
      prompt = await promptDecisionAnswers(packet, io);
    }
    // "Check first": SFlow runs the check, with the time the person asked for, and asks the list again once.
    if (prompt?.check) {
      const { LONGEST_SECONDS } = await import('../decision-probes.mjs');
      packet = await checkedPacket(root, config, workflow, packet, { seconds: LONGEST_SECONDS, phaseId, say: (line) => io.output.write(`${line}\n`) });
      prompt = await promptDecisionAnswers(packet, io);
      if (prompt?.check) {
        io.output.write('The check did not finish in time; nothing was recorded.\n');
        return;
      }
    }
    if (!prompt) return;
    answers = prompt.answers;
  }
  try {
    if (!answered(answers)) {
      refused(`Choose at least one item with --choose ITEM=OPTION. ${packet.headline}`, 'DECISIONS_CHOICE_REQUIRED',
        { packet, record: packet.record });
    }
    // Before the answers are read against this list: an item's number means something else on a changed one.
    if (confirm && confirm !== packet.packetSha256 && (DIGEST.test(confirm) || copySlip(confirm, packet.packetSha256) === 'slip')) changedList(packet, confirm, phaseId);
    const plan = decisionRecordPlan(packet, answers, { at });
    const preview = await previewOf(workflow, packet, plan);
    if (prompt) {
      if (!plan.steps.length || !await prompt.confirm(preview.summary)) {
        console.log('Nothing was recorded.');
        return;
      }
      confirm = packet.packetSha256;
    }
    if (!confirm) {
      refused(preview.record?.recordInChat
        ? `Recording needs the confirmation of the list it was chosen from. Review the summary, then run: ${preview.record.command}`
        : `These decisions are recorded in a person's own terminal, which shows the summary and asks them to confirm: ${preview.record?.command ?? packet.record.form}`,
        'DECISIONS_CONFIRMATION_REQUIRED', { summary: preview.summary, record: preview.record, packetSha256: packet.packetSha256,
          nextAction: { command: `singularity-flow decisions ${packet.workId}`, skill: '/sf-decide', label: 'Review the decision list and the summary of your choices.' } });
    }
    if (!DIGEST.test(confirm)) refused('--confirm takes the list\'s digest from its preview (`--json`, packetSha256). In your own terminal, leave --confirm out: it shows the summary and asks you to confirm.', 'DECISIONS_OPTIONS_INVALID', { packetSha256: packet.packetSha256 });
    if (!plan.steps.length) {
      const only = plan.refused.map((entry) => `${entry.item} (${entry.title}): ${entry.words} Share this with them: ${entry.share}`).join(' ');
      refused(`Nothing was recorded: you may not decide what you chose. ${only}`, 'DECISIONS_NOT_YOURS', { refused: plan.refused });
    }
    const { actionActor } = await import('./kernel.mjs');
    const { loadSession } = await import('../session.mjs');
    const actor = actionActor(root);
    const session = await loadSession(root, { required: false });
    const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
    // An answers file is what VS Code's and Copilot CLI's decisions cards write; the terminal asks or takes flags.
    const channel = optionString(options, 'answers') ? 'decisions-card' : 'terminal';
    const outcome = await runDecisionPlan(plan, (effect, step, produced) => applyEffect(root, config, workflow, effect, step, produced, { actor, agent, channel }));
    // The person's answer on the card restarts the window of the Copilot turn that opened it [owner, 2026-11-16].
    if (channel === 'decisions-card') await import('../copilot-mutation-guard.mjs').then((guard) => guard.renewTurnAfterCardAnswer(root, workflow.workItem.id)).catch(() => {});
    const isDraft = (entry) => entry.kind === 'intent-amendment-draft';
    // The same convergence answer again records nothing [SCS:REQ-034]: said so, never counted as recorded.
    const stepOf = (item) => plan.steps.find((step) => step.item === item);
    const same = (entry) => entry.kind === 'convergence-adjudication' && !(stepOf(entry.item)?.effects[0]?.items ?? []).some((id) => (entry.record?.recorded ?? []).includes(id));
    const unchanged = outcome.recorded.filter(same).map((entry) => ({ item: entry.item, words: `${stepOf(entry.item).label}: that answer, with that reason, is already recorded` }));
    const recorded = outcome.recorded.filter((entry) => !isDraft(entry) && !same(entry)).map((entry) => ({ item: entry.item, kind: entry.kind, record: recordId(entry.kind, entry.record), value: entry.record }));
    // What was drafted, where, and what is next: a file, not a record [SCS:REQ-020, REQ-021].
    const drafted = outcome.recorded.filter(isDraft).map((entry) => ({ item: entry.item, path: entry.record.path, clauses: entry.record.clauses ?? [],
      slots: (entry.record.slots ?? []).length, next: { command: entry.record.next.command, copilotCommand: '/sf-amend propose',
        words: 'Write the wording in place of each sflow-draft slot and delete the closing line, or ask the Story\'s agent '
          + '(/sf-amend propose); then propose it. The scope approvers decide it.' } }));
    const remaining = outcome.remaining.map((entry) => ({ item: entry.item, kind: entry.kind, words: effectWords(workflow, entry.effect,
      plan.steps.find((step) => step.item === entry.item)?.values ?? {}) }));
    if (outcome.failed) {
      const error = outcome.failed.error;
      const list = `singularity-flow decisions ${workflow.workItem.id}`;
      throw new SingularityFlowError(
        `${recorded.length ? `Recorded ${recorded.map((entry) => `${entry.item}: ${entry.record}`).join(', ')}; then ` : ''}`
          + `${outcome.failed.item} stopped: ${error.message} Not recorded: ${remaining.map((entry) => `${entry.item}: ${entry.words}`).join('; ')}. `
          + `List what remains with: ${list}`,
        { code: recorded.length ? 'DECISIONS_PARTLY_RECORDED' : error.code ?? 'DECISIONS_RECORD_FAILED',
          details: { recorded, remaining, failed: { item: outcome.failed.item, kind: outcome.failed.kind, code: error.code ?? null, message: error.message },
            cause: error.details ?? null, nextAction: { command: list, skill: '/sf-decide', label: 'List what remains to decide.' } } });
    }
    const read = await readDecisionPacket(root, config, workflow, { phaseId, at: nowIso() }).catch(() => null);
    // Nothing left that waits on this person: the Story's own next step, never an answer with nothing to do [owner, 2026-11-18].
    const after = read ? withStoryNext(read, await storyNextOf(root, workflow.workItem.id, read)) : null;
    // A pin or plan amendment that changed the open code step after its summary was written: its author updates the
    // summary in this same turn, before prepublish refuses it [owner, 2026-11-13].
    const summaryUpdate = recorded.some((entry) => ['plan-amendment', 'node-pin'].includes(entry.kind))
      ? await import('../summary-step-changes.mjs').then(async ({ summaryUpdateAfterDecision }) => summaryUpdateAfterDecision(root, config,
        (await storyContext(root, workflow.workItem.id, { record: false })).workflow)).catch(() => null) : null;
    // One entry per decision, in its own words: a record's ID says neither how many were made nor what they were.
    const draftedItems = new Set([...drafted, ...unchanged].map((entry) => entry.item));
    // What an intent amendment's decision did, beside what was chosen: a partial approval waits for the rest.
    const said = new Map(outcome.recorded.filter((entry) => /^(?:intent-amendment-(?:decision|refresh|acknowledge)|settled-undo)$/u.test(entry.kind) && entry.record?.words)
      .map((entry) => [entry.item, entry.record.words]));
    const decided = plan.steps.filter((step) => !draftedItems.has(step.item))
      .map((step) => ({ item: step.item, words: `${step.label}: ${step.effects.map((effect) => effectWords(workflow, effect, step.values)).join('; then ')}${said.has(step.item) ? `. ${said.get(step.item)}` : ''}` }));
    if (!optionBoolean(options, 'json')) {
      for (const entry of plan.refused) console.log(`Not recorded: ${entry.item} (${entry.title}). ${entry.words} Share this with them: ${entry.share}`);
      for (const entry of decided) console.log(`Recorded ${entry.item}, ${entry.words}.`);
      for (const entry of unchanged) console.log(`Nothing changed for ${entry.item}, ${entry.words}.`);
      for (const entry of drafted) console.log(`Drafted ${entry.item} at ${entry.path}; nothing was recorded. ${entry.next.words}\n  ${entry.next.command}`);
      if (after) console.log(after.items.length ? after.headline : `${after.phaseLabel} has nothing left waiting for a decision.`);
      if (after?.storyNext) console.log(storyNextLines(after.storyNext).join('\n'));
      // Something here still waits on them: the Decide card, never this list again [owner, 2026-11-18].
      else if (after?.items.length && waitsOnPerson(after)) console.log(storyNextLines(decideCardNext(workflow.workItem.id)).join('\n'));
      else if (after && !after.items.length && after.next?.command) console.log(`Next: ${after.next.title}\n  ${after.next.copilotCommand ?? after.next.command}`);
      if (summaryUpdate) console.log(summaryUpdate.words);
    }
    // With nothing left on the list, the Story's own next step: never an answer with nothing to do (owner, 2026-11-10).
    const next = after?.storyNext ? [{ id: 'story-next', label: after.storyNext.title, command: after.storyNext.command, skill: after.storyNext.copilotCommand ?? null, rank: 'NOW', kind: 'workflow' }]
      // What is left is answered on the Decide card: never /sf-decide from a /sf-decide turn [owner, 2026-11-18].
      : after?.items.length ? [{ id: 'decide-card', label: `${after.headline} ${decideCardNext(workflow.workItem.id).title}.`,
        command: decideCardNext(workflow.workItem.id).command, skill: null, rank: 'NOW', kind: 'workflow' }]
      : after?.next?.command ? [{ id: 'story-next', label: after.next.title, command: after.next.command, skill: after.next.skill ?? null, rank: 'NOW', kind: 'workflow' }] : [];
    emitCommandResult(commandResult({
      operation: { id: 'decisions.record', classification: 'mutation' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: succeeded('decisions.record.succeeded', { count: String(plan.steps.length - drafted.length - unchanged.length), records: String(recorded.length),
        refused: String(plan.refused.length), ...(drafted.length ? { drafted: String(drafted.length) } : {}) }),
      effects: effects({ stateChanged: recorded.length > 0, filesChanged: true, publicationCreated: recorded.length > 0 }),
      next: next.map((entry) => action(entry)),
      data: { recorded, decided, ...(drafted.length ? { drafted } : {}), ...(unchanged.length ? { unchanged } : {}), ...(summaryUpdate ? { summaryUpdate, agentInstruction: summaryUpdate.words } : {}), refused: plan.refused,
        remaining: after?.items.map((item) => ({ id: item.id, kind: item.kind, title: item.title })) ?? null, packetSha256: after?.packetSha256 ?? null,
        ...(after?.storyNext ? { storyNext: after.storyNext } : {}) }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
  } finally {
    prompt?.close();
  }
}

async function show(root, options, workId) {
  const { config, workflow } = await storyContext(root, workId, { record: false });
  const phaseId = optionString(options, 'phase') ?? null;
  const at = nowIso();
  const answers = await answersFrom(options);
  const json = optionBoolean(options, 'json');
  const read = await readDecisionPacket(root, config, workflow, { phaseId, at, card: options.card !== false });
  // A preview shows the choices against the list as read; only a read a person answers runs the checks first.
  const packet = probing(options, { json }) && !answered(answers)
    ? await checkedPacket(root, config, workflow, read, { seconds: optionString(options, 'probe-wait', null), phaseId, card: options.card !== false, say: json ? () => {} : toStderr })
    : read;
  if (answered(answers)) {
    const { decisionRecordPlan } = await import('../decision-list.mjs');
    const preview = await previewOf(workflow, packet, decisionRecordPlan(packet, answers, { at }));
    if (!optionBoolean(options, 'json')) {
      console.log(packet.headline);
      for (const entry of preview.refused) console.log(`Not yours to decide: ${entry.item} (${entry.title}). ${entry.words} Share this with them: ${entry.share}`);
      for (const line of preview.summary) console.log(`  ${line}`);
      // A person reads a command they can type: a digest stays with the route a /sf-decide turn runs [no hashes shown].
      if (preview.record) console.log(preview.record.recordInChat
        ? `Nothing was recorded. To record these decisions, answer them in ${preview.record.copilotCommand}, or run ${packet.record.interactive} in your own terminal, which asks you each choice.`
        : `Nothing was recorded. To record these decisions, run in your own terminal:\n  ${preview.record.command}`
          + `${preview.record.copilotCommand ? `\nOr answer them on the Decide card: ${preview.record.copilotCommand} opens it.` : ''}`);
      if (preview.withApproval && !preview.withApproval.recordInChat) console.log(`Or record them with the approval, in one commit:\n  ${preview.withApproval.command}`);
    }
    return emitShow(packet, options, workflow, { preview });
  }
  const route = await inApproval(packet);
  const evidence = optionBoolean(options, 'json') ? await approvalEvidenceOf(root, config, workflow, packet, at) : null;
  const opening = await versionOpeningOf(root, workflow).catch(() => null);
  // The version question is asked here too, so the headline counts it: never "Nothing waits on you now." above it.
  const plain = opening && packet.plain ? { ...packet.plain, headline: (await import('../decision-plain.mjs')).plainHeadline(
    [...packet.items, ...(packet.offered ?? [])].filter((item) => !item.settled && item.plain?.question).length + 1) } : packet.plain;
  const listed = { ...packet, ...(plain ? { plain } : {}), ...(route ? { inApproval: route } : {}), ...(evidence ? { approvalEvidence: evidence } : {}),
    ...(opening ? { versionOpening: opening } : {}) };
  // Nothing here waits on this person: the list ends with the Story's own next step [owner, 2026-11-18].
  const shown = withStoryNext(listed, await storyNextOf(root, workflow.workItem.id, listed, { opening }));
  if (!optionBoolean(options, 'json')) process.stdout.write(packetText(shown));
  return emitShow(shown, options, workflow);
}

/**
 * `decisions undo --settled STL-ID`: a person hands a settled decision back to themselves [owner, 2026-11-13]. Its
 * question goes back on its own route, which the result names; nothing it settled is reversed here.
 */
async function undo(root, options, workId) {
  const id = optionString(options, 'settled');
  if (!id) refused('Name the settled decision to undo: singularity-flow decisions undo [WORK-ID] --settled STL-001. `singularity-flow decisions` lists what was settled.', 'DECISIONS_OPTIONS_INVALID');
  const { config, workflow } = await storyContext(root, workId, { record: true, fetch: optionBoolean(options, 'fetch') });
  if (workflow.status !== 'in_progress') {
    refused(`Story ${workflow.workItem.id} is ${workflow.status}; what was settled is undone while it is in progress.`, 'DECISIONS_STORY_CLOSED');
  }
  const [{ undoSettledDecision }, { actionActor }, { loadSession }] = await Promise.all([
    import('../settled-decisions.mjs'), import('./kernel.mjs'), import('../session.mjs')]);
  const session = await loadSession(root, { required: false });
  const agent = session?.workId === workflow.workItem.id ? session.agent ?? null : null;
  const result = await undoSettledDecision(root, config, workflow, id, { actor: actionActor(root), agent,
    reason: optionString(options, 'reason') ?? null, channel: 'terminal' });
  if (!optionBoolean(options, 'json')) {
    console.log(`Undid ${result.settled.id}: ${result.settled.answer}`);
    console.log(result.reraised.words);
    console.log(`Next: ${result.reraised.copilotCommand ?? result.reraised.command}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decisions.undo', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('decisions.undo.succeeded', { settled: result.settled.id, undo: result.undo.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    next: [action({ id: 'settled-undo.reraised', label: result.reraised.words, command: result.reraised.command,
      skill: result.reraised.copilotCommand?.split(' ')[0] ?? null, rank: 'NOW', kind: 'workflow' })],
    data: { undo: result.undo, settled: result.settled, reraised: result.reraised, commit: result.publication?.sha ?? null, pushed: result.publication?.pushed ?? false }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

export async function run(argv, { positionals = argv, options = {}, io = { input: processInput, output: processOutput } } = {}) {
  const mode = ['record', 'undo'].includes(positionals[1]) ? positionals[1] : 'show';
  if (options.help === true) return console.log(DECISIONS_USAGE);
  const allowed = new Set(mode === 'record' ? RECORD_OPTIONS : mode === 'undo' ? UNDO_OPTIONS : SHOW_OPTIONS);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) refused(`Unsupported decisions ${mode === 'show' ? '' : `${mode} `}option --${key}.`, 'DECISIONS_OPTIONS_INVALID');
  }
  const idIndex = mode === 'show' ? 1 : 2;
  if (positionals.length > idIndex + 1) refused('Name at most one Story: singularity-flow decisions [record|undo] [WORK-ID].', 'DECISIONS_OPTIONS_INVALID');
  const workId = positionals[idIndex] ?? optionString(options, 'work-id') ?? null;
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  if (mode === 'undo') return undo(root, options, workId);
  return mode === 'record' ? record(root, options, workId, io) : show(root, options, workId);
}
