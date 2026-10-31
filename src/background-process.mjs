/**
 * A process that outlives the command that starts it: a refresh, index or maintenance pass behind
 * an answer already given. Nothing waits for it and its output is discarded.
 *
 * Elsewhere it is a detached child. On Windows libuv puts every child started without `detached`
 * in its parent's job object, which ends the child when the parent exits, so a refresh behind a
 * stale answer never finished there. A detached child has no console, and each console program it
 * starts in turn (Git, a Node worker) would open a window of its own; so a detached relay starts
 * the process with a hidden console of its own, outside the parent's job, and waits for it.
 */
import { spawn } from 'node:child_process';

const RELAY = [
  "const { spawn } = require('node:child_process');",
  'const [command, args] = JSON.parse(process.argv[1]);',
  "const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });",
  "child.once('error', () => process.exit(1));",
  "child.once('exit', (code) => process.exit(code ?? 1));"
].join('\n');

/** Start `command` with `args` in `cwd`; the returned child is already unreferenced. */
export function spawnBackground(command, args, { cwd, env = process.env, platform = process.platform } = {}) {
  const [file, argv] = platform === 'win32'
    ? [process.execPath, ['-e', RELAY, JSON.stringify([command, args])]] : [command, args];
  const child = spawn(file, argv, { cwd, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => {});
  child.unref();
  return child;
}
