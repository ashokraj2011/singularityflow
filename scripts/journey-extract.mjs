/**
 * Turns a real Story's Copilot sessions into a journey a test can replay through the guard. A development
 * tool: offline, reads the host's logs and writes only the file named by --out.
 *
 *   node scripts/journey-extract.mjs --sessions <COPILOT-SESSION-STATE-DIR> --story <WORK-ID> --out <FILE>
 *
 * Rerun it to add what a Story did since: it rebuilds the file from the logs. A chat folder can differ
 * from the checkout, so sessions are matched on content: the Story's ID as a whole word.
 *
 * Privacy is by construction. What is kept is an allow-list: tool names, program names, flags, command
 * words from the registry and fixed placeholders. Anything else in an argument becomes a placeholder, so
 * no path, login, name, repository URL, prompt, reason or application content can pass through it.
 * test/journey-replay.test.mjs checks each saved token against the same list.
 */
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { refusalFromCompletion } from './route-audit.mjs';

// Each stands for one kind of value. A replay turns it back into a path or word of its own fixture.
export const PLACEHOLDERS = Object.freeze(['<WORK-ID>', '<VALUE>', '<TEXT>', '<N>', '<CHECKOUT>', '<REPO-PATH>', '<ARTIFACT-PATH>', '<HOME-PATH>', '<SYSTEM-PATH>', '<ISSUED-OUTPUT>', '<ISSUED-STAGING>',
  '<PROGRAM>', '<HEREDOC>', '<ENV>']);
export const PROGRAMS = new Set(['singularity-flow', 'sflow', 'ls', 'cat', 'git', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'grep', 'rg', 'sed', 'awk', 'jq', 'head', 'tail', 'find', 'pwd', 'cd',
  'echo', 'test', 'python3', 'python', 'wc', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'which', 'command', 'env', 'export', 'nl', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'stat', 'file', 'true', 'false', 'printf', 'date', 'sleep', 'bash', 'sh', 'zsh', 'nvm', 'tee', 'diff', 'for', 'do', 'done', 'if', 'then', 'fi', 'while']);
export const SECOND_WORDS = Object.freeze({ git: new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'branch', 'ls-files', 'add', 'commit', 'push', 'fetch', 'pull', 'checkout', 'switch', 'merge', 'rebase', 'reset', 'restore', 'stash', 'worktree', 'remote', 'config', 'grep', 'cat-file', 'ls-tree', 'blame', 'tag', 'clean', 'rm', 'mv', 'for-each-ref', 'merge-base', 'symbolic-ref', 'init', 'clone']),
  npm: new Set(['test', 'run', 'install', 'ci', 'ls', 'exec', 'view', 'audit', 'start']), pnpm: new Set(['test', 'run', 'install', 'exec']), yarn: new Set(['test', 'run', 'install']),
  npx: new Set(['vitest', 'playwright', 'eslint', 'tsc', 'jest', 'prettier', 'vite']) });
export const ENV_NAMES = new Set(['PATH', 'HOME', 'CI', 'NODE_ENV', 'NODE_OPTIONS', 'FORCE_COLOR', 'NO_COLOR', 'TERM', 'LANG', 'PORT']);
// Words of the product's own: steps of the shipped workflows and values its options enumerate.
export const PRODUCT_WORDS = new Set(['intake', 'specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'testing', 'conformance', 'design', 'requirements',
  'human', 'governed-agent', 'copilot-host', 'manual-in-place', 'manual-import', 'test', 'tests', 'dependency-test', 'run',
  'enter', 'begin', 'publish', 'prepublish', 'draft-check', 'show', 'current', 'open', 'takeover', 'answer', 'record', 'check', 'context', 'submit', 'stage', 'advance', 'adjudicate', 'adjudications',
  'summary', 'last', 'status', 'plan', 'choose', 'witness', 'prepare', 'preflight', 'resolve', 'approve', 'findings', 'base', 'scope', 'matrix', 'list']);
export const FLAG = /^--?[a-zA-Z][a-zA-Z0-9-]*$/u;

const pathClass = (token, { checkout, home, workId }) => {
  const value = token.replace(/^~(?=\/)/u, home).replace(/^\$HOME(?=\/|$)/u, home);
  // A chat folder can differ from the checkout, so the checkout is also told by SFlow's own folder for them.
  if (/\.sflow\/staging|singularity-flow\/staging|\/staging\/|-staging\b|\/\.git\/(?:worktrees\/[^/]+\/)?singularity-flow\//u.test(value)) return '<ISSUED-STAGING>';
  if (/(?:^|\/)\.sflow\/out\//u.test(value) || /copilot-tool-output-/u.test(value)) return '<ISSUED-OUTPUT>';
  if (/(?:^|\/)singularity\/work-items\/[^/]+\/artifacts\//u.test(value)) return '<ARTIFACT-PATH>';
  if (/\/story-worktrees\/[^/]+$/u.test(value) || value === checkout) return '<CHECKOUT>';
  if (/\/story-worktrees\/[^/]+\//u.test(value) || (checkout && value.startsWith(`${checkout}/`))) return '<REPO-PATH>';
  if (home && (value === home || value.startsWith(`${home}/`))) return '<HOME-PATH>';
  if (value.startsWith('/')) return '<SYSTEM-PATH>';
  if (workId && value === workId) return '<WORK-ID>';
  return '<REPO-PATH>';
};
const looksLikePath = (token) => /[/\\]/u.test(token) || /^\.{1,2}$/u.test(token) || /^\.?[\w@-]+\.[A-Za-z0-9]{1,8}$/u.test(token);

/** A shell line as words and operators, with its quoting noted: a quoted word with spaces is text. */
export function shellWords(line) {
  const words = []; let word = null; let quote = null; let hadSpace = false;
  const flush = () => { if (word !== null) { words.push({ word, text: hadSpace }); word = null; hadSpace = false; } };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < line.length) word += line[++index];
      else { word += char; if (/\s/u.test(char)) hadSpace = true; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; word ??= ''; continue; }
    if (char === '\\' && index + 1 < line.length) { word = (word ?? '') + line[++index]; continue; }
    if (char === '\n') { flush(); words.push({ operator: ';' }); continue; }
    if (/\s/u.test(char)) { flush(); continue; }
    const two = line.slice(index, index + 2);
    if (['&&', '||', '>>', '2>', '<<'].includes(two)) { flush(); words.push({ operator: two }); index += 1; continue; }
    if ([';', '|', '>', '<', '&', '(', ')'].includes(char)) { flush(); words.push({ operator: char }); continue; }
    word = (word ?? '') + char;
  }
  flush();
  return words;
}

/** One shell command in allow-listed tokens. Every word that is not on a list becomes a placeholder. */
export function normalizeCommand(command, context) {
  const { workId, knownWords } = context;
  const source = String(command).replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/gu, ' HEREDOCMARK ');
  const out = [];
  let position = 'program'; let program = null; let wordsSeen = 0;
  for (const entry of shellWords(source)) {
    if (entry.operator) { out.push(entry.operator); if (!['>', '>>', '2>', '<', '<<'].includes(entry.operator)) { position = 'program'; program = null; wordsSeen = 0; } continue; }
    const { word, text } = entry;
    if (word === 'HEREDOCMARK') { out.push('<HEREDOC>'); continue; }
    if (position === 'program') {
      const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su);
      if (assignment) {
        out.push(`${ENV_NAMES.has(assignment[1]) ? assignment[1] : '<ENV>'}=${assignment[2].includes('/') ? pathClass(assignment[2].split(':')[0], context) : '<VALUE>'}`);
        continue;
      }
      const base = word.split('/').at(-1).replace(/\.(?:cmd|exe|ps1)$/u, '');
      if (PROGRAMS.has(base)) { out.push(word.includes('/') && !['singularity-flow', 'sflow'].includes(base) ? pathClass(word, context) : base); program = base; }
      else if (looksLikePath(word)) { out.push(pathClass(word, context)); program = '<PROGRAM>'; } else { out.push('<PROGRAM>'); program = '<PROGRAM>'; }
      position = 'arguments'; wordsSeen = 0;
      continue;
    }
    wordsSeen += 1;
    const flag = word.match(/^(--?[a-zA-Z][a-zA-Z0-9-]*)=(.*)$/su);
    if (FLAG.test(word)) { out.push(word); continue; }
    if (flag && FLAG.test(flag[1])) { out.push(`${flag[1]}=${looksLikePath(flag[2]) ? pathClass(flag[2], context) : '<VALUE>'}`); continue; }
    if (workId && (word === workId)) { out.push('<WORK-ID>'); continue; }
    if (['singularity-flow', 'sflow'].includes(program)) {
      if (wordsSeen === 1 && knownWords.has(word)) { out.push(word); continue; }
      if (PRODUCT_WORDS.has(word)) { out.push(word); continue; }
      out.push(text ? '<TEXT>' : looksLikePath(word) ? pathClass(word, context) : '<VALUE>');
      continue;
    }
    if (wordsSeen === 1 && SECOND_WORDS[program]?.has(word)) { out.push(word); continue; }
    if (text) { out.push('<TEXT>'); continue; }
    if (/^\d+$/u.test(word)) { out.push('<N>'); continue; }
    out.push(looksLikePath(word) ? pathClass(word, context) : '<VALUE>');
  }
  return out.join(' ');
}

const PATH_FIELDS = ['path', 'file_path', 'filePath', 'target', 'absolutePath'];

/** A tool call's arguments, with only what the guard reads. Contents never stay. */
export function normalizeArguments(toolName, args, context) {
  if (typeof args === 'string') {
    // An apply_patch body: its targets are all the guard needs.
    const targets = [...args.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gmu)].map((match) => ({ change: match[1], path: pathClass(match[2].trim(), context) }));
    return targets.length ? { patch: targets } : {};
  }
  if (!args || typeof args !== 'object') return {};
  if (typeof args.command === 'string') return { command: normalizeCommand(args.command, context) };
  const kept = {};
  for (const field of PATH_FIELDS) if (typeof args[field] === 'string') kept.path = pathClass(args[field], context);
  if (Array.isArray(args.view_range)) kept.view_range = true;
  if (typeof args.input === 'string' && /^\*\*\* /mu.test(args.input)) return normalizeArguments(toolName, args.input, context);
  if (typeof args.workId === 'string') kept.workId = '<WORK-ID>';
  return kept;
}

export const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]*$/u;
const NOT_A_GUARD_QUESTION = new Set(['report_intent', 'task_complete', 'ask_user', 'tool_search_tool', 'read_bash', 'write_bash', 'stop_bash', 'list_bash']);

/** One session's calls as journey rows: the turn's skill, tool, normalized arguments and outcome. */
export async function sessionRows(file, context) {
  const starts = new Map(); const rows = []; let turn = 'plain'; let startTime = null; let checkout = null; let mentions = 0;
  const pattern = new RegExp(`(?<![\\w-])${context.workId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\w-])`, 'u');
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!mentions && pattern.test(line)) mentions = 1;
    if (!line.startsWith('{"type":"tool.execution_') && !line.startsWith('{"type":"user.message"') && !line.startsWith('{"type":"session.start"')) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const { type, data } = event;
    if (type === 'session.start') { startTime = data?.startTime ?? null; checkout = data?.context?.gitRoot ?? data?.context?.cwd ?? null; }
    else if (type === 'user.message') turn = String(data?.content ?? '').match(/^\s*\/(sf(?:low)?-[a-z-]+)/u)?.[1] ?? 'plain';
    else if (type === 'tool.execution_start') starts.set(data?.toolCallId, { toolName: data?.toolName, arguments: data?.arguments });
    else if (type === 'tool.execution_complete') {
      const start = starts.get(data?.toolCallId);
      if (!start || !TOOL_NAME.test(start.toolName ?? '') || NOT_A_GUARD_QUESTION.has(start.toolName)) continue;
      const refusal = refusalFromCompletion(data, start);
      rows.push({ turn, tool: start.toolName, args: normalizeArguments(start.toolName, start.arguments, { ...context, checkout }),
        outcome: refusal?.kind === 'guard' ? refusal.code : 'allowed',
        ...(refusal?.kind === 'command' && refusal.code !== 'NONZERO_EXIT_NO_CODE' ? { cli: refusal.code } : {}) });
    }
  }
  return { startTime, mentions: mentions > 0, rows };
}

/** The command words the registry knows, for the extractor and for the test that checks what it saved. */
export async function registryWords() {
  const { COMMAND_REGISTRY } = await import('../src/command-registry.mjs');
  const words = new Set();
  for (const entry of COMMAND_REGISTRY) {
    words.add(entry.name);
    for (const alias of entry.aliases ?? []) words.add(alias);
  }
  return words;
}

/** True for a token a journey may hold: every other word must have become a placeholder. */
export function tokenAllowed(token, knownWords) {
  if ([';', '&&', '||', '|', '>', '>>', '2>', '<', '<<', '&', '(', ')'].includes(token) || PLACEHOLDERS.includes(token)) return true;
  if (FLAG.test(token) || PROGRAMS.has(token) || PRODUCT_WORDS.has(token) || knownWords.has(token)) return true;
  if (Object.values(SECOND_WORDS).some((words) => words.has(token))) return true;
  const assignment = token.match(/^([^=]+)=(<[A-Z-]+>)$/u);
  return Boolean(assignment && PLACEHOLDERS.includes(assignment[2]) && (FLAG.test(assignment[1]) || ENV_NAMES.has(assignment[1]) || assignment[1] === '<ENV>'));
}

async function main(argv) {
  const usage = 'Use --sessions <COPILOT-SESSION-STATE-DIR> --story <WORK-ID> --out <FILE>.';
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--sessions', '--story', '--out'].includes(argv[index]) || !argv[index + 1]) throw new Error(usage);
    options[argv[index].slice(2)] = argv[index + 1];
  }
  if (!options.sessions || !options.story || !options.out) throw new Error(usage);
  const context = { workId: options.story, knownWords: await registryWords(), home: process.env.HOME ?? '' };
  const root = path.resolve(options.sessions);
  const sessions = [];
  for (const name of readdirSync(root)) {
    const file = path.join(root, name, 'events.jsonl');
    try { if (!statSync(file).isFile()) continue; } catch { continue; }
    const session = await sessionRows(file, context);
    if (session.mentions && session.rows.length) sessions.push(session);
  }
  sessions.sort((left, right) => String(left.startTime).localeCompare(String(right.startTime)));
  const journey = { schemaVersion: 1, note: 'Scrubbed by scripts/journey-extract.mjs. Rerun it to rebuild.',
    sessions: sessions.map((session) => session.rows) };
  writeFileSync(path.resolve(options.out), `${JSON.stringify(journey, null, 0).replaceAll('},{', '},\n{').replaceAll('[[', '[\n[').replaceAll(']]', ']\n]')}\n`);
  console.log(`${sessions.length} sessions, ${sessions.reduce((sum, session) => sum + session.rows.length, 0)} calls`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

