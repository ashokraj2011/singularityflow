import os from 'node:os';
import path from 'node:path';
import { stat } from 'node:fs/promises';

let support = null;

async function loadSupport() {
  support ??= Promise.all([
    import('./schema-migrations.mjs'),
    import('./util.mjs'),
    import('./git-remote-diagnostics.mjs'),
    import('./git-repository-identity.mjs')
  ]).then(([migrations, util, remotes, identities]) => ({
    assertCredentialFreeRemote: remotes.assertCredentialFreeRemote,
    currentSchemaVersion: migrations.currentSchemaVersion,
    readRecord: migrations.readRecord,
    readJson: util.readJson,
    gitRepositoryLocalPath: identities.gitRepositoryLocalPath,
    sameGitRepository: identities.sameGitRepository,
    writeAtomic: util.writeAtomic
  }));
  return support;
}

/** A disappeared local checkout is not a usable organisation choice. Keep inaccessible paths
 * (which might be on an unmounted drive) rather than treating permission errors as deletion. */
async function availableLead(lead, gitRepositoryLocalPath) {
  const local = gitRepositoryLocalPath(lead?.url);
  if (!local || !path.isAbsolute(local)) return true;
  try {
    await stat(local);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR';
  }
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
  const { assertCredentialFreeRemote, gitRepositoryLocalPath } = await loadSupport();
  const accepted = [];
  for (const lead of await listLeadRepositoryRegistryRecords(file)) {
    try {
      const url = assertCredentialFreeRemote(lead?.url);
      if (await availableLead({ url }, gitRepositoryLocalPath)
          && !accepted.some((entry) => entry.url === url)) accepted.push({ ...lead, url });
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
  const { assertCredentialFreeRemote, gitRepositoryLocalPath, sameGitRepository } = await loadSupport();
  assertCredentialFreeRemote(remote);
  const { withRegistryFileLease } = await import('./workspace.mjs');
  return await withRegistryFileLease(file, async () => {
    const existing = (await Promise.all((await listLeadRepositoryRegistryRecords(file))
      .map(async (lead) => ({ lead, available: await availableLead(lead, gitRepositoryLocalPath) }))))
      .filter((entry) => entry.available).map((entry) => entry.lead);
    const leads = [
      { url: remote, usedAt: new Date().toISOString() },
      ...existing.filter((lead) => !sameGitRepository(lead?.url, remote))
    ].slice(0, 20);
    await writeLeads(file, leads);
    return listLeadRepositories(file);
  });
}

export async function forgetLeadRepository(url, file = leadRegistryFile()) {
  const remote = String(url ?? '').trim();
  const { sameGitRepository } = await loadSupport();
  const { withRegistryFileLease } = await import('./workspace.mjs');
  return await withRegistryFileLease(file, async () => {
    const leads = (await listLeadRepositoryRegistryRecords(file))
      .filter((lead) => !sameGitRepository(lead?.url, remote));
    await writeLeads(file, leads);
    return listLeadRepositories(file);
  });
}
