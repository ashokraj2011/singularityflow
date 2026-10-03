/**
 * Jest and Vitest test declarations read as data [E2G-015].
 *
 * Pure and bounded: the source is tokenized, never imported, transpiled or executed. A declaration
 * is a `describe`/`test`/`it` call at the start of a statement, at the top level or directly inside
 * a literal `describe` body, whose title is a string literal (single, double or substitution-free
 * template quotes). Its identity is the file, the describe path and the title; its revision is the
 * SHA-256 of the whole call, body included, so weakening an assertion is a new revision.
 *
 * Everything the reader cannot pin down is reported against the declaration it affects, never
 * guessed: dynamic titles, declarations inside loops, conditions or helper functions, parameterized
 * suites, `.each` tables that are not literal, titles that cannot tell instances apart, inverted
 * tests (`.failing`, `.fails`) and duplicate identities. A tag that is not directly above a
 * declaration is reported as not attached.
 */
import { createHash } from 'node:crypto';

import { acceptanceTagsInComment, adjacentWhitespace } from './tags.mjs';

export const JAVASCRIPT_DECLARATION_SCHEMA = 'javascript-test-v2';
const MAX_SOURCE_CHARACTERS = 1024 * 1024;
const MAX_TOKENS = 400_000;
const TEST_FUNCTIONS = new Set(['test', 'it', 'xit', 'xtest', 'fit']);
const SUITE_FUNCTIONS = new Set(['describe', 'suite', 'xdescribe', 'fdescribe']);
const MODIFIERS = new Set([
  'only', 'skip', 'todo', 'concurrent', 'sequential', 'each', 'for', 'failing', 'fails', 'skipIf', 'runIf'
]);
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else',
  'yield', 'await'
]);
const REGEX_AFTER_PUNCTUATION = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '...', '?.'
]);
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'with', 'switch', 'catch']);
const CONTINUATION = new Set(['.', ',', '(', '[', '=', '+', '-', '*', '/', '%', '?', ':', '&', '|', '^', '<', '>', '!', '~', '=>', '...', '?.']);
const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$‌‍]/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** A canonical, key-sorted JSON form for identity digests. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

class LexError extends Error {
  constructor(code, message, line) {
    super(message);
    this.code = code;
    this.line = line;
  }
}

function decodeStringLiteral(raw) {
  // The body between quotes, with the escapes a test title realistically uses resolved. Anything
  // else that is escaped keeps its escaped character, which is what the runtime would print.
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/gsu, (match, escape) => {
    if (/^\r?\n$/u.test(escape)) return '';
    if (escape.startsWith('u{')) return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16));
    if (escape.startsWith('u') && escape.length === 5) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (escape.startsWith('x') && escape.length === 3) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[escape] ?? escape;
  });
}

/**
 * Tokenize JavaScript or TypeScript. Comments are kept as tokens so tags can be attached; JSX text
 * and other shapes the lexer cannot read safely end in a LexError rather than a guess.
 */
export function tokenizeJavaScript(source) {
  const text = String(source ?? '');
  const tokens = [];
  let index = 0;
  let line = 1;
  // One frame per open template expression: the brace depth at which its `}` resumes the template.
  const templateFrames = [];
  let braceDepth = 0;
  const previousSignificant = () => {
    for (let cursor = tokens.length - 1; cursor >= 0; cursor -= 1) {
      if (tokens[cursor].type !== 'comment') return tokens[cursor];
    }
    return null;
  };
  const push = (token) => {
    if (tokens.length >= MAX_TOKENS) throw new LexError('JAVASCRIPT_SOURCE_LIMIT_EXCEEDED', `more than ${MAX_TOKENS} tokens`, line);
    tokens.push(token);
  };
  const scanTemplate = (start, startLine, openedHere) => {
    // Reads template characters from `index` until the closing backtick or a `${`.
    let raw = '';
    while (index < text.length) {
      const character = text[index];
      if (character === '\\') { raw += text.slice(index, index + 2); if (text[index + 1] === '\n') line += 1; index += 2; continue; }
      if (character === '`') {
        index += 1;
        return { closed: true, raw };
      }
      if (character === '$' && text[index + 1] === '{') {
        index += 2;
        return { closed: false, raw };
      }
      if (character === '\n') line += 1;
      raw += character;
      index += 1;
    }
    throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated template literal starting on line ${startLine}`, startLine);
  };
  if (text.startsWith('#!')) {
    const end = text.indexOf('\n');
    index = end < 0 ? text.length : end;
  }
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '\n') { line += 1; index += 1; continue; }
    if (/\s/u.test(character)) { index += 1; continue; }
    const start = index;
    const startLine = line;
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      const stop = end < 0 ? text.length : end;
      push({ type: 'comment', kind: 'line', text: text.slice(index, stop), start, end: stop, line: startLine });
      index = stop;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated block comment on line ${startLine}`, startLine);
      const body = text.slice(index, end + 2);
      line += (body.match(/\n/gu) ?? []).length;
      push({ type: 'comment', kind: 'block', text: body, start, end: end + 2, line: startLine });
      index = end + 2;
      continue;
    }
    if (character === '\'' || character === '"') {
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== character) {
        if (text[cursor] === '\\') {
          if (text[cursor + 1] === '\n') line += 1;
          cursor += 2;
          continue;
        }
        if (text[cursor] === '\n') throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated string on line ${startLine}`, startLine);
        cursor += 1;
      }
      if (cursor >= text.length) throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated string on line ${startLine}`, startLine);
      push({ type: 'string', value: decodeStringLiteral(text.slice(index + 1, cursor)), start, end: cursor + 1, line: startLine });
      index = cursor + 1;
      continue;
    }
    if (character === '`') {
      index += 1;
      const part = scanTemplate(start, startLine);
      if (part.closed) {
        push({ type: 'template', raw: part.raw, value: decodeStringLiteral(part.raw), substitutions: false, start, end: index, line: startLine });
      } else {
        push({ type: 'template', raw: part.raw, value: null, substitutions: true, start, end: null, line: startLine, open: true });
        templateFrames.push({ depth: braceDepth, token: tokens.at(-1) });
      }
      continue;
    }
    if (character === '}' && templateFrames.length && templateFrames.at(-1).depth === braceDepth) {
      // The `}` of a template expression: resume reading the template's characters.
      index += 1;
      const frame = templateFrames.at(-1);
      const part = scanTemplate(start, startLine);
      frame.token.raw += `\${…}${part.raw}`;
      if (part.closed) {
        templateFrames.pop();
        frame.token.end = index;
        delete frame.token.open;
      }
      continue;
    }
    if (character === '/') {
      const previous = previousSignificant();
      const regexAllowed = !previous
        || (previous.type === 'punct' && REGEX_AFTER_PUNCTUATION.has(previous.value))
        || (previous.type === 'identifier' && REGEX_AFTER_KEYWORD.has(previous.value));
      if (regexAllowed) {
        let cursor = index + 1;
        let inClass = false;
        while (cursor < text.length) {
          const current = text[cursor];
          if (current === '\n') throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated regular expression on line ${startLine}`, startLine);
          if (current === '\\') { cursor += 2; continue; }
          if (current === '[') inClass = true;
          else if (current === ']') inClass = false;
          else if (current === '/' && !inClass) break;
          cursor += 1;
        }
        if (cursor >= text.length) throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated regular expression on line ${startLine}`, startLine);
        cursor += 1;
        while (cursor < text.length && /[A-Za-z]/u.test(text[cursor])) cursor += 1;
        push({ type: 'regex', start, end: cursor, line: startLine });
        index = cursor;
        continue;
      }
    }
    if (IDENTIFIER_START.test(character)) {
      let cursor = index + character.length;
      while (cursor < text.length && IDENTIFIER_PART.test(text[cursor])) cursor += 1;
      push({ type: 'identifier', value: text.slice(index, cursor), start, end: cursor, line: startLine });
      index = cursor;
      continue;
    }
    if (/[0-9]/u.test(character) || (character === '.' && /[0-9]/u.test(next ?? ''))) {
      let cursor = index + 1;
      while (cursor < text.length && /[0-9A-Za-z_.]/u.test(text[cursor])) cursor += 1;
      push({ type: 'number', start, end: cursor, line: startLine });
      index = cursor;
      continue;
    }
    const three = text.slice(index, index + 3);
    const two = text.slice(index, index + 2);
    const value = three === '...' ? three : ['=>', '?.'].includes(two) && !(two === '?.' && /[0-9]/u.test(text[index + 2] ?? '')) ? two : character;
    if (value === '{') braceDepth += 1;
    if (value === '}') braceDepth -= 1;
    push({ type: 'punct', value, start, end: index + value.length, line: startLine });
    index += value.length;
  }
  if (templateFrames.length) {
    throw new LexError('JAVASCRIPT_SOURCE_UNREADABLE', `unterminated template expression starting on line ${templateFrames.at(-1).token.line}`, templateFrames.at(-1).token.line);
  }
  return tokens;
}

/** The index of the first token after `index` that is not inside it (template expressions). */
function nextOutside(tokens, index) {
  const end = tokens[index]?.end ?? tokens[index]?.start;
  let next = index + 1;
  while (next < tokens.length && tokens[next].start < end) next += 1;
  return next;
}

function matchingClose(tokens, openIndex) {
  const open = tokens[openIndex].value;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'punct') continue;
    if (['(', '[', '{'].includes(token.value)) depth += 1;
    else if ([')', ']', '}'].includes(token.value)) {
      depth -= 1;
      if (depth === 0) return token.value === close ? index : -1;
    }
  }
  return -1;
}

/** The count of a literal `.each` table, or null when the set is dynamic. */
function literalTableCount(tokens, table) {
  if (!table) return null;
  if (table.kind === 'template') {
    if (table.token.substitutions === false && !table.token.raw.trim()) return 0;
    const rows = table.token.raw.split(/\r?\n/u).map((row) => row.trim()).filter(Boolean);
    return rows.length > 1 ? rows.length - 1 : null;
  }
  const [open, close] = table.range;
  if (tokens[open + 1]?.value !== '[') return null;
  const arrayClose = matchingClose(tokens, open + 1);
  if (arrayClose < 0 || arrayClose !== close - 1) return null;
  let depth = 0;
  let elements = 0;
  let sawElement = false;
  for (let index = open + 2; index < arrayClose; index += 1) {
    const token = tokens[index];
    if (token.type === 'punct' && ['(', '[', '{'].includes(token.value)) depth += 1;
    if (token.type === 'punct' && [')', ']', '}'].includes(token.value)) depth -= 1;
    if (depth === 0 && token.type === 'punct' && token.value === '...') return null;
    if (depth === 0 && token.type === 'punct' && token.value === ',') {
      if (sawElement) elements += 1;
      sawElement = false;
      continue;
    }
    if (token.type !== 'comment') sawElement = true;
  }
  return elements + (sawElement ? 1 : 0);
}

/**
 * An anchored pattern for the titles an `.each` template prints: printf placeholders and `$name`
 * interpolations match anything, everything else is literal. Null when the template has no literal
 * text left to tell its instances from other tests.
 */
export function eachTitlePattern(template) {
  const parts = [];
  let literal = '';
  const flush = () => { if (literal) parts.push({ literal }); literal = ''; };
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];
    if (character === '%' && template[index + 1] === '%') { literal += '%'; index += 1; continue; }
    if (character === '%' && /[sdifjoOp#$]/u.test(template[index + 1] ?? '')) { flush(); parts.push({ any: true }); index += 1; continue; }
    if (character === '$' && /[A-Za-z_{#]/u.test(template[index + 1] ?? '')) {
      flush();
      parts.push({ any: true });
      index += 1;
      if (template[index] === '{') { while (index < template.length && template[index] !== '}') index += 1; continue; }
      while (index + 1 < template.length && /[A-Za-z0-9_.#]/u.test(template[index + 1])) index += 1;
      continue;
    }
    literal += character;
  }
  flush();
  if (!parts.some((part) => part.literal?.trim())) return null;
  const pattern = parts.map((part) => part.literal != null ? part.literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : '.*?').join('');
  return `^${pattern}$`;
}

function attachedComments(tokens, firstIndex, source) {
  const attached = [];
  let boundary = tokens[firstIndex].start;
  for (let index = firstIndex - 1; index >= 0 && tokens[index].type === 'comment'; index -= 1) {
    if (!adjacentWhitespace(source.slice(tokens[index].end, boundary))) break;
    attached.unshift(index);
    boundary = tokens[index].start;
  }
  return attached;
}

function statementStart(tokens, index, source, controlBodyStart) {
  if (controlBodyStart.has(index)) return { start: true, controlled: true };
  let previous = index - 1;
  while (previous >= 0 && tokens[previous].type === 'comment') previous -= 1;
  if (previous < 0) return { start: true, controlled: false };
  const before = tokens[previous];
  if (before.type === 'punct' && [';', '{', '}'].includes(before.value)) return { start: true, controlled: false };
  if (before.type === 'identifier' && ['else', 'do'].includes(before.value)) return { start: true, controlled: true };
  const newline = /\n/u.test(source.slice(before.end ?? before.start, tokens[index].start));
  if (!newline) return { start: false, controlled: false };
  if (before.type === 'punct' && CONTINUATION.has(before.value)) return { start: false, controlled: false };
  return { start: true, controlled: false };
}

function gap(code, message) {
  return { code, message };
}

/**
 * Read one test file's declarations. Never throws for the file's content: an unreadable file is a
 * file gap, and every tag in it is then reported as unattached with that reason.
 */
export function scanJavaScriptDeclarations(source, { sourcePath, framework }) {
  const text = String(source ?? '');
  const empty = { schema: JAVASCRIPT_DECLARATION_SCHEMA, sourcePath, framework, declarations: [], unattachedTags: [], fileGaps: [] };
  if (text.length > MAX_SOURCE_CHARACTERS) {
    return { ...empty, fileGaps: [gap('JAVASCRIPT_SOURCE_LIMIT_EXCEEDED', `the file exceeds ${MAX_SOURCE_CHARACTERS} characters`)] };
  }
  let tokens;
  try { tokens = tokenizeJavaScript(text); } catch (error) {
    if (!(error instanceof LexError)) throw error;
    const unattachedTags = [];
    for (const [index, raw] of text.split(/\r?\n/u).entries()) {
      const ids = /^\s*(?:\/\/|\/\*|\*)/u.test(raw) ? acceptanceTagsInComment(raw) : [];
      if (ids.length) unattachedTags.push({ line: index + 1, clauseIds: ids, code: error.code, message: `the file cannot be read as data: ${error.message}` });
    }
    return { ...empty, unattachedTags, fileGaps: [gap(error.code, error.message)] };
  }
  const declarations = [];
  const attachedCommentIndexes = new Set();
  // Open bracket frames. A `{` frame records whether it is the body of a literal describe, which
  // is the only block (besides the file) where a declaration has a static identity.
  const frames = [];
  const pendingSuiteBodies = new Map();
  const pendingSuiteCalls = new Set();
  const controlBodyStart = new Set();
  const controlHeaders = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'comment') continue;
    if (token.type === 'punct' && ['(', '[', '{'].includes(token.value)) {
      const suite = pendingSuiteBodies.get(index) ?? null;
      const controlled = token.value === '{' && controlBodyStart.has(index);
      frames.push({ value: token.value, index, suite, suiteCall: pendingSuiteCalls.has(index), controlled });
      // A control keyword's header `(`: the statement after its `)` is conditional.
      let previous = index - 1;
      while (previous >= 0 && tokens[previous].type === 'comment') previous -= 1;
      if (token.value === '(' && tokens[previous]?.type === 'identifier' && CONTROL_KEYWORDS.has(tokens[previous].value)) {
        const close = matchingClose(tokens, index);
        if (close > 0) controlHeaders.set(close, true);
      }
      continue;
    }
    if (token.type === 'punct' && [')', ']', '}'].includes(token.value)) {
      frames.pop();
      if (controlHeaders.has(index)) {
        let next = index + 1;
        while (next < tokens.length && tokens[next].type === 'comment') next += 1;
        if (next < tokens.length) controlBodyStart.add(next);
      }
      continue;
    }
    if (token.type === 'identifier' && ['else', 'do'].includes(token.value)) {
      let next = index + 1;
      while (next < tokens.length && tokens[next].type === 'comment') next += 1;
      if (next < tokens.length && !(tokens[next].type === 'identifier' && tokens[next].value === 'if')) controlBodyStart.add(next);
      continue;
    }
    if (token.type !== 'identifier' || !(TEST_FUNCTIONS.has(token.value) || SUITE_FUNCTIONS.has(token.value))) continue;
    const position = statementStart(tokens, index, text, controlBodyStart);
    if (!position.start) continue;
    // The callee chain: `test.skip.each(table)(title, fn)`, `it.skipIf(x)(title, fn)`, …
    const modifiers = [];
    let table = null;
    let cursor = index + 1;
    let malformed = false;
    while (tokens[cursor]?.type === 'punct' && tokens[cursor].value === '.' && tokens[cursor + 1]?.type === 'identifier') {
      const modifier = tokens[cursor + 1].value;
      if (!MODIFIERS.has(modifier)) { malformed = true; break; }
      modifiers.push(modifier);
      cursor += 2;
      if (['each', 'for'].includes(modifier)) {
        if (tokens[cursor]?.type === 'template') { table = { kind: 'template', token: tokens[cursor] }; cursor = nextOutside(tokens, cursor); }
        else if (tokens[cursor]?.value === '(') {
          const close = matchingClose(tokens, cursor);
          if (close < 0) { malformed = true; break; }
          table = { kind: 'call', range: [cursor, close] };
          cursor = close + 1;
        } else { malformed = true; break; }
      } else if (['skipIf', 'runIf'].includes(modifier)) {
        if (tokens[cursor]?.value !== '(') { malformed = true; break; }
        const close = matchingClose(tokens, cursor);
        if (close < 0) { malformed = true; break; }
        cursor = close + 1;
      }
    }
    if (malformed || tokens[cursor]?.type !== 'punct' || tokens[cursor].value !== '(') continue;
    const callOpen = cursor;
    const callClose = matchingClose(tokens, callOpen);
    if (callClose < 0) continue;
    const titleToken = tokens[callOpen + 1];
    const literalTitle = titleToken && (titleToken.type === 'string' || (titleToken.type === 'template' && titleToken.substitutions === false))
      && [',', ')'].includes(tokens[callOpen + 2]?.value);
    const title = literalTitle ? titleToken.value : null;
    const isSuite = SUITE_FUNCTIONS.has(token.value);
    // Static only at the top level or directly in a describe body: every open frame is either a
    // literal describe call's parentheses or its body.
    const dynamicContext = position.controlled || frames.some((frame) => !frame.suite && !frame.suiteCall);
    const enclosingSuites = frames.filter((frame) => frame.suite).map((frame) => frame.suite);
    if (isSuite) {
      pendingSuiteCalls.add(callOpen);
      // The body brace: the first `{` after `=>` or a function header's `)` inside this call.
      for (let scan = callOpen + 1; scan < callClose; scan += 1) {
        const candidate = tokens[scan];
        if (candidate.type !== 'punct' || candidate.value !== '{') continue;
        let previous = scan - 1;
        while (previous > callOpen && tokens[previous].type === 'comment') previous -= 1;
        if (['=>', ')'].includes(tokens[previous]?.value)) {
          pendingSuiteBodies.set(scan, {
            title,
            dynamic: !literalTitle || modifiers.includes('each') || modifiers.includes('for') || dynamicContext
              || enclosingSuites.some((suite) => suite.dynamic),
            path: [...enclosingSuites.map((suite) => suite.title), title],
            skipped: token.value === 'xdescribe' || modifiers.includes('skip') || enclosingSuites.some((suite) => suite.skipped),
            focused: token.value === 'fdescribe' || modifiers.includes('only')
          });
          break;
        }
      }
    }
    const comments = attachedComments(tokens, index, text);
    const clauseIds = [...new Set(comments.flatMap((commentIndex) => acceptanceTagsInComment(tokens[commentIndex].text)))];
    if (isSuite) {
      if (clauseIds.length) {
        for (const commentIndex of comments) attachedCommentIndexes.add(commentIndex);
        // A tag on a describe ties the criterion to a group, not to one test.
        declarations.push({
          suiteTag: true, line: token.line, clauseIds,
          gaps: [gap('AC_TAG_ON_SUITE', 'the tag is above a describe block; place it directly above the test that verifies the criterion')]
        });
      }
      continue;
    }
    for (const commentIndex of comments) attachedCommentIndexes.add(commentIndex);
    let end = tokens[callClose].end;
    if (tokens[callClose + 1]?.type === 'punct' && tokens[callClose + 1].value === ';') end = tokens[callClose + 1].end;
    const start = token.start;
    const gaps = [];
    if (!literalTitle) gaps.push(gap('DYNAMIC_TITLE', 'the test title is not a string literal'));
    if (dynamicContext) gaps.push(gap('DECLARATION_IN_DYNAMIC_CONTEXT', 'the test is declared inside a loop, condition, function or expression rather than at the top level or directly in a describe body'));
    if (enclosingSuites.some((suite) => suite.dynamic)) gaps.push(gap('DYNAMIC_SUITE', 'an enclosing describe has a dynamic title or is parameterized'));
    if (modifiers.includes('failing') || modifiers.includes('fails')) gaps.push(gap('INVERTED_TEST', 'the test is expected to fail, so a pass would mean its body failed'));
    const parameterized = modifiers.includes('each') || modifiers.includes('for');
    let parameters = null;
    if (parameterized) {
      const count = literalTableCount(tokens, table);
      const pattern = title ? eachTitlePattern(title) : null;
      parameters = { kind: count == null ? 'dynamic' : 'static', count, titlePattern: pattern };
      if (count == null) gaps.push(gap('DYNAMIC_PARAMETER_SET', 'the parameter table is not a literal, so the expected instances are unknown'));
      else if (count === 0) gaps.push(gap('EMPTY_PARAMETER_SET', 'the parameter table is empty'));
      if (title && !pattern) gaps.push(gap('PARAMETER_TITLE_NOT_DISTINCT', 'the title template has no literal text to tell its instances apart'));
    }
    const suitePath = enclosingSuites.map((suite) => suite.title);
    const identity = { schema: JAVASCRIPT_DECLARATION_SCHEMA, framework, sourcePath, suitePath, name: title };
    declarations.push({
      ...identity,
      logicalTestId: `sha256:${sha256(canonical(identity))}`,
      line: token.line,
      span: { start, end },
      declarationSha256: `sha256:${sha256(Buffer.from(text.slice(start, end), 'utf8'))}`,
      modifiers,
      skipped: ['xit', 'xtest'].includes(token.value) || modifiers.includes('skip') || modifiers.includes('todo')
        || enclosingSuites.some((suite) => suite.skipped),
      focused: token.value === 'fit' || modifiers.includes('only') || enclosingSuites.some((suite) => suite.focused),
      parameters,
      clauseIds,
      gaps
    });
  }
  // Duplicate identities in one file are ambiguous for every copy.
  const byIdentity = new Map();
  for (const declaration of declarations.filter((entry) => !entry.suiteTag && entry.name != null)) {
    const key = canonical([declaration.suitePath, declaration.name]);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), declaration]);
  }
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    for (const declaration of group) declaration.gaps.push(gap('DUPLICATE_DECLARATION', `${group.length} tests in this file share the describe path and title`));
  }
  // A parameterized title pattern that also matches a sibling test's title is ambiguous.
  for (const declaration of declarations.filter((entry) => entry.parameters?.titlePattern)) {
    const pattern = new RegExp(declaration.parameters.titlePattern, 'u');
    const rival = declarations.find((other) => other !== declaration && !other.suiteTag
      && canonical(other.suitePath) === canonical(declaration.suitePath) && other.name != null && pattern.test(other.name));
    if (rival) declaration.gaps.push(gap('PARAMETER_TITLE_NOT_DISTINCT', `the title template also matches the test '${rival.name}'`));
  }
  const unattachedTags = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'comment' || attachedCommentIndexes.has(index)) continue;
    const clauseIds = acceptanceTagsInComment(token.text);
    if (clauseIds.length) {
      unattachedTags.push({ line: token.line, clauseIds, code: 'AC_TAG_NOT_ATTACHED', message: 'the tag is not directly above a test declaration' });
    }
  }
  return {
    ...empty,
    declarations: declarations.filter((entry) => !entry.suiteTag),
    unattachedTags: [
      ...unattachedTags,
      ...declarations.filter((entry) => entry.suiteTag).map((entry) => ({ line: entry.line, clauseIds: entry.clauseIds, code: entry.gaps[0].code, message: entry.gaps[0].message }))
    ].sort((left, right) => left.line - right.line)
  };
}
