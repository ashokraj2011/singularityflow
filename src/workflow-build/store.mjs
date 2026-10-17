/**
 * Workflow builds: machine-local, outside every repository and every folder a team brings in.
 *
 * `<state>/<build-id>/` (directories 0700, files 0600) holds:
 * - `build.json`, the `workflow-build` record: what the build started from, the screened capture
 *   manifest, the items found in it, and (from the build engine on) proposals, questions and the
 *   conversation, sealed with an integrity digest;
 * - `uploads/`, copies of single files and pasted notes the person added, captured like a folder;
 * - `capture/<path>`, the screened text of every captured file, which Copilot reads instead of the
 *   source.
 *
 * A build is kept for 14 days after its last change; every command removes expired ones first. It
 * never enters a repository: finishing one goes through Workflow Studio's reviewed proposal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

export const WORKFLOW_BUILD_KIND = 'workflow-build';
export const WORKFLOW_BUILD_DAYS = 14;
const BUILD_ID = /^wb_[a-f0-9]{16}$/u;
const DAY = 24 * 60 * 60 * 1000;

function fail(code, message, details = undefined) {
  throw new SingularityFlowError(message, { code, details });
}

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

/** `SINGULARITY_FLOW_WORKFLOW_BUILD_STATE`, else `~/.singularity-flow/workflow-builds`. */
export function workflowBuildStateRoot(env = process.env, home = os.homedir()) {
  const root = path.resolve(env.SINGULARITY_FLOW_WORKFLOW_BUILD_STATE || path.join(home, '.singularity-flow', 'workflow-builds'));
  if (root === path.parse(root).root) fail('WORKFLOW_BUILD_STATE_UNSAFE', 'The workflow build state directory cannot be a filesystem root.');
  return root;
}

/** The real state directory, created 0700; a symbolic link is refused, never followed. */
async function stateRoot(env) {
  const root = workflowBuildStateRoot(env);
  const existing = await lstat(root).catch(() => null);
  if (existing?.isSymbolicLink()) fail('WORKFLOW_BUILD_STATE_UNSAFE', `Workflow build state cannot be a symbolic link: ${root}`);
  if (existing && !existing.isDirectory()) fail('WORKFLOW_BUILD_STATE_UNSAFE', `Workflow build state is not a directory: ${root}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}

export function requireBuildId(value) {
  const id = String(value ?? '').trim();
  if (!BUILD_ID.test(id)) fail('WORKFLOW_BUILD_INVALID', `'${id}' is not a workflow build ID (wb_ followed by 16 hex digits).`);
  return id;
}

export async function writePrivate(file, text) {
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

export function buildPaths(root, id) {
  const directory = path.join(root, id);
  return { directory, record: path.join(directory, 'build.json'), uploads: path.join(directory, 'uploads'), capture: path.join(directory, 'capture') };
}

/** Remove builds past their expiry. Unreadable entries older than the period go too. */
export async function pruneWorkflowBuilds({ env = process.env, now = Date.now() } = {}) {
  const root = await stateRoot(env);
  const removed = [];
  for (const name of await readdir(root).catch(() => [])) {
    if (!BUILD_ID.test(name)) continue;
    const paths = buildPaths(root, name);
    let expires = null;
    try { expires = Date.parse(JSON.parse(await readFile(paths.record, 'utf8')).expiresAt); } catch {}
    if (!Number.isFinite(expires)) {
      const info = await lstat(paths.directory).catch(() => null);
      expires = info ? info.mtimeMs + WORKFLOW_BUILD_DAYS * DAY : 0;
    }
    if (expires <= now) {
      await rm(paths.directory, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** A new, empty build directory and its ID; the caller writes the first record with saveWorkflowBuild. */
export async function allocateWorkflowBuild({ env = process.env } = {}) {
  const root = await stateRoot(env);
  const id = `wb_${randomBytes(8).toString('hex')}`;
  const paths = buildPaths(root, id);
  await mkdir(paths.directory, { mode: 0o700 });
  return { id, paths };
}

export async function workflowBuildPaths(id, { env = process.env } = {}) {
  return buildPaths(await stateRoot(env), requireBuildId(id));
}

/** Write the record, stamped and sealed, and move its expiry to 14 days after this change. */
export async function saveWorkflowBuild(record, { env = process.env, now = Date.now() } = {}) {
  const paths = buildPaths(await stateRoot(env), requireBuildId(record.id));
  const stamped = sealed({
    ...record,
    schemaVersion: currentSchemaVersion(WORKFLOW_BUILD_KIND),
    kind: WORKFLOW_BUILD_KIND,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + WORKFLOW_BUILD_DAYS * DAY).toISOString()
  });
  await writePrivate(paths.record, `${JSON.stringify(stamped, null, 2)}\n`);
  return stamped;
}

export async function readWorkflowBuild(id, { env = process.env } = {}) {
  const paths = buildPaths(await stateRoot(env), requireBuildId(id));
  let text;
  try { text = await readFile(paths.record, 'utf8'); }
  catch { fail('WORKFLOW_BUILD_MISSING', `There is no workflow build '${id}' on this computer. Builds are kept for ${WORKFLOW_BUILD_DAYS} days after their last change; list them with: singularity-flow workflow build status`); }
  let record;
  try { record = readRecord(WORKFLOW_BUILD_KIND, text).record; }
  catch (error) { fail('WORKFLOW_BUILD_CORRUPT', `Workflow build '${id}' cannot be read: ${error.message}`); }
  if (sealed(record).integritySha256 !== record.integritySha256) fail('WORKFLOW_BUILD_CORRUPT', `Workflow build '${id}' was changed outside Singularity Flow.`);
  return record;
}

export async function listWorkflowBuilds({ env = process.env } = {}) {
  const root = await stateRoot(env);
  const builds = [];
  for (const name of (await readdir(root).catch(() => [])).sort()) {
    if (!BUILD_ID.test(name)) continue;
    try { builds.push(await readWorkflowBuild(name, { env })); } catch { /* an unreadable build is pruned when it expires */ }
  }
  return builds.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
