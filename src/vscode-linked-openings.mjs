/**
 * The VS Code windows that opened a folder through a link, read from VS Code's own workspaceStorage: VS Code's Copilot chat
 * runs no hooks there (copilot-chat-hooks.mjs says so in the chat; code-outside-plan.mjs says why no hook named who changed a
 * file). Node built-ins only, and every read fails quietly: a folder that cannot be read is no link.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VSCODE_STORAGE_LIMIT = 2000;

function small(file, limit) {
  try {
    const stat = statSync(file);
    return stat.isFile() && stat.size <= limit ? readFileSync(file, 'utf8') : null;
  } catch { return null; }
}

function real(target) {
  try { return realpathSync.native(target); } catch { return null; }
}

/** VS Code's user-data folders whose workspaceStorage names the folders its windows opened. */
export function vscodeUserDataDirectories({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (env.SINGULARITY_FLOW_VSCODE_USER_DATA) return [path.resolve(env.SINGULARITY_FLOW_VSCODE_USER_DATA)];
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA ? path.resolve(env.APPDATA) : path.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config'));
  return ['Code', 'Code - Insiders'].map((name) => path.join(base, name));
}

/**
 * The VS Code windows that opened `folder`, or a folder holding it (a Story's worktree sits inside its repository),
 * through a link: `{ opened, real, lastUsedMs }`, most recent first, `real` being the opened folder's real path. Read
 * from each window's workspaceStorage/<id>/workspace.json (`"folder": "file:///tmp/x"`); a multi-root workspace is not.
 */
export function vscodeLinkedOpenings(folder, { env = process.env, home = os.homedir(), platform = process.platform,
  since = 0 } = {}) {
  const target = folder ? real(folder) : null;
  if (!target) return [];
  const found = new Map();
  for (const userData of vscodeUserDataDirectories({ env, home, platform })) {
    const storage = path.join(userData, 'User', 'workspaceStorage');
    let names = [];
    try { names = readdirSync(storage).slice(0, VSCODE_STORAGE_LIMIT); } catch { continue; }
    for (const name of names) {
      const file = path.join(storage, name, 'workspace.json');
      const text = small(file, 16 * 1024);
      if (!text) continue;
      let opened = null;
      try {
        const uri = JSON.parse(text)?.folder;
        if (typeof uri === 'string' && uri.startsWith('file:')) opened = fileURLToPath(uri);
      } catch { continue; }
      const openedReal = opened ? real(opened) : null;
      if (!openedReal || path.resolve(opened) === openedReal) continue;
      if (target !== openedReal && !target.startsWith(`${openedReal}${path.sep}`)) continue;
      let lastUsedMs = 0;
      try { lastUsedMs = statSync(path.join(storage, name)).mtimeMs; } catch { /* unknown */ }
      if (lastUsedMs < since) continue;
      const previous = found.get(opened);
      if (!previous || previous.lastUsedMs < lastUsedMs) found.set(opened, { opened, real: openedReal, lastUsedMs });
    }
  }
  return [...found.values()].sort((a, b) => b.lastUsedMs - a.lastUsedMs);
}
