import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/** This checkout's Git directory, distinct for each linked worktree; no Git process is started. */
export function repositoryWorktreeDirectory(root) {
  const marker = path.join(root, '.git');
  let info;
  try { info = lstatSync(marker); } catch { return null; }
  if (info.isDirectory()) { try { return realpathSync(marker); } catch { return null; } }
  // A pointer file is one short line. Refuse anything else rather than read an unbounded file.
  if (!info.isFile() || info.size > 4_096) return null;
  let pointer;
  try { pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(readFileSync(marker, 'utf8'))?.[1]; } catch { return null; }
  if (!pointer) return null;
  try { return realpathSync(path.resolve(root, pointer)); } catch { return null; }
}
