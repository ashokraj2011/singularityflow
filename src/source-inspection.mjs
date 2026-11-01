/**
 * Source inspection facade (SDA §4, Phase A): reads of source revisions, files at a revision and
 * ancestry, named for what they answer rather than for the Git command behind them.
 *
 * Reads only. Write paths keep their modules until Phase B. A module that reads source through
 * here stops starting Git itself, and test/source-inspection.test.mjs holds every module's own
 * local Git reads to the committed inventory: that count may only fall (SDA-AC-001).
 *
 * Every answer keeps three outcomes apart (§7.3): `present` with its value, `absent` (Git answered
 * that the revision or path is not there), and `unavailable` (Git could not answer: a timeout, an
 * output bound, a missing object), which carries the process result for the caller's diagnostics.
 * `offline: true` forbids a partial clone from fetching a missing object.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import { run } from './util.mjs';

const ABSENT_PATH = /path .* does not exist|exists on disk, but not in|not exist in/iu;

function gitEnvironment(env, offline) {
  return offline
    ? { ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
    : env;
}

function read(root, args, { env, offline, maxBytes = null, encoding = 'utf8' }) {
  return run('git', args, {
    cwd: root, allowFailure: true, env: gitEnvironment(env, offline),
    ...(maxBytes == null ? {} : { maxBuffer: maxBytes }),
    ...(encoding === 'buffer' ? { encoding: 'buffer' } : {})
  });
}

/** The bytes of one file at a revision: text by default, a Buffer with `encoding: 'buffer'`. */
export function sourceFileAt(root, revision, relative, {
  env = process.env, offline = false, maxBytes = null, encoding = 'utf8'
} = {}) {
  const shown = read(root, ['show', `${revision}:${relative}`], { env, offline, maxBytes, encoding });
  if (processResultSucceeded(shown)) return { status: 'present', value: shown.stdout };
  if (processResultCompleted(shown) && ABSENT_PATH.test(String(shown.stderr ?? ''))) return { status: 'absent' };
  return { status: 'unavailable', result: shown };
}

/** The full commit ID a revision names. */
export function sourceRevision(root, revision, { env = process.env, offline = false } = {}) {
  const resolved = read(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { env, offline });
  if (processResultSucceeded(resolved)) return { status: 'present', value: resolved.stdout.trim() };
  // `--quiet` makes a revision that does not resolve a clean exit 1 with no output.
  if (processResultCompleted(resolved) && resolved.status === 1 && !resolved.stdout) return { status: 'absent' };
  return { status: 'unavailable', result: resolved };
}

/** Whether `ancestor` is in the history of `descendant`. */
export function sourceContains(root, ancestor, descendant, { env = process.env, offline = false } = {}) {
  const checked = read(root, ['merge-base', '--is-ancestor', ancestor, descendant], { env, offline });
  if (processResultCompleted(checked) && (checked.status === 0 || checked.status === 1)) {
    return { status: 'present', value: checked.status === 0 };
  }
  return { status: 'unavailable', result: checked };
}

/**
 * The checkout's branch, head and changed paths, through the registered revision query. The query
 * registry loads only here: the facade's readers sit in startup read graphs that never ask this.
 */
export async function sourceWorkingState(root, { env = process.env } = {}) {
  const { executeGitQuery } = await import('./git-query.mjs');
  return { status: 'present', value: executeGitQuery(root, 'repository.revision', {}, { env }) };
}

/**
 * Line endings as the person's own Git writes them on checkout, as `-c` arguments. A destructive
 * proof runs Git without system or global configuration, and Git for Windows sets core.autocrlf=true
 * in the system one, so only the person's own environment (`personalEnv`) names them. Only these two
 * values cross. The proof's own `git status` takes them too (withCheckoutLineEndings): it compares a
 * file whose stat data no longer matches the index by content, and without them a CRLF checkout
 * reads as modified there.
 */
export function checkoutLineEndings(root, personalEnv) {
  const configured = read(root, ['config', '--get-regexp', '^core\\.(autocrlf|eol)$'], { env: personalEnv, offline: false });
  if (!processResultSucceeded(configured)) return [];
  return configured.stdout.split(/\r?\n/u).flatMap((line) => {
    const [key, value] = line.trim().split(/\s+/u);
    return /^core\.(?:autocrlf|eol)$/iu.test(key ?? '') && /^(?:true|false|input|lf|crlf|native)$/iu.test(value ?? '')
      ? ['-c', `${key.toLowerCase()}=${value.toLowerCase()}`] : [];
  });
}

/** `env` with the line endings checkoutLineEndings read as Git's environment configuration, after its own entries. */
export function withCheckoutLineEndings(env, lineEndings) {
  const entries = [];
  for (let index = 1; index < lineEndings.length; index += 2) entries.push(lineEndings[index].split('='));
  if (!entries.length) return env;
  const configured = Number(env.GIT_CONFIG_COUNT ?? 0);
  const offset = Number.isSafeInteger(configured) && configured >= 0 ? configured : 0;
  const result = { ...env, GIT_CONFIG_COUNT: String(offset + entries.length) };
  entries.forEach(([key, value], index) => {
    result[`GIT_CONFIG_KEY_${offset + index}`] = key;
    result[`GIT_CONFIG_VALUE_${offset + index}`] = value;
  });
  return result;
}

/**
 * The bytes Git's checkout writes for each path's indexed blob, as their SHA-256: one
 * `checkout-index --temp` into a private directory outside the checkout, with Git's own line-ending
 * and encoding conversion. `configuration` carries the caller's `-c` overrides (its configured
 * filters disabled). A path Git wrote nothing for is missing from the map.
 */
export function sourceCheckoutForm(root, paths, { env = process.env, personalEnv = process.env, configuration = [],
  lineEndings = null } = {}) {
  const gitDirectory = read(root, ['rev-parse', '--absolute-git-dir'], { env, offline: true });
  if (!processResultSucceeded(gitDirectory) || !gitDirectory.stdout.trim()) return { status: 'unavailable', result: gitDirectory };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sflow-checkout-form-'));
  try {
    const written = run('git', [...configuration, ...(lineEndings ?? checkoutLineEndings(root, personalEnv)), '--git-dir', gitDirectory.stdout.trim(),
      '--work-tree', directory, 'checkout-index', '--temp', '-z', '--stdin'], {
      cwd: directory, env: gitEnvironment(env, true), input: `${paths.join('\0')}\0`, allowFailure: true
    });
    if (!processResultSucceeded(written)) return { status: 'unavailable', result: written };
    const value = new Map();
    for (const line of written.stdout.split('\0').filter(Boolean)) {
      const tab = line.indexOf('\t');
      const name = line.slice(0, tab);
      if (tab < 1 || name.includes('/') || name.includes('\\')) continue;
      try { value.set(line.slice(tab + 1), createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex')); }
      catch { /* Unreadable: no answer for that path. */ }
    }
    return { status: 'present', value };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
