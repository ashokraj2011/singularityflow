/** One creation request's immutable configuration and system identity; never live Git authority. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { incrementCommandCounter } from './dx-timing-context.mjs';

const contexts = new AsyncLocalStorage();
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const LIMIT = 32 * 1024 * 1024;

export async function withCreationContext(action) {
  if (contexts.getStore()?.active) return action();
  const frame = { active: true, configurations: new Map(), bytes: 0, identities: new Map(),
    directories: new Set(), snapshots: new WeakMap(), cleanup: null };
  return contexts.run(frame, async () => {
    try { return await action(); }
    finally {
      frame.active = false;
      frame.configurations.clear(); frame.identities.clear();
      const cleaned = await Promise.allSettled([...frame.directories].map(directory => frame.cleanup?.(directory)));
      if (cleaned.some(result => result.status === 'rejected')) console.warn(
        'Warning: a disposable configuration checkout could not be removed. The Story result is unchanged.');
      frame.directories.clear();
    }
  });
}

export function creationConfigurationOwner(cleanup) {
  const frame = contexts.getStore();
  if (!frame?.active) return null;
  if (cleanup) frame.cleanup = cleanup;
  return frame;
}

/** Caller must freshly resolve authority first. Only complete verified immutable captures share. */
export async function creationConfiguration(authority, { env, captureAuthoringBytes }, load, verify) {
  const frame = contexts.getStore();
  if (!frame?.active || !OID.test(authority?.commit ?? '')) return load();
  const key = JSON.stringify([authority.remote, authority.branch, authority.commit,
    authority.sourceCommit ?? null, authority.source ?? null, captureAuthoringBytes === true,
    Object.entries(env).sort(([a], [b]) => a.localeCompare(b))]);
  const retained = frame.configurations.get(key);
  if (retained) {
    const snapshot = await retained;
    verify(snapshot);
    incrementCommandCounter('configuration.creation-capture-reuse');
    return snapshot;
  }
  if (frame.configurations.size >= 4 || frame.bytes >= LIMIT) return load();
  const pending = Promise.resolve().then(load);
  frame.configurations.set(key, pending);
  try {
    const snapshot = await pending;
    verify(snapshot);
    const bytes = snapshot.assets.reduce((sum, asset) => sum + asset.contents.length, 0);
    if (frame.bytes + bytes > LIMIT) frame.configurations.delete(key);
    else frame.bytes += bytes;
    return snapshot;
  } catch (error) {
    frame.configurations.delete(key);
    throw error;
  }
}

/** The process token's SID may share within a request; ACL results themselves never share. */
export async function creationSystemIdentity(owner, key, load) {
  const frame = contexts.getStore();
  if (!frame?.active) return load();
  if (!frame.identities.has(owner)) frame.identities.set(owner, new Map());
  const identities = frame.identities.get(owner);
  if (identities.has(key)) {
    incrementCommandCounter('windows.acl.identity-reuse');
    return identities.get(key);
  }
  const pending = Promise.resolve().then(load);
  identities.set(key, pending);
  try { return await pending; }
  catch (error) { identities.delete(key); throw error; }
}
