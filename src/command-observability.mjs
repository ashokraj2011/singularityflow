/** Activity and harness accounting without importing the legacy dispatcher. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, branch } from './git-execution.mjs';
import { optionBoolean } from './util.mjs';
import { withReadScope } from './read-scope.mjs';

async function loadObservabilityConfig(root) {
  if (!root) return null;
  try {
    const workflowPath = path.join(root, 'singularity', 'workflow.yml');
    if (existsSync(workflowPath)) {
      const text = await readFile(workflowPath, 'utf8');
      if (!/^\s*(?:logging|harnessImports)\s*:/m.test(text)) {
        return { harnessImports: { mode: 'off' }, logging: null };
      }
    }
    const { loadDefinition } = await import('./config.mjs');
    return await loadDefinition(root);
  } catch {
    return null;
  }
}

async function prepare(command, argv, options) {
  const { repositoryLogger, redactCommandArgv } = await import('./logging.mjs');
  const env = optionBoolean(options, 'json') ? { ...process.env, SINGULARITY_FLOW_LOG_CONSOLE: 'off' }
    : optionBoolean(options, 'verbose') ? { ...process.env, SINGULARITY_FLOW_LOG_CONSOLE: 'debug' } : process.env;
  let root = null, definition = null;
  try { root = repoRoot(); } catch { /* Rootless commands still have a console logger. */ }
  // The old logger and harness each loaded this same definition before invocation. This scope
  // ends before the handler can mutate anything; it never caches identity or publication state.
  definition = await loadObservabilityConfig(root);
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
  let harness = null;
  if (root && definition && definition.harnessImports?.mode && definition.harnessImports.mode !== 'off') {
    try {
      const [{ loadSession }, harnessModule] = await Promise.all([
        import('./session.mjs'),
        import('./harness-events.mjs')
      ]);
      harness = harnessModule;
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
    if (invocation && harness) await harness.completeHarnessInvocation(invocation.root, invocation.started, {
      exitCode: 0, output: result?.harnessOutput ?? null,
      actionsExecuted: result?.harnessEvidence?.actionsExecuted ?? [], questions: result?.harnessEvidence?.questions ?? []
    }).catch(() => {});
    return result;
  } catch (error) {
    log.error('command.failed', error?.message, { durationMs: Date.now() - started, exitCode: error?.exitCode ?? 1, error });
    const { markCliFailureLogged } = await import('./cli-failure.mjs');
    markCliFailureLogged(error);
    if (invocation && harness) await harness.completeHarnessInvocation(invocation.root, invocation.started, { exitCode: error?.exitCode ?? 1 }).catch(() => {});
    throw error;
  }
}
