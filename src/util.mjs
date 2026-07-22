import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class SingularityFlowError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'SingularityFlowError';
    this.exitCode = exitCode;
  }
}

export function invariant(condition, message) {
  if (!condition) throw new SingularityFlowError(message);
}

export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  let passthrough = false;
  const put = (key, value) => {
    if (Object.hasOwn(options, key)) options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
    else options[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      put(token.slice(5), false);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 2) {
      put(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      put(key, next);
      index += 1;
    } else put(key, true);
  }
  return { positionals, options };
}

export function optionString(options, key, fallback = undefined) {
  const value = options[key];
  if (value === undefined || value === false) return fallback;
  if (value === true) throw new SingularityFlowError(`Option --${key} requires a value.`);
  return String(Array.isArray(value) ? value.at(-1) : value);
}

export function optionStrings(options, key) {
  const value = options[key];
  if (value === undefined || value === false) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => item === true)) throw new SingularityFlowError(`Option --${key} requires a value.`);
  return values.map(String);
}

export function optionBoolean(options, key, fallback = false) {
  const value = options[key];
  if (value === undefined) return fallback;
  const actual = Array.isArray(value) ? value.at(-1) : value;
  if (typeof actual === 'boolean') return actual;
  const normalized = String(actual).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new SingularityFlowError(`Option --${key} expects a boolean.`);
}

export function optionNumber(options, key, fallback = undefined) {
  const value = optionString(options, key, fallback);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SingularityFlowError(`Option --${key} expects a number.`);
  return number;
}

export function requirePositional(positionals, index, label) {
  if (!positionals[index]) throw new SingularityFlowError(`Missing ${label}.`);
  return positionals[index];
}

export function run(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  allowFailure = false,
  shell = false,
  stdio = 'pipe'
} = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell, stdio });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const status = result.status ?? (result.error ? 1 : 0);
  if (result.error && !allowFailure) throw new SingularityFlowError(`Unable to run ${command}: ${result.error.message}`);
  if (status !== 0 && !allowFailure) {
    throw new SingularityFlowError(`${command} ${args.join(' ')} failed: ${stderr.trim() || stdout.trim() || `exit ${status}`}`);
  }
  return { status, stdout, stderr, error: result.error };
}

export function commandExists(command) {
  const result = process.platform === 'win32'
    ? run('where', [command], { allowFailure: true })
    : run('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { allowFailure: true });
  return result.status === 0;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Required file not found: ${filePath}`);
    if (error instanceof SyntaxError) throw new SingularityFlowError(`Invalid JSON in ${filePath}: ${error.message}`);
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, filePath);
}

export async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
  await rename(temp, filePath);
}

export async function snapshot(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { exists: true, size: info.size, sha256: null };
    const content = await readFile(filePath);
    return { exists: true, size: info.size, sha256: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, size: 0, sha256: null };
    throw error;
  }
}

export function posix(value) {
  return value.split(path.sep).join('/');
}

export function repoRelative(root, candidate) {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SingularityFlowError(`Path is outside the repository: ${candidate}`);
  return posix(relative || '.');
}

export function truncate(value, max = 2000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n… truncated …`;
}

export function table(rows, columns) {
  const widths = columns.map((column) => Math.max(column.label.length, ...rows.map((row) => String(row[column.key] ?? '').length)));
  const line = (row) => columns.map((column, index) => String(row[column.key] ?? '').padEnd(widths[index])).join('  ');
  return [line(Object.fromEntries(columns.map((column) => [column.key, column.label]))), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}
