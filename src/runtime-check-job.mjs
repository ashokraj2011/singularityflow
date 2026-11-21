/**
 * The runtime check of a batch job or worker (step intents spec §12.3): SFlow runs the job's start entry (its command,
 * or the command its typed run configuration names) twice on the repository's sample or fixture input, in a temporary
 * copy of the project, and compares the two runs. What becomes a finding (breaks use):
 *   - a crash (a stack trace, or death by a signal) or a non-zero exit, on either run;
 *   - different output on the second run: what it printed, or the files it wrote, differ from the first run's.
 * Timestamps, durations, ids and the temporary folder's own path are left out of the comparison, and so are log files.
 * A run that does not finish in its time, a project too large to copy, a before-launch step that fails: each is what
 * is missing here, never a finding. SFlow's own work, no model; nothing the job writes reaches the repository.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

const MAXIMUM_FILES = 4_000;
const MAXIMUM_BYTES = 64 * 1024 * 1024;
const MAXIMUM_ARGUMENT_FILE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_OUTPUT = 200_000;
const MAXIMUM_TEXT_COMPARED = 1024 * 1024;
const CRASH = /(?:\n\s+at\s+(?:async\s+)?[\w.$<>]+\s?\(|Traceback \(most recent call last\)|\bpanic: |Exception in thread "|\bSegmentation fault\b)/u;
// Folders a job's dependencies live in, linked into the copy rather than copied (they are read, not written).
const DEPENDENCY_FOLDERS = Object.freeze(['node_modules']);
const SKIPPED = /(?:^|\/)(?:node_modules|\.git|\.gradle|\.venv|venv|__pycache__|\.cache|logs?|tmp)(?:\/|$)/u;
const DATA = /\.(?:csv|tsv|json|jsonl|ndjson|xml|ya?ml|txt|parquet|avro|dat|sql)$/iu;
const SAMPLE_FOLDER = /(?:^|\/)(?:samples?|fixtures?|examples?|test-?data|sample-?data|example-?data|seeds?)\//iu;
const SAMPLE_FILE = /(?:^|\/)(?:sample|example|fixture|input)[\w.-]*\.[a-z0-9]+$/iu;
const NOT_INPUT = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[\w.-]*\.json|\.github\/|apm\.yml|singularity\/)/u;

/**
 * The repository's sample or fixture inputs for the project in `folder` (its committed files): data files in a
 * samples, fixtures, examples or test-data folder, or named sample, example, fixture or input; shallowest first.
 */
export function sampleInputs(tracked, folder = '') {
  return tracked.filter((file) => (!folder || file.startsWith(`${folder}/`)) && DATA.test(file) && !NOT_INPUT.test(file)
    && !/(?:^|\/)(?:node_modules|dist|build|target)\//u.test(file) && (SAMPLE_FOLDER.test(file) || SAMPLE_FILE.test(file)))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)).slice(0, 20);
}

/** Text with what changes from run to run taken out: timestamps, times, durations, ids, and the folder it ran in. */
export function comparableText(text, folder = null) {
  let value = String(text ?? '');
  if (folder) value = value.split(folder).join('<folder>');
  return value
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gu, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/gu, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|sec|secs|seconds?|m|min|minutes?)\b/gu, '<duration>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<id>')
    .replace(/\b1[6-9]\d{8}(?:\d{3})?\b/gu, '<time>')
    .replace(/\bpid[ =:]\s*\d+\b/giu, 'pid <id>');
}

/**
 * A copy of the project's committed files in `target` (the repository's own folder layout), with its dependency
 * folders linked and the files `argv` names that are not committed (a built jar) copied. `{ files, bytes }`, or
 * `{ tooLarge }` past the limits.
 */
export async function copyProject(root, tracked, { folder = '', workingDirectory = '.', argv = [], target }) {
  const files = tracked.filter((file) => !folder || file === folder || file.startsWith(`${folder}/`)).filter((file) => !SKIPPED.test(file));
  if (files.length > MAXIMUM_FILES) return { tooLarge: `${files.length} files (at most ${MAXIMUM_FILES})` };
  let bytes = 0;
  for (const file of files) {
    const source = path.join(root, file);
    let info;
    try { info = await lstat(source); } catch { continue; }
    if (!info.isFile()) continue;
    bytes += info.size;
    if (bytes > MAXIMUM_BYTES) return { tooLarge: `more than ${MAXIMUM_BYTES / 1024 / 1024} MiB` };
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await copyFile(source, path.join(target, file));
  }
  const linked = [];
  for (const base of [...new Set(['', folder, workingDirectory === '.' ? '' : workingDirectory])]) {
    for (const name of DEPENDENCY_FOLDERS) {
      const relative = base ? `${base}/${name}` : name;
      const info = await lstat(path.join(root, relative)).catch(() => null);
      if (!info?.isDirectory() || await lstat(path.join(target, relative)).catch(() => null)) continue;
      await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
      await symlink(path.join(root, relative), path.join(target, relative), 'dir');
      linked.push(relative);
    }
  }
  // What the command names that the repository does not commit, such as target/app.jar: copied, never linked.
  const cwd = workingDirectory === '.' ? '' : workingDirectory;
  for (const token of argv.slice(1)) {
    if (typeof token !== 'string' || token.startsWith('-') || path.isAbsolute(token) || token.split(/[\\/]/u).includes('..') || !/[./]/u.test(token)) continue;
    const relative = path.posix.join(cwd, token.replace(/\\/gu, '/'));
    if (await lstat(path.join(target, relative)).catch(() => null)) continue;
    const info = await stat(path.join(root, relative)).catch(() => null);
    if (!info?.isFile() || info.size > MAXIMUM_ARGUMENT_FILE_BYTES) continue;
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await copyFile(path.join(root, relative), path.join(target, relative));
  }
  return { files: files.length, bytes, linked };
}

/** Every file in `folder` with its comparable digest, dependency links, logs and caches left out. */
export async function folderOutputs(folder) {
  const outputs = new Map();
  async function walk(relative, depth) {
    if (depth > 12 || outputs.size > MAXIMUM_FILES * 2) return;
    let entries;
    try { entries = await readdir(path.join(folder, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || SKIPPED.test(child) || /\.log$/u.test(entry.name)) continue;
      if (entry.isDirectory()) { await walk(child, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const bytes = await readFile(path.join(folder, child)).catch(() => null);
      if (!bytes) continue;
      const text = bytes.length <= MAXIMUM_TEXT_COMPARED && !bytes.includes(0) ? comparableText(bytes.toString('utf8'), folder) : null;
      outputs.set(child, createHash('sha256').update(text ?? bytes).digest('hex'));
    }
  }
  await walk('', 0);
  return outputs;
}

/** What differs between two folder readings: the files added, removed or changed. */
export function outputChanges(before, after) {
  const changed = [];
  for (const [file, digest] of after) if (!before.has(file)) changed.push({ file, change: 'added' }); else if (before.get(file) !== digest) changed.push({ file, change: 'changed' });
  for (const file of before.keys()) if (!after.has(file)) changed.push({ file, change: 'removed' });
  return changed.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * Run `argv` once in `cwd`: input from `stdinFile` (or none), its own process group, stopped after `timeoutMs`.
 * `{ code, signal, stdout, stderr, timedOut, error }`. `spawnProcess` is for tests.
 */
export async function runJobOnce(argv, { cwd, env, stdinFile = null, timeoutMs, spawnProcess = spawn, terminate = null }) {
  const input = stdinFile ? await readFile(stdinFile).catch(() => null) : null;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(argv[0], argv.slice(1), { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, error: String(error?.message ?? error) }); return; }
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    child.stdout?.on('data', (chunk) => { if (stdout.length < MAXIMUM_OUTPUT) stdout += chunk; });
    child.stderr?.on('data', (chunk) => { if (stderr.length < MAXIMUM_OUTPUT) stderr += chunk; });
    child.stdin?.on('error', () => {});
    if (input) child.stdin?.end(input); else child.stdin?.end();
    const timer = setTimeout(() => {
      timedOut = true;
      if (terminate) terminate(child.pid);
      else { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
    }, Math.max(1_000, timeoutMs));
    child.once('error', (error) => finish({ code: null, signal: null, stdout, stderr, timedOut, error: String(error?.message ?? error) }));
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut, error: null }));
  });
}

const tail = (text, lines = 12) => String(text ?? '').trim().split('\n').slice(-lines).join('\n').slice(-1_500);

/** The findings of two runs of the same job on the same input, and what they say ran. */
export function jobFindings(name, first, second, { firstOutputs, secondOutputs, folder, input }) {
  const findings = [];
  const where = { command: name };
  const failed = (run, which) => {
    if (run.error) return { type: 'job-did-not-start', class: 'breaks-use', title: `${name} does not start`, detail: run.error.slice(0, 600), where };
    // A crash is death by a signal, or a non-zero exit with a stack trace; a logged, handled stack trace with exit 0 is not.
    if (run.signal || (run.code !== 0 && (CRASH.test(run.stderr) || CRASH.test(run.stdout)))) {
      return { type: 'job-crashed', class: 'breaks-use', title: `${name} crashes on the ${which} run${input ? ` with ${input}` : ''}`,
        detail: `It ${run.signal ? `died of ${run.signal}` : `printed a stack trace and exited ${run.code}`}.`, evidence: { code: run.code, signal: run.signal, stderr: tail(run.stderr) }, where };
    }
    if (run.code !== 0) {
      return { type: 'job-failed', class: 'breaks-use', title: `${name} exits ${run.code} on the ${which} run${input ? ` with ${input}` : ''}`,
        detail: tail(run.stderr || run.stdout, 6) || 'It printed nothing.', evidence: { code: run.code, stderr: tail(run.stderr), stdout: tail(run.stdout, 6) }, where };
    }
    return null;
  };
  const one = failed(first, 'first');
  if (one) return [one];
  const two = failed(second, 'second');
  if (two) return [two];
  const printed = comparableText(first.stdout, folder) !== comparableText(second.stdout, folder);
  const files = outputChanges(firstOutputs, secondOutputs);
  if (printed || files.length) {
    findings.push({ type: 'job-not-repeatable', class: 'breaks-use', title: `${name} gives different output when run again on the same input`,
      detail: [printed ? 'What it printed differs between the two runs.' : null,
        files.length ? `The second run ${files.slice(0, 6).map((entry) => `${entry.change === 'added' ? 'added' : entry.change === 'removed' ? 'removed' : 'changed'} ${entry.file}`).join(', ')}${files.length > 6 ? `, and ${files.length - 6} more` : ''}.` : null,
        'A job that runs again (a retry, a rerun after a failure) must give the same result.'].filter(Boolean).join(' '),
      evidence: { files: files.slice(0, 20), ...(printed ? { first: tail(first.stdout, 6), second: tail(second.stdout, 6) } : {}) }, where });
  }
  return findings;
}

/** Remove a temporary folder this check made; never follows the dependency links it put there. */
export async function removeCopy(folder) {
  await rm(folder, { recursive: true, force: true }).catch(() => {});
}
