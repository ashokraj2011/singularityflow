/**
 * The acts behind the mutation planners, for a host that may carry them out. `[INT:CON-110]`
 *
 * Separate from the planner map on purpose. Every host has the planners — a read-only host can
 * show every plan — and only a host built with `readOnly: false` and this map can carry one out,
 * after a confirmation receipt redeems. `work.start` needs the host's own route to the `start`
 * operation, so it is present only when the host supplies one.
 */
const lazy = (load, name) => async (request) => (await load())[name](request);
const watches = () => import('./watches.mjs');
const starts = () => import('./work-start.mjs');
const workspaces = () => import('./workspace-switch.mjs');

export function gatewayMutationExecutors({ runStart = null } = {}) {
  return new Map(Object.entries({
    'watch-create': lazy(watches, 'watchCreateExecute'),
    'watch-revoke': lazy(watches, 'watchRevokeExecute'),
    'work-draft-save': lazy(starts, 'workDraftSaveExecute'),
    'workspace-switch': lazy(workspaces, 'workspaceSwitchExecute'),
    ...(runStart ? { 'work-start': async (request) => (await starts()).workStartExecutor({ runStart })(request) } : {})
  }));
}

/**
 * This package's CLI as a bounded child: exit status and parsed JSON. `[INT:CON-066]`
 *
 * Asynchronous on purpose. The stdio gateway runs `start --fetch` through here, and a synchronous
 * child held its event loop for as long as the start took, so pings, cancellations and the replies
 * to its own confirmation requests went unanswered. A child still running at `timeoutMs` is stopped
 * with its process tree, and `timedOut` says so: what it had done by then is not known. Kept here,
 * beside its one caller, rather than in util.mjs, which every command loads eagerly.
 */
export async function runSingularityFlowCli(args, { cwd, env = process.env, timeoutMs = 600_000, spawnCommand = null } = {}) {
  const [{ spawn }, { default: path }, { PACKAGE_ROOT }, { signalProcessTree }] = await Promise.all([
    import('node:child_process'), import('node:path'), import('../../package-root.mjs'), import('../../util.mjs')
  ]);
  const maxBytes = 1 << 25;
  return new Promise((resolve) => {
    let child;
    try {
      child = (spawnCommand ?? spawn)(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs'), ...args],
        { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
    } catch { resolve({ status: null, signal: null, json: null, timedOut: false }); return; }
    const chunks = [];
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    child.stdout?.on('data', (chunk) => { bytes += chunk.length; if (bytes <= maxBytes) chunks.push(chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      void signalProcessTree(child, 'SIGTERM');
      setTimeout(() => { if (!settled) void signalProcessTree(child, 'SIGKILL'); }, 5_000).unref?.();
    }, timeoutMs);
    const settle = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let json = null;
      if (!timedOut && bytes <= maxBytes) { try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } }
      resolve({ status, signal: signal ?? null, json, timedOut });
    };
    child.once('error', () => settle(null, null));
    child.once('close', (code, signal) => settle(code, signal));
  });
}

/** The CLI-side route to `start`: this package's own CLI, as a bounded child process. */
export async function cliStartRoute(argv, { cwd }) {
  return runSingularityFlowCli(argv, { cwd });
}

/**
 * Everything the CLI-side host (the stdio gateway) can carry out, including the disposable
 * bisection, which runs configured test commands in temporary worktrees. Kept out of the shared map
 * so the editor bundle does not carry a test runner it never plans for.
 */
export function cliMutationExecutors() {
  const executors = gatewayMutationExecutors({ runStart: cliStartRoute });
  executors.set('investigation-bisect', async (request) => (await import('./investigation-bisect.mjs')).investigationBisectExecute(request));
  return executors;
}
