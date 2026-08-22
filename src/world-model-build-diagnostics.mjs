import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitDir } from './git.mjs';
import { logFilePath, parseLogLines } from './logging.mjs';

async function activityEntries(root) {
  const current = logFilePath(gitDir(root));
  const files = [];
  // Rotation keeps the newest log in `activity.log` and older logs in ascending suffix order.
  // Read oldest to newest so a build whose start crossed a rotation boundary remains reconstructable.
  for (let index = 20; index >= 1; index -= 1) {
    const candidate = `${current}.${index}`;
    if (existsSync(candidate)) files.push(candidate);
  }
  if (existsSync(current)) files.push(current);
  const entries = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '');
    entries.push(...parseLogLines(text));
  }
  return entries;
}

function latest(entries, names) {
  const accepted = new Set(Array.isArray(names) ? names : [names]);
  return entries.filter((entry) => accepted.has(entry.event)).at(-1) ?? null;
}

function stage(entry, started, fallbackReason) {
  if (!entry) return {
    availability: 'unavailable', reason: fallbackReason, durationMs: null,
    startedAt: started?.ts ?? null, completedAt: null
  };
  return {
    availability: Number.isFinite(entry.durationMs) ? 'available' : 'partial',
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
    startedAt: started?.ts ?? entry.startedAt ?? null,
    completedAt: entry.ts ?? null,
    invocationId: entry.invocationId ?? null,
    routing: entry.routing ?? null
  };
}

async function invocationDiagnostics(root, buildEntries) {
  const references = [];
  for (const entry of buildEntries) {
    if (!entry.invocationId) continue;
    const stageId = entry.event.startsWith('worldmodel.discovery.') ? 'discovery' : 'synthesis';
    if (!references.some((candidate) => candidate.invocationId === entry.invocationId)) {
      references.push({ invocationId: entry.invocationId, stage: stageId, view: entry.view ?? null });
    }
  }
  const directory = path.join(gitDir(root), 'singularity-flow', 'model-invocations');
  const invocations = [];
  for (const reference of references) {
    const file = path.join(directory, `${reference.invocationId}.json`);
    let record = null;
    try { record = JSON.parse(await readFile(file, 'utf8')); } catch { /* explicit below */ }
    invocations.push({
      ...reference,
      availability: record ? 'available' : 'unavailable',
      provider: record?.provider ?? null,
      model: record?.model ?? null,
      routing: record?.routing ?? null,
      promptBytes: Number.isFinite(record?.promptBytes) ? record.promptBytes : null,
      usage: record?.usage ?? { status: 'unavailable' }
    });
  }
  return invocations;
}

/**
 * Reconstruct the last machine-local world-model build receipt from content-free activity events.
 * Missing or rotated information is represented explicitly; diagnostics never invent durations.
 */
export async function latestWorldModelBuildDiagnostics(root) {
  const entries = await activityEntries(root);
  const end = latest(entries, 'worldmodel.build.end');
  if (!end?.buildId) {
    return {
      availability: 'unavailable',
      reason: 'no-local-world-model-build-log',
      buildId: null,
      status: null,
      stages: {
        discovery: stage(null, null, 'no-local-discovery-event'),
        synthesis: stage(null, null, 'no-local-synthesis-event'),
        total: stage(null, null, 'no-local-build-event')
      },
      invocations: []
    };
  }

  const buildEntries = entries.filter((entry) => entry.buildId === end.buildId);
  const start = latest(buildEntries, 'worldmodel.build.start');
  const discoveryStart = latest(buildEntries, 'worldmodel.discovery.planned');
  const discovery = latest(buildEntries, 'worldmodel.discovery.complete');
  const synthesisStart = latest(buildEntries, 'worldmodel.synthesis.start');
  const synthesis = latest(buildEntries, [
    'worldmodel.synthesis.recovery.ok', 'worldmodel.synthesis.ok', 'worldmodel.synthesis.failed'
  ]);
  const invocations = await invocationDiagnostics(root, buildEntries);
  return {
    availability: start ? 'available' : 'partial',
    reason: start ? null : 'build-start-rotated-or-unavailable',
    buildId: end.buildId,
    status: end.status ?? 'unknown',
    runtime: start?.runtime ?? null,
    buildCommit: start?.buildCommit ?? null,
    buildSourceSha256: start?.buildSourceSha256 ?? null,
    requestedMode: start?.requestedMode ?? null,
    effectiveMode: start?.effectiveMode ?? null,
    routing: synthesis?.routing ?? start?.generationRouting ?? null,
    rebuildReason: start?.rebuildReason ?? null,
    views: {
      selected: discovery?.selectedViews ?? start?.selectedViews ?? [],
      missing: discovery?.missingViews ?? [],
      generated: discovery?.generatedViews ?? [],
      reused: discovery?.reusedViews ?? []
    },
    stages: {
      discovery: stage(discovery, discoveryStart, 'no-local-discovery-event'),
      synthesis: stage(synthesis, synthesisStart, 'no-local-synthesis-event'),
      total: stage(end, start, 'no-local-build-event')
    },
    invocations
  };
}
