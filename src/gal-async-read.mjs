/**
 * Published, host-neutral async GAL read descriptors.
 *
 * A host supplies its supervised Buffer-returning Git runner. This module never launches Git,
 * selects an executable, inherits credentials, or accepts caller-built argv. The VS Code host can
 * bundle it without pulling the synchronous engine process runner into its activation path.
 */

const ROOT_ARGV = Object.freeze(['rev-parse', '--show-toplevel']);

const DESCRIPTORS = Object.freeze({
  'repository.root': Object.freeze({
    id: 'repository.root', version: 1, argv: ROOT_ARGV,
    effects: 'none', network: false, dependency: 'repository-instance',
    timeoutMs: 15_000,
    parse(bytes) { return bytes.toString('utf8').trim(); }
  })
});

export const GAL_ASYNC_READ_DESCRIPTORS = DESCRIPTORS;

/** Execute only an installed read descriptor through the host's existing async supervisor. */
export async function executeGalAsyncRead(id, cwd, {
  runner, signal
} = {}) {
  const descriptor = Object.hasOwn(DESCRIPTORS, id) ? DESCRIPTORS[id] : null;
  if (!descriptor) return Object.freeze({ ok: false, code: 'GAL_OPERATION_UNSUPPORTED' });
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || typeof runner !== 'function') {
    return Object.freeze({ ok: false, code: 'GAL_INPUT_INVALID' });
  }
  let result;
  try {
    result = await runner([...descriptor.argv], {
      cwd, timeout: descriptor.timeoutMs, signal
    });
  } catch {
    return Object.freeze({ ok: false, code: 'GAL_GIT_FAILED' });
  }
  if (result?.failure) {
    const code = result.failure === 'cancelled' ? 'GAL_CANCELLED'
      : result.failure === 'timeout' ? 'GAL_TIMEOUT'
        : result.failure === 'output-overflow' ? 'GAL_OUTPUT_LIMIT'
          : result.failure === 'git-unavailable' ? 'GAL_EXECUTABLE_UNAVAILABLE'
            : 'GAL_GIT_FAILED';
    return Object.freeze({ ok: false, code });
  }
  if (result?.status !== 0) return Object.freeze({ ok: false, code: 'GAL_GIT_FAILED' });
  if (!Buffer.isBuffer(result.stdout)) return Object.freeze({ ok: false, code: 'GAL_PROTOCOL_INVALID' });
  const value = descriptor.parse(result.stdout);
  return value ? Object.freeze({ ok: true, value })
    : Object.freeze({ ok: false, code: 'GAL_PROTOCOL_INVALID' });
}
