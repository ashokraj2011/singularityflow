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
import { executeGitQuery } from './git-query.mjs';
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

/** The checkout's branch, head and changed paths, through the registered revision query. */
export function sourceWorkingState(root, { env = process.env } = {}) {
  return { status: 'present', value: executeGitQuery(root, 'repository.revision', {}, { env }) };
}
