import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { FosGitObjectService } from './fos-object-service.mjs';
import { recordSha256 } from './records.mjs';
import { createRepoContext } from './repo-context.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { run, SingularityFlowError } from './util.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function portable(relative) {
  const value = String(relative ?? '').split(path.sep).join('/');
  if (!value || path.isAbsolute(value) || value.split('/').includes('..') || value.includes('\0')) {
    throw new SingularityFlowError(`FOS input path '${value}' is not repository-relative.`, {
      code: 'FOS_INPUT_PATH_INVALID'
    });
  }
  return value;
}

function selection(value) {
  if (typeof value === 'string') return { path: portable(value), source: 'worktree' };
  const selected = { path: portable(value?.path), source: value?.source ?? 'worktree' };
  if (!['worktree', 'index'].includes(selected.source)) throw new SingularityFlowError(
    `Unknown FOS input source '${selected.source}'.`, { code: 'FOS_INPUT_SOURCE_INVALID' }
  );
  return selected;
}

async function worktreeInput(root, selected, readBoundaryHook = null) {
  const absolute = path.resolve(root, selected.path);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SingularityFlowError(
    `FOS input path '${selected.path}' escapes the repository.`, { code: 'FOS_INPUT_PATH_INVALID' }
  );
  const before = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(
      `Required FOS input '${selected.path}' is missing from the worktree.`, {
        code: 'FOS_INPUT_MISSING', details: { path: selected.path, source: selected.source }
      }
    );
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink()) throw new SingularityFlowError(
    `Required FOS input '${selected.path}' must be a regular non-symlink file.`, {
      code: 'FOS_INPUT_TYPE_INVALID'
    }
  );
  const resolved = await realpath(absolute);
  const rootResolved = await realpath(root);
  const resolvedRelative = path.relative(rootResolved, resolved);
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
    throw new SingularityFlowError(`FOS input path '${selected.path}' resolves outside the repository.`, {
      code: 'FOS_INPUT_PATH_INVALID'
    });
  }
  const bytes = await readFile(absolute);
  if (readBoundaryHook) await readBoundaryHook(Object.freeze({
    path: selected.path, source: selected.source, byteLength: bytes.length, sha256: digest(bytes)
  }));
  const after = await lstat(absolute);
  for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
    if (before[field] !== after[field]) throw new SingularityFlowError(
      `Required FOS input '${selected.path}' changed while its bytes were being sealed.`, {
        code: 'FOS_INPUT_CHANGED', details: { path: selected.path, source: selected.source }
      }
    );
  }
  return Object.freeze({
    path: selected.path,
    source: 'worktree',
    byteLength: bytes.length,
    sha256: digest(bytes),
    gitMode: before.mode & 0o111 ? '100755' : '100644',
    objectOid: null
  });
}

function indexEntry(root, relative) {
  const result = run('git', ['ls-files', '--stage', '-z', '--', relative], {
    cwd: root, allowFailure: true
  });
  if (result.status !== 0) throw new SingularityFlowError(
    `Cannot inspect required index input '${relative}'.`, { code: 'FOS_INPUT_UNAVAILABLE' }
  );
  const rows = result.stdout.split('\0').filter(Boolean);
  if (rows.length !== 1) throw new SingularityFlowError(
    rows.length === 0
      ? `Required FOS input '${relative}' is missing from the index.`
      : `Required FOS input '${relative}' has unresolved index stages.`, {
      code: rows.length === 0 ? 'FOS_INPUT_MISSING' : 'FOS_INPUT_CONFLICT',
      details: { path: relative, source: 'index' }
    }
  );
  const match = /^(100(?:644|755)) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/u.exec(rows[0]);
  if (!match || match[3] !== relative || !OID.test(match[2])) throw new SingularityFlowError(
    `Required index input '${relative}' has an invalid Git identity.`, { code: 'FOS_INPUT_UNAVAILABLE' }
  );
  return { gitMode: match[1], objectOid: match[2] };
}

async function indexInput(root, selected, objects) {
  const entry = indexEntry(root, selected.path);
  const object = await objects.read(entry.objectOid);
  if (!object || object.type !== 'blob' || object.oid !== entry.objectOid) throw new SingularityFlowError(
    `Required index input '${selected.path}' could not be read as its exact Git blob.`, {
      code: 'FOS_INPUT_UNAVAILABLE'
    }
  );
  return Object.freeze({
    path: selected.path,
    source: 'index',
    byteLength: object.bytes.length,
    sha256: digest(object.bytes),
    gitMode: entry.gitMode,
    objectOid: entry.objectOid
  });
}

function sealBody(repository, inputs) {
  return { repository, inputs };
}

function validate(record) {
  const valid = record?.kind === 'fos-sealed-input'
    && record?.observation?.classification === 'observational'
    && typeof record?.repository?.repositoryInstanceId === 'string'
    && typeof record?.repository?.worktreeInstanceId === 'string'
    && Array.isArray(record?.inputs) && record.inputs.length > 0
    && record.inputs.every((input) => typeof input.path === 'string'
      && ['worktree', 'index'].includes(input.source)
      && Number.isSafeInteger(input.byteLength) && input.byteLength >= 0
      && SHA256.test(input.sha256)
      && /^100(?:644|755)$/.test(input.gitMode)
      && (input.source === 'worktree' ? input.objectOid == null : OID.test(input.objectOid ?? '')))
    && SHA256.test(record?.sealedInputSha256)
    && record.sealedInputSha256 === `sha256:${recordSha256(sealBody(record.repository, record.inputs))}`;
  if (!valid) throw new SingularityFlowError(
    'The FOS sealed-input record is incomplete or has an invalid byte identity.', {
      code: 'FOS_SEALED_INPUT_INVALID'
    }
  );
  return Object.freeze(record);
}

/** Seal explicitly selected worktree or index bytes; status metadata is retained as observation only. */
export async function sealFosInputs(root, values, { context = null, readBoundaryHook = null } = {}) {
  const selected = [...new Map((values ?? []).map((value) => {
    const item = selection(value);
    return [`${item.source}:${item.path}`, item];
  })).values()].sort((left, right) => `${left.source}:${left.path}`.localeCompare(`${right.source}:${right.path}`));
  if (selected.length === 0 || selected.length > 4096) throw new SingularityFlowError(
    'FOS input sealing requires between 1 and 4096 explicit paths.', { code: 'FOS_INPUT_SET_INVALID' }
  );
  const repositoryContext = context ?? createRepoContext(root, { cache: false });
  const observation = await repositoryContext.statusObservation();
  const identity = await repositoryContext.identity();
  const objects = new FosGitObjectService(root, { idleMs: 60_000 });
  try {
    const inputs = [];
    for (const item of selected) inputs.push(item.source === 'index'
      ? await indexInput(root, item, objects)
      : await worktreeInput(root, item, readBoundaryHook));
    const repository = {
      repositoryInstanceId: identity.repositoryInstanceId,
      worktreeInstanceId: identity.worktreeInstanceId,
      objectFormat: identity.objectFormat
    };
    const record = {
      schemaVersion: currentSchemaVersion('fos-sealed-input'),
      kind: 'fos-sealed-input',
      repository,
      observation,
      inputs,
      sealedInputSha256: `sha256:${recordSha256(sealBody(repository, inputs))}`
    };
    return validate(record);
  } finally {
    await objects.close();
  }
}

export function readFosSealedInputs(raw) {
  return validate(readRecord('fos-sealed-input', raw).record);
}

/** Re-read the same sources and prove their exact bytes still match the sealed authorization input. */
export async function verifyFosSealedInputs(root, raw) {
  const expected = typeof raw === 'string' || Buffer.isBuffer(raw) || raw instanceof Uint8Array
    ? readFosSealedInputs(raw) : validate(structuredClone(raw));
  const actual = await sealFosInputs(root, expected.inputs.map(({ path: inputPath, source }) => ({
    path: inputPath, source
  })));
  if (actual.sealedInputSha256 !== expected.sealedInputSha256) throw new SingularityFlowError(
    'Required FOS input bytes changed after they were sealed; prepare a fresh operation.', {
      code: 'FOS_INPUT_CHANGED',
      details: {
        expected: expected.sealedInputSha256,
        actual: actual.sealedInputSha256
      }
    }
  );
  return Object.freeze({ valid: true, sealedInputSha256: actual.sealedInputSha256 });
}
