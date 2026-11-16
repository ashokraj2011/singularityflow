#!/usr/bin/env node
/**
 * Plain-language check: the words a person reads stay plain.
 *
 * In a real Story (2026-11-16) the owner could not understand what SFlow showed: a card counting
 * "1 still need a decision from you" without naming it, "No recommendation" three times, a next step
 * telling them to "review the guarded code successor boundary; preserve the published generation",
 * a refusal that a step "must have a published generation" with only generic help as its way out.
 *
 * This reads the sources of every text a person reads as syntax trees, never by running a command:
 * narration headlines, refusal messages and the steps that get past them, next-step labels and
 * reasons, decision-list texts, the VS Code views' own words and the skills' fixed lines. Each text
 * is checked for:
 *   (a) jargon: engine terms a person cannot be expected to know (JARGON);
 *   (b) length: a cap per kind (KINDS), set from the measured distribution so the worst fail;
 *   (c) required parts: a refusal names a way out that is not generic help (unless the command
 *       itself was malformed), and a decision item recommends something;
 *   (d) no counts without names: "2 still need a decision" says which two, or lists them;
 *   (e) a step's generation is a "version", never a "draft" (DRAFT_FOR_VERSION).
 * A text that may keep a term or its length says so in EXCEPTIONS, with a reason.
 *
 * Existing violations are the committed baseline (benchmarks/plain-language/baseline.json), which may
 * only shrink: test/plain-language.test.mjs fails on a new violation, and on a fixed one until the
 * baseline is regenerated. A rewritten text is a new text: it passes, or it names its exception.
 *
 *   node scripts/plain-language-check.mjs [--json] [--list] [--distribution] [--inventory] [--update]
 *
 * --update rewrites the baseline from the sources; --list prints every violation with its line; --distribution
 * prints each kind's measured lengths; --inventory where each kind's texts live.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_PATH = 'benchmarks/plain-language/baseline.json';

/**
 * What each kind of text is, and its length cap in characters, slots counted as their name in
 * braces. Measured on main e1574fa2d (--distribution, 2026-11-16), as texts, then median / 75th / 90th /
 * 95th / 99th percentile / longest:
 *   narration     317  72 /  99 / 129 / 145 / 197 / 231  cap 160 (9 over)
 *   refusal      7561  64 /  88 / 134 / 171 / 278 / 860  cap 200 (230 over)
 *   refusal-step  262 117 / 169 / 241 / 264 / 440 / 615  cap 200 (40 over)
 *   next-label    480  49 /  73 / 106 / 134 / 221 / 428  cap 72 (121 over): "1. Now — " and the label fit 80 columns
 *   next-reason   343  96 / 149 / 232 / 267 / 577 / 680  cap 200 (52 over)
 *   decision      633  60 /  90 / 121 / 143 / 230 / 302  cap 160 (18 over)
 *   vscode-view  5573  45 /  78 / 120 / 156 / 245 / 949  cap 160 (250 over)
 *   skill-line    600  29 /  44 /  44 /  44 /  44 / 152  cap 120 (1 over)
 * Each cap fails the longest texts of its kind and leaves room for every ordinary one.
 */
export const KINDS = Object.freeze({
  narration: { cap: 160, what: 'a command\'s headline or WHY line (src/narration/messages.mjs)' },
  refusal: { cap: 200, what: 'a refusal\'s message, which the person reads and act.said repeats' },
  'refusal-step': { cap: 200, what: 'a step out of a refusal (its label is act.do.reason)' },
  'next-label': { cap: 72, what: 'a next step\'s one-line label ("Now — <label>")' },
  'next-reason': { cap: 200, what: 'a next step\'s or continuation\'s reason' },
  decision: { cap: 160, what: 'a decision-list item\'s words: its title, why, recommendation and choices' },
  'vscode-view': { cap: 160, what: 'a VS Code view\'s own words around engine text' },
  'skill-line': { cap: 120, what: 'a fixed line a skill tells the agent to say' }
});

/**
 * Engine words a person cannot be expected to know. The first fourteen are the owner's examples and
 * the engine vocabulary named with them; the rest were the most frequent engine terms in a scan of the
 * person-facing texts (2026-11-16). A text that explains its term, or that only a maintainer reads,
 * names its exception in EXCEPTIONS.
 */
export const JARGON = Object.freeze([
  ['generation', /\bgenerations?\b/iu, 'say "version" ("version 2", "the published version", "a new version")'],
  ['successor', /\bsuccessors?\b/iu, 'say "the next version"'],
  ['retained', /\bretain(?:ed|s|ing)?\b|\bretention\b/iu, 'say "kept" or "saved"'],
  ['binding', /\bbindings?\b/iu, 'say which Story or session it is tied to'],
  ['packet', /\bpackets?\b/iu, 'say what it holds: "the review", "the answers"'],
  ['kernel', /\bkernel\b/iu, 'say "SFlow"'],
  ['lifecycle event', /\blifecycle events?\b/iu, 'say what happened'],
  ['projection', /\bprojections?\b/iu, 'say "view" or "summary"'],
  ['attestation', /\battestations?\b/iu, 'say "signed record"'],
  ['provenance', /\bprovenance\b/iu, 'say "where it came from"'],
  ['ledger', /\bledgers?\b/iu, 'say "record"'],
  ['sidecar', /\bsidecars?\b/iu, 'say what the file is for'],
  ['staging', /\bstag(?:ing|ed)\b/iu, 'say "not saved yet"'],
  ['published generation', /\bpublished generation\b/iu, 'say "the published version"'],
  ['aggregate', /\baggregates?\b/iu, 'say "the Story\'s record"'],
  ['invariant', /\binvariants?\b/iu, 'say what must stay true'],
  ['envelope', /\benvelopes?\b/iu, 'say what it holds'],
  ['admission', /\badmi(?:ssion|tted)\b/iu, 'say "allowed"'],
  ['canonical', /\bcanonical\b/iu, 'say "the usual" or name it'],
  ['rail', /\brail\b/iu, 'say "the Story\'s steps"'],
  ['digest', /\bdigests?\b/iu, 'name what was reviewed, never a hash'],
  ['transport', /\btransport\b/iu, 'say "sending" or "sync"'],
  ['durable', /\bdurable\b/iu, 'say "saved"'],
  ['deterministic', /\bdeterministic(?:ally)?\b/iu, 'say "always the same" or drop it'],
  ['preimage', /\bpreimages?\b/iu, 'say "the files as they were"'],
  ['payload', /\bpayloads?\b/iu, 'say what it holds'],
  ['hydrate', /\b(?:de)?hydrat(?:e|ed|es|ing|ion)\b/iu, 'say "fetch" or "fill in"'],
  ['idempotent', /\bidempoten(?:t|cy)\b/iu, 'say "safe to run again"'],
  ['oracle', /\boracles?\b/iu, 'say "check"']
].map(([term, pattern, instead]) => Object.freeze({ term, pattern, instead })));

/**
 * A step's generation is a "version" ("version 2", "the published version"); a "draft" is only the private,
 * unpublished working copy (2026-11-16). "draft 2", "draft {generation}", "draft N+1" and "the
 * published draft" use the one word for the other. The verb ("cannot draft {step}") and other drafts
 * ("discard draft {#number}" of configuration) are not matched.
 */
export const DRAFT_FOR_VERSION = /\bdraft\s+(?:\d+\b|N(?:\+1)?\b|\{#?[^}]*(?:generation|next)[^}]*\})|\bpublished\s+drafts?\b/iu;

/** Codes whose refusal is about the command's own words: help with the command's forms is the way out. */
export const MALFORMED_COMMAND = /(?:^|_)(?:USAGE|ARGUMENTS?|OPTIONS?|FLAGS?|UNKNOWN_SUBCOMMAND|UNKNOWN_COMMAND|COMMAND_UNKNOWN|UNKNOWN_OPTION|ID_INVALID)(?:_|$)/u;
/** The fallback steps every refusal gets when nothing names its way out. */
export const GENERIC_STEP_IDS = Object.freeze(new Set(['command-help', 'diagnose-repository', 'recommended-next']));
/** The detail fields a throw site names its own way out with (refusal-remediation.mjs explicitCommands). */
const ROUTE_DETAILS = new Set(['diagnosticAction', 'nextAction', 'discardAction', 'remapAction', 'reviewAction', 'nextCommand',
  'recoveryCommand', 'repairCommand', 'command', 'retry', 'retryCommand', 'recoveryCommands', 'actions', 'gate', 'findings',
  'route', 'routes', 'next', 'remedy', 'repair', 'continuation', 'nextActions']);

/**
 * Texts that may keep what a rule flags, each with why. `file` and `includes` find the text; `rules`
 * are the rule IDs it may keep (jargon:<term>, a space as a hyphen; length; count-without-name;
 * draft-for-version). An exception that no longer matches a text fails the test, so this list stays exact.
 */
export const EXCEPTIONS = Object.freeze([
  ...[['src/commands/secrets.mjs', 'check what is staged before each commit'],
    ['src/git.mjs', 'Commit or unstage those paths'],
    ['src/editor.mjs', 'unrelated files are already staged']].map(([file, includes]) => ({ file, includes, rules: ['jargon:staging'],
    reason: 'Git\'s own word for what the next commit holds; the person fixes it with Git' }))
].map(Object.freeze));

const SKIP_DIRECTORIES = new Set(['node_modules', 'generated', 'dist', 'out', '.git']);

async function filesUnder(root, relative, extensions) {
  const found = [];
  const walk = async (directory) => {
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) await walk(child); }
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(child);
    }
  };
  await walk(relative);
  return found;
}

const COUNT_NAME = /^(?:count|counts|open|total|remaining|pending|failed|have|need|n|number|missing|settled|recorded|done|passed|unchecked|left|later|waiting|blocked|skipped|added|removed|changed|issues|items|findings|steps|files|gaps|holds)$|(?:Count|Total|Number|Size)$/u;
const LIST_CALLS = /^(?:join|listWords|list|names|joinNames|humanList|sentenceList|words)$/u;

function lastName(node) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return lastName(node.expression);
  if (ts.isCallExpression(node)) return lastName(node.expression);
  if (ts.isNonNullExpression?.(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression?.(node)) return lastName(node.expression);
  return null;
}

/**
 * A text as a person reads it: literal words kept, every slot as `{name}`, a count as `{#name}` and a
 * joined list as `{list}`. Each branch of a condition is a variant of its own (at most MAX_VARIANTS):
 * the longest is the text, the length rule reads it; the count rule reads every variant; the jargon
 * rule reads every literal piece.
 */
const MAX_VARIANTS = 8;
const longestFirst = (values) => [...new Set(values)].sort((left, right) => right.length - left.length).slice(0, MAX_VARIANTS);
const joined = (lefts, rights) => longestFirst(lefts.flatMap((left) => rights.map((right) => left + right)));
export function render(node, sourceFile) {
  const pieces = [];
  const walk = (current) => {
    if (!current) return [''];
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) { pieces.push(current.text); return [current.text]; }
    if (ts.isTemplateExpression(current)) {
      pieces.push(current.head.text);
      let variants = [current.head.text];
      for (const span of current.templateSpans) {
        variants = joined(variants, walk(span.expression));
        pieces.push(span.literal.text);
        variants = variants.map((variant) => variant + span.literal.text);
      }
      return variants;
    }
    if (ts.isParenthesizedExpression(current) || (ts.isAsExpression && ts.isAsExpression(current))) return walk(current.expression);
    if (ts.isConditionalExpression(current)) return longestFirst([...walk(current.whenTrue), ...walk(current.whenFalse)]);
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      if (operator === ts.SyntaxKind.PlusToken) return joined(walk(current.left), walk(current.right));
      if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(operator)) return longestFirst([...walk(current.left), ...walk(current.right)]);
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return longestFirst([...walk(current.right), '']);
      return ['{…}'];
    }
    if (ts.isCallExpression(current)) {
      const callee = lastName(current.expression);
      if (callee && LIST_CALLS.test(callee)) return ['{list}'];
      // slot(s.count, '0'), String(x), oneLine(x): the slot is the first argument.
      if (callee && /^(?:slot|String|oneLine|escape|safe|capitalized|plural|bold|code|quote|style|detail)$/u.test(callee) && current.arguments[0]) {
        const inner = current.arguments[0];
        if (ts.isStringLiteralLike(inner) || ts.isTemplateExpression(inner)) return walk(inner);
        return [slotOf(inner)];
      }
      return [`{${callee ?? '…'}}`];
    }
    return [slotOf(current)];
  };
  const slotOf = (expression) => {
    if (ts.isPropertyAccessExpression(expression) && ['length', 'size'].includes(expression.name.text)) {
      return `{#${lastName(expression.expression) ?? 'count'}}`;
    }
    const name = lastName(expression);
    if (!name) return '{…}';
    return COUNT_NAME.test(name) ? `{#${name}}` : `{${name}}`;
  };
  const [text, ...variants] = walk(node);
  return { text, variants, pieces: pieces.filter((piece) => /[a-z]/iu.test(piece)) };
}

// A word is a run of letters on its own: `sflow.story.evidence` and `singularity/portfolio.yml` are not three words.
const words = (text) => text.replace(/\{[^}]*\}/gu, ' ').split(/\s+/u)
  .filter((token) => /^[("'“‘]?[A-Za-z][A-Za-z'’-]*[)"'”’.,;:!?…]*$/u.test(token) && /[A-Za-z]{2}/u.test(token));
/** Reads as words to a person: three or more of them, not a command, a path, a pattern or code. */
export function sentenceLike(text) {
  const trimmed = text.trim();
  if (words(trimmed).length < 3) return false;
  if (/^(?:singularity-flow|sflow|git|npm|node|gh)\s|^\/sf-|^--|^[./~]|^\^|^https?:/u.test(trimmed)) return false;
  if (/[;{]\s*[a-z-]+\s*:\s*[^;]+;/u.test(trimmed)) return false; // CSS
  if (/^[\w.$]+\(|=>|\bfunction\b|\bconst\b|\breturn\b/u.test(trimmed)) return false; // code
  return true;
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

const lineOf = (sourceFile, node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
const propertyNameOf = (node) => (node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null);
const objectProperty = (object, name) => (object && ts.isObjectLiteralExpression(object)
  ? object.properties.find((entry) => ts.isPropertyAssignment(entry) && propertyNameOf(entry.name) === name) ?? null : null);
const isLiteralText = (node) => node && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)
  || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
  || (ts.isConditionalExpression(node) && (isLiteralText(node.whenTrue) || isLiteralText(node.whenFalse)))
  || ts.isParenthesizedExpression(node) && isLiteralText(node.expression));

/** Literals nested in a template are part of that template's text, not texts of their own. */
function insideTemplate(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTemplateSpan(current) || ts.isTemplateExpression(current)) return true;
    if (ts.isBlock(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/** HTML in a view's template: each text between its tags is a text of its own. */
function htmlSegments(text) {
  if (!/<[a-z][\w-]*[\s>/]/iu.test(text)) return [text];
  return text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/giu, '<>')
    .split(/<[^>]*>/u).map((segment) => segment.replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

// Next-step builders whose reason (or label) is a positional argument: file, callee, argument index, kind.
const POSITIONAL = Object.freeze([
  ['src/nextsteps.mjs', 'action', 3, 'next-reason'],
  ['src/source-review-continuation.mjs', 'action', 2, 'next-reason'],
  ['src/phase-mutation-contract.mjs', 'route', 1, 'next-reason'],
  ['src/phase-resolution.mjs', 'route', 3, 'next-reason'],
  ['src/refusal-remediation.mjs', 'step', 1, 'refusal-step']
]);
// Files whose every sentence is person-facing wording.
const WORDING_FILES = Object.freeze([
  [/^src\/narration\/messages\.mjs$/u, 'narration'],
  [/^src\/decision-(?:list|advice|plain)\.mjs$/u, 'decision'],
  [/^plugin\/extensions\/decisions\/[^/]+\.mjs$/u, 'decision'],
  [/^apps\/vscode\/src\/views\/.+\.ts$/u, 'vscode-view']
]);
const ACTION_SIBLINGS = new Set(['command', 'argv', 'skill', 'copilotCommand', 'shell']);

/** Every text a person reads in one source file. */
export function textsOfSource(file, source) {
  const sourceFile = parse(file, source);
  const texts = [];
  const claimed = new Set();
  const add = (kind, node, extra = {}) => {
    if (!node || claimed.has(node.pos)) return;
    claimed.add(node.pos);
    // A choice between whole sentences is a text per sentence: shortening one never renames the others.
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    if (ts.isConditionalExpression(inner)) {
      for (const branch of [inner.whenTrue, inner.whenFalse]) if (isLiteralText(branch)) add(kind, branch, extra);
      return;
    }
    const { text, variants, pieces } = render(node, sourceFile);
    const segments = kind === 'vscode-view' ? htmlSegments(text) : [text];
    const tidy = (value) => value.replace(/\s+/gu, ' ').trim();
    for (const segment of segments) {
      const value = tidy(segment);
      if (!extra.always && !sentenceLike(value)) continue;
      texts.push({ kind, file, line: lineOf(sourceFile, node), text: value, ...(segments.length > 1 ? { pieces: [value] }
        : { pieces, variants: variants.map(tidy).filter((variant) => variant && variant !== value) }), ...extra.facts });
    }
    // Every literal inside belongs to this text.
    const claim = (child) => { claimed.add(child.pos); ts.forEachChild(child, claim); };
    ts.forEachChild(node, claim);
  };
  const positional = POSITIONAL.filter(([owner]) => owner === file);
  const wording = WORDING_FILES.find(([pattern]) => pattern.test(file))?.[1] ?? null;
  const visit = (node) => {
    if (ts.isNewExpression(node) && lastName(node.expression) === 'SingularityFlowError' && node.arguments?.[0] && isLiteralText(node.arguments[0])) {
      const options = node.arguments[1];
      const code = objectProperty(options, 'code')?.initializer;
      const details = objectProperty(options, 'details')?.initializer;
      const detailKeys = details && ts.isObjectLiteralExpression(details)
        ? details.properties.map((entry) => (ts.isShorthandPropertyAssignment(entry) ? entry.name.text
          : ts.isSpreadAssignment(entry) ? '...' : propertyNameOf(entry.name))).filter(Boolean)
        : details ? ['...'] : [];
      add('refusal', node.arguments[0], { always: true, facts: {
        code: code && ts.isStringLiteralLike(code) ? code.text : code ? '…' : null,
        routed: detailKeys.some((key) => key === '...' || ROUTE_DETAILS.has(key))
      } });
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : null;
      for (const [, name, index, kind] of positional) {
        if (callee === name && node.arguments[index] && isLiteralText(node.arguments[index])) add(kind, node.arguments[index], { always: true });
      }
    }
    // An item that recommends nothing: decision-advice.mjs says so with none(<what the person must weigh>).
    if (file === 'src/decision-advice.mjs' && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'none'
        && node.arguments[0] && isLiteralText(node.arguments[0])) {
      add('decision', node.arguments[0], { always: true, facts: { noRecommendation: true } });
    }
    if (file === 'src/nextsteps.mjs' && ts.isFunctionDeclaration(node) && node.name?.text === 'nextActionLabel') {
      const returns = (child) => {
        if (ts.isReturnStatement(child) && child.expression && isLiteralText(child.expression)) add('next-label', child.expression, { always: true });
        ts.forEachChild(child, returns);
      };
      returns(node);
    }
    // An action object: its reason (or detail) and label sit beside its command, argv or skill.
    if (ts.isObjectLiteralExpression(node) && node.properties.some((entry) => ACTION_SIBLINGS.has(propertyNameOf(entry.name)))) {
      for (const [name, kind] of [['reason', 'next-reason'], ['detail', 'next-reason'], ['label', 'next-label']]) {
        const value = objectProperty(node, name)?.initializer;
        if (value && isLiteralText(value)) add(kind, value);
      }
    }
    if (wording && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && !insideTemplate(node)
        && !ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)
        && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      add(wording, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return texts;
}

/** A skill's fixed lines: the quoted sentences it tells the agent to say or show. */
export function textsOfSkill(file, source) {
  const texts = [];
  const body = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u)?.[0] ?? '';
  const skipped = body.split('\n').length - 1;
  source.split('\n').forEach((line, index) => {
    if (index < skipped) return;
    for (const match of line.matchAll(/(?:"|“)([^"“”\n]{12,400})(?:"|”)/gu)) {
      const text = match[1].replace(/`([^`]*)`/gu, '{$1}').trim();
      if (sentenceLike(text) && !/^[a-z_.]+$/u.test(text)) texts.push({ kind: 'skill-line', file, line: index + 1, text, pieces: [match[1].replace(/`[^`]*`/gu, ' ')] });
    }
  });
  return texts;
}

/** Every person-facing text, in a stable order. */
export async function collectTexts(root = ROOT) {
  const sources = [...await filesUnder(root, 'src', ['.mjs']), ...await filesUnder(root, 'plugin/extensions', ['.mjs']),
    ...await filesUnder(root, 'apps/vscode/src/views', ['.ts'])];
  const texts = [];
  for (const file of sources) texts.push(...textsOfSource(file, await readFile(path.join(root, file), 'utf8')));
  for (const file of await filesUnder(root, 'plugin/skills', ['SKILL.md'])) texts.push(...textsOfSkill(file, await readFile(path.join(root, file), 'utf8')));
  return texts;
}

/** What a text reads as with slots, code and commands taken out: what the jargon rule looks at. */
function prose(text) {
  return text.replace(/\{[^}]*\}/gu, ' ').replace(/`[^`]*`/gu, ' ')
    .replace(/(?:singularity-flow|sflow)(?:\s+[^\s.;,)]+){1,6}/gu, ' ')
    .replace(/(?:^|\s)--?[a-z][\w-]*/gu, ' ')
    .replace(/[\w-]+(?:[./_=][\w-]+)+/gu, ' ');
}

// (d) What a person is asked to act on, counted: "{#open} still need a decision", "{#waiting} approvals are waiting".
const COUNTED_ASK = /^\s*(?:of\s+\{#?\w+\}\s+)?(?:[\w'-]+\s+){0,3}?(?:still\s+)?(?:need|needs|wait|waits|waiting|awaiting|remain|remains|open|settled|unanswered|pending|block|blocks|blocking|hold|holds|decisions?|questions?|findings?|issues?|items?|blockers?|obligations?|gaps?|approvals?|answers?|choices?)\b/iu;

/** The rules a text breaks: rule IDs, before exceptions. */
export function textViolations(entry, { routedCodes = new Set() } = {}) {
  const found = [];
  const reading = [entry.text, ...(entry.pieces ?? [])].map(prose).join(' \n ');
  // A rule ID has no space: the baseline lists a text's rules space-separated.
  for (const { term, pattern } of JARGON) if (pattern.test(reading)) found.push(`jargon:${term.replaceAll(' ', '-')}`);
  const cap = KINDS[entry.kind]?.cap;
  if (cap && entry.text.length > cap) found.push('length');
  if ([entry.text, ...(entry.variants ?? []), ...(entry.pieces ?? [])].some((value) => DRAFT_FOR_VERSION.test(value.replace(/`[^`]*`/gu, ' ')))) {
    found.push('draft-for-version');
  }
  // (d) A count of what waits on the person with nothing named: no list, no ": {name}", not followed by its list.
  const counts = [entry.text, ...(entry.variants ?? [])].some((variant) => [...variant.matchAll(/\{#\w+\}/gu)].some((count) => {
    // The sentence the count is in names them: a list, ": {name}", "(…)", or it ends in ":" before its list.
    const [after = '', next = ''] = variant.slice(count.index + count[0].length).split(/(?<=[.!?])\s/u);
    const named = /\{list\}/u.test(after) || /^\{list\}/u.test(next) || /[:(]\s*\{(?!#)[^}]+\}/u.test(after) || /:\s*$/u.test(after)
      || /\b(?:named|listed|below|these|each of them)\b/iu.test(after);
    return !named && COUNTED_ASK.test(after);
  }));
  if (counts) found.push('count-without-name');
  // (c) A refusal names its own way out, unless the command itself was malformed: its code has a route, or the
  // throw site names one in its details. One with no code can only ever get the generic help.
  if (entry.kind === 'refusal' && !entry.routed && entry.code !== '…' && !(entry.code && MALFORMED_COMMAND.test(entry.code))
      && !(entry.code && routedCodes.has(entry.code))) found.push('generic-route');
  // (c) A decision item says what it recommends.
  if (entry.kind === 'decision' && (entry.noRecommendation || /^No recommendation\b/u.test(entry.text))) found.push('no-recommendation');
  return found;
}

function exceptionFor(entry, rule) {
  return EXCEPTIONS.find((exception) => exception.file === entry.file && entry.text.includes(exception.includes)
    && exception.rules.includes(rule)) ?? null;
}

/**
 * The codes whose refusal names its own way out: a plan built for the code alone, with no details,
 * leads somewhere other than the generic help, or refusal-remediation.mjs names the code.
 */
export async function routedRefusalCodes(codes, root = ROOT) {
  const module = await import(pathToFileURL(path.join(root, 'src/refusal-remediation.mjs')).href);
  const remediation = await readFile(path.join(root, 'src/refusal-remediation.mjs'), 'utf8');
  const named = new Set(remediation.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/gu) ?? []);
  const routed = new Set();
  for (const code of codes) {
    if (named.has(code)) { routed.add(code); continue; }
    let plan = null;
    try {
      const error = Object.assign(new Error('refused'), { code, details: {} });
      plan = module.refusalRemediationPlan(error, []);
    } catch { plan = null; }
    if ((plan?.steps ?? []).some((step) => step && !GENERIC_STEP_IDS.has(step.id))) routed.add(code);
  }
  return routed;
}

const normalized = (text) => text.replace(/\{[^}]*\}/gu, '{}').replace(/\s+/gu, ' ').trim();
export const textKey = (entry) => `${entry.kind}|${entry.file}|${createHash('sha256').update(normalized(entry.text)).digest('hex').slice(0, 12)}`;

/** Every text with the rules it breaks, after exceptions. */
export async function scan(root = ROOT) {
  const texts = await collectTexts(root);
  const codes = new Set(texts.filter((entry) => entry.kind === 'refusal' && entry.code && entry.code !== '…').map((entry) => entry.code));
  const routedCodes = await routedRefusalCodes(codes, root);
  const usedExceptions = new Set();
  const results = texts.map((entry) => {
    const rules = textViolations(entry, { routedCodes }).filter((rule) => {
      const exception = exceptionFor(entry, rule);
      if (exception) usedExceptions.add(exception);
      return !exception;
    });
    return { ...entry, key: textKey(entry), rules };
  });
  return { texts: results, unusedExceptions: EXCEPTIONS.filter((exception) => !usedExceptions.has(exception)) };
}

/**
 * The committed form. A coded refusal with no route is recorded by its code, one with no code by how many its file
 * throws, and every other violation by its text: file, then a hash of the words (slots as `{}`), then the rules it
 * breaks, with `×N` when the same words occur N times in that file. A text that changes is a new text.
 */
export function baselineOf({ texts }) {
  const unroutedCodes = new Set();
  const uncodedRefusals = {};
  const byText = {};
  const totals = {};
  const count = (rule, by = 1) => { const family = rule.split(':')[0]; totals[family] = (totals[family] ?? 0) + by; };
  for (const entry of texts) {
    const rules = entry.rules.filter((rule) => rule !== 'generic-route');
    if (entry.rules.includes('generic-route')) {
      count('generic-route');
      if (entry.code) unroutedCodes.add(entry.code);
      else uncodedRefusals[entry.file] = (uncodedRefusals[entry.file] ?? 0) + 1;
    }
    if (!rules.length) continue;
    for (const rule of rules) count(rule);
    const file = (byText[entry.file] ??= {});
    const hash = entry.key.split('|').at(-1);
    const was = file[hash] ? parseEntry(file[hash]) : { rules: [], n: 0 };
    file[hash] = formatEntry({ rules: [...new Set([...was.rules, ...rules])].sort(), n: was.n + 1 });
  }
  const sorted = (object) => Object.fromEntries(Object.entries(object).sort(([left], [right]) => left.localeCompare(right)));
  return {
    revision: 1,
    caps: Object.fromEntries(Object.entries(KINDS).map(([kind, { cap }]) => [kind, cap])),
    totals: sorted(totals),
    unroutedCodes: [...unroutedCodes].sort(),
    uncodedRefusals: sorted(uncodedRefusals),
    texts: sorted(Object.fromEntries(Object.entries(byText).map(([file, entries]) => [file, sorted(entries)])))
  };
}

const parseEntry = (value) => {
  const [, times, rules] = /^(?:(\d+)× )?(.*)$/u.exec(value);
  return { rules: rules.split(' ').filter(Boolean), n: Number(times ?? 1) };
};
const formatEntry = ({ rules, n }) => `${n > 1 ? `${n}× ` : ''}${rules.join(' ')}`;

/** What rose (a new violation, or more of one) and what fell, against a committed baseline. */
export function compare(baseline, current, texts = []) {
  const rose = [];
  const fell = [];
  const wording = (file, hash) => texts.find((entry) => entry.file === file && entry.key.endsWith(`|${hash}`));
  const said = (file, hash) => { const entry = wording(file, hash); return entry ? `${file}:${entry.line} "${entry.text}"` : `${file} (${hash})`; };
  const allowed = new Set(baseline.unroutedCodes ?? []);
  const now = new Set(current.unroutedCodes);
  for (const code of now) if (!allowed.has(code)) {
    const site = texts.find((entry) => entry.code === code && entry.rules.includes('generic-route'));
    rose.push(`generic-route: refusal ${code} has only generic help as its way out${site ? ` (${site.file}:${site.line})` : ''}`);
  }
  for (const code of allowed) if (!now.has(code)) fell.push(`generic-route: refusal ${code} now names its way out`);
  for (const file of new Set([...Object.keys(baseline.uncodedRefusals ?? {}), ...Object.keys(current.uncodedRefusals)])) {
    const [was, is] = [baseline.uncodedRefusals?.[file] ?? 0, current.uncodedRefusals[file] ?? 0];
    if (is > was) rose.push(`generic-route: ${file} throws ${is} refusals with no code and no way out (was ${was}); give each a code and a route`);
    else if (is < was) fell.push(`generic-route: ${file} throws ${is} refusals with no code and no way out (was ${was})`);
  }
  for (const file of new Set([...Object.keys(baseline.texts ?? {}), ...Object.keys(current.texts)])) {
    const [before, after] = [baseline.texts?.[file] ?? {}, current.texts[file] ?? {}];
    for (const [hash, value] of Object.entries(after)) {
      const [is, was] = [parseEntry(value), before[hash] ? parseEntry(before[hash]) : { rules: [], n: 0 }];
      const added = is.rules.filter((rule) => !was.rules.includes(rule));
      if (added.length || is.n > was.n) rose.push(`${(added.length ? added : is.rules).join(' ')}: ${said(file, hash)}`);
    }
    for (const [hash, value] of Object.entries(before)) {
      const [was, is] = [parseEntry(value), after[hash] ? parseEntry(after[hash]) : { rules: [], n: 0 }];
      const removed = was.rules.filter((rule) => !is.rules.includes(rule));
      if (removed.length || is.n < was.n) fell.push(`${(removed.length ? removed : was.rules).join(' ')}: ${file} (${hash})`);
    }
  }
  return { rose, fell };
}

const quantile = (values, q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
/** Each kind's measured lengths: count, median, 90th, 95th and 99th percentile, the longest. */
export function distribution(texts) {
  const result = {};
  for (const kind of Object.keys(KINDS)) {
    const lengths = texts.filter((entry) => entry.kind === kind).map((entry) => entry.text.length).sort((left, right) => left - right);
    if (!lengths.length) { result[kind] = { texts: 0 }; continue; }
    result[kind] = { texts: lengths.length, p50: quantile(lengths, 0.5), p75: quantile(lengths, 0.75), p90: quantile(lengths, 0.9), p95: quantile(lengths, 0.95),
      p99: quantile(lengths, 0.99), max: lengths.at(-1), cap: KINDS[kind].cap, over: lengths.filter((length) => length > KINDS[kind].cap).length };
  }
  return result;
}

/** Where each kind lives: files and texts per kind. */
export function inventory(texts) {
  const result = {};
  for (const entry of texts) {
    const kind = (result[entry.kind] ??= { texts: 0, files: {} });
    kind.texts += 1;
    kind.files[entry.file] = (kind.files[entry.file] ?? 0) + 1;
  }
  return result;
}

async function main(argv) {
  const result = await scan();
  const current = baselineOf(result);
  if (argv.includes('--update')) {
    await mkdir(path.join(ROOT, path.dirname(BASELINE_PATH)), { recursive: true });
    await writeFile(path.join(ROOT, BASELINE_PATH), `${JSON.stringify(current, null, 1)}\n`);
    console.log(`Wrote ${BASELINE_PATH}: ${JSON.stringify(current.totals)}.`);
    return 0;
  }
  if (argv.includes('--distribution')) { console.log(JSON.stringify(distribution(result.texts), null, 2)); return 0; }
  if (argv.includes('--inventory')) {
    const counted = inventory(result.texts);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(counted).map(([kind, entry]) => [kind, { texts: entry.texts,
      files: Object.keys(entry.files).length, top: Object.entries(entry.files).sort((left, right) => right[1] - left[1]).slice(0, 8) }])), null, 2));
    return 0;
  }
  if (argv.includes('--list')) {
    for (const entry of result.texts.filter((candidate) => candidate.rules.length)) console.log(`${entry.file}:${entry.line} [${entry.rules.join(' ')}] ${entry.text}`);
    return 0;
  }
  const baseline = JSON.parse(await readFile(path.join(ROOT, BASELINE_PATH), 'utf8'));
  const { rose, fell } = compare(baseline, current, result.texts);
  const stale = result.unusedExceptions.map((exception) => `${exception.file}: "${exception.includes}" matches no text that needs it`);
  if (argv.includes('--json')) console.log(JSON.stringify({ rose, fell, stale, totals: current.totals }, null, 2));
  else {
    for (const line of rose) console.log(`new: ${line}`);
    for (const line of fell) console.log(`fixed: ${line}`);
    for (const line of stale) console.log(`stale exception: ${line}`);
    console.log(`${rose.length} new, ${fell.length} fixed${fell.length ? ' (lock them in with --update)' : ''}; totals ${JSON.stringify(current.totals)}.`);
  }
  return rose.length || stale.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
