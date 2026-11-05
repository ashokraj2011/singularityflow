/**
 * Reads of one exact tree, object or commit, for the services that check them byte by byte: the
 * commit policy and the configuration projection. They answer as the source inspection facade does,
 * `present` with a value or `unavailable` with the process result, and live apart from it because the
 * facade sits in the startup read graphs, which never ask these.
 */
import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import { run } from './util.mjs';

/**
 * `required: true` is for a caller with nothing to do when Git cannot answer: Git's failure throws as
 * an unguarded `run` does, so its answer is always `present`.
 */
function read(root, args, { env = process.env, maxBytes = null, timeoutMs = null, encoding = 'utf8', input = null, required = false } = {}) {
  return run('git', args, {
    cwd: root, allowFailure: !required, env,
    ...(maxBytes == null ? {} : { maxBuffer: maxBytes }),
    ...(timeoutMs == null ? {} : { timeoutMs }),
    ...(input == null ? {} : { input }),
    ...(encoding === 'buffer' ? { encoding: 'buffer' } : {})
  });
}

const answer = (result, value) => (processResultSucceeded(result) ? { status: 'present', value: value(result.stdout) } : { status: 'unavailable', result });

/** Every entry under a tree as `ls-tree -r -z` prints it: NUL-separated, in `format`'s columns when given. */
export function exactTreeListing(root, tree, { format = null, ...options } = {}) {
  return answer(read(root, ['ls-tree', '-r', '-z', ...(format ? [`--format=${format}`] : []), tree], options), (stdout) => stdout);
}

/** Each object's `<id> <type>` line, in order; one Git does not hold reads `<id> missing`. */
export function exactObjectTypes(root, objects, options = {}) {
  return answer(read(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { ...options, input: `${objects.join('\n')}\n` }),
    (stdout) => stdout.trimEnd().split(/\r?\n/u));
}

/** A commit object's own bytes, unparsed, as a Buffer. */
export function exactCommitObject(root, commit, options = {}) {
  return answer(read(root, ['cat-file', 'commit', commit], { ...options, encoding: 'buffer' }), (stdout) => stdout);
}

/** Whether Git verifies a commit's signature: `false` when Git answered that it does not. */
export function exactCommitSignatureVerified(root, commit, options = {}) {
  const verified = read(root, ['verify-commit', '--raw', commit], options);
  return processResultCompleted(verified) ? { status: 'present', value: verified.status === 0 } : { status: 'unavailable', result: verified };
}

/** The checkout's own Git directory (absolute) and its common one, as Git prints them. */
export function exactGitDirectories(root, options = {}) {
  return answer(read(root, ['rev-parse', '--absolute-git-dir', '--git-common-dir'], options), (stdout) => stdout.trim().split(/\r?\n/u));
}
