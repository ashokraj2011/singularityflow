/**
 * Existing commands run in a row as one command, for skills that used to spend a Copilot round trip
 * on each. Each step enters the same CLI dispatcher. Fixed model-free reads share the loaded
 * runtime but never a caller's read cache or configuration overlay. Mutations remain isolated
 * child processes, with their existing timeout and refusal packet. Rules are never duplicated.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationContext } from './operation-context.mjs';
import { SingularityFlowError, parseArgs } from './util.mjs';
import { resolveOperation } from './command-registry.mjs';
import { withoutReadScope } from './read-scope.mjs';
import { withoutConfigurationReadScope } from './configuration-read-scope.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { capturedStepResult, stepFailureSummary, stepRefusal } from './cli-step-result.mjs';
import { boundExecutionContextRoot, SURFACE_CONTEXT_ENV } from './execution-context-scope.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');

/** One step: the same command, in its own process, with its JSON answer or its refusal. */
function processStep(args, cwd) {
  // A command started with --no-model runs its steps the same way.
  const model = operationContext()?.modelMode?.enabled === false && !args.includes('--no-model') ? ['--no-model'] : [];
  // A step's result is read whole by the command that ran it; only that command's own output is bounded.
  const child = spawnSync(process.execPath, [CLI, ...model, ...args], {
    cwd, env: { ...process.env,
      ...(boundExecutionContextRoot() ? { [SURFACE_CONTEXT_ENV]: JSON.stringify({ schemaVersion: 1, repositoryPath: path.resolve(cwd) }) } : {}),
      SINGULARITY_FLOW_AGENT_OUTPUT: 'raw', SINGULARITY_FLOW_REFUSAL_ENVELOPE: 'stderr-v1' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000
  });
  return capturedStepResult(child);
}

const READ_STEPS = new Set([
  'pause.status', 'workspace.current', 'session.candidates', 'session.status',
  'session.context', 'nextsteps', 'phase.prepublish', 'phase.show', 'status'
]);
let queue = Promise.resolve();

/** Only the fixed model-free read steps may reuse this runtime. Mutations keep process isolation. */
export function reusableReadStep(args) {
  try {
    const { positionals, options } = parseArgs(args);
    const operation = resolveOperation({ requestedCommand: positionals[0], positionals, options });
    const shape = [positionals[0], positionals[1]].filter(Boolean).join('.');
    return operation.classification === 'read' && operation.modelPolicy === 'never'
      && (READ_STEPS.has(shape) || READ_STEPS.has(positionals[0]) && ['status', 'nextsteps'].includes(positionals[0]));
  } catch { return false; }
}

async function readStep(args, cwd) {
  const previousCwd = process.cwd(), previousExit = process.exitCode;
  const previousStarted = globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT;
  const previousDepth = globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH ?? 0;
  const out = process.stdout.write, err = process.stderr.write;
  const presentation = Object.fromEntries(['SINGULARITY_FLOW_AGENT_OUTPUT', 'SINGULARITY_FLOW_REFUSAL_ENVELOPE', SURFACE_CONTEXT_ENV]
    .map(key => [key, process.env[key]]));
  const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  const capture = name => function(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    sizes[name] += bytes.length;
    if (sizes[name] > 64 * 1024 * 1024) throw new SingularityFlowError('Composed read output exceeded its bound.', { code: 'CLI_STEP_OUTPUT_TOO_LARGE' });
    chunks[name].push(bytes);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  let status = 0;
  try {
    if (boundExecutionContextRoot()) process.env[SURFACE_CONTEXT_ENV] = JSON.stringify({ schemaVersion: 1, repositoryPath: path.resolve(cwd) });
    process.chdir(cwd); process.exitCode = undefined;
    process.env.SINGULARITY_FLOW_AGENT_OUTPUT = 'raw';
    process.env.SINGULARITY_FLOW_REFUSAL_ENVELOPE = 'stderr-v1';
    globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
    globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = previousDepth + 1;
    process.stdout.write = capture('stdout'); process.stderr.write = capture('stderr');
    await withoutReadScope(() => withoutConfigurationReadScope(async () => {
      try {
        const { main } = await import('./cli-entry.mjs');
        await main(args);
      } catch (error) {
        const { reportCliFailure } = await import('./cli-failure.mjs');
        await reportCliFailure(error, args);
      }
    }));
    status = process.exitCode ?? 0;
  } finally {
    process.stdout.write = out; process.stderr.write = err;
    process.exitCode = previousExit;
    globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = previousStarted;
    globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = previousDepth;
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(presentation)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
  return capturedStepResult({ status, stdout, stderr });
}

/** Serialize captured reads; every step keeps a fresh operation context and its exact refusal. */
export async function step(args, cwd) {
  const model = operationContext()?.modelMode?.enabled === false && !args.includes('--no-model') ? ['--no-model'] : [];
  const effective = [...model, ...args];
  const invoke = () => {
    if (process.env.SINGULARITY_FLOW_COMPOSED_READS === 'off' || !reusableReadStep(effective)) {
      incrementCommandCounter('cli.steps.process-spawns');
      return measureCommandSpan('cli.steps.process', () => processStep(effective, cwd));
    }
    incrementCommandCounter('cli.steps.read-reused');
    return measureCommandSpan('cli.steps.read', () => readStep(effective, cwd));
  };
  const pending = queue.then(invoke, invoke);
  queue = pending.then(() => undefined, () => undefined);
  return pending;
}

/**
 * A failed step ends the command with that step's own refusal, untouched: its JSON result travels
 * with the error, and the error boundary prints it as it is (cli-failure.mjs), so its recovery plan
 * is the step's own and not one rebuilt from a copy of its code and details.
 */
export function stop(result, label, code = 'CLI_STEP_FAILED') {
  const exitCode = Number.isInteger(result.status) && result.status !== 0 ? result.status : 1;
  const relayed = stepRefusal(result);
  const error = relayed?.error
    ? new SingularityFlowError(relayed.error.message ?? `${label} was refused.`, {
      code: relayed.error.code ?? 'CLI_STEP_REFUSED', exitCode,
      details: { step: label, ...(relayed.error.details ?? {}) }
    })
    : new SingularityFlowError(`${label} did not complete: ${stepFailureSummary(result)}`, {
      code: result.timedOut ? 'CLI_STEP_TIMEOUT' : result.processError?.code === 'ENOBUFS' ? 'CLI_STEP_OUTPUT_TOO_LARGE' : code,
      exitCode, details: { execution: { step: label, exitCode: result.status ?? null, signal: result.signal ?? null,
        timedOut: result.timedOut === true, processCode: result.processError?.code ?? null } }
    });
  if (relayed) Object.defineProperty(error, 'relayedResult', { value: relayed });
  throw error;
}

/**
 * What follows a step an `-if-ready` command just took, from the review it already read. The
 * checked result's own fields stay unchanged and describe the moment before the step ran, when that
 * step was itself the next action. An agent that read the long result from the top reported
 * "published" and ended without offering what follows, so callers put this first.
 */
export function nextAfterStep(review, done) {
  const continuation = review?.continuation ?? null;
  const action = continuation?.nextAction ?? null;
  return {
    instruction: `${done} End the reply with this next action: its reason, then its Copilot, Shell and VS Code (model-free) routes in that order, saying "not available for this action" for a missing one. Fields after this one describe the check before the step ran.`,
    ...(continuation?.contextBoundary ? { contextBoundary: continuation.contextBoundary } : {}),
    reason: action?.reason ?? null,
    commandGuidance: action ? { copilotCommand: continuation.copilotCommand ?? null,
      command: continuation.nextCommand ?? null, modelFreeCommand: continuation.modelFreeCommand ?? null } : null
  };
}
