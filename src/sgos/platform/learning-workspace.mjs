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
  readPrivateSidecar, safePrivateSidecarDirectory, writeImmutablePrivateSidecar
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
const MAX_FIXTURE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 64;
const MAX_MANIFEST_BYTES = 256 * 1024;
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

export function createLearningWorkspaceService({ lessonCatalog = null, repositoryRoot }) {
  if (typeof repositoryRoot !== 'string' || !repositoryRoot.trim()) {
    fail('Learning workspace service requires an explicit repository root.');
  }
  if (lessonCatalog !== null && typeof lessonCatalog?.start !== 'function') {
    fail('Learning workspace service received an invalid signed lesson catalog.');
  }
  const root = path.resolve(repositoryRoot);

  async function resolve(request) {
    if (!lessonCatalog) {
      fail('Materializing a learning workspace requires the signed lesson catalog.',
        'SGOS_LEARN_LESSON_AUTHORITY_REQUIRED');
    }
    const mission = await lessonCatalog.start(request);
    const fixture = validateLearningFixture(request.fixture);
    if (mission.module.sandboxFixture.fixtureId !== fixture.id
        || mission.module.sandboxFixture.fixtureSha256 !== fixture.fixtureSha256) {
      fail('Learning fixture does not match the exact module fixture ID and digest.',
        'SGOS_LEARN_FIXTURE_BINDING_MISMATCH');
    }
    return { mission, fixture, plan: materializationPlan(mission, fixture) };
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
      if (!manifest) return Object.freeze({ missionId, status: 'not-materialized' });
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
      return Object.freeze({
        missionId, status: missing.length ? 'incomplete' : changed.length ? 'changed' : 'ready',
        workspacePath: target, moduleSha256: manifest.moduleSha256,
        fixtureSha256: manifest.fixtureSha256,
        files: Object.freeze({ total: manifest.files.length, missing, changed }),
        authority: false, certification: false, employeeScoring: false
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
