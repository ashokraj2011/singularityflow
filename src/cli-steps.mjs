/**
 * Existing commands run in a row as one command, for skills that used to spend a Copilot round trip
 * on each. Every step is the same CLI command with `--json`, in its own process, so its refusal
 * keeps its own message, code and recovery plan, and nothing here re-implements a rule.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationContext } from './operation-context.mjs';
import { SingularityFlowError } from './util.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');

/** One step: the same command, in its own process, with its JSON answer or its refusal. */
export function step(args, cwd) {
  // A command started with --no-model runs its steps the same way.
  const model = operationContext()?.modelMode?.enabled === false && !args.includes('--no-model') ? ['--no-model'] : [];
  const child = spawnSync(process.execPath, [CLI, ...model, ...args], {
    cwd, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000
  });
  let value = null;
  try { value = JSON.parse(child.stdout); } catch { value = null; }
  return { ok: child.status === 0, status: child.status, value, stdout: child.stdout, stderr: child.stderr };
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
