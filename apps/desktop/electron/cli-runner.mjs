import { spawn, spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DESKTOP_CLI_TIMEOUT_MS = 120_000;
export const REPOSITORY_SNAPSHOT_TIMEOUT_MS = 45_000;
// Governed image/PDF previews may contain a 25 MiB document encoded as base64.
const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

export class LegacyControlRootError extends Error {
  constructor(repository, legacyRoot) {
    super(`This repository uses the former ${legacyRoot}/ control folder. Migrate it to the visible singularity/ folder before opening it.`);
    this.name = 'LegacyControlRootError';
    this.code = 'SINGULARITY_FLOW_LEGACY_CONTROL_ROOT';
    this.repository = repository;
    this.legacyRoot = legacyRoot;
  }
}

export async function validateRepositoryDirectory(repository) {
  const resolved = path.resolve(repository || '');
  const canonical = await realpath(resolved).catch(() => null);
  const root = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!root?.isDirectory()) throw new Error('The selected repository folder does not exist or is not a directory.');
  const git = await lstat(path.join(canonical, '.git')).catch(() => null);
  if (!git) throw new Error(`The selected folder is not a Git repository: ${resolved}`);
  if (git.isSymbolicLink()) throw new Error(`The selected repository has unsafe symbolic-link Git metadata: ${canonical}`);
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: canonical,
    encoding: 'utf8',
    windowsHide: true
  });
  if (probe.status !== 0 || !probe.stdout?.trim()) {
    throw new Error(`The selected folder is not a valid Git working tree: ${canonical}`);
  }
  const topLevel = await realpath(probe.stdout.trim()).catch(() => null);
  if (!topLevel || topLevel !== canonical) {
    throw new Error(`Select the Git repository root instead of a nested directory: ${canonical}`);
  }

  const control = await lstat(path.join(canonical, 'singularity')).catch(() => null);
  if (control?.isSymbolicLink()) throw new Error(`The singularity control directory cannot be a symbolic link: ${canonical}`);
  const workflow = await lstat(path.join(canonical, 'singularity', 'workflow.yml')).catch(() => null);
  if (workflow?.isSymbolicLink()) throw new Error(`The Singularity Flow workflow cannot be a symbolic link: ${canonical}`);
  if (!workflow?.isFile()) {
    for (const legacyRoot of ['.singularity', '.sdlc']) {
      const legacyControl = await lstat(path.join(canonical, legacyRoot)).catch(() => null);
      if (legacyControl?.isSymbolicLink()) throw new Error(`The former ${legacyRoot} control directory cannot be a symbolic link: ${canonical}`);
      const legacyWorkflow = await lstat(path.join(canonical, legacyRoot, 'workflow.yml')).catch(() => null);
      const legacyConfig = await lstat(path.join(canonical, legacyRoot, 'config.json')).catch(() => null);
      if (legacyWorkflow?.isSymbolicLink() || legacyConfig?.isSymbolicLink()) {
        throw new Error(`Former Singularity Flow configuration files cannot be symbolic links: ${canonical}/${legacyRoot}`);
      }
      if (legacyWorkflow?.isFile() || legacyConfig?.isFile()) throw new LegacyControlRootError(canonical, legacyRoot);
    }
    throw new Error(`The selected Git repository is not initialized with Singularity Flow. Select the folder containing singularity/workflow.yml or run 'singularity-flow init' there first.`);
  }
  return canonical;
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
