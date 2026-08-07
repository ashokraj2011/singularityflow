import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { EpicSourceRecord, RepositorySnapshot, StoryArtifact } from './cli/snapshot.ts';

export type EvidenceTarget = {
  kind: 'story' | 'epic';
  id: string;
  label: string;
};

export type EvidenceInput =
  | { kind: 'files' | 'figma-export'; paths: string[] }
  | { kind: 'url'; url: string; label: string };

export type EvidenceCatalogItem = {
  target: EvidenceTarget;
  id: string;
  label: string;
  status: 'active' | 'detached';
  kind: string;
  path?: string;
  url?: string;
  mimeType?: string;
  sha256?: string;
  packageId?: string;
  detachReason?: string;
  detachedAt?: string;
  detachedBy?: string;
};

const actorLabel = (actor?: { name?: string; email?: string; login?: string }): string | undefined =>
  actor?.name ?? actor?.login ?? actor?.email;

const isStoryEvidence = (record: StoryArtifact): boolean => ['file', 'url'].includes(record.type ?? '');

/** A single UI catalog assembled from the coherent snapshot, never from an independent rescan. */
export function evidenceCatalog(snapshot: RepositorySnapshot | null | undefined): EvidenceCatalogItem[] {
  if (!snapshot) return [];
  const items: EvidenceCatalogItem[] = [];
  const story = snapshot.workflow?.workItem;
  if (story?.id) {
    const target: EvidenceTarget = { kind: 'story', id: story.id, label: `Story ${story.id}` };
    for (const record of [...(snapshot.documents ?? []), ...(snapshot.detachedDocuments ?? [])].filter(isStoryEvidence)) {
      if (!record.id) continue;
      items.push({
        target, id: record.id, label: record.label ?? record.id,
        status: record.status === 'detached' ? 'detached' : 'active',
        kind: record.kind ?? record.type ?? 'evidence', path: record.path, url: record.url,
        mimeType: record.mimeType, sha256: record.sha256 ?? undefined, packageId: record.packageId,
        detachReason: record.detachReason, detachedAt: record.detachedAt,
        detachedBy: actorLabel(record.detachedBy)
      });
    }
  }
  const initiative = snapshot.initiative;
  const epicId = initiative?.state?.initiative?.id;
  if (epicId) {
    const target: EvidenceTarget = { kind: 'epic', id: epicId, label: `Epic ${epicId}` };
    const addSource = (record: EpicSourceRecord, status: 'active' | 'detached'): void => {
      items.push({
        target, id: record.sourceId, label: record.name ?? record.sourceId, status,
        kind: record.provider ?? 'source', path: record.recordPath, mimeType: record.mimeType,
        sha256: record.sha256, detachReason: record.detachReason, detachedAt: record.detachedAt,
        detachedBy: actorLabel(record.detachedBy)
      });
    };
    for (const source of initiative.sources?.sources ?? []) addSource(source, 'active');
    for (const source of initiative.detachedSources ?? []) addSource(source, 'detached');
  }
  return items.sort((left, right) => left.target.label.localeCompare(right.target.label)
    || left.status.localeCompare(right.status) || left.label.localeCompare(right.label));
}

export function evidenceDetachCommand(item: EvidenceCatalogItem, scope: 'file' | 'package', reason: string): string[] {
  return item.target.kind === 'story'
    ? ['documents', 'detach', item.id, '--scope', scope, '--reason', reason, '--yes']
    : ['epic', 'sources', 'detach', item.id, '--epic', item.target.id, '--reason', reason, '--yes'];
}

/** Resolve only governed subjects that are already present in the coherent repository snapshot. */
export function evidenceTargets(snapshot: RepositorySnapshot | null | undefined): EvidenceTarget[] {
  if (!snapshot) return [];
  const targets: EvidenceTarget[] = [];
  const story = snapshot.workflow?.workItem;
  if (story?.id) targets.push({ kind: 'story', id: story.id, label: `Story ${story.id}` });
  const epic = snapshot.initiative?.state?.initiative;
  if (epic?.id) targets.push({ kind: 'epic', id: epic.id, label: `Epic ${epic.id}` });
  return targets;
}

/**
 * Convert an editor choice to the existing CLI mutation. The CLI remains the authority: it applies
 * phase gates, hashes bytes, updates the catalog, commits, and pushes. VS Code never writes a
 * governed source record itself.
 */
export function evidenceCommands(target: EvidenceTarget, input: EvidenceInput): string[][] {
  if (input.kind === 'url') {
    return target.kind === 'story'
      ? [['documents', 'upload', '--url', input.url, '--label', input.label]]
      : [['epic', 'sources', 'add', '--epic', target.id, '--url', input.url, '--label', input.label]];
  }
  if (target.kind === 'story') {
    return [[
      'documents', 'upload', ...input.paths,
      ...(input.kind === 'figma-export' ? ['--kind', 'figma-export'] : [])
    ]];
  }
  // Epic source intake accepts one file at a time. Keep the order deterministic so a retry and its
  // receipts are understandable even when a complete Figma export directory was selected.
  return [...input.paths].sort().map((file) => [
    'epic', 'sources', 'add', '--epic', target.id, '--provider', 'local', '--file', file,
    ...(input.kind === 'figma-export' ? ['--label', `Figma export · ${path.basename(file)}`] : [])
  ]);
}

export function validateEvidenceUrl(value: string, figmaOnly = false): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) {
      return 'Use an HTTPS URL without embedded credentials.';
    }
    if (figmaOnly && !(url.hostname === 'figma.com' || url.hostname.endsWith('.figma.com'))) {
      return 'Enter a Figma HTTPS link.';
    }
    return null;
  } catch {
    return 'Enter a valid HTTPS URL.';
  }
}

/** Expand an Epic folder without following symlinks outside the selected export. */
export async function expandEpicEvidenceDirectory(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  await visit(root);
  return files;
}
