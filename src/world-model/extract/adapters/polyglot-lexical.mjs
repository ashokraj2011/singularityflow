import path from 'node:path';

const C_LIKE = new Set(['c', 'cpp', 'csharp', 'go', 'java', 'kotlin', 'php', 'rust', 'swift']);
const HASH_COMMENT = new Set(['php', 'python', 'ruby']);

export const POLYGLOT_STRUCTURAL_LANGUAGES = Object.freeze([
  'c', 'cpp', 'csharp', 'go', 'java', 'kotlin', 'php', 'python', 'ruby', 'rust', 'swift'
]);

/**
 * Produce a same-length lexical code mask. Comments and string bodies become spaces while line
 * endings and code bytes stay in place, so every reported line remains bound to the pinned source.
 * This is intentionally a closed lexical grammar, not a semantic parser.
 */
export function maskPolyglotNonCode(source, language) {
  const input = String(source);
  const output = [...input];
  let state = 'code';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];
    const triple = input.slice(index, index + 3);
    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code';
      else output[index] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') output[index] = ' ';
      continue;
    }
    if (state === 'triple-string') {
      if (triple === quote.repeat(3)) {
        output[index] = output[index + 1] = output[index + 2] = ' ';
        index += 2;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') output[index] = ' ';
      continue;
    }
    if (state === 'string') {
      if (current !== '\n' && current !== '\r') output[index] = ' ';
      if (escaped) escaped = false;
      else if (current === '\\' && quote !== '`') escaped = true;
      else if (current === quote) state = 'code';
      continue;
    }

    if (C_LIKE.has(language) && current === '/' && next === '/') {
      output[index] = output[index + 1] = ' ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (C_LIKE.has(language) && current === '/' && next === '*') {
      output[index] = output[index + 1] = ' ';
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (HASH_COMMENT.has(language) && current === '#') {
      output[index] = ' ';
      state = 'line-comment';
      continue;
    }
    if ((language === 'python' || language === 'kotlin' || language === 'java')
        && (triple === "'''" || triple === '\"\"\"')) {
      quote = current;
      output[index] = output[index + 1] = output[index + 2] = ' ';
      index += 2;
      state = 'triple-string';
      continue;
    }
    if (current === "'" || current === '"' || current === '`') {
      quote = current;
      output[index] = ' ';
      state = 'string';
    }
  }
  return output.join('');
}

const SYMBOL_PATTERNS = Object.freeze({
  java: /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)|\b(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|\s)+[\w$<>\[\],.?]+\s+([A-Za-z_$][\w$]*)\s*\(/g,
  kotlin: /\b(class|interface|object|enum\s+class|data\s+class|sealed\s+class|fun)\s+([A-Za-z_][\w]*)/g,
  python: /^\s*(?:async\s+)?(class|def)\s+([A-Za-z_]\w*)/gm,
  go: /^\s*(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
  rust: /\b(?:pub(?:\([^)]*\))?\s+)?(struct|enum|trait|fn|mod)\s+([A-Za-z_]\w*)/g,
  ruby: /^\s*(class|module|def)\s+([A-Za-z_]\w*[!?=]?)/gm,
  php: /\b(class|interface|trait|function)\s+([A-Za-z_]\w*)/g,
  csharp: /\b(class|interface|struct|enum|record|delegate)\s+([A-Za-z_]\w*)|\b(?:public|protected|private|internal|static|virtual|override|async|sealed|partial|\s)+[\w<>,?\[\]]+\s+([A-Za-z_]\w*)\s*\(/g,
  c: /\b(struct|union|enum|typedef)\s+([A-Za-z_]\w*)|^\s*[\w*\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/gm,
  cpp: /\b(class|struct|union|enum|namespace)\s+([A-Za-z_]\w*)|^\s*[\w:*&<>~,\s]+\s+([A-Za-z_~]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/gm,
  swift: /\b(class|struct|protocol|enum|actor|func)\s+([A-Za-z_]\w*)/g
});

function lineNumberAt(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

export function extractPolyglotSymbols(source, language) {
  const pattern = SYMBOL_PATTERNS[language];
  if (!pattern) return [];
  const code = maskPolyglotNonCode(source, language);
  const symbols = [];
  const seen = new Set();
  pattern.lastIndex = 0;
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    const kind = String(match[1] ?? 'function').replace(/\s+/g, '-');
    const name = match[2] ?? match[3];
    if (!name) continue;
    const key = `${lineNumberAt(code, match.index)}:${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    symbols.push({ kind, name, line: lineNumberAt(code, match.index) });
  }
  return symbols;
}

function quotedTarget(line) {
  return /['\"]([^'\"]+)['\"]/.exec(line)?.[1] ?? null;
}

/** Extract declared import targets after proving the import keyword occurs outside comments/strings. */
export function extractPolyglotImports(source, language) {
  const original = String(source).split(/\r?\n/);
  const masked = maskPolyglotNonCode(source, language).split(/\r?\n/);
  const imports = [];
  let goImportBlock = false;
  for (let index = 0; index < masked.length; index += 1) {
    const code = masked[index];
    const raw = original[index];
    let target = null;
    if (language === 'python') {
      target = /^\s*from\s+([.\w]+)\s+import\b/.exec(code)?.[1]
        ?? /^\s*import\s+([.\w]+)/.exec(code)?.[1] ?? null;
    } else if (language === 'java' || language === 'kotlin') {
      target = /^\s*import\s+(?:static\s+)?([\w.*]+)/.exec(code)?.[1] ?? null;
    } else if (language === 'csharp') {
      target = /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)/.exec(code)?.[1] ?? null;
    } else if (language === 'rust') {
      target = /^\s*use\s+([\w:]+)/.exec(code)?.[1]
        ?? /^\s*mod\s+([A-Za-z_]\w*)/.exec(code)?.[1] ?? null;
    } else if (language === 'swift') {
      target = /^\s*import\s+([A-Za-z_]\w*)/.exec(code)?.[1] ?? null;
    } else if (language === 'go') {
      if (/^\s*import\s*\(/.test(code)) goImportBlock = true;
      else if (goImportBlock && /^\s*\)/.test(code)) goImportBlock = false;
      else if (/^\s*import\b/.test(code) || goImportBlock) target = quotedTarget(raw);
    } else if (language === 'ruby') {
      if (/^\s*require(?:_relative)?\b/.test(code)) target = quotedTarget(raw);
    } else if (language === 'php') {
      target = /^\s*use\s+([\\\w]+)/.exec(code)?.[1] ?? null;
      if (!target && /^\s*(?:require|require_once|include|include_once)\b/.test(code)) target = quotedTarget(raw);
    } else if (language === 'c' || language === 'cpp') {
      if (/^\s*#\s*include\b/.test(code)) target = quotedTarget(raw) ?? /<([^>]+)>/.exec(raw)?.[1] ?? null;
    }
    if (target) imports.push({ target, line: index + 1 });
  }
  return imports.filter((entry, index, values) => (
    values.findIndex((candidate) => candidate.target === entry.target && candidate.line === entry.line) === index
  ));
}

export function resolvePolyglotLocal(from, target, language, knownPaths) {
  const known = knownPaths instanceof Set ? knownPaths : new Set(knownPaths);
  const relativeBase = target.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(from), target))
    : null;
  const moduleBase = target.replace(/^\.+/, '').replace(/::|\\|\./g, '/').replace(/\*$/, '');
  const candidates = [];
  if (relativeBase && relativeBase !== '..' && !relativeBase.startsWith('../')) candidates.push(relativeBase);
  if (['java', 'kotlin'].includes(language)) candidates.push(`${moduleBase}.java`, `${moduleBase}.kt`);
  if (language === 'python') candidates.push(`${moduleBase}.py`, `${moduleBase}/__init__.py`);
  if (language === 'rust') candidates.push(`${moduleBase}.rs`, `${moduleBase}/mod.rs`);
  if (language === 'csharp') candidates.push(`${moduleBase}.cs`);
  if (language === 'swift') candidates.push(`${moduleBase}.swift`);
  if (relativeBase) {
    const extensions = ['.c', '.cc', '.cpp', '.h', '.hpp', '.go', '.php', '.rb'];
    candidates.push(...extensions.map((extension) => `${relativeBase}${extension}`));
  }
  return candidates.find((candidate) => known.has(candidate))
    ?? [...known].find((candidate) => candidates.some((suffix) => candidate.endsWith(`/${suffix}`)))
    ?? null;
}
