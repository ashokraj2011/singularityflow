import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_CLI_TIMEOUT_MS = 120_000;
export const REPOSITORY_SNAPSHOT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function validateRepositoryDirectory(repository) {
  const resolved = path.resolve(repository || '');
  const root = await stat(resolved).catch(() => null);
  if (!root?.isDirectory()) throw new Error('The selected repository folder does not exist or is not a directory.');
  const git = await stat(path.join(resolved, '.git')).catch(() => null);
  if (!git) throw new Error(`The selected folder is not a Git repository: ${resolved}`);
  const workflow = await stat(path.join(resolved, 'singularity', 'workflow.yml')).catch(() => null);
  if (!workflow?.isFile()) throw new Error(`The selected Git repository is not initialized with Singularity Flow. Select the folder containing singularity/workflow.yml or run 'singularity-flow init' there first.`);
  return resolved;
}

export function invokeCliProcess({ executable, cli, repository, args, input = null, json = true, env = {}, timeoutMs = DESKTOP_CLI_TIMEOUT_MS, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => finish(reject, error instanceof Error ? error : new Error(String(error)));
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child?.kill('SIGTERM');
        fail(new Error('The Singularity Flow CLI returned too much data while opening the repository.'));
        return target;
      }
      return target + chunk.toString('utf8');
    };

    try {
      child = spawnImpl(executable, [cli, ...args], {
        cwd: repository,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      fail(error);
      return;
    }

    timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail(new Error(`The Singularity Flow CLI did not finish within ${Math.ceil(timeoutMs / 1000)} seconds. Check the selected repository in a terminal and try again.`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return fail(new Error(stderr.trim().replace(/^Singularity Flow error:\s*/, '') || stdout.trim() || `CLI exited with ${code}`));
      if (!json) return finish(resolve, { output: stdout.trim() });
      try { finish(resolve, JSON.parse(stdout)); }
      catch { fail(new Error(`The CLI returned invalid data: ${stdout.slice(0, 500)}`)); }
    });
    if (input == null) child.stdin.end();
    else child.stdin.end(input, 'utf8');
  });
}
