/** Content-free, machine-local Evidence Packet usage telemetry. */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { writeAtomic } from './util.mjs';

function telemetryRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'evidence-packets', 'telemetry'); }
function telemetryFile(root, packetId) { return path.join(telemetryRoot(root), `${packetId}.json`); }

const ALLOWED = new Set([
  'schemaVersion', 'packetId', 'workId', 'phase', 'includedBytes', 'estimatedTokens',
  'omittedItems', 'unavailableItems', 'expansionRequests', 'observationRawBytes',
  'observationIncludedBytes', 'cacheKey', 'providerInputTokens', 'providerCachedInputTokens'
]);

function contentFree(record) {
  const unknown = Object.keys(record).filter((key) => !ALLOWED.has(key));
  if (unknown.length) throw new Error(`Context packet telemetry contains disallowed fields: ${unknown.join(', ')}`);
  return record;
}

export async function recordContextPacketTelemetry(root, packet, { providerTelemetry = null } = {}) {
  const observation = packet.observation ?? null;
  const providerObserved = providerTelemetry?.source === 'provider';
  const prior = await readFile(telemetryFile(root, packet.packetId))
    .then((bytes) => readRecord('context-packet-telemetry', bytes).record)
    .catch(() => null);
  const record = contentFree({
    schemaVersion: currentSchemaVersion('context-packet-telemetry'),
    packetId: packet.packetId,
    workId: packet.binding.workId ?? null,
    phase: packet.binding.phase ?? null,
    includedBytes: packet.budget.includedContentBytes,
    estimatedTokens: packet.budget.estimatedInputTokens,
    omittedItems: packet.omissions.length,
    unavailableItems: packet.unavailable.length,
    expansionRequests: Number(prior?.expansionRequests ?? 0),
    observationRawBytes: observation?.rawBytes ?? null,
    observationIncludedBytes: observation?.includedBytes ?? null,
    cacheKey: packet.contextManifest.cacheKey,
    providerInputTokens: providerObserved && Number.isFinite(providerTelemetry.inputTokens) ? providerTelemetry.inputTokens : null,
    providerCachedInputTokens: providerObserved && Number.isFinite(providerTelemetry.cachedInputTokens) ? providerTelemetry.cachedInputTokens : null
  });
  await writeAtomic(telemetryFile(root, packet.packetId), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export async function recordContextExpansionRequest(root, packetId) {
  let record;
  try { record = readRecord('context-packet-telemetry', await readFile(telemetryFile(root, packetId))).record; }
  catch { return null; }
  const next = contentFree({ ...record, expansionRequests: Number(record.expansionRequests ?? 0) + 1 });
  await writeAtomic(telemetryFile(root, packetId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export async function contextPacketTelemetryForWork(root, workId) {
  const names = await readdir(telemetryRoot(root)).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const name of names.filter((value) => /^ctx-[a-f0-9]{20}\.json$/.test(value))) {
    const record = await readFile(path.join(telemetryRoot(root), name))
      .then((bytes) => readRecord('context-packet-telemetry', bytes).record)
      .catch(() => null);
    if (!record) continue;
    if (record.workId === workId) records.push(record);
  }
  records.sort((left, right) => left.packetId.localeCompare(right.packetId));
  return {
    packets: records.length,
    includedBytes: records.reduce((total, record) => total + record.includedBytes, 0),
    estimatedTokens: records.reduce((total, record) => total + record.estimatedTokens, 0),
    expansionRequests: records.reduce((total, record) => total + record.expansionRequests, 0),
    providerInputTokens: records.some((record) => record.providerInputTokens != null)
      ? records.reduce((total, record) => total + (record.providerInputTokens ?? 0), 0) : null,
    providerCachedInputTokens: records.some((record) => record.providerCachedInputTokens != null)
      ? records.reduce((total, record) => total + (record.providerCachedInputTokens ?? 0), 0) : null
  };
}
