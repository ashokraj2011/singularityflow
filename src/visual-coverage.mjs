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

export const NATIVE_CAPTURE_MAXIMUM_SCALE = 4;

/**
 * The pixel scale at which a native screenshot fits a profile, or null. A simulator or device
 * captures at its own pixel density (an iPhone Simulator at 3x), so a capture fits at the profile's
 * declared pixel size or at an exact whole-number multiple of its logical size, from its declared
 * density up to 4x: the same screen, never another shape and never a lower density than it asks for. The scale is recorded and shown, never hidden.
 */
/** The scales a native capture may have for this profile, in words: "2x-4x". */
export function nativeCaptureScaleRange(profile) {
  const lowest = Math.max(1, Math.ceil(profile.deviceScaleFactor ?? 1));
  return lowest === NATIVE_CAPTURE_MAXIMUM_SCALE ? `${lowest}x` : `${lowest}x-${NATIVE_CAPTURE_MAXIMUM_SCALE}x`;
}

export function nativeCaptureScale(profile, actual) {
  const expected = profilePixelSize(profile);
  if (actual?.width === expected.width && actual?.height === expected.height) return profile.deviceScaleFactor;
  // Never below the density the profile declares: a profile that asks for 3x is not met at 1x.
  for (let scale = Math.max(1, Math.ceil(profile.deviceScaleFactor ?? 1)); scale <= NATIVE_CAPTURE_MAXIMUM_SCALE; scale += 1) {
    if (actual?.width === profile.width * scale && actual?.height === profile.height * scale) return scale;
  }
  return null;
}

/**
 * The not-applicable decisions (`decision visual-profile`) that hold for a step now, by profile:
 * each one nobody revoked. Pure.
 */
export function activeVisualProfileDecisions(workflow, phaseId) {
  const entries = workflow?.visualProfileDecisions ?? [];
  const revoked = new Set(entries.map((entry) => entry?.revokes).filter(Boolean));
  const active = new Map();
  for (const entry of entries) {
    if (entry?.id && !entry.revokes && !revoked.has(entry.id) && entry.phase === phaseId && entry.disposition === 'not-applicable') active.set(entry.profileId, entry);
  }
  return active;
}

/** The command that records a screenshot taken on a simulator, emulator or device for a profile. */
export function nativeCaptureCommand(phaseId, profileId) {
  return `singularity-flow visual record --phase ${phaseId} --profile-id ${profileId} --screen-id <SCREEN-ID> --state-id <STATE-ID> --file <PNG-PATH> --source <simulator|emulator|device> --device "<DEVICE>"`;
}

/** The command a person who approves the step runs to record that a profile does not apply to this Story. */
export function visualProfileDecisionCommand(workflow, phaseId, profileId) {
  return `singularity-flow decision visual-profile ${workflow?.workItem?.id ?? '<WORK-ID>'} --phase ${phaseId} --profile ${profileId} --not-applicable --reason "<why this screen size does not apply to this Story>"`;
}

/** The routes for each missing profile: capture it, or (while another profile stays required) decide it does not apply. */
export function missingProfileRoutes(workflow, result) {
  const required = result.profiles.length - (result.notApplicable?.length ?? 0);
  return result.uncovered.slice(0, 3).flatMap((profileId) => [
    { command: nativeCaptureCommand(result.phase, profileId),
      label: `Capture ${profileId} at its exact pixel size and record it (from a pinned MCP tool, use mcp record --kind visual-artifact instead).` },
    ...(required > 1 ? [{ command: visualProfileDecisionCommand(workflow, result.phase, profileId),
      label: `Or a person who approves ${result.phase} records, with a reason, that ${profileId} does not apply to this Story; it is listed as not applicable, never as passed.` }] : [])
  ]);
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
  const covered = [], uncovered = [], duplicates = [], notApplicable = [], warnings = [...integrity.warnings], errors = [...integrity.errors, ...native.errors];
  // A person's not-applicable decision stands only while another profile still needs evidence.
  const decided = activeVisualProfileDecisions(workflow, phase.id);
  const decisionsHold = profiles.some((profile) => !decided.has(profile.id));
  if (decided.size && !decisionsHold) errors.push(`Every verification profile is marked not applicable (${[...decided.values()].map((entry) => entry.id).join(', ')}); at least one must be evidenced, so none of those decisions applies.`);
  for (const profile of profiles) {
    const records = byProfile.get(profile.id) ?? [];
    const decision = decisionsHold ? decided.get(profile.id) : null;
    if (!records.length && decision) {
      notApplicable.push({ profileId: profile.id, decisionId: decision.id, reason: decision.reason, actor: decision.actor, authorityGroup: decision.authorityGroup, at: decision.at });
      warnings.push(`Verification profile '${profile.id}' is not applicable for this Story (${decision.id}, decided by ${decision.actor} through ${decision.authorityGroup}): ${decision.reason} This is an exception, not passing evidence.`);
      continue;
    }
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
      } else if (actual && nativeCaptureScale(profile, actual) === null) {
        errors.push(`[VISUAL_CAPTURE_DIMENSIONS_MISMATCH] Native capture '${record.id}' is ${actual.width}×${actual.height}; profile '${profile.id}' expects ${expected.width}×${expected.height} (${profile.width}×${profile.height} at ${nativeCaptureScaleRange(profile)}).`);
      } else if (actual) {
        covered.push({ profileId: profile.id, recordId: record.id, outputSha256: record.outputSha256, dimensions: actual,
          scale: nativeCaptureScale(profile, actual), method: 'native-capture', source: record.source });
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
  // `notApplicable` appears only when a person decided one, so existing projections keep their bytes.
  return { schemaVersion: 1, status, mode: configured.coverage, phase: phase.id, generation, profiles, covered, uncovered, unclaimed, stale, duplicates, warnings, errors,
    ...(notApplicable.length ? { notApplicable } : {}) };
}

export async function assertVisualCoverage(root, workflow, options = {}) {
  const result = await evaluateVisualCoverage(root, workflow, options);
  if (result.mode === 'enforce' && result.errors.length) {
    const routes = result.uncovered?.length ? missingProfileRoutes(workflow, result) : [];
    throw new SingularityFlowError(`Visual verification coverage failed:\n- ${result.errors.join('\n- ')}${routes.length
      ? '\nCapture each missing profile at its pixel size, or a whole-number multiple of it from a simulator, emulator or device (visual record), or a person who approves the step records that it does not apply to this Story (decision visual-profile).' : ''}`,
    { code: 'VISUAL_COVERAGE_FAILED', details: { ...result, ...(routes.length ? { nextAction: routes[0], recoveryCommands: routes } : {}) } });
  }
  return result;
}
