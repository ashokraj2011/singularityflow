import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyMcpEvidence } from './mcp-evidence.mjs';
import { decodePngRgba8 } from './png-rgba8.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';

function policy(workflow) {
  return workflow.resolution?.verification ?? { coverage: 'warn', profiles: [], comparison: { mode: 'off' } };
}

function itemRoot(root, workflow, itemDirectory) {
  return itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
}

function expectedGeneration(phase) {
  return Math.max(1, Number(phase.generation ?? 0));
}

export async function evaluateVisualCoverage(root, workflow, { itemDirectory = null } = {}) {
  const configured = policy(workflow);
  const profiles = configured.profiles ?? [];
  if (!profiles.length) return { schemaVersion: 1, status: 'not-configured', mode: configured.coverage ?? 'warn', phase: 'visual-verification', generation: null, profiles: [], covered: [], uncovered: [], unclaimed: [], stale: [], duplicates: [], warnings: [], errors: [] };
  const phase = workflow.phases?.['visual-verification'];
  if (!phase) throw new SingularityFlowError('Verification profiles require a visual-verification phase.', { code: 'VISUAL_PHASE_MISSING' });
  const generation = expectedGeneration(phase), integrity = await verifyMcpEvidence(root, workflow, { itemDirectory });
  const candidates = integrity.records.filter((record) => record.kind === 'visual-artifact' && record.phase === phase.id);
  const current = candidates.filter((record) => Number(record.targetGeneration) === generation);
  const stale = candidates.filter((record) => Number(record.targetGeneration) !== generation).map((record) => record.id).sort();
  const byProfile = new Map();
  for (const record of current) {
    if (!byProfile.has(record.profileId)) byProfile.set(record.profileId, []);
    byProfile.get(record.profileId).push(record);
  }
  const covered = [], uncovered = [], duplicates = [], warnings = [...integrity.warnings], errors = [...integrity.errors];
  const directory = itemRoot(root, workflow, itemDirectory);
  for (const profile of profiles) {
    const records = byProfile.get(profile.id) ?? [];
    if (!records.length) { uncovered.push(profile.id); continue; }
    if (records.length > 1) duplicates.push({ profileId: profile.id, records: records.map((record) => record.id).sort() });
    const record = [...records].sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))[0];
    let dimensions = null;
    if (record.output?.mediaType === 'image/png') {
      try {
        const output = await secureRepositoryPath(directory, record.output.path, { label: `Visual artifact ${record.id}`, mustExist: true, type: 'file' });
        const decoded = decodePngRgba8(await readFile(output.absolute), { maxPixels: configured.comparison?.maxPixels });
        dimensions = { width: decoded.width, height: decoded.height };
        const expectedWidth = Math.round(profile.width * profile.deviceScaleFactor);
        const expectedHeight = Math.round(profile.height * profile.deviceScaleFactor);
        if (decoded.width !== expectedWidth || decoded.height !== expectedHeight) warnings.push(`Visual artifact '${record.id}' is ${decoded.width}×${decoded.height}; profile '${profile.id}' expects ${expectedWidth}×${expectedHeight}.`);
      } catch (error) { errors.push(`Visual artifact '${record.id}' cannot be decoded: ${error.message}`); }
    }
    covered.push({ profileId: profile.id, recordId: record.id, outputSha256: record.outputSha256, dimensions });
  }
  const known = new Set(profiles.map((profile) => profile.id));
  const unclaimed = current.filter((record) => !known.has(record.profileId)).map((record) => ({ recordId: record.id, profileId: record.profileId ?? null }));
  if (uncovered.length) {
    const message = `Missing visual evidence for verification profile(s): ${uncovered.join(', ')}.`;
    if (configured.coverage === 'enforce') errors.push(message); else warnings.push(message);
  }
  const status = errors.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return { schemaVersion: 1, status, mode: configured.coverage, phase: phase.id, generation, profiles, covered, uncovered, unclaimed, stale, duplicates, warnings, errors };
}

export async function assertVisualCoverage(root, workflow, options = {}) {
  const result = await evaluateVisualCoverage(root, workflow, options);
  if (result.mode === 'enforce' && result.errors.length) throw new SingularityFlowError(`Visual verification coverage failed:\n- ${result.errors.join('\n- ')}`, { code: 'VISUAL_COVERAGE_FAILED', details: result });
  return result;
}
