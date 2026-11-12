import { formatCommandRouteLines } from '../model-free-commands.mjs';
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
 * as for `decision evidence-reuse`, `decision test-risk` and `decision test-command`.
 */
import { readFile } from 'node:fs/promises';
import { stdin as processInput, stdout as processOutput } from 'node:process';
import readline from 'node:readline/promises';

import { action, commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { nowIso, optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const SHOW_OPTIONS = Object.freeze(['json', 'help', 'no-model', 'work-id', 'phase', 'choose', 'reason', 'expires', 'cause', 'clause', 'card']);
const RECORD_OPTIONS = Object.freeze([...SHOW_OPTIONS, 'confirm', 'answers', 'fetch']);
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const DECISIONS_USAGE = [
  'Usage: singularity-flow decisions [WORK-ID] [--phase PHASE] [--no-card] [--json]',
  '       singularity-flow decisions [WORK-ID] --choose ITEM=OPTION [--reason ITEM=TEXT] [--expires ITEM=YYYY-MM-DD] [--cause ITEM=TEXT] [--clause ITEM=IDS] [--json]',
  '       singularity-flow decisions record [WORK-ID] --choose ITEM=OPTION [...] --confirm sha256:DIGEST [--json]',
  '       singularity-flow decisions record [WORK-ID] --answers FILE',
  '       singularity-flow decisions record [WORK-ID]   (interactive terminal)',
  'Lists what people must decide before the step can move, in plain words with choices, and records the',
  'choices with one confirmation. Each choice is checked against the deciding person\'s approval group and',
  'written as the same records its own command writes. Options with a recommendation are shown first.'
].join('\n');

function refused(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
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
const listedItem = (packet, id) => [...packet.items, ...(packet.offered ?? [])].find((item) => item.id === id);

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
  const summary = plan.steps.map((step) => `${step.item}. ${listedItem(packet, step.item).title}: ${step.label}. `
    + `Records: ${step.effects.map((effect) => effectWords(workflow, effect, step.values)).join('; then ')}.`);
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
  }) ? { phase: packet.phase, flags: decisionApprovalFlags(chosen), recordInChat: recordInChat && plan.steps.every((step) => step.option !== 'return'),
    command: `singularity-flow approve ${packet.phase} --work-id ${packet.workId} --fetch ${decisionApprovalFlags(chosen)}` } : null;
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
  const lines = [`${numbered ? `${index + 1}. ` : `${item.id}. `}${item.title}`, `   ${item.why}`, `   ${item.decidedBy.words}`];
  if (!item.decidedBy.allowed && item.decidedBy.share) lines.push(`   Share this with them: ${item.decidedBy.share}`);
  item.options.forEach((option, position) => {
    const yours = option.action ? '  (yours to do; never recorded here)' : option.available === false ? '  (not available)' : '';
    lines.push(`   ${numbered ? `${position + 1})` : `${option.id}:`} ${option.label}${option.recommended ? '  [recommended]' : ''}${yours}`);
  });
  return lines;
}

function packetText(packet) {
  const lines = [packet.headline, ...(packet.recorded?.length ? ['', 'Recorded plan accounting (separate from visual sign-off):',
    ...packet.recorded.map(entry => `  ${entry.id}: ${entry.summary}`)] : [])];
  if (!packet.items.length && !packet.offered?.length) return `${lines.join('\n')}\n`;
  lines.push('');
  for (const [index, item] of packet.items.entries()) lines.push(...itemLines(item, index), '');
  for (const [index, item] of (packet.offered ?? []).entries()) lines.push(...itemLines(item, index), '');
  if (packet.items.some((item) => ['conformance-gap', 'upstream-issue'].includes(item.kind))) lines.push(packet.rule);
  if ([...packet.items, ...(packet.offered ?? [])].some((item) => item.options.some((option) => option.recordable !== false))) {
    lines.push('Decide them in this terminal:', ...formatCommandRouteLines({ command: packet.record.interactive, copilotCommand: packet.record.copilotCommand }));
    if (packet.record.recommended) lines.push('Or record the recommended choices:', ...formatCommandRouteLines({ command: packet.record.recommended, copilotCommand: packet.record.copilotCommand }));
    if (packet.inApproval) lines.push('Or answer them in the approval, in one commit:', ...formatCommandRouteLines(packet.inApproval));
  } else if (packet.next) lines.push('Next:', ...formatCommandRouteLines(packet.next));
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
  try {
    say(packet.headline);
    for (const [index, item] of [...packet.items, ...(packet.offered ?? [])].entries()) {
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
        values.clause[item.id] = await ask(`   The clauses that carry it, separated by commas${known.length ? ` (${known.slice(0, 8).join(', ')})` : ''}: `);
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

function changedList(packet, confirm, phaseId) {
  refused(`The decision list changed since it was reviewed (it was ${confirm.slice(0, 19)}…, it is ${packet.packetSha256.slice(0, 19)}…). Nothing was recorded. `
    + 'Review the current list and choose again.', 'DECISIONS_PACKET_CHANGED', { packet, packetSha256: packet.packetSha256,
    nextAction: { command: `singularity-flow decisions ${packet.workId}${phaseId ? ` --phase ${phaseId}` : ''}`, skill: '/sf-decide', label: 'Review the current decision list.' } });
}

async function record(root, options, workId, io) {
  const {createGitEngine}=await import('../engine-compatibility/git-publication.mjs');
  const binding=createGitEngine({root,decisionInteraction:{async prepare(context) {
    const {workflow,phaseId,at,packet}=context;
      let answers = await answersFrom(options);
      let confirm = answers.confirm ?? optionString(options, 'confirm') ?? null;
      const interactive = !answered(answers) && !confirm && !optionBoolean(options, 'json') && io.input.isTTY === true && io.output.isTTY === true;
      const { decisionRecordPlan } = await import('../decision-list.mjs');
      let prompt = null;
      if (interactive) {
        if (!packet.items.length && !packet.offered?.length) {
          console.log(packet.headline);
          return {cancelled:true};
        }
        prompt = await promptDecisionAnswers(packet, io);
        if (!prompt) return {cancelled:true};
        answers = prompt.answers;
      }
      try {
        if (!answered(answers)) {
          refused(`Choose at least one item with --choose ITEM=OPTION. ${packet.headline}`, 'DECISIONS_CHOICE_REQUIRED',
            { packet, record: packet.record });
        }
        // Before the answers are read against this list: an item's number means something else on a changed one.
        if (confirm && DIGEST.test(confirm) && confirm !== packet.packetSha256) changedList(packet, confirm, phaseId);
        const plan = decisionRecordPlan(packet, answers, { at });
        const preview = await previewOf(workflow, packet, plan);
        if (prompt) {
          if (!plan.steps.length || !await prompt.confirm(preview.summary)) {
            console.log('Nothing was recorded.');
            return {cancelled:true};
          }
          confirm = packet.packetSha256;
        }
        if (!confirm) {
          refused(`Recording needs the confirmation of the list it was chosen from. Review the summary, then run: ${preview.record?.command ?? packet.record.form}`,
            'DECISIONS_CONFIRMATION_REQUIRED', { summary: preview.summary, record: preview.record, packetSha256: packet.packetSha256,
              nextAction: { command: `singularity-flow decisions ${packet.workId}`, skill: '/sf-decide', label: 'Review the decision list and the summary of your choices.' } });
        }
        if (!DIGEST.test(confirm)) refused('--confirm takes the list\'s digest: sha256:<64 hexadecimal characters>.', 'DECISIONS_OPTIONS_INVALID');
        if (!plan.steps.length) {
          const only = plan.refused.map((entry) => `${entry.item} (${entry.title}): ${entry.words} Share this with them: ${entry.share}`).join(' ');
          refused(`Nothing was recorded: you may not decide what you chose. ${only}`, 'DECISIONS_NOT_YOURS', { refused: plan.refused });
        }
        return {answers,confirmation:confirm};
      } finally {
        prompt?.close();
      }

  }}});
  const receipt=await binding.engine.run('decisions.record',{workId,
    phaseId:optionString(options,'phase') ?? null,fetch:optionBoolean(options,'fetch')});
  if(receipt.status==='not-recorded')return;
  const context=binding.presentation();
  const {workflow,legacyPlan:plan,after}=context;
  const {effectWords}=await import('../decision-list.mjs');
  const decided=plan.steps.map(step=>({item:step.item,words:`${step.label}: ${step.effects.map(effect=>effectWords(workflow,effect,step.values)).join('; then ')}`}));
  context.decided=decided;
  if(!optionBoolean(options,'json')) {
    for(const entry of plan.refused)console.log(`Not recorded: ${entry.item} (${entry.title}). ${entry.words} Share this with them: ${entry.share}`);
    for(const entry of decided)console.log(`Recorded ${entry.item}, ${entry.words}.`);
    if(after)console.log(after.items.length ? after.headline : `${after.phaseLabel} has nothing left waiting for a decision.`);
  }
  emitCommandResult(decisionRecordingCommandResult(receipt,context),{json:optionBoolean(options,'json'),postState:workflow});
}

/** Existing CLI wire projection of the actual registered decision outcome. */
export function decisionRecordingCommandResult(receipt,context) {
  const {legacyPlan:plan,after,decided}=context;
  const next=after?.items.length ? [{id:'decision-list',label:after.headline,
    command:`singularity-flow decisions ${receipt.subject.id}`,skill:'/sf-decide',rank:'NOW',kind:'workflow'}] : [];
  return commandResult({
    operation:{id:'decisions.record',classification:'mutation'},subject:receipt.subject,
    outcome:succeeded('decisions.record.succeeded',{count:String(plan.steps.length),records:String(receipt.effects.recordedEntries),refused:String(plan.refused.length)}),
    effects:effects({stateChanged:true,filesChanged:true,publicationCreated:true}),next:next.map(entry=>action(entry)),
    data:{recorded:receipt.recorded,decided,refused:plan.refused,remaining:receipt.remaining,packetSha256:receipt.packetSha256}
  });
}

async function show(root, options, workId) {
  const phaseId = optionString(options, 'phase') ?? null;
  const {createGitQueryEngine}=await import('../engine-compatibility/git-query.mjs'),
    bound=createGitQueryEngine({root,decisionListOptions:{card:options.card!==false}});
  await bound.engine.run('decisions.list',{workId,phaseId});
  const {workflow,at,packet}=bound.presentation();
  const answers = await answersFrom(options);
  if (answered(answers)) {
    const { decisionRecordPlan } = await import('../decision-list.mjs');
    const preview = await previewOf(workflow, packet, decisionRecordPlan(packet, answers, { at }));
    if (!optionBoolean(options, 'json')) {
      console.log(packet.headline);
      for (const entry of preview.refused) console.log(`Not yours to decide: ${entry.item} (${entry.title}). ${entry.words} Share this with them: ${entry.share}`);
      for (const line of preview.summary) console.log(`  ${line}`);
      if (preview.record) console.log(`Nothing was recorded. To record these decisions, run in your own terminal:\n  ${preview.record.command}`);
      if (preview.withApproval) console.log(`Or record them with the approval, in one commit:\n  ${preview.withApproval.command}`);
    }
    return emitShow(packet, options, workflow, { preview });
  }
  const route = await inApproval(packet);
  const shown = route ? { ...packet, inApproval: route } : packet;
  if (!optionBoolean(options, 'json')) process.stdout.write(packetText(shown));
  return emitShow(shown, options, workflow);
}

export async function run(argv, { positionals = argv, options = {}, io = { input: processInput, output: processOutput } } = {}) {
  const mode = positionals[1] === 'record' ? 'record' : 'show';
  if (options.help === true) return console.log(DECISIONS_USAGE);
  const allowed = new Set(mode === 'record' ? RECORD_OPTIONS : SHOW_OPTIONS);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) refused(`Unsupported decisions ${mode === 'record' ? 'record ' : ''}option --${key}.`, 'DECISIONS_OPTIONS_INVALID');
  }
  const idIndex = mode === 'record' ? 2 : 1;
  if (positionals.length > idIndex + 1) refused('Name at most one Story: singularity-flow decisions [record] [WORK-ID].', 'DECISIONS_OPTIONS_INVALID');
  const workId = positionals[idIndex] ?? optionString(options, 'work-id') ?? null;
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot();
  return mode === 'record' ? record(root, options, workId, io) : show(root, options, workId);
}
