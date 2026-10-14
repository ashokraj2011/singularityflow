/**
 * Conversion sessions for `workflow import-team`: machine-local, outside every repository and the
 * source directory. [TAWI §4.3]
 *
 * `<state>/<session-id>/` (directories 0700, files 0600) holds:
 * - `session.json`, the `team-import-session` record: the capture manifest, the selected entry,
 *   the issued candidate path, and every compile's findings and state;
 * - `capture/<path>`, the screened text of the files an interpretation needs, which the model reads
 *   instead of the source (withheld and blocked files are never copied);
 * - `candidate.json`, the one file the model writes (issued to the Copilot turn by the guard).
 *
 * Sessions expire after seven days; every command removes expired ones first. A session is never
 * part of a bundle.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

export const TEAM_IMPORT_SESSION_DAYS = 7;
const SESSION_ID = /^tis_[a-f0-9]{16}$/u;
const DAY = 24 * 60 * 60 * 1000;

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, details });
}

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** `SINGULARITY_FLOW_TEAM_IMPORT_STATE`, else `~/.singularity-flow/team-imports`. */
export function teamImportStateRoot(env = process.env, home = os.homedir()) {
  const root = path.resolve(env.SINGULARITY_FLOW_TEAM_IMPORT_STATE || path.join(home, '.singularity-flow', 'team-imports'));
  if (root === path.parse(root).root) fail('TEAM_IMPORT_STATE_UNSAFE', 'The team import state directory cannot be a filesystem root.');
  return root;
}

/** The real state directory, created 0700; a symbolic link is refused, never followed. */
async function stateRoot(env) {
  const root = teamImportStateRoot(env);
  const existing = await lstat(root).catch(() => null);
  if (existing?.isSymbolicLink()) fail('TEAM_IMPORT_STATE_UNSAFE', `Team import state cannot be a symbolic link: ${root}`);
  if (existing && !existing.isDirectory()) fail('TEAM_IMPORT_STATE_UNSAFE', `Team import state is not a directory: ${root}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

export function requireSessionId(value) {
  const id = String(value ?? '').trim();
  if (!SESSION_ID.test(id)) fail('TEAM_IMPORT_SESSION_INVALID', `'${id}' is not a team import session ID (tis_ followed by 16 hex digits).`);
  return id;
}

async function writePrivate(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function sealed(record) {
  const { integritySha256: ignored, ...content } = record;
  return { ...content, integritySha256: digest(JSON.stringify(content)) };
}

export function sessionPaths(root, id) {
  const directory = path.join(root, id);
  return {
    directory,
    record: path.join(directory, 'session.json'),
    capture: path.join(directory, 'capture'),
    candidate: path.join(directory, 'candidate.json')
  };
}

/** Remove sessions past their expiry. Unreadable entries older than the period go too. */
export async function pruneTeamImportSessions({ env = process.env, now = Date.now() } = {}) {
  const root = await stateRoot(env);
  const removed = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (!SESSION_ID.test(name)) continue;
    const paths = sessionPaths(root, name);
    let expires = null;
    try { expires = Date.parse(JSON.parse(await readFile(paths.record, 'utf8')).expiresAt); } catch {}
    if (!Number.isFinite(expires)) {
      const info = await lstat(paths.directory).catch(() => null);
      expires = info ? info.mtimeMs + TEAM_IMPORT_SESSION_DAYS * DAY : 0;
    }
    if (expires <= now) {
      await rm(paths.directory, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Create a session for `capture`, copy the screened text of `closure` into it, and return the
 * record. `contents` maps capture paths to the screened text `captureTeamDirectory` returned.
 */
export async function createTeamImportSession({ capture, contents, closure, entry, options = {} }, { env = process.env, now = Date.now() } = {}) {
  const root = await stateRoot(env);
  const id = `tis_${randomBytes(8).toString('hex')}`;
  const paths = sessionPaths(root, id);
  await mkdir(paths.directory, { mode: 0o700 });
  const snapshots = [];
  for (const file of closure) {
    const text = contents.get(file.path);
    if (text === undefined) continue;
    const target = path.join(paths.capture, ...file.path.split('/'));
    if (!target.startsWith(paths.capture + path.sep)) continue;
    await writePrivate(target, text);
    snapshots.push({ path: file.path, snapshot: target });
  }
  const record = sealed({
    schemaVersion: currentSchemaVersion('team-import-session'),
    kind: 'team-import-session',
    id,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TEAM_IMPORT_SESSION_DAYS * DAY).toISOString(),
    options,
    capture,
    entry,
    closure: closure.map((file) => ({ path: file.path, sha256: file.sha256, ambient: file.ambient === true })),
    snapshots,
    candidatePath: paths.candidate,
    compiles: []
  });
  await writePrivate(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Read and verify one session; an expired, altered or missing session is refused by name. */
export async function readTeamImportSession(sessionId, { env = process.env, now = Date.now() } = {}) {
  const id = requireSessionId(sessionId);
  const root = await stateRoot(env);
  const paths = sessionPaths(root, id);
  let text;
  try { text = await readFile(paths.record, 'utf8'); }
  catch { fail('TEAM_IMPORT_SESSION_MISSING', `Team import session ${id} does not exist or has expired. Run singularity-flow workflow import-team inspect again.`); }
  const { record } = readRecord('team-import-session', text);
  const { integritySha256, ...content } = record;
  if (record.kind !== 'team-import-session' || record.id !== id || integritySha256 !== digest(JSON.stringify(content))) {
    fail('TEAM_IMPORT_SESSION_CORRUPT', `Team import session ${id} was altered outside singularity-flow. Run inspect again.`);
  }
  if (Date.parse(record.expiresAt) <= now) {
    await rm(paths.directory, { recursive: true, force: true });
    fail('TEAM_IMPORT_SESSION_MISSING', `Team import session ${id} expired. Run singularity-flow workflow import-team inspect again.`);
  }
  return record;
}

/** Replace a session record with `next` (sealed again, updatedAt stamped). */
export async function updateTeamImportSession(next, { env = process.env, now = Date.now() } = {}) {
  const root = await stateRoot(env);
  const paths = sessionPaths(root, requireSessionId(next.id));
  const record = sealed({ ...next, updatedAt: new Date(now).toISOString() });
  await writePrivate(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** Every live session, newest first, as summaries. */
export async function listTeamImportSessions({ env = process.env, now = Date.now() } = {}) {
  const root = await stateRoot(env);
  const sessions = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (!SESSION_ID.test(name)) continue;
    try {
      const record = await readTeamImportSession(name, { env, now });
      const last = record.compiles.at(-1) ?? null;
      sessions.push({
        id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt,
        source: record.capture.roots[0]?.path ?? null, entry: record.entry?.selected ?? [],
        state: last?.state ?? 'awaiting-candidate', bundle: last?.out ?? null, bundleSha256: last?.bundleSha256 ?? null
      });
    } catch {}
  }
  return sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
