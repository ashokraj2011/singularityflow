/**
 * Secret-looking values in environment files, for one run's redactor only [ENVF "Secrets in output"].
 *
 * A run that places environment files reads each file once, bounded, with a parser for its kind:
 * YAML, `.properties`, `.env`, JSON, TOML, INI, and string literals in Python settings. A value under
 * a key that looks secret, or a value that looks secret (secret-looking.mjs, the app-suggestions
 * rule), becomes a redaction entry named `FILE-KEY`. The entries go straight to
 * output-redaction.mjs inside the run's materialized environment; nothing here stores, hashes, logs
 * or prints a value, and a parser error never quotes the file.
 */
import { constants as fsConstants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { looksSecretName, looksSecretValue } from './secret-looking.mjs';

export const MAXIMUM_ENVIRONMENT_FILE_BYTES = 1024 * 1024;
const MAXIMUM_PAIRS = 4_096;
const MAXIMUM_DEPTH = 32;
const MAXIMUM_VALUE = 16_384;
// Booleans, numbers and placeholders are configuration, not credentials, even under a secret key.
const NOT_SECRET = /^(?:true|false|yes|no|on|off|null|none|nil|~|-?\d+(?:\.\d+)?)$/iu;
const PLACEHOLDER = /^(?:\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]*\}\}|<[^<>]*>|%\([^)]*\)s|changeme|change-me|xxx+|\*+)$/iu;
const EXTENSIONS = Object.freeze({
  '.yml': 'yaml', '.yaml': 'yaml', '.properties': 'properties', '.json': 'json', '.toml': 'toml',
  '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini', '.py': 'python', '.env': 'dotenv'
});

/** Which parser reads a file, from its name: `.env`, `.env.uat` and `uat.env` are dotenv files. */
export function environmentFileKind(relative) {
  const base = path.posix.basename(String(relative)).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
  return EXTENSIONS[path.posix.extname(base)] ?? 'raw';
}

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/** `KEY=value` lines; `export`, quotes and an unquoted trailing ` # comment` are understood. */
function dotenvPairs(text, push) {
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2];
    if (!/^\s*["']/u.test(value)) value = value.replace(/\s+#.*$/u, '');
    push(match[1], unquote(value));
  }
}

/** Java properties: `=`, `:` or whitespace separates; `\` continues a line; `#` and `!` comment. */
function propertiesPairs(text, push) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    while (/(?:^|[^\\])(?:\\\\)*\\$/u.test(line) && index + 1 < lines.length && line.length < MAXIMUM_VALUE) {
      line = line.slice(0, -1) + lines[index + 1].trimStart();
      index += 1;
    }
    if (/^\s*(?:[#!]|$)/u.test(line)) continue;
    const match = /^\s*((?:\\.|[^\s=:\\])+)\s*[=:\s]\s*(.*)$/u.exec(line);
    if (match) push(match[1].replace(/\\(.)/gu, '$1'), match[2].trim());
  }
}

/** INI and TOML share a section header and `key = value`; quoted TOML keys and values are unquoted. */
function sectionPairs(text, push, { toml = false } = {}) {
  let section = '';
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$/u.exec(line);
    if (header) { section = header[1].replace(/["']/gu, ''); continue; }
    if (/^\s*(?:[#;]|$)/u.test(line)) continue;
    const match = toml ? /^\s*((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*(.*)$/u.exec(line)
      : /^\s*([^=:;#\s][^=:]*?)\s*[=:]\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2];
    if (toml && /^\s*(?:"""|''')/u.test(value)) continue;
    if (!/^\s*["']/u.test(value)) value = value.replace(/\s+[#;].*$/u, '');
    else value = (/^\s*("(?:\\.|[^"\\])*"|'[^']*')/u.exec(value)?.[1] ?? value);
    const key = match[1].replace(/["']/gu, '').replace(/\s*\.\s*/gu, '.');
    push(section ? `${section}.${key}` : key, unquote(value));
  }
}

/** Python settings: `NAME = "value"` and `'KEY': 'value'` string literals, nothing evaluated. */
function pythonPairs(text, push) {
  for (const line of text.split(/\r?\n/u)) {
    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[rbuf]?(["'])((?:\\.|(?!\2).)*)\2/u.exec(line);
    if (assignment) push(assignment[1], assignment[3]);
    for (const pair of line.matchAll(/(["'])([^"'\n]{1,128})\1\s*:\s*[rbuf]?(["'])((?:\\.|(?!\3).)*)\3/gu)) push(pair[2], pair[4]);
  }
}

function walk(value, key, push, depth = 0) {
  if (depth > MAXIMUM_DEPTH || value == null) return;
  if (typeof value === 'string') { push(key, value); return; }
  if (typeof value !== 'object') return;
  for (const [child, nested] of Object.entries(value)) walk(nested, key ? `${key}.${child}` : child, push, depth + 1);
}

/** Every `{ key, value }` string pair of one file's text, bounded; an unparseable file yields what its lines show. */
export function environmentFilePairs(kind, text) {
  const pairs = [];
  const push = (key, value) => {
    if (pairs.length < MAXIMUM_PAIRS && typeof value === 'string') pairs.push({ key: String(key ?? ''), value });
  };
  if (kind === 'json') {
    try { walk(JSON.parse(text), '', push); } catch { /* not JSON: nothing is read from it */ }
  } else if (kind === 'yaml') {
    try {
      for (const document of YAML.parseAllDocuments(text, { maxAliasCount: 64, uniqueKeys: false, prettyErrors: false })) {
        if (document.errors?.length) throw new Error('invalid');
        walk(document.toJS({ maxAliasCount: 64 }), '', push);
      }
    } catch {
      pairs.length = 0;
      // Simple `key: value` lines still give their values, with the indentation's parents unknown.
      for (const line of text.split(/\r?\n/u)) {
        const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s+(\S.*)$/u.exec(line);
        if (match) push(match[1], unquote(match[2].replace(/\s+#.*$/u, '')));
      }
    }
  } else if (kind === 'properties') propertiesPairs(text, push);
  else if (kind === 'toml') sectionPairs(text, push, { toml: true });
  else if (kind === 'ini') sectionPairs(text, push);
  else if (kind === 'python') pythonPairs(text, push);
  else {
    dotenvPairs(text, push);
    // A key file (Rails credentials, a token on its own line) is a value without a key.
    if (kind === 'raw') for (const line of text.split(/\r?\n/u)) if (!line.includes('=')) push('', line.trim());
  }
  return pairs;
}

function nameToken(value, fallback) {
  const token = String(value).toUpperCase().replace(/[^A-Z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 64);
  if (!token) return fallback;
  return /^[A-Z]/u.test(token) ? token : `F${token}`;
}

/** The redaction name of a value: the file's name and the key, as `[redacted:FILE-KEY]` shows them. */
export function redactionName(relative, key) {
  return `${nameToken(path.posix.basename(String(relative)), 'FILE')}-${nameToken(key, 'VALUE')}`;
}

/** The pairs whose value is redacted: under a secret-looking key, or itself secret-looking. */
export function secretEnvironmentFileValues(relative, pairs) {
  return pairs.flatMap(({ key, value }) => {
    const trimmed = value.trim();
    if (trimmed.length < 4 || value.length > MAXIMUM_VALUE || NOT_SECRET.test(trimmed) || PLACEHOLDER.test(trimmed)) return [];
    if (!(key && looksSecretName(key)) && !looksSecretValue(trimmed)) return [];
    return [{ name: redactionName(relative, key), value: trimmed }];
  });
}

async function boundedText(location) {
  let handle;
  try {
    handle = await open(await realpath(location), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_ENVIRONMENT_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAXIMUM_ENVIRONMENT_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAXIMUM_ENVIRONMENT_FILE_BYTES) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, offset));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The redaction entries of the files a run uses ({ path, location }), and the paths that could not
 * be read for redaction (too large, not UTF-8, unreadable). Only the caller's redactor keeps entries.
 */
export async function environmentFileRedactions(files) {
  const entries = [];
  const unread = [];
  for (const file of files) {
    const text = await boundedText(file.location);
    if (text == null) { unread.push(file.path); continue; }
    entries.push(...secretEnvironmentFileValues(file.path, environmentFilePairs(environmentFileKind(file.path), text)));
  }
  return { entries, unread };
}
