import { processResultCompleted, processResultSucceeded } from './process-result.mjs';
import { run, SingularityFlowError } from './util.mjs';

const EXACT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Test whether one exact commit object is available using Git's stable batch protocol. Unlike
 * `cat-file -e`, a missing object is an explicit status-zero `missing` record rather than an exit
 * code shared with repository and execution failures.
 */
export function gitCommitObjectExists(root, commit, {
  env = process.env,
  runCommand = run
} = {}) {
  if (!EXACT_OBJECT_ID.test(commit)) throw new SingularityFlowError(
    'Git commit availability requires one exact object ID.', { code: 'GIT_OBJECT_ID_INVALID' }
  );
  const expression = `${commit}^{commit}`;
  const result = runCommand('git', [
    'cat-file', '--batch-check=%(objectname) %(objecttype)'
  ], { cwd: root, env, input: `${expression}\n`, allowFailure: true });
  if (!processResultSucceeded(result)) throw new SingularityFlowError(
    'Git commit availability could not be observed safely.', {
      code: 'GIT_OBJECT_OBSERVATION_UNAVAILABLE',
      details: {
        exitCode: Number.isInteger(result?.status) ? result.status : null,
        timedOut: result?.timedOut === true,
        blocked: result?.blocked === true,
        aborted: result?.aborted === true,
        outputOverflow: result?.outputOverflow === true,
        signal: result?.signal ?? null
      }
    }
  );
  if (result.stderr) throw new SingularityFlowError(
    'Git commit availability returned unexpected diagnostics.', {
      code: 'GIT_OBJECT_PROTOCOL_INVALID'
    }
  );
  if (result.stdout === `${expression} missing\n`) return false;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64}) commit\n$/u.test(result.stdout)) return true;
  throw new SingularityFlowError('Git commit availability returned an invalid record.', {
    code: 'GIT_OBJECT_PROTOCOL_INVALID'
  });
}

/**
 * Observe one local Git ancestry predicate without turning execution failure into "not merged".
 *
 * `merge-base --is-ancestor` has one registered negative answer: exit 1 with no stdout/stderr and
 * no timeout, signal, cancellation, overflow, block, or spawn error. Every other non-success is an
 * unavailable observation and must stop proposal/authority decisions.
 */
export function gitIsAncestor(root, ancestor, descendant, {
  env = process.env,
  runCommand = run
} = {}) {
  const result = runCommand('git', [
    'merge-base', '--is-ancestor', ancestor, descendant
  ], { cwd: root, env, allowFailure: true });
  if (processResultSucceeded(result)) return true;
  if (result?.status === 1 && processResultCompleted(result)
      && !result.stdout && !result.stderr) return false;
  throw new SingularityFlowError('Git ancestry could not be observed safely.', {
    code: 'GIT_ANCESTRY_UNAVAILABLE',
    details: {
      exitCode: Number.isInteger(result?.status) ? result.status : null,
      timedOut: result?.timedOut === true,
      blocked: result?.blocked === true,
      aborted: result?.aborted === true,
      outputOverflow: result?.outputOverflow === true,
      signal: result?.signal ?? null
    }
  });
}
