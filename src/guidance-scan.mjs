/**
 * What a piece of agent, skill or instruction text points at, line by line: the links it gives, the
 * API calls it shows, and the rules it states. Pure and dependency-free, so `workflow check` and the
 * workflow builder read guidance the same way. Nothing here fetches a link or runs a command.
 *
 * Every result carries its 1-based line, so a finding can say exactly where it came from. Rules are
 * read only from prose (never from code blocks); API calls are read from both, because a runbook's
 * `curl` line is usually inside one.
 */

const FENCE = /^\s*(```|~~~)/u;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;
const BARE_URL = /\bhttps?:\/\/[^\s<>()"'`\]]+/giu;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
// "POST /v1/payments" or "GET https://host/path", as API documentation and runbooks write them.
const METHOD_TARGET = /\b(GET|POST|PUT|PATCH|DELETE)\s+((?:https?:\/\/|\/)[^\s"'`<>),]+)/u;
const CLIENT_CALL = /\b(curl|wget|fetch|axios(?:\.(?:get|post|put|patch|delete))?|requests\.(?:get|post|put|patch|delete)|http\.(?:get|post|request)|Invoke-RestMethod|Invoke-WebRequest)\b/iu;
const NEGATIVE = /\b(never|must not|mustn't|do not|don't|should not|shouldn't|avoid)\b/iu;
const POSITIVE = /\b(always|must|should|make sure to|be sure to)\b/iu;
const LIMIT = /\b(at most|no more than|up to|maximum of|max(?:imum)?|at least|no fewer than|minimum of|min(?:imum)?)\s+(\d+)\s+([a-z][a-z-]*)/iu;
// Commands a team runs to check its work, as runbooks and skills write them. Recorded, never run.
const COMMAND = /^(?:\$\s+)?((?:npm|pnpm|yarn|npx|mvn|\.\/mvnw|gradle|\.\/gradlew|pytest|tox|nox|make|go|dotnet|cargo|bundle|rake|ruff|eslint|tsc|bash|sh|pwsh|\.\/[\w./-]+\.(?:sh|ps1|py))(?:\s+[^\s|;&]+)*)/u;
const COMMAND_FIRST = /^(?:npm|pnpm|yarn)\s+(?:run|test|ci|install|build|lint)\b|^npx\s|^(?:mvn|\.\/mvnw)\s|^(?:gradle|\.\/gradlew)\s|^(?:python3?\s+-m\s+)?pytest\b|^tox\b|^nox\b|^make(?:\s|$)|^go\s+(?:test|build|vet)\b|^dotnet\s+(?:test|build)\b|^cargo\s+(?:test|build|clippy)\b|^bundle\s+exec\b|^rake\b|^ruff\b|^eslint\b|^tsc\b|^(?:bash|sh|pwsh)\s+\S+\.(?:sh|ps1)\b|^\.\/[\w./-]+\.(?:sh|ps1|py)\b/u;
// Where a person has to look at the work before it goes on: sign-off, approval, review by someone.
const CHECKPOINT = /\b(sign(?:s|ed)?[- ]off|approv(?:e|es|ed|al)\b|review(?:ed)? by|must be reviewed|needs? (?:a )?(?:human |manual )?review)/iu;
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'any', 'all', 'your', 'you',
  'it', 'its', 'this', 'that', 'these', 'those', 'be', 'is', 'are', 'was', 'when', 'if', 'before', 'after', 'each', 'every',
  'please', 'also', 'just', 'then', 'there', 'their', 'them', 'our', 'we', 'us', 'from', 'by', 'as', 'at', 'into']);
const HOSTS = Object.freeze({
  repository: [['github', 'com'].join('.'), 'gitlab.com', 'bitbucket.org', 'dev.azure.com'],
  fileShare: ['sharepoint.com', 'onedrive.live.com', '1drv.ms', 'drive.google.com', 'docs.google.com', 'dropbox.com', 'box.com']
});

/** The words a rule or limit is about: lower case, without filler words, plurals folded. */
function subjectWords(text, limit = 5) {
  return (String(text).toLowerCase().match(/[a-z0-9][a-z0-9-]*/gu) ?? [])
    .filter((word) => !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
    .slice(0, limit);
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/** A link's kind, in the words a person uses: a ticket, a wiki page, a repository, a file share, or the web. */
export function linkKind(url) {
  const host = hostOf(url) ?? '';
  const lower = String(url).toLowerCase();
  if (/\/browse\/[a-z][a-z0-9]+-\d+/u.test(lower) || host.includes('jira') || /\/(?:issues|pull)\/\d+/u.test(lower)) return 'ticket';
  if (lower.includes('/wiki/') || lower.includes('/display/') || host.includes('confluence')) return 'wiki';
  if (HOSTS.fileShare.some((entry) => host === entry || host.endsWith(`.${entry}`))) return 'file-share';
  if (HOSTS.repository.some((entry) => host === entry || host.endsWith(`.${entry}`)) || host.startsWith('git.')) return 'repository';
  return 'web';
}

/** An endpoint as people write it, with shell and template variables kept readable and no query. */
function endpoint(value) {
  return String(value).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, '{$1}').replace(/[?#].*$/u, '').replace(/[.,;:]+$/u, '');
}

/** A check or build command on one line of code, as written (one command, no shell chaining). */
function commandOn(text) {
  if (text == null) return null;
  const line = String(text).trim().replace(/^\$\s+/u, '');
  if (!COMMAND_FIRST.test(line)) return null;
  return (COMMAND.exec(line)?.[1] ?? line).trim().slice(0, 200);
}

function apiCallOn(line) {
  const direct = METHOD_TARGET.exec(line);
  const client = CLIENT_CALL.exec(line);
  if (!direct && !client) return null;
  const url = (line.match(BARE_URL) ?? [])[0] ?? null;
  if (client && !url && !direct) return null;
  let method = direct?.[1] ?? null;
  if (!method && client) {
    const flag = /(?:-X|--request)\s+['"]?([A-Za-z]+)/u.exec(line)?.[1]?.toUpperCase();
    const named = /\.(get|post|put|patch|delete)\b/iu.exec(client[1])?.[1]?.toUpperCase();
    const option = /method\s*[:=]\s*['"]([A-Za-z]+)['"]/iu.exec(line)?.[1]?.toUpperCase();
    method = [flag, named, option].find((entry) => METHODS.includes(entry))
      ?? (/(?:-d|--data(?:-raw|-binary)?|-F|--form|--json)\b/u.test(line) ? 'POST' : 'GET');
  }
  const target = endpoint(direct?.[2] ?? url);
  const host = hostOf(target.replace(/\{[^}]*\}/gu, 'x'));
  return { method, target, host, via: client ? client[1].toLowerCase() : 'text' };
}

/**
 * Scan one text. Returns `{ links, apiCalls, rules, limits }`, each entry with its line:
 * - links: `{ url, kind, host, line }` for web links and `{ target, kind: 'relative', line }` for paths;
 * - apiCalls: `{ method, target, host, via, line }`;
 * - rules: `{ polarity: 'do'|'never', words, text, line }` for sentences that say always/must or never/do not;
 * - limits: `{ bound: 'max'|'min', value, unit, subject, text, line }`;
 * - commands: `{ command, line }` for check and build commands in code (`npm test`, `mvn verify`, `./scripts/x.sh`);
 * - checkpoints: `{ text, line }` for prose that asks for a sign-off, an approval or someone's review.
 */
export function scanGuidanceText(text, { startLine = 1 } = {}) {
  const commands = [];
  const checkpoints = [];
  const links = [];
  const apiCalls = [];
  const rules = [];
  const limits = [];
  let fenced = false;
  const lines = String(text ?? '').replace(/^﻿/u, '').split(/\r?\n/u);
  lines.forEach((raw, index) => {
    const line = startLine + index;
    if (FENCE.test(raw)) { fenced = !fenced; return; }
    const call = apiCallOn(raw);
    if (call) apiCalls.push({ ...call, line });
    const command = commandOn(fenced ? raw : null);
    if (command) commands.push({ command, line });
    if (fenced) return;
    for (const span of raw.matchAll(/`([^`\n]+)`/gu)) {
      const inline = commandOn(span[1]);
      if (inline && !commands.some((entry) => entry.line === line && entry.command === inline)) commands.push({ command: inline, line });
    }
    const seen = new Set();
    for (const match of raw.matchAll(MARKDOWN_LINK)) {
      const target = match[2];
      if (/^https?:\/\//iu.test(target)) {
        seen.add(target);
        links.push({ url: target, kind: linkKind(target), host: hostOf(target), line });
      } else if (!/^(?:#|mailto:|tel:|[a-z][a-z0-9+.-]*:)/iu.test(target)) {
        links.push({ target: target.replace(/#.*$/u, ''), kind: 'relative', line });
      }
    }
    if (!call) {
      for (const match of raw.matchAll(BARE_URL)) {
        const url = match[0].replace(/[.,;:]+$/u, '');
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({ url, kind: linkKind(url), host: hostOf(url), line });
      }
    }
    const prose = raw.replace(/`[^`]*`/gu, ' ').replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, '');
    if (CHECKPOINT.test(prose) && !/^\s*#/u.test(raw)) checkpoints.push({ text: prose.trim(), line });
    for (const sentence of prose.split(/(?<=[.!?;])\s+/u)) {
      const negative = NEGATIVE.exec(sentence);
      const positive = negative ? null : POSITIVE.exec(sentence);
      const keyword = negative ?? positive;
      if (keyword) {
        const words = subjectWords(sentence.slice(keyword.index + keyword[0].length));
        if (words.length >= 2) rules.push({ polarity: negative ? 'never' : 'do', words, text: sentence.trim(), line });
      }
      const limit = LIMIT.exec(sentence);
      if (limit) {
        const before = subjectWords(sentence.slice(0, limit.index), 12).slice(-2);
        const unit = subjectWords(limit[3], 1)[0] ?? limit[3].toLowerCase();
        limits.push({ bound: /least|min|fewer/iu.test(limit[1]) ? 'min' : 'max', value: Number(limit[2]), unit, subject: before, text: sentence.trim(), line });
      }
    }
  });
  return { links, apiCalls, rules, limits, commands, checkpoints };
}

const sameWords = (a, b) => a.length === b.length && a.every((word, index) => word === b[index]);
/** "never squash commits" and "always squash commits before merging" are about the same thing. */
const sameRule = (a, b) => {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && short.every((word, index) => word === long[index]);
};

/**
 * Rules from different places that cannot both be followed: one says always X and another never X,
 * or two give different limits for the same thing. `sources` is `[{ file, scan }]`. A pattern
 * check, so callers call these possible conflicts and let a person dismiss them.
 */
export function guidanceConflicts(sources) {
  const conflicts = [];
  const keyed = new Set();
  const add = (kind, a, b, summary) => {
    const ends = [`${a.file}:${a.line}`, `${b.file}:${b.line}`].sort();
    const key = `${kind}\0${ends.join('\0')}`;
    if (keyed.has(key)) return;
    keyed.add(key);
    conflicts.push({ kind, summary, first: { file: a.file, line: a.line, text: a.text }, second: { file: b.file, line: b.line, text: b.text } });
  };
  const rules = sources.flatMap(({ file, scan }) => scan.rules.map((rule) => ({ ...rule, file })));
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const [a, b] = [rules[i], rules[j]];
      if (a.polarity === b.polarity || (a.file === b.file && a.line === b.line)) continue;
      if (sameRule(a.words, b.words)) add('rule', a, b, (a.words.length <= b.words.length ? a : b).words.join(' '));
    }
  }
  const limits = sources.flatMap(({ file, scan }) => scan.limits.map((limit) => ({ ...limit, file })));
  for (let i = 0; i < limits.length; i += 1) {
    for (let j = i + 1; j < limits.length; j += 1) {
      const [a, b] = [limits[i], limits[j]];
      if (a.unit !== b.unit || !a.subject.length || !sameWords(a.subject, b.subject) || (a.file === b.file && a.line === b.line)) continue;
      const [max, min] = a.bound === 'max' ? [a, b] : [b, a];
      const clash = a.bound === b.bound ? a.value !== b.value : min.value > max.value;
      if (clash) add('limit', a, b, `${a.subject.join(' ')} ${a.unit}`);
    }
  }
  return conflicts;
}
