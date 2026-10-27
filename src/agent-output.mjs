/**
 * What an agent reads from a `--for-agent` result: `act` first, and never more than it can see.
 * `[agent-output]`
 *
 * Live Copilot runs failed in one shape again and again. A host saves a long tool result to a file
 * and shows only its start, or saves it outside the workspace where the agent's own file tools
 * cannot open it at all (a verification step stopped on its 40 KB phase entry). Whatever the agent
 * had to act on was late, or unreadable, so it stalled, asked again what an earlier step settled,
 * ended without the next step, or looped on a preview.
 *
 * So every agent result now starts with `act`: one place, derived only from what the engine itself
 * returned, saying what state this is, what to do now with its Copilot, Shell and VS Code routes,
 * and whether a person must answer or confirm first. And it is bounded: when the result is larger
 * than the budget, the complete result is written to the checkout's Git-excluded `.sflow/out/`
 * (agent-output-folder.mjs), long texts as their own line-readable files, and stdout keeps `act`,
 * the fields that fit and the exact line range of every field it left out.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_OUTPUT_FOLDER, agentOutputDirectory, excludeAgentOutput } from './agent-output-folder.mjs';
import { observeFindingStreak } from './finding-escalation.mjs';
import { gitCommonDir, repoRoot } from './git-execution.mjs';
import { CLI_PATH_REFERENCE, safeCommandGuidance, validateSafeSflowCommand } from './safe-command-guidance.mjs';
import { validateAgentEntryRequest } from './agent-entry-options.mjs';
import { interpretsForAgent } from './cli-json-output.mjs';
import { parseArgs, writeAtomic } from './util.mjs';

// Copilot CLI shows a shell result inline only below 8,192 characters. From there it saves the result
// outside the workspace, shows its first 500 characters and suggests rg/head/tail/jq on that file,
// which a session turn may not run. Measured over 9,519 recorded shell results (Copilot 1.0.92 to
// 1.0.95, 2026-10-16): the largest inline was 8,191 characters, the smallest saved 8.0 KB. A 16 KB
// view was therefore still saved. 7,500 bytes leaves room for the stderr lines in the same result.
export const DEFAULT_AGENT_OUTPUT_BYTES = 7_500;
// An agent read a 40 KB overflow file in three slices on average, up to eight: one model call per
// slice, each re-sending the whole conversation (22% of all calls in recorded sessions, 2026-10-18
// to 10-21). So the fields a view leaves out are written first and together, and named as at most
// four ranges of whole fields (72 KB), to be read in one response. In a live run (Copilot 1.0.95,
// 2026-10-22) its file tool cut a ranged read at about 20,000 characters ("Output truncated") and
// refused a 28,205-byte file whole ("File too large to read at once"), so a range is at most
// 18,000 bytes, and a long text file is named as ranges of that size too.
export const READ_CHUNK_BYTES = 18_000;
export const READ_PLAN_CHUNKS = 4;
export const LOOP_THRESHOLD = 3;
const LOOP_WINDOW_MS = 2 * 60 * 60 * 1000;
// `wait`: reading a result again while its command still runs is never a loop.
const UNCOUNTED_STATES = new Set(['author', 'read', 'paused', 'wait']);
const LARGE_TEXT_BYTES = 4_000;
const FIELD_ORDER = 'agentOutputFieldOrder';
// Recorded sessions read review document bodies back in every approval, publish and submit result
// (29% of all overflow bytes read, 2026-10-18 to 10-21), and the same protocol text up to three times.
// A reference (path, size, hash, reason) costs about 350 bytes; shorter texts stay inline.
const DUPLICATE_TEXT_BYTES = 600;
const DOCUMENT_BODY_BYTES = 600;
const DOCUMENT_BODY_REASON = 'document body: the person reviews it outside the chat; open it only to quote a line';
const FIELD_BYTES = 6_000;
const SMALL_FIELD_BYTES = 300;
const KEPT_RESULTS = 40;
// The omitted-field list a view shows; past it, a count and a paged index file. `[OUT:REQ-014]`
export const OMITTED_FIELDS_SHOWN = 12;
const PREVIEW_BYTES = 1_500;
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const oneLine = (text, limit = 400) => {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

export function agentOutputBudget(env = process.env) {
  const configured = Number.parseInt(env.SINGULARITY_FLOW_AGENT_OUTPUT_BYTES ?? '', 10);
  return Number.isInteger(configured) && configured >= 4_000 && configured <= 1_000_000 ? configured : DEFAULT_AGENT_OUTPUT_BYTES;
}

/** Bounded agent output applies to the outermost command only: a composed step reads its result whole. */
export function agentOutputGoverned(env = process.env) {
  return env.SINGULARITY_FLOW_AGENT_OUTPUT !== 'full' && env.SINGULARITY_FLOW_AGENT_OUTPUT !== 'raw'
    && !(globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0)
    // A command whose action a person reviewed at the terminal (action-authorization.mjs) is read
    // there by that person, whole: its preview, their answer and its result.
    && globalThis.__SINGULARITY_FLOW_PERSON_AT_TERMINAL !== true;
}

/** The three routes of one engine-returned action, exactly as its own guidance gives them. */
function routes(action) {
  if (!action || typeof action !== 'object') return null;
  const given = action.commandGuidance && typeof action.commandGuidance === 'object' && !Array.isArray(action.commandGuidance)
    && (action.commandGuidance.command || action.commandGuidance.copilotCommand) ? action.commandGuidance : null;
  const guidance = given ?? (action.command || action.argv ? safeCommandGuidance(action) : null);
  const shell = guidance?.command ?? action.command ?? null;
  const copilot = guidance?.copilotCommand ?? action.copilotCommand ?? null;
  const vscode = guidance?.modelFreeCommand ?? action.modelFreeCommand ?? null;
  if (!shell && !copilot) return null;
  return { reason: oneLine(action.reason ?? action.detail ?? action.label ?? ''), copilot, shell, vscode };
}

/** A returned action that carries a value a person must confirm (a digest or plan hash). */
function confirmation(route) {
  const value = String(route?.shell ?? '').match(/\s--confirm(?:-plan)?\s+(?!--)(\S+)/u)?.[1];
  return value ? { kind: 'confirm', value,
    how: 'Show what it confirms, ask the person in this chat, and only on an explicit yes run do.shell once; a changed value needs a fresh review.' } : null;
}

// An informational next action is an offer for the person, never the one thing to do now: a
// `pause status` read offered "Pause SFlow guidance", and the loop guard told Copilot to do it.
const firstNow = (actions) => Array.isArray(actions)
  ? actions.find((action) => action && typeof action === 'object' && action.kind !== 'informational'
    && (action.timing == null || ['now', 'blocked'].includes(action.timing))) ?? null
  : null;

function genericAction(result) {
  return result.continuation?.nextAction ?? (result.nextAction && typeof result.nextAction === 'object' ? result.nextAction : null)
    ?? (result.nextCommand ? { command: result.nextCommand, skill: result.nextSkill ?? null, reason: result.reason ?? null } : null)
    ?? firstNow(result.actions) ?? firstNow(result.next) ?? null;
}

function withRoute(act, action) {
  const route = routes(action);
  if (!route) return act;
  const ask = confirmation(route);
  return { ...act, ...(ask ? { state: 'confirm', ask } : {}), do: route };
}

/**
 * The state and the one thing to do now, from the engine's own fields only. A result type with
 * its own meaning is read by its rule; anything else uses the first explicit next action it returns.
 */
export function agentAct(result) {
  if (result?.resultType === 'sflow-utility-entry') {
    const act = agentAct(result.data);
    return act ? { ...act, ...(act.read ? { read: act.read.map(field => `data.${field}`) } : {}) } : null;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.paused === true) return { state: 'paused', said: 'SFlow is paused for this conversation; answer as native Copilot and offer only /sf-pause off.', do: null };
  // `result last` (agent-result-keeper.mjs): a kept result is acted on as the command returned it;
  // otherwise it says to wait for the command, run it once more, or that nothing was kept.
  if (result.resultType === 'sflow-kept-result') {
    if (result.status === 'running') return { state: 'wait', do: { reason: 'Read the result once the command ends.', copilot: null, shell: result.retry ?? null, vscode: null },
      said: oneLine(`Still running: ${(result.running ?? []).map((entry) => entry.command).join('; ')}. Run this same read again; never run the command itself again.`) };
    if (result.status === 'interrupted') return { state: 'next', do: null,
      said: oneLine(`${result.interrupted?.command ?? 'The command'} ended without a result (interrupted or killed). Run it again once, with --for-agent --json.`) };
    if (result.status === 'none') return { state: 'read', do: null, said: 'No result is kept for this checkout. Run the command again once, with --for-agent --json.' };
  }
  // Every skill reads the pause state first, so the same answer repeats all day: it is a read to
  // follow, never an action (pausing or resuming is only ever the person's explicit request).
  const mode = result.resultType === 'sflow-copilot-mode' ? result : result.data?.resultType === 'sflow-copilot-mode' ? result.data : null;
  if (mode) return mode.paused === true ? agentAct({ paused: true }) : { state: 'read', said: oneLine(mode.agentInstruction ?? '') || null, do: null };
  const documents = result.resultType === 'document-readiness' ? result : result.documentReadiness;
  if (documents?.status === 'upload-required') return { state: 'ask-person', do: null,
    read: documents === result ? ['missing', 'instruction'] : ['documentReadiness', 'continuation', 'actions', 'next'],
    said: 'Ask for the listed original documents on this laptop. Restore each existing ID with the chosen file; do not recreate the Story, change hashes, or repeat settled questions.' };
  if (result.resultType === 'document-restored') return withRoute({ state: 'next', do: null,
    read: ['documentId', 'effects', 'preservedPath', 'next'],
    said: 'The exact original is restored locally under the same ID. Report any preserved changed copy. No Story phase, approval or Git ref changed; resume the returned same-Story route.' }, genericAction(result));
  if (result.resultType === 'intake-entry') {
    if (result.status === 'preflight-ready') return { state: 'next', do: null, read: ['preflight', 'intake'],
      said: 'The exact selected-base preview passed. Continue this invocation\'s Start step with identical explicit choices and the returned receipt, if any. Do not repeat preflight; creation still validates live authority.' };
    if (result.status === 'choices-ready') return { state: 'ask-person', do: null,
      read: ['choices', 'intake', 'existingWork', 'preflight', 'personalization'],
      said: 'Use the returned catalog to ask for explicit base, workflow and intake-policy choices. Reuse this packet; do not repeat pause/workspace/version/status/catalog lookups. It does not authorize Story creation.' };
    return withRoute({ state: 'next', do: null, read: ['changes', 'workspace', 'existingWork', 'preflight'],
      said: `Intake requires ${result.status}; preserve existing work and resolve that condition before creating a Story.` },
    result.commandGuidance ? { commandGuidance: result.commandGuidance } : null);
  }
  if (result.resultType === 'session-open') {
    if (result.status === 'choose' && result.localClone?.available === false) return { state: 'ask-person', do: null,
      read: ['table', 'localClone', 'selectors'],
      said: 'Show the returned candidates; they were read from the remote because the local clone cannot be read. Say that opening a Story is blocked and relay localClone.remedy; do not open one until the person has done it.' };
    if (result.status === 'choose') return { state: 'ask-person', do: null, read: ['table', 'selectors'],
      said: 'Show the returned candidates and ask for the exact Story ID. Reuse this packet; do not list them again without a selection change.' };
    if (result.status === 'ready') {
      // The facts and actions to relay, here at the start, whatever a host shows of the rest.
      // No `do`: opening a session again is never a loop to count.
      const open = result.open ?? {};
      const actions = Array.isArray(result.nextsteps?.actions) ? result.nextsteps.actions : result.nextsteps?.data?.actions ?? [];
      const next = actions.map((entry) => routes(entry) && { timing: entry.timing ?? null, ...routes(entry) }).filter(Boolean).slice(0, 5);
      return { state: 'next', do: null,
        story: { workId: result.workId ?? open.workId ?? null, repositoryPath: result.repositoryPath ?? open.repositoryPath ?? null,
          commit: typeof open.head === 'string' ? open.head.slice(0, 12) : null, agent: open.agent ?? result.session?.activeAgent ?? null,
          phase: open.phase ?? result.session?.phase ?? null, localOnly: result.localOnly ?? null,
          ...(open.remoteSync?.status ? { remoteSync: open.remoteSync.status } : {}) },
        ...(next.length ? { next } : {}), read: ['nextsteps', 'context'],
        said: `The exact session is attached and verified.${open.remoteSync?.status === 'unavailable'
          ? ' Say that the remote could not be reached, so the local checkout was opened as it is and may be behind.' : ''} Report story, relay its next actions in order and end the session-only turn; do not repeat context or nextsteps lookups.` };
    }
  }
  if (result.error?.code === 'SOURCE_REVIEW_REPORT_INVALID' && result.error.details?.repair?.status === 'repair-packet') return {
    state: 'correct', do: null, read: ['error.details.repair', 'error.details.findings'],
    said: 'The packet was not retained. Repair its exact format/citation fields using the returned hints and this invocation\'s stagingProtocol; check changed bytes within the two-repair budget. Do not restart the phase, run generic diagnostics, or invent coverage.' };
  if (result.error && result.remediationPlan) {
    const plan = result.remediationPlan;
    const step = (plan.steps ?? []).find((entry) => entry?.command) ?? null;
    return withRoute({ state: plan.escalation ? 'escalate' : 'refused',
      said: oneLine(plan.escalation?.instruction ?? `${result.error.code ?? 'Refused'}: ${result.error.message ?? ''}`),
      strategy: plan.context?.strategy ?? null, do: null }, step && { ...step, reason: step.label });
  }
  const done = result.publishIfReady?.published ? result.publishIfReady.next : result.submitIfReady?.submitted ? result.submitIfReady.next : null;
  if (done) return { state: 'next', said: oneLine(done.instruction?.split('. ')[0] ?? 'Done.'),
    do: done.commandGuidance ? { reason: oneLine(done.reason), copilot: done.commandGuidance.copilotCommand ?? null,
      shell: done.commandGuidance.command ?? null, vscode: done.commandGuidance.modelFreeCommand ?? null } : null };
  if (result.resultType === 'sflow-phase-entry') {
    if (result.status === 'documents-required') return { state: 'ask-person', do: null,
      read: ['documentReadiness', 'next'],
      said: 'Ask the person to upload the missing original documents on this laptop. Restore the existing IDs with the exact returned commands and an explicitly chosen file; then resume this phase. Never recreate the Story, duplicate documents or repeat settled requirements questions.' };
    if (result.status === 'authoring-entry') return { state: 'author', do: null, read: ['mutationContract', 'authoringProgress', 'scopeReview', 'context'],
      said: `Authoring ${result.phase ?? 'this step'} is admitted: do this step's own drafting now, inside mutationContract. It is not a next action to relay.` };
    if (result.status === 'clarification-required') return { state: 'ask-person', do: null, read: ['clarification', 'context'],
      said: oneLine(`Ask the unanswered questions now, as clarification.checkpoint says${result.context ? '' : ' after composing the context once'}; this is this skill's own step.`) };
    return withRoute({ state: 'next', said: oneLine(result.reason ?? `Phase entry status: ${result.status}.`), do: null }, firstNow(result.next));
  }
  if (result.resultType === 'sflow-phase-prepublish') {
    if (result.repairLoop?.status === 'escalate') return { state: 'escalate', do: null,
      said: oneLine(result.repairLoop.instruction ?? 'The same finding keeps returning; stop repairing and hand it on.') };
    if (result.status === 'ready' && result.commands?.publish) return withRoute({ state: 'publish', do: null, read: ['scopeReview'],
      said: 'Ready: publish once with the returned command; it runs the required tests.' },
      { command: result.commands.publish, ...(result.commandGuidance?.publish ? { commandGuidance: result.commandGuidance.publish } : {}), reason: 'Publish this draft.' });
    const count = Array.isArray(result.findings) ? result.findings.length : null;
    return { state: 'correct', do: null, read: ['findings', 'correction', 'traceabilityRepair', 'repairLoop'],
      said: oneLine(`${result.status}${count == null ? '' : ` with ${count} finding${count === 1 ? '' : 's'}`}: ${result.correction?.guidance ?? 'fix the listed findings in this draft, then recheck once.'}`),
      ...correctionList(result.findings) };
  }
  if (result.resultType === 'source-review-agent-context' && result.canReview) return {
    state: 'review', do: null, read: ['reviewGuide', 'citationGuide', 'sources', 'clarifications', 'artifact', 'reportTemplate', 'stagingProtocol'],
    said: 'Perform the independent review now. Read pinned source text files with native file tools; their 1-based lines are citation lines. Stage, check, repair the changed packet within the bounded budget, then retain. Do not stop at a repairable packet error or invent coverage.' };
  if (result.resultType === 'source-review-check') {
    if (result.repair?.status === 'reload-context') return withRoute({ state: 'next', do: null,
      read: ['repair'], said: result.repair.instruction }, result.continuation?.nextAction);
    if (result.retentionReady && result.repair?.mappingTasks?.length) return {
      state: 'review', do: null, read: ['repair', 'evaluation', 'stagingProtocol'],
      said: 'Review missing scenario/clause mappings now. Add only genuinely supported rows and recheck within the repair budget; otherwise retain reviewed genuine gaps using stagingProtocol.retain. Do not invent coverage or require a new author generation for a reviewer omission.' };
    if (result.retentionReady) return withRoute({ state: 'retain', do: null,
      read: ['repair', 'evaluation'], said: 'Packet valid: retain it now, including honest correction-required findings. Retention is not approval.' }, result.continuation?.nextAction);
    return { state: 'correct', do: null, read: ['repair', 'findings', 'stagingProtocol'],
      said: 'Repair this staged packet now using exact citation fields and pinned text, then check the changed packet. At most two changed-packet repair attempts; never retry unchanged bytes or invent coverage.',
      ...correctionList(result.findings) };
  }
  // The decision list: the person chooses; recording a reused run or a test-run risk is their own
  // terminal step, and an agent records only upstream-issue options, in a /sf-decide turn.
  const list = result.resultType === 'sflow-decisions' ? result : result.data?.resultType === 'sflow-decisions' ? result.data : null;
  if (list) {
    const at = list === result ? '' : 'data.';
    const record = list.preview?.record ?? null;
    if (record) return record.recordInChat
      ? { state: 'confirm', do: null, read: [`${at}preview`],
        said: `Show ${at}preview.summary and ask the person for an explicit yes in this chat. In a /sf-decide turn run ${at}preview.record.command once; otherwise give it to them for their own terminal. Never change its digest.` }
      : { state: 'confirm-in-terminal', do: null, read: [`${at}preview`],
        said: `Show ${at}preview.summary. The person records it by running ${at}preview.record.command in their own terminal; never run it or change its digest.` };
    if (list.items?.length) return { state: 'ask-person', do: null, read: [`${at}items`, `${at}record`],
      said: 'Show each item\'s title and why; ask the person to pick one of its options (recommended first) and any date or reason, offering its default. Never choose for them.' };
    return { state: 'read', do: null, said: oneLine(list.headline) };
  }
  const action = genericAction(result);
  const state = result.classification === 'convergence-advance-required' ? 'confirm-review' : 'next';
  const said = oneLine(result.reason ?? result.agentInstruction ?? (result.classification ? `Classification: ${result.classification}.` : '')) || null;
  return withRoute({ state: action ? state : 'read', said, do: null }, action);
}

/**
 * The findings to fix, in `act` itself. A correction said only "correct the cited findings": an
 * agent whose host showed the start of the result never saw which, edited blind and reran
 * prepublish ten times while the count went 1, 3, 2, 4. Each line names the place and the fix.
 */
function correctionList(findings) {
  if (!Array.isArray(findings) || !findings.length) return {};
  const MAXIMUM = 6;
  const fix = findings.slice(0, MAXIMUM).map((finding) => {
    const where = finding?.path ? ` at ${finding.path}${finding.line ? `:${finding.line}` : ''}` : '';
    return oneLine(`${finding?.code ?? 'finding'}${where}: ${finding?.message ?? ''}`, 320);
  });
  if (findings.length > MAXIMUM) fix.push(`+${findings.length - MAXIMUM} more in findings`);
  return { fix };
}

/**
 * The same actionable result three times in a row is a loop, whatever produced it. `[agent-output]`
 *
 * A person following a preview route saw the same Convergence digest again and again; agents
 * re-ran reads that could not change. When an agent result with something to do or confirm comes
 * back unchanged a third time for the same Story step (same state, command, value, head and
 * generation, within two hours), `act` says so and names the one thing that changes it. The count
 * is kept on this computer only (finding-escalation.mjs's private store) and accepts nothing.
 */
export function observeAgentLoop(root, result, act, { now = Date.now() } = {}) {
  if (!act || UNCOUNTED_STATES.has(act.state) || !(act.do || act.ask)) return act;
  const fingerprint = sha256(JSON.stringify([result.resultType ?? null, act.state, act.do?.shell ?? act.do?.copilot ?? null,
    act.ask?.value ?? null, result.head ?? null, result.generation ?? null, result.status ?? result.classification ?? null]));
  let count = 1;
  try {
    count = observeFindingStreak(root, { workId: `agent-loop:${result.workId ?? result.resultType ?? 'result'}`,
      phaseId: String(result.phase ?? result.phaseId ?? '-'), fingerprint, windowMs: LOOP_WINDOW_MS, now });
  } catch { return act; }
  if (count < LOOP_THRESHOLD) return act;
  const instruction = act.ask?.kind === 'confirm' || act.state === 'confirm'
    ? `This confirmation has come back ${count} times in a row and the person has not given it. Ask them now in this chat to confirm the exact value; only on an explicit yes run do.shell once. Do not offer the preview again.`
    : act.state === 'confirm-review'
      ? `This review has come back ${count} times in a row unconfirmed. Run do.shell once to show the digest, then ask the person now in this chat to confirm it; only on an explicit yes run the returned --confirm command once. Do not end with this route again.`
    : act.state === 'ask-person'
      ? `The same questions have been due ${count} times in a row. Ask them now with ask_user (or print them and stop); do not load the context again.`
      : `The same result has come back ${count} times in a row; repeating the command cannot change it. Do act.do now, or tell the person exactly what is blocked and stop.`;
  return { ...act, said: `Repeated ${count} times: ${act.said ?? ''}`.trim(), loop: { repeated: count, instruction } };
}

/** Write a long text as its own line-readable file; the full JSON keeps a reference to it. */
async function externalize(value, directory, base, trail, written, reviewSources = false) {
  const citationText = reviewSources && trail.length === 3 && trail[0] === 'sources' && trail[2] === 'text';
  if (typeof value === 'string' && (citationText || bytes(value) > LARGE_TEXT_BYTES)) {
    const file = path.join(directory, `${base}.${trail.join('.').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80)}.txt`);
    await writeAtomic(file, value, { mode: 0o600 });
    const entry = { textFile: file, bytes: bytes(value), lines: value.split('\n').length, sha256: sha256(value) };
    written.push({ field: trail.join('.'), ...entry });
    return entry;
  }
  if (Array.isArray(value)) return Promise.all(value.map((child, index) => externalize(child, directory, base, [...trail, String(index)], written, reviewSources)));
  if (!value || typeof value !== 'object') return value;
  const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await externalize(child, directory, base, [...trail, key], written, reviewSources)]));
  return Object.fromEntries(entries);
}

/** Every string at least `minimum` bytes long under `value`, with its trail. */
function longStrings(value, trail, minimum, found = []) {
  if (typeof value === 'string') { if (bytes(value) >= minimum) found.push({ trail, text: value }); }
  else if (Array.isArray(value)) value.forEach((child, index) => longStrings(child, [...trail, String(index)], minimum, found));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) longStrings(child, [...trail, key], minimum, found);
  return found;
}

const valueAt = (value, trail) => trail.reduce((node, key) => (node == null ? node : node[key]), value);
const reviewDocumentBody = (trail) => trail.some((key, index) => key === 'review' && trail[index + 1] === 'documents'
  && /^\d+$/u.test(trail[index + 2] ?? '') && (trail[index + 3] === 'content' || (trail[index + 3] === 'display' && ['full', 'preview'].includes(trail[index + 4])))
  && trail.length === index + (trail[index + 3] === 'content' ? 4 : 5));

/**
 * Text in the fields a view leaves out that an agent should not read again: a review document's
 * body (every review skill shows identities, hashes and links, never bodies: the person reviews
 * them outside the chat), and a long text the result already gives it elsewhere (the path rule
 * in act, the composed prompt that renders the same protocol, instructions inside effective
 * instructions). Each becomes its own file, marked with why, outside the read ranges;
 * completeAgentResult() still reads it back. Returns the fields to write and the files marked.
 */
async function referenceTexts(full, ordered, omitted, kept, seen, { directory, base, texts }) {
  const minimum = DUPLICATE_TEXT_BYTES;
  const fileOf = new Map(texts.map((entry) => [entry.field, entry]));
  const candidates = [];
  // A body is never wanted, in the view or out of it; a repeated text only matters where it is read again.
  for (const key of [...omitted, ...kept]) {
    const walk = (node, trail) => {
      if (isTextReference(node)) {
        const text = valueAt(ordered, trail);
        if (typeof text === 'string' && bytes(text) >= minimum) candidates.push({ trail, text, file: fileOf.get(trail.join('.')) ?? null });
      } else if (typeof node === 'string') { if (bytes(node) >= minimum) candidates.push({ trail, text: node, file: null }); }
      else if (Array.isArray(node)) node.forEach((child, index) => walk(child, [...trail, String(index)]));
      else if (node && typeof node === 'object') for (const [name, child] of Object.entries(node)) walk(child, [...trail, name]);
    };
    walk(full[key], [key]);
  }
  for (const candidate of candidates) if (reviewDocumentBody(candidate.trail) && bytes(candidate.text) > DOCUMENT_BODY_BYTES) candidate.reason = DOCUMENT_BODY_REASON;
  const inView = (candidate) => kept.includes(candidate.trail[0]);
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.reason || inView(candidate)) continue;
    const where = (other) => `same text as ${other.trail.join('.')}`;
    const shown = seen.find((other) => other.text.includes(candidate.text));
    // A longer text the agent reads anyway holds it, or an earlier copy does; a body to review
    // outside the chat is never what holds it.
    const holder = shown ?? candidates.find((other, at) => other !== candidate && !other.reason && !inView(other) && other.text.includes(candidate.text)
      && (other.text.length > candidate.text.length || at < index));
    if (holder) candidate.reason = where(holder);
  }
  const marked = candidates.filter((candidate) => candidate.reason);
  if (!marked.length) return { fields: full, references: new Set() };
  const fields = Object.fromEntries(Object.entries(full).map(([key, value]) => [key, omitted.includes(key) || kept.includes(key) ? structuredClone(value) : value]));
  const references = new Set();
  for (const candidate of marked) {
    let entry = candidate.file;
    if (!entry) {
      const file = path.join(directory, `${base}.${candidate.trail.join('.').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80)}.txt`);
      await writeAtomic(file, candidate.text, { mode: 0o600 });
      entry = { textFile: file, bytes: bytes(candidate.text), lines: candidate.text.split('\n').length, sha256: sha256(candidate.text) };
      // Registered as an issued read path with the rest, so the agent may still open it.
      texts.push({ field: candidate.trail.join('.'), ...entry, reference: true });
    }
    references.add(entry.textFile);
    const parent = valueAt(fields, candidate.trail.slice(0, -1));
    parent[candidate.trail.at(-1)] = { textFile: entry.textFile, bytes: entry.bytes, lines: entry.lines, sha256: entry.sha256, referenceOf: candidate.reason };
  }
  return { fields, references };
}

/** The 1-based line range of each top-level field in two-space indented JSON. */
function topLevelRanges(text) {
  const lines = text.split('\n');
  const ranges = {};
  let current = null;
  lines.forEach((line, index) => {
    const match = line.match(/^ {2}"((?:[^"\\]|\\.)*)":/u);
    if (match) {
      if (current) ranges[current].push(index);
      current = JSON.parse(`"${match[1]}"`);
      ranges[current] = [index + 1];
    }
  });
  if (current) ranges[current].push(lines.length - 1);
  return ranges;
}

/** Consecutive line ranges of a text, each at most `chunkBytes` (a longer line is its own range). */
function lineRanges(text, chunkBytes = READ_CHUNK_BYTES) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const ranges = [];
  let start = 1, size = 0;
  lines.forEach((line, index) => {
    const length = bytes(line) + 1;
    if (size && size + length > chunkBytes) { ranges.push([start, index]); start = index + 1; size = 0; }
    size += length;
  });
  if (lines.length) ranges.push([start, lines.length]);
  return ranges;
}

/**
 * The ranges that hold the given fields, in order: consecutive whole fields grouped up to the chunk
 * size, a larger field split at line boundaries. At most `chunks` ranges; what is left stays
 * readable by each field's own range.
 */
function readPlan(text, ranges, fields, { chunkBytes = READ_CHUNK_BYTES, chunks = READ_PLAN_CHUNKS } = {}) {
  const lines = text.split('\n');
  const lineBytes = (index) => bytes(lines[index - 1]) + 1;
  const plan = [];
  let open = null;
  const close = () => { if (open) plan.push({ lines: [open.start, open.end], bytes: open.bytes }); open = null; };
  for (const field of fields) {
    const [start, end] = ranges[field] ?? [];
    if (!start || !end) continue;
    let fieldBytes = 0;
    for (let line = start; line <= end; line++) fieldBytes += lineBytes(line);
    // A field that does not fit beside the open range starts its own; only a field larger than a
    // whole range is split, at line boundaries.
    if (open && open.bytes + fieldBytes > chunkBytes) close();
    for (let line = start; line <= end; line++) {
      const size = lineBytes(line);
      if (open && open.bytes + size > chunkBytes) close();
      if (plan.length >= chunks) return plan;
      open ??= { start: line, end: line, bytes: 0 };
      open.end = line;
      open.bytes += size;
    }
  }
  close();
  return plan.slice(0, chunks);
}

// A result stays at least a day, so an agent still reading one never loses it to a later command's
// cleanup; older ones stay while they are among the newest KEPT_RESULTS.
const KEPT_RESULT_MS = 24 * 60 * 60 * 1000;

// The names SFlow writes: `<kind>-<8 hex>`, then a field trail or `omitted` for the files of the
// same result. The folder sits in a checkout, so cleanup never touches any other file there.
const RESULT_FILE = /^[A-Za-z0-9-]{1,48}-[0-9a-f]{8}(?:\.[A-Za-z0-9_.-]+)?\.(?:json|txt)$/u;

/** A result's base name: its kind and the first eight hex digits of what it holds. */
const resultBase = (kind, text) => `${String(kind || 'result').replace(/^sflow-/u, '').replace(/[^A-Za-z0-9-]/gu, '-').slice(0, 48) || 'result'}-${sha256(text).slice(7, 15)}`;

/**
 * Remove old results whole: a result is its JSON, its text files and its omitted index, all named
 * from one base and dated by their newest file. The result just written (`keep`) is never removed,
 * however many files it has.
 */
async function prune(directory, keep, now = new Date()) {
  try {
    const results = new Map();
    for (const name of (await readdir(directory)).filter((name) => RESULT_FILE.test(name))) {
      const base = name.replace(/\..*$/u, '');
      const entry = results.get(base) ?? { base, names: [], at: 0 };
      entry.names.push(name);
      results.set(base, entry);
    }
    await Promise.all([...results.values()].map(async (entry) => {
      entry.at = Math.max(0, ...await Promise.all(entry.names.map((name) => stat(path.join(directory, name)).then(({ mtimeMs }) => mtimeMs, () => 0))));
    }));
    const stale = [...results.values()].sort((left, right) => right.at - left.at).slice(KEPT_RESULTS)
      .filter((entry) => entry.base !== keep && now.getTime() - entry.at > KEPT_RESULT_MS);
    await Promise.all(stale.flatMap((entry) => entry.names.map((name) => rm(path.join(directory, name), { force: true }))));
  } catch { /* retention is best effort */ }
}

async function registerReadFiles(root, files) {
  try { await (await import('./copilot-mutation-guard.mjs')).issueMutationReadPaths(root, files); }
  catch (error) {
    // Presentation bookkeeping must not turn a successful publication into a replayable failure.
    console.error(`Warning: CLI-issued read-path hints could not be registered (${error.code ?? error.message}). Exact returned paths remain authoritative.`);
  }
}

function repositoryOf(result, cwd) {
  const candidate = typeof result.repositoryPath === 'string' && path.isAbsolute(result.repositoryPath) ? result.repositoryPath : cwd;
  // The checkout's top, from the same one Git process that names its Git directories, so the
  // anchored exclude line covers the folder from any cwd inside it. Native real paths also expand
  // Windows 8.3 aliases (a short TEMP path versus Git's long path): both sides must name the same
  // physical root before computing a checkout-relative file.
  try {
    const root = realpathSync.native(repoRoot(candidate));
    return { root, common: gitCommonDir(candidate), directory: path.join(root, ...AGENT_OUTPUT_FOLDER.split('/')) };
  } catch { return null; }
}

/** Make the folder ready before the first file: excluded from Git first, then created. */
async function readyFolder(target) {
  await excludeAgentOutput(target.common);
  await agentOutputDirectory(target.root);
}

/** True when this exact command accepts --for-agent; a compact entry keeps its own option rules. */
async function acceptsAgentView(argv) {
  const { positionals, options } = parseArgs(argv);
  const [command, subcommand] = positionals;
  // An exact confirmation is replayed exactly; a read without --json has no agent view.
  if (options.confirm !== undefined || options.json !== true) return false;
  // For every other command it is an output option the CLI removes before the command reads options.
  if (!interpretsForAgent(positionals)) return true;
  const withFlag = { ...options, 'for-agent': true };
  try {
    if (command === 'phase' && subcommand === 'enter') {
      (await import('./commands/phase.mjs')).validatePhaseEntryRequest({ positionals, options: withFlag });
    } else if (command === 'session') {
      if (subcommand === 'current') {
        return positionals.length === 2 && Object.keys(withFlag).every((key) => ['for-agent', 'json', 'no-model', 'timings', 'timing'].includes(key));
      }
      if (subcommand !== 'open') return false;
      (await import('./commands/session-open.mjs')).validateSessionOpenRequest({ positionals, options: withFlag });
    } else if (['nextsteps', 'inputs', 'review-source'].includes(command)) {
      validateAgentEntryRequest(command, { positionals, options: withFlag });
    }
    return true;
  } catch { return false; }
}

/**
 * Every exact SFlow route an agent view returns carries --for-agent where its command accepts it.
 * Copilot's shell is not a terminal, so a route the agent runs as given (`recover --phase X --json`)
 * otherwise printed its whole result and the host saved it outside the workspace. Only a string that
 * is one complete SFlow command changes; prose, Copilot routes and confirmations never do.
 */
export async function withAgentRoutes(value) {
  const routed = new Map();
  const route = (text) => {
    if (!/^(?:singularity-flow|sflow) /u.test(text) || text.includes('--for-agent')
        || (text.match(/ --json(?=\s|$)/gu) ?? []).length !== 1) return text;
    if (!routed.has(text)) routed.set(text, (async () => {
      const safe = validateSafeSflowCommand(text);
      if (!safe || safe.argv.filter((value) => value === '--json').length !== 1) return text;
      return await acceptsAgentView(safe.argv) ? text.replace(/ --json(?=\s|$)/u, ' --for-agent --json') : text;
    })());
    return routed.get(text);
  };
  const walk = async (node) => {
    if (typeof node === 'string') return route(node);
    if (Array.isArray(node)) return Promise.all(node.map(walk));
    if (!node || typeof node !== 'object') return node;
    const entries = await Promise.all(Object.entries(node).map(async ([key, child]) => [key, await walk(child)]));
    const next = Object.fromEntries(entries);
    // A route's argv stays the same command as its text.
    if (typeof node.command === 'string' && next.command !== node.command && Array.isArray(node.argv) && node.argv.includes('--json')) {
      next.argv = node.argv.flatMap((value) => value === '--json' ? ['--for-agent', '--json'] : [value]);
    }
    // And so does each platform's quoted copy of it, which an agent may run instead.
    if (typeof node.command === 'string' && next.command !== node.command && node.platformCommands && typeof node.platformCommands === 'object') {
      next.platformCommands = Object.fromEntries(Object.entries(node.platformCommands).map(([platform, line]) => [platform,
        typeof line === 'string' && !line.includes('--for-agent') ? line.replace(/ (['"]?)--json\1(?=\s|$)/u, ' $1--for-agent$1 $1--json$1') : line]));
    }
    return next;
  };
  return walk(value);
}

// A field that hands the agent a path: its key names one and its value is one (or a list of them).
// `repositoryPath` alone is the command cwd every skill boundary already names.
const PATH_KEY = /^(?:path|file|root|directory|textFile)$|(?:Path|File|Root|Directory)$/u;
const PATH_LIST_KEY = /^(?:paths|files|textFiles)$|(?:Paths|Files)$/u;

/** Whether a result returns file paths the agent is expected to use. `[OUT:REQ-030]` */
export function returnsAgentPaths(result) {
  const visit = (node, top) => {
    if (Array.isArray(node)) return node.some((child) => visit(child, false));
    if (!node || typeof node !== 'object') return false;
    return Object.entries(node).some(([key, value]) => {
      if (top && (key === 'act' || key === 'repositoryPath')) return false;
      if (typeof value === 'string') return PATH_KEY.test(key) && /[/\\]/u.test(value);
      if (PATH_LIST_KEY.test(key) && Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry)) return true;
      return visit(value, false);
    });
  };
  return visit(result, true);
}

// Sizing stands in for the index the view will name; its numbers are as wide as a real one's.
const INDEX_PLACEHOLDER = Object.freeze({ path: `${'x'.repeat(240)}.omitted.json`, bytes: 9_999_999, lines: 9_999_999,
  read: Array.from({ length: READ_PLAN_CHUNKS }, () => ({ lines: [9_999_999, 9_999_999], bytes: 9_999_999 })) });

/** The omitted fields a view names: all of them, or the first few with their count and the index of every one. */
function omittedList(references, index) {
  return references.length > OMITTED_FIELDS_SHOWN
    ? { omittedFields: references.slice(0, OMITTED_FIELDS_SHOWN), omittedFieldCount: references.length, omittedIndex: index }
    : { omittedFields: references };
}

/**
 * The bounded fallback (§5.3) when no repository can be found to keep the full result: the view
 * still fits, keeps what it can, and names the fields it does not show instead of printing them all.
 * `[OUT:REQ-014]`
 */
function unretainedView(act, ordered, budget, agentJson, unkept = null) {
  const keys = Object.keys(ordered).filter((key) => key !== 'act');
  const size = Object.fromEntries(keys.map((key) => [key, bytes(JSON.stringify(ordered[key]) ?? 'null')]));
  const reads = new Set((act?.read ?? []).map((field) => String(field).split('.')[0]));
  const agentOutput = { complete: false, retained: false, state: 'detail-unavailable', bytes: bytes(agentJson(ordered)),
    ...(unkept ? { writeError: errorCode(unkept), instruction: UNKEPT_RESULT }
      : { instruction: 'No repository was found from here to keep the full result; the omitted fields are not shown. Run the command from the Story checkout to read them.' }) };
  const render = (kept) => agentJson({ ...(act ? { act: { ...act, complete: false } } : {}), agentOutput,
    ...omittedList(keys.filter((key) => !kept.has(key)).map((key) => ({ field: key, bytes: size[key] })), null),
    ...Object.fromEntries(keys.filter((key) => kept.has(key)).map((key) => [key, ordered[key]])) });
  const kept = new Set(keys);
  // The fields act reads stay longest; otherwise the largest go first.
  const order = (left, right) => Number(reads.has(left)) - Number(reads.has(right)) || size[right] - size[left];
  while (bytes(render(kept)) > budget && kept.size) kept.delete([...kept].sort(order)[0]);
  const rendered = render(kept);
  if (bytes(rendered) <= budget) return `${rendered}\n`;
  // Nothing else fits: what is missing, by name and count only.
  return `${agentJson({ act: { state: act?.state ?? 'read', said: null, do: null, complete: false }, agentOutput, omittedFieldCount: keys.length })}\n`;
}

/** The lines of `text` that fit `limit` bytes, whole lines only. */
function headLines(text, limit) {
  let shown = '';
  for (const line of text.split('\n')) {
    if (bytes(shown) + bytes(line) + 1 > limit) break;
    shown += `${line}\n`;
  }
  return shown;
}

/**
 * Output that is not one JSON object (malformed JSON, an array) and does not fit: the bounded literal
 * envelope. The text is kept whole in a file named with its read plan, and a preview of its first
 * lines stays in view; without a repository to keep it in, the envelope says what is not shown.
 * `[OUT:REQ-014]`
 */
async function literalEnvelope(text, { cwd, budget, now, literal, unkept = null }) {
  const { agentJson } = await import('./agent-packet-presentation.mjs');
  const target = unkept ? null : repositoryOf({}, cwd);
  const said = literal === 'json-array' ? 'The command returned a JSON array, not one result object.' : 'The command returned text that is not one JSON object.';
  let agentOutput;
  if (target) {
    await readyFolder(target);
    const file = path.join(target.directory, `${resultBase('literal', text)}.txt`);
    await writeAtomic(file, text, { mode: 0o600 });
    await registerReadFiles(target.root, [file]);
    await prune(target.directory, path.basename(file, '.txt'), now);
    const relative = path.relative(target.root, file).split(path.sep).join('/');
    agentOutput = { complete: false, literal, path: file, relativePath: relative, bytes: bytes(text), lines: text.split('\n').length - 1,
      sha256: sha256(text), read: lineRanges(text), instruction: 'Literal output kept whole: request every agentOutput.read line range together in one response; nothing was truncated.' };
  } else {
    agentOutput = { complete: false, literal, retained: false, state: 'detail-unavailable', bytes: bytes(text),
      ...(unkept ? { writeError: errorCode(unkept), instruction: UNKEPT_LITERAL }
        : { instruction: 'No repository was found from here to keep this output; only the preview is shown. Run the command from the Story checkout to read all of it.' }) };
  }
  const envelope = (preview) => agentJson({ act: { state: 'read', said, do: null, complete: false }, agentOutput, preview });
  const reserve = bytes(envelope('')) + 16;
  return `${envelope(headLines(text, Math.max(0, Math.min(PREVIEW_BYTES, budget - reserve))))}\n`;
}

/**
 * The agent view of one command's JSON stdout. Small results keep every field, with `act` first;
 * larger ones are written whole and stdout keeps what fits. Other text that fits is returned
 * unchanged; larger text gets the literal envelope.
 *
 * The command has already run when its result is shown, so a result that cannot be written (a
 * full disk, a file another program holds open on Windows, a read-only checkout or exclude file)
 * never turns into a refusal: a command that committed would read as refused and be run again.
 * The view then keeps what fits, names what it does not show, and stderr says why.
 */
export async function boundedAgentOutput(text, options = {}) {
  try { return await keptAgentOutput(text, options); }
  catch (error) {
    warnUnkept(error);
    const budget = options.budget ?? agentOutputBudget();
    let result = null;
    try { result = JSON.parse(text); } catch { /* shown as literal text */ }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return bytes(text) <= budget ? text : literalEnvelope(text, { budget, literal: Array.isArray(result) ? 'json-array' : 'not-json', unkept: error });
    }
    const { agentJson } = await import('./agent-packet-presentation.mjs');
    const act = result.act ?? agentAct(result);
    const rest = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'act'));
    return unretainedView(act, act ? { act, ...rest } : result, budget, agentJson, error);
  }
}

const UNKEPT_RESULT = 'The full result could not be written here; the omitted fields are not shown. The command ran: never run it again to read them.';
const UNKEPT_LITERAL = 'This output could not be written here; only the preview is shown. The command ran: never run it again to read the rest.';
const errorCode = (error) => String(error?.code ?? error?.name ?? 'Error');
const warnUnkept = (error) => console.error(`Warning: the full result could not be written (${errorCode(error)}: ${oneLine(error?.message, 200)}); `
  + 'the command\'s effects stand and the view shows what fits.');

async function keptAgentOutput(text, { cwd = process.cwd(), budget = agentOutputBudget(), now = new Date() } = {}) {
  let result;
  let literal = null;
  try { result = JSON.parse(text); } catch { literal = 'not-json'; }
  if (!literal && (!result || typeof result !== 'object' || Array.isArray(result))) literal = Array.isArray(result) ? 'json-array' : 'not-json';
  if (literal) return bytes(text) <= budget ? text : literalEnvelope(text, { cwd, budget, now, literal });
  const { agentJson } = await import('./agent-packet-presentation.mjs');
  // The repository is resolved only when it is needed (a counted result or one to write), so the
  // small reads every skill turn makes cost no extra Git process.
  let located;
  const locate = () => (located ??= repositoryOf(result, cwd) ?? false) || null;
  const derived = result.act ?? agentAct(result);
  // A kept result read again (`result last`) is the same action, never a repeat of it.
  const counted = derived && !result.keptResult && !UNCOUNTED_STATES.has(derived.state) && (derived.do || derived.ask);
  const observed = counted && locate() ? observeAgentLoop(locate().root, result, derived, { now: now.getTime() }) : derived;
  // Name the path rule in the mandatory first field, never an omitted long instruction or catalog
  // body, and only where the view returns paths to use: its own fields, or the file a bounded view
  // writes. Presentation only: no new filesystem/Git lookup, path rewriting or permission.
  const rest = Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'act'));
  const presented = async (paths) => {
    const act = observed && !result.paused && paths ? { ...observed, paths: CLI_PATH_REFERENCE } : observed;
    const ordered = await withAgentRoutes(act ? { act, ...rest } : result);
    return { act, ordered, whole: agentJson(ordered) };
  };
  let { act, ordered, whole } = await presented(returnsAgentPaths(result));
  const { catalogAgentView } = await import('./agent-catalog-presentation.mjs');
  let catalog = catalogAgentView(ordered);
  // JSON packet lines are not source citation lines. Keep exact bytes once in a native-readable
  // file even for short review sources, rather than duplicating them as numbered prompt text.
  const reviewSources = ['source-review-agent-context', 'source-review-context'].includes(result.resultType)
    && result.canReview && Array.isArray(result.sources) && result.sources.length > 0;
  if ((!catalog && !reviewSources && bytes(whole) <= budget) || (!locate() && bytes(whole) <= budget)) return `${whole}\n`;
  if (!locate()) return unretainedView(act, ordered, budget, agentJson);
  // A bounded view returns the file it wrote, so it names the rule too.
  if (act && !act.paths && !result.paused) {
    ({ act, ordered, whole } = await presented(true));
    catalog = catalogAgentView(ordered);
  }
  const target = locate();
  await readyFolder(target);
  const base = resultBase(String(result.resultType ?? (result.error ? 'refusal' : 'result')), whole);
  const texts = [];
  const full = await externalize(ordered, target.directory, base, [], texts, reviewSources);
  const file = path.join(target.directory, `${base}.json`);
  const relative = path.relative(target.root, file);
  const write = async (value) => {
    const fullText = `${JSON.stringify(value, null, 2)}\n`;
    await writeAtomic(file, fullText, { mode: 0o600 });
    await registerReadFiles(target.root, [file, ...texts.map(entry => entry.textFile)]);
    await prune(target.directory, base, now);
    return fullText;
  };
  const describe = (fullText, instruction) => ({ complete: false, path: file,
    ...(relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? { relativePath: relative.split(path.sep).join('/') } : {}),
    bytes: bytes(fullText), lines: fullText.split('\n').length - 1, sha256: sha256(fullText), instruction });
  // Each instruction is one sentence under 200 bytes; the skills' output contract states the rule in
  // full (COMPLETE_OUTPUT_CONTRACT in scripts/skill-policy.mjs). `[OUT:REQ-031]`
  const catalogInstruction = 'Metadata-only catalog: read a selected detailField from this retained result (long texts have their own files); no definition was discarded, and a summary never replaces a selected body.';
  if (catalog) {
    const agentOutput = describe(await write(full), catalogInstruction);
    // Prefer every identity to a richer partial list: a list-names task must not expand the
    // complete catalog just because descriptions and attachment detail used the inline budget.
    for (const [limit, identityOnly] of [[20, false], [20, true], [10, true], [5, true], [1, true]]) {
      const view = { ...catalogAgentView(ordered, limit, { identityOnly }), agentOutput };
      const rendered = agentJson(view);
      if (bytes(rendered) <= budget) return `${rendered}\n`;
    }
  }
  const instruction = catalog ? catalogInstruction : 'Bounded result: request every agentOutput.read line range (1-based, inclusive) and every omittedFields textFiles path, by its read ranges when given, together in one response; nothing was truncated.';
  const keys = Object.keys(ordered).filter((key) => key !== 'act');
  const size = Object.fromEntries(keys.map((key) => [key, bytes(JSON.stringify(ordered[key]) ?? 'null')]));
  const textFiles = Object.fromEntries(keys.map((key) => [key, texts.filter((entry) => entry.field === key || entry.field.startsWith(`${key}.`))
    .map(({ field, textFile, bytes: length, lines }) => ({ field, path: textFile, bytes: length, lines,
      ...(length > READ_CHUNK_BYTES ? { read: lineRanges(readFileSync(textFile, 'utf8')) } : {}) }))]));
  const reference = (ranges) => Object.fromEntries(keys.map((key) => [key,
    { field: key, bytes: size[key], lines: ranges[key] ?? null, ...(textFiles[key].length ? { textFiles: textFiles[key] } : {}) }]));
  const render = (kept, agentOutput, references, order = keys, values = ordered, index = null) => agentJson({ act: { ...(act ?? {}), complete: false }, agentOutput,
    ...omittedList(order.filter((key) => !kept.has(key)).map((key) => references[key]), index ?? INDEX_PLACEHOLDER),
    ...Object.fromEntries(keys.filter((key) => kept.has(key)).map((key) => [key, values[key]])) });
  // Keep every field without a long text, then move fields out until the view fits: larger ones
  // before small ones, and within each, the material before the packet's read order before what
  // `act` itself reads. Ids, status and the fields `act` names stay longest.
  const top = (fields) => new Set((fields ?? []).map((field) => String(field).split('.')[0]));
  const actReads = top(act?.read), readOrder = top([...(result.agentGuide ? ['agentGuide'] : []), ...(result.agentGuide?.readOrder ?? [])]);
  const tier = (key) => actReads.has(key) ? 0 : readOrder.has(key) ? 1 : 2;
  const removalOrder = (left, right) => (size[right] > SMALL_FIELD_BYTES) - (size[left] > SMALL_FIELD_BYTES)
    || tier(right) - tier(left) || size[right] - size[left];
  const kept = new Set(keys.filter((key) => textFiles[key].length === 0 && (size[key] <= FIELD_BYTES || tier(key) < 2)));
  // What stays is decided first, against the widest numbers the file can produce: reordering its
  // top-level fields changes neither its bytes nor its lines, so the final view never grows.
  // The file keeps the command's own field order as its last entry, outside every read range, so
  // completeAgentResult() returns the result exactly as the command produced it.
  const fieldOrder = Object.keys(full);
  const wholeText = `${JSON.stringify({ ...full, [FIELD_ORDER]: fieldOrder }, null, 2)}\n`;
  // A text moved to a reference file adds at most six lines (its object) and saves bytes.
  const widest = wholeText.split('\n').length - 1 + 6 * longStrings(full, [], DUPLICATE_TEXT_BYTES).length + texts.length;
  // A text file already written gains only its reason when it becomes a reference.
  const provisional = { ...describe(wholeText, instruction), lines: widest, bytes: bytes(wholeText) + 200 * texts.length,
    read: Array.from({ length: READ_PLAN_CHUNKS }, () => ({ lines: [widest, widest], bytes: 9_999_999 })) };
  const provisionalReferences = reference(Object.fromEntries(keys.map((key) => [key, [widest, widest]])));
  while (bytes(render(kept, provisional, provisionalReferences)) > budget && kept.size) kept.delete([...kept].sort(removalOrder)[0]);
  // The fields left out come first in the file, in the order they are read, so a few ranges hold them.
  const omitted = keys.filter((key) => !kept.has(key))
    .map((key, index) => ({ key, index })).sort((left, right) => tier(left.key) - tier(right.key) || left.index - right.index).map(({ key }) => key);
  // What the agent already sees: act and the fields kept in the view.
  const seen = longStrings({ act: ordered.act, ...Object.fromEntries([...kept].map((key) => [key, ordered[key]])) }, [], DUPLICATE_TEXT_BYTES)
    .filter(({ trail }) => !reviewDocumentBody(trail));
  const { fields, references } = await referenceTexts(full, ordered, omitted, [...kept], seen, { directory: target.directory, base, texts });
  for (const key of omitted) textFiles[key] = textFiles[key].filter((entry) => !references.has(entry.path));
  const fileOrder = [...omitted, ...Object.keys(fields).filter((key) => !omitted.includes(key))];
  const fullText = await write({ ...Object.fromEntries(fileOrder.map((key) => [key, fields[key]])), [FIELD_ORDER]: fieldOrder });
  const ranges = topLevelRanges(fullText);
  const read = readPlan(fullText, ranges, omitted);
  const agentOutput = { ...describe(fullText, instruction), ...(read.length ? { read } : {}) };
  const placed = reference(ranges);
  let index = null;
  if (omitted.length > OMITTED_FIELDS_SHOWN) {
    // Every omitted field's reference, in a file of its own the agent pages through when it needs one.
    const indexText = `${JSON.stringify(omitted.map((key) => placed[key]), null, 2)}\n`;
    const indexFile = path.join(target.directory, `${base}.omitted.json`);
    await writeAtomic(indexFile, indexText, { mode: 0o600 });
    await registerReadFiles(target.root, [indexFile]);
    index = { path: indexFile, bytes: bytes(indexText), lines: indexText.split('\n').length - 1,
      ...(bytes(indexText) > READ_CHUNK_BYTES ? { read: lineRanges(indexText) } : {}) };
  }
  return `${render(kept, agentOutput, placed, omitted, fields, index)}\n`;
}

/**
 * Text an agent reads: whole when it fits; otherwise the lines that fit and the file, inside the
 * repository, that holds all of it. Copilot saves a larger result outside the workspace instead.
 */
export async function boundedAgentText(text, { cwd = process.cwd(), budget = agentOutputBudget(), now = new Date(), kind = 'text' } = {}) {
  if (bytes(text) <= budget) return text;
  const target = repositoryOf({}, cwd);
  let unkept = null;
  if (target) {
    // As with a JSON result, text that cannot be written is never a refusal of a command that ran.
    try { return await keptAgentText(text, target, { budget, now, kind }); }
    catch (error) { unkept = error; warnUnkept(error); }
  }
  // The bounded fallback: the start that fits, and what could not be kept. `[OUT:REQ-014]`
  const total = text.split('\n').length;
  const why = unkept ? 'The rest could not be written here; the command ran: never run it again to read the rest.'
    : 'No repository was found from here to keep the rest; run the command from the Story checkout to read all of it.';
  const footer = (shown) => `\n[Output not kept] Lines 1-${shown} of ${total} are above. ${why}\n`;
  const head = headLines(text, Math.max(0, budget - bytes(footer(total))));
  return `${head}${footer(head ? head.split('\n').length - 1 : 0)}`;
}

async function keptAgentText(text, target, { budget, now, kind }) {
  await readyFolder(target);
  const file = path.join(target.directory, `${resultBase(kind || 'text', text)}.txt`);
  await writeAtomic(file, text, { mode: 0o600 });
  await registerReadFiles(target.root, [file]);
  await prune(target.directory, path.basename(file, '.txt'), now);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const relative = path.relative(target.root, file).split(path.sep).join('/');
  const footer = (shown) => `\n[Output continues] Lines 1-${shown} of ${lines.length} are above. The complete output is `
    + `${file} (${relative}); use that exact absolute path, never prefix it with the checkout. Read lines ${shown + 1}-${lines.length} there with your file-reading tool, not shell tools. `
    + 'Nothing was truncated.\n';
  const reserve = bytes(footer(lines.length));
  let shown = 0;
  let size = 0;
  while (shown < lines.length && size + bytes(lines[shown]) + 1 + reserve <= budget) size += bytes(lines[shown++]) + 1;
  return `${lines.slice(0, shown).join('\n')}${shown ? '\n' : ''}${footer(shown)}`;
}

const isTextReference = (value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.textFile === 'string'
  && Object.keys(value).every((key) => ['textFile', 'bytes', 'lines', 'sha256', 'referenceOf'].includes(key));

/** The complete result behind a bounded view, with every long text read back; any other result as is. */
export function completeAgentResult(output) {
  const view = typeof output === 'string' ? JSON.parse(output) : output;
  if (view?.agentOutput?.complete !== false || typeof view.agentOutput.path !== 'string') return view;
  const inline = (value) => isTextReference(value) ? readFileSync(value.textFile, 'utf8')
    : Array.isArray(value) ? value.map(inline)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)])) : value;
  const { [FIELD_ORDER]: order, ...stored } = JSON.parse(readFileSync(view.agentOutput.path, 'utf8'));
  const keys = Array.isArray(order) ? [...order.filter((key) => Object.hasOwn(stored, key)), ...Object.keys(stored).filter((key) => !order.includes(key))] : Object.keys(stored);
  return inline(Object.fromEntries(keys.map((key) => [key, stored[key]])));
}
