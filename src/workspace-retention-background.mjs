/** Bounded opportunistic maintenance, outside foreground Story/approval transactions. */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export async function scheduleWorkspaceRetention(workspacePath, { protect = [], env = process.env } = {}) {
  if (!workspacePath || env.SINGULARITY_FLOW_AUTOMATIC_CLEANUP === 'off' || env.NODE_ENV === 'test') return false;
  try {
    const { workspaceRetentionSettings } = await import('./workspace-retention.mjs');
    const settings = await workspaceRetentionSettings(workspacePath);
    if (!settings.enabled) return false;
    // This is only a launch throttle. The worker revalidates policy, records, identity and proofs.
    const state = JSON.parse(await readFile(path.join(workspacePath, '.singularity-flow', 'cleanup-state.json'), 'utf8').catch(() => '{}'));
    const age = Date.now() - Date.parse(state.checkedAt);
    if (age >= 0 && age < settings.intervalMinutes * 60000) return false;
    // The shipped source worker is intentionally not part of the foreground cold bundle closure.
    const child = fork(fileURLToPath(new URL('../src/workspace-retention-worker.mjs', import.meta.url)), [], {
      cwd: workspacePath, env: { ...env }, execArgv: [], windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    child.once('error', () => { /* Worker launch cannot fail the successful workspace/session operation. */ });
    child.send({ workspacePath: path.resolve(workspacePath), protect }, () => {
      if (child.connected) child.disconnect();
      child.unref();
    });
    return true;
  } catch { return false; /* Invalid preferences suspend maintenance; the explicit command reports them. */ }
}
