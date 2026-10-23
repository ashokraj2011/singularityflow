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
// Commands a team runs, as runbooks, skills and instructions write them: one per line of code, or
// in inline code in prose. Recorded and classified, never run.
const COMMAND = /^((?:[\w./-]+)(?:\s+[^\s|;&<>]+)*)/u;
const COMMAND_FIRST = new RegExp([
  String.raw`^(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+\S+|(?:test|t|ci|install|i|build|lint|start|exec|publish|audit)\b)`, String.raw`^(?:pnpm|yarn)\s+[a-z][\w:-]*$`,
  String.raw`^(?:pnpm|yarn)\s+[a-z][\w:-]*\s`, String.raw`^npx\s`, String.raw`^(?:mvn|\.\/mvnw)(?:\s|$)`, String.raw`^(?:gradle|\.\/gradlew)\s`,
  String.raw`^(?:python3?\s+-m\s+)?pytest\b`, String.raw`^python3?\s+(?:-m\s+[\w.]+|[\w./-]+\.py|manage\.py)\b`, String.raw`^node\s+[\w./-]+\.(?:js|mjs|cjs|ts)\b`,
  String.raw`^(?:tox|nox|jest|vitest|mocha|cypress|playwright|phpunit|rspec|rake|ruff|eslint|tsc|mypy|flake8|pylint|black|prettier|gofmt|swiftlint|ktlint|detekt)\b`,
  String.raw`^make(?:\s|$)`, String.raw`^go\s+(?:test|build|vet|run|fmt)\b`, String.raw`^dotnet\s+(?:test|build|run|format|publish)\b`,
  String.raw`^cargo\s+(?:test|build|clippy|fmt|run)\b`, String.raw`^bundle\s+exec\b`, String.raw`^composer\s+(?:test|run|install)\b`,
  String.raw`^(?:swift\s+(?:test|build)|xcodebuild\b|flutter\s+(?:test|build|analyze)|dart\s+(?:test|analyze))`,
  String.raw`^(?:docker(?:-compose)?|kubectl|helm|terraform|ansible-playbook|fastlane|firebase|az|aws|gcloud)\s`,
  String.raw`^(?:bash|sh|zsh|pwsh)\s+(?:-File\s+)?\S+\.(?:sh|ps1)\b`, String.raw`^\.?\/?(?:scripts?|bin|tools)\/[\w./-]+\b`, String.raw`^\.\/[\w./-]+\.(?:sh|ps1|py)\b`
].join('|'), 'u');
// What a command is for. Tests, lint, type checks, builds and formatting can become a step's check
// that sflow runs at submit; scripts, runs, installs and deployments stay with the agent.
const CATEGORIES = [
  ['deploy', /\b(?:deploy|release|publish|rollout|promote)\b|^(?:kubectl|helm|terraform\s+apply|ansible-playbook|fastlane|firebase\s+deploy|docker\s+push|az\b|aws\b|gcloud\b)/u],
  ['test', /\b(?:test|tests|spec|specs|e2e|pytest|jest|vitest|mocha|cypress|playwright|phpunit|rspec|tox|nox|verify|check)\b|^(?:npm|pnpm|yarn)\s+t\b/u],
  ['lint', /\b(?:lint|eslint|ruff|flake8|pylint|clippy|vet|swiftlint|ktlint|detekt|analy[sz]e)\b/u],
  ['typecheck', /\b(?:tsc|mypy|typecheck|type-check|types)\b/u],
  ['format', /\b(?:format|fmt|prettier|black|gofmt)\b/u],
  ['build', /\b(?:build|compile|package|assemble)\b/u],
  ['install', /\b(?:install|ci|i|bundle\s+install|pip\s+install|restore)\b|^(?:npm|pnpm|yarn)\s+(?:ci|install|i)\b/u],
  ['run', /^(?:npm|pnpm|yarn)\s+(?:start|exec)\b|^node\s|^python3?\s+(?:[\w./-]+\.py|manage\.py\s+runserver)|\brun\b|^docker(?:-compose)?\s+(?:run|up)\b/u],
  ['script', /^(?:bash|sh|zsh|pwsh)\s|^\.?\/?(?:scripts?|bin|tools)\/|^\.\/[\w./-]+\.(?:sh|ps1|py)\b|^make(?:\s|$)/u]
];
/** Categories a step can run as its check, and the quality-command kind each becomes. */
export const CHECK_KINDS = Object.freeze({ test: 'test', lint: 'lint', typecheck: 'static-analysis', format: 'format', build: 'compile' });
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

/**
 * What a command is for: test, lint, typecheck, format, build, install, run, deploy, script or
 * other. Deployment wins over everything (a "release test" still releases).
 */
export function classifyCommand(command) {
  const text = String(command ?? '').toLowerCase().replace(/^(?:[a-z_][a-z0-9_]*=\S*\s+)+/u, '');
  return CATEGORIES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other';
}

/**
 * The commands on one line of code, as written: each part of an `a && b` chain, with environment
 * settings kept in the command. A leading `cd <dir>` (inside the repository) becomes the
 * directory the commands after it run in, so nothing is dropped. A pipe, `;` or redirection ends a command.
 */
function commandsOn(text) {
  if (text == null) return [];
  const found = [];
  let directory = null;
  for (const part of String(text).trim().replace(/^\$\s+/u, '').split(/\s*&&\s*/u)) {
    const env = /^((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(.*)$/u.exec(part.trim());
    const line = env[2];
    const into = /^cd\s+([\w./-]+)\/?$/u.exec(line)?.[1];
    if (into) { directory = into.startsWith('/') || into.split('/').includes('..') ? null : [directory, into.replace(/^\.\//u, '')].filter((entry) => entry && entry !== '.').join('/') || null; continue; }
    if (!COMMAND_FIRST.test(line)) continue;
    const command = `${env[1]}${(COMMAND.exec(line)?.[1] ?? line).trim()}`.trim().slice(0, 200);
    found.push({ command, category: classifyCommand(command), ...(directory ? { directory } : {}) });
  }
  return found;
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
 * - commands: `{ command, category, directory?, line }` for commands in code (`npm test`, `mvn verify`, `./scripts/x.sh`),
 *   classified by classifyCommand;
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
    for (const command of commandsOn(fenced ? raw : null)) commands.push({ ...command, line });
    if (fenced) return;
    for (const span of raw.matchAll(/`([^`\n]+)`/gu)) {
      for (const inline of commandsOn(span[1])) {
        if (!commands.some((entry) => entry.line === line && entry.command === inline.command)) commands.push({ ...inline, line });
      }
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
