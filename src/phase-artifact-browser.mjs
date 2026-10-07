/** Read-only phase browsing. Never substitute a working file for an approved publication. */
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { agentBriefReviewDocuments } from './agent-briefs.mjs';
import { governedDocumentPath } from './documents.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { exactFileAtObject } from './git.mjs';
import { readRecord } from './schema-migrations.mjs';
import { workDirRelative } from './state-stores.mjs';
import { SingularityFlowError, posix } from './util.mjs';

const MAX_BYTES = 1024 * 1024;
const fail = (message, code = 'PHASE_ARTIFACT_UNAVAILABLE') => { throw new SingularityFlowError(message, { code }); };

function phaseEntries(config, workflow, phase) {
  const entries = new Map();
  if (phase.requiredArtifact?.path) {
    const relative = posix(path.join(workDirRelative(config, workflow.workItem.id), phase.requiredArtifact.path));
    entries.set(relative, { path: relative, label: phase.label ?? phase.id, kind: phase.requiredArtifact.kind ?? 'document' });
  }
  for (const artifact of phase.artifacts ?? []) {
    if (artifact.path) entries.set(artifact.path, { ...artifact, label: entries.get(artifact.path)?.label
      ?? artifact.label ?? artifact.name ?? path.posix.basename(artifact.path) });
  }
  for (const brief of agentBriefReviewDocuments(workflow, phase)) {
    if (brief.path && Number(brief.generation) === Number(phase.generation)) {
      entries.set(brief.path, { ...brief, kind: 'agent-brief', label: `Agent brief for ${brief.consumerPhase}` });
    }
  }
  return [...entries.values()].map(entry => ({ ...entry,
    id: `ART-${createHash('sha256').update(`${phase.id}\0${entry.path}`).digest('hex').slice(0, 24)}`,
    type: 'artifact', phase: phase.id, generation: phase.generation ?? 0
  }));
}

/** No file bodies, tests, network or per-phase Git queries on the list path. */
export function phaseArtifactCatalog(config, workflow) {
  return { workId: workflow.workItem.id, currentPhase: workflow.currentPhase,
    phases: (workflow.phaseOrder ?? []).map(id => {
      const phase = workflow.phases[id];
      return { id, label: phase?.label ?? id, status: phase?.status ?? 'not_started', generation: phase?.generation ?? 0,
        approved: phase?.status === 'approved' && Number(phase.generation) > 0,
        artifacts: phase ? phaseEntries(config, workflow, phase).map(entry => ({
          id: entry.id, label: entry.label, path: entry.path, kind: entry.kind ?? 'document'
        })) : [] };
    }) };
}

function safeRepositoryPath(relative) {
  if (typeof relative !== 'string' || !relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)
      || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => !part || part === '..' || part === '.')) {
    fail('This artifact does not have a safe repository-relative path.', 'PHASE_ARTIFACT_PATH_UNSAFE');
  }
}

/** Resolve an engine-listed identity, then read bounded regular bytes from the named version. */
export async function viewPhaseArtifact(root, config, workflow, id, version = 'draft') {
  if (!['draft', 'approved'].includes(version)) fail('Choose draft or approved.', 'PHASE_ARTIFACT_VERSION_INVALID');
  let phase;
  let entry;
  for (const phaseId of workflow.phaseOrder ?? []) {
    const candidate = workflow.phases[phaseId];
    if (!candidate) continue;
    const found = phaseEntries(config, workflow, candidate).find(item => item.id === id);
    if (found) { phase = candidate; entry = found; break; }
  }
  if (!entry) fail('This artifact is not registered in the selected Story.', 'PHASE_ARTIFACT_UNKNOWN');
  safeRepositoryPath(entry.path);
  let bytes;
  let commit = null;
  if (version === 'approved') {
    if (phase.status !== 'approved' || !(Number(phase.generation) > 0)) {
      fail('This phase has no currently approved generation. No draft was substituted.', 'PHASE_ARTIFACT_NOT_APPROVED');
    }
    commit = publishedGenerationCommit(root, workflow, phase);
    if (!commit) fail('The approved generation is unavailable locally. Refresh Story history; no draft was substituted.');
    const aggregateBytes = exactFileAtObject(root, commit, `${workDirRelative(config, workflow.workItem.id)}/workflow.json`, { maximumBytes: 16 * MAX_BYTES, regularOnly: true });
    if (!aggregateBytes) fail('The published Story aggregate could not be read locally.');
    const published = readRecord('story-workflow', JSON.parse(aggregateBytes.toString('utf8'))).record;
    const publishedPhase = published.phases?.[phase.id];
    if (published.workItem?.id !== workflow.workItem.id || Number(publishedPhase?.generation) !== Number(phase.generation)) {
      fail('The approved artifact does not bind to this Story generation.');
    }
    const recorded = phaseEntries(config, published, publishedPhase).find(item => item.id === id);
    if (!recorded) fail('This artifact was not part of the approved published generation.');
    bytes = exactFileAtObject(root, commit, recorded.path, { maximumBytes: MAX_BYTES, regularOnly: true });
    if (!bytes) fail('Approved bytes are missing or exceed the 1 MiB preview limit. No draft was substituted.');
    if (recorded.sha256 && createHash('sha256').update(bytes).digest('hex') !== recorded.sha256.replace(/^sha256:/u, '')) {
      fail('Approved artifact bytes do not match their published registration.');
    }
  } else {
    const absolute = await governedDocumentPath(root, config, workflow, entry);
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) fail('This draft is not a regular file.');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) fail('This draft exceeds the 1 MiB preview limit.');
      bytes = buffer.subarray(0, length);
    } finally { await file.close(); }
  }
  const binary = bytes.includes(0) || !isUtf8(bytes) || /\.(png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?|zip)$/iu.test(entry.path);
  return { workId: workflow.workItem.id, phase: phase.id, generation: phase.generation, version, commit,
    record: { id, path: entry.path, label: entry.label, kind: entry.kind },
    sha256: createHash('sha256').update(bytes).digest('hex'), binary, content: binary ? null : bytes.toString('utf8') };
}
