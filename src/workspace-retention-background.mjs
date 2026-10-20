/** Bounded opportunistic maintenance, outside foreground Story/approval transactions. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';

/**
 * The worker's launch packet travels in its environment, never over IPC. The worker is an ES
 * module, which Node evaluates asynchronously: a message sent right after the launch arrives
 * before the worker's listener exists and is dropped, so the worker exited having done nothing.
 * The worker reads and removes the variable before any work, so its own Git children never see it.
 */
export const RETENTION_WORKER_PACKET = 'SINGULARITY_FLOW_RETENTION_WORKER_PACKET';
// Below Windows' 32,767-character limit for one environment variable.
const MAXIMUM_PACKET_CHARACTERS = 30_000;

export async function scheduleWorkspaceRetention(workspacePath, { protect = [], env = process.env } = {}) {
  if (!workspacePath || env.SINGULARITY_FLOW_AUTOMATIC_CLEANUP === 'off' || env.NODE_ENV === 'test') return false;
  try {
    const { workspaceRetentionSettings } = await import('./workspace-retention.mjs');
    const settings = await workspaceRetentionSettings(workspacePath);
    if (!settings.enabled) return false;
    // This is only a launch throttle. The worker revalidates policy, records, identity and proofs.
    const stateFile = path.join(workspacePath, '.singularity-flow', 'cleanup-state.json');
    const info = await lstat(stateFile).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024)) return false;
    const state = info ? JSON.parse(await readFile(stateFile, 'utf8')) : {};
    const age = Date.now() - Date.parse(state.checkedAt);
    if (age >= 0 && age < settings.intervalMinutes * 60000) return false;
    // Capture before spawning: a removed caller cwd must not leave a half-launched worker behind.
    const protectedPaths = [...new Set([process.cwd(), ...protect])];
    if (protectedPaths.length > 32) return false;
    // The worker's cwd is the workspace, not the terminal that launched it. Preserve the
    // caller's actual directory too, even when this command selects another Story/window.
    const packet = JSON.stringify({ workspacePath: path.resolve(workspacePath), protect: protectedPaths });
    if (packet.length > MAXIMUM_PACKET_CHARACTERS) return false;
    // The shipped source worker is intentionally not part of the foreground cold bundle closure.
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/workspace-retention-worker.mjs', import.meta.url))], {
      cwd: workspacePath, env: { ...env, [RETENTION_WORKER_PACKET]: packet }, windowsHide: true, stdio: 'ignore'
    });
    child.once('error', () => { /* Worker launch cannot fail the successful workspace/session operation. */ });
    child.unref();
    return true;
  } catch { return false; /* Invalid preferences suspend maintenance; the explicit command reports them. */ }
}
