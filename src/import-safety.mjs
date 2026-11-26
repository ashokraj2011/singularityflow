/**
 * SFlow's text checks on imported text (docs/SPEC-OMK-ORG-MARKETPLACE-v1.md §7): a skill, template or agent goes into an
 * agent's prompt, so its text is checked before its first use, for what a person reading it could miss or what would work
 * against SFlow's own rules. Rules, not a model: the same text always gives the same answer [OMK:REQ-030].
 *
 * - block: hidden characters, text telling an agent to get around SFlow's rules, to read or print credentials, or to run
 *   downloaded content straight away; and a secret (secrets.mjs, as today). The import is refused (IMPORT_SAFETY_BLOCKED)
 *   with each line shown, every invisible character spelled out [OMK:REQ-031].
 * - look: hidden markup, a long encoded run, a command that sends data out or destroys work. The import needs the
 *   person's yes (`--looked <check IDs>`, or the review card's checkbox); the record keeps which lines were looked at, so
 *   a later update asks again only for lines that changed.
 * - note: each link to a host other than the marketplace's own, once per host.
 *
 * Honest limits [OMK:REQ-033]: these are "SFlow's text checks", never a security review. They catch hidden text and plain
 * attempts to get around SFlow's rules, not a clever prompt; SFlow's hooks, approvals and frozen snapshots stay the safety
 * boundary. Pure, apart from hashing.
 */
import { createHash } from 'node:crypto';

import { scanText } from './secrets.mjs';
import { SingularityFlowError } from './util.mjs';

/** The checker's version: a result kept for a text is read again only when this changes. */
export const IMPORT_SAFETY_CHECKER = 'sflow-text-checks/2';
/** What the checks are called wherever a person reads them: never a security review [OMK:REQ-033]. */
export const SAFETY_NAME = "SFlow's text checks";

/** Each check and what it does: block refuses, look needs the person's yes, note only shows [OMK:REQ-030]. */
export const SAFETY_CHECKS = Object.freeze({
  'hidden-characters': 'block', 'rule-bypass': 'block', 'credential-access': 'block', 'pipe-to-shell': 'block', secret: 'block',
  'hidden-markup': 'look', 'encoded-payload': 'look', 'data-upload': 'look', 'destructive-command': 'look', 'sflow-command': 'look',
  'outside-link': 'note'
});
export const LOOK_CHECKS = Object.freeze(Object.keys(SAFETY_CHECKS).filter((check) => SAFETY_CHECKS[check] === 'look'));

const CHECK_WORDS = Object.freeze({
  'hidden-characters': 'hidden characters',
  'rule-bypass': "tells an agent to get around SFlow's rules",
  'credential-access': 'tells an agent to read or print credentials',
  'pipe-to-shell': 'runs downloaded content straight away',
  secret: 'what looks like a secret',
  'hidden-markup': 'text hidden in markup',
  'encoded-payload': 'a long encoded run',
  'data-upload': 'sends data out',
  'destructive-command': 'a command that destroys work',
  'sflow-command': "names one of SFlow's approve, decision, override, pause or guard commands: check that it asks the person and does not run it for them",
  'outside-link': 'a link to another site'
});
const SEVERITY_ORDER = Object.freeze({ block: 0, look: 1, note: 2 });
const LINE_SHOWN = 240;

const sha256 = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

// ------------------------------------------------------------------------------------------------ hidden characters

// Bidirectional controls, zero-width and other format characters (Cf, Unicode tags included), the Hangul fillers, and
// the control characters other than tab, line feed and carriage return.
const INVISIBLE = /[\p{Cf}ᅟᅠㅤﾠ\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** `text` with every invisible character spelled out, as `[U+202E]`, so a person sees where it is. */
export function spellInvisible(text) {
  return String(text ?? '').replace(INVISIBLE, (character) => `[U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}]`);
}

/** The invisible characters of one line, spelled out; a byte order mark only counts away from the text's very start. */
function invisibleIn(line, { first = false } = {}) {
  const found = [];
  for (const match of line.matchAll(INVISIBLE)) {
    if (first && match.index === 0 && match[0] === '﻿') continue;
    found.push(spellInvisible(match[0]));
  }
  return [...new Set(found)];
}

// ------------------------------------------------------------------------------------------------ the patterns

// A negation just before what a pattern found ("never skip the approval", "do not run curl … | sh") means the text warns
// against it: SFlow's own rules say the same. So does a clause that opens with one and lists what it forbids ("Never
// fabricate host identifiers, bypass a guard, or …"); a negation inside a condition ("If the tests do not pass, skip the
// approval") is neither, so the approval's skip is still found.
const NEGATION = /\b(?:never|not|don'?t|doesn'?t|mustn'?t|cannot|can'?t|no|nor|without|avoid|refuse to|forbidden to|prohibited from)\b[^.!?,;\n]{0,24}$/iu;
const OPENING_NEGATION = /^(?:never|do not|don'?t|must not|mustn'?t|you must not|you never|no agent|nothing)\b[^;:]*$/iu;
function negated(line, index, prefix = '') {
  // A sentence wrapped over lines: what came before it on the lines above counts (`prefix`).
  const before = `${prefix ? `${prefix} ` : ''}${line.slice(0, index)}`;
  if (NEGATION.test(before.slice(-48))) return true;
  const clause = before.split(/[.!?;:](?=\s|$)/u).at(-1).replace(/^[\s>*_#\-–—•\d.()[\]]*/u, '');
  return OPENING_NEGATION.test(clause);
}

const BYPASS_VERBS = String.raw`(?:skip(?:ping)?|bypass(?:ing)?|circumvent|get(?:ting)? around|work around|disable|turn(?:ing)? off|switch off|deactivate|suppress|ignore|override)`;
const SFLOW_OBJECTS = String.raw`(?:approvals?|approval gates?|sign-?offs?|(?:the |code |human )review(?: step)?|hooks?|sf ?guard|sflow guard|guardrails?|singularity[- ]flow|sflow)`;
const RULE_BYPASS = Object.freeze([
  // Skip the approval, turn off the hooks, get around SF Guard.
  new RegExp(String.raw`\b${BYPASS_VERBS}\b[^.\n]{0,40}?\b${SFLOW_OBJECTS}\b`, 'iu'),
  // Approve, merge or publish on its own.
  /\b(?:approve|merge|publish|push|deploy|release|submit)\b[^.\n]{0,40}?(?:\bon your own\b|\bby yourself\b|\byourself\b|\bwithout (?:asking|waiting|(?:any |an |a |the )?(?:approvals?|reviews?|confirmation|permission|sign-?off|person|user|human)))/iu,
  // Edit SFlow's own configuration, hooks or records.
  /\b(?:edit|modify|change|write|delete|remove|rewrite|overwrite|update|create|touch|replace|truncate|append to|push to|commit to|merge into)\b[^\n]{0,60}?(?<![\w./-])(?:singularity\/|sflow\/config\b|\.github\/hooks\b|\.git\/singularity-flow\b|imports\.lock\.yml\b|agents\.lock\.yml\b)/iu,
  // Ignore earlier or system instructions.
  /\b(?:ignore|disregard|forget|override|overrule)\b[^.\n]{0,30}?\b(?:previous|prior|earlier|above|preceding|all other|any other|system|original|your)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|rules|directions|guidance|guidelines|messages?|constraints)\b/iu
]);

const PRIVATE_READS = Object.freeze([
  /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\/home\/[\w.-]+|\/Users\/[\w.-]+)[/\\]\.(?:ssh|aws|gnupg|kube|netrc|npmrc|pypirc|git-credentials|docker[/\\]config\.json|config[/\\]gh)\b/iu,
  /\bgh\s+auth\s+(?:token|status\s+(?:-t|--show-token))\b/iu,
  /\bprintenv\b/iu,
  /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain)\b/iu,
  /\bsecret-tool\s+lookup\b/iu,
  /\bcmdkey\s+\/list\b/iu,
  /\b(?:cat|type|print|echo|dump|reveal|send|upload)\b[^\n]{0,30}?(?<![\w.-])\.env(?![\w.-])/iu,
  /\b(?:print|echo|cat|dump|reveal|exfiltrate|leak)\b[^.\n]{0,40}?\b(?:credentials?|access tokens?|auth tokens?|api tokens?|tokens|passwords?|secrets?|private keys?|api keys?|keychains?)\b/iu,
  /\b(?:send|upload|post|copy)\b[^.\n]{0,20}?\b(?:your|the user'?s|the person'?s|all|every)\b[^.\n]{0,20}?\b(?:credentials?|tokens|passwords?|secrets?|private keys?|api keys?)\b/iu
]);

const SHELLS = String.raw`(?:sh|bash|zsh|ksh|dash|fish|python[23]?|perl|ruby|node|iex|invoke-expression|pwsh|powershell)`;
const PIPE_TO_SHELL = Object.freeze([
  new RegExp(String.raw`\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?${SHELLS}\b`, 'iu'),
  /\b(?:sh|bash|zsh)\s+(?:-\w+\s+)*["']?\$\(\s*(?:curl|wget)\b/iu,
  /\b(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget)\b/iu,
  /\b(?:iex|invoke-expression)\s*\(?\s*\(?\s*(?:iwr|irm|invoke-webrequest|invoke-restmethod|new-object\s+(?:system\.)?net\.webclient)\b/iu
]);

/**
 * SFlow's approve, decision, override, pause, guard and confirmation commands, named in a text: a look, not a block. Naming
 * one is how an SFlow-aware skill tells the person what to run ("ask the person to run /sf-approve"); only a person can say
 * whether a line runs it for them. Its read-only forms are not flagged at all (`pause status`, `guard status|report|
 * remote-check`, `approvals`, `decision show`, `decisions` with no answer, `appeal show|list|preflight|evidence-prepare`).
 */
const SFLOW_COMMAND = /\b(?:singularity-flow|sflow)\s+(approve|approvals|decision|decisions|decide|override|appeal|pause|guard|confirm)\b(?:\s+([a-z][a-z-]*))?/giu;
const SFLOW_ROUTE = /(?<![\w-])\/sf-(?:approve|decide|review-decide|override|appeal|pause|guard|gate|confirm)\b/iu;
// `pause off` only gives SFlow's guidance back, so it gets around nothing either.
const READ_ONLY_FORMS = Object.freeze({ pause: ['status', 'off'], guard: ['status', 'report', 'remote-check'], decision: ['show'],
  appeal: ['show', 'list', 'preflight', 'evidence-prepare'] });
const SFLOW_ROUTE_READ = /^\/sf-pause\s+(?:status|off)\b/iu;
function sflowCommandIn(line, prefix = '') {
  for (const match of line.matchAll(SFLOW_COMMAND)) {
    const [command, action] = [match[1].toLowerCase(), match[2]?.toLowerCase() ?? null];
    // `approvals` only reads; `decisions` reads unless the line gives it an answer.
    if (command === 'approvals' || (command === 'decisions' && (!action || !['record', 'undo'].includes(action)) && !/--(?:choose|answers)\b/u.test(line))) continue;
    if (action && (READ_ONLY_FORMS[command] ?? []).includes(action)) continue;
    if (!negated(line, match.index, prefix)) return match;
  }
  for (const match of line.matchAll(new RegExp(SFLOW_ROUTE.source, 'giu'))) {
    if (!SFLOW_ROUTE_READ.test(line.slice(match.index)) && !negated(line, match.index, prefix)) return match;
  }
  return null;
}

// An HTML comment that only steers a tool (a linter, a table of contents, a region) holds no instructions.
// SFlow's own template markers are written `sflow:` (`<!-- sflow:guidance … -->`) as well as `sflow-`. A block-level check
// still reads every line of a comment, as it reads every other line.
const TOOL_COMMENT = /^\s*(?:markdownlint|prettier|eslint|vale|textlint|cspell|spell|toc\b|end ?toc|#?region|#?endregion|sflow[-:]|@ac:|lint)/iu;
const HIDDEN_MARKUP = Object.freeze([
  /<[a-z][^>]*\s(?:hidden|aria-hidden\s*=\s*["']?true)(?=[\s>=/])/iu,
  /display\s*:\s*none/iu,
  /visibility\s*:\s*hidden/iu,
  /style\s*=\s*["'][^"']*(?:font-size\s*:\s*0(?![.\d])|opacity\s*:\s*0(?![.\d]))/iu
]);

const ENCODED_PAYLOAD = Object.freeze([
  /[A-Za-z0-9+/]{200,}={0,2}/u,
  /\bdata:[\w.+-]+\/[\w.+-]+[;,]/iu
]);

const DATA_UPLOAD = Object.freeze([
  /\bcurl\b[^\n]*?\s(?:-d|--data(?:-raw|-binary|-urlencode|-ascii)?|-F|--form(?:-string)?|-T|--upload-file|--json)(?=[\s=]|$)/u,
  /\b(?:curl|http|https|xh|wget)\b[^\n]*?(?:-X\s*|--request[\s=]+|--method[\s=]+)(?:POST|PUT|PATCH)\b/iu,
  /\bwget\b[^\n]*?--post-(?:data|file)\b/iu,
  /\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b[^\n]*?-method\s+(?:post|put|patch)\b/iu,
  /\bPOST\b[^.\n]{0,30}?\bto\s+https?:\/\//u,
  /\b(?:nc|ncat|netcat)\s+\S+\s+\d+\s*</u
]);

const DESTRUCTIVE = Object.freeze([
  /\bgit\s+push\b[^\n]*?\s(?:--force(?:-with-lease)?|-f)(?=\s|$|[`"'])/u,
  /\bgit\s+reset\s+--hard\s+(?:@\{u(?:pstream)?\}|[\w.-]+\/[\w./-]+)/u,
  /\brm\s+(?:-[a-zA-Z]*(?:rf|fr)[a-zA-Z]*|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)\s+(?:--no-preserve-root\s+)?(?:\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?)(?=[\s"';`]|$)/u,
  /--no-verify\b/u
]);

const URL = /\bhttps?:\/\/([^\s/<>()"'`\]\\|]+)[^\s<>()"'`\]\\|]*/giu;

/** The host of a repository or index address, as an outside link is compared with it: `null` for a folder. */
export function addressHost(value) {
  const text = String(value ?? '').trim();
  const ssh = /^(?:ssh:\/\/)?[\w.-]+@([\w.-]+)[:/]/u.exec(text);
  if (ssh) return ssh[1].toLowerCase();
  try { return /^https?:/iu.test(text) ? new globalThis.URL(text).hostname.toLowerCase() : null; } catch { return null; }
}

/** The first match of any of `patterns` in `line` that is not negated, or null. */
function firstMatch(line, patterns, { negation = true, prefix = '' } = {}) {
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match && !(negation && negated(line, match.index, prefix))) return match;
  }
  return null;
}

/** One finding: its check, line, severity and words, the line as shown (spelled out, shortened) and its digest. */
function finding(check, number, raw, { shown = undefined, detail = null } = {}) {
  const text = shown === undefined ? spellInvisible(raw.trim()) : shown;
  return {
    check, severity: SAFETY_CHECKS[check], line: number, lineSha256: sha256(raw),
    text: text == null ? null : text.length > LINE_SHOWN ? `${text.slice(0, LINE_SHOWN - 1)}…` : text,
    words: `${CHECK_WORDS[check]}${detail ? `: ${detail}` : ''}`
  };
}

/**
 * The findings for `text` [OMK:REQ-030]: `{ checker, state, findings, blocks, looks, notes }`, each finding
 * `{ check, severity, line, lineSha256, text, words }`, blocks first, then by line. `state` is blocked, look or clean
 * (a note needs nothing). `ownHosts` are the marketplace's own hosts, never noted. `secrets: false` leaves the secret scan
 * to the caller that already ran it (an import refuses a secret with its own refusal first).
 */
export function checkImportText(text, { ownHosts = [], secrets = true } = {}) {
  const source = String(text ?? '');
  const lines = source.split('\n').map((line) => line.replace(/\r$/u, ''));
  const own = new Set(ownHosts.filter(Boolean).map((host) => String(host).toLowerCase()));
  const findings = [];
  const hosts = new Set();
  // The start of a sentence wrapped from the lines above ("Do not …, approve your own artifacts,\ndisable checks/hooks"):
  // its negation still reads on the next line. A blank line or a sentence's end starts again.
  let carried = '';
  lines.forEach((line, index) => {
    const number = index + 1;
    const prefix = carried;
    carried = !line.trim() || /^\s*(?:#|[-*>|]|\d+\.)\s/u.test(lines[index + 1] ?? '') ? ''
      : `${prefix ? `${prefix} ` : ''}${line.trim()}`.split(/[.!?](?=\s|$)/u).at(-1).slice(-240);
    const hidden = invisibleIn(line, { first: index === 0 });
    if (hidden.length) findings.push(finding('hidden-characters', number, line, { detail: hidden.join(' ') }));
    if (firstMatch(line, RULE_BYPASS, { prefix })) findings.push(finding('rule-bypass', number, line));
    if (firstMatch(line, PRIVATE_READS, { prefix })) findings.push(finding('credential-access', number, line));
    if (firstMatch(line, PIPE_TO_SHELL, { prefix })) findings.push(finding('pipe-to-shell', number, line));
    if (firstMatch(line, HIDDEN_MARKUP, { negation: false })) findings.push(finding('hidden-markup', number, line));
    if (firstMatch(line, ENCODED_PAYLOAD, { negation: false })) findings.push(finding('encoded-payload', number, line));
    if (firstMatch(line, DATA_UPLOAD, { prefix })) findings.push(finding('data-upload', number, line));
    if (firstMatch(line, DESTRUCTIVE, { prefix })) findings.push(finding('destructive-command', number, line));
    if (sflowCommandIn(line, prefix)) findings.push(finding('sflow-command', number, line));
    for (const match of line.matchAll(URL)) {
      // A sentence's own full stop or comma after a link is not part of its host.
      const host = match[1].replace(/[.,;:!?]+$/u, '').replace(/:\d+$/u, '').replace(/^[^@]*@/u, '').toLowerCase();
      if (own.has(host) || hosts.has(host)) continue;
      hosts.add(host);
      findings.push(finding('outside-link', number, line, { detail: host }));
    }
  });
  // An HTML comment that holds words, across lines: shown at its first line.
  for (const match of source.matchAll(/<!--([\s\S]*?)-->/gu)) {
    const body = match[1].trim();
    if (!body || TOOL_COMMENT.test(body) || body.split(/\s+/u).length < 3) continue;
    const number = source.slice(0, match.index).split('\n').length;
    if (!findings.some((entry) => entry.check === 'hidden-markup' && entry.line === number)) {
      findings.push(finding('hidden-markup', number, lines[number - 1], { detail: 'an HTML comment a reader of the page does not see' }));
    }
  }
  if (secrets) {
    for (const found of scanText(source, { path: 'imported text' }).filter((entry) => !entry.waived)) {
      if (findings.some((entry) => entry.check === 'secret' && entry.line === found.line)) continue;
      // Never the value: the line is named, not shown.
      findings.push(finding('secret', found.line, lines[found.line - 1] ?? '', { shown: null, detail: `${found.label} ${found.preview}`.trim() }));
    }
  }
  findings.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] || left.line - right.line
    || (left.check < right.check ? -1 : left.check > right.check ? 1 : 0));
  const of = (severity) => findings.filter((entry) => entry.severity === severity);
  const blocks = of('block'); const looks = of('look');
  return { checker: IMPORT_SAFETY_CHECKER, state: blocks.length ? 'blocked' : looks.length ? 'look' : 'clean', findings, blocks, looks, notes: of('note') };
}

/**
 * Several texts at once (an agent's agent.md and the skills it brings): `{ checker, state, texts, blocks, looks, notes }`,
 * each finding carrying the `text` name it was found in as `file`.
 */
export function checkImportTexts(entries = [], options = {}) {
  const texts = entries.map(({ name, text }) => ({ name, ...checkImportText(text, options) }));
  const all = (field) => texts.flatMap((entry) => entry[field].map((found) => ({ ...found, file: entry.name })));
  const blocks = all('blocks'); const looks = all('looks');
  return { checker: IMPORT_SAFETY_CHECKER, state: blocks.length ? 'blocked' : looks.length ? 'look' : 'clean', texts, blocks, looks, notes: all('notes') };
}

/** The look checks a person names with `--looked`, checked: each is one of LOOK_CHECKS. */
export function parseLookedChecks(values = []) {
  const named = [...new Set([values].flat().flatMap((value) => String(value ?? '').split(',')).map((value) => value.trim()).filter(Boolean))];
  const unknown = named.find((check) => !LOOK_CHECKS.includes(check));
  if (unknown) {
    throw new SingularityFlowError(`--looked names the look checks a preview listed (${LOOK_CHECKS.join(', ')}), not '${unknown}'.`, { code: 'IMPORT_SAFETY_LOOKED_INVALID',
      details: { nextAction: { command: 'singularity-flow imports', label: 'See what is imported here; preview the item again for its look checks.' } } });
  }
  return named.sort();
}

/**
 * What still needs the person's yes [OMK:REQ-031]: the look findings whose check `looked` does not name and whose line
 * the import's earlier record (`previous`, its `source.safety`) did not already look at, so a later update asks again
 * only for lines that changed. `record` is what the import record keeps once it is added: every look line, now looked at.
 */
export function safetyGate(result, { looked = [], previous = null } = {}) {
  const named = new Set(looked);
  const before = new Set((previous?.looked ?? []).map((entry) => `${entry.file ?? ''}\u0000${entry.check}\u0000${entry.lineSha256}`));
  const unlooked = result.looks.filter((entry) => !named.has(entry.check) && !before.has(`${entry.file ?? ''}\u0000${entry.check}\u0000${entry.lineSha256}`));
  const record = result.looks.length ? { checker: result.checker,
    looked: result.looks.map((entry) => ({ ...(entry.file ? { file: entry.file } : {}), check: entry.check, line: entry.line, lineSha256: entry.lineSha256 })) } : null;
  return { blocked: result.blocks, unlooked, checks: [...new Set(unlooked.map((entry) => entry.check))].sort(), record };
}

/** One finding as a person reads it: where, what, and the line itself with every invisible character spelled out. */
export function findingLine(entry) {
  const where = entry.file ? `${entry.file}, line ${entry.line}` : `Line ${entry.line}`;
  return `${where} (${entry.words})${entry.text ? `: ${entry.text}` : ''}`;
}

/** The lines a preview shows: blocks, then "Look at these lines", then the notes; empty when the text is clean. */
export function safetyLines(result) {
  const lines = [];
  if (result.blocks.length) lines.push(`${SAFETY_NAME} refuse it:`, ...result.blocks.map((entry) => `  ${findingLine(entry)}`));
  if (result.looks.length) lines.push('Look at these lines:', ...result.looks.map((entry) => `  ${findingLine(entry)}`));
  if (result.notes.length) lines.push(`Links to other sites: ${[...new Set(result.notes.map((entry) => entry.words.replace(/^[^:]*: /u, '')))].join(', ')}.`);
  return lines;
}

/** The marketplace-owned findings a block gives, so the feedback to its owners can carry them (MCR §6, OMK §10). */
export function safetyFeedbackFindings(result) {
  return result.blocks.map((entry) => ({ class: 'import-safety', owner: 'marketplace', check: entry.check, line: entry.line, ...(entry.file ? { file: entry.file } : {}),
    words: `${SAFETY_NAME} refuse ${entry.file ? `${entry.file}, ` : ''}line ${entry.line}: ${entry.words}.`,
    fix: entry.check === 'hidden-characters' ? 'Remove the hidden characters from that line.' : 'Rewrite that line so it does not ask an agent to do this.' }));
}

/**
 * The refusal of a blocked text [OMK:REQ-031]: IMPORT_SAFETY_BLOCKED, every block line shown. `nextAction` is the way on
 * the caller has (the marketplace's other items, or its feedback); nothing was imported.
 */
export function safetyBlocked(result, { label = 'This text', nextAction = null } = {}) {
  return new SingularityFlowError([`${SAFETY_NAME} refuse ${label}: nothing was imported.`, ...result.blocks.map((entry) => `  ${findingLine(entry)}`),
    `These are ${SAFETY_NAME}, not a security review. Tell the item's owner; a newer version without these lines can be imported.`].join('\n'),
  { code: 'IMPORT_SAFETY_BLOCKED', details: { checker: result.checker, findings: result.blocks, ...(nextAction ? { nextAction } : {}) } });
}

/**
 * The refusal of a text whose look lines nobody looked at yet [OMK:REQ-031]: IMPORT_SAFETY_LOOK_NEEDED, with the lines
 * and `command`, the same command with `--looked`, which the person's yes runs. With no command (Workflow Studio's own
 * apply), the words name the review card's checkbox and the flag.
 */
export function safetyLookNeeded(gate, { label = 'This text', command = null }) {
  return new SingularityFlowError([`${label} has lines to look at before it is added (${SAFETY_NAME}):`, ...gate.unlooked.map((entry) => `  ${findingLine(entry)}`),
    command ? 'Look at them; when you are sure, add it with --looked.'
      : `Look at them; when you are sure, tick "I looked at these lines" on its review card (or add it with --looked ${gate.checks.join(',')}).`].join('\n'),
  { code: 'IMPORT_SAFETY_LOOK_NEEDED', details: { checks: gate.checks, findings: gate.unlooked,
    ...(command ? { nextAction: { command, label: 'Add it once the person has looked at these lines and said yes.' } } : {}) } });
}

/** What a catalog row or a page says of an installed text's checks: null when it is clean. */
export function safetyFlag(result, { what = 'it' } = {}) {
  if (!result || result.state === 'clean') return null;
  const first = (result.state === 'blocked' ? result.blocks : result.looks)[0];
  const where = first ? ` (line ${first.line}: ${first.words})` : '';
  return {
    state: result.state, checker: result.checker,
    words: result.state === 'blocked'
      ? `${SAFETY_NAME} refuse ${what}${where}: tasks do not offer it, and it stays here until a person updates or removes it.`
      : `${SAFETY_NAME} ask a person to look at ${what}${where}.`,
    findings: [...result.blocks, ...result.looks].map(({ check, severity, line, words }) => ({ check, severity, line, words }))
  };
}
