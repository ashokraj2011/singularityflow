/**
 * The runtime check of a command-line tool (step intents spec §12.3): SFlow runs each command the project declares
 * (a package's `bin` entries, today) with `--help` and with an argument no tool accepts, in an empty folder with its
 * own home, input closed and a short time limit. What becomes a finding:
 *   - a bad argument that exits 0 (breaks use: scripts and pipelines read it as success);
 *   - a crash on a bad argument (a stack trace), or a `--help` that crashes (breaks use);
 *   - an error printed on stdout with nothing on stderr, a `--help` that exits non-zero, or one that waits (advice).
 * SFlow's own work, no model; nothing the tool reads or writes is in the repository.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 10_000;
const BAD_ARGUMENT = '--sflow-not-an-option';
const CRASH = /(?:\n\s+at\s+(?:async\s+)?[\w.$<>]+\s?\(|Traceback \(most recent call last\)|\bpanic: |Exception in thread ")/u;
const ERROR_WORDS = /\b(?:error|unknown|invalid|unrecognized|not recognized|usage)\b/iu;

/** The commands a Node package declares: `[{ name, file }]` from its `bin`, relative to the package folder. */
export function packageCommands(manifest, folder = '') {
  const bin = manifest?.bin;
  const entries = typeof bin === 'string' ? [[String(manifest.name ?? 'cli').split('/').pop(), bin]] : bin && typeof bin === 'object' ? Object.entries(bin) : [];
  return entries.filter(([, file]) => typeof file === 'string' && file).map(([name, file]) => ({ name, file: path.posix.normalize(path.posix.join(folder, file)) }));
}

/** Run argv with nothing from the repository or the person's home; `{ code, signal, stdout, stderr, timedOut }`. */
export async function runProbe(argv, { cwd, home, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TMPDIR: home, LANG: 'C', NO_COLOR: '1', CI: '1' } });
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.on('data', (chunk) => { if (stdout.length < 20_000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 20_000) stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: String(error.message), timedOut }); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}

/**
 * Probe each of `commands` (`[{ name, file }]`, files absolute) and return `{ ran, findings, calls }`. `runtime` is the
 * argv prefix that runs a file (Node itself for a package's bin).
 */
export async function probeCommands(commands, { runtime = [process.execPath], deadline = Date.now() + 60_000 } = {}) {
  const findings = [];
  const calls = [];
  const ran = [];
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-runtime-cli-'));
  try {
    for (const command of commands.slice(0, 5)) {
      if (Date.now() > deadline) break;
      const help = await runProbe([...runtime, command.file, '--help'], { cwd: home, home });
      const bad = await runProbe([...runtime, command.file, BAD_ARGUMENT], { cwd: home, home });
      calls.push({ command: command.name, argv: '--help', code: help.code, timedOut: help.timedOut }, { command: command.name, argv: BAD_ARGUMENT, code: bad.code, timedOut: bad.timedOut });
      ran.push(`${command.name} --help`, `${command.name} ${BAD_ARGUMENT}`);
      const where = { command: command.name, file: command.file };
      if (!bad.timedOut && bad.code === 0) findings.push({ type: 'exit-zero-on-bad-argument', class: 'breaks-use', title: `${command.name} exits 0 for an argument it does not accept`,
        detail: `${command.name} ${BAD_ARGUMENT} exited 0; a script or pipeline reads that as success.`, evidence: { argv: BAD_ARGUMENT, code: 0, stdout: bad.stdout.slice(0, 300), stderr: bad.stderr.slice(0, 300) }, where });
      if (CRASH.test(bad.stderr) || CRASH.test(bad.stdout)) findings.push({ type: 'crash-on-bad-argument', class: 'breaks-use', title: `${command.name} crashes on an argument it does not accept`,
        detail: 'It printed a stack trace instead of a usage message.', evidence: { argv: BAD_ARGUMENT, code: bad.code, stderr: bad.stderr.slice(0, 600) }, where });
      else if (!bad.timedOut && bad.code !== 0 && !bad.stderr.trim() && ERROR_WORDS.test(bad.stdout)) findings.push({ type: 'error-on-stdout', class: 'improvement',
        title: `${command.name} prints its error on stdout`, detail: 'Errors belong on stderr, so output piped onward stays clean.', evidence: { stdout: bad.stdout.slice(0, 300) }, where });
      if (CRASH.test(help.stderr)) findings.push({ type: 'crash-on-help', class: 'breaks-use', title: `${command.name} --help crashes`, detail: help.stderr.slice(0, 300), where });
      else if (help.timedOut) findings.push({ type: 'help-waits', class: 'improvement', title: `${command.name} --help did not finish within ${TIMEOUT_MS / 1000} seconds`, detail: 'It may be waiting for input.', where });
      else if (help.code !== 0) findings.push({ type: 'help-fails', class: 'improvement', title: `${command.name} --help exits ${help.code}`, detail: (help.stderr || help.stdout).slice(0, 300), where });
    }
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
  return { ran, findings, calls };
}
