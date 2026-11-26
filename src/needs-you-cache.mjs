/**
 * What Needs you keeps between reads [FPL:REQ-016, REQ-017]: per repository and identity, the Story list's state commit
 * and, for each in-progress Story, the commit its state was read at with the items computed from it. A Story whose
 * commit did not move costs no read on the next refresh, and `needs-you --offline` paints from these files alone.
 *
 * A read model, never an authority: every choice still goes through its own command and checks. One small JSON file per
 * workspace repository, beside the workspace registry (redirected with it, so a test run never reads a person's). An
 * unreadable, oversized or foreign file is ignored and rewritten by the next read.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const KEPT_FORMAT = 1;
const KEPT_MAXIMUM_BYTES = 16 * 1024 * 1024;

/** Beside the workspace registry, wherever SINGULARITY_FLOW_WORKSPACE_REGISTRY puts it. */
export function keptDirectory(env = process.env) {
  const registry = path.resolve(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY || path.join(os.homedir(), '.singularity-flow', 'workspaces.json'));
  return path.join(path.dirname(registry), 'needs-you');
}

/** The identity a read was judged with, as one key: its email, and its GitHub login when known. */
export function identityKey(actor) {
  const email = String(actor?.email ?? '').trim().toLowerCase();
  const login = String(actor?.login ?? '').trim().toLowerCase();
  return [email && `email:${email}`, login && `login:${login}`].filter(Boolean).join(' ') || 'unknown';
}

/** One file per repository of one workspace (or the window's repository outside one). */
export function keptFile(directory, { workspaceId = null, repositoryId, url = null }) {
  const name = createHash('sha256').update(`${workspaceId ?? ''}\0${repositoryId}\0${url ?? ''}`).digest('hex').slice(0, 32);
  return path.join(directory, `${name}.json`);
}

const valid = (record) => record && typeof record === 'object' && record.format === KEPT_FORMAT
  && record.repository && typeof record.repository.id === 'string' && record.byIdentity && typeof record.byIdentity === 'object';

/** The kept record, or null when there is none or it cannot be trusted. */
export async function readKept(file) {
  try {
    const bytes = await readFile(file);
    if (bytes.length > KEPT_MAXIMUM_BYTES) return null;
    const record = JSON.parse(bytes.toString('utf8'));
    return valid(record) ? record : null;
  } catch { return null; }
}

/** Every kept record in `directory` (the offline paint reads these). */
export async function readAllKept(directory) {
  let names = [];
  try { names = (await readdir(directory)).filter((name) => /^[a-f0-9]{32}\.json$/u.test(name)); } catch { return []; }
  const records = await Promise.all(names.map((name) => readKept(path.join(directory, name))));
  return records.filter(Boolean);
}

/** Replace the kept record whole, atomically; a write that fails only means the next read does the work again. */
export async function writeKept(file, record) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ ...record, format: KEPT_FORMAT })}\n`, { mode: 0o600 });
    await rename(temporary, file);
    return true;
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
    return false;
  }
}

/** The section of a kept record for one identity, or an empty one. */
export function identitySection(record, key) {
  const section = record?.byIdentity?.[key];
  return section && typeof section === 'object' ? section
    : { identity: null, at: null, stateCommit: null, stories: {}, reviews: null, local: null, initiatives: null };
}

/** Every item a section holds, in no particular order. */
export function sectionItems(section) {
  const stories = Object.values(section?.stories ?? {}).flatMap((entry) => (Array.isArray(entry?.items) ? entry.items : []));
  const rest = ['reviews', 'local', 'initiatives'].flatMap((name) => (Array.isArray(section?.[name]?.items) ? section[name].items : []));
  return [...stories, ...rest];
}
