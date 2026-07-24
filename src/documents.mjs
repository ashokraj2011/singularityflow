import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNoPendingPublication, saveWorkflow, workDir, workDirRelative } from './state.mjs';
import { loadSession } from './session.mjs';
import { SingularityFlowError, exists, nowIso, posix, snapshot, writeJson, writeText } from './util.mjs';
import { assertPhaseSequence, enforceSequenceGate } from './sequence.mjs';
import { sourceRuntime, storageAdapter } from './epic-sources.mjs';

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

function manifestPath(root, config, workflow) { return path.join(workDir(root, config, workflow.workItem.id), 'documents.json'); }
function mimeType(file) { return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'; }
function safeName(value) { return path.basename(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document'; }
function nextId(records) { return `DOC-${String(Math.max(0, ...records.map((item) => Number(item.id?.match(/^DOC-(\d+)$/)?.[1] ?? 0))) + 1).padStart(3, '0')}`; }
function nextPackageId(records) { return `PKG-${String(Math.max(0, ...records.map((item) => Number(item.id?.match(/^PKG-(\d+)$/)?.[1] ?? 0))) + 1).padStart(3, '0')}`; }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

async function directoryFiles(source, packageName, relativeParts = [], packageSource = source) {
  const files = [];
  const entries = (await readdir(source, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(source, entry.name); const parts = [...relativeParts, entry.name];
    if (entry.isSymbolicLink()) throw new SingularityFlowError(`Document directories cannot contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) files.push(...await directoryFiles(absolute, packageName, parts, packageSource));
    else if (entry.isFile()) files.push({ source: absolute, info: await stat(absolute), packageName, packageSource, sourceRelativePath: posix(parts.join('/')) });
  }
  return files;
}

async function loadManifest(root, config, workflow) {
  const file = manifestPath(root, config, workflow);
  const manifest = await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : { schemaVersion: 2, workId: workflow.workItem.id, documents: [], packages: [] };
  manifest.schemaVersion = Math.max(2, manifest.schemaVersion ?? 1); manifest.packages ??= [];
  return manifest;
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
  const packageRoot = path.join(workDir(root, config, workflow.workItem.id), 'inputs', 'packages', packageRecord.id);
  const packageRelative = posix(path.relative(root, packageRoot)); await mkdir(packageRoot, { recursive: true });
  const audit = { schemaVersion: 1, id: packageRecord.id, name: packageRecord.name, importedAt: packageRecord.importedAt, fileCount: records.length, totalBytes, extensions, emptyFiles: records.filter((item) => item.size === 0).map((item) => item.id), duplicates, files: records.map(({ id, label, sourceRelativePath, path: filePath, mimeType: type, size, sha256 }) => ({ id, label, sourceRelativePath, path: filePath, mimeType: type, size, sha256 })) };
  await writeJson(path.join(packageRoot, 'manifest.json'), audit);
  const inventory = [`# Design package ${packageRecord.id} — ${packageRecord.name}`, '', `- Files: **${records.length}**`, `- Bytes: **${totalBytes}**`, `- Empty files: **${audit.emptyFiles.length}**`, `- Duplicate groups: **${duplicates.length}**`, '', '| ID | Relative source path | Type | Bytes | SHA-256 |', '|---|---|---|---:|---|', ...records.map((item) => `| ${item.id} | ${item.sourceRelativePath} | ${item.mimeType} | ${item.size} | \`${item.sha256}\` |`), '', '## File types', '', ...Object.entries(extensions).sort().map(([extension, count]) => `- ${extension}: ${count}`), ''];
  await writeText(path.join(packageRoot, 'inventory.md'), `${inventory.join('\n')}\n`);
  const images = records.filter((item) => item.mimeType?.startsWith('image/'));
  const cards = images.map((item) => { const relative = posix(path.relative(packageRoot, path.join(root, item.path))); return `<figure><img loading="lazy" src="${escapeHtml(relative)}" alt="${escapeHtml(item.label)}"><figcaption><strong>${escapeHtml(item.sourceRelativePath)}</strong><small>${escapeHtml(item.id)} · ${escapeHtml(item.sha256.slice(0, 12))}</small></figcaption></figure>`; }).join('');
  const gallery = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(packageRecord.name)} gallery</title><style>body{font:16px/1.5 Inter,system-ui,sans-serif;margin:32px;background:#f5f7f5;color:#17251d}h1{color:#16472b}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}figure{margin:0;background:#fff;border:1px solid #d7dfda;border-radius:14px;overflow:hidden;box-shadow:0 8px 24px #183f2a12}img{display:block;width:100%;height:260px;object-fit:contain;background:#eef2ef}figcaption{display:flex;flex-direction:column;padding:14px}small{color:#68756d}</style></head><body><h1>${escapeHtml(packageRecord.name)}</h1><p>${images.length} image preview(s) from ${records.length} files. Open source files at original resolution.</p><div class="grid">${cards || '<p>No image files were detected.</p>'}</div></body></html>`;
  await writeText(path.join(packageRoot, 'gallery.html'), gallery);
  Object.assign(packageRecord, { fileCount: records.length, totalBytes, manifestPath: `${packageRelative}/manifest.json`, inventoryPath: `${packageRelative}/inventory.md`, galleryPath: `${packageRelative}/gallery.html`, imageCount: images.length, duplicateGroups: duplicates.length, emptyFiles: audit.emptyFiles.length });
}

function documentPolicy(workflow, config) {
  return workflow.resolution?.documents ?? config.documents ?? { allowedPhases: ['intake'], maxFileBytes: 26214400, maxPreviewBytes: 1048576 };
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

export async function addDocuments(root, config, workflow, { files = [], url = null, label = null, kind = null } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'upload documents');
  const phase = await assertPhaseSequence(root, workflow, 'upload documents');
  const policy = documentPolicy(workflow, config); const allowed = policy.allowedPhases ?? ['intake'];
  if (!allowed.includes(phase.id)) await enforceSequenceGate(root, workflow, 'documentPhase', 'upload documents', {
    requestedPhase: phase.id,
    reason: `Documents may be uploaded only during: ${allowed.join(', ')}. Current phase is '${phase.id}'.`
  });
  if (!files.length && !url) throw new SingularityFlowError('Provide one or more files or --url <https-url>.');
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new SingularityFlowError('Document URL must use http:// or https://.');
  const fileInputs = [];
  for (const candidate of files) {
    const source = path.resolve(candidate); const info = await stat(source).catch(() => null);
    if (info?.isFile()) fileInputs.push({ source, info, packageName: null, packageSource: null, sourceRelativePath: null });
    else if (info?.isDirectory()) {
      const expanded = await directoryFiles(source, safeName(source));
      if (!expanded.length) throw new SingularityFlowError(`Document directory contains no regular files: ${candidate}`);
      fileInputs.push(...expanded);
    } else throw new SingularityFlowError(`Document path is not a regular file or directory: ${candidate}`);
  }
  if (label && fileInputs.length + (url ? 1 : 0) > 1) throw new SingularityFlowError('--label can be used only when uploading one document.');
  for (const input of fileInputs) {
    if (input.info.size > (policy.maxFileBytes ?? 26214400)) throw new SingularityFlowError(`Document exceeds the ${(policy.maxFileBytes ?? 26214400)} byte limit: ${input.source}`);
  }
  const session = await loadSession(root); if (session.workId && session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Active persona session belongs to ${session.workId}; resume ${workflow.workItem.id} before uploading.`);
  const manifest = await loadManifest(root, config, workflow); const added = [];
  const packageMap = new Map();
  for (const input of fileInputs.filter((item) => item.packageSource)) if (!packageMap.has(input.packageSource)) {
    const record = { id: nextPackageId([...manifest.packages, ...packageMap.values()]), name: input.packageName, sourceName: path.basename(input.packageSource), phase: phase.id, importedAt: nowIso(), importedBy: session.actor, persona: session.persona };
    packageMap.set(input.packageSource, record); manifest.packages.push(record);
  }
  for (const { source, packageName, packageSource, sourceRelativePath } of fileInputs) {
    const id = nextId(manifest.documents); const filename = safeName(source);
    const preservedPath = sourceRelativePath ? path.posix.join(packageName, ...sourceRelativePath.split('/').map(safeName)) : filename;
    const relative = path.posix.join(workDirRelative(config, workflow.workItem.id), 'inputs', id, preservedPath);
    const destination = path.join(root, relative); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination);
    const fileSnapshot = await snapshot(destination);
    const record = { id, type: 'file', label: label ?? sourceRelativePath ?? filename, kind: kind ?? (packageName ? 'directory-import' : 'reference'), sourceName: path.basename(source), path: posix(relative), mimeType: mimeType(filename), size: fileSnapshot.size, sha256: fileSnapshot.sha256, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, persona: session.persona };
    if (packageName) { record.sourcePackage = packageName; record.packageId = packageMap.get(packageSource).id; record.sourceRelativePath = sourceRelativePath; }
    manifest.documents.push(record); added.push(record);
  }
  if (url) {
    const id = nextId(manifest.documents); const record = { id, type: 'url', label: label ?? url, kind: kind ?? (/figma\.com/i.test(url) ? 'figma' : 'reference'), url, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, persona: session.persona };
    manifest.documents.push(record); added.push(record);
  }
  for (const packageRecord of packageMap.values()) await writePackageIndexes(root, config, workflow, manifest, packageRecord);
  manifest.updatedAt = nowIso(); await writeJson(manifestPath(root, config, workflow), manifest);
  workflow.documents = { count: manifest.documents.length, updatedAt: manifest.updatedAt };
  workflow.history.push({ at: manifest.updatedAt, actor: session.actor.login ?? session.actor.email ?? session.actor.name, persona: session.persona, event: 'documents_added', phase: phase.id, detail: added.map((item) => item.id).join(', ') });
  await saveWorkflow(root, config, workflow); return added;
}

function resolveStorageProvider(config, providerId) {
  const storage = config.storage;
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
  const { selectedId, provider } = resolveStorageProvider(config, providerId);
  const session = await loadSession(root);
  if (session.workId && session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Active persona session belongs to ${session.workId}; resume ${workflow.workItem.id} before fetching.`);
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
  const manifest = await loadManifest(root, config, workflow);
  const id = nextId(manifest.documents);
  const relative = path.posix.join(workDirRelative(config, workflow.workItem.id), 'inputs', id, filename);
  const destination = path.join(root, relative); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, result.bytes);
  const fileSnapshot = await snapshot(destination);
  const record = {
    id, type: 'file', label: label ?? headMeta?.name ?? filename, kind: kind ?? 'provider-fetch', sourceName: filename,
    path: posix(relative), mimeType: result.mimeType ?? headMeta?.mimeType ?? mimeType(filename),
    size: fileSnapshot.size, sha256: fileSnapshot.sha256, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, persona: session.persona,
    remote: { source: provider.type, providerId: selectedId, objectId: result.objectId ?? reference.objectId ?? String(remoteRef), version: result.version ?? headMeta?.version ?? null, ref: String(remoteRef) }
  };
  manifest.documents.push(record);
  manifest.updatedAt = nowIso(); await writeJson(manifestPath(root, config, workflow), manifest);
  workflow.documents = { count: manifest.documents.length, updatedAt: manifest.updatedAt };
  workflow.history.push({ at: manifest.updatedAt, actor: session.actor.login ?? session.actor.email ?? session.actor.name, persona: session.persona, event: 'documents_added', phase: phase.id, detail: `${id} ← ${provider.type}:${selectedId}` });
  await saveWorkflow(root, config, workflow); return [record];
}

// Browse a configured storage provider so a picker can list selectable documents.
export async function listRemoteDocuments(config, { providerId = null, path: subPath = '', runtime = {} } = {}) {
  const { selectedId, provider } = resolveStorageProvider(config, providerId);
  const adapter = storageAdapter(selectedId, provider, sourceRuntime(runtime, selectedId));
  if (typeof adapter.list !== 'function') throw new SingularityFlowError(`Storage provider '${selectedId}' (${provider.type}) does not support browsing.`);
  return { providerId: selectedId, providerType: provider.type, entries: await adapter.list({ path: subPath }) };
}

async function systemDocument(root, config, workflow, id, label, relative) {
  const absolute = path.join(workDir(root, config, workflow.workItem.id), relative); if (!(await exists(absolute))) return null;
  const info = await snapshot(absolute); return { id, type: 'system', label, kind: 'workflow', path: posix(path.relative(root, absolute)), mimeType: mimeType(relative), size: info.size, sha256: info.sha256, phase: null };
}

export async function documentCatalog(root, config, workflow) {
  const manifest = await loadManifest(root, config, workflow); const records = [...manifest.documents];
  for (const packageRecord of manifest.packages ?? []) {
    for (const [suffix, label, kind, filePath, type] of [['INVENTORY', `${packageRecord.name} inventory`, 'package-inventory', packageRecord.inventoryPath, 'text/markdown'], ['GALLERY', `${packageRecord.name} gallery`, 'package-gallery', packageRecord.galleryPath, 'text/html'], ['MANIFEST', `${packageRecord.name} manifest`, 'package-manifest', packageRecord.manifestPath, 'application/json']]) {
      if (!filePath || !(await exists(path.join(root, filePath)))) continue;
      const info = await snapshot(path.join(root, filePath)); records.push({ id: `PACKAGE-${packageRecord.id}-${suffix}`, type: 'package', label, kind, path: filePath, mimeType: type, size: info.size, sha256: info.sha256, phase: packageRecord.phase, packageId: packageRecord.id });
    }
  }
  for (const [id, label, relative] of [['SYS-README', 'Work-item guide', 'README.md'], ['SYS-STATUS', 'Workflow status', 'STATUS.md'], ['SYS-WORKFLOW', 'Workflow state', 'workflow.json'], ['SYS-SOURCE', 'Source context', 'source.json'], ['SYS-STORY', 'User story', 'USER-STORY.md']]) {
    const record = await systemDocument(root, config, workflow, id, label, relative); if (record) records.push(record);
  }
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId]; const absolute = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
    if (!(await exists(absolute))) continue; const info = await snapshot(absolute);
    records.push({ id: `PHASE-${phaseId.toUpperCase()}`, type: 'artifact', label: phase.label, kind: phase.requiredArtifact.kind, path: posix(path.relative(root, absolute)), mimeType: mimeType(absolute), size: info.size, sha256: info.sha256, phase: phaseId, status: phase.status, generation: phase.generation });
    let extraIndex = 0;
    for (const artifact of phase.artifacts.filter((item) => item.path !== posix(path.relative(root, absolute)))) {
      if (!(await exists(path.join(root, artifact.path)))) continue; extraIndex += 1;
      records.push({ id: `ART-${phaseId.toUpperCase()}-${String(extraIndex).padStart(2, '0')}`, type: 'artifact', label: path.basename(artifact.path), kind: artifact.kind, path: artifact.path, mimeType: mimeType(artifact.path), size: artifact.size, sha256: artifact.sha256, phase: phaseId, status: artifact.status, generation: phase.generation });
    }
  }
  return records;
}

export async function viewDocument(root, config, workflow, reference) {
  const records = await documentCatalog(root, config, workflow); const normalized = reference.toLowerCase();
  const matches = records.filter((item) => item.id.toLowerCase() === normalized || item.path?.toLowerCase() === normalized || path.basename(item.path ?? '').toLowerCase() === normalized);
  if (!matches.length) throw new SingularityFlowError(`Document '${reference}' was not found. Run singularity-flow documents list.`);
  if (matches.length > 1) throw new SingularityFlowError(`Document reference '${reference}' is ambiguous; use its document ID.`);
  const record = matches[0]; if (record.type === 'url') return { record, content: null, binary: false };
  const extension = path.extname(record.path).toLowerCase(); const binary = !TEXT_EXTENSIONS.has(extension) && !record.mimeType.startsWith('text/');
  const absolute = await governedDocumentPath(root, config, workflow, record);
  if (binary) return { record, content: null, binary: true, absolutePath: absolute };
  const policy = documentPolicy(workflow, config); const content = await readFile(absolute, 'utf8'); const limit = policy.maxPreviewBytes ?? 1048576;
  return { record, content: content.length > limit ? `${content.slice(0, limit)}\n… preview truncated …\n` : content, binary: false };
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
