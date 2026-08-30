import os from 'node:os';
import path from 'node:path';

import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { readJson, writeAtomic } from './util.mjs';

/** Where the machine-local lead pointers live. Overridable so tests stay isolated. */
export function leadRegistryFile() {
  return process.env.SINGULARITY_FLOW_LEAD_REGISTRY
    ?? path.join(os.homedir(), '.singularity-flow', 'leads.json');
}

/** The lead repositories this machine knows about, most recently used first. */
export async function listLeadRepositories(file = leadRegistryFile()) {
  let stored;
  try { stored = readRecord('capability-lead-registry', await readJson(file)).record; }
  catch (error) {
    if (error?.message?.startsWith('Required file not found:')) return [];
    throw error;
  }
  return Array.isArray(stored?.leads) ? stored.leads : [];
}

async function writeLeads(file, leads) {
  await writeAtomic(file, `${JSON.stringify({
    schemaVersion: currentSchemaVersion('capability-lead-registry'), leads
  }, null, 2)}\n`, { mode: 0o600 });
}

export async function rememberLeadRepository(url, file = leadRegistryFile()) {
  const remote = String(url ?? '').trim();
  if (!remote) return listLeadRepositories(file);
  const existing = await listLeadRepositories(file);
  const leads = [
    { url: remote, usedAt: new Date().toISOString() },
    ...existing.filter((lead) => lead.url !== remote)
  ].slice(0, 20);
  await writeLeads(file, leads);
  return leads;
}

export async function forgetLeadRepository(url, file = leadRegistryFile()) {
  const leads = (await listLeadRepositories(file)).filter((lead) => lead.url !== url);
  await writeLeads(file, leads);
  return leads;
}
