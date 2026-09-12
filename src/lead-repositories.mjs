import os from 'node:os';
import path from 'node:path';

import { assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';

let support = null;

async function loadSupport() {
  support ??= Promise.all([
    import('./schema-migrations.mjs'),
    import('./util.mjs')
  ]).then(([migrations, util]) => ({
    currentSchemaVersion: migrations.currentSchemaVersion,
    readRecord: migrations.readRecord,
    readJson: util.readJson,
    writeAtomic: util.writeAtomic
  }));
  return support;
}

/** Where the machine-local lead pointers live. Overridable so tests stay isolated. */
export function leadRegistryFile() {
  return process.env.SINGULARITY_FLOW_LEAD_REGISTRY
    ?? path.join(os.homedir(), '.singularity-flow', 'leads.json');
}

/** The lead repositories this machine knows about, most recently used first. */
export async function listLeadRepositoryRegistryRecords(file = leadRegistryFile()) {
  const { readJson, readRecord } = await loadSupport();
  let stored;
  try { stored = readRecord('capability-lead-registry', await readJson(file)).record; }
  catch (error) {
    if (error?.message?.startsWith('Required file not found:')) return [];
    // This file is a machine-local convenience index, never capability authority. A truncated,
    // malformed, archived, or otherwise unreadable copy must therefore behave like an empty
    // cache instead of preventing an authoritative Git read. Preserve future-schema errors: they
    // are not corruption, and silently replacing a registry written by a newer SFlow build would
    // discard pointers that this build may not understand.
    if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error;
    return [];
  }
  return Array.isArray(stored?.leads) ? stored.leads : [];
}

/** Operational callers receive only entries that pass the current remote trust boundary. */
export async function listLeadRepositories(file = leadRegistryFile()) {
  const accepted = [];
  for (const lead of await listLeadRepositoryRegistryRecords(file)) {
    try {
      const url = assertCredentialFreeRemote(lead?.url);
      if (!accepted.some((entry) => entry.url === url)) accepted.push({ ...lead, url });
    } catch { /* legacy/corrupt entries remain on disk for explicit diagnosis or removal */ }
  }
  return accepted;
}

async function writeLeads(file, leads) {
  const { currentSchemaVersion, writeAtomic } = await loadSupport();
  await writeAtomic(file, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('capability-lead-registry'), leads
  }, null, 2)}\n`, { mode: 0o600 });
}

export async function rememberLeadRepository(url, file = leadRegistryFile()) {
  const remote = String(url ?? '').trim();
  if (!remote) return listLeadRepositories(file);
  assertCredentialFreeRemote(remote);
  const { withRegistryFileLease } = await import('./workspace.mjs');
  return await withRegistryFileLease(file, async () => {
    const existing = await listLeadRepositoryRegistryRecords(file);
    const leads = [
      { url: remote, usedAt: new Date().toISOString() },
      ...existing.filter((lead) => lead.url !== remote)
    ].slice(0, 20);
    await writeLeads(file, leads);
    return listLeadRepositories(file);
  });
}

export async function forgetLeadRepository(url, file = leadRegistryFile()) {
  const { withRegistryFileLease } = await import('./workspace.mjs');
  return await withRegistryFileLease(file, async () => {
    const leads = (await listLeadRepositoryRegistryRecords(file))
      .filter((lead) => lead.url !== url);
    await writeLeads(file, leads);
    return listLeadRepositories(file);
  });
}
