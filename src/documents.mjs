import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNoPendingPublication, saveStoryDraft, workDir, workDirRelative } from './state-stores.mjs';
import { loadSession } from './session.mjs';
import { SingularityFlowError, exists, nowIso, posix, run, snapshot, writeJson, writeText } from './util.mjs';
import { assertPhaseSequence, enforceSequenceGate } from './sequence.mjs';
import { sourceRuntime, storageAdapter } from './epic-sources.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

const DOCUMENT_MANIFEST_SCHEMA_VERSION = currentSchemaVersion('document-manifest');
export const STORY_DOCUMENT_RESOURCE_LIMITS = Object.freeze({
  maxFiles: 5000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDepth: 32
});

const TEXT_EXTENSIONS = new Set([
  '.adoc', '.c', '.cc', '.clj', '.cljs', '.cmake', '.cpp', '.cs', '.css', '.dart', '.go', '.gradle', '.graphql', '.groovy',
  '.h', '.hpp', '.html', '.ini', '.java', '.js', '.jsx', '.json', '.kt', '.kts', '.less', '.lua', '.m', '.md', '.mdx', '.mm',
  '.php', '.properties', '.py', '.r', '.rb', '.rs', '.rst', '.sass', '.scala', '.scss', '.sh', '.sql', '.svg', '.swift', '.tf',
  '.toml', '.ts', '.tsx', '.tsv', '.txt', '.vue', '.xml', '.yaml', '.yml'
]);
const MIME_TYPES = {
  '.c': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.cs': 'text/x-csharp', '.css': 'text/css', '.csv': 'text/csv',
  '.dart': 'text/x-dart', '.fig': 'application/x-figma', '.gif': 'image/gif', '.go': 'text/x-go', '.gradle': 'text/x-gradle',
  '.groovy': 'text/x-groovy', '.h': 'text/x-c', '.hpp': 'text/x-c++', '.html': 'text/html', '.java': 'text/x-java-source',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.jsx': 'text/jsx', '.json': 'application/json',
  '.kt': 'text/x-kotlin', '.kts': 'text/x-kotlin', '.lua': 'text/x-lua', '.md': 'text/markdown', '.mdx': 'text/markdown',
  '.pdf': 'application/pdf', '.php': 'text/x-php', '.png': 'image/png', '.properties': 'text/plain', '.py': 'text/x-python',
  '.r': 'text/x-r', '.rb': 'text/x-ruby', '.rs': 'text/x-rust', '.scala': 'text/x-scala', '.scss': 'text/x-scss',
  '.sh': 'text/x-shellscript', '.sql': 'text/x-sql', '.svg': 'image/svg+xml', '.swift': 'text/x-swift', '.tf': 'text/x-terraform',
  '.ts': 'text/typescript', '.tsx': 'text/tsx', '.txt': 'text/plain', '.vue': 'text/x-vue', '.webp': 'image/webp',
  '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml'
};
const INLINE_PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export function createStoryDocumentBudget({
  maxFiles = STORY_DOCUMENT_RESOURCE_LIMITS.maxFiles,
  maxTotalBytes = STORY_DOCUMENT_RESOURCE_LIMITS.maxTotalBytes,
  maxDepth = STORY_DOCUMENT_RESOURCE_LIMITS.maxDepth
} = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1
      || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1
      || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new SingularityFlowError(
      'Story document aggregate limits must use positive safe integers and a non-negative depth.',
      { code: 'STORY_DOCUMENT_LIMIT_INVALID' }
    );
  }
  return { maxFiles, maxTotalBytes, maxDepth, files: 0, totalBytes: 0 };
}

export function admitStoryDocumentResource(budget, {
  depth = 0, size = null, label = 'document input'
} = {}) {
  if (!budget || !Number.isSafeInteger(depth) || depth < 0
      || (size != null && (!Number.isSafeInteger(size) || size < 0))) {
    throw new SingularityFlowError('Story document resource metadata is invalid.', {
      code: 'STORY_DOCUMENT_LIMIT_INVALID'
    });
  }
  if (depth > budget.maxDepth) {
    throw new SingularityFlowError(
      `Story document input exceeds the ${budget.maxDepth}-level directory depth limit: ${label}`,
      {
        code: 'STORY_DOCUMENT_LIMIT_EXCEEDED',
        details: { limit: 'maxDepth', maximum: budget.maxDepth, observed: depth }
      }
    );
  }
  if (size == null) return budget;
  if (budget.files + 1 > budget.maxFiles) {
    throw new SingularityFlowError(
      `Story document input exceeds the ${budget.maxFiles}-file aggregate limit: ${label}`,
      {
        code: 'STORY_DOCUMENT_LIMIT_EXCEEDED',
        details: { limit: 'maxFiles', maximum: budget.maxFiles, observed: budget.files + 1 }
      }
    );
  }
  if (budget.totalBytes + size > budget.maxTotalBytes) {
    throw new SingularityFlowError(
      `Story document input exceeds the ${budget.maxTotalBytes}-byte aggregate limit: ${label}`,
      {
        code: 'STORY_DOCUMENT_LIMIT_EXCEEDED',
        details: {
          limit: 'maxTotalBytes', maximum: budget.maxTotalBytes,
          observed: budget.totalBytes + size
        }
      }
    );
  }
  budget.files += 1;
  budget.totalBytes += size;
  return budget;
}

function manifestPath(root, config, workflow) { return path.join(workDir(root, config, workflow.workItem.id), 'documents.json'); }
function mimeType(file) { return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'; }
// Story intake validates and freezes local documents before it creates a governed Story commit.
// Export the same MIME resolver used by the eventual catalog write so the preflight and publication
// cannot disagree merely because two extension tables drifted apart.
export function documentMimeType(file) { return mimeType(file); }
export function validateDocumentUrl(value) {
  const candidate = String(value ?? '');
  if (!/^https?:\/\/\S+$/i.test(candidate)) {
    throw new SingularityFlowError('Document URL must use http:// or https://.');
  }
  let parsed;
  try { parsed = new URL(candidate); }
  catch {
    throw new SingularityFlowError('Document URL must be a valid http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new SingularityFlowError('Document URL must be a valid http:// or https:// URL.');
  }
  if (parsed.username || parsed.password) {
    throw new SingularityFlowError(
      'Document URL must not contain credentials. Use a credential-free reference and an approved credential helper.',
      { code: 'STORY_DOCUMENT_URL_CREDENTIALS' }
    );
  }
  // Query strings and fragments are legitimate parts of durable references (for example Figma
  // node-id and GitHub line anchors). Refuse only names that conventionally carry authentication
  // material; blanket query/fragment rejection would make normal Story intake unusable.
  const sensitiveParameter = (name) => /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|share[-_]?token|token|sig|signature|secret|password|passwd|credential|authorization|auth|api[-_]?key|apikey|awsaccesskeyid|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-credential|x-goog-signature)$/iu.test(name);
  const unsafeQueryKey = [...parsed.searchParams.keys()].find(sensitiveParameter);
  const fragmentParameters = parsed.hash.includes('=')
    ? new URLSearchParams(parsed.hash.replace(/^#/u, '')) : null;
  const unsafeFragmentKey = fragmentParameters
    ? [...fragmentParameters.keys()].find(sensitiveParameter) : null;
  if (unsafeQueryKey || unsafeFragmentKey) {
    throw new SingularityFlowError(
      `Document URL must not contain credential parameter '${unsafeQueryKey ?? unsafeFragmentKey}'. Use a stable credential-free reference.`,
      { code: 'STORY_DOCUMENT_URL_CREDENTIALS' }
    );
  }
  return candidate;
}
function safeName(value) {
  let candidate = path.basename(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  candidate = candidate.replace(/[. ]+$/gu, '') || 'document';
  // Git treats a component named `.git` specially on every platform. Windows additionally refuses
  // DOS device names even when they carry an extension. Preserve human-recognizable source paths,
  // but make those reserved components ordinary portable directory/file names.
  if (candidate.toLowerCase() === '.git'
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(candidate)) {
    candidate = `document-${candidate.replace(/^\.+/u, '') || 'file'}`;
  }
  return candidate;
}
function nextId(records) { return `DOC-${String(Math.max(0, ...records.map((item) => Number(item.id?.match(/^DOC-(\d+)$/)?.[1] ?? 0))) + 1).padStart(3, '0')}`; }
function nextPackageId(records) { return `PKG-${String(Math.max(0, ...records.map((item) => Number(item.id?.match(/^PKG-(\d+)$/)?.[1] ?? 0))) + 1).padStart(3, '0')}`; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

async function directoryFiles(
  source, packageName, relativeParts = [], packageSource = source,
  budget = createStoryDocumentBudget(), depth = 0
) {
  admitStoryDocumentResource(budget, { depth, label: source });
  const files = [];
  const entries = (await readdir(source, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(source, entry.name); const parts = [...relativeParts, entry.name];
    if (entry.isSymbolicLink()) throw new SingularityFlowError(`Document directories cannot contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) {
      files.push(...await directoryFiles(
        absolute, packageName, parts, packageSource, budget, depth + 1
      ));
    } else if (entry.isFile()) {
      const info = await stat(absolute);
      admitStoryDocumentResource(budget, {
        depth: depth + 1, size: info.size, label: absolute
      });
      files.push({ source: absolute, info, packageName, packageSource, sourceRelativePath: posix(parts.join('/')) });
    }
  }
  return files;
}

function frozenEvidenceMap(records) {
  if (!Array.isArray(records)) {
    throw new SingularityFlowError('Frozen Story document evidence is malformed.', {
      code: 'STORY_DOCUMENT_CAPTURE_INVALID'
    });
  }
  const result = new Map();
  for (const record of records) {
    const source = typeof record?.captured === 'string' ? path.resolve(record.captured) : null;
    if (!source || !Number.isInteger(record?.size) || record.size < 0
        || !/^[a-f0-9]{64}$/u.test(record?.sha256 ?? '')
        || typeof record?.mimeType !== 'string' || result.has(source)) {
      throw new SingularityFlowError('Frozen Story document evidence is malformed.', {
        code: 'STORY_DOCUMENT_CAPTURE_INVALID'
      });
    }
    result.set(source, record);
  }
  return result;
}

async function readFrozenDocument(source, expected) {
  let handle;
  try {
    const before = await lstat(source, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('not a regular file');
    handle = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs
        || opened.ctimeNs !== before.ctimeNs) throw new Error('identity changed before read');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
        || bytes.byteLength !== expected.size || sha256 !== expected.sha256
        || documentMimeType(source) !== expected.mimeType) {
      throw new Error('captured bytes changed');
    }
    return { bytes, size: bytes.byteLength, sha256 };
  } catch (error) {
    throw new SingularityFlowError(
      `Story document capture changed before publication: ${source}`,
      { code: 'STORY_DOCUMENT_CHANGED', cause: error }
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertDocumentPathTrackable(root, relative) {
  const ignored = run('git', ['check-ignore', '--quiet', '--no-index', '--', relative], {
    cwd: root, allowFailure: true
  });
  if (ignored.status === 0) {
    throw new SingularityFlowError(
      `Governed document path is excluded by Git ignore policy: ${relative}. `
      + 'Allow singularity/work-items document inputs in the repository ignore policy, then retry.',
      { code: 'STORY_DOCUMENT_GIT_IGNORED' }
    );
  }
  if (ignored.status !== 1) {
    throw new SingularityFlowError(
      `Git could not verify that governed document path will be published: ${relative}.`,
      { code: 'STORY_DOCUMENT_GIT_UNVERIFIED' }
    );
  }
}

async function loadManifest(root, config, workflow) {
  const file = manifestPath(root, config, workflow);
  const manifest = await exists(file)
    ? readRecord('document-manifest', await readFile(file)).record
    : { schemaVersion: DOCUMENT_MANIFEST_SCHEMA_VERSION, workId: workflow.workItem.id, documents: [], packages: [] };
  manifest.packages ??= [];
  return manifest;
}

export function evidenceIsActive(record) {
  // Detachment is the only catalog status that removes a document from active
  // composition and browsing. Lifecycle artifacts reuse this catalog but carry
  // phase statuses such as `in_progress`, `awaiting_approval`, and `approved`.
  // Treating the evidence vocabulary as an allowlist silently hid every generated
  // phase artifact from editor snapshots while leaving the status-less system
  // documents visible.
  return record?.status !== 'detached';
}

async function contextJsonFiles(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await contextJsonFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(absolute);
  }
  return files.sort();
}

async function storyEvidenceDependencies(root, config, workflow, targets) {
  const needles = new Set(targets.flatMap((record) => [record.id, record.sha256, record.path, record.url].filter(Boolean)));
  const itemRoot = workDir(root, config, workflow.workItem.id);
  const phases = new Set();
  const records = [];
  for (const file of await contextJsonFiles(path.join(itemRoot, 'context'))) {
    let parsed;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
    const serialized = JSON.stringify(parsed);
    if (![...needles].some((needle) => serialized.includes(needle))) continue;
    if (parsed.phase && workflow.phases?.[parsed.phase]) phases.add(parsed.phase);
    parsed.stale = true;
    parsed.staleReason = `Supporting evidence detached: ${targets.map((item) => item.id).join(', ')}`;
    parsed.staleAt = nowIso();
    await writeJson(file, parsed);
    records.push(posix(path.relative(root, file)));
  }
  return { phases: [...phases], records };
}

function storyCone(workflow, phases) {
  const indexes = phases.map((phaseId) => workflow.phaseOrder.indexOf(phaseId)).filter((index) => index >= 0);
  if (!indexes.length) return { affectedPhases: [], reopenedPhase: null, earliest: -1 };
  const earliest = Math.min(...indexes);
  const affectedPhases = workflow.phaseOrder.slice(earliest);
  return { affectedPhases, reopenedPhase: workflow.phaseOrder[earliest], earliest };
}

function invalidateStoryCone(workflow, cone, decisionSha256, timestamp) {
  if (cone.earliest < 0) return cone;
  const { earliest, affectedPhases, reopenedPhase } = cone;
  for (let index = earliest; index < workflow.phaseOrder.length; index += 1) {
    const phase = workflow.phases[workflow.phaseOrder[index]];
    for (const approval of phase.approvals ?? []) if (!approval.invalidatedAt) {
      approval.invalidatedAt = timestamp;
      approval.invalidationReason = 'supporting-evidence-detached';
      approval.invalidatedBy = decisionSha256;
    }
    phase.status = index === earliest ? 'in_progress' : 'not_started';
    phase.submittedAt = null;
    phase.approvedAt = null;
    phase.approvedBy = null;
    phase.invalidatedAt = timestamp;
    phase.invalidatedBy = decisionSha256;
  }
  workflow.currentPhase = reopenedPhase;
  workflow.status = 'in_progress';
  return { affectedPhases, reopenedPhase };
}

/**
 * Detach supporting evidence without deleting its committed bytes. The caller runs this inside
 * commitAndPublish.beforeStateWrite so manifest, state, projections, decision, commit, and push are
 * one publication transaction.
 */
export async function detachDocuments(root, config, workflow, {
  documentId, scope = 'file', reason
} = {}) {
  const comment = String(reason ?? '').trim();
  if (!comment) throw new SingularityFlowError('A detachment reason is required.');
  if (!['file', 'package'].includes(scope)) throw new SingularityFlowError("Document detach --scope must be 'file' or 'package'.");
  const manifest = await loadManifest(root, config, workflow);
  const selected = manifest.documents.find((record) => record.id === documentId);
  if (!selected) throw new SingularityFlowError(`Supporting document '${documentId}' was not found.`);
  if (!evidenceIsActive(selected)) throw new SingularityFlowError(`Supporting document '${documentId}' is already detached.`);
  if (scope === 'package' && !selected.packageId) throw new SingularityFlowError(`Document '${documentId}' is not a Figma or directory package member.`);
  const targets = scope === 'package'
    ? manifest.documents.filter((record) => record.packageId === selected.packageId && evidenceIsActive(record))
    : [selected];
  const session = await loadSession(root);
  const timestamp = nowIso();
  const dependencies = await storyEvidenceDependencies(root, config, workflow, targets);
  const cone = storyCone(workflow, dependencies.phases);
  const decisionBase = {
    schemaVersion: currentSchemaVersion('evidence-detachment-decision'),
    type: 'evidence-detachment',
    subject: { kind: 'story', id: workflow.workItem.id },
    target: { documentId: selected.id, packageId: selected.packageId ?? null, scope },
    documents: targets.map((record) => ({ id: record.id, sha256: record.sha256 ?? null, path: record.path ?? null, url: record.url ?? null })),
    reason: comment,
    actor: session.actor,
    agent: session.agent ?? null,
    at: timestamp,
    previousHash: selected.sha256 ?? createHash('sha256').update(String(selected.url ?? '')).digest('hex'),
    dependentContextRecords: dependencies.records,
    affectedPhases: cone.affectedPhases,
    reopenedPhase: cone.reopenedPhase
  };
  const decisionSha256 = createHash('sha256').update(JSON.stringify(decisionBase)).digest('hex');
  decisionBase.sha256 = decisionSha256;
  const invalidation = invalidateStoryCone(workflow, cone, decisionSha256, timestamp);
  for (const record of targets) Object.assign(record, {
    status: 'detached', detachedAt: timestamp, detachDecisionSha256: decisionSha256,
    detachedBy: session.actor, detachReason: comment
  });
  if (selected.packageId) {
    const packageRecord = manifest.packages.find((record) => record.id === selected.packageId);
    if (packageRecord && manifest.documents.filter((record) => record.packageId === selected.packageId).every((record) => !evidenceIsActive(record))) {
      Object.assign(packageRecord, { status: 'detached', detachedAt: timestamp, detachDecisionSha256: decisionSha256 });
    }
  }
  const decisionFile = path.join(workDir(root, config, workflow.workItem.id), 'evidence', 'detachments', `${decisionSha256}.json`);
  await writeJson(decisionFile, decisionBase);
  manifest.updatedAt = timestamp;
  await writeJson(manifestPath(root, config, workflow), manifest);
  workflow.documents = {
    count: manifest.documents.filter(evidenceIsActive).length,
    totalCount: manifest.documents.length,
    updatedAt: timestamp
  };
  workflow.history.push({
    at: timestamp,
    actor: session.actor.login ?? session.actor.email ?? session.actor.name,
    agent: session.agent,
    event: 'evidence_detached',
    phase: invalidation.reopenedPhase ?? workflow.currentPhase,
    detail: `${targets.map((item) => item.id).join(', ')} detached: ${comment}`
  });
  return {
    decision: decisionBase,
    decisionPath: posix(path.relative(root, decisionFile)),
    targets,
    affectedPhases: invalidation.affectedPhases,
    reopenedPhase: invalidation.reopenedPhase
  };
}

async function writePackageIndexes(root, config, workflow, manifest, packageRecord) {
  const records = manifest.documents.filter((item) => item.packageId === packageRecord.id);
  const extensions = {}; const hashes = new Map(); let totalBytes = 0;
  for (const record of records) {
    const extension = path.extname(record.sourceRelativePath ?? record.sourceName).toLowerCase() || '(none)';
    extensions[extension] = (extensions[extension] ?? 0) + 1; totalBytes += record.size ?? 0;
    const group = hashes.get(record.sha256) ?? []; group.push(record.id); hashes.set(record.sha256, group);
  }
  const duplicates = [...hashes.entries()].filter(([, ids]) => ids.length > 1).map(([sha256, ids]) => ({ sha256, documents: ids }));
  const documentPackageDirectory = path.join(workDir(root, config, workflow.workItem.id), 'inputs', 'packages', packageRecord.id);
  const packageRelative = posix(path.relative(root, documentPackageDirectory)); await mkdir(documentPackageDirectory, { recursive: true });
  const audit = { schemaVersion: currentSchemaVersion('document-package-manifest'), id: packageRecord.id, name: packageRecord.name, importedAt: packageRecord.importedAt, fileCount: records.length, totalBytes, extensions, emptyFiles: records.filter((item) => item.size === 0).map((item) => item.id), duplicates, files: records.map(({ id, label, sourceRelativePath, path: filePath, mimeType: type, size, sha256 }) => ({ id, label, sourceRelativePath, path: filePath, mimeType: type, size, sha256 })) };
  await writeJson(path.join(documentPackageDirectory, 'manifest.json'), audit);
  const inventory = [`# Design package ${packageRecord.id} — ${packageRecord.name}`, '', `- Files: **${records.length}**`, `- Bytes: **${totalBytes}**`, `- Empty files: **${audit.emptyFiles.length}**`, `- Duplicate groups: **${duplicates.length}**`, '', '| ID | Relative source path | Type | Bytes | SHA-256 |', '|---|---|---|---:|---|', ...records.map((item) => `| ${item.id} | ${item.sourceRelativePath} | ${item.mimeType} | ${item.size} | \`${item.sha256}\` |`), '', '## File types', '', ...Object.entries(extensions).sort().map(([extension, count]) => `- ${extension}: ${count}`), ''];
  await writeText(path.join(documentPackageDirectory, 'inventory.md'), `${inventory.join('\n')}\n`);
  const images = records.filter((item) => item.mimeType?.startsWith('image/'));
  const cards = images.map((item) => { const relative = posix(path.relative(documentPackageDirectory, path.join(root, item.path))); return `<figure><img loading="lazy" src="${escapeHtml(relative)}" alt="${escapeHtml(item.label)}"><figcaption><strong>${escapeHtml(item.sourceRelativePath)}</strong><small>${escapeHtml(item.id)} · ${escapeHtml(item.sha256.slice(0, 12))}</small></figcaption></figure>`; }).join('');
  const gallery = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(packageRecord.name)} gallery</title><style>body{font:16px/1.5 Inter,system-ui,sans-serif;margin:32px;background:#f5f7f5;color:#17251d}h1{color:#16472b}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}figure{margin:0;background:#fff;border:1px solid #d7dfda;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px #183f2a12}img{display:block;width:100%;height:260px;object-fit:contain;background:#eef2ef}figcaption{display:flex;flex-direction:column;padding:14px}small{color:#68756d}</style></head><body><h1>${escapeHtml(packageRecord.name)}</h1><p>${images.length} image preview(s) from ${records.length} files. Open source files at original resolution.</p><div class="grid">${cards || '<p>No image files were detected.</p>'}</div></body></html>`;
  await writeText(path.join(documentPackageDirectory, 'gallery.html'), gallery);
  Object.assign(packageRecord, { fileCount: records.length, totalBytes, manifestPath: `${packageRelative}/manifest.json`, inventoryPath: `${packageRelative}/inventory.md`, galleryPath: `${packageRelative}/gallery.html`, imageCount: images.length, duplicateGroups: duplicates.length, emptyFiles: audit.emptyFiles.length });
}

function documentPolicy(workflow, config) {
  return workflow.resolution?.documents ?? config.documents ?? { allowedPhases: ['intake'], maxFileBytes: 26214400, maxPreviewBytes: 1048576 };
}

function assertCapabilityMime(workflow, type, label) {
  const policy = workflow.resolution?.capability?.policy;
  if (!policy || !Object.hasOwn(policy, 'allowedMimeTypes')) return;
  if (!policy.allowedMimeTypes.includes(type)) {
    throw new SingularityFlowError(`Capability '${workflow.resolution.capability.id}' does not allow MIME type '${type}' for ${label}.`);
  }
}

async function governedDocumentPath(root, config, workflow, record) {
  if (!record.path) throw new SingularityFlowError(`Document '${record.id}' has no repository path.`);
  const itemRoot = path.resolve(workDir(root, config, workflow.workItem.id));
  const absolute = path.resolve(root, record.path);
  const relative = path.relative(itemRoot, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SingularityFlowError(`Document '${record.id}' is outside work item ${workflow.workItem.id}.`);
  }
  const fileInfo = await lstat(absolute).catch(() => null);
  if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`Document '${record.id}' is not a regular governed file.`);
  }
  const [realItemRoot, realDocument] = await Promise.all([realpath(itemRoot), realpath(absolute)]);
  const realRelative = path.relative(realItemRoot, realDocument);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new SingularityFlowError(`Document '${record.id}' resolves outside work item ${workflow.workItem.id}.`);
  }
  return absolute;
}

export async function addDocuments(root, config, workflow, {
  files = [], url = null, label = null, kind = null, frozenEvidence = null
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'upload documents');
  const phase = await assertPhaseSequence(root, workflow, 'upload documents');
  const policy = documentPolicy(workflow, config); const allowed = policy.allowedPhases ?? ['intake'];
  if (!allowed.includes(phase.id)) await enforceSequenceGate(root, workflow, 'documentPhase', 'upload documents', {
    requestedPhase: phase.id,
    reason: `Documents may be uploaded only during: ${allowed.join(', ')}. Current phase is '${phase.id}'.`
  });
  if (!files.length && !url) throw new SingularityFlowError('Provide one or more files or --url <https-url>.');
  const verifiedUrl = url ? validateDocumentUrl(url) : null;
  const resourceBudget = createStoryDocumentBudget();
  if (verifiedUrl) admitStoryDocumentResource(resourceBudget, {
    depth: 0, size: 0, label: 'URL reference'
  });
  const fileInputs = [];
  for (const candidate of files) {
    const source = path.resolve(candidate); const info = await stat(source).catch(() => null);
    if (info?.isFile()) {
      admitStoryDocumentResource(resourceBudget, { depth: 0, size: info.size, label: source });
      fileInputs.push({ source, info, packageName: null, packageSource: null, sourceRelativePath: null });
    }
    else if (info?.isDirectory()) {
      const expanded = await directoryFiles(
        source, safeName(source), [], source, resourceBudget, 0
      );
      if (!expanded.length) throw new SingularityFlowError(`Document directory contains no regular files: ${candidate}`);
      fileInputs.push(...expanded);
    } else throw new SingularityFlowError(`Document path is not a regular file or directory: ${candidate}`);
  }
  const frozenBySource = frozenEvidence == null ? null : frozenEvidenceMap(frozenEvidence);
  if (frozenBySource) {
    const capturedSources = fileInputs.map((input) => path.resolve(input.source));
    if (capturedSources.length !== frozenBySource.size
        || capturedSources.some((source) => !frozenBySource.has(source))) {
      throw new SingularityFlowError(
        'Story document capture contents changed before publication.',
        { code: 'STORY_DOCUMENT_CHANGED' }
      );
    }
  }
  if (label && fileInputs.length + (verifiedUrl ? 1 : 0) > 1) throw new SingularityFlowError('--label can be used only when uploading one document.');
  for (const input of fileInputs) {
    if (input.info.size > (policy.maxFileBytes ?? 26214400)) throw new SingularityFlowError(`Document exceeds the ${(policy.maxFileBytes ?? 26214400)} byte limit: ${input.source}`);
    assertCapabilityMime(workflow, mimeType(input.source), input.source);
  }
  const session = await loadSession(root); if (session.workId && session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Active governed-agent session belongs to ${session.workId}; resume ${workflow.workItem.id} before uploading.`);
  const manifest = await loadManifest(root, config, workflow); const added = [];
  const packageMap = new Map();
  for (const input of fileInputs.filter((item) => item.packageSource)) if (!packageMap.has(input.packageSource)) {
    const record = { id: nextPackageId([...manifest.packages, ...packageMap.values()]), name: input.packageName, sourceName: path.basename(input.packageSource), phase: phase.id, importedAt: nowIso(), importedBy: session.actor, agent: session.agent };
    packageMap.set(input.packageSource, record); manifest.packages.push(record);
  }
  for (const { source, packageName, packageSource, sourceRelativePath } of fileInputs) {
    const id = nextId(manifest.documents); const filename = safeName(source);
    // Preserve the review-friendly package hierarchy while sanitizing every component. In
    // particular, a literal `.git` component disappears from `git add`, and DOS device names make a
    // commit produced on Linux impossible to check out on Windows.
    const preservedPath = sourceRelativePath
      ? path.posix.join(packageName, ...sourceRelativePath.split('/').map(safeName))
      : filename;
    const relative = path.posix.join(
      workDirRelative(config, workflow.workItem.id), 'inputs', id, preservedPath
    );
    assertDocumentPathTrackable(root, relative);
    const expected = frozenBySource?.get(path.resolve(source)) ?? null;
    const frozenSnapshot = expected ? await readFrozenDocument(source, expected) : null;
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (frozenSnapshot) {
      await writeFile(destination, frozenSnapshot.bytes, { flag: 'wx' });
    } else {
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    }
    const fileSnapshot = await snapshot(destination);
    if (frozenSnapshot && (fileSnapshot.size !== frozenSnapshot.size
        || fileSnapshot.sha256 !== frozenSnapshot.sha256)) {
      throw new SingularityFlowError(
        `Story document changed while it was being staged: ${source}`,
        { code: 'STORY_DOCUMENT_CHANGED' }
      );
    }
    const record = { id, type: 'file', label: label ?? sourceRelativePath ?? filename, kind: kind ?? (packageName ? 'directory-import' : 'reference'), sourceName: path.basename(source), path: posix(relative), mimeType: mimeType(filename), size: fileSnapshot.size, sha256: fileSnapshot.sha256, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, agent: session.agent };
    if (packageName) { record.sourcePackage = packageName; record.packageId = packageMap.get(packageSource).id; record.sourceRelativePath = sourceRelativePath; }
    manifest.documents.push(record); added.push(record);
  }
  if (verifiedUrl) {
    const id = nextId(manifest.documents); const record = { id, type: 'url', label: label ?? verifiedUrl, kind: kind ?? (/figma\.com/i.test(verifiedUrl) ? 'figma' : 'reference'), url: verifiedUrl, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, agent: session.agent };
    manifest.documents.push(record); added.push(record);
  }
  for (const packageRecord of packageMap.values()) await writePackageIndexes(root, config, workflow, manifest, packageRecord);
  manifest.updatedAt = nowIso(); await writeJson(manifestPath(root, config, workflow), manifest);
  workflow.documents = { count: manifest.documents.length, updatedAt: manifest.updatedAt };
  workflow.history.push({ at: manifest.updatedAt, actor: session.actor.login ?? session.actor.email ?? session.actor.name, agent: session.agent, event: 'documents_added', phase: phase.id, detail: added.map((item) => item.id).join(', ') });
  await saveStoryDraft(root, config, workflow); return added;
}

function resolveStorageProvider(config, providerId, workflow = null) {
  const storage = workflow?.resolution?.storage ?? config.storage;
  const selectedId = providerId ?? storage?.defaultProvider ?? null;
  const provider = storage?.providers?.[selectedId];
  if (!provider) throw new SingularityFlowError(`Unknown or unconfigured storage provider '${selectedId ?? ''}'. Declare it under storage.providers in singularity/workflow.yml.`);
  return { selectedId, provider, storage };
}

// Fetch a governed document from a configured storage provider (OneDrive/SharePoint, Artifactory,
// S3, …) and materialize its bytes into the work item, exactly like an uploaded local file. The
// bytes land in inputs/DOC-nnn/, so the document remains Git-transferable — a resumed checkout on
// another machine has the content, not just a link. The caller commits/pushes the result.
export async function fetchRemoteDocument(root, config, workflow, { providerId = null, remoteRef = null, name = null, label = null, kind = null, runtime = {} } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'fetch documents');
  const phase = await assertPhaseSequence(root, workflow, 'fetch documents');
  const policy = documentPolicy(workflow, config); const allowed = policy.allowedPhases ?? ['intake'];
  if (!allowed.includes(phase.id)) await enforceSequenceGate(root, workflow, 'documentPhase', 'fetch documents', {
    requestedPhase: phase.id,
    reason: `Documents may be added only during: ${allowed.join(', ')}. Current phase is '${phase.id}'.`
  });
  if (!remoteRef) throw new SingularityFlowError('Provide a provider item ID or path to fetch (documents fetch --ref <id>).');
  const { selectedId, provider } = resolveStorageProvider(config, providerId, workflow);
  const session = await loadSession(root);
  if (session.workId && session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Active governed-agent session belongs to ${session.workId}; resume ${workflow.workItem.id} before fetching.`);
  const adapter = storageAdapter(selectedId, provider, sourceRuntime(runtime, selectedId));
  const reference = { objectId: remoteRef, url: /^https?:\/\//i.test(remoteRef) ? remoteRef : undefined };
  let headMeta = null;
  if ((!name || !label) && typeof adapter.head === 'function') {
    try { headMeta = await adapter.head(reference); } catch { headMeta = null; }
  }
  const maxBytes = policy.maxFileBytes ?? 26214400;
  const result = await adapter.get(reference, { maxBytes });
  if (!result?.bytes) throw new SingularityFlowError(`Provider '${selectedId}' returned no bytes for '${remoteRef}'.`);
  if (result.bytes.length > maxBytes) throw new SingularityFlowError(`Fetched document exceeds the ${maxBytes} byte limit: ${remoteRef}`);
  const filename = safeName(name ?? headMeta?.name ?? label ?? String(remoteRef));
  assertCapabilityMime(workflow, result.mimeType ?? headMeta?.mimeType ?? mimeType(filename), remoteRef);
  const manifest = await loadManifest(root, config, workflow);
  const id = nextId(manifest.documents);
  const relative = path.posix.join(workDirRelative(config, workflow.workItem.id), 'inputs', id, filename);
  const destination = path.join(root, relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, result.bytes);
  const fileSnapshot = await snapshot(destination);
  const record = {
    id, type: 'file', label: label ?? headMeta?.name ?? filename, kind: kind ?? 'provider-fetch', sourceName: filename,
    path: posix(relative), mimeType: result.mimeType ?? headMeta?.mimeType ?? mimeType(filename),
    size: fileSnapshot.size, sha256: fileSnapshot.sha256, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, agent: session.agent,
    remote: { source: provider.type, providerId: selectedId, objectId: result.objectId ?? reference.objectId ?? String(remoteRef), version: result.version ?? headMeta?.version ?? null, ref: String(remoteRef) }
  };
  manifest.documents.push(record);
  manifest.updatedAt = nowIso(); await writeJson(manifestPath(root, config, workflow), manifest);
  workflow.documents = { count: manifest.documents.length, updatedAt: manifest.updatedAt };
  workflow.history.push({ at: manifest.updatedAt, actor: session.actor.login ?? session.actor.email ?? session.actor.name, agent: session.agent, event: 'documents_added', phase: phase.id, detail: `${id} ← ${provider.type}:${selectedId}` });
  await saveStoryDraft(root, config, workflow); return [record];
}

// Browse a configured storage provider so a picker can list selectable documents.
export async function listRemoteDocuments(config, { providerId = null, path: subPath = '', runtime = {}, workflow = null } = {}) {
  const { selectedId, provider } = resolveStorageProvider(config, providerId, workflow);
  const adapter = storageAdapter(selectedId, provider, sourceRuntime(runtime, selectedId));
  if (typeof adapter.list !== 'function') throw new SingularityFlowError(`Storage provider '${selectedId}' (${provider.type}) does not support browsing.`);
  return { providerId: selectedId, providerType: provider.type, entries: await adapter.list({ path: subPath }) };
}

async function systemDocument(root, config, workflow, id, label, relative) {
  const absolute = path.join(workDir(root, config, workflow.workItem.id), relative); if (!(await exists(absolute))) return null;
  const info = await snapshot(absolute); return { id, type: 'system', label, kind: 'workflow', path: posix(path.relative(root, absolute)), mimeType: mimeType(relative), size: info.size, sha256: info.sha256, phase: null };
}

export async function documentCatalog(root, config, workflow, { includeDetached = false } = {}) {
  const manifest = await loadManifest(root, config, workflow);
  const records = manifest.documents.filter((record) => includeDetached || evidenceIsActive(record));
  for (const packageRecord of manifest.packages ?? []) {
    if (!includeDetached && !evidenceIsActive(packageRecord)) continue;
    for (const [suffix, label, kind, filePath, type] of [['INVENTORY', `${packageRecord.name} inventory`, 'package-inventory', packageRecord.inventoryPath, 'text/markdown'], ['GALLERY', `${packageRecord.name} gallery`, 'package-gallery', packageRecord.galleryPath, 'text/html'], ['MANIFEST', `${packageRecord.name} manifest`, 'package-manifest', packageRecord.manifestPath, 'application/json']]) {
      if (!filePath || !(await exists(path.join(root, filePath)))) continue;
      const info = await snapshot(path.join(root, filePath)); records.push({ id: `PACKAGE-${packageRecord.id}-${suffix}`, type: 'package', label, kind, path: filePath, mimeType: type, size: info.size, sha256: info.sha256, phase: packageRecord.phase, packageId: packageRecord.id });
    }
  }
  for (const [id, label, relative] of [['SYS-README', 'Work-item guide', 'README.md'], ['SYS-STATUS', 'Workflow status', 'STATUS.md'], ['SYS-WORKFLOW', 'Workflow state', 'workflow.json'], ['SYS-SOURCE', 'Source context', 'source.json'], ['SYS-STORY', 'User story', 'USER-STORY.md']]) {
    const record = await systemDocument(root, config, workflow, id, label, relative); if (record) records.push(record);
  }
  for (const phaseId of workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})) {
    const phase = workflow.phases[phaseId];
    if (!phase?.requiredArtifact?.path) continue;
    const absolute = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
    if (!(await exists(absolute))) continue; const info = await snapshot(absolute);
    records.push({ id: `PHASE-${phaseId.toUpperCase()}`, type: 'artifact', label: phase.label, kind: phase.requiredArtifact.kind, path: posix(path.relative(root, absolute)), mimeType: mimeType(absolute), size: info.size, sha256: info.sha256, phase: phaseId, status: phase.status, generation: phase.generation });
    let extraIndex = 0;
    for (const artifact of (phase.artifacts ?? []).filter((item) => item.path !== posix(path.relative(root, absolute)))) {
      if (!(await exists(path.join(root, artifact.path)))) continue; extraIndex += 1;
      records.push({ id: `ART-${phaseId.toUpperCase()}-${String(extraIndex).padStart(2, '0')}`, type: 'artifact', label: path.basename(artifact.path), kind: artifact.kind, path: artifact.path, mimeType: mimeType(artifact.path), size: artifact.size, sha256: artifact.sha256, phase: phaseId, status: artifact.status, generation: phase.generation });
    }
  }
  return records;
}

export async function viewDocument(root, config, workflow, reference, { includeDetached = false } = {}) {
  const records = await documentCatalog(root, config, workflow, { includeDetached }); const normalized = reference.toLowerCase();
  const matches = records.filter((item) => item.id.toLowerCase() === normalized || item.path?.toLowerCase() === normalized || path.basename(item.path ?? '').toLowerCase() === normalized);
  if (!matches.length) throw new SingularityFlowError(`Document '${reference}' was not found. Run singularity-flow documents list.`);
  if (matches.length > 1) throw new SingularityFlowError(`Document reference '${reference}' is ambiguous; use its document ID.`);
  const record = matches[0]; if (record.type === 'url') return { record, content: null, binary: false };
  const extension = path.extname(record.path).toLowerCase(); const binary = !TEXT_EXTENSIONS.has(extension) && !record.mimeType.startsWith('text/');
  const absolute = await governedDocumentPath(root, config, workflow, record);
  const current = await snapshot(absolute);
  if (record.sha256 && (current.sha256 !== record.sha256 || current.size !== record.size)) {
    throw new SingularityFlowError(`Document '${record.id}' no longer matches its committed catalog hash. Expected ${record.sha256}, found ${current.sha256}.`);
  }
  if (binary) return {
    record, content: null, binary: true, absolutePath: absolute,
    verifiedSha256: current.sha256, size: current.size, previewBytes: 0, truncated: false
  };
  const policy = documentPolicy(workflow, config); const bytes = await readFile(absolute); const limit = policy.maxPreviewBytes ?? 1048576;
  let previewBytes = Math.min(bytes.length, limit);
  let content = bytes.subarray(0, previewBytes).toString('utf8');
  // Do not end a byte-limited preview halfway through a UTF-8 code point.
  while (content.endsWith('\uFFFD') && previewBytes > 0) {
    previewBytes -= 1;
    content = bytes.subarray(0, previewBytes).toString('utf8');
  }
  const truncated = bytes.length > previewBytes;
  if (truncated) content = `${content}\n… preview truncated …\n`;
  return {
    record, content, binary: false, absolutePath: absolute,
    verifiedSha256: current.sha256, size: current.size, previewBytes, truncated
  };
}

export async function previewDocument(root, config, workflow, reference) {
  const viewed = await viewDocument(root, config, workflow, reference);
  if (viewed.record.type === 'url' || !viewed.binary) return viewed;
  if (!INLINE_PREVIEW_TYPES.has(viewed.record.mimeType)) {
    return { record: viewed.record, content: null, binary: true, previewable: false };
  }
  const policy = documentPolicy(workflow, config);
  const limit = policy.maxFileBytes ?? 26214400;
  const absolute = await governedDocumentPath(root, config, workflow, viewed.record);
  const current = await snapshot(absolute);
  if (current.sha256 !== viewed.record.sha256 || current.size !== viewed.record.size) {
    throw new SingularityFlowError(`Document '${viewed.record.id}' no longer matches its committed catalog hash. Expected ${viewed.record.sha256}, found ${current.sha256}.`);
  }
  if (current.size > limit) throw new SingularityFlowError(`Document '${viewed.record.id}' exceeds the ${limit} byte inline-preview limit.`);
  const bytes = await readFile(absolute);
  return {
    record: viewed.record,
    content: null,
    binary: true,
    previewable: true,
    mime: viewed.record.mimeType,
    dataUrl: `data:${viewed.record.mimeType};base64,${bytes.toString('base64')}`,
    sha256: current.sha256,
    size: current.size,
    integrity: 'verified'
  };
}
