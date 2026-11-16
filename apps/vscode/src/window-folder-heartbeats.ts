/**
 * A window's heartbeats, one per open folder in a workspace (WS-8). No vscode import, so it is checked without an
 * extension host.
 */
import { lstatSync } from 'node:fs';
import * as path from 'node:path';

/** Whether a folder sits in a workspace (a workspace.json at or above it): only such a folder has presence to keep. */
export function inWorkspaceFolder(folder: string): boolean {
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    try { if (lstatSync(path.join(current, 'workspace.json')).isFile()) return true; } catch { /* keep looking */ }
    if (path.dirname(current) === current) return false;
  }
}

/**
 * The heartbeats a window sends each minute: its own repository's, and in a multi-root window one for every other open
 * folder in a workspace, each under its own presence record, so cleanup never retires a Story checkout open as a second
 * folder (WS-8). Each folder is named with --context-root; nothing else changes for a one-folder window.
 */
export function heartbeatCommands(surface: string, pid: number, folders: readonly string[], bound: string | null): string[][] {
  const base = ['workspace', 'retention', '--heartbeat', '--pid', String(pid)];
  // Only a multi-root window's other Git checkouts: a one-folder window keeps its single heartbeat.
  const checkout = (folder: string): boolean => { try { lstatSync(path.join(folder, '.git')); return true; } catch { return false; } };
  const others = folders.length < 2 ? [] : folders.filter((folder) => !bound || path.resolve(folder) !== path.resolve(bound))
    .filter((folder) => checkout(folder) && inWorkspaceFolder(folder));
  return [[...base.slice(0, 3), '--surface', surface, ...base.slice(3), '--json'],
    ...others.map((folder, index) => [...base.slice(0, 3), '--surface', `${surface}-${index + 1}`, ...base.slice(3), '--context-root', folder, '--json'])];
}
