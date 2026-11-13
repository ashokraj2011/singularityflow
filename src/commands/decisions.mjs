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

const SHOW_OPTIONS = Object.freeze(['json', 'help', 'no-model', 'work-id', 'phase', 'choose', 'reason', 'expires', 'cause', 'clause', 'card']);
const RECORD_OPTIONS = Object.freeze([...SHOW_OPTIONS, 'confirm', 'answers', 'fetch']);
const UNDO_OPTIONS = Object.freeze(['json', 'help', 'no-model', 'work-id', 'settled', 'reason', 'fetch']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const DECISIONS_USAGE = [
  'Usage: singularity-flow decisions [WORK-ID] [--phase PHASE] [--no-card] [--json]',
  '       singularity-flow decisions [WORK-ID] --choose ITEM=OPTION [--reason ITEM=TEXT] [--expires ITEM=YYYY-MM-DD] [--cause ITEM=TEXT] [--clause ITEM=IDS] [--json]',
  '       singularity-flow decisions record [WORK-ID] --choose ITEM=OPTION [...]   (your own terminal shows the summary and asks)',
  '       singularity-flow decisions record [WORK-ID] --choose ITEM=OPTION [...] --confirm sha256:DIGEST [--json]   (a script or a /sf-decide turn)',
  '       singularity-flow decisions record [WORK-ID] --answers FILE',
  '       singularity-flow decisions record [WORK-ID]   (interactive terminal)',
  '       singularity-flow decisions undo [WORK-ID] --settled STL-ID [--reason TEXT]   (what was settled for you becomes your question again)',
  'Lists what people must decide before the step can move, in plain words with choices, and records the',
  'choices with one confirmation. Each choice is checked against the deciding person\'s approval group and',
  'written as the same records its own command writes. Options with a recommendation are shown first.'
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
  // An agent may record only options that write upstream-issue records, in a /sf-decide turn.
  const recordInChat = plan.steps.every((step) => ISSUE_ONLY_OPTIONS.includes(step.option));
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
      // A choice no /sf-decide turn may record has no Copilot route: that turn would only preview it again.
      copilotCommand: recordInChat ? `/sf-decide ${packet.workId}` : null,
      terminal: 'Run it in your own terminal to record these decisions; nothing is recorded until then.'
    } : null,
    withApproval
  };
}

function itemLines(item, index, { numbered = false } = {}) {
  // An intent amendment shows what it changes and reaches, so a person decides it from the same words on every host [owner, 2026-11-13].
  const amendment = [...(item.details?.lines ?? []).map((line) => `     - ${line}`), ...(item.details?.proposedBy ? [`   ${item.details.proposedBy}`] : []),
    ...(item.details?.reach ? [`   ${item.details.reach}`] : [])];
  // What was settled for the person is no question: its evidence and where it is undone, not who decides or what it holds.
  const lines = [`${numbered ? `${index + 1}. ` : `${item.id}. `}${item.title}`, `   ${item.why}`, ...amendment,
    ...(item.settled ? settledEvidenceLines(item) : []),
    // Its recommended answer, from the facts SFlow has, or what to weigh when it has none [owner, 2026-11-13].
    ...(item.recommended?.words ? [`   ${item.recommended.words}`] : []), ...(item.settled ? [] : [`   ${item.decidedBy.words}`]),
    // What it holds back and where it is answered, on every item [decision map, findings 1 and 11].
    ...(item.holdsWords && !item.settled ? [`   ${item.holdsWords}`] : []), ...(item.answer?.words ? [`   ${item.answer.words}`] : [])];
  if (!item.decidedBy.allowed && item.decidedBy.share) lines.push(`   Share this with them: ${item.decidedBy.share}`);
  item.options.forEach((option, position) => {
    // An author's own step (accounting for what the person typed) is never the reader's to do.
    const yours = option.action ? (option.decidedBy?.author ? '  (its author\'s step; never recorded here)' : '  (yours to do; never recorded here)')
      : option.available === false ? '  (not available)' : '';
    // The label alone: the option's outcome is data for every host, and beside the label it only repeated it in other words.
    const recommended = option.recommended || item.recommended?.option === option.id;
    lines.push(`   ${numbered ? `${position + 1})` : `${option.id}:`} ${option.label}${recommended ? '  [recommended]' : ''}${yours}`);
    // What the choice does to the Story, in one line [owner, 2026-11-13].
    if (option.does) lines.push(`      ${option.does}`);
    // The option's own command, for a person who decides it in their terminal instead.
    if (option.terminal && option.available !== false && !numbered) lines.push(`      or in your own terminal: ${option.terminal}`);
  });
  return lines;
}

/**
 * What a settled item rests on, one line per fact: shown under "Settled for you", each with its Undo [owner,
 * 2026-11-13]. The records and the settling are the settled-decisions reader's; this only shows them.
 */
function settledEvidenceLines(item) {
  const evidence = [item.evidence ?? item.details?.evidence].flat().filter((line) => typeof line === 'string' && line.trim());
  return evidence.map((line) => `   - ${line}`);
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
  const lines = [packet.headline, ...(packet.recorded?.length ? ['', 'Recorded plan accounting (separate from visual sign-off):',
    ...packet.recorded.map(entry => `  ${entry.id}: ${entry.summary}`)] : [])];
  if (!packet.items.length && !packet.offered?.length && !packet.settled?.length) return `${lines.join('\n')}\n`;
  lines.push('');
  const settled = settledItems(packet);
  for (const [index, item] of packet.items.entries()) if (!settled.includes(item)) lines.push(...itemLines(item, index), '');
  for (const [index, item] of (packet.offered ?? []).entries()) if (!settled.includes(item)) lines.push(...itemLines(item, index), '');
  if (settled.length) {
    lines.push('Settled for you (undo any of them below):', '');
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
  // The next step's own model-free route when it has one (@sflow /approve for the approval), never "not available" beside it.
  } else if (packet.next) lines.push('Next:', ...formatCommandRouteLines({ ...packet.next, modelFreeCommand: packet.next.modelFreeCommand ?? modelFreeCommandForCommand(packet.next.command) }));
  else lines.push(...formatCommandRouteLines({ copilotCommand: packet.record.share }));
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
  try {
    say(packet.headline);
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
      say('');
      for (const line of itemLines(item, index, { numbered: true })) say(line);
      if (!item.decidedBy.allowed) continue;
      // Only the person's own steps: nothing to choose here, so each command is shown, not asked.
      if (item.options.every((option) => option.recordable === false)) {
        for (const option of item.options.filter((entry) => entry.action?.command)) say(`   Run it yourself: ${option.action.command}`);
        continue;
      }
      const skip = item.options.length + 1;
      say(`   ${skip}) Not now`);
      const preferred = item.options.findIndex((entry) => entry.recommended && entry.decidedBy.allowed) + 1 || skip;
      let chosen = null;
      while (chosen === null) {
        const pick = await ask(`   Choose 1-${skip} [${preferred}]: `);
        const number = pick === '' ? preferred : Number(pick);
        if (Number.isInteger(number) && number >= 1 && number <= skip) chosen = number;
        else say(`   Type a number from 1 to ${skip}.`);
      }
      if (chosen === skip) continue;
      const option = item.options[chosen - 1];
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
  return { id: proposal.id, decision: 'approved', applied: true, generation: application.toSpecificationGeneration ?? null,
    words: `${proposal.id} is approved: the amended scope is in force${application.revalidate?.length
      ? `, nothing was reset, and ${application.revalidate.map((entry) => phaseWords(workflow, entry.phase)).join(', ')} ${application.revalidate.length === 1 ? 'has a row' : 'each have a row'} on this list for its approvers`
      : '. Acknowledge it next, on this list or in a terminal'}` };
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
      { decision: effect.decision, reason: step.values.reason || null, channel });
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

async function record(root, options, workId, io) {
  const { config, workflow } = await storyContext(root, workId, { record: true, fetch: optionBoolean(options, 'fetch') });
  if (workflow.status !== 'in_progress') {
    refused(`Story ${workflow.workItem.id} is ${workflow.status}; decisions are recorded while it is in progress.`, 'DECISIONS_STORY_CLOSED');
  }
  const phaseId = optionString(options, 'phase') ?? null;
  const at = nowIso();
  const packet = await readDecisionPacket(root, config, workflow, { phaseId, at });
  let answers = await answersFrom(options);
  let confirm = answers.confirm ?? optionString(options, 'confirm') ?? null;
  const terminal = !confirm && !optionBoolean(options, 'json') && io.input.isTTY === true && io.output.isTTY === true;
  const interactive = terminal && !answered(answers);
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
    const isDraft = (entry) => entry.kind === 'intent-amendment-draft';
    // The same convergence answer again records nothing [SCS:REQ-034]: said so, never counted as recorded.
    const stepOf = (item) => plan.steps.find((step) => step.item === item);
    const same = (entry) => entry.kind === 'convergence-adjudication' && !(stepOf(entry.item)?.effects[0]?.items ?? []).some((id) => (entry.record?.recorded ?? []).includes(id));
    const unchanged = outcome.recorded.filter(same).map((entry) => ({ item: entry.item, words: `${stepOf(entry.item).label}: that answer, with that reason, is already recorded` }));
    const recorded = outcome.recorded.filter((entry) => !isDraft(entry) && !same(entry)).map((entry) => ({ item: entry.item, kind: entry.kind, record: recordId(entry.kind, entry.record), value: entry.record }));
    // What was drafted, where, and what is next: a file, not a record [SCS:REQ-020, REQ-021].
    const drafted = outcome.recorded.filter(isDraft).map((entry) => ({ item: entry.item, path: entry.record.path, clauses: entry.record.clauses ?? [],
      slots: (entry.record.slots ?? []).length, next: { command: entry.record.next.command, copilotCommand: '/sf-reject intent-amendment propose',
        words: 'Write the wording in place of each sflow-draft slot and delete the closing line, or ask the Story\'s agent '
          + '(/sf-reject intent-amendment propose); then propose it. The scope approvers decide it.' } }));
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
    const after = await readDecisionPacket(root, config, workflow, { phaseId, at: nowIso() }).catch(() => null);
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
      if (after && !after.items.length && after.next?.command) console.log(`Next: ${after.next.title}\n  ${after.next.copilotCommand ?? after.next.command}`);
    }
    // With nothing left on the list, the Story's own next step: never an answer with nothing to do (owner, 2026-11-10).
    const next = after?.items.length ? [{ id: 'decision-list', label: after.headline, command: `singularity-flow decisions ${workflow.workItem.id}`,
      skill: '/sf-decide', rank: 'NOW', kind: 'workflow' }]
      : after?.next?.command ? [{ id: 'story-next', label: after.next.title, command: after.next.command, skill: after.next.skill ?? null, rank: 'NOW', kind: 'workflow' }] : [];
    emitCommandResult(commandResult({
      operation: { id: 'decisions.record', classification: 'mutation' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: succeeded('decisions.record.succeeded', { count: String(plan.steps.length - drafted.length - unchanged.length), records: String(recorded.length),
        refused: String(plan.refused.length), ...(drafted.length ? { drafted: String(drafted.length) } : {}) }),
      effects: effects({ stateChanged: recorded.length > 0, filesChanged: true, publicationCreated: recorded.length > 0 }),
      next: next.map((entry) => action(entry)),
      data: { recorded, decided, ...(drafted.length ? { drafted } : {}), ...(unchanged.length ? { unchanged } : {}), refused: plan.refused,
        remaining: after?.items.map((item) => ({ id: item.id, kind: item.kind, title: item.title })) ?? null, packetSha256: after?.packetSha256 ?? null }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
  } finally {
    prompt?.close();
  }
}

async function show(root, options, workId) {
  const { config, workflow } = await storyContext(root, workId, { record: false });
  const phaseId = optionString(options, 'phase') ?? null;
  const at = nowIso();
  const packet = await readDecisionPacket(root, config, workflow, { phaseId, at, card: options.card !== false });
  const answers = await answersFrom(options);
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
        : `Nothing was recorded. To record these decisions, run in your own terminal:\n  ${preview.record.command}`);
      if (preview.withApproval && !preview.withApproval.recordInChat) console.log(`Or record them with the approval, in one commit:\n  ${preview.withApproval.command}`);
    }
    return emitShow(packet, options, workflow, { preview });
  }
  const route = await inApproval(packet);
  const evidence = optionBoolean(options, 'json') ? await approvalEvidenceOf(root, config, workflow, packet, at) : null;
  const shown = { ...packet, ...(route ? { inApproval: route } : {}), ...(evidence ? { approvalEvidence: evidence } : {}) };
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
