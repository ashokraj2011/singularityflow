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

/** The CLI-side route to `start`: this package's own CLI, as a bounded child process. */
export async function cliStartRoute(argv, { cwd }) {
  const { runSingularityFlowCli } = await import('../../util.mjs');
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
