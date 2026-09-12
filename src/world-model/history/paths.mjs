import path from 'node:path';

import { assertSha256, contractFailure } from '../contracts.mjs';
import { deepFreeze } from '../canonicalize.mjs';

export const DEFAULT_WORLD_MODEL_OUTPUT_DIR = 'singularity/world-model';
export const DEFAULT_WORLD_MODEL_HISTORY_DIR = 'singularity/world-model-history';
export const WMP_HISTORY_MODELS_DIR = 'models';
export const WMP_HISTORY_VIEWS_DIR = 'views';
export const WMP_HISTORY_OBJECTS_DIR = 'objects/sha256';
export const WMP_HISTORY_HANDOFFS_DIR = 'handoffs';

const PORTABLE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const PORTABLE_SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAXIMUM_ROOT_BYTES = 1024;

function fail(message, code = 'WMP_HISTORY_PATH_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function normalizeStorageRoot(value, label) {
  if (typeof value !== 'string' || !value.length || value !== value.trim()) {
    fail(`${label} must be a non-empty repository-relative path.`);
  }
  if (Buffer.byteLength(value, 'utf8') > MAXIMUM_ROOT_BYTES) {
    fail(`${label} exceeds its ${MAXIMUM_ROOT_BYTES}-byte limit.`, 'WMP_CONTRACT_LIMIT');
  }
  if (value.includes('\\') || /[\0\r\n]/.test(value) || path.posix.isAbsolute(value)
      || /^[A-Za-z]:/.test(value) || value.startsWith('//') || value.endsWith('/')) {
    fail(`${label} must be a canonical portable Git-relative path.`,
      'WMP_HISTORY_PATH_INVALID', { value });
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..'
      || segment.endsWith('.') || WINDOWS_RESERVED_SEGMENT.test(segment)
      || segment.toLowerCase() === '.git' || !PORTABLE_SEGMENT.test(segment))) {
    fail(`${label} contains an unsafe or non-portable segment.`,
      'WMP_HISTORY_PATH_INVALID', { value });
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) {
    fail(`${label} is not canonical.`, 'WMP_HISTORY_PATH_INVALID', { value, normalized });
  }
  return normalized;
}

function isSameOrAncestor(left, right) {
  return left === right || right.startsWith(`${left}/`);
}

/** One owner for the compatible current projection and immutable history roots. */
export function validateWorldModelHistoryRoots({
  outputDir = DEFAULT_WORLD_MODEL_OUTPUT_DIR,
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR
} = {}) {
  const output = normalizeStorageRoot(outputDir, 'World-model outputDir');
  const history = normalizeStorageRoot(historyDir, 'World-model historyDir');
  const foldedOutput = output.toLowerCase();
  const foldedHistory = history.toLowerCase();
  if (isSameOrAncestor(foldedOutput, foldedHistory)
      || isSameOrAncestor(foldedHistory, foldedOutput)) {
    fail(
      'World-model current projection and immutable history roots must be disjoint and cannot differ only by case.',
      'WMP_HISTORY_ROOT_OVERLAP', { outputDir: output, historyDir: history }
    );
  }
  return deepFreeze({ outputDir: output, historyDir: history });
}

/** Compatibility spelling used by contract-only callers. */
export function validateWorldModelHistoryLayout({
  projectionRoot = DEFAULT_WORLD_MODEL_OUTPUT_DIR,
  historyRoot = DEFAULT_WORLD_MODEL_HISTORY_DIR
} = {}) {
  const roots = validateWorldModelHistoryRoots({
    outputDir: projectionRoot, historyDir: historyRoot
  });
  return deepFreeze({ projectionRoot: roots.outputDir, historyRoot: roots.historyDir });
}

function digestHex(value, label) {
  assertSha256(value, label);
  return value.slice('sha256:'.length);
}

function checkedHistoryDir(historyDir) {
  // Key-path helpers do not know the caller's configured projection root. Revalidating against
  // the default outputDir here rejected valid custom root pairs (for example a custom current
  // projection with history at the default current path). Root overlap is checked once by the
  // publication/read boundary; this helper owns only portable history-path syntax.
  return normalizeStorageRoot(historyDir, 'World-model historyDir');
}

export function worldModelHistoryModelPath(modelKey, {
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR
} = {}) {
  return path.posix.join(
    checkedHistoryDir(historyDir), WMP_HISTORY_MODELS_DIR,
    `${digestHex(modelKey, 'WMP model key')}.json`
  );
}

export function worldModelHistoryViewPath(viewKey, {
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR
} = {}) {
  return path.posix.join(
    checkedHistoryDir(historyDir), WMP_HISTORY_VIEWS_DIR,
    `${digestHex(viewKey, 'WMP view key')}.json`
  );
}

export function worldModelHistoryObjectPath(objectSha256, {
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR
} = {}) {
  const hex = digestHex(objectSha256, 'WMP object digest');
  return path.posix.join(
    checkedHistoryDir(historyDir), WMP_HISTORY_OBJECTS_DIR, hex.slice(0, 2), hex
  );
}

export function worldModelHistoryHandoffPath(handoffSha256, {
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR
} = {}) {
  return path.posix.join(
    checkedHistoryDir(historyDir), WMP_HISTORY_HANDOFFS_DIR,
    `${digestHex(handoffSha256, 'WMP handoff digest')}.json`
  );
}

export function worldModelGroundingReferencePath(workId, groundingSha256, {
  workItemRoot = 'singularity/work-items'
} = {}) {
  const root = normalizeStorageRoot(workItemRoot, 'WMP work-item root');
  if (typeof workId !== 'string' || !PORTABLE_SUBJECT.test(workId)) {
    fail('WMP grounding Work ID must be a portable identifier.', 'WMP_HISTORY_PATH_INVALID');
  }
  return path.posix.join(
    root, workId, 'context/grounding/wmp',
    `${digestHex(groundingSha256, 'WMP grounding digest')}.json`
  );
}

export function worldModelSourceAdoptionPath(adoptionSha256) {
  return path.posix.join(
    '$git/world-model-source-adoptions/v1',
    `${digestHex(adoptionSha256, 'WMP source-adoption digest')}.json`
  );
}

export const modelBindingPath = worldModelHistoryModelPath;
export const viewBindingPath = worldModelHistoryViewPath;
export const objectPath = worldModelHistoryObjectPath;
export const handoffPath = worldModelHistoryHandoffPath;
