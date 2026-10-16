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
 * than the budget, the complete result is written inside the repository's Git directory (agents
 * already edit staging files there), long texts as their own line-readable files, and stdout keeps
 * `act`, the fields that fit and the exact line range of every field it left out.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { observeFindingStreak } from './finding-escalation.mjs';
import { gitDir } from './git-execution.mjs';
import { safeCommandGuidance, validateSafeSflowCommand } from './safe-command-guidance.mjs';
import { validateAgentEntryRequest } from './agent-entry-options.mjs';
import { interpretsForAgent } from './cli-json-output.mjs';
import { parseArgs, writeAtomic } from './util.mjs';

// Copilot CLI shows a shell result inline only below 8,192 characters. From there it saves the result
// outside the workspace, shows its first 500 characters and suggests rg/head/tail/jq on that file,
// which a session turn may not run. Measured over 9,519 recorded shell results (Copilot 1.0.92 to
// 1.0.95, 2026-10-16): the largest inline was 8,191 characters, the smallest saved 8.0 KB. A 16 KB
// view was therefore still saved. 7,500 bytes leaves room for the stderr lines in the same result.
export const DEFAULT_AGENT_OUTPUT_BYTES = 7_500;
export const LOOP_THRESHOLD = 3;
const LOOP_WINDOW_MS = 2 * 60 * 60 * 1000;
const UNCOUNTED_STATES = new Set(['author', 'read', 'paused']);
const LARGE_TEXT_BYTES = 4_000;
const FIELD_BYTES = 6_000;
const SMALL_FIELD_BYTES = 300;
const KEPT_RESULTS = 40;
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
    && !(globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH > 0);
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

const firstNow = (actions) => Array.isArray(actions)
  ? actions.find((action) => action && typeof action === 'object' && (action.timing == null || ['now', 'blocked'].includes(action.timing))) ?? null
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
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.paused === true) return { state: 'paused', said: 'SFlow is paused for this conversation; answer as native Copilot and offer only /sf-pause off.', do: null };
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
          phase: open.phase ?? result.session?.phase ?? null, localOnly: result.localOnly ?? null },
        ...(next.length ? { next } : {}), read: ['nextsteps', 'context'],
        said: 'The exact session is attached and verified. Report story, relay its next actions in order and end the session-only turn; do not repeat context or nextsteps lookups.' };
    }
  }
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
    if (result.status === 'authoring-entry') return { state: 'author', do: null, read: ['mutationContract', 'authoringProgress', 'context'],
      said: `Authoring ${result.phase ?? 'this step'} is admitted: do this step's own drafting now, inside mutationContract. It is not a next action to relay.` };
    if (result.status === 'clarification-required') return { state: 'ask-person', do: null, read: ['clarification', 'context'],
      said: oneLine(`Ask the unanswered questions now, as clarification.checkpoint says${result.context ? '' : ' after composing the context once'}; this is this skill's own step.`) };
    return withRoute({ state: 'next', said: oneLine(result.reason ?? `Phase entry status: ${result.status}.`), do: null }, firstNow(result.next));
  }
  if (result.resultType === 'sflow-phase-prepublish') {
    if (result.repairLoop?.status === 'escalate') return { state: 'escalate', do: null,
      said: oneLine(result.repairLoop.instruction ?? 'The same finding keeps returning; stop repairing and hand it on.') };
    if (result.status === 'ready' && result.commands?.publish) return withRoute({ state: 'publish', do: null,
      said: 'Ready: publish once with the returned command; it runs the required tests.' },
      { command: result.commands.publish, ...(result.commandGuidance?.publish ? { commandGuidance: result.commandGuidance.publish } : {}), reason: 'Publish this draft.' });
    const count = Array.isArray(result.findings) ? result.findings.length : null;
    return { state: 'correct', do: null, read: ['findings', 'correction', 'traceabilityRepair', 'repairLoop'],
      said: oneLine(`${result.status}${count == null ? '' : ` with ${count} finding${count === 1 ? '' : 's'}`}: ${result.correction?.guidance ?? 'fix the listed findings in this draft, then recheck once.'}`),
      ...correctionList(result.findings) };
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
async function externalize(value, directory, base, trail, written) {
  if (typeof value === 'string' && bytes(value) > LARGE_TEXT_BYTES) {
    const file = path.join(directory, `${base}.${trail.join('.').replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80)}.txt`);
    await writeAtomic(file, value, { mode: 0o600 });
    const entry = { textFile: file, bytes: bytes(value), lines: value.split('\n').length, sha256: sha256(value) };
    written.push({ field: trail.join('.'), ...entry });
    return entry;
  }
  if (Array.isArray(value)) return Promise.all(value.map((child, index) => externalize(child, directory, base, [...trail, String(index)], written)));
  if (!value || typeof value !== 'object') return value;
  const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => [key, await externalize(child, directory, base, [...trail, key], written)]));
  return Object.fromEntries(entries);
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

async function prune(directory) {
  try {
    const names = (await readdir(directory)).filter((name) => /\.(?:json|txt)$/u.test(name));
    const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(directory, name))).mtimeMs })));
    const stale = dated.sort((left, right) => right.at - left.at).slice(KEPT_RESULTS * 4);
    await Promise.all(stale.map(({ name }) => rm(path.join(directory, name), { force: true })));
  } catch { /* retention is best effort */ }
}

function repositoryOf(result, cwd) {
  const candidate = typeof result.repositoryPath === 'string' && path.isAbsolute(result.repositoryPath) ? result.repositoryPath : cwd;
  // Real paths on both sides, so a relative path survives /tmp → /private/tmp and similar links.
  try { return { root: realpathSync(candidate), directory: path.join(realpathSync(gitDir(candidate)), 'singularity-flow', 'agent-results') }; }
  catch { return null; }
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
    return next;
  };
  return walk(value);
}

/**
 * The agent view of one command's JSON stdout. Small results keep every field, with `act` first;
 * larger ones are written whole and stdout keeps what fits. Text that is not one JSON object is
 * returned unchanged.
 */
export async function boundedAgentOutput(text, { cwd = process.cwd(), budget = agentOutputBudget(), now = new Date() } = {}) {
  let result;
  try { result = JSON.parse(text); } catch { return text; }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return text;
  const { agentJson } = await import('./agent-packet-presentation.mjs');
  // The repository is resolved only when it is needed (a counted result or one to write), so the
  // small reads every skill turn makes cost no extra Git process.
  let located;
  const locate = () => (located ??= repositoryOf(result, cwd) ?? false) || null;
  const derived = result.act ?? agentAct(result);
  const counted = derived && !UNCOUNTED_STATES.has(derived.state) && (derived.do || derived.ask);
  const act = counted && locate() ? observeAgentLoop(locate().root, result, derived, { now: now.getTime() }) : derived;
  const ordered = await withAgentRoutes(act ? { act, ...Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'act')) } : result);
  const whole = agentJson(ordered);
  if (bytes(whole) <= budget || !locate()) return `${whole}\n`;
  const target = locate();
  const kind = String(result.resultType ?? (result.error ? 'refusal' : 'result')).replace(/[^A-Za-z0-9-]/gu, '-').slice(0, 48);
  const base = `${kind}-${now.toISOString().replace(/[:.]/gu, '-')}-${sha256(whole).slice(7, 15)}`;
  const texts = [];
  const full = await externalize(ordered, target.directory, base, [], texts);
  const fullText = `${JSON.stringify(full, null, 2)}\n`;
  const file = path.join(target.directory, `${base}.json`);
  await writeAtomic(file, fullText, { mode: 0o600 });
  await prune(target.directory);
  const ranges = topLevelRanges(fullText);
  const relative = path.relative(target.root, file);
  const agentOutput = { complete: false, path: file,
    ...(relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? { relativePath: relative.split(path.sep).join('/') } : {}),
    bytes: bytes(fullText), lines: fullText.split('\n').length - 1, sha256: sha256(fullText),
    instruction: 'A bounded view of a complete result. omittedFields lists each field left out with its exact line range in agentOutput.path, and long texts as their own files; read only the ranges you need with your file-reading tool. Nothing was truncated.' };
  const keys = Object.keys(ordered).filter((key) => key !== 'act');
  const size = Object.fromEntries(keys.map((key) => [key, bytes(JSON.stringify(ordered[key]) ?? 'null')]));
  const reference = Object.fromEntries(keys.map((key) => {
    const textFiles = texts.filter((entry) => entry.field === key || entry.field.startsWith(`${key}.`))
      .map(({ field, textFile, bytes: length, lines }) => ({ field, path: textFile, bytes: length, lines }));
    return [key, { field: key, bytes: size[key], lines: ranges[key] ?? null, ...(textFiles.length ? { textFiles } : {}) }];
  }));
  const render = (kept) => agentJson({ act: { ...(act ?? {}), complete: false }, agentOutput,
    omittedFields: keys.filter((key) => !kept.has(key)).map((key) => reference[key]),
    ...Object.fromEntries(keys.filter((key) => kept.has(key)).map((key) => [key, ordered[key]])) });
  // Keep every field without a long text, then move fields out until the view fits: larger ones
  // before small ones, and within each, the material before the packet's read order before what
  // `act` itself reads. Ids, status and the fields `act` names stay longest.
  const top = (fields) => new Set((fields ?? []).map((field) => String(field).split('.')[0]));
  const actReads = top(act?.read), readOrder = top([...(result.agentGuide ? ['agentGuide'] : []), ...(result.agentGuide?.readOrder ?? [])]);
  const tier = (key) => actReads.has(key) ? 0 : readOrder.has(key) ? 1 : 2;
  const removalOrder = (left, right) => (size[right] > SMALL_FIELD_BYTES) - (size[left] > SMALL_FIELD_BYTES)
    || tier(right) - tier(left) || size[right] - size[left];
  const kept = new Set(keys.filter((key) => !reference[key].textFiles && (size[key] <= FIELD_BYTES || tier(key) < 2)));
  let view = render(kept);
  while (bytes(view) > budget && kept.size) {
    kept.delete([...kept].sort(removalOrder)[0]);
    view = render(kept);
  }
  return `${view}\n`;
}

/**
 * Text an agent reads: whole when it fits; otherwise the lines that fit and the file, inside the
 * repository, that holds all of it. Copilot saves a larger result outside the workspace instead.
 */
export async function boundedAgentText(text, { cwd = process.cwd(), budget = agentOutputBudget(), now = new Date(), kind = 'text' } = {}) {
  if (bytes(text) <= budget) return text;
  const target = repositoryOf({}, cwd);
  if (!target) return text;
  const name = String(kind || 'text').replace(/[^A-Za-z0-9-]/gu, '-').slice(0, 48) || 'text';
  const file = path.join(target.directory, `${name}-${now.toISOString().replace(/[:.]/gu, '-')}-${sha256(text).slice(7, 15)}.txt`);
  await writeAtomic(file, text, { mode: 0o600 });
  await prune(target.directory);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const relative = path.relative(target.root, file).split(path.sep).join('/');
  const footer = (shown) => `\n[Output continues] Lines 1-${shown} of ${lines.length} are above. The complete output is `
    + `${file} (${relative}); read lines ${shown + 1}-${lines.length} there with your file-reading tool, not shell tools. `
    + 'Nothing was truncated.\n';
  const reserve = bytes(footer(lines.length));
  let shown = 0;
  let size = 0;
  while (shown < lines.length && size + bytes(lines[shown]) + 1 + reserve <= budget) size += bytes(lines[shown++]) + 1;
  return `${lines.slice(0, shown).join('\n')}${shown ? '\n' : ''}${footer(shown)}`;
}

const isTextReference = (value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.textFile === 'string'
  && Object.keys(value).every((key) => ['textFile', 'bytes', 'lines', 'sha256'].includes(key));

/** The complete result behind a bounded view, with every long text read back; any other result as is. */
export function completeAgentResult(output) {
  const view = typeof output === 'string' ? JSON.parse(output) : output;
  if (view?.agentOutput?.complete !== false || typeof view.agentOutput.path !== 'string') return view;
  const inline = (value) => isTextReference(value) ? readFileSync(value.textFile, 'utf8')
    : Array.isArray(value) ? value.map(inline)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inline(child)])) : value;
  return inline(JSON.parse(readFileSync(view.agentOutput.path, 'utf8')));
}
