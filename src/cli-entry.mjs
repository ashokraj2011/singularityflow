import { commandDefinition } from './command-registry.mjs';
import { commandTimer, recordCommandTiming, writeCommandTimings } from './dx-command-timing.mjs';
import { repoRoot } from './git.mjs';
import { parseArgs, SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';

// These commands promise to remove machine-local Singularity state. Recording their own duration
// after they finish would immediately recreate `.git/singularity-flow/` and make that promise false.
const LOCAL_STATE_RESET_COMMANDS = new Set(['factory-reset', 'reset-all']);

function rootIfAvailable() {
  try { return repoRoot(); } catch { return null; }
}

export async function main(argv) {
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return console.log(VERSION);
  const { positionals, options } = parseArgs(argv);
  const requested = positionals[0];
  if (!requested || ['--help', '-h'].includes(requested)) {
    const legacy = await import('./commands/legacy.mjs');
    return legacy.run(argv, { positionals, options });
  }
  if (requested === 'version') return console.log(VERSION);

  const definition = commandDefinition(requested);
  if (!definition) throw new SingularityFlowError(`Unknown command: ${requested}`);
  const timer = commandTimer(definition.name, globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT ?? process.hrtime.bigint());
  timer.stage('root-dispatch');
  const root = rootIfAvailable();
  try {
    const module = await import(definition.modulePath);
    timer.stage('module-load');
    const result = await module.run(argv, { positionals: [definition.name, ...positionals.slice(1)], options, definition });
    timer.stage('execute');
    const event = timer.finish({ outcome: 'ok' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name)) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    return result;
  } catch (error) {
    timer.stage('execute');
    const event = timer.finish({ outcome: 'error', error: error?.name ?? 'Error' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name)) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    throw error;
  }
}
