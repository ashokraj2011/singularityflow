/**
 * `session open [WORK-ID]`: everything `/sf-session` needs in one command.
 *
 * Attaching a Copilot session took seven commands in a row (pause, workspace, candidates,
 * open-local, attach, status, context, nextsteps), and each was a separate model round trip, so
 * the wait was mostly the model reading one answer to ask the next question. The order and every
 * check stay exactly as they were; this runs them. Each step is the same command with `--json`, in
 * its own process, so a refusal keeps its own message, code and recovery plan, and nothing here
 * re-implements a rule. Without a work ID it returns the candidate table, because choosing a Story
 * is the person's decision, never inferred.
 */
import { step, stop as stopStep } from '../cli-steps.mjs';
import { SingularityFlowError } from '../util.mjs';

const LOCAL_FALLBACK = new Set(['SESSION_LOCAL_STORY_UNAVAILABLE', 'SESSION_LOCAL_REPOSITORY_UNAVAILABLE']);
const OPTIONS = new Set(['workspace', 'repository', 'json']);
const stop = (result, label) => stopStep(result, label, 'SESSION_OPEN_STEP_FAILED');

export async function run({ positionals, options }) {
  for (const key of Object.keys(options)) {
    if (!OPTIONS.has(key)) throw new SingularityFlowError(`session open takes --workspace, --repository and --json, not --${key}.`, { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  }
  if (positionals.length > 3) throw new SingularityFlowError('session open takes at most one work ID.', { code: 'SESSION_OPEN_OPTION_UNSUPPORTED' });
  const json = options.json === true;
  const workId = positionals[2] ?? null;
  const cwd = process.cwd();
  const pause = step(['pause', 'status', '--json'], cwd);
  if (pause.ok && pause.value?.data?.paused) {
    const result = { schemaVersion: 1, resultType: 'session-open', status: 'paused', agentInstruction: pause.value.data.agentInstruction ?? null };
    return console.log(json ? JSON.stringify(result, null, 2) : 'Singularity Flow guidance is paused. Resume it with /sf-pause off.');
  }
  // Explicit selectors win; otherwise the active workspace's exact scope, never the host cwd's.
  let selectors = [];
  if (options.workspace || options.repository) {
    selectors = [...(options.workspace ? ['--workspace', options.workspace] : []), ...(options.repository ? ['--repository', options.repository] : [])];
  } else {
    const current = step(['workspace', 'current', '--json'], cwd);
    if (current.ok && current.value?.active && current.value.workspacePath && current.value.repositoryId) {
      selectors = ['--workspace', current.value.workspacePath, '--repository', current.value.repositoryId];
    }
  }
  if (!workId) {
    const table = step(['session', 'candidates', ...selectors, '--table'], cwd);
    if (!table.ok) stop(table, 'session candidates');
    const result = { schemaVersion: 1, resultType: 'session-open', status: 'choose', selectors, table: table.stdout.trimEnd(),
      nextAction: `singularity-flow session open <WORK-ID>${selectors.length ? ` ${selectors.join(' ')}` : ''}` };
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(result.table);
    return console.log(`\nChoose a Story, then run: ${result.nextAction}`);
  }
  let opened = step(['session', 'open-local', workId, ...selectors, '--json'], cwd);
  let attached = false;
  if (!opened.ok) {
    if (!LOCAL_FALLBACK.has(opened.value?.error?.code)) stop(opened, 'session open-local');
    opened = step(['session', 'attach', workId, ...selectors, '--json'], cwd);
    if (!opened.ok) stop(opened, 'session attach');
    attached = true;
  }
  const checkout = opened.value?.repositoryPath;
  if (!checkout) throw new SingularityFlowError(`Opening ${workId} returned no checkout path.`, { code: 'SESSION_OPEN_STEP_FAILED' });
  const status = step(['session', 'status', '--json'], checkout);
  if (!status.ok) stop(status, 'session status');
  const agent = opened.value.agent ?? null;
  if (status.value?.ready !== true || status.value.workId !== workId || (status.value.activeAgent ?? null) !== agent) {
    throw new SingularityFlowError(
      `${workId} opened at ${checkout}, but its session does not match (ready: ${status.value?.ready}, Story: ${status.value?.workId}, agent: ${status.value?.activeAgent ?? 'none'}; expected ${agent ?? 'none'}). Nothing else was done.`,
      { code: 'SESSION_OPEN_BINDING_MISMATCH', details: { repositoryPath: checkout } });
  }
  const context = step(['session', 'context', '--work-id', workId, '--slice', 'brief', '--max-output-bytes', '32768', '--json'], checkout);
  if (!context.ok) stop(context, 'session context');
  const next = step(['nextsteps', workId, '--json'], checkout);
  if (!next.ok) stop(next, 'nextsteps');
  const result = {
    schemaVersion: 1, resultType: 'session-open', status: 'ready', workId, repositoryPath: checkout,
    localOnly: !attached, attachedFromRemote: attached, open: opened.value, session: status.value,
    context: context.value, nextsteps: next.value
  };
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
