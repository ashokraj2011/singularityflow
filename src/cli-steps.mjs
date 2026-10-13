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

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');

/** One step: the same command, in its own process, with its JSON answer or its refusal. */
function processStep(args, cwd) {
  // A command started with --no-model runs its steps the same way.
  const model = operationContext()?.modelMode?.enabled === false && !args.includes('--no-model') ? ['--no-model'] : [];
  const child = spawnSync(process.execPath, [CLI, ...model, ...args], {
    cwd, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000
  });
  let value = null;
  try { value = JSON.parse(child.stdout); } catch { value = null; }
  return { ok: child.status === 0, status: child.status, value, stdout: child.stdout, stderr: child.stderr };
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
  const out = process.stdout.write, err = process.stderr.write;
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
    process.chdir(cwd); process.exitCode = undefined;
    globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT = process.hrtime.bigint();
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
    process.chdir(previousCwd);
  }
  const stdout = Buffer.concat(chunks.stdout).toString('utf8'), stderr = Buffer.concat(chunks.stderr).toString('utf8');
  let value = null;
  try { value = JSON.parse(stdout); } catch { /* Human table output is intentionally not JSON. */ }
  return { ok: status === 0, status, value, stdout, stderr };
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
  const relayed = result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value : null;
  const error = relayed?.error
    ? new SingularityFlowError(relayed.error.message ?? `${label} was refused.`, {
      code: relayed.error.code ?? 'CLI_STEP_REFUSED', exitCode,
      details: { step: label, ...(relayed.error.details ?? {}) }
    })
    : new SingularityFlowError(`${label} did not complete: ${(result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? 'no output'}`, {
      code, exitCode, details: { step: label }
    });
  if (relayed) Object.defineProperty(error, 'relayedResult', { value: relayed });
  throw error;
}
