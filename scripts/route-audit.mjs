/**
 * What really happens after a refusal, from the host's own session logs. A development tool: offline
 * and read-only, and nothing in the product imports it (SPEC-OUT CON-015, like native-copilot-audit).
 *
 *   node scripts/route-audit.mjs --sessions <COPILOT-SESSION-STATE-DIR> [--since YYYY-MM-DD] [--json]
 *
 * For each refusal it finds the code, the route offered, and what came next: whether the turn went on
 * and an SFlow command worked, whether the same code came back, whether the turn ended there, and
 * whether the next session on the same checkout ran on another surface. The output is aggregates
 * only: product codes, command words from the command registry, and counts. No command argument,
 * path, prompt, reply, reason or session ID leaves this script.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const CODE = /^[A-Z][A-Z0-9_]{3,}$/u;
const GUARD_PREFIX = 'Denied by preToolUse hook: ';
const SFLOW_COMMAND = /(?:^|[\s;&|("'`/])(?:singularity-flow|sflow)(?:\.cmd|\.exe|\.ps1)?['"]?\s+[a-z]/iu;

// A guard refusal in prose has no code; each is named for the sentence that opens it.
const PROSE_GUARD = Object.freeze([
  [/^Select and synchronize a Singularity Flow work/u, 'GUARD_PROSE_SELECT_WORK'],
  [/^Select a Singularity Flow working lens/u, 'GUARD_PROSE_SELECT_LENS'],
  [/must not discover a repository by searching/u, 'GUARD_PROSE_REPOSITORY_SEARCH'],
  [/session-setup-only turn/u, 'GUARD_PROSE_SESSION_SETUP']
]);

/** The JSON object a command printed, past any progress lines before it. */
export function outputObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.search(/^\s*\{/mu);
  if (start < 0) return null;
  const body = text.slice(start);
  try { return JSON.parse(body); } catch { /* cut short, or text after it */ }
  const end = body.lastIndexOf('}');
  if (end < 0) return null;
  try { return JSON.parse(body.slice(0, end + 1)); } catch { return null; }
}

// A shell that finished in the background reports its exit code only in a trailer on its output.
const exitFailed = (data, content) => (data?.shellExecution?.exitCode ?? 0) !== 0 || data?.success === false
  || /<shellId: \d+ completed with exit code [1-9]\d*>\s*$/u.test(content ?? '');

const firstCommandWord = (command) => {
  const words = String(command ?? '').match(/(?:singularity-flow|sflow)(?:\.cmd|\.exe|\.ps1)?['"]?\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/iu);
  return words ? [words[1], words[2] ?? null] : null;
};

/**
 * A route's shape, never its arguments. `knownWords` holds the command words of the registry, so a
 * Story ID or a path in the same place cannot pass; the second word stays only if the registry knows it.
 */
export function routeShape(route, knownWords = null) {
  if (route?.skill) return /^\/sf(?:low)?-[a-z-]+$/u.test(route.skill) ? route.skill : '/sf-(other)';
  const words = firstCommandWord(route?.shell);
  if (!words) return route?.prose ? '(prose only)' : '(none)';
  const [verb, second] = words;
  if (knownWords && !knownWords.has(verb)) return 'singularity-flow (other)';
  return second && knownWords?.has(`${verb} ${second}`) ? `singularity-flow ${verb} ${second}` : `singularity-flow ${verb}`;
}

// What a route can do from where it stands; the same four words as the static layer in the tests.
const READ_ONLY_VERBS = new Set(['recover', 'status', 'doctor', 'about', 'help', 'explain', 'nextsteps', 'next', 'home',
  'decisions', 'gate', 'advise', 'recommend', 'report', 'show', 'whoami', 'check', 'list', 'view']);
const READ_ONLY_SKILLS = new Set(['/sf-recover', '/sf-status', '/sf-doctor', '/sf-explain', '/sf-next', '/sf-home', '/sf-advise',
  '/sf-report', '/sf-help', '/sf-session', '/sf-workspaces']);
export function routeKind(shape) {
  if (shape === '(none)' || shape === '(prose only)') return 'none';
  if (shape.startsWith('/')) return READ_ONLY_SKILLS.has(shape) ? 'read-only' : 'can-change';
  return READ_ONLY_VERBS.has(shape.split(' ')[1]) ? 'read-only' : 'can-change';
}

function guardRoute(message) {
  const copilot = message.match(/^- Copilot: (\/sf[a-z-]+)/mu)?.[1];
  const shell = message.match(/^- Shell: (singularity-flow [^\n]+)/mu)?.[1];
  if (copilot || shell) return { skill: copilot ?? null, shell: shell ?? null };
  const named = message.match(/(?:^|[\s`])(\/sf-[a-z-]+)/u)?.[1];
  const run = message.match(/(?:Run|run)\s+`?(singularity-flow [a-z][^\n`.;]*)/u)?.[1];
  return named || run ? { skill: named ?? null, shell: run ?? null } : { prose: true };
}

function commandRoute(value) {
  const action = value?.act?.do;
  if (action && (action.copilot || action.shell)) return { skill: action.copilot ?? null, shell: action.shell ?? null };
  const step = value?.remediationPlan?.steps?.find((entry) => entry?.command || entry?.skill);
  if (step) return { skill: step.skill ?? null, shell: step.command ?? null };
  return value?.remediationPlan?.steps?.length ? { prose: true } : {};
}

/** The refusal a completed tool call carries, or null. Takes its code and route; keeps no text. */
export function refusalFromCompletion(data, start = {}) {
  const message = typeof data?.error?.message === 'string' ? data.error.message : '';
  if (message.startsWith(GUARD_PREFIX)) {
    const text = message.slice(GUARD_PREFIX.length);
    const code = text.match(/^([A-Z][A-Z0-9_]{3,})\b/u)?.[1]
      ?? PROSE_GUARD.find(([pattern]) => pattern.test(text))?.[1] ?? 'GUARD_PROSE_OTHER';
    return { kind: 'guard', code, route: guardRoute(text) };
  }
  const command = start?.arguments?.command;
  const isSflow = (typeof command === 'string' && SFLOW_COMMAND.test(command)) || /^sflow_/u.test(start?.toolName ?? '');
  if (!isSflow) return null;
  const content = typeof data?.result?.content === 'string' ? data.result.content : '';
  const value = outputObject(content);
  const failedExit = exitFailed(data, content);
  const state = value?.act?.state;
  const refused = value?.resultType === 'sflow-refusal-plan' || value?.status === 'failed' || state === 'refused' || state === 'repair';
  if (!failedExit && !refused) return null;
  const said = typeof value?.act?.said === 'string' ? value.act.said.match(/^([A-Z][A-Z0-9_]{3,}):/u)?.[1] : null;
  const code = [value?.error?.code, value?.remediationPlan?.code, value?.code, said].find((entry) => CODE.test(String(entry ?? '')))
    ?? content.match(/"code"\s*:\s*"([A-Z][A-Z0-9_]{3,})"/u)?.[1]
    ?? content.match(/(?:^|\n)(?:Error:\s*)?\[?([A-Z][A-Z0-9_]{3,})\]?:\s/u)?.[1];
  if (!code) return failedExit ? { kind: 'command', code: 'NONZERO_EXIT_NO_CODE', route: {} } : null;
  return { kind: 'command', code, route: value ? commandRoute(value) : {} };
}

const surfaceOf = (text) => (/in VS Code\b/u.test(text) ? 'vscode' : /non-interactive mode/u.test(text) ? 'cli-headless'
  : /Copilot CLI|terminal assistant/iu.test(text) ? 'cli' : 'other');

/** One session's tool calls and person turns, in order. Only what the ranking needs is kept. */
export async function readSession(file) {
  const session = { startTime: null, checkout: null, surface: 'unknown', calls: [] };
  const starts = new Map();
  let turn = 0;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Big model snapshots make up most of these logs, and the prefix check skips them unparsed.
    if (!line.startsWith('{"type":"tool.execution_') && !line.startsWith('{"type":"user.message"')
        && !line.startsWith('{"type":"session.start"') && !line.startsWith('{"type":"system.message"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const { type, data } = event;
    if (type === 'session.start') {
      session.startTime = data?.startTime ?? event.timestamp ?? null;
      session.checkout = data?.context?.gitRoot ?? data?.context?.cwd ?? null;
    } else if (type === 'system.message') {
      if (session.surface === 'unknown') session.surface = surfaceOf(String(data?.content ?? '').slice(0, 200));
    } else if (type === 'user.message') {
      turn += 1;
      session.calls.push({ turn, person: true, slash: String(data?.content ?? '').match(/^\s*(\/sf(?:low)?-[a-z-]+)/u)?.[1] ?? null });
    } else if (type === 'tool.execution_start') {
      starts.set(data?.toolCallId, { toolName: data?.toolName, arguments: data?.arguments });
    } else if (type === 'tool.execution_complete') {
      const start = starts.get(data?.toolCallId) ?? {};
      if (start.toolName === 'report_intent') continue;
      const command = start?.arguments?.command;
      const isSflow = (typeof command === 'string' && SFLOW_COMMAND.test(command)) || /^sflow_/u.test(start?.toolName ?? '');
      const refusal = refusalFromCompletion(data, start);
      const content = typeof data?.result?.content === 'string' ? data.result.content : '';
      // A digest in memory tells one call from another; arguments are never kept or printed.
      const callKey = createHash('sha256').update(JSON.stringify([start.toolName, start.arguments ?? null])).digest('hex');
      session.calls.push({ turn, isSflow, refusal, callKey, tool: start.toolName ?? null, sflowWords: isSflow ? firstCommandWord(command) : null,
        ok: !refusal && !exitFailed(data, content) });
    }
  }
  return session;
}

const OUTCOMES = Object.freeze(['advanced', 'otherTools', 'readsOnly', 'looped', 'stopped']);
const emptyRow = () => ({ hits: 0, sessions: new Set(), advanced: 0, otherTools: 0, readsOnly: 0, looped: 0, stopped: 0, recurred: 0, laterTurn: 0,
  routeTaken: 0, routeTakenNoHelp: 0, personNext: new Map(), routes: new Map(), surfaces: new Map(), sessionEnded: 0, surfaceChanged: 0 });

/**
 * What followed one refusal, up to the person's next message.
 * - looped: the very same call was refused again with the same code.
 * - advanced: the refused command itself, or an SFlow command that changes state, then worked.
 * - readsOnly: SFlow commands worked after it, but only ones that read and change nothing.
 * - otherTools: other tools worked and no SFlow command did, so the logs cannot say it helped.
 * - stopped: nothing worked after it, so the turn ended on the refusal.
 * `recurred` says the same code came back for a different call; `routeTaken` that the route was used.
 */
export function classifyAftermath(calls, index, route, { isMutation = () => false } = {}) {
  const here = calls[index];
  const routeVerb = firstCommandWord(route?.shell)?.[0] ?? null;
  const refusedWords = here.sflowWords?.join(' ') ?? null;
  let sameCall = false; let recurred = false; let advanced = false; let readWorked = false; let anyOk = false;
  let routeTaken = false; let personNext = null; let sessionEnded = true;
  for (let at = index + 1; at < calls.length; at += 1) {
    const call = calls[at];
    if (call.person) { personNext = call.slash ?? '(typed)'; sessionEnded = false; break; }
    if (call.refusal?.code === here.refusal.code) {
      if (call.callKey === here.callKey) sameCall = true; else recurred = true;
    }
    if (routeVerb && call.sflowWords?.[0] === routeVerb) routeTaken = true;
    if (!call.ok) continue;
    anyOk = true;
    if (!call.isSflow) continue;
    if (isMutation(call.sflowWords) || (refusedWords && call.sflowWords?.join(' ') === refusedWords)) advanced = true;
    else readWorked = true;
  }
  if (route?.skill && personNext === route.skill) routeTaken = true;
  const outcome = sameCall ? 'looped' : advanced ? 'advanced' : readWorked ? 'readsOnly' : anyOk ? 'otherTools' : 'stopped';
  return { outcome, recurred, routeTaken, personNext, sessionEnded };
}

export function buildReport(sessions, { since = null, knownWords = null, isMutation = () => false } = {}) {
  const rows = new Map();
  const counted = since ? sessions.filter((entry) => String(entry.startTime ?? '') >= since) : sessions;
  const byCheckout = new Map();
  for (const session of [...counted].sort((left, right) => String(left.startTime).localeCompare(String(right.startTime)))) {
    if (!byCheckout.has(session.checkout)) byCheckout.set(session.checkout, []);
    byCheckout.get(session.checkout).push(session);
  }
  let refusals = 0; let unparsedExits = 0;
  const surfaces = new Map();
  counted.forEach((session, sessionIndex) => {
    surfaces.set(session.surface, (surfaces.get(session.surface) ?? 0) + 1);
    const peers = byCheckout.get(session.checkout) ?? [];
    const next = peers[peers.indexOf(session) + 1];
    session.calls.forEach((call, index) => {
      if (!call.refusal) return;
      if (call.refusal.code === 'NONZERO_EXIT_NO_CODE') { unparsedExits += 1; return; }
      refusals += 1;
      const shape = routeShape(call.refusal.route, knownWords);
      if (!rows.has(call.refusal.code)) rows.set(call.refusal.code, emptyRow());
      const row = rows.get(call.refusal.code);
      const after = classifyAftermath(session.calls, index, call.refusal.route, { isMutation });
      row.hits += 1; row.sessions.add(sessionIndex); row[after.outcome] += 1;
      if (after.recurred) row.recurred += 1;
      if (after.routeTaken) row.routeTaken += 1;
      if (after.routeTaken && after.outcome !== 'advanced') row.routeTakenNoHelp += 1;
      row.routes.set(shape, (row.routes.get(shape) ?? 0) + 1);
      row.surfaces.set(session.surface, (row.surfaces.get(session.surface) ?? 0) + 1);
      if (after.personNext) row.personNext.set(after.personNext, (row.personNext.get(after.personNext) ?? 0) + 1);
      // The same code again on a later turn, or in a later session on the same checkout.
      const turnBoundary = session.calls.findIndex((entry, at) => at > index && entry.person);
      const laterHere = turnBoundary >= 0 && session.calls.slice(turnBoundary).some((entry) => entry.refusal?.code === call.refusal.code);
      if (laterHere || next?.calls.some((entry) => entry.refusal?.code === call.refusal.code)) row.laterTurn += 1;
      if (after.sessionEnded) {
        row.sessionEnded += 1;
        if (next && !['other', 'unknown'].includes(next.surface) && next.surface !== session.surface) row.surfaceChanged += 1;
      }
    });
  });
  const sessionsWithRefusal = new Set();
  const table = [...rows].map(([code, row]) => {
    for (const entry of row.sessions) sessionsWithRefusal.add(entry);
    const routes = [...row.routes].sort((left, right) => right[1] - left[1]);
    const top = routes[0]?.[0] ?? '(none)';
    return { code, hits: row.hits, sessions: row.sessions.size,
      ...Object.fromEntries(OUTCOMES.map((name) => [name, row[name]])),
      deadEndHits: row.looped + row.stopped + row.readsOnly, recurred: row.recurred, laterTurn: row.laterTurn,
      routeTaken: row.routeTaken, routeTakenNoHelp: row.routeTakenNoHelp, sessionEnded: row.sessionEnded, surfaceChanged: row.surfaceChanged,
      topRoute: top, topRouteKind: routeKind(top),
      surfaces: Object.fromEntries(row.surfaces),
      personNext: [...row.personNext].sort((left, right) => right[1] - left[1]).slice(0, 3) };
  }).sort((left, right) => right.deadEndHits - left.deadEndHits || right.hits - left.hits || left.code.localeCompare(right.code));
  return { sessions: counted.length, surfaces: Object.fromEntries(surfaces), sessionsWithRefusal: sessionsWithRefusal.size, refusals, unparsedExits, table };
}

export function renderReport(report, heading) {
  const lines = [`### ${heading}`, '', `${report.sessions} sessions (${Object.entries(report.surfaces).map(([name, count]) => `${name} ${count}`).join(', ')}), `
    + `${report.sessionsWithRefusal} with a refusal; ${report.refusals} refusals; ${report.unparsedExits} other failed SFlow commands with no code the script could read.`, '',
  '| Code | Hits | Sessions | Dead-end hits | Same call again | Stopped | Reads only | Advanced | Other tools | Same code, other call | Same code, later turn | Route taken | Route taken, no help | Session ended | Surface changed | Top route | Kind | Person next |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|'];
  for (const row of report.table) {
    lines.push(`| ${row.code} | ${row.hits} | ${row.sessions} | ${row.deadEndHits} | ${row.looped} | ${row.stopped} | ${row.readsOnly} | ${row.advanced} | ${row.otherTools} | ${row.recurred} | ${row.laterTurn} | ${row.routeTaken} | ${row.routeTakenNoHelp} | ${row.sessionEnded} | ${row.surfaceChanged} | ${row.topRoute} | ${row.topRouteKind} | ${row.personNext.map(([name, count]) => `${name} ${count}`).join(', ')} |`);
  }
  return lines.join('\n');
}

async function registryWords() {
  const { COMMAND_REGISTRY } = await import('../src/command-registry.mjs');
  const words = new Set();
  for (const entry of COMMAND_REGISTRY) {
    words.add(entry.name); for (const alias of entry.aliases ?? []) words.add(alias);
    const parts = String(entry.operation?.id ?? '').split('.');
    if (parts.length > 1) words.add(`${entry.name} ${parts[1]}`);
  }
  return words;
}

async function main(argv) {
  const usage = 'Use --sessions <COPILOT-SESSION-STATE-DIR> [--since YYYY-MM-DD] [--json].';
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') { options.json = true; continue; }
    if (!['--sessions', '--since'].includes(argv[index]) || !argv[index + 1]) throw new Error(usage);
    options[argv[index].slice(2)] = argv[++index];
  }
  if (!options.sessions) throw new Error(usage);
  const root = path.resolve(options.sessions);
  const sessions = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name, 'events.jsonl');
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    sessions.push(await readSession(file));
  }
  const knownWords = await registryWords();
  const { resolveOperation } = await import('../src/command-registry.mjs');
  // The registry says which commands change state; a verb it does not know counts as a read.
  const isMutation = (words) => {
    if (!words?.[0]) return false;
    try { return resolveOperation({ requestedCommand: words[0], positionals: words.filter(Boolean), options: {} }).classification !== 'read'; } catch { return false; }
  };
  const report = buildReport(sessions, { since: options.since ?? null, knownWords, isMutation });
  if (options.json) console.log(JSON.stringify(report, null, 1));
  else console.log(renderReport(report, options.since ? `Since ${options.since}` : 'All sessions'));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
