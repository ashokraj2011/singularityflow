/**
 * Public functions, methods and classes in a source file, and whether each carries a doc comment.
 *
 * Pure and deliberately lexical: comments and strings are masked so a declaration is only found in
 * code, and a doc comment is recognised by each language's own convention — JSDoc/TSDoc, Python
 * docstrings, Javadoc, KDoc, PHPDoc, `///` in C#, Rust and Swift, a Go comment directly above, and
 * `#` lines in Ruby. It is not a parser. Its answers feed advisories that never block, so a missed
 * or extra declaration costs a reviewer a glance, never a publication.
 *
 * A comment made only of Singularity Flow traceability tags (`@clause:…`, `@ac:…`) documents
 * nothing and does not count.
 */
import path from 'node:path';
import { maskPolyglotNonCode } from './world-model/extract/adapters/polyglot-lexical.mjs';

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp',
  '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.php': 'php', '.rb': 'ruby'
});

/** Source languages without a recogniser yet: counted, never guessed at. */
const UNSUPPORTED_SOURCE = new Set(['.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm', '.scala', '.dart', '.lua', '.r', '.clj', '.ex', '.exs', '.erl', '.fs', '.vb']);

export function documentationLanguage(filePath) {
  const name = String(filePath ?? '');
  if (/\.d\.[cm]?ts$/iu.test(name)) return null; // declaration files describe, they do not implement
  return LANGUAGE_BY_EXTENSION[path.extname(name).toLowerCase()] ?? null;
}

export function unsupportedSourceLanguage(filePath) {
  return UNSUPPORTED_SOURCE.has(path.extname(String(filePath ?? '')).toLowerCase());
}

/**
 * Mask comments and strings in JavaScript or TypeScript. A `/` starts a regular expression where
 * an operand is expected, which is the usual lexical heuristic; template literals are masked whole.
 */
function maskScript(source) {
  const input = String(source);
  const output = [...input];
  let state = 'code';
  let quote = null;
  let escaped = false;
  let inClass = false;
  let previous = '';
  const blank = (index) => { if (input[index] !== '\n' && input[index] !== '\r') output[index] = ' '; };
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code'; else blank(index);
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') { blank(index); blank(index + 1); index += 1; state = 'code'; } else blank(index);
      continue;
    }
    if (state === 'string' || state === 'regex') {
      blank(index);
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (state === 'regex' && current === '[') inClass = true;
      else if (state === 'regex' && current === ']') inClass = false;
      else if (state === 'regex' && current === '/' && !inClass) { state = 'code'; previous = ')'; }
      else if (state === 'string' && current === quote) { state = 'code'; previous = ')'; }
      else if (current === '\n' && quote !== '`') state = 'code';
      continue;
    }
    if (current === '/' && next === '/') { blank(index); blank(index + 1); index += 1; state = 'line-comment'; continue; }
    if (current === '/' && next === '*') { blank(index); blank(index + 1); index += 1; state = 'block-comment'; continue; }
    if (current === '"' || current === "'" || current === '`') { quote = current; blank(index); state = 'string'; continue; }
    if (current === '/' && (previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous))) {
      blank(index); state = 'regex'; inClass = false; continue;
    }
    if (!/\s/u.test(current)) previous = current;
  }
  return output.join('');
}

function maskedSource(source, language) {
  if (language === 'javascript' || language === 'typescript') return maskScript(source);
  return maskPolyglotNonCode(source, language);
}

const TAG_ONLY = /^(?:@(?:clause|ac):\S+[\s,]*)+$/u;
const MAX_DECLARATION_LINE = 2000;

/** The text of a comment block once its markers are gone, and whether any of it documents. */
function commentHasProse(lines) {
  return lines.some((line) => {
    const text = line.trim()
      .replace(/^\/\*\*?/u, '').replace(/\*\/$/u, '').replace(/^\/\/[/!]?/u, '').replace(/^#+/u, '').replace(/^\*/u, '')
      .trim();
    return text !== '' && !TAG_ONLY.test(text);
  });
}

const DECORATOR = {
  javascript: /^\s*@/u, typescript: /^\s*@/u, java: /^\s*@/u, kotlin: /^\s*@/u, swift: /^\s*@/u,
  csharp: /^\s*\[/u, rust: /^\s*#!?\[/u, php: /^\s*#\[/u
};

/** A comment line holding only traceability tags, which `/sf-code` puts directly above a declaration. */
const TAG_LINE = /^(?:\/\/+|#+|\/\*+|\*)\s*(?:@(?:clause|ac):\S+[\s,]*)+(?:\*\/)?$/u;

/**
 * The first line of a decorator, annotation or attribute that ends on `end` and opens on an
 * earlier line, or null. Bracket counting over at most 40 lines; an advisory heuristic, not a parser.
 */
function decoratorStart(lines, end, decorator) {
  let balance = 0;
  for (let line = end; line >= 0 && end - line < 40; line -= 1) {
    for (const character of [...lines[line]].reverse()) {
      if (')]}'.includes(character)) balance += 1;
      else if ('([{'.includes(character)) balance -= 1;
    }
    if (decorator.test(lines[line])) return balance <= 0 && line < end ? line : null;
    if (balance <= 0) return null;
  }
  return null;
}

/**
 * The line above `index` where its doc comment would end: past traceability tag lines and every
 * decorator, annotation or attribute, including one written over several lines.
 */
function aboveLeadIn(lines, index, language) {
  const decorator = DECORATOR[language];
  let cursor = index - 1;
  while (cursor >= 0) {
    const text = lines[cursor].trim();
    if (TAG_LINE.test(text) || decorator?.test(lines[cursor])) { cursor -= 1; continue; }
    const start = decorator && /[)\]}]\s*[,;]?$/u.test(text) ? decoratorStart(lines, cursor, decorator) : null;
    if (start === null) break;
    cursor = start - 1;
  }
  return cursor;
}

/**
 * The doc comment immediately above `index` (skipping decorators, annotations and attributes), in
 * the given style, or null. Blank lines break the association, as they do for every tool that reads
 * these comments.
 */
function commentAbove(lines, index, language, style) {
  let cursor = aboveLeadIn(lines, index, language);
  if (cursor < 0) return null;
  const line = lines[cursor].trim();
  if (style === 'block' || style === 'block-or-slash') {
    if (line.endsWith('*/')) {
      let start = cursor;
      while (start >= 0 && !lines[start].includes('/*')) start -= 1;
      if (start >= 0 && lines[start].trim().startsWith('/**')) return lines.slice(start, cursor + 1);
      if (style === 'block') return null;
    }
  }
  const prefix = style === 'hash' ? '#' : style === 'line' ? '//' : '///';
  if (style === 'block-or-slash' || style === 'slash' || style === 'line' || style === 'hash') {
    const block = [];
    while (cursor >= 0 && lines[cursor].trim().startsWith(prefix)
        && !(style === 'hash' && /^#\s*(?:frozen_string_literal|encoding|rubocop)/u.test(lines[cursor].trim()))) {
      block.unshift(lines[cursor]);
      cursor -= 1;
    }
    return block.length ? block : null;
  }
  return null;
}

const STYLE = {
  javascript: 'block', typescript: 'block', java: 'block', kotlin: 'block', php: 'block',
  csharp: 'block-or-slash', rust: 'block-or-slash', swift: 'block-or-slash', go: 'line', ruby: 'hash'
};

/** The docstring opening a Python body: the first statement after the signature is a string. */
function pythonDocstring(lines, masked, index) {
  let depth = 0;
  let cursor = index;
  for (; cursor < masked.length; cursor += 1) {
    for (const character of masked[cursor]) {
      if ('([{'.includes(character)) depth += 1;
      else if (')]}'.includes(character)) depth -= 1;
    }
    if (depth <= 0 && masked[cursor].trimEnd().endsWith(':')) break;
  }
  for (let body = cursor + 1; body < lines.length; body += 1) {
    const text = lines[body].trim();
    if (!text) continue;
    if (!/^[rRuUbBfF]{0,2}("""|'''|"|')/u.test(text)) return null;
    const collected = [];
    for (let line = body; line < lines.length && collected.length < 200; line += 1) {
      collected.push(lines[line]);
      const joined = collected.join('\n').trim().replace(/^[rRuUbBfF]{0,2}/u, '');
      const delimiter = joined.startsWith('"""') ? '"""' : joined.startsWith("'''") ? "'''" : joined[0];
      if (joined.length > delimiter.length && joined.slice(delimiter.length).includes(delimiter)) break;
    }
    const inner = collected.join('\n').trim().replace(/^[rRuUbBfF]{0,2}("""|'''|"|')/u, '').replace(/("""|'''|"|')\s*$/u, '');
    return inner.split('\n');
  }
  return null;
}

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'new', 'else', 'do', 'try', 'with', 'await', 'typeof', 'void', 'delete', 'yield']);

function scriptDeclarations(masked) {
  const found = [];
  const classStack = [];
  let depth = 0;
  masked.forEach((line, index) => {
    const exported = line.match(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:(?:abstract|async)\s+)*(function\*?|class)\s*([A-Za-z_$][\w$]*)?/u);
    const arrow = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\(|[A-Za-z_$][\w$]*\s*=>)/u);
    if (exported) {
      const kind = exported[1] === 'class' ? 'class' : 'function';
      found.push({ index, kind, name: exported[2] ?? 'default' });
      if (kind === 'class') classStack.push({ depth, public: true });
    } else if (arrow) {
      found.push({ index, kind: 'function', name: arrow[1] });
    } else if (/^\s*(?:abstract\s+)?class\s+[A-Za-z_$]/u.test(line)) {
      classStack.push({ depth, public: false });
    } else {
      const inside = classStack.at(-1);
      // A class body holds only members, so a name followed by a parameter list is a method.
      const method = line.match(/^\s*((?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*)\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/u);
      if (inside?.public && depth === inside.depth + 1 && method && !CONTROL.has(method[2])
          && !/\b(?:private|protected)\b/u.test(method[1]) && !method[2].startsWith('#') && !method[2].startsWith('_')) {
        found.push({ index, kind: 'method', name: method[2] });
      }
    }
    for (const character of line) {
      if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        while (classStack.length && depth <= classStack.at(-1).depth) classStack.pop();
      }
    }
  });
  return found;
}

const DECLARATION_PATTERNS = Object.freeze({
  java: [
    [/^\s*public\s+(?:(?:abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/u, 'class'],
    [/^\s*public\s+(?:(?:static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?[\w$<>[\],.?]+\s+([A-Za-z_$][\w$]*)\s*\(/u, 'method'],
    [/^\s*public\s+([A-Z][\w$]*)\s*\(/u, 'constructor']
  ],
  kotlin: [
    [/^\s*(?!.*\b(?:private|internal|protected)\b)(?:(?:public|open|abstract|final|data|sealed|enum|inner|annotation|value|actual|expect)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/u, 'class'],
    [/^\s*(?!.*\b(?:private|internal|protected)\b)(?:(?:public|open|abstract|final|override|suspend|inline|operator|infix|tailrec|external|actual|expect)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/u, 'function']
  ],
  csharp: [
    [/^\s*public\s+(?:(?:static|abstract|sealed|partial|readonly|unsafe|new)\s+)*(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/u, 'class'],
    [/^\s*public\s+(?:(?:static|abstract|sealed|virtual|override|async|readonly|unsafe|new|extern|partial)\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*(?:<[^>]+>)?\s*\(/u, 'method']
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[[(]/u, 'function'],
    [/^type\s+([A-Z]\w*)\s+/u, 'type']
  ],
  rust: [
    [/^\s*pub\s+(?:(?:async|const|unsafe)\s+|extern\s+"[^"]*"\s+)*fn\s+([A-Za-z_]\w*)/u, 'function'],
    [/^\s*pub\s+(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/u, 'type']
  ],
  swift: [
    [/^\s*(?:public|open)\s+(?:(?:static|class|final|override|mutating|convenience|required|indirect)\s+)*(?:class|struct|protocol|enum|actor)\s+([A-Za-z_]\w*)/u, 'type'],
    [/^\s*(?:public|open)\s+(?:(?:static|class|final|override|mutating|convenience|required|nonmutating)\s+)*func\s+([A-Za-z_]\w*)/u, 'function'],
    [/^\s*(?:public|open)\s+(?:(?:convenience|required|override)\s+)*(init)\b/u, 'initializer']
  ],
  php: [
    [/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/u, 'class'],
    [/^\s*(?!.*\b(?:private|protected)\b)(?:(?:public|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/u, 'function']
  ]
});

function patternDeclarations(masked, language) {
  const found = [];
  masked.forEach((line, index) => {
    for (const [pattern, kind] of DECLARATION_PATTERNS[language]) {
      const match = line.match(pattern);
      if (match) { found.push({ index, kind, name: match[1] }); break; }
    }
  });
  return found;
}

function pythonDeclarations(masked) {
  const found = [];
  let publicClassIndent = null;
  masked.forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    if (line.trim() && publicClassIndent !== null && indent <= publicClassIndent && !/^\s*(?:class|def|async\s+def|@)/u.test(line)) {
      publicClassIndent = null;
    }
    const cls = line.match(/^(\s*)class\s+([A-Za-z_]\w*)/u);
    const def = line.match(/^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/u);
    if (cls) {
      if (publicClassIndent !== null && indent <= publicClassIndent) publicClassIndent = null;
      if (indent === 0 && !cls[2].startsWith('_')) { found.push({ index, kind: 'class', name: cls[2] }); publicClassIndent = 0; }
    } else if (def) {
      if (publicClassIndent !== null && indent <= publicClassIndent) publicClassIndent = null;
      const topLevel = indent === 0;
      const method = publicClassIndent !== null && indent > publicClassIndent;
      if ((topLevel || method) && !def[2].startsWith('_')) found.push({ index, kind: topLevel ? 'function' : 'method', name: def[2] });
    }
  });
  return found;
}

function rubyDeclarations(masked) {
  const found = [];
  let privateIndent = null;
  masked.forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    if (/^\s*(?:private|protected)\s*$/u.test(line)) { privateIndent = indent; return; }
    if (/^\s*public\s*$/u.test(line)) { privateIndent = null; return; }
    const type = line.match(/^\s*(?:class|module)\s+([A-Z]\w*(?:::\w+)*)/u);
    if (type) { privateIndent = null; found.push({ index, kind: 'class', name: type[1] }); return; }
    const def = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/u);
    if (def && !(privateIndent !== null && indent === privateIndent) && def[1] !== 'initialize') {
      found.push({ index, kind: 'method', name: def[1] });
    }
  });
  return found;
}

/**
 * Every public declaration in a source file, with its 1-based line and whether it is documented.
 * An unknown language returns an empty list rather than a guess.
 */
export function publicDeclarations(source, language) {
  if (!language) return [];
  const lines = String(source).split(/\r?\n/u);
  // A declaration fits on a line of ordinary length; a longer one is minified or generated text,
  // and leaving it out keeps the line patterns' work bounded whatever the file holds.
  const masked = maskedSource(source, language).split(/\r?\n/u)
    .map((line) => (line.length > MAX_DECLARATION_LINE ? '' : line));
  const found = language === 'javascript' || language === 'typescript' ? scriptDeclarations(masked)
    : language === 'python' ? pythonDeclarations(masked)
      : language === 'ruby' ? rubyDeclarations(masked)
        : DECLARATION_PATTERNS[language] ? patternDeclarations(masked, language) : [];
  return found.map(({ index, kind, name }) => {
    const comment = language === 'python' ? pythonDocstring(lines, masked, index) : commentAbove(lines, index, language, STYLE[language]);
    return Object.freeze({ line: index + 1, kind, name, documented: Boolean(comment && commentHasProse(comment)) });
  });
}

const LEAD_IN = /^\s*(?:$|\/\/|\/\*|\*|#|@|\[)/u;

/**
 * The declarations a change touched: one whose declaration line, or any line of its body, is among
 * `changedLines`. Editing a body counts, so touching an undocumented function is the moment its
 * advisory appears. A body ends before the blank, comment and decorator lines that lead into the
 * next declaration, and a changed blank line changes nothing, so appending code after a function
 * does not touch it.
 */
export function changedDeclarations(declarations, changedLines, sourceLines) {
  const changed = changedLines instanceof Set ? changedLines : new Set(changedLines);
  const lines = Array.isArray(sourceLines) ? sourceLines : null;
  const total = lines ? lines.length : Number(sourceLines) || 0;
  return declarations.filter((declaration, index) => {
    let end = (declarations[index + 1]?.line ?? (total + 1)) - 1;
    if (lines) while (end > declaration.line && LEAD_IN.test(lines[end - 1] ?? '')) end -= 1;
    for (let line = declaration.line; line <= end; line += 1) {
      if (changed.has(line) && (!lines || lines[line - 1]?.trim())) return true;
    }
    return false;
  });
}
