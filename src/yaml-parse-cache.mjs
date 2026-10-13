/**
 * Parse the same configuration text once per process, and once per machine. `[perf]`
 *
 * A Story start spent about 460 ms parsing YAML, most of it the same `workflow.yml` and
 * `portfolio.yml` read again by the asset policy, the definition loader and the portfolio loader.
 * The read-scope memo cannot help there: `start` writes, so it never opens a read scope.
 *
 * The key is the text's SHA-256, so a file rewritten mid-command (bootstrap writes `workflow.yml`
 * and reads it back) is a different key and is parsed afresh. The first result stays private and
 * every caller receives its own structured clone, so a caller that normalizes a definition in
 * place cannot change what the next caller reads. A parse error is never remembered: it throws
 * every time, exactly as `YAML.parse` does.
 *
 * Agent, skill and instruction front matter goes through here too: a Story start parsed 49
 * distinct texts 751 times and every phase command parsed 48 texts about 170 times, mostly the same
 * agent front matter read again by each lookup. Entries are evicted least recently used, within a
 * count and a text-size budget, so a repository with many agents and skills does not empty the
 * cache and fall back to parsing each one again.
 *
 * ## Across commands
 *
 * Every command is a new process, so each one parsed the same 48 texts again, and the first parses
 * in a process are the slow ones: the parser has not been optimized yet. Those 48 parses took about
 * 300 ms in a fresh process; reading the same results back from disk took under 15 ms. A parsed
 * result is therefore also kept on disk, named by the text's SHA-256, in a private directory under
 * the system temporary directory (as Node keeps its compile cache), one per `yaml` version. A
 * result is written only when the parse succeeded without warnings, so a text YAML warns about is
 * parsed, and warned about, in every command as before. An unreadable, foreign or damaged entry is
 * ignored and parsed again. `SINGULARITY_FLOW_YAML_CACHE` names another absolute directory, or
 * `off` turns the disk cache off; it is also off when the `yaml` version cannot be read, as in a
 * bundle, where one long-lived process keeps its results in memory anyway.
 *
 * Only `YAML.parse(text)` with default options belongs here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import YAML from 'yaml';

const MAXIMUM_ENTRIES = 1024;
const MAXIMUM_TEXT_LENGTH = 4 * 1024 * 1024;
const MAXIMUM_CACHED_TEXT_LENGTH = 32 * 1024 * 1024;
const MAXIMUM_STORED_TEXT_LENGTH = 512 * 1024;
const STORED_FORMAT = 1;
const MAXIMUM_SHARD_ENTRIES = 16;
const parsed = new Map();
let cachedTextLength = 0;
let storeDirectory;

const ownedByUser = (info) => typeof process.getuid !== 'function' || info.uid === process.getuid();

/** The private directory parsed results are kept in, or null when the disk cache is off. */
function stored(env = process.env) {
  if (storeDirectory !== undefined) return storeDirectory;
  storeDirectory = null;
  try {
    const configured = String(env.SINGULARITY_FLOW_YAML_CACHE ?? '').trim();
    if (configured.toLowerCase() === 'off') return null;
    // A relative path would land in whichever checkout the command ran from.
    if (configured && (!path.isAbsolute(configured) || path.parse(configured).root === configured)) return null;
    const version = createRequire(import.meta.url)('yaml/package.json').version;
    if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,40}$/u.test(version)) return null;
    const user = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
    const base = configured || path.join(os.tmpdir(), `singularity-flow-${user}`);
    const directory = path.join(base, 'yaml', `v${STORED_FORMAT}-yaml-${version}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A shared temporary directory: use only directories this user owns and nobody else can open.
    for (const owned of [...(configured ? [] : [base]), path.dirname(directory), directory]) {
      const info = lstatSync(owned);
      if (!info.isDirectory() || info.isSymbolicLink() || !ownedByUser(info)
          || (typeof process.getuid === 'function' && (info.mode & 0o077) !== 0)) return null;
    }
    storeDirectory = directory;
  } catch { storeDirectory = null; }
  return storeDirectory;
}

function storedPath(directory, key) { return path.join(directory, key.slice(0, 2), `${key}.v8`); }

function readStored(key) {
  const directory = stored();
  if (!directory) return undefined;
  try {
    const file = storedPath(directory, key);
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || !ownedByUser(info)) return undefined;
    const entry = v8.deserialize(readFileSync(file));
    return entry?.format === STORED_FORMAT && entry.key === key ? entry : undefined;
  } catch { return undefined; }
}

function writeStored(key, value) {
  const directory = stored();
  if (!directory) return;
  const shard = path.join(directory, key.slice(0, 2));
  const temporary = path.join(shard, `.${key}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    mkdirSync(shard, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, v8.serialize({ format: STORED_FORMAT, key, value }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, storedPath(directory, key));
    // Edited files leave old results behind; keep each shard to its newest entries.
    const entries = readdirSync(shard).filter((name) => name.endsWith('.v8'));
    if (entries.length > MAXIMUM_SHARD_ENTRIES) {
      entries.map((name) => ({ name, at: lstatSync(path.join(shard, name)).mtimeMs }))
        .sort((left, right) => right.at - left.at).slice(MAXIMUM_SHARD_ENTRIES)
        .forEach(({ name }) => unlinkSync(path.join(shard, name)));
    }
  } catch {
    try { unlinkSync(temporary); } catch { /* never written */ }
  }
}

/** The parse, and whether YAML warned while making it (those results are not kept on disk). */
function parseWatchingWarnings(text) {
  let warned = false;
  const emitWarning = process.emitWarning;
  process.emitWarning = function watchedWarning(...warning) {
    warned = true;
    return emitWarning.apply(this, warning);
  };
  try { return { value: YAML.parse(text), warned }; }
  finally { process.emitWarning = emitWarning; }
}

/** `YAML.parse(text)`, answered from an earlier parse of identical text when there was one. */
export function parseYamlText(text) {
  if (typeof text !== 'string' || text.length > MAXIMUM_TEXT_LENGTH) return YAML.parse(text);
  const key = createHash('sha256').update(text).digest('hex');
  let entry = parsed.get(key);
  if (entry) parsed.delete(key);
  else {
    const kept = text.length <= MAXIMUM_STORED_TEXT_LENGTH ? readStored(key) : undefined;
    if (kept) entry = { value: kept.value, length: text.length };
    else {
      const { value, warned } = parseWatchingWarnings(text);
      entry = { value, length: text.length };
      if (!warned && text.length <= MAXIMUM_STORED_TEXT_LENGTH) writeStored(key, value);
    }
    cachedTextLength += entry.length;
  }
  parsed.set(key, entry);
  for (const [oldest, { length }] of parsed) {
    if (parsed.size <= MAXIMUM_ENTRIES && cachedTextLength <= MAXIMUM_CACHED_TEXT_LENGTH) break;
    parsed.delete(oldest);
    cachedTextLength -= length;
  }
  const { value } = entry;
  return value === null || typeof value !== 'object' ? value : structuredClone(value);
}
