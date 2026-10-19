/**
 * A screenshot taken on an iOS Simulator, Android emulator or physical device, recorded as what it
 * is: a native capture.
 *
 * Enforced visual coverage needs a profile-bound screenshot for each screen size. `mcp record`
 * binds one to a pinned MCP server and tool, so a `xcrun simctl io booted screenshot` or
 * `adb exec-out screencap -p` capture had no honest way in: recording it meant naming a tool that
 * did not produce it. A native capture names its source kind (simulator, emulator or device), the
 * device and optionally its OS version, and never an MCP server or tool. Flow copies the PNG into
 * the Story, binds its digest, reads its width and height from the PNG header, and refuses it when
 * that size is not the profile's exact pixel size. The record says the capture was declared by
 * whoever recorded it; Flow did not watch the device. It is committed by the next publication.
 */
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { isVisualVerificationPhase } from './phase-roles.mjs';
import { readPngHeader } from './png-rgba8.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { nowIso, posix, secureRepositoryPath, SingularityFlowError, snapshot, writeAtomic, writeJson } from './util.mjs';
import { NATIVE_CAPTURE_DIRECTORY, NATIVE_CAPTURE_FORMAT, NATIVE_CAPTURE_SOURCES, nativeCaptureScale, nativeCaptureScaleRange, profilePixelSize } from './visual-coverage.mjs';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_RECORDS = 5000;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEVICE = /^[\p{L}\p{N}][\p{L}\p{N} ._()'+,-]{0,119}$/u;
const OS_VERSION = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,39}$/u;
const SECRET = /(?:authorization|bearer|cookie|api[_-]?key|access[_-]?token|password|secret)\s*[:=]/iu;

function invalid(message, details = undefined) {
  return new SingularityFlowError(message, { code: 'VISUAL_CAPTURE_INVALID', ...(details ? { details } : {}) });
}

function managedName(relative) {
  const clean = path.basename(relative).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  return clean || 'capture.png';
}

/**
 * Record one native capture for a profile of the in-progress visual step. Returns the record, its
 * repository-relative file and the repository-relative copy of the image. Refuses
 * `VISUAL_CAPTURE_DIMENSIONS_MISMATCH` naming the expected and actual pixel sizes when the PNG is
 * not the profile's size; nothing is written then.
 */
export async function recordNativeVisualCapture(root, workflow, {
  phase = null, profileId, screenId, stateId, file, source, device, osVersion = null, note = null,
  actor = null, agent = null, itemDirectory = null
} = {}) {
  const phaseId = phase ?? workflow.currentPhase;
  const step = workflow.phases?.[phaseId];
  if (!step || !isVisualVerificationPhase(step)) {
    throw invalid(`A native capture is recorded for a visual verification step (an artifact of kind visual-test-evidence); ${phaseId ?? 'no step'} is not one.`);
  }
  if (step.status !== 'in_progress') {
    throw new SingularityFlowError(`A native capture can only be recorded for an in-progress step; ${phaseId} is ${step.status}.`, { code: 'VISUAL_CAPTURE_PHASE_CLOSED' });
  }
  const profiles = workflow.resolution?.verification?.profiles ?? [];
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) throw invalid(`${phaseId} does not check a verification profile '${profileId ?? ''}'; it checks ${profiles.map((entry) => entry.id).join(', ') || 'none'}.`);
  for (const [option, value] of [['--screen-id', screenId], ['--state-id', stateId]]) {
    if (!IDENTITY.test(String(value ?? ''))) throw invalid(`${option} takes 1 to 128 letters, digits, dots, underscores or hyphens.`);
  }
  if (!NATIVE_CAPTURE_SOURCES.includes(source)) throw invalid(`--source says where the screenshot was taken: ${NATIVE_CAPTURE_SOURCES.join(', ')}.`);
  if (!DEVICE.test(String(device ?? ''))) throw invalid('--device names the simulator, emulator or device that took the screenshot (1 to 120 characters).');
  if (osVersion != null && !OS_VERSION.test(String(osVersion))) throw invalid('--os-version takes 1 to 40 letters, digits, spaces, dots, hyphens or parentheses.');
  if (note != null && (String(note).length > 500 || SECRET.test(String(note)))) throw invalid('--note takes at most 500 characters and never a credential or secret.');
  if (!file) throw invalid('Name the repository-relative PNG with --file.');
  const input = await secureRepositoryPath(root, file, { label: 'Native capture', mustExist: true, type: 'file' });
  const info = await lstat(input.absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw invalid('A native capture must be a regular file, not a symbolic link.');
  if (info.size > MAX_BYTES) throw invalid(`A native capture may be at most ${MAX_BYTES} bytes.`);
  if (path.extname(input.relative).toLowerCase() !== '.png') throw invalid('A native capture must be a PNG file (.png).');
  const bytes = await readFile(input.absolute);
  let actual;
  try { actual = readPngHeader(bytes); } catch (error) { throw invalid(`${input.relative} cannot be read as a PNG: ${error.message}`); }
  const expected = profilePixelSize(profile);
  const scale = nativeCaptureScale(profile, actual);
  if (scale === null) {
    throw new SingularityFlowError(`${input.relative} is ${actual.width}×${actual.height} pixels; verification profile '${profile.id}' (${profile.label}) expects ${expected.width}×${expected.height} `
      + `(${profile.width}×${profile.height} at ${nativeCaptureScaleRange(profile)}). Record a capture at that size, or under the profile it matches; nothing was recorded.`, {
      code: 'VISUAL_CAPTURE_DIMENSIONS_MISMATCH', details: { phase: phaseId, profileId: profile.id, expected, actual }
    });
  }
  const itemRoot = itemDirectory ?? path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const recordsDirectory = path.join(itemRoot, NATIVE_CAPTURE_DIRECTORY, 'records');
  const id = `vnc-${randomUUID()}`;
  return withSubjectLock(root, { kind: 'story', id: workflow.workItem.id }, async () => {
    const existing = await readdir(recordsDirectory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    if (existing.filter((name) => name.endsWith('.json')).length >= MAX_RECORDS) {
      throw new SingularityFlowError(`Native capture limit reached (${MAX_RECORDS} records).`, { code: 'VISUAL_CAPTURE_LIMIT' });
    }
    const outputsDirectory = path.join(itemRoot, NATIVE_CAPTURE_DIRECTORY, 'outputs', id);
    try {
      const relative = posix(path.join(NATIVE_CAPTURE_DIRECTORY, 'outputs', id, managedName(input.relative)));
      const target = await secureRepositoryPath(itemRoot, relative, { label: 'Managed native capture' });
      await writeAtomic(target.absolute, bytes);
      const captured = await snapshot(target.absolute);
      const record = {
        // A format string, not a registered record family: the migration registry is locked.
        format: NATIVE_CAPTURE_FORMAT,
        id,
        kind: 'visual-native-capture',
        // A native capture, never an MCP tool result: no server, no tool, and Flow did not observe it.
        evidenceMethod: 'native-capture',
        captureSource: 'declared-by-recorder',
        workId: workflow.workItem.id,
        phase: phaseId,
        targetGeneration: nextPhaseGeneration(step),
        profileId: profile.id, screenId, stateId,
        source: { kind: source, device: String(device), osVersion: osVersion == null ? null : String(osVersion) },
        dimensions: actual,
        scale,
        output: { path: relative, sha256: captured.sha256, bytes: captured.size, mediaType: 'image/png', sourceDisposition: 'local-copy' },
        outputSha256: captured.sha256,
        actor, agent,
        recordedAt: nowIso(),
        note: note == null ? null : String(note)
      };
      const recordFile = path.join(recordsDirectory, `${id}.json`);
      await writeJson(recordFile, record);
      return { file: posix(path.relative(root, recordFile)), image: posix(path.relative(root, target.absolute)), record };
    } catch (error) {
      await rm(outputsDirectory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}
