import path from 'node:path';

import { compareText, sha256 } from '../../canonicalize.mjs';
import { contractFailure } from '../../contracts.mjs';
import { scopedSnapshotFiles } from '../../scope/matcher.mjs';
import { validateScopeManifest } from '../../scope/manifest.mjs';
import { readExactSourceFile, validateSourceSnapshot } from '../../source/snapshot.mjs';
import { WMB_V4_KERNEL_SOURCE_SHA256 } from '../../source-digest.mjs';

export const JAVASCRIPT_LIKE = Object.freeze(new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']));
export const SOURCE_LIKE = Object.freeze(new Set([
  ...JAVASCRIPT_LIKE, '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.swift'
]));

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.cjs': 'javascript',
  '.go': 'go', '.h': 'c', '.hpp': 'cpp', '.java': 'java', '.js': 'javascript',
  '.jsx': 'javascript', '.kt': 'kotlin', '.kts': 'kotlin', '.mjs': 'javascript',
  '.php': 'php', '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.swift': 'swift',
  '.ts': 'typescript', '.tsx': 'typescript'
});

export function implementationSha256(id, version, algorithm) {
  return sha256({
    kind: 'world-model-extractor-implementation', id, version, algorithm,
    sourceSha256: WMB_V4_KERNEL_SOURCE_SHA256
  });
}

export function adapterFiles(context) {
  if (Array.isArray(context.adapterFileCache)) return context.adapterFileCache;
  validateSourceSnapshot(context.sourceSnapshot);
  validateScopeManifest(context.scopeManifest);
  const files = scopedSnapshotFiles(context.sourceSnapshot, context.scopeManifest)
    .filter((file) => file.type === 'regular')
    .sort((left, right) => compareText(left.path, right.path));
  context.adapterFileCache = Object.freeze(files);
  return context.adapterFileCache;
}

export function languageForPath(relative) {
  return LANGUAGE_BY_EXTENSION[path.posix.extname(relative).toLowerCase()] ?? null;
}

export function exactText(context, file) {
  const cached = context.sourceTextCache?.get(file.path);
  if (cached === null) {
    contractFailure(`Pinned source '${file.path}' is not valid UTF-8.`, 'WMB_EXTRACTION_UNAVAILABLE', { path: file.path });
  }
  if (typeof cached === 'string') return cached;
  const bytes = readExactSourceFile(context.root, context.sourceSnapshot, file.path);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    context.sourceTextCache?.set(file.path, text);
    return text;
  } catch {
    context.sourceTextCache?.set(file.path, null);
    contractFailure(`Pinned source '${file.path}' is not valid UTF-8.`, 'WMB_EXTRACTION_UNAVAILABLE', { path: file.path });
  }
}

export function evidenceDescriptor(file, { kind = 'file', locator = {}, subject } = {}) {
  const canonicalSubject = subject ?? { kind: 'file', id: file.path };
  return {
    kind,
    locator: { path: file.path, ...locator },
    subjectSha256: sha256(canonicalSubject),
    sourceContentSha256: file.contentSha256,
    scope: { status: 'inside' }
  };
}

export function factDraft({ factType, subject, claim, status = 'available', assurance,
  evidence = [], conflictsWith = [], scopeStatus = 'inside', reason = null }) {
  const value = { factType, subject, claim, status, assurance, evidence, conflictsWith, scopeStatus };
  if (reason) value.reason = reason;
  return value;
}

export function unavailableDraft({ factType, subject, attemptedProducer, code, detail, evidence = [] }) {
  return factDraft({
    factType,
    subject,
    claim: null,
    status: 'unavailable',
    assurance: 'not-applicable',
    evidence,
    reason: { code, detail, attemptedProducer }
  });
}

export function result(producerId, observations, facts) {
  return { producerId, observations, facts };
}
