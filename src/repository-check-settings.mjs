/** Machine-local performance preferences. Never captured as Story policy or approval authority. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitFactCheckout } from './git-fact-cache.mjs';

export const DEFAULT_REPOSITORY_CHECKS = Object.freeze({ mode: 'cached', intervalMinutes: 30 });
const MODES = new Set(['always', 'cached', 'manual']);
const MAXIMUM_PREFERENCES_BYTES = 128 * 1024;

export function repositoryCheckPreferencesFile(env = process.env) {
  return path.resolve(env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES
    || path.join(os.homedir(), '.singularity-flow', 'repository-checks.json'));
}

export function normalizeRepositoryCheckSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(
    new Error('Repository-check settings must be an object.'), { code: 'REPOSITORY_CHECK_SETTINGS_INVALID' });
  const mode = value.mode ?? DEFAULT_REPOSITORY_CHECKS.mode;
  const intervalMinutes = Number(value.intervalMinutes ?? DEFAULT_REPOSITORY_CHECKS.intervalMinutes);
  if (!MODES.has(mode) || !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) {
    throw Object.assign(new Error('Repository checks require mode always, cached or manual and an integer intervalMinutes between 1 and 10080.'), {
      code: 'REPOSITORY_CHECK_SETTINGS_INVALID'
    });
  }
  return Object.freeze({ mode, intervalMinutes });
}

function readPreferences(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAXIMUM_PREFERENCES_BYTES) return null;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return record?.format === 1 && record.workspaces && typeof record.workspaces === 'object'
      && !Array.isArray(record.workspaces) ? record : null;
  } catch (error) { return error.code === 'ENOENT' ? undefined : null; }
}

function within(root, candidate) {
  const relative = path.relative(candidate, root);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** VS Code mirrors workspace overrides here so native Copilot shell skills use the same settings. */
export function repositoryCheckSettings(root, { env = process.env } = {}) {
  const record = readPreferences(repositoryCheckPreferencesFile(env));
  if (record === null) return Object.freeze({ mode: 'always', intervalMinutes: 30, settingsInvalid: true });
  const checkout = root ? gitFactCheckout(root) : null;
  const roots = [root && path.resolve(root), checkout?.commonDir].filter(Boolean);
  const workspace = Object.entries(record?.workspaces ?? {})
    .filter(([candidate]) => path.isAbsolute(candidate) && roots.some(value => within(value, candidate)))
    .sort(([a], [b]) => b.length - a.length)[0]?.[1];
  try {
    return normalizeRepositoryCheckSettings({ ...record?.defaults, ...workspace,
      ...(env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE !== undefined
        ? { mode: env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE } : {}),
      ...(env.SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES !== undefined
        ? { intervalMinutes: env.SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES } : {}) });
  } catch {
    // A malformed optional preference cannot weaken verification or block Story work.
    return Object.freeze({ mode: 'always', intervalMinutes: 30, settingsInvalid: true });
  }
}

/** Atomic, leased local preference update; unrelated workspace overrides remain intact. */
export async function saveRepositoryCheckSettings(settings, { workspacePath = null,
  file = repositoryCheckPreferencesFile() } = {}) {
  const normalized = settings === null ? (workspacePath ? null : DEFAULT_REPOSITORY_CHECKS) : normalizeRepositoryCheckSettings(settings);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe repository-check preferences directory.');
  const previous = readPreferences(file);
  const existing = workspacePath ? previous?.workspaces?.[path.resolve(workspacePath)] : previous?.defaults;
  if (normalized === null && existing === undefined) return null;
  if (JSON.stringify(existing) === JSON.stringify(normalized)) return normalized;
  const { withRegistryFileLease } = await import('./file-lease.mjs');
  return withRegistryFileLease(file, async () => {
    const record = readPreferences(file) ?? { format: 1, defaults: DEFAULT_REPOSITORY_CHECKS, workspaces: {} };
    if (workspacePath && normalized === null) delete record.workspaces[path.resolve(workspacePath)];
    else if (workspacePath) record.workspaces[path.resolve(workspacePath)] = normalized;
    else record.defaults = normalized;
    if (Object.keys(record.workspaces).length > 512) throw new Error('Too many local repository-check workspace preferences.');
    const text = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(text) > MAXIMUM_PREFERENCES_BYTES) throw new Error('Repository-check preferences are too large.');
    const temporary = path.join(directory, `.repository-checks-${randomUUID()}.tmp`);
    try {
      // schema-transient: optional machine-local preferences, never governed repository state.
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return normalized;
  });
}

export function repositoryCheckKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
