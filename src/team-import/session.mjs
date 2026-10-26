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
 * Where a captured file's screened copy lives: an office document's text beside its name (`.txt`),
 * so the copy never claims to be the document; any other file under its own path.
 */
function snapshotTarget(capture, file) {
  const target = path.join(capture, ...`${file.path}${file.media === 'document' ? '.txt' : ''}`.split('/'));
  return target.startsWith(capture + path.sep) ? target : null;
}

/**
 * Create a session for `capture`, copy the screened text of `closure` into it, and return the
 * record. `contents` maps capture paths to the screened text `captureTeamDirectory` returned, and
 * `binaries` to the bytes of each image or PDF, copied whole for the model to open.
 */
export async function createTeamImportSession({ capture, contents, binaries = new Map(), closure, entry, options = {} }, { env = process.env, now = Date.now() } = {}) {
  const root = await stateRoot(env);
  const id = `tis_${randomBytes(8).toString('hex')}`;
  const paths = sessionPaths(root, id);
  await mkdir(paths.directory, { mode: 0o700 });
  const snapshots = [];
  for (const file of closure) {
    const value = contents.get(file.path) ?? binaries.get(file.path);
    const target = snapshotTarget(paths.capture, file);
    if (value === undefined || !target) continue;
    await writePrivate(target, value);
    snapshots.push({ path: file.path, snapshot: target, ...(file.media ? { media: file.media } : {}) });
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

export const TEAM_IMPORT_SESSION_TRANSFER = 'sflow-team-import-session-transfer@1';

/**
 * A session as one file, to go on with the conversion on another computer: its sealed record, the
 * screened copies it keeps (an image or PDF as base64 of its bytes) and the candidate written so
 * far. Nothing else leaves this computer.
 */
export async function exportTeamImportSession(sessionId, { env = process.env, now = Date.now() } = {}) {
  const session = await readTeamImportSession(sessionId, { env, now });
  const paths = sessionPaths(await stateRoot(env), session.id);
  const files = [];
  for (const entry of session.snapshots ?? []) {
    files.push(entry.media === 'viewable'
      ? { path: entry.path, media: 'viewable', base64: (await readFile(entry.snapshot)).toString('base64') }
      : { path: entry.path, ...(entry.media ? { media: entry.media } : {}), text: await readFile(entry.snapshot, 'utf8') });
  }
  const candidate = await readFile(paths.candidate, 'utf8').catch(() => null);
  const content = { schema: TEAM_IMPORT_SESSION_TRANSFER, exportedAt: new Date(now).toISOString(), session, files, candidate };
  return { ...content, sha256: digest(JSON.stringify(content)) };
}

/**
 * Go on with a session another computer exported. `folders` are where the team directory (and any
 * extra roots) are on this computer, in the order inspect was given them; compile still checks they
 * hold exactly what was interpreted. A session this computer has already is refused.
 */
export async function importTeamImportSession(transfer, { folders = [], env = process.env, now = Date.now() } = {}) {
  if (!transfer || typeof transfer !== 'object' || transfer.schema !== TEAM_IMPORT_SESSION_TRANSFER) {
    fail('TEAM_IMPORT_TRANSFER_INVALID', 'This is not a team import session file: export one with singularity-flow workflow import-team export.');
  }
  const { sha256, ...content } = transfer;
  if (sha256 !== digest(JSON.stringify(content))) fail('TEAM_IMPORT_TRANSFER_INVALID', 'The session file was changed after it was exported.');
  const session = transfer.session;
  const id = requireSessionId(session?.id);
  const { integritySha256, ...sealedContent } = session;
  if (session.kind !== 'team-import-session' || integritySha256 !== digest(JSON.stringify(sealedContent))) {
    fail('TEAM_IMPORT_TRANSFER_INVALID', `Session ${id} in the file was changed outside singularity-flow.`);
  }
  const roots = session.capture?.roots ?? [];
  if (folders.length !== roots.length) {
    fail('TEAM_IMPORT_TRANSFER_FOLDERS', `Session ${id} read ${roots.length} folder${roots.length === 1 ? '' : 's'}; name where ${roots.length === 1 ? 'it is' : 'they are'} on this computer with --folder, in the same order.`);
  }
  const root = await stateRoot(env);
  const paths = sessionPaths(root, id);
  if (await lstat(paths.directory).catch(() => null)) fail('TEAM_IMPORT_SESSION_EXISTS', `This computer already has session ${id}; go on with it here.`);
  const files = Array.isArray(transfer.files) ? transfer.files : [];
  for (const file of files) {
    const parts = String(file?.path ?? '').split('/');
    const held = file?.media === 'viewable' ? typeof file.base64 === 'string' : typeof file?.text === 'string' && [undefined, 'document'].includes(file.media);
    if (!held || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) {
      fail('TEAM_IMPORT_TRANSFER_INVALID', `The session file names a file it may not hold: ${String(file?.path ?? '')}.`);
    }
  }
  await mkdir(paths.directory, { mode: 0o700 });
  const snapshots = [];
  for (const file of files) {
    const target = snapshotTarget(paths.capture, file);
    if (!target) continue;
    await writePrivate(target, file.media === 'viewable' ? Buffer.from(file.base64, 'base64') : file.text);
    snapshots.push({ path: file.path, snapshot: target, ...(file.media ? { media: file.media } : {}) });
  }
  if (typeof transfer.candidate === 'string') await writePrivate(paths.candidate, transfer.candidate);
  const rebound = roots.map((entry, index) => ({ ...entry, path: path.resolve(folders[index]) }));
  const record = sealed({
    ...sealedContent,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TEAM_IMPORT_SESSION_DAYS * DAY).toISOString(),
    capture: { ...session.capture, roots: rebound },
    options: { ...session.options, ...(session.options?.roots ? { roots: rebound } : {}) },
    snapshots,
    candidatePath: paths.candidate
  });
  await writePrivate(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
