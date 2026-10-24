/**
 * Machine-local, identity-scoped gateway records: watches and saved intake drafts. `[INT:CON-101]`
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
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { activeWorkspaceFile } from '../workspace-context.mjs';
import { SingularityFlowError, writeAtomic } from '../util.mjs';

export const GATEWAY_LOCAL_STORES = Object.freeze(['watches', 'drafts']);

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
