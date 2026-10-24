/**
 * Machine-local, identity-scoped gateway records: watches, saved intake drafts and the guide
 * session. `[INT:CON-101]`
 *
 * These are presentation conveniences, not governed state. They live beside the active-workspace
 * selection — the same machine-local directory, redirected by the same environment variable, so a
 * test or a second profile never shares them by accident — and never in a repository, a state
 * branch or anything that is published. Losing one loses nothing the kernel cannot reconstruct
 * from governed records, which is the property `[INT:CON-101]` asks for.
 *
 * Every entry names the actor that wrote it and every reader filters by actor. A shared machine
 * account therefore still shows each person only their own entries, and an entry can never supply
 * an approved input: the work-start planner reads a draft as a proposal to be confirmed again.
 *
 * Written with restrictive permissions, because "local" is a statement about where the bytes are,
 * not about who can read them.
 *
 * Deliberately not a migrated record family. These files are safe to discard by definition, so a
 * shape this build does not recognise is reported and left alone for the person to remove, never
 * migrated: there is nothing in one that governed state depends on.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { activeWorkspaceFile } from '../workspace-context.mjs';
import { SingularityFlowError, writeAtomic } from '../util.mjs';

export const GATEWAY_LOCAL_STORES = Object.freeze(['watches', 'drafts', 'guide-session']);

/** Bounded so a store cannot grow into something a read path pays for. */
export const MAX_LOCAL_ENTRIES = 200;

export function gatewayStoreFile(name, env = process.env) {
  if (!GATEWAY_LOCAL_STORES.includes(name)) {
    throw new SingularityFlowError(`'${name}' is not a gateway local store.`, { code: 'GATEWAY_STORE_UNKNOWN' });
  }
  return path.join(path.dirname(activeWorkspaceFile(env)), `gateway-${name}.json`);
}

function empty(name) {
  return { kind: `gateway-${name}`, entries: [] };
}

/** The store, or an empty one. A malformed store is reported, never silently replaced. */
export async function readGatewayStore(name, { env = process.env } = {}) {
  const file = gatewayStoreFile(name, env);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { file, record: empty(name) };
    throw error;
  }
  let record;
  try { record = JSON.parse(text); } catch {
    throw new SingularityFlowError(`The gateway ${name} store at ${file} is not valid JSON.`, { code: 'GATEWAY_STORE_INVALID' });
  }
  if (record?.kind !== `gateway-${name}` || !Array.isArray(record.entries)) {
    throw new SingularityFlowError(`The gateway ${name} store at ${file} has an unknown shape.`, { code: 'GATEWAY_STORE_INVALID' });
  }
  return { file, record };
}

export async function gatewayStoreEntries(name, actorId, { env = process.env } = {}) {
  const { record } = await readGatewayStore(name, { env });
  return record.entries.filter((entry) => entry.actorId === actorId);
}

/** Read, apply one change, write atomically at 0600. Returns the entries the change produced. */
export async function updateGatewayStore(name, change, { env = process.env } = {}) {
  const { file, record } = await readGatewayStore(name, { env });
  const entries = change([...record.entries]);
  if (!Array.isArray(entries)) throw new TypeError('A gateway store change must return the new entries.');
  if (entries.length > MAX_LOCAL_ENTRIES) {
    throw new SingularityFlowError(`The gateway ${name} store is full (${MAX_LOCAL_ENTRIES} entries).`, { code: 'GATEWAY_STORE_FULL' });
  }
  await writeAtomic(file, `${JSON.stringify({ ...record, entries }, null, 2)}\n`, { mode: 0o600 });
  return entries;
}

/**
 * The guide session: what the conversation was looking at, and nothing that can act.
 * `[INT:CON-100]` `[INT:CON-101]` `[INT:CON-102]` `[INT:CON-103]`
 *
 * It may remember the presentation workspace, the selected subject, the subjects the last answer
 * showed, a pending clarification or candidate handle, the last result handles and the last menu —
 * and no field of it authorizes anything. The kernel never reads it: a handle in it is verified
 * against the session that signed it like any other, a subject in it is at most a proposal the
 * kernel resolves again, and a plan is confirmed only against the plan's own subject and preview.
 *
 * One entry per person and workspace, so a shared machine account keeps people apart and a second
 * workspace starts clean. Bounded in every field and in entries, and expiring: an entry older than
 * {@link GUIDE_SESSION_TTL_MS} reads as absent and is pruned on the next write. Safe to discard —
 * losing it loses a convenience, and the kernel reconstructs every answer from records.
 *
 * Closed by construction rather than by care. Only the fields named here are kept, each through a
 * pattern that admits identifiers and read or selection handles only, so a confirmation value, a
 * receipt, a plan handle (plans stay in the kernel plan store), a secret, a prompt or any prose has
 * no field that will hold it.
 */
export const GUIDE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_GUIDE_SESSIONS = 32;
const MAX_GUIDE_HANDLES = 8;
const MAX_GUIDE_MENU = 12;
const MAX_GUIDE_SUBJECTS = 8;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUBJECT_KIND = /^[a-z][a-z-]{0,31}$/;
/** Read and selection handles only: `pla_` (a plan) and `rcp_` (a receipt) never match. */
const GUIDE_HANDLE = /^(?:sel|rea)_[a-f0-9]{32}$/;
const MENU_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/** Which workspace an entry belongs to: the workspace, else the repository, else the machine. */
export function guideSessionScope({ workspaceId = null, root = null } = {}) {
  if (typeof workspaceId === 'string' && IDENTIFIER.test(workspaceId)) return `workspace:${workspaceId}`;
  if (typeof root === 'string' && root) {
    return `repository:${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24)}`;
  }
  return 'machine';
}

const subjectOf = (value) => value && typeof value === 'object'
  && SUBJECT_KIND.test(String(value.kind ?? '')) && IDENTIFIER.test(String(value.id ?? ''))
  ? Object.freeze({ kind: value.kind, id: value.id }) : null;

const listOf = (values, pattern, max) => Object.freeze([...new Set((Array.isArray(values) ? values : [])
  .filter((value) => typeof value === 'string' && pattern.test(value)))].slice(0, max));

/** The fields a patch may set, each through its own pattern; everything else is dropped. */
function guideSessionFields(patch = {}) {
  const fields = {};
  if ('presentationWorkspaceId' in patch) {
    fields.presentationWorkspaceId = typeof patch.presentationWorkspaceId === 'string'
      && IDENTIFIER.test(patch.presentationWorkspaceId) ? patch.presentationWorkspaceId : null;
  }
  if ('subject' in patch) fields.subject = subjectOf(patch.subject);
  if ('visibleSubjects' in patch) {
    const seen = new Set();
    fields.visibleSubjects = Object.freeze((Array.isArray(patch.visibleSubjects) ? patch.visibleSubjects : [])
      .map(subjectOf).filter((entry) => entry && !seen.has(`${entry.kind}:${entry.id}`) && seen.add(`${entry.kind}:${entry.id}`))
      .slice(0, MAX_GUIDE_SUBJECTS));
  }
  if ('pending' in patch) {
    const pending = patch.pending;
    fields.pending = pending && ['candidates', 'clarification'].includes(pending.kind) && GUIDE_HANDLE.test(String(pending.handle ?? ''))
      ? Object.freeze({ kind: pending.kind, handle: pending.handle }) : null;
  }
  if ('lastResultHandles' in patch) fields.lastResultHandles = listOf(patch.lastResultHandles, GUIDE_HANDLE, MAX_GUIDE_HANDLES);
  if ('lastMenu' in patch) fields.lastMenu = listOf(patch.lastMenu, MENU_ID, MAX_GUIDE_MENU);
  return fields;
}

function guideOwner({ actorId, scope }) {
  if (typeof actorId !== 'string' || !actorId || actorId.length > 256 || /[\u0000-\u001f\u007f]/.test(actorId)) return null;
  if (typeof scope !== 'string' || !/^(?:workspace:[A-Za-z0-9._-]{1,128}|repository:[a-f0-9]{24}|machine)$/.test(scope)) return null;
  return { actorId, scope };
}

const live = (entry, at) => Date.parse(entry?.expiresAt ?? '') > at;

/** This person's entry for this workspace, or null when there is none or it expired. */
export async function readGuideSession(owner, { env = process.env, now = () => Date.now() } = {}) {
  const who = guideOwner(owner ?? {});
  if (!who) return null;
  let record;
  // A store this build cannot read is a lost convenience, not an error worth stopping a read for.
  try { ({ record } = await readGatewayStore('guide-session', { env })); } catch { return null; }
  const at = now();
  return record.entries.find((entry) => entry.actorId === who.actorId && entry.scope === who.scope && live(entry, at)) ?? null;
}

/**
 * Remember what the guide just showed. Bounded, closed, and renewed for another TTL.
 *
 * Expired entries — anyone's — are pruned on the way through, and the oldest are evicted past
 * {@link MAX_GUIDE_SESSIONS}, so the store never grows into something a read path pays for.
 */
export async function rememberGuideSession(owner, patch = {}, { env = process.env, now = () => Date.now() } = {}) {
  const who = guideOwner(owner ?? {});
  if (!who) return null;
  const at = now();
  let stored = null;
  await updateGatewayStore('guide-session', (entries) => {
    const kept = entries.filter((entry) => live(entry, at));
    const previous = kept.find((entry) => entry.actorId === who.actorId && entry.scope === who.scope);
    stored = {
      ...guideSessionFields({
        presentationWorkspaceId: null, subject: null, visibleSubjects: [], pending: null, lastResultHandles: [], lastMenu: [],
        ...(previous ?? {})
      }),
      ...guideSessionFields(patch),
      actorId: who.actorId,
      scope: who.scope,
      updatedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + GUIDE_SESSION_TTL_MS).toISOString()
    };
    const others = kept.filter((entry) => entry !== previous)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, MAX_GUIDE_SESSIONS - 1);
    return [stored, ...others];
  }, { env });
  return stored;
}

/**
 * Forget this person's conversational context for this workspace. `[INT:REQ-101]`
 *
 * Only that entry: no work is cancelled, no plan is touched (plans live in the kernel, not here
 * `[INT:CON-102]`), the selected workspace default is a different file and stays as it is, and no
 * lifecycle record is read or written. A store this build cannot parse is discarded whole, because
 * the person asked for a reset and nothing in the file is anything else depends on.
 */
export async function resetGuideSession(owner, { env = process.env } = {}) {
  const who = guideOwner(owner ?? {});
  if (!who) return Object.freeze({ cleared: false });
  const mine = (entry) => entry.actorId === who.actorId && entry.scope === who.scope;
  try {
    const { record } = await readGatewayStore('guide-session', { env });
    if (!record.entries.some(mine)) return Object.freeze({ cleared: false });
  } catch (error) {
    if (error?.code !== 'GATEWAY_STORE_INVALID') throw error;
    await writeAtomic(gatewayStoreFile('guide-session', env), `${JSON.stringify(empty('guide-session'), null, 2)}\n`, { mode: 0o600 });
    return Object.freeze({ cleared: true });
  }
  await updateGatewayStore('guide-session', (entries) => entries.filter((entry) => !mine(entry)), { env });
  return Object.freeze({ cleared: true });
}
