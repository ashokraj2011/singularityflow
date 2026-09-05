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
    throw error;
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
  const existing = await listLeadRepositoryRegistryRecords(file);
  const leads = [
    { url: remote, usedAt: new Date().toISOString() },
    ...existing.filter((lead) => lead.url !== remote)
  ].slice(0, 20);
  await writeLeads(file, leads);
  return listLeadRepositories(file);
}

export async function forgetLeadRepository(url, file = leadRegistryFile()) {
  const leads = (await listLeadRepositoryRegistryRecords(file)).filter((lead) => lead.url !== url);
  await writeLeads(file, leads);
  return listLeadRepositories(file);
}
