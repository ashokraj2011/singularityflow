/** Machine-local browser workspace lifecycle; independent of repository readiness. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { UiError, idleMinutes } from './contracts.mjs';
import { spawnBackground } from '../background-process.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export async function run(argv, parsed = {}) {
  try { return await runLifecycle(parsed); }
  catch (error) { throw await (await import('./cli-recovery.mjs')).withUiRecovery(error, argv); }
}

async function runLifecycle({ positionals = ['ui'], options = {} } = {}) {
  const action = positionals[1] ?? 'open';
  const allowed = { open: ['json', 'open', 'idle-minutes', 'resume-request', 'timings'], status: ['json', 'timings'], stop: ['json', 'drain', 'timings'], serve: ['json', 'idle-minutes', 'timings'] };
  if (!allowed[action] || positionals.length > 2 || Object.keys(options).some(key => !allowed[action].includes(key))) {
    throw new SingularityFlowError('Use ui open [--no-open] [--idle-minutes 1..60] [--resume-request INVOCATION-ID], ui status --json, ui stop [--drain], or ui serve.', { code: 'UI_COMMAND_INVALID' });
  }
  const idle = idleMinutes(optionString(options, 'idle-minutes') ?? process.env.SINGULARITY_FLOW_UI_IDLE_MINUTES ?? 10);
  // Keep the independent program in its shipped source location. Bundling its import.meta worker
  // and asset URLs into a CLI chunk would relocate them and pull HTTP code into unrelated reads.
  const { openWorkspace, serviceStatus, stopService, ensureService } = await import(
    pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'local-ui', 'client.mjs')).href);
  const json = optionBoolean(options, 'json');
  let result;
  if (action === 'status') result = await serviceStatus();
  if (action === 'stop') result = await stopService({ drain: optionBoolean(options, 'drain') });
  if (action === 'open') {
    result = await openWorkspace({ root: process.cwd(), idle, resume: optionString(options, 'resume-request') ?? null });
    if (options.open !== false) {
      const command = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
      spawnBackground(command, [result.url], { cwd: process.cwd() });
      result.browserLaunch = 'requested';
    }
  }
  if (action === 'serve') {
    const current = await ensureService({ idle, foreground: true });
    if (!current.service) throw new UiError('UI_SERVICE_ALREADY_RUNNING', 'A compatible browser workspace is already running. Use ui open to connect.');
    console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-ui', action, status: 'running', ...current.service.status() }, null, json ? 2 : 0)); // schema-transient: command response
    const stop = () => { void current.service.close(); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    try { await current.service.done; } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
    return;
  }
  result = { schemaVersion: 1, resultType: 'sflow-ui', action, ...result }; // schema-transient: command response
  console.log(json ? JSON.stringify(result, null, 2) : action === 'open'
    ? `SFlow browser workspace: ${result.url}\n${result.reused ? 'Connected to the running service.' : 'Started the independent local service.'}`
    : action === 'status' ? `SFlow browser workspace: ${result.status}` : `SFlow browser workspace: ${result.status ?? 'stopping'}`);
  return result;
}
