import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertNoPendingPublication, saveWorkflow, workDir, workDirRelative } from './state.mjs';
import { loadSession } from './session.mjs';
import { SingularityFlowError, exists, nowIso, posix, snapshot, writeJson } from './util.mjs';
import { assertPhaseSequence, enforceSequenceGate } from './sequence.mjs';

const TEXT_EXTENSIONS = new Set(['.adoc', '.csv', '.html', '.ini', '.json', '.md', '.mdx', '.rst', '.sql', '.svg', '.toml', '.tsv', '.txt', '.xml', '.yaml', '.yml']);
const MIME_TYPES = {
  '.csv': 'text/csv', '.fig': 'application/x-figma', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.md': 'text/markdown', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain', '.webp': 'image/webp', '.yaml': 'application/yaml', '.yml': 'application/yaml'
};

function manifestPath(root, config, workflow) { return path.join(workDir(root, config, workflow.workItem.id), 'documents.json'); }
function mimeType(file) { return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'; }
function safeName(value) { return path.basename(value).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document'; }
function nextId(records) { return `DOC-${String(Math.max(0, ...records.map((item) => Number(item.id?.match(/^DOC-(\d+)$/)?.[1] ?? 0))) + 1).padStart(3, '0')}`; }

async function loadManifest(root, config, workflow) {
  const file = manifestPath(root, config, workflow);
  return await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : { schemaVersion: 1, workId: workflow.workItem.id, documents: [] };
}

function documentPolicy(workflow, config) {
  return workflow.resolution?.documents ?? config.documents ?? { allowedPhases: ['intake'], maxFileBytes: 26214400, maxPreviewBytes: 1048576 };
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
  if (label && files.length + (url ? 1 : 0) > 1) throw new SingularityFlowError('--label can be used only when uploading one document.');
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new SingularityFlowError('Document URL must use http:// or https://.');
  const fileInputs = [];
  for (const candidate of files) {
    const source = path.resolve(candidate); const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new SingularityFlowError(`Document is not a regular file: ${candidate}`);
    if (info.size > (policy.maxFileBytes ?? 26214400)) throw new SingularityFlowError(`Document exceeds the ${(policy.maxFileBytes ?? 26214400)} byte limit: ${candidate}`);
    fileInputs.push({ source, info });
  }
  const session = await loadSession(root); if (session.workId && session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Active persona session belongs to ${session.workId}; resume ${workflow.workItem.id} before uploading.`);
  const manifest = await loadManifest(root, config, workflow); const added = [];
  for (const { source } of fileInputs) {
    const id = nextId(manifest.documents); const filename = safeName(source); const relative = `${workDirRelative(config, workflow.workItem.id)}/inputs/${id}/${filename}`;
    const destination = path.join(root, relative); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination);
    const fileSnapshot = await snapshot(destination);
    const record = { id, type: 'file', label: label ?? filename, kind: kind ?? 'reference', sourceName: path.basename(source), path: posix(relative), mimeType: mimeType(filename), size: fileSnapshot.size, sha256: fileSnapshot.sha256, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, persona: session.persona };
    manifest.documents.push(record); added.push(record);
  }
  if (url) {
    const id = nextId(manifest.documents); const record = { id, type: 'url', label: label ?? url, kind: kind ?? (/figma\.com/i.test(url) ? 'figma' : 'reference'), url, phase: phase.id, addedAt: nowIso(), addedBy: session.actor, persona: session.persona };
    manifest.documents.push(record); added.push(record);
  }
  manifest.updatedAt = nowIso(); await writeJson(manifestPath(root, config, workflow), manifest);
  workflow.documents = { count: manifest.documents.length, updatedAt: manifest.updatedAt };
  workflow.history.push({ at: manifest.updatedAt, actor: session.actor.login ?? session.actor.email ?? session.actor.name, persona: session.persona, event: 'documents_added', phase: phase.id, detail: added.map((item) => item.id).join(', ') });
  await saveWorkflow(root, config, workflow); return added;
}

async function systemDocument(root, config, workflow, id, label, relative) {
  const absolute = path.join(workDir(root, config, workflow.workItem.id), relative); if (!(await exists(absolute))) return null;
  const info = await snapshot(absolute); return { id, type: 'system', label, kind: 'workflow', path: posix(path.relative(root, absolute)), mimeType: mimeType(relative), size: info.size, sha256: info.sha256, phase: null };
}

export async function documentCatalog(root, config, workflow) {
  const manifest = await loadManifest(root, config, workflow); const records = [...manifest.documents];
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
  if (binary) return { record, content: null, binary: true, absolutePath: path.join(root, record.path) };
  const policy = documentPolicy(workflow, config); const content = await readFile(path.join(root, record.path), 'utf8'); const limit = policy.maxPreviewBytes ?? 1048576;
  return { record, content: content.length > limit ? `${content.slice(0, limit)}\n… preview truncated …\n` : content, binary: false };
}
