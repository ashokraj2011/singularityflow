/**
 * `session open [WORK-ID]`: everything `/sf-session` needs in one command.
 *
 * Attaching a Copilot session took seven commands in a row (pause, workspace, candidates,
 * open-local, attach, status, context, nextsteps), and each was a separate model round trip, so
 * the wait was mostly the model reading one answer to ask the next question. The order and every
 * check stay exactly as they were; this runs them. Each step is the same command with `--json`;
 * reads share the loaded runtime and mutations remain in their own process. A refusal keeps its
 * own message, code and recovery plan, and nothing here
 * re-implements a rule. Without a work ID it returns the candidate table, because choosing a Story
 * is the person's decision, never inferred.
 */
import { step, stop as stopStep } from '../cli-steps.mjs';
import { SingularityFlowError } from '../util.mjs';

const LOCAL_FALLBACK = new Set(['SESSION_LOCAL_STORY_UNAVAILABLE', 'SESSION_LOCAL_REPOSITORY_UNAVAILABLE']);
const OPTIONS = new Set(['workspace', 'repository', 'json', 'for-agent', 'timings']);
const stop = (result, label) => stopStep(result, label, 'SESSION_OPEN_STEP_FAILED');

/** Validate before a pause response, so an invalid request cannot silently become another action. */
export function validateSessionOpenRequest({ positionals, options }) {
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) throw new SingularityFlowError(`session open takes --workspace, --repository, --for-agent, --timings and --json, not --${key}.`, { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  }
  if (positionals.length > 3) throw new SingularityFlowError('session open takes at most one work ID.', { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  if (options.json !== undefined && options.json !== true) throw new SingularityFlowError('session open requires --json without a value.', { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  if (options.timings !== undefined && options.timings !== true) throw new SingularityFlowError('--timings is a boolean flag.', { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  if (options['for-agent'] !== undefined && (options['for-agent'] !== true || options.json !== true)) {
    throw new SingularityFlowError('session open --for-agent requires --json; both are boolean flags.', { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  }
}

/** The same paused result at early dispatch and inside the composed command. No Git or selection. */
export function pausedSessionOpenResult(agentInstruction = null) {
  return { schemaVersion: 1, resultType: 'session-open', status: 'paused', paused: true, agentInstruction }; // schema-transient: composed command response, never a durable record
}

export async function run({ positionals, options }) {
  validateSessionOpenRequest({ positionals, options });
  const json = options.json === true;
  const workId = positionals[2] ?? null;
  const cwd = process.cwd();
  const pause = await step(['pause', 'status', '--json'], cwd);
  if (!pause.ok) stop(pause, 'pause status');
  if (typeof pause.value?.data?.paused !== 'boolean') throw new SingularityFlowError(
    'Session setup could not verify the pause state. Nothing was selected or attached.', { code: 'SESSION_OPEN_PAUSE_UNAVAILABLE' });
  if (pause.value.data.paused) {
    const result = pausedSessionOpenResult(pause.value.data.agentInstruction ?? null);
    return console.log(json ? JSON.stringify(result, null, 2) : 'Singularity Flow guidance is paused. Resume it with /sf-pause off.');
  }
  // Explicit selectors win; otherwise the active workspace's exact scope, never the host cwd's.
  let selectors = [];
  if (options.workspace || options.repository) {
    selectors = [...(options.workspace ? ['--workspace', options.workspace] : []), ...(options.repository ? ['--repository', options.repository] : [])];
  } else {
    const current = await step(['workspace', 'current', '--json'], cwd);
    if (current.ok && current.value?.active && current.value.workspacePath && current.value.repositoryId) {
      selectors = ['--workspace', current.value.workspacePath, '--repository', current.value.repositoryId];
    }
  }
  if (!workId) {
    const table = await step(['session', 'candidates', ...selectors, '--table'], cwd);
    if (!table.ok) stop(table, 'session candidates');
    const result = { schemaVersion: 1, resultType: 'session-open', status: 'choose', selectors, table: table.stdout.trimEnd(),
      nextAction: `singularity-flow session open <WORK-ID>${selectors.length ? ` ${selectors.join(' ')}` : ''}` };
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(result.table);
    return console.log(`\nChoose a Story, then run: ${result.nextAction}`);
  }
  let opened = await step(['session', 'open-local', workId, ...selectors, '--json'], cwd);
  let attached = false;
  if (!opened.ok) {
    if (!LOCAL_FALLBACK.has(opened.value?.error?.code)) stop(opened, 'session open-local');
    opened = await step(['session', 'attach', workId, ...selectors, '--json'], cwd);
    if (!opened.ok) stop(opened, 'session attach');
    attached = true;
  }
  const checkout = opened.value?.repositoryPath;
  if (!checkout) throw new SingularityFlowError(`Opening ${workId} returned no checkout path.`, { code: 'SESSION_OPEN_STEP_FAILED' });
  const projection = process.env.SINGULARITY_FLOW_SESSION_READS === 'legacy' ? null
    : await (await import('../session-read-service.mjs')).readOpenedSession(checkout, { workId });
  const status = projection ? { ok: true, value: projection.session } : await step(['session', 'status', '--json'], checkout);
  if (!status.ok) stop(status, 'session status');
  const agent = opened.value.agent ?? null;
  if (status.value?.ready !== true || status.value.workId !== workId || (status.value.activeAgent ?? null) !== agent) {
    throw new SingularityFlowError(
      `${workId} opened at ${checkout}, but its session does not match (ready: ${status.value?.ready}, Story: ${status.value?.workId}, agent: ${status.value?.activeAgent ?? 'none'}; expected ${agent ?? 'none'}). Nothing else was done.`,
      { code: 'SESSION_OPEN_BINDING_MISMATCH', details: { repositoryPath: checkout } });
  }
  const context = projection ? { ok: true, value: projection.context }
    : await step(['session', 'context', '--work-id', workId, '--slice', 'brief', '--max-output-bytes', '32768', '--json'], checkout);
  if (!context.ok) stop(context, 'session context');
  const next = projection ? { ok: true, value: projection.nextsteps } : await step(['nextsteps', workId, '--json'], checkout);
  if (!next.ok) stop(next, 'nextsteps');
  const result = {
    schemaVersion: 1, resultType: 'session-open', status: 'ready', workId, repositoryPath: checkout,
    localOnly: !attached, attachedFromRemote: attached, open: opened.value, session: status.value,
    context: context.value, nextsteps: next.value
  };
  if (options['for-agent']) Object.assign(result, { ready: true,
    agentInstruction: 'Reuse the verified open/session binding, brief and nextsteps in this result. Do not repeat pause, workspace, session, context or nextsteps lookups merely to obtain the same fields. Selection changes and later operation-specific readiness/consent still require fresh checks.' });
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${workId} is ready at ${checkout} (${attached ? 'attached from the remote' : 'local checkout, no remote sync'}).`);
  console.log(`Agent: ${agent ?? 'none (Story complete)'} · phase: ${opened.value.phase ?? status.value.phase ?? '—'} · commit: ${String(opened.value.head ?? '').slice(0, 8) || '—'}`);
  console.log(`Work there with: cd ${JSON.stringify(checkout)}`);
  const actions = next.value?.actions ?? next.value?.data?.actions ?? [];
  if (actions.length) {
    console.log('Next:');
    actions.forEach((action, index) => console.log(`  ${index + 1}. ${action.label ?? action.reason ?? action.id}${action.command ? ` — ${action.command}` : ''}`));
  }
}
