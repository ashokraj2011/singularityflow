import { constants, createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Offline attribution of recorded host sessions (SPEC-OUT v3 M0, §2 and §6.2). It reads Copilot's own
 * session logs read-only and reports counts and identifiers only: no prompt, code, output text,
 * argument string or path leaves it. No work command, hook or skill imports it (CON-015).
 */
export const SESSION_ANALYZER_VERSION = 'sflow-session-attribution/1';
export const CALL_CAUSES = Object.freeze(['user-turn', 'sflow-result', 'sflow-overflow', 'sflow-mixed', 'source-read', 'host-shell', 'host-saved-read', 'other']);
export const RESULT_ROUTES = Object.freeze(['sflow-result', 'sflow-overflow-read', 'source-read', 'search', 'host-shell-test', 'host-shell-other', 'host-saved-read', 'other']);
// What a skill run must record to count as finished; any other SFlow skill needs one SFlow result that was not refused.
export const SKILL_SUCCESS = Object.freeze({ 'sf-phase': ['published', 'submitted'], 'sf-code': ['published', 'submitted'],
  'sf-publish': ['published'], 'sf-submit': ['submitted'], 'sf-approve': ['approved'], 'sf-review-source': ['review-retained'],
  'sf-decide': ['recorded'] });

const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'run_in_terminal', 'execute', 'exec_command']);
const SHELL_FOLLOW_UPS = new Set(['read_bash', 'write_bash', 'stop_bash', 'read_powershell', 'write_powershell', 'stop_powershell', 'get_terminal_output', 'write_stdin']);
const READ_TOOLS = new Set(['view', 'read_file', 'readFile', 'read']);
const SEARCH_TOOLS = new Set(['rg', 'grep', 'glob', 'grep_search', 'file_search', 'semantic_search', 'search', 'find', 'list_dir', 'ls']);
const SFLOW_COMMAND = /(?:^|[\s;&|(`"'/])(?:singularity-flow(?:\.mjs)?|sflow)(?=\s|$)/u;
const SFLOW_VERB = /(?:singularity-flow(?:\.mjs)?|sflow)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/u;
const TEST_RUNNER = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|node\b[^|;&]*\s--test\b|jest\b|vitest\b|mocha\b|pytest\b|playwright\s+test\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b|mvnw?\b[^|;&]*\b(?:test|verify)\b|gradlew?\b[^|;&]*\btest\b|rspec\b|phpunit\b)/u;
const OVERFLOW_PATH = /[^\s'"`]*agent-results[\\/][^\s'"`]+/u;
const OVERFLOW_TYPE = /^([A-Za-z0-9][A-Za-z0-9-]*?)-\d{4}-\d{2}-\d{2}T/u;
const HOST_SAVED_PATH = /copilot-tool-output-/u;
const HOST_SAVED_NOTICE = /^Output too large to read at once \(/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const VERB_MARKS = Object.freeze({ submit: 'submitted', approve: 'approved', 'phase publish': 'published',
  'decisions record': 'recorded', 'decision record': 'recorded' });
const OPERATION_MARKS = Object.freeze({ submit: 'submitted', approve: 'approved', publish: 'published' });

const identifier = (value, fallback = null) => typeof value === 'string' && IDENTIFIER.test(value) ? value : fallback;
const digest = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const bytesOf = (value) => typeof value === 'string' ? Buffer.byteLength(value) : 0;
const count = (row, key, by = 1) => { row[key] = (row[key] ?? 0) + by; };
const skillLabel = (name) => { const value = identifier(name); return value ? value.replace(/^sflow-/u, 'sf-') : null; };
const slashName = (content) => typeof content === 'string' ? content.match(/^\/(?:[\w.-]+:)?([\w.-]+)/u)?.[1] ?? null : null;

function routeOf(name, args) {
  if (SHELL_TOOLS.has(name)) {
    const command = typeof args?.command === 'string' ? args.command : '';
    if (SFLOW_COMMAND.test(command)) {
      const [, first, second] = command.match(SFLOW_VERB) ?? [];
      return { route: 'sflow-result', verb: (second && VERB_MARKS[`${first} ${second}`] ? `${first} ${second}` : first) ?? null };
    }
    const overflow = command.match(OVERFLOW_PATH)?.[0];
    if (overflow) return { route: 'sflow-overflow-read', file: overflow, range: digest(command) };
    if (HOST_SAVED_PATH.test(command)) return { route: 'host-saved-read' };
    return { route: TEST_RUNNER.test(command) ? 'host-shell-test' : 'host-shell-other' };
  }
  if (READ_TOOLS.has(name) || (name === 'str_replace_editor' && args?.command === 'view')) {
    const file = [args?.path, args?.filePath, args?.file_path].find((value) => typeof value === 'string') ?? '';
    if (OVERFLOW_PATH.test(file)) return { route: 'sflow-overflow-read', file,
      range: JSON.stringify(args?.view_range ?? [args?.startLine ?? args?.offset ?? null, args?.endLine ?? args?.limit ?? null]) };
    return { route: HOST_SAVED_PATH.test(file) ? 'host-saved-read' : 'source-read' };
  }
  if (SEARCH_TOOLS.has(name)) return { route: 'search' };
  if (SHELL_FOLLOW_UPS.has(name)) return { route: 'shell-follow-up', shell: String(args?.shellId ?? args?.id ?? '') };
  return { route: 'other' };
}

// The JSON SFlow printed, after any progress lines and before the host's exit suffix.
function sflowJson(content) {
  const start = content.search(/(?:^|\n)\{/u), end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const value = JSON.parse(content.slice(start, end + 1)); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}

function successMarks(result, verb, exitCode) {
  const marks = new Set();
  if (!result) {
    if (exitCode === 0) { marks.add('answered'); if (VERB_MARKS[verb]) marks.add(VERB_MARKS[verb]); }
    return marks;
  }
  if (result.error || result.resultType === 'sflow-refusal-plan' || ['refused', 'escalate'].includes(result.act?.state)) return marks;
  marks.add('answered');
  // A bounded view may have moved publishIfReady/submitIfReady to its file; act.said is SFlow's own first word for them.
  if (result.publishIfReady?.published === true || (result.resultType === 'sflow-phase-prepublish' && result.act?.said === 'Published')) marks.add('published');
  if (result.submitIfReady?.submitted === true || (result.resultType === 'sflow-submission-readiness'
    && (result.act?.said === 'Submitted' || result.reasonCode === 'PHASE_ALREADY_SUBMITTED'))) marks.add('submitted');
  if (result.resultType === 'sflow-approval-agent-result' && result.outcome?.status === 'succeeded') marks.add('approved');
  if (result.resultType === 'source-review-status' && result.status === 'ready') marks.add('review-retained');
  if (result.operation?.classification === 'mutation' && result.outcome?.status === 'succeeded') {
    marks.add('recorded');
    if (OPERATION_MARKS[result.operation.id]) marks.add(OPERATION_MARKS[result.operation.id]);
  }
  return marks;
}

function finishedTask(task) {
  if (!task.skill?.startsWith('sf-')) return null;
  if (!task.sflow) return false;
  return (SKILL_SUCCESS[task.skill] ?? ['answered']).some((mark) => task.marks.has(mark));
}

function causeOf(window) {
  const groups = new Set(window.map((route) => ({ 'sflow-overflow-read': 'sflow-overflow', search: 'source-read',
    'host-shell-test': 'host-shell', 'host-shell-other': 'host-shell' })[route] ?? route));
  if (!groups.size) return 'other';
  if (groups.size === 1) return [...groups][0];
  return [...groups].every((group) => group === 'sflow-result' || group === 'sflow-overflow') ? 'sflow-mixed' : 'other';
}

/** One session's state machine. push() takes each parsed event in log order; finish() returns its summary. */
export function createSessionAttribution(sessionId) {
  const session = { id: identifier(sessionId) ?? digest(sessionId), hostVersion: null, date: null, calls: [], tasks: [], routes: [],
    overflow: new Map(), hooks: { injections: 0, bytes: 0, sizes: [], byHook: {} }, auxiliary: { calls: 0, promptTokens: 0 },
    prefix: { systemPromptBytes: 0, openingSkillBytes: 0, firstUserMessageBytes: null, hookContextBytes: 0 },
    sflow: false, unparsedLines: 0, unmatchedResults: 0 };
  const starts = new Map(), shells = new Map();
  let window = [], userTurn = false, task = null, pendingSkill = null;
  const beforeFirstCall = () => session.calls.length === 0;
  const event = (record) => {
    const type = record?.type, data = record?.data ?? {};
    if (!session.date && typeof record?.timestamp === 'string') session.date = record.timestamp.slice(0, 10);
    if (type === 'session.start') {
      session.hostVersion = identifier(data.copilotVersion, 'other');
      if (typeof data.startTime === 'string') session.date = data.startTime.slice(0, 10);
    } else if (type === 'system.message' && beforeFirstCall()) session.prefix.systemPromptBytes += bytesOf(data.content);
    else if (type === 'skill.invoked' || type === 'skill.invoked_ref') {
      if (beforeFirstCall()) session.prefix.openingSkillBytes += type === 'skill.invoked' ? bytesOf(data.content) : (Number.isSafeInteger(data.contentLength) ? data.contentLength : 0);
      if (data.trigger !== 'user-invoked') return;
      const label = skillLabel(data.name);
      // Older hosts log the skill after the message that invoked it.
      if (task && !task.skill && task.calls === 0 && task.slash && skillLabel(task.slash) === label) task.skill = label;
      else pendingSkill = label;
    } else if (type === 'user.message') {
      if (data.source) return; // skill bodies and system notices the host delivers as messages belong to the current turn
      task = { skill: pendingSkill, slash: slashName(data.content), calls: 0, inputTokens: 0, cacheReadTokens: 0, premiumRequests: 0,
        marks: new Set(), sflow: false };
      session.tasks.push(task); pendingSkill = null; userTurn = true;
      if (session.prefix.firstUserMessageBytes === null) session.prefix.firstUserMessageBytes = bytesOf(data.transformedContent ?? data.content);
    } else if (type === 'hook.end') {
      const context = data.output?.additionalContext;
      if (typeof context !== 'string') return;
      const size = bytesOf(context);
      session.hooks.injections++; session.hooks.bytes += size; session.hooks.sizes.push(size);
      count(session.hooks.byHook, identifier(data.hookType, 'other'));
      if (beforeFirstCall()) session.prefix.hookContextBytes += size;
    } else if (type === 'model.model_call_success') {
      session.auxiliary.calls++;
      if (Number.isSafeInteger(data.responseUsage?.prompt_tokens)) session.auxiliary.promptTokens += data.responseUsage.prompt_tokens;
    } else if (type === 'tool.execution_start') {
      starts.set(data.toolCallId, { name: data.toolName, ...routeOf(data.toolName, data.arguments) });
    } else if (type === 'tool.execution_complete') {
      const start = starts.get(data.toolCallId);
      if (start) starts.delete(data.toolCallId); else session.unmatchedResults++;
      let info = start ?? { route: 'other' };
      if (info.route === 'shell-follow-up') info = shells.get(info.shell) ?? { route: 'host-shell-other' };
      const content = typeof data.result?.content === 'string' ? data.result.content
        : typeof data.error?.message === 'string' ? data.error.message : typeof data.error === 'string' ? data.error : '';
      const shell = content.match(/<shellId: ([^\s>]+)/u)?.[1];
      if (shell && SHELL_TOOLS.has(start?.name)) shells.set(shell, { route: info.route, verb: info.verb ?? null });
      let resultType = null;
      if (info.route === 'sflow-result') {
        session.sflow = true;
        const parsed = sflowJson(content);
        resultType = parsed ? identifier(parsed.resultType, 'json') : 'text';
        if (task) {
          task.sflow = true;
          const exit = Number.isSafeInteger(data.shellExecution?.exitCode) ? data.shellExecution.exitCode
            : Number(content.match(/exit code (\d+)>\s*$/u)?.[1] ?? NaN);
          for (const mark of successMarks(parsed, info.verb, exit)) task.marks.add(mark);
        }
      } else if (info.route === 'sflow-overflow-read') {
        resultType = path.basename(info.file).match(OVERFLOW_TYPE)?.[1] ?? 'unknown';
        const key = digest(info.file), file = session.overflow.get(key) ?? { reads: 0, ranges: {} };
        file.reads++; count(file.ranges, info.range); session.overflow.set(key, file);
      }
      session.routes.push({ route: info.route, bytes: bytesOf(content), savedByHost: HOST_SAVED_NOTICE.test(content), resultType,
        ...(info.route === 'other' ? { tool: identifier(start?.name, 'unknown') } : {}) });
      window.push(info.route);
    } else if (type === 'session.usage_record') {
      const usage = data.usage ?? {};
      const number = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
      if (beforeFirstCall()) Object.assign(session.prefix, { toolDefinitionTokens: number(usage.toolTokenCount), availableTools: number(usage.availableToolCount) });
      const toolWindow = { sflowResults: 0, overflowReads: 0, sourceReads: 0, hostShell: 0, hostSavedReads: 0, other: 0 };
      for (const route of window) {
        const key = { 'sflow-result': 'sflowResults', 'sflow-overflow-read': 'overflowReads', 'source-read': 'sourceReads', search: 'sourceReads',
          'host-shell-test': 'hostShell', 'host-shell-other': 'hostShell', 'host-saved-read': 'hostSavedReads' }[route] ?? 'other';
        toolWindow[key]++;
      }
      const call = { call: session.calls.length + 1, inputTokens: number(usage.inputTokens), cacheReadTokens: number(usage.cacheReadTokens),
        outputTokens: number(usage.outputTokens), model: identifier(usage.model, 'other'),
        premiumRequests: usage.initiator === 'user' ? number(usage.cost) : 0,
        cause: userTurn ? 'user-turn' : causeOf(window), toolWindow, task };
      session.calls.push(call);
      if (task) { task.calls++; task.inputTokens += call.inputTokens; task.cacheReadTokens += call.cacheReadTokens; task.premiumRequests += call.premiumRequests; }
      window = []; userTurn = false;
    }
  };
  return {
    push(line) {
      if (typeof line === 'string') { try { line = JSON.parse(line); } catch { session.unparsedLines++; return; } }
      if (!line || typeof line !== 'object') { session.unparsedLines++; return; }
      event(line);
    },
    finish() {
      for (const entry of session.tasks) { entry.finished = finishedTask(entry); delete entry.slash; }
      return { ...session, unfinishedToolCalls: starts.size };
    }
  };
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
};
const share = (part, whole) => whole ? Math.round((part / whole) * 10000) / 10000 : null;
const sorted = (row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)));

function taskRow(tasks) {
  const finished = tasks.filter((task) => task.finished === true);
  const sum = (key, rows = tasks) => rows.reduce((total, task) => total + task[key], 0);
  const per = (key) => finished.length ? Math.round(sum(key) / finished.length) : null;
  return { tasks: tasks.length, finished: finished.length, finishRate: share(finished.length, tasks.length),
    calls: sum('calls'), inputTokens: sum('inputTokens'), cacheReadTokens: sum('cacheReadTokens'),
    uncachedInputTokens: sum('inputTokens') - sum('cacheReadTokens'), premiumRequests: sum('premiumRequests'),
    // Every attempt's input is charged to the runs that finished (REQ-008); the finished runs' own median is beside it.
    inputPerFinishedTask: per('inputTokens'), uncachedInputPerFinishedTask: finished.length ? Math.round((sum('inputTokens') - sum('cacheReadTokens')) / finished.length) : null,
    callsPerFinishedTask: finished.length ? Math.round((sum('calls') / finished.length) * 100) / 100 : null,
    premiumRequestsPerFinishedTask: finished.length ? Math.round((sum('premiumRequests') / finished.length) * 100) / 100 : null,
    finishedTaskInputMedian: quantile(finished.map((task) => task.inputTokens), 0.5) };
}

/** Aggregates finished session summaries into the §6.2 report. Only sessions that ran an SFlow command count. */
export function copilotSessionReport(summaries, { since = null, details = false } = {}) {
  const kept = summaries.filter((session) => session.sflow).sort((left, right) => left.id.localeCompare(right.id));
  const calls = kept.flatMap((session) => session.calls), routes = kept.flatMap((session) => session.routes);
  const tasks = kept.flatMap((session) => session.tasks);
  const input = calls.reduce((total, call) => total + call.inputTokens, 0);
  const cached = calls.reduce((total, call) => total + call.cacheReadTokens, 0);
  const resultBytes = routes.reduce((total, row) => total + row.bytes, 0);
  const byCause = Object.fromEntries(CALL_CAUSES.map((cause) => {
    const rows = calls.filter((call) => call.cause === cause), tokens = rows.reduce((total, call) => total + call.inputTokens, 0);
    return [cause, { calls: rows.length, inputTokens: tokens, callShare: share(rows.length, calls.length), inputShare: share(tokens, input) }];
  }));
  const byRoute = Object.fromEntries(RESULT_ROUTES.map((route) => {
    const rows = routes.filter((row) => row.route === route), size = rows.reduce((total, row) => total + row.bytes, 0);
    return [route, { results: rows.length, bytes: size, byteShare: share(size, resultBytes), savedByHost: rows.filter((row) => row.savedByHost).length }];
  }));
  const typed = (route) => {
    const rows = {};
    for (const row of routes.filter((entry) => entry.route === route)) {
      const entry = rows[row.resultType ?? 'unknown'] ??= { results: 0, bytes: 0 };
      entry.results++; entry.bytes += row.bytes;
    }
    return sorted(rows);
  };
  const files = kept.flatMap((session) => [...session.overflow.values()]);
  const overflowReads = files.reduce((total, file) => total + file.reads, 0);
  const repeats = files.reduce((total, file) => total + Object.values(file.ranges).reduce((sum, reads) => sum + reads - 1, 0), 0);
  const bySkill = {};
  for (const skill of [...new Set(tasks.filter((task) => task.skill).map((task) => task.skill))].sort()) bySkill[skill] = taskRow(tasks.filter((task) => task.skill === skill));
  const firsts = kept.filter((session) => session.calls.length);
  const prefix = firsts.reduce((total, session) => total + session.calls[0].inputTokens * session.calls.length, 0);
  const median = (pick) => quantile(firsts.map(pick).filter((value) => Number.isFinite(value)), 0.5);
  const hostVersions = {}, models = {}, byHook = {};
  for (const session of kept) count(hostVersions, session.hostVersion ?? 'unknown');
  for (const call of calls) count(models, call.model);
  for (const session of kept) for (const [hook, injections] of Object.entries(session.hooks.byHook)) count(byHook, hook, injections);
  const dates = kept.map((session) => session.date).filter(Boolean).sort();
  const hookSizes = kept.flatMap((session) => session.hooks.sizes);
  const report = { schemaVersion: 1, resultType: 'copilot-session-attribution-report', analyzerVersion: SESSION_ANALYZER_VERSION,
    corpus: { since, sessionsRead: summaries.length, sessionsWithSflow: kept.length, dateRange: { first: dates[0] ?? null, last: dates.at(-1) ?? null },
      hostVersions: sorted(hostVersions), models: sorted(models),
      unparsedLines: kept.reduce((total, session) => total + session.unparsedLines, 0),
      unmatchedToolResults: kept.reduce((total, session) => total + session.unmatchedResults, 0),
      unfinishedToolCalls: kept.reduce((total, session) => total + session.unfinishedToolCalls, 0) },
    totals: { calls: calls.length, inputTokens: input, cacheReadTokens: cached, uncachedInputTokens: input - cached,
      outputTokens: calls.reduce((total, call) => total + call.outputTokens, 0),
      premiumRequests: calls.reduce((total, call) => total + call.premiumRequests, 0), toolResults: routes.length, resultBytes,
      callsOutsideTasks: calls.filter((call) => !call.task).length },
    byCause, byRoute,
    resultTypes: { sflowResults: typed('sflow-result'), overflowReads: typed('sflow-overflow-read') },
    otherTools: sorted(routes.filter((row) => row.route === 'other').reduce((row, entry) => (count(row, entry.tool), row), {})),
    overflowReads: { files: files.length, reads: overflowReads, readsPerFile: { median: quantile(files.map((file) => file.reads), 0.5),
      p90: quantile(files.map((file) => file.reads), 0.9) }, repeatRate: share(repeats, overflowReads) },
    tasks: { sflowSkills: taskRow(tasks.filter((task) => task.finished !== null)), bySkill,
      unlabelled: { tasks: tasks.filter((task) => task.finished === null).length,
        inputTokens: tasks.filter((task) => task.finished === null).reduce((total, task) => total + task.inputTokens, 0) } },
    fixedPrefix: { share: share(prefix, input), firstCallInputTokens: median((session) => session.calls[0].inputTokens),
      toolDefinitionTokens: median((session) => session.prefix.toolDefinitionTokens), availableTools: median((session) => session.prefix.availableTools),
      systemPromptBytes: median((session) => session.prefix.systemPromptBytes), openingSkillBytes: median((session) => session.prefix.openingSkillBytes),
      firstUserMessageBytes: median((session) => session.prefix.firstUserMessageBytes), hookContextBytes: median((session) => session.prefix.hookContextBytes) },
    hookContext: { injections: hookSizes.length, bytes: hookSizes.reduce((total, size) => total + size, 0),
      bytesPerInjection: { median: quantile(hookSizes, 0.5), p90: quantile(hookSizes, 0.9) }, byHook: sorted(byHook) },
    auxiliaryModelCalls: { calls: kept.reduce((total, session) => total + session.auxiliary.calls, 0),
      promptTokens: kept.reduce((total, session) => total + session.auxiliary.promptTokens, 0) },
    definitions: { tokens: 'Host-reported session.usage_record input per model call; cacheReadTokens is the cached part.',
      bytes: 'UTF-8 bytes of each tool result the model was shown; bytes are not tokens.',
      cause: 'What the tool results since the previous model call contained; the first call after a person\'s message is user-turn.',
      task: 'A person\'s message to their next one, labelled by the skill it invoked.', finished: { ...SKILL_SUCCESS, default: ['answered'] },
      premiumRequests: 'Cost of person-initiated model calls, as the host records it.',
      fixedPrefixShare: 'Each session\'s first call input times its calls, over all input.' },
    limitations: ['A host-saved SFlow result shows only the host notice, so its success state is unknown.',
      'Sessions without any SFlow command are left out; sessionsRead counts them.',
      'Auxiliary host model calls are reported beside ITC, not in it.'] };
  if (details) report.records = {
    calls: kept.flatMap((session) => session.calls.map((call) => ({ schemaVersion: 1, session: session.id, call: call.call,
      inputTokens: call.inputTokens, cacheReadTokens: call.cacheReadTokens, model: call.model, cause: call.cause, toolWindow: call.toolWindow,
      task: { skill: call.task?.skill ?? null, finished: call.task?.finished ?? null } }))),
    routes: kept.flatMap((session) => session.routes.map((row) => ({ schemaVersion: 1, session: session.id, route: row.route, bytes: row.bytes,
      savedByHost: row.savedByHost, resultType: row.resultType }))) };
  return report;
}

/** Reads `<directory>/<session>/events.jsonl` read-only, one line at a time; sessions that started before `since` are skipped. */
export async function readCopilotSessionReport(directory, { since = null, details = false } = {}) {
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/u.test(since)) throw new Error('--since takes a date as YYYY-MM-DD.');
  const root = await lstat(directory).catch(() => null);
  if (!root?.isDirectory()) throw new Error(`--sessions needs the host's session-state directory; ${directory} is not a directory.`);
  const summaries = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name, 'events.jsonl');
    const info = await lstat(file).catch(() => null);
    // A log last written before the cut-off cannot hold a session that started after it.
    if (!info?.isFile() || (since && info.mtime.toISOString().slice(0, 10) < since)) continue;
    const session = createSessionAttribution(name);
    const input = createReadStream(file, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) });
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) if (line.trim()) session.push(line);
    const summary = session.finish();
    if (!since || (summary.date && summary.date >= since)) summaries.push(summary);
  }
  return copilotSessionReport(summaries, { since, details });
}
