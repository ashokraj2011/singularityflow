import { isVisualVerificationPhase, visualVerificationPhaseOf } from './phase-roles.mjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyMcpEvidence } from './mcp-evidence.mjs';
import { decodePngRgba8, readPngHeader } from './png-rgba8.mjs';
import { secureRepositoryPath, SingularityFlowError, snapshot } from './util.mjs';

/**
 * Where `visual record` keeps a screenshot taken on a simulator, emulator or device, apart from the
 * MCP records: a native capture never names an MCP server or tool, and is never read as one.
 */
export const NATIVE_CAPTURE_DIRECTORY = 'context/visual/captures';
export const NATIVE_CAPTURE_SOURCES = Object.freeze(['simulator', 'emulator', 'device']);

function policy(workflow) {
  return workflow.resolution?.verification ?? { coverage: 'warn', profiles: [], comparison: { mode: 'off' } };
}

function itemRoot(root, workflow, itemDirectory) {
  return itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
}

function expectedGeneration(phase) {
  return Math.max(1, Number(phase.generation ?? 0));
}

/** The exact pixel size a capture for a profile must have: its width and height at its device scale. */
export function profilePixelSize(profile) {
  return { width: Math.round(profile.width * profile.deviceScaleFactor), height: Math.round(profile.height * profile.deviceScaleFactor) };
}

/** The native captures in a Story, each checked against the bytes it recorded. */
async function nativeCaptures(directory, workflow) {
  const records = [], errors = [];
  const recordsDirectory = path.join(directory, NATIVE_CAPTURE_DIRECTORY, 'records');
  let names;
  try { names = (await readdir(recordsDirectory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return { records, errors }; throw error; }
  for (const name of names) {
    let record;
    try { record = JSON.parse(await readFile(path.join(recordsDirectory, name), 'utf8')); }
    catch (error) { errors.push(`Native capture '${name}' cannot be read: ${error.message}`); continue; }
    const prefix = `Native capture '${record?.id ?? name}'`;
    if (record?.schemaVersion !== 1 || record.kind !== 'visual-native-capture' || record.evidenceMethod !== 'native-capture' || `${record.id}.json` !== name) { errors.push(`${prefix} is not a native capture record.`); continue; }
    if (record.workId !== workflow.workItem.id) { errors.push(`${prefix} belongs to work item '${record.workId ?? 'unknown'}'.`); continue; }
    if (record.output?.mediaType !== 'image/png' || record.outputSha256 !== record.output?.sha256) { errors.push(`${prefix} does not bind a PNG output.`); continue; }
    try {
      const output = await secureRepositoryPath(directory, record.output.path ?? '', { label: `${prefix} output` });
      const current = await snapshot(output.absolute);
      if (!current.exists) { errors.push(`${prefix} output is missing: ${record.output.path}`); continue; }
      if (current.sha256 !== record.output.sha256 || current.size !== record.output.bytes) { errors.push(`${prefix} output changed after capture: ${record.output.path}`); continue; }
      records.push({ record, absolute: output.absolute });
    } catch (error) { errors.push(`${prefix} output cannot be read: ${error.message}`); }
  }
  return { records, errors };
}

export async function evaluateVisualCoverage(root, workflow, { itemDirectory = null, phaseId = workflow.currentPhase } = {}) {
  const configured = policy(workflow);
  const profiles = configured.profiles ?? [];
  if (!profiles.length) return { schemaVersion: 1, status: 'not-configured', mode: configured.coverage ?? 'warn', phase: visualVerificationPhaseOf(workflow, phaseId)?.id ?? null, generation: null, profiles: [], covered: [], uncovered: [], unclaimed: [], stale: [], duplicates: [], warnings: [], errors: [] };
  const phase = visualVerificationPhaseOf(workflow, phaseId);
  // A decision route that skipped every visual step leaves nothing to cover: answer, do not refuse.
  const visualSteps = (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map((id) => workflow.phases?.[id]).filter(isVisualVerificationPhase);
  if (!phase && visualSteps.length && visualSteps.every((step) => step.status === 'skipped')) {
    return { schemaVersion: 1, status: 'not-applicable', reason: 'visual-step-skipped', mode: configured.coverage ?? 'warn', phase: null, generation: null,
      profiles: profiles.map((profile) => profile.id), covered: [], uncovered: [], unclaimed: [], stale: [], duplicates: [], warnings: [], errors: [] };
  }
  if (!phase) throw new SingularityFlowError('Verification profiles require a visual verification step (an artifact of kind visual-test-evidence).', { code: 'VISUAL_PHASE_MISSING' });
  const generation = expectedGeneration(phase), integrity = await verifyMcpEvidence(root, workflow, { itemDirectory });
  const directory = itemRoot(root, workflow, itemDirectory);
  const native = await nativeCaptures(directory, workflow);
  const nativeFiles = new Map(native.records.map(({ record, absolute }) => [record, absolute]));
  const candidates = [...integrity.records.filter((record) => record.kind === 'visual-artifact' && record.phase === phase.id),
    ...native.records.map(({ record }) => record).filter((record) => record.phase === phase.id)];
  const current = candidates.filter((record) => Number(record.targetGeneration) === generation);
  const stale = candidates.filter((record) => Number(record.targetGeneration) !== generation).map((record) => record.id).sort();
  const byProfile = new Map();
  for (const record of current) {
    if (!byProfile.has(record.profileId)) byProfile.set(record.profileId, []);
    byProfile.get(record.profileId).push(record);
  }
  const covered = [], uncovered = [], duplicates = [], warnings = [...integrity.warnings], errors = [...integrity.errors, ...native.errors];
  for (const profile of profiles) {
    const records = byProfile.get(profile.id) ?? [];
    if (!records.length) { uncovered.push(profile.id); continue; }
    if (records.length > 1) duplicates.push({ profileId: profile.id, records: records.map((record) => record.id).sort() });
    const record = [...records].sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))[0];
    const expected = profilePixelSize(profile);
    if (nativeFiles.has(record)) {
      // A native capture covers its profile only at the profile's exact pixel size.
      let actual = null;
      try { actual = readPngHeader(await readFile(nativeFiles.get(record))); }
      catch (error) { errors.push(`Native capture '${record.id}' cannot be read as a PNG: ${error.message}`); }
      if (actual && (actual.width !== record.dimensions?.width || actual.height !== record.dimensions?.height)) {
        errors.push(`Native capture '${record.id}' records ${record.dimensions?.width}×${record.dimensions?.height} but its PNG is ${actual.width}×${actual.height}.`);
      } else if (actual && (actual.width !== expected.width || actual.height !== expected.height)) {
        errors.push(`[VISUAL_CAPTURE_DIMENSIONS_MISMATCH] Native capture '${record.id}' is ${actual.width}×${actual.height}; profile '${profile.id}' expects ${expected.width}×${expected.height}.`);
      } else if (actual) {
        covered.push({ profileId: profile.id, recordId: record.id, outputSha256: record.outputSha256, dimensions: actual, method: 'native-capture', source: record.source });
        continue;
      }
      uncovered.push(profile.id);
      continue;
    }
    let dimensions = null;
    if (record.output?.mediaType === 'image/png') {
      try {
        const output = await secureRepositoryPath(directory, record.output.path, { label: `Visual artifact ${record.id}`, mustExist: true, type: 'file' });
        const decoded = decodePngRgba8(await readFile(output.absolute), { maxPixels: configured.comparison?.maxPixels });
        dimensions = { width: decoded.width, height: decoded.height };
        if (decoded.width !== expected.width || decoded.height !== expected.height) warnings.push(`Visual artifact '${record.id}' is ${decoded.width}×${decoded.height}; profile '${profile.id}' expects ${expected.width}×${expected.height}.`);
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
