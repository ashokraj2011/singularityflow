/**
 * The office checks' one place that starts a process (`singularity-flow probe office`).
 *
 * Every probe asks a tool through here, so the reviewed process sites stay in one file
 * (scripts/git-bypass-baseline.json). Nothing here prompts: Git never asks in the terminal, and every
 * call has a deadline. A tool that is missing answers `missing: true` instead of throwing.
 */
import { spawn } from 'node:child_process';
import { resolvePlatformProcess } from '../platform-process.mjs';
import { run } from '../util.mjs';

const QUIET_GIT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SINGULARITY_FLOW_GIT_FACT_CACHE: 'off' };

function answer(result, error = null) {
  const failure = error ?? result?.error ?? null;
  return {
    ok: !failure && result?.status === 0,
    status: result?.status ?? null,
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? failure?.message ?? ''),
    timedOut: Boolean(result?.timedOut),
    missing: Boolean(failure && (failure.code === 'ENOENT' || failure.code === 'SUBPROCESS_UNAVAILABLE'
      || /not found|unavailable|ENOENT/iu.test(String(failure.message ?? ''))))
  };
}

/** One short tool call: `node --version`, `copilot --version`, `reg query ...`. */
export function tool(command, args = [], { cwd = process.cwd(), env = process.env, timeoutMs = 20_000, input } = {}) {
  try {
    return answer(run(command, args, { cwd, env, allowFailure: true, timeoutMs, input, windowsHide: true }));
  } catch (error) { return answer(null, error); }
}

/** Git, with no prompt and no cached answers: the probes change what they read between calls. */
export function gitIn(cwd, args, { env = process.env, timeoutMs = 60_000, input } = {}) {
  try {
    return answer(run('git', args, { cwd, env: { ...env, ...QUIET_GIT }, allowFailure: true, timeoutMs, input, windowsHide: true }));
  } catch (error) { return answer(null, error); }
}

/**
 * A longer tool call that must not block this process: Copilot CLI talks to the stand-in model this
 * process serves, so the event loop keeps running while it works.
 */
export function launch(command, args = [], { cwd = process.cwd(), env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const resolved = resolvePlatformProcess(command, args, { environment: env, cwd });
      child = spawn(resolved.executable, resolved.arguments, {
        cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(resolved.spawnOptions ?? {})
      });
    } catch (error) { resolve(answer(null, error)); return; }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (text, chunk) => (text.length > 200_000 ? text : text + chunk);
    child.stdout.on('data', (chunk) => { stdout = cap(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = cap(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve(answer({ status: null, stdout, stderr }, error)); });
    child.on('close', (status) => { clearTimeout(timer); resolve(answer({ status, stdout, stderr, timedOut })); });
  });
}
