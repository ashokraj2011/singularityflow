/** Activity and harness accounting without importing the legacy dispatcher. */
import { repoRoot, branch } from './git-execution.mjs';
import { optionBoolean } from './util.mjs';
import { withReadScope } from './read-scope.mjs';

async function prepare(command, argv, options) {
  const [{ loadDefinition }, { repositoryLogger, redactCommandArgv }, harness] = await Promise.all([
    import('./config.mjs'), import('./logging.mjs'), import('./harness-events.mjs')
  ]);
  const env = optionBoolean(options, 'json') ? { ...process.env, SINGULARITY_FLOW_LOG_CONSOLE: 'off' }
    : optionBoolean(options, 'verbose') ? { ...process.env, SINGULARITY_FLOW_LOG_CONSOLE: 'debug' } : process.env;
  let root = null, definition = null;
  try { root = repoRoot(); } catch { /* Rootless commands still have a console logger. */ }
  // The old logger and harness each loaded this same definition before invocation. This scope
  // ends before the handler can mutate anything; it never caches identity or publication state.
  try { if (root) definition = await loadDefinition(root); } catch { /* Accounting must not refuse the command. */ }
  let log;
  try {
    log = repositoryLogger(root, definition, {
      context: { command, pid: process.pid, ...(root ? { cwd: root, branch: branch(root) ?? null } : {}) }, env
    });
  } catch {
    log = repositoryLogger(null, null, { context: { command, pid: process.pid }, env });
  }
  const persistedArgv = redactCommandArgv(argv);
  let invocation = null;
  if (root && definition && definition.harnessImports?.mode !== 'off') {
    try {
      const { loadSession } = await import('./session.mjs');
      const session = await loadSession(root).catch(() => null);
      invocation = { root, started: harness.beginHarnessInvocation({
        subject: session?.workId ? { kind: 'story', id: session.workId } : null,
        skill: command === 'show' ? 'sflow-show' : null, contractClass: command === 'show' ? 'echo' : null,
        command: ['singularity-flow', ...persistedArgv]
      }) };
    } catch { /* Harness is optional, as in the legacy preparation. */ }
  }
  return { log, invocation, persistedArgv, harness };
}

export async function withCommandObservability(command, argv, options, invoke) {
  const { log, invocation, persistedArgv, harness } = await withReadScope(() => prepare(command, argv, options));
  const started = Date.now();
  log.info('command.start', null, { argv: persistedArgv.slice(0, 24) });
  try {
    const result = await invoke();
    log.info('command.ok', null, { durationMs: Date.now() - started });
    if (invocation) await harness.completeHarnessInvocation(invocation.root, invocation.started, {
      exitCode: 0, output: result?.harnessOutput ?? null,
      actionsExecuted: result?.harnessEvidence?.actionsExecuted ?? [], questions: result?.harnessEvidence?.questions ?? []
    }).catch(() => {});
    return result;
  } catch (error) {
    log.error('command.failed', error?.message, { durationMs: Date.now() - started, exitCode: error?.exitCode ?? 1, error });
    const { markCliFailureLogged } = await import('./cli-failure.mjs');
    markCliFailureLogged(error);
    if (invocation) await harness.completeHarnessInvocation(invocation.root, invocation.started, { exitCode: error?.exitCode ?? 1 }).catch(() => {});
    throw error;
  }
}
