import { createHash } from 'node:crypto';
import { commandDefinition, operationById, resolveOperation } from './command-registry.mjs';
import { commandTimer, recordCommandTiming, writeCommandTimings } from './dx-command-timing.mjs';
import { repoRoot } from './git.mjs';
import { parseArgs, SingularityFlowError } from './util.mjs';
import { VERSION } from './version.mjs';
import { resolveModelMode, stripGlobalModelOptions } from './model-mode.mjs';
import { withOperationContext } from './operation-context.mjs';

// These commands promise to remove machine-local Singularity state. Recording their own duration
// after they finish would immediately recreate `.git/singularity-flow/` and make that promise false.
const LOCAL_STATE_RESET_COMMANDS = new Set(['factory-reset', 'reset-all']);

function rootIfAvailable() {
  try { return repoRoot(); } catch { return null; }
}

export async function main(argv) {
  const modelMode = resolveModelMode(argv);
  const effectiveArgv = stripGlobalModelOptions(argv);
  const root = rootIfAvailable();
  const argvSha256 = createHash('sha256').update(JSON.stringify(effectiveArgv)).digest('hex');
  if (effectiveArgv.length === 1 && ['--version', '-v'].includes(effectiveArgv[0])) {
    return withOperationContext({
      operation: { id: 'version', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'version', startedAt: new Date().toISOString()
    }, () => console.log(VERSION));
  }
  const { positionals, options } = parseArgs(effectiveArgv);
  const requested = positionals[0];
  if (!requested || ['--help', '-h'].includes(requested)) {
    return withOperationContext({
      operation: { id: 'help.root', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode,
      root,
      argvSha256,
      argvHash: `sha256:${argvSha256}`,
      command: 'help',
      startedAt: new Date().toISOString()
    }, async () => {
      const legacy = await import('./commands/legacy.mjs');
      return legacy.run(effectiveArgv, { positionals, options });
    });
  }
  if (requested === 'version') {
    return withOperationContext({
      operation: { id: 'version', modelPolicy: 'never', classification: 'read', output: 'human' },
      modelMode, root, argvSha256, argvHash: `sha256:${argvSha256}`, command: 'version', startedAt: new Date().toISOString()
    }, () => console.log(VERSION));
  }

  const definition = commandDefinition(requested);
  if (!definition) throw new SingularityFlowError(`Unknown command: ${requested}`);
  const requestedOperation = resolveOperation({ requestedCommand: requested, positionals: [definition.name, ...positionals.slice(1)], options });
  const operation = requestedOperation.modelPolicy === 'optional' && !modelMode.enabled
    ? operationById(requestedOperation.fallback.operationId)
    : requestedOperation;
  if (operation.modelPolicy === 'required' && !modelMode.enabled) {
    const fallback = operation.fallback?.operationId
      ? ` Use the model-free fallback: singularity-flow ${operation.fallback.operationId.replace('.', ' ')}.`
      : '';
    throw new SingularityFlowError(`Operation '${operation.id}' requires a model and cannot run with --no-model.${fallback}`, {
      code: 'MODEL_UNAVAILABLE', details: { operationId: operation.id, fallback: operation.fallback ?? null }
    });
  }
  const timer = commandTimer(definition.name, {
    started: globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT ?? process.hrtime.bigint(),
    // The resolved operation, not the command. `report`, `telemetry`, `review`, `inputs`, `spec` and
    // `visual` each carry both read and mutating subcommands, so the command-level value calls every
    // one of them a mutation and mis-partitions the DX timing dataset. The VS Code adapter already
    // classifies per subcommand; this keeps the two surfaces telling the same story.
    commandClass: operation.classification
  });
  timer.stage('root-dispatch');
  try {
    const module = await import(definition.modulePath);
    timer.stage('module-load');
    const result = await withOperationContext({
      operation,
      modelMode,
      root,
      argvSha256,
      argvHash: `sha256:${argvSha256}`,
      fallbackFrom: operation.id === requestedOperation.id ? null : requestedOperation.id,
      command: definition.name,
      startedAt: new Date().toISOString()
    }, () => module.run(effectiveArgv, { positionals: [definition.name, ...positionals.slice(1)], options, definition, operation, requestedOperation, modelMode }));
    timer.stage('execute');
    const event = timer.finish({ outcome: 'success' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name)) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    return result;
  } catch (error) {
    timer.stage('execute');
    const event = timer.finish({ outcome: 'error', errorClass: error?.name ?? 'Error' });
    if (!LOCAL_STATE_RESET_COMMANDS.has(definition.name)) await recordCommandTiming(root, event);
    if (options.timings === true) writeCommandTimings(event);
    throw error;
  }
}
