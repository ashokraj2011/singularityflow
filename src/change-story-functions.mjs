/**
 * The functions a change added, changed or removed in one file, and the tests in a test file [CSP:REQ-001,
 * docs/SPEC-CSP-CHANGE-STORY-PAGE-v1.md]. Owner, 2026-11-27: "list methods and what it does, returns, or what part edited".
 *
 * The list is SFlow's, so it is complete: every callable the parser finds before and after is compared by its name and its
 * text. JavaScript and TypeScript are read with the TypeScript compiler's parser (SFlow's own copy, never the repository's);
 * Java, Python, Kotlin and Swift with the structural scanner; C, C++, C#, Go, PHP, Ruby and Rust with the lexical one. A
 * function's extent is the compiler's span, or its braces (its indentation in Python) on the code with comments and strings
 * masked. A file in another language, or too large, is listed with no functions and says so.
 *
 * Pure but for the compiler's lazy load: no file or Git read.
 */
import path from 'node:path';

export const CHANGE_STORY_FUNCTION_LIMITS = Object.freeze({ fileBytes: 512 * 1024, functionsPerFile: 120, testsPerFile: 200, helperLines: 15 });

const TYPESCRIPT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const STRUCTURAL = Object.freeze({ '.java': 'java', '.py': 'python', '.kt': 'kotlin', '.kts': 'kotlin', '.swift': 'swift' });
const LEXICAL = Object.freeze({ '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.go': 'go',
  '.php': 'php', '.rb': 'ruby', '.rs': 'rust' });
const CALLABLE = new Set(['function', 'method', 'constructor', 'async-function', 'extension-function', 'initializer', 'def', 'fn', 'func']);
// Braces bound a body in every language read here but Python's indentation and Ruby's `end`.
const INDENTED = new Set(['python', 'ruby']);

/** The language a path is read as, or null when SFlow does not read its functions. */
export function functionLanguage(relative) {
  const extension = path.posix.extname(String(relative ?? '')).toLowerCase();
  if (TYPESCRIPT.has(extension)) return 'typescript';
  return STRUCTURAL[extension] ?? LEXICAL[extension] ?? null;
}

let compiler;
async function typescript() {
  if (compiler === undefined) {
    try {
      const { resolveTypeScript } = await import('./ast-packs/typescript-core.mjs');
      compiler = resolveTypeScript()?.module ?? null;
    } catch { compiler = null; }
  }
  return compiler;
}

const lines = (text) => String(text ?? '').split(/\r?\n/u);
const bodyOf = (all, start, end) => all.slice(start - 1, end).map((line) => line.trimEnd()).join('\n');

/** The last line of a brace-bounded body that opens at or after `start` (1-based), on masked code; `start` when none opens. */
function braceEnd(masked, start) {
  let depth = 0;
  let opened = false;
  for (let index = start - 1; index < masked.length; index += 1) {
    for (const character of masked[index]) {
      if (character === '{') { depth += 1; opened = true; }
      else if (character === '}') { depth -= 1; if (opened && depth <= 0) return index + 1; }
      else if (character === ';' && !opened && depth === 0) return index + 1;
    }
    // A declaration whose body never opens within a few lines (an expression body, an abstract method) is one line.
    if (!opened && index - (start - 1) >= 3) return start;
  }
  return opened ? masked.length : start;
}

/** The last line of an indentation-bounded body (Python, and Ruby with its closing `end`). */
function indentEnd(all, start, language) {
  const indent = (line) => line.length - line.trimStart().length;
  const own = indent(all[start - 1] ?? '');
  let last = start;
  for (let index = start; index < all.length; index += 1) {
    const line = all[index];
    if (!line.trim()) continue;
    if (indent(line) <= own) {
      if (language === 'ruby' && indent(line) === own && /^\s*end\b/u.test(line)) return index + 1;
      break;
    }
    last = index + 1;
  }
  return last;
}

function extentEnd(all, masked, start, language) {
  return INDENTED.has(language) ? indentEnd(all, start, language) : braceEnd(masked, start);
}

/** Display name: the class and method for a member (`Cart.add`), else the function's own name; never a package. */
function displayName(qualifiedName, name, containerNames = []) {
  const container = containerNames.at(-1);
  return container ? `${container}.${name}` : name ?? qualifiedName;
}

async function typescriptFunctions(relative, text) {
  const ts = await typescript();
  if (!ts) return null;
  const { declarations } = await import('./ast-packs/typescript-core.mjs');
  const extension = path.posix.extname(relative).toLowerCase();
  const kind = extension === '.tsx' ? ts.ScriptKind.TSX : extension === '.jsx' ? ts.ScriptKind.JSX
    : ['.js', '.mjs', '.cjs'].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, kind);
  const { records } = declarations(ts, source, relative);
  const all = lines(text);
  const byId = new Map(records.map((record) => [record.id, record]));
  return records.filter((record) => ['function', 'method', 'constructor'].includes(record.kind)).map((record) => {
    const containers = [];
    for (let parent = byId.get(record.containerId); parent; parent = byId.get(parent.containerId)) containers.unshift(parent.name);
    return {
      key: record.id.replace(/^ts:[^#]*#/u, ''), name: record.name, display: displayName(record.qualifiedName, record.name, containers), kind: record.kind,
      exported: Boolean(ts.getCombinedModifierFlags(record.node) & ts.ModifierFlags.Export), start: record.span.startLine, end: record.span.endLine,
      body: bodyOf(all, record.span.startLine, record.span.endLine)
    };
  });
}

async function structuralFunctions(language, text) {
  const { extractPolyglotSyntax } = await import('./ast-packs/polyglot-syntax-core.mjs');
  const { maskPolyglotNonCode } = await import('./polyglot-lexical.mjs');
  const facts = extractPolyglotSyntax(Buffer.from(text, 'utf8'), language).facts.filter((fact) => fact?.kind === 'symbol');
  const all = lines(text);
  const masked = lines(maskPolyglotNonCode(text, language));
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const seen = new Map();
  return facts.filter((fact) => CALLABLE.has(fact.declarationKind)).map((fact) => {
    const containers = [];
    for (let parent = byId.get(fact.containerId); parent; parent = byId.get(parent.containerId)) containers.unshift(parent.name);
    const start = fact.line ?? fact.span?.startLine ?? 1;
    const end = extentEnd(all, masked, start, language);
    const base = [...containers, fact.name].join('.');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count ? `${base}~${count + 1}` : base, name: fact.name, display: displayName(fact.qualifiedName, fact.name, containers),
      kind: fact.declarationKind, exported: fact.visibility === 'public', start, end, body: bodyOf(all, start, end) };
  });
}

async function lexicalFunctions(language, text) {
  const { extractPolyglotSymbols, maskPolyglotNonCode } = await import('./polyglot-lexical.mjs');
  const all = lines(text);
  const masked = lines(maskPolyglotNonCode(text, language));
  const seen = new Map();
  return extractPolyglotSymbols(text, language).filter((symbol) => CALLABLE.has(symbol.kind)).map((symbol) => {
    const end = extentEnd(all, masked, symbol.line, language);
    const count = seen.get(symbol.name) ?? 0;
    seen.set(symbol.name, count + 1);
    return { key: count ? `${symbol.name}~${count + 1}` : symbol.name, name: symbol.name, display: symbol.name, kind: symbol.kind,
      exported: null, start: symbol.line, end, body: bodyOf(all, symbol.line, end) };
  });
}

/** The callables in one file's text, in source order; null when its language is not read or it is too large. */
export async function fileFunctions(relative, text) {
  const language = functionLanguage(relative);
  if (!language || text == null || Buffer.byteLength(String(text), 'utf8') > CHANGE_STORY_FUNCTION_LIMITS.fileBytes) return null;
  try {
    const found = language === 'typescript' ? await typescriptFunctions(relative, String(text))
      : Object.values(STRUCTURAL).includes(language) ? await structuralFunctions(language, String(text)) : await lexicalFunctions(language, String(text));
    return found ? found.slice(0, CHANGE_STORY_FUNCTION_LIMITS.functionsPerFile) : null;
  } catch { return null; }
}

const callPattern = (name) => new RegExp(`(?<![\\w$.])${String(name).replace(/[.*+?^${}()|[\]\\$]/gu, '\\$&')}\\s*\\(`, 'gu');

/**
 * The functions one file's change added, changed or removed: `{ read, functions }`, each function `{ key, name, display,
 * kind, change: 'new'|'edited'|'removed', start, end }`, and a small new helper only one other changed function calls with
 * `helperOf` (that function's key). `read` is false when the file's language is not read here.
 */
export async function functionChanges(relative, before, after) {
  const [old, now] = await Promise.all([before == null ? [] : fileFunctions(relative, before), after == null ? [] : fileFunctions(relative, after)]);
  if (old === null || now === null) return { read: false, functions: [] };
  const was = new Map(old.map((entry) => [entry.key, entry]));
  const is = new Map(now.map((entry) => [entry.key, entry]));
  const changes = [];
  for (const entry of now) {
    const prior = was.get(entry.key);
    if (!prior) changes.push({ ...entry, change: 'new' });
    else if (prior.body.replace(/\s+/gu, ' ') !== entry.body.replace(/\s+/gu, ' ')) changes.push({ ...entry, change: 'edited' });
  }
  for (const entry of old) if (!is.has(entry.key)) changes.push({ ...entry, change: 'removed' });
  // A small helper the change added, called once, from another function the change added or changed, folds under it.
  const all = lines(after);
  for (const entry of changes) {
    if (entry.change !== 'new' || entry.exported === true || entry.end - entry.start + 1 > CHANGE_STORY_FUNCTION_LIMITS.helperLines) continue;
    const calls = [];
    all.forEach((line, index) => {
      const number = index + 1;
      if (number >= entry.start && number <= entry.end) return;
      for (const _ of line.matchAll(callPattern(entry.name))) calls.push(number);
    });
    if (calls.length !== 1) continue;
    const caller = changes.find((other) => other !== entry && other.change !== 'removed' && calls[0] >= other.start && calls[0] <= other.end
      && !(other.start <= entry.start && other.end >= entry.end));
    if (caller && !caller.helperOf) entry.helperOf = caller.key;
  }
  return { read: true, functions: changes.map(({ body, exported, ...entry }) => entry) };
}

// Test cases by language: the name a runner reports, on its declaration line.
const TEST_CASES = Object.freeze([
  { languages: ['typescript'], pattern: /(?<![\w$.])(?:test|it)(?:\.(?:only|skip|todo|concurrent|each\([^)]*\)))?\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/u },
  { languages: ['python'], pattern: /^\s*(?:async\s+)?def\s+(test_\w*)\s*\(/u, group: 1 },
  { languages: ['go'], pattern: /^\s*func\s+(Test\w*)\s*\(/u, group: 1 },
  { languages: ['ruby'], pattern: /^\s*(?:it|test|specify)\s+(['"])((?:\\.|(?!\1).)+)\1/u }
]);
const ANNOTATED = /^\s*(?:@(?:Test|ParameterizedTest|RepeatedTest)\b|\[(?:Test|Fact|Theory|TestMethod)\b)/u;
const METHOD_NAME = /(?:fun\s+`?([^`(]+)`?|\b([A-Za-z_]\w*)\s*\()/u;

/**
 * The test cases in a test file, in source order: `{ key, name, start, end, body }`. JavaScript's `test`/`it` names,
 * Python's and Go's test functions, Ruby's `it`, and a JUnit/xUnit annotated method. [] when none is found.
 */
export async function testCases(relative, text) {
  if (text == null || Buffer.byteLength(String(text), 'utf8') > CHANGE_STORY_FUNCTION_LIMITS.fileBytes) return [];
  const language = functionLanguage(relative);
  const all = lines(text);
  // Comments and strings masked as Java's, for the braces of a JavaScript or C-like test body.
  const maskAs = language === 'typescript' ? 'java' : language;
  let masked = all;
  try {
    if (maskAs && !INDENTED.has(language)) masked = lines((await import('./polyglot-lexical.mjs')).maskPolyglotNonCode(String(text), maskAs));
  } catch { masked = all; }
  const cases = [];
  const seen = new Map();
  const add = (name, start) => {
    const end = extentEnd(all, masked, start, INDENTED.has(language) ? language : 'java');
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    cases.push({ key: count ? `${name}~${count + 1}` : name, name, start, end, body: bodyOf(all, start, end) });
  };
  let annotated = false;
  all.forEach((line, index) => {
    if (cases.length >= CHANGE_STORY_FUNCTION_LIMITS.testsPerFile) return;
    if (ANNOTATED.test(line)) { annotated = true; if (!/\(\s*\)\s*(?:throws[^{]*)?\{?\s*$|fun\s/u.test(line.replace(ANNOTATED, ''))) return; }
    if (annotated && !/^\s*@/u.test(line) && line.trim()) {
      annotated = false;
      const named = METHOD_NAME.exec(line.replace(/^\s*(?:public|private|protected|internal|static|async|override|void|suspend|\s)+/u, ''));
      const name = (named?.[1] ?? named?.[2])?.trim();
      if (name) { add(name, index + 1); return; }
    }
    for (const rule of TEST_CASES) {
      if (!rule.languages.includes(language)) continue;
      const match = rule.pattern.exec(line);
      if (match) { add(match[rule.group ?? 2], index + 1); return; }
    }
  });
  return cases;
}

/** A test file's cases the change added or changed, each `{ name, change: 'new'|'edited', start, end }`; removed ones too. */
export async function testCaseChanges(relative, before, after) {
  const [old, now] = await Promise.all([before == null ? [] : testCases(relative, before), after == null ? [] : testCases(relative, after)]);
  const was = new Map(old.map((entry) => [entry.key, entry]));
  const is = new Set(now.map((entry) => entry.key));
  const changes = [];
  for (const entry of now) {
    const prior = was.get(entry.key);
    if (!prior) changes.push({ name: entry.name, change: 'new', start: entry.start, end: entry.end });
    else if (prior.body.replace(/\s+/gu, ' ') !== entry.body.replace(/\s+/gu, ' ')) changes.push({ name: entry.name, change: 'edited', start: entry.start, end: entry.end });
  }
  for (const entry of old) if (!is.has(entry.key)) changes.push({ name: entry.name, change: 'removed', start: entry.start, end: entry.end });
  return changes;
}
