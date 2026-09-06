/**
 * Disposable SGOS learning workspaces.
 *
 * A learning workspace is machine-local tutorial state under the Git common directory. It never
 * alters the application checkout, executes fixture content, or creates governance authority.
 */
import path from 'node:path';
import { rm } from 'node:fs/promises';

import { gitCommonDir } from '../../git.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, safePrivateSidecarDirectory, writeImmutablePrivateSidecar,
  writeMutablePrivateSidecar
} from '../../private-sidecar.mjs';
import { canonicalJson } from '../../records.mjs';
import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import { scanText } from '../../secrets.mjs';
import { withSubjectLock } from '../../subject-lock.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { clonePlatformJson, isPlainPlatformObject, platformSha256 } from './contracts.mjs';

const FIXTURE_KIND = 'learning-fixture';
const FIXTURE_VERSION = 1;
const WORKSPACE_FAMILY = 'learning-workspace';
const PROGRESS_FAMILY = 'learning-progress';
const MAX_FIXTURE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 64;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PROGRESS_BYTES = 64 * 1024;
const MAX_TRANSFER_BYTES = 96 * 1024;
const TRANSFER_PREFIXES = Object.freeze(new Map([
  [1, 'sflow-learning-progress-v1.'],
  [2, 'sflow-learning-progress-v2.']
]));
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const PORTABLE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(message, code = 'SGOS_LEARN_WORKSPACE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function exactKeys(value, allowed, label) {
  if (!isPlainPlatformObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing required field '${key}'.`);
  }
}

function fixturePath(value, label) {
  const segments = typeof value === 'string' ? value.split('/') : [];
  if (typeof value !== 'string' || !value || value !== value.trim()
      || value.includes('\\') || value.startsWith('/') || value.endsWith('/')
      || segments.some((segment) => !PORTABLE_SEGMENT.test(segment)
        || WINDOWS_RESERVED.test(segment) || segment.endsWith('.'))
      || path.posix.normalize(value) !== value) {
    fail(`${label} must be one portable normalized relative POSIX path.`,
      'SGOS_LEARN_FIXTURE_PATH_INVALID');
  }
  if (Buffer.byteLength(value, 'utf8') > 512) {
    fail(`${label} exceeds the 512-byte limit.`, 'SGOS_LEARN_LIMIT');
  }
  return value;
}

function fixtureDigest(value) {
  const core = clonePlatformJson(value, '$learningFixture');
  delete core.fixtureSha256;
  return platformSha256(core);
}

export function validateLearningFixture(input) {
  exactKeys(input, ['kind', 'id', 'version', 'files', 'fixtureSha256'], 'learning fixture');
  if (input.kind !== FIXTURE_KIND) fail(`Learning fixture kind must be '${FIXTURE_KIND}'.`);
  if (input.version !== FIXTURE_VERSION) fail(`Learning fixture version must be ${FIXTURE_VERSION}.`);
  if (typeof input.id !== 'string' || !ID.test(input.id)) {
    fail('Learning fixture ID has an invalid format.');
  }
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
    fail(`Learning fixture files must contain between 1 and ${MAX_FILES} entries.`,
      'SGOS_LEARN_LIMIT');
  }
  let previous = null;
  let totalBytes = 0;
  for (const [index, file] of input.files.entries()) {
    exactKeys(file, ['path', 'content'], `learning fixture.files[${index}]`);
    const relative = fixturePath(file.path, `learning fixture.files[${index}].path`);
    if (previous !== null && previous >= relative) {
      fail('Learning fixture files must be sorted by unique path.');
    }
    previous = relative;
    if (typeof file.content !== 'string') {
      fail(`learning fixture.files[${index}].content must be UTF-8 text.`);
    }
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) {
      fail(`Learning fixture file '${relative}' exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        'SGOS_LEARN_LIMIT');
    }
    const findings = scanText(file.content, { path: '<learning-fixture>' });
    if (findings.length) {
      fail(`Learning fixture file '${relative}' contains credential-shaped content.`,
        'SGOS_LEARN_SECRET_REFUSED', {
          rules: [...new Set(findings.map((finding) => finding.rule))].sort()
        });
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_FIXTURE_BYTES) {
    fail(`Learning fixture exceeds the ${MAX_FIXTURE_BYTES}-byte limit.`, 'SGOS_LEARN_LIMIT');
  }
  if (!SHA256.test(String(input.fixtureSha256 ?? ''))
      || input.fixtureSha256 !== fixtureDigest(input)) {
    fail('Learning fixture failed self-hash verification.', 'SGOS_LEARN_FIXTURE_TAMPERED');
  }
  return Object.freeze(clonePlatformJson(input, '$learningFixture'));
}

export function createLearningFixture(input) {
  if (!isPlainPlatformObject(input) || Object.hasOwn(input, 'fixtureSha256')) {
    fail('Learning fixture creation expects an object without fixtureSha256.');
  }
  const fixture = { ...clonePlatformJson(input, '$learningFixture'), fixtureSha256: null };
  fixture.fixtureSha256 = fixtureDigest(fixture);
  return validateLearningFixture(fixture);
}

function missionSegment(missionId) {
  if (!SHA256.test(String(missionId ?? ''))) {
    fail('Learning mission ID must be one exact SHA-256.', 'SGOS_LEARN_MISSION_INVALID');
  }
  return missionId.slice('sha256:'.length);
}

function learningRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'learning');
}

function missionRoot(root, missionId) {
  return path.join(learningRoot(root), missionSegment(missionId));
}

function workspacePath(root, missionId) {
  return path.join(missionRoot(root, missionId), 'workspace');
}

function manifestPath(root, missionId) {
  return path.join(missionRoot(root, missionId), 'workspace.json');
}

function progressPath(root, missionId) {
  return path.join(missionRoot(root, missionId), 'progress.json');
}

function planCore(mission, fixture) {
  return {
    kind: 'learning-workspace-materialization-plan', version: 1,
    missionId: mission.missionId,
    lessonId: mission.lesson.lessonId,
    role: mission.lesson.role,
    packId: mission.lesson.packId,
    packSha256: mission.lesson.packSha256,
    moduleSha256: mission.module.moduleSha256,
    fixtureId: fixture.id,
    fixtureSha256: fixture.fixtureSha256,
    fileCount: fixture.files.length,
    totalBytes: fixture.files.reduce((total, file) =>
      total + Buffer.byteLength(file.content, 'utf8'), 0),
    effects: {
      applicationRepository: 'none', git: 'none', governedProcess: 'none',
      modelInvocations: 0, toolInvocations: 0,
      machineLocalTutorial: 'create-or-verify'
    }
  };
}

function materializationPlan(mission, fixture) {
  const core = planCore(mission, fixture);
  return Object.freeze({ ...core, confirmationSha256: platformSha256(core) });
}

function workspaceRecord(mission, fixture) {
  const core = {
    schemaVersion: currentSchemaVersion(WORKSPACE_FAMILY),
    kind: 'learning-workspace',
    missionId: mission.missionId,
    lessonId: mission.lesson.lessonId,
    role: mission.lesson.role,
    packId: mission.lesson.packId,
    packSha256: mission.lesson.packSha256,
    moduleSha256: mission.module.moduleSha256,
    fixtureId: fixture.id,
    fixtureSha256: fixture.fixtureSha256,
    files: fixture.files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      sha256: platformSha256(Buffer.from(file.content, 'utf8'))
    })),
    authority: false,
    certification: false,
    employeeScoring: false
  };
  return Object.freeze({ ...core, workspaceSha256: platformSha256(core) });
}

async function readManifest(root, missionId, { optional = false } = {}) {
  const bytes = await readPrivateSidecar(root, manifestPath(root, missionId), {
    maximumBytes: MAX_MANIFEST_BYTES, optional
  });
  if (bytes === null) return null;
  const record = readRecord(WORKSPACE_FAMILY, bytes).record;
  const core = clonePlatformJson(record, '$learningWorkspace');
  delete core.workspaceSha256;
  if (record.kind !== 'learning-workspace' || record.missionId !== missionId
      || !SHA256.test(String(record.workspaceSha256 ?? ''))
      || record.workspaceSha256 !== platformSha256(core)) {
    fail('Learning workspace manifest failed integrity verification.',
      'SGOS_LEARN_WORKSPACE_TAMPERED');
  }
  return record;
}

function progressRecord(manifest, completedCheckIds) {
  const core = {
    schemaVersion: currentSchemaVersion(PROGRESS_FAMILY),
    kind: 'learning-progress',
    missionId: manifest.missionId,
    lessonId: manifest.lessonId,
    role: manifest.role,
    packId: manifest.packId,
    packSha256: manifest.packSha256,
    moduleSha256: manifest.moduleSha256,
    fixtureSha256: manifest.fixtureSha256,
    completedCheckIds: [...new Set(completedCheckIds)].sort(),
    progressProfile: 'identity-free-monotonic-v2',
    authority: false,
    certification: false,
    employeeScoring: false
  };
  return Object.freeze({ ...core, progressSha256: platformSha256(core) });
}

function validateProgress(input) {
  exactKeys(input, [
    'schemaVersion', 'kind', 'missionId', 'lessonId', 'role', 'packId', 'packSha256',
    'moduleSha256', 'fixtureSha256', 'completedCheckIds', 'authority', 'certification',
    'employeeScoring', 'progressProfile', 'progressSha256'
  ], 'learning progress');
  if (input.kind !== 'learning-progress') {
    fail('Learning progress uses an unsupported schema.', 'SGOS_LEARN_PROGRESS_INVALID');
  }
  missionSegment(input.missionId);
  for (const [label, value] of [['lesson ID', input.lessonId], ['Pack ID', input.packId]]) {
    if (typeof value !== 'string' || !ID.test(value)) {
      fail(`Learning progress ${label} is invalid.`, 'SGOS_LEARN_PROGRESS_INVALID');
    }
  }
  if (typeof input.role !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(input.role)) {
    fail('Learning progress role is invalid.', 'SGOS_LEARN_PROGRESS_INVALID');
  }
  for (const [label, value] of [
    ['Pack', input.packSha256], ['module', input.moduleSha256],
    ['fixture', input.fixtureSha256], ['record', input.progressSha256]
  ]) {
    if (!SHA256.test(String(value ?? ''))) {
      fail(`Learning progress ${label} digest is invalid.`, 'SGOS_LEARN_PROGRESS_INVALID');
    }
  }
  if (!Array.isArray(input.completedCheckIds) || input.completedCheckIds.length > 64) {
    fail('Learning progress completed checks exceed the installed limit.', 'SGOS_LEARN_LIMIT');
  }
  let previous = null;
  for (const checkId of input.completedCheckIds) {
    if (typeof checkId !== 'string' || !ID.test(checkId)
        || (previous !== null && previous >= checkId)) {
      fail('Learning progress completed checks must be sorted unique identifiers.',
        'SGOS_LEARN_PROGRESS_INVALID');
    }
    previous = checkId;
  }
  if (input.authority !== false || input.certification !== false
      || input.employeeScoring !== false) {
    fail('Learning progress cannot contain authority, certification, or employee scoring.',
      'SGOS_LEARN_PROGRESS_AUTHORITY_REFUSED');
  }
  if (input.progressProfile !== 'identity-free-monotonic-v2') {
    fail('Learning progress profile is not installed.', 'SGOS_LEARN_PROGRESS_INVALID');
  }
  const core = clonePlatformJson(input, '$learningProgress');
  delete core.progressSha256;
  if (input.progressSha256 !== platformSha256(core)) {
    fail('Learning progress failed integrity verification.', 'SGOS_LEARN_PROGRESS_TAMPERED');
  }
  return Object.freeze(clonePlatformJson(input, '$learningProgress'));
}

async function readProgress(root, missionId, { optional = false } = {}) {
  const bytes = await readPrivateSidecar(root, progressPath(root, missionId), {
    maximumBytes: MAX_PROGRESS_BYTES, optional
  });
  if (bytes === null) return null;
  return validateProgress(readRecord(PROGRESS_FAMILY, bytes).record);
}

function progressProjection(missionId, progress = null) {
  return Object.freeze({
    missionId,
    status: progress ? 'in-progress' : 'not-started',
    completedCheckIds: Object.freeze([...(progress?.completedCheckIds ?? [])]),
    progressSha256: progress?.progressSha256 ?? null,
    portable: true,
    recordsAttempts: false,
    recordsIdentity: false,
    recordsTime: false,
    recordsAnswers: false,
    authority: false,
    certification: false,
    employeeScoring: false
  });
}

function assertProgressBinding(progress, manifest) {
  for (const key of [
    'missionId', 'lessonId', 'role', 'packId', 'packSha256', 'moduleSha256', 'fixtureSha256'
  ]) {
    if (progress[key] !== manifest[key]) {
      fail(`Learning progress ${key} does not match the local tutorial workspace.`,
        'SGOS_LEARN_PROGRESS_BINDING_MISMATCH');
    }
  }
}

function encodeProgressTransfer(progress) {
  const prefix = TRANSFER_PREFIXES.get(progress.schemaVersion);
  if (!prefix) {
    fail('Learning progress transfer uses an unsupported schema version.',
      'SGOS_LEARN_PROGRESS_TRANSFER_INVALID');
  }
  return `${prefix}${Buffer.from(canonicalJson(progress), 'utf8').toString('base64url')}`;
}

function decodeProgressTransfer(transfer) {
  const selected = typeof transfer === 'string'
    ? [...TRANSFER_PREFIXES.entries()].find(([, prefix]) => transfer.startsWith(prefix))
    : null;
  const encoded = selected ? transfer.slice(selected[1].length) : '';
  if (!selected || Buffer.byteLength(transfer, 'utf8') > MAX_TRANSFER_BYTES
      || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    fail('Learning progress transfer is malformed or exceeds the installed limit.',
      'SGOS_LEARN_PROGRESS_TRANSFER_INVALID');
  }
  let bytes;
  let parsed;
  try {
    bytes = Buffer.from(encoded, 'base64url');
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('Learning progress transfer is not canonical JSON.',
      'SGOS_LEARN_PROGRESS_TRANSFER_INVALID');
  }
  const decoded = readRecord(PROGRESS_FAMILY, parsed);
  if (TRANSFER_PREFIXES.get(decoded.storedVersion) !== selected[1]
      || !bytes.equals(Buffer.from(canonicalJson(parsed), 'utf8'))
      || `${selected[1]}${Buffer.from(canonicalJson(parsed), 'utf8').toString('base64url')}` !== transfer) {
    fail('Learning progress transfer is not canonically encoded.',
      'SGOS_LEARN_PROGRESS_TRANSFER_INVALID');
  }
  return validateProgress(decoded.record);
}

export function createLearningWorkspaceService({ lessonCatalog = null, repositoryRoot }) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim()) {
    fail('Learning workspace service requires an explicit repository root.');
  }
  if (lessonCatalog !== null && typeof lessonCatalog?.start !== 'function') {
    fail('Learning workspace service received an invalid signed lesson catalog.');
  }
  const root = path.resolve(repositoryRoot);

  async function resolveMission(request) {
    if (!lessonCatalog) {
      fail('Pack-backed learning operations require the signed lesson catalog.',
        'SGOS_LEARN_LESSON_AUTHORITY_REQUIRED');
    }
    const mission = await lessonCatalog.start(request);
    return mission;
  }

  async function resolve(request) {
    const mission = await resolveMission(request);
    const fixture = validateLearningFixture(request.fixture);
    if (mission.module.sandboxFixture.fixtureId !== fixture.id
        || mission.module.sandboxFixture.fixtureSha256 !== fixture.fixtureSha256) {
      fail('Learning fixture does not match the exact module fixture ID and digest.',
        'SGOS_LEARN_FIXTURE_BINDING_MISMATCH');
    }
    return { mission, fixture, plan: materializationPlan(mission, fixture) };
  }

  async function checkedWorkspace(mission) {
    const manifest = await readManifest(root, mission.missionId);
    const expected = {
      missionId: mission.missionId,
      lessonId: mission.lesson.lessonId,
      role: mission.lesson.role,
      packId: mission.lesson.packId,
      packSha256: mission.lesson.packSha256,
      moduleSha256: mission.module.moduleSha256,
      fixtureSha256: mission.module.sandboxFixture.fixtureSha256
    };
    for (const [key, value] of Object.entries(expected)) {
      if (manifest[key] !== value) {
        fail(`Learning workspace ${key} no longer matches the signed lesson.`,
          'SGOS_LEARN_WORKSPACE_BINDING_MISMATCH');
      }
    }
    return manifest;
  }

  async function evaluateCheck(request) {
    const check = request.module?.completionChecks?.find(
      (candidate) => candidate?.checkId === request.checkId
    );
    if (!check) {
      fail(`Learning check '${request.checkId ?? ''}' is unavailable.`,
        'SGOS_LEARN_CHECK_UNAVAILABLE');
    }
    if (check.type === 'quiz') return lessonCatalog.quiz(request);
    if (check.type === 'teach-back') return lessonCatalog.teachBack(request);
    fail(`Learning check '${request.checkId}' has an unsupported type.`,
      'SGOS_LEARN_CHECK_UNAVAILABLE');
  }

  async function planImport(transfer) {
    const incoming = decodeProgressTransfer(transfer);
    const manifest = await readManifest(root, incoming.missionId);
    assertProgressBinding(incoming, manifest);
    const existing = await readProgress(root, incoming.missionId, { optional: true });
    if (existing) assertProgressBinding(existing, manifest);
    const merged = progressRecord(manifest, [
      ...(existing?.completedCheckIds ?? []), ...incoming.completedCheckIds
    ]);
    const core = {
      kind: 'learning-progress-import-plan',
      version: 1, // schema-transient: confirmation plan, never written.
      missionId: incoming.missionId,
      incomingProgressSha256: incoming.progressSha256,
      currentProgressSha256: existing?.progressSha256 ?? null,
      mergedProgressSha256: merged.progressSha256,
      checksAdded: merged.completedCheckIds.filter(
        (checkId) => !existing?.completedCheckIds.includes(checkId)
      ),
      effect: 'merge-machine-local-learning-progress-only'
    };
    return Object.freeze({
      ...core, confirmationSha256: platformSha256(core), merged
    });
  }

  async function planReset(missionId) {
    const manifest = await readManifest(root, missionId);
    const core = {
      kind: 'learning-workspace-reset-plan', version: 1, missionId,
      workspaceSha256: manifest.workspaceSha256,
      effect: 'delete-machine-local-tutorial-only'
    };
    return Object.freeze({ ...core, confirmationSha256: platformSha256(core) });
  }

  return Object.freeze({
    profile: 'disposable-learning-workspace-v1',

    async plan(request) {
      return (await resolve(request)).plan;
    },

    async materialize(request) {
      const selected = await resolve(request);
      if (request.confirm !== selected.plan.confirmationSha256) {
        fail(`Learning workspace confirmation must equal ${selected.plan.confirmationSha256}.`,
          'SGOS_LEARN_CONFIRMATION_MISMATCH');
      }
      return withSubjectLock(root, {
        kind: 'sgos-learning', id: missionSegment(selected.mission.missionId)
      }, async () => {
        // Resolve again while holding the mission lock so Pack revocation or replacement between
        // preview and mutation cannot materialize stale tutorial bytes.
        const current = await resolve(request);
        if (current.plan.confirmationSha256 !== request.confirm) {
          fail(`Learning workspace plan changed; review ${current.plan.confirmationSha256}.`,
            'SGOS_LEARN_CONFIRMATION_MISMATCH');
        }
        const target = workspacePath(root, current.mission.missionId);
        await safePrivateSidecarDirectory(root, target, { create: true });
        for (const file of current.fixture.files) {
          await writeImmutablePrivateSidecar(root, path.join(target, ...file.path.split('/')),
            Buffer.from(file.content, 'utf8'), { maximumBytes: MAX_FILE_BYTES });
        }
        const manifest = workspaceRecord(current.mission, current.fixture);
        await writeImmutablePrivateSidecar(root, manifestPath(root, current.mission.missionId),
          `${canonicalJson(manifest)}\n`, { maximumBytes: MAX_MANIFEST_BYTES });
        return Object.freeze({
          ...manifest, status: 'ready', workspacePath: target,
          boundary: {
            applicationRepository: false, gitChanges: false, processAuthority: false,
            certification: false, employeeScoring: false
          }
        });
      });
    },

    async status(missionId) {
      const manifest = await readManifest(root, missionId, { optional: true });
      if (!manifest) {
        const partialEntries = await listPrivateSidecar(root, missionRoot(root, missionId), {
          optional: true
        });
        return Object.freeze({
          missionId,
          status: partialEntries.length ? 'interrupted' : 'not-materialized',
          recovery: partialEntries.length ? 'repeat-confirmed-materialize' : null,
          partialEntryCount: partialEntries.length,
          authority: false,
          certification: false,
          employeeScoring: false
        });
      }
      const target = workspacePath(root, missionId);
      const changed = [];
      const missing = [];
      for (const file of manifest.files) {
        const bytes = await readPrivateSidecar(root, path.join(target, ...file.path.split('/')), {
          maximumBytes: MAX_FILE_BYTES, optional: true
        });
        if (bytes === null) missing.push(file.path);
        else if (bytes.length !== file.bytes || platformSha256(bytes) !== file.sha256) changed.push(file.path);
      }
      const progress = await readProgress(root, missionId, { optional: true });
      if (progress) assertProgressBinding(progress, manifest);
      return Object.freeze({
        missionId, status: missing.length ? 'incomplete' : changed.length ? 'changed' : 'ready',
        workspacePath: target, moduleSha256: manifest.moduleSha256,
        fixtureSha256: manifest.fixtureSha256,
        files: Object.freeze({ total: manifest.files.length, missing, changed }),
        progress: progressProjection(missionId, progress),
        authority: false, certification: false, employeeScoring: false
      });
    },

    async progress(missionId) {
      const manifest = await readManifest(root, missionId);
      const progress = await readProgress(root, missionId, { optional: true });
      if (progress) assertProgressBinding(progress, manifest);
      return progressProjection(missionId, progress);
    },

    async recordCheck(request) {
      const mission = await resolveMission(request);
      return withSubjectLock(root, {
        kind: 'sgos-learning', id: missionSegment(mission.missionId)
      }, async () => {
        // Re-resolve and evaluate while holding the mission lock. A Pack replacement or revoked
        // lesson cannot write progress for bytes that are no longer current.
        const currentMission = await resolveMission(request);
        if (currentMission.missionId !== mission.missionId) {
          fail('Learning mission authority changed before progress could be recorded.',
            'SGOS_LEARN_LESSON_AUTHORITY_CHANGED');
        }
        const manifest = await checkedWorkspace(currentMission);
        const result = await evaluateCheck(request);
        const finalMission = await resolveMission(request);
        if (finalMission.missionId !== currentMission.missionId) {
          fail('Learning mission authority changed while the check was evaluated.',
            'SGOS_LEARN_LESSON_AUTHORITY_CHANGED');
        }
        const existing = await readProgress(root, currentMission.missionId, { optional: true });
        if (existing) assertProgressBinding(existing, manifest);
        if (result.status !== 'passed') {
          return Object.freeze({
            changed: false,
            result: Object.freeze({
              checkId: result.checkId, checkType: result.checkType,
              evaluation: result.evaluation, status: result.status,
              certification: false, authority: false
            }),
            progress: progressProjection(currentMission.missionId, existing)
          });
        }
        const next = progressRecord(manifest, [
          ...(existing?.completedCheckIds ?? []), result.checkId
        ]);
        const changed = existing?.progressSha256 !== next.progressSha256;
        if (changed) {
          await writeMutablePrivateSidecar(root, progressPath(root, currentMission.missionId),
            `${canonicalJson(next)}\n`, { maximumBytes: MAX_PROGRESS_BYTES });
        }
        return Object.freeze({
          changed,
          result: Object.freeze({
            checkId: result.checkId, checkType: result.checkType,
            evaluation: result.evaluation, status: result.status,
            certification: false, authority: false
          }),
          progress: progressProjection(currentMission.missionId, next)
        });
      });
    },

    async exportProgress(missionId) {
      const manifest = await readManifest(root, missionId);
      const progress = await readProgress(root, missionId);
      assertProgressBinding(progress, manifest);
      return Object.freeze({
        kind: 'learning-progress-transfer',
        version: 1, // schema-transient: copy/paste transport, never written.
        encoding: 'base64url-canonical-json',
        missionId,
        progressSha256: progress.progressSha256,
        transfer: encodeProgressTransfer(progress),
        containsIdentity: false,
        containsAnswers: false,
        containsTiming: false,
        authority: false,
        certification: false,
        employeeScoring: false
      });
    },

    async importPlan(transfer) {
      const { merged, ...plan } = await planImport(transfer);
      return Object.freeze(plan);
    },

    async importProgress(transfer, confirm) {
      const decoded = decodeProgressTransfer(transfer);
      return withSubjectLock(root, {
        kind: 'sgos-learning', id: missionSegment(decoded.missionId)
      }, async () => {
        const plan = await planImport(transfer);
        if (confirm !== plan.confirmationSha256) {
          fail(`Learning progress import confirmation must equal ${plan.confirmationSha256}.`,
            'SGOS_LEARN_CONFIRMATION_MISMATCH');
        }
        const existing = await readProgress(root, decoded.missionId, { optional: true });
        const changed = existing?.progressSha256 !== plan.merged.progressSha256;
        if (changed) {
          await writeMutablePrivateSidecar(root, progressPath(root, decoded.missionId),
            `${canonicalJson(plan.merged)}\n`, { maximumBytes: MAX_PROGRESS_BYTES });
        }
        return Object.freeze({
          changed,
          progress: progressProjection(decoded.missionId, plan.merged),
          importedProgressSha256: decoded.progressSha256,
          mergeOnly: true,
          authority: false,
          certification: false,
          employeeScoring: false
        });
      });
    },

    async resetPlan(missionId) {
      return planReset(missionId);
    },

    async reset(missionId, confirm) {
      return withSubjectLock(root, { kind: 'sgos-learning', id: missionSegment(missionId) }, async () => {
        const plan = await planReset(missionId);
        if (confirm !== plan.confirmationSha256) {
          fail(`Learning workspace reset confirmation must equal ${plan.confirmationSha256}.`,
            'SGOS_LEARN_CONFIRMATION_MISMATCH');
        }
        const target = missionRoot(root, missionId);
        await safePrivateSidecarDirectory(root, target);
        await rm(target, { recursive: true, force: false });
        return Object.freeze({ missionId, status: 'reset', applicationRepositoryChanged: false,
          gitChanged: false, processAuthorityChanged: false });
      });
    }
  });
}
