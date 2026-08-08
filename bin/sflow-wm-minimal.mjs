#!/usr/bin/env node
/**
 * Cross-platform entry point for the minimal world-model build.
 *
 * `bin` used to point straight at `scripts/worldmodel-minimal.sh`. npm happily creates a shim for
 * that on Windows, and the shim then fails on a machine with no POSIX shell — with a message about
 * `sh` rather than anything a reader could act on, for a command HELP.md documents like any other.
 *
 * The shell script stays the single implementation: it is the thing that is tested, and porting a
 * hundred lines of argument handling to win a platform would be a second implementation to keep in
 * step. So this finds a shell, and when there is none it says exactly what to run instead — the
 * script is a convenience wrapper over one `wm build` invocation, and that command is available
 * everywhere.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'worldmodel-minimal.sh');

function shell() {
  for (const candidate of ['bash', 'sh']) {
    if (spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0) return candidate;
  }
  // Git for Windows ships bash but does not always put it on PATH, so the usual install locations
  // are worth trying before giving up on somebody who does have one.
  if (process.platform === 'win32') {
    for (const candidate of [
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe')
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const interpreter = shell();
if (!interpreter) {
  console.error([
    'sflow-wm-minimal needs a POSIX shell, and none was found on this machine.',
    '',
    'It is a convenience wrapper. Run the command it wraps instead:',
    '',
    '  singularity-flow wm build --depth quick --parallel --workers 2',
    '',
    'On Windows, installing Git for Windows also provides the shell this wrapper looks for.'
  ].join('\n'));
  process.exit(1);
}

const result = spawnSync(interpreter, [script, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
