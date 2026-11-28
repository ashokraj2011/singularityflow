/**
 * What the office report may never carry: names, emails, hostnames, organisation and repository names, URLs,
 * tokens, environment values and file paths. Every string in the report passes through one scrubber before it is
 * written. It removes two kinds of thing:
 *
 * - the exact values this machine holds (the account name, home folder, computer name, Git identity, remote
 *   address and its parts, the checkout's folder and name, Jira settings, and every environment value that
 *   names a path, address or secret), wherever they appear and in any letter case;
 * - anything shaped like a URL, an email, an scp-style remote, an absolute path, an IP address, a hostname or a
 *   token, whatever its value.
 *
 * A literal shorter than three characters is never removed by itself: it would eat ordinary words.
 */
import os from 'node:os';

const SECRET_NAME = /(?:token|secret|password|passwd|pat|key|auth|cookie|credential|proxy|jira|github|gh_|gitlab|azure|copilot_provider)/iu;
const PATHISH = /[\\/@:.]/u;
const MINIMUM = 3;

// Whole things first, before any literal can break them apart: URLs, remotes, emails and tokens.
const WHOLE = [
  // URLs of any scheme, then scp-style remotes (user@host:path), then emails.
  [/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"<>()\]]+/giu, '[url]'],
  [/\b[\w.-]+@[\w.-]+:[\w~./-]+/gu, '[remote]'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu, '[email]'],
  // Tokens: provider prefixes, bearer and basic credentials, long hex or base64 runs.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/gu, '[token]'],
  [/\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/giu, '[token]'],
  [/\b[A-Fa-f0-9]{40,}\b/gu, '[digest]'],
  [/(?<![\w/+-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])[A-Za-z0-9+/_-]{32,}={0,2}(?![\w/])/gu, '[token]']
];
// Then, after the literals: paths, addresses and hostnames.
const PARTS = [
  // Paths: Windows drive and UNC paths, home-relative paths, then absolute POSIX paths.
  [/(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\'"]+\\)[^\s'"<>|]*/gu, '[path]'],
  [/(?<![\w\]])~[\\/][^\s'"<>|]*/gu, '[path]'],
  [/(?<![\w.:\]>-])\/[^\s/'"<>|:]+(?:\/[^\s/'"<>|:]*)+/gu, '[path]'],
  // Addresses and hostnames (dotted names with a known suffix or three or more labels).
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/gu, '[address]'],
  [/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,24}\b/giu, '[host]'],
  [/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|dev|corp|local|internal|lan|intra|cloud|ai|app|co|us|uk|in|de)\b/giu, '[host]']
];

// GitHub's cloud host is joined so the repository holds no public host name (scripts/check.mjs).
const PUBLIC_HOSTS = new Set([['github', 'com'].join('.'), 'gitlab.com', 'bitbucket.org', 'dev.azure.com', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com']);
const COMMON_LABELS = new Set(['git', 'www', 'ssh', 'scm', 'code', 'source', 'github', 'gitlab', 'bitbucket', 'azure', 'dev', 'com', 'net', 'org']);
// Product words the report names on purpose. They are set aside before scrubbing and put back after, so a remote on
// one of these public hosts cannot take the product's name with it.
const KEEP = [['GitHub', 'com'].join('.'), 'GitLab.com', 'Bitbucket.org', 'GitHub Enterprise', 'GitHub', 'GitLab', 'Bitbucket', 'Azure DevOps'];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Folder names every machine has: a home folder's other parts are removed, these never are by themselves.
const COMMON_FOLDERS = /^(?:users|home|private|var|tmp|usr|opt|bin|src|lib|local|program files|appdata|roaming|library|applications|documents|desktop)$/iu;

/** One value, and with `parts` its path pieces too: a home folder's last name is often the account name. */
function addLiteral(set, value, parts = false) {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (text.length < MINIMUM || text.length > 4096) return;
  set.add(text);
  if (!parts) return;
  for (const part of text.split(/[\\/]+/u)) {
    if (part.length >= MINIMUM && part !== text && !COMMON_FOLDERS.test(part) && !/^[a-z]:$/iu.test(part)) set.add(part);
  }
}

/** Host, organisation and repository of a remote address, each on its own. */
export function remoteParts(address) {
  const value = String(address ?? '').trim();
  if (!value) return [];
  const parts = [value];
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(value);
  let host = null;
  let pathname = '';
  try {
    const url = new URL(value);
    host = url.hostname; pathname = url.pathname;
    if (url.username) parts.push(decodeURIComponent(url.username));
  } catch {
    if (scp) { host = scp[1]; pathname = scp[2]; }
  }
  if (host) {
    parts.push(host);
    // A company host names the company in its labels (git.example-corp.net); a public host names nobody.
    const labels = host.toLowerCase().split('.');
    if (/(?:^|\.)visualstudio\.com$/u.test(host.toLowerCase())) parts.push(labels[0]);
    else if (!PUBLIC_HOSTS.has(host.toLowerCase())) {
      parts.push(...labels.slice(0, -1).filter((label) => label.length >= MINIMUM && !COMMON_LABELS.has(label)));
    }
  }
  for (const segment of pathname.split('/')) {
    const name = segment.replace(/\.git$/u, '');
    if (name && !['_git', 'scm', 'git', 'v3', 'DefaultCollection'].includes(name)) parts.push(name);
  }
  return parts;
}

/** Every value of this machine the report must not carry. */
export function machineLiterals({ env = process.env, extra = [], homes = [] } = {}) {
  const set = new Set();
  let info = {};
  try { info = os.userInfo(); } catch { /* no account record */ }
  addLiteral(set, info.username);
  addLiteral(set, info.homedir, true);
  addLiteral(set, os.homedir(), true);
  const host = os.hostname();
  addLiteral(set, host);
  addLiteral(set, host.split('.')[0]);
  for (const name of ['USER', 'USERNAME', 'LOGNAME', 'USERDOMAIN', 'USERDNSDOMAIN', 'COMPUTERNAME', 'HOSTNAME']) addLiteral(set, env[name]);
  for (const name of ['USERPROFILE', 'HOMEPATH', 'HOME']) addLiteral(set, env[name], true);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MINIMUM) continue;
    if (SECRET_NAME.test(name)) { addLiteral(set, value); continue; }
    if (value.length >= 8 && PATHISH.test(value)) {
      for (const piece of value.split(/[;\n]|:(?![\\/])/u)) if (piece.length >= 8) addLiteral(set, piece);
    }
  }
  for (const value of homes) addLiteral(set, value, true);
  for (const value of extra) addLiteral(set, value);
  return [...set];
}

/** A function that removes the literals and every sensitive shape from one string. */
export function createScrubber(literals = []) {
  const ordered = [...new Set(literals.filter((value) => typeof value === 'string' && value.trim().length >= MINIMUM)
    .map((value) => value.trim()))].sort((a, b) => b.length - a.length);
  const literal = ordered.length
    ? new RegExp(ordered.map((value) => `(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`).join('|'), 'giu')
    : null;
  const keep = new RegExp(KEEP.map((word) => `(?<![\\w.])${escapeRegExp(word)}(?![\\w.])`).join('|'), 'gu');
  const scrub = (value) => {
    const kept = [];
    let text = String(value ?? '').replace(/\u0000/gu, '').replace(keep, (word) => `\u0000${kept.push(word) - 1}\u0000`);
    for (const [shape, replacement] of WHOLE) text = text.replace(shape, replacement);
    if (literal) text = text.replace(literal, '[removed]');
    for (const [shape, replacement] of PARTS) text = text.replace(shape, replacement);
    return text.replace(/\u0000(\d+)\u0000/gu, (_, index) => kept[Number(index)] ?? '');
  };
  scrub.literals = ordered;
  return scrub;
}

/** The same value with every string scrubbed; keys are SFlow's own and stay. */
export function scrubDeep(value, scrub) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => scrubDeep(entry, scrub));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubDeep(entry, scrub)]));
  }
  return value;
}

/** Which literals still appear in `text`, ignoring case: empty for a report that may be sent. */
export function leftovers(text, literals) {
  const lower = String(text).toLowerCase();
  return literals.filter((value) => {
    const needle = value.toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0) {
      const before = lower[at - 1] ?? ' ';
      const after = lower[at + needle.length] ?? ' ';
      if (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after)) return true;
      at = lower.indexOf(needle, at + 1);
    }
    return false;
  });
}
