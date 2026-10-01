import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { EpicSourceRecord, RepositorySnapshot, StoryArtifact } from './cli/snapshot.ts';

export type EvidenceTarget = {
  kind: 'story' | 'epic';
  id: string;
  label: string;
};

/**
 * What to attach. A Story document needs a name, one per path in order (a folder is one document
 * package named once); an Epic source keeps its own labels, so `names` is ignored there. `store`
 * and `phases` apply to Story documents only: where the file bytes are kept, and which phases
 * use the documents (absent means the current phase onward).
 */
export type EvidenceInput =
  | { kind: 'files' | 'figma-export'; paths: string[]; names?: string[]; store?: 'git' | 'local'; phases?: string[] | null }
  | { kind: 'url'; url: string; label: string; phases?: string[] | null }
  | { kind: 'epic-source'; sourceId: string; name: string; store?: 'git' | 'local'; phases?: string[] | null };

/** `documents browse --provider epic --json`: the verified sources of the Epic a Story was released from. */
export type EpicSourceBrowse = {
  epicId: string;
  commit: string;
  entries: Array<{ id: string; name: string; filename?: string | null; mimeType?: string | null; size?: number; imported: boolean }>;
  rejected: Array<{ sourceId: string | null; name: string | null; reason: string }>;
};

export type EvidenceCatalogItem = {
  target: EvidenceTarget;
  id: string;
  label: string;
  /** The phases a Story document is offered to; absent means every phase. */
  phases?: string[];
  /** Where a Story file's bytes are kept, and for one kept on one machine whether this checkout has it. */
  storage?: 'git' | 'local';
  availability?: 'available' | 'unavailable' | 'changed';
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
        target, id: record.id, label: record.name ?? record.label ?? record.id,
        ...(Array.isArray(record.phases) ? { phases: record.phases } : {}),
        ...(record.storage?.kind === 'local' ? { storage: 'local' as const, availability: record.availability ?? 'unavailable' }
          : record.type === 'file' ? { storage: 'git' as const } : {}),
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

/** The dry run of a Story document detach: which published work used it and what reopens. Epics have none. */
export function evidenceDetachPreviewCommand(item: EvidenceCatalogItem, scope: 'file' | 'package'): string[] | null {
  return item.target.kind === 'story'
    ? ['documents', 'detach', item.id, '--scope', scope, '--dry-run', '--json']
    : null;
}

/** One line per published generation a document change reaches, as a person reads it. */
export function evidenceUsesLabel(uses: Array<{ phase: string; generation: number }> | undefined): string | null {
  return uses?.length ? uses.map((use) => `${use.phase} generation ${use.generation}`).join(', ') : null;
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
  // A Story imports a verified copy of one of its Epic's sources; the CLI checks it against the Epic.
  if (input.kind === 'epic-source') {
    return [['documents', 'fetch', '--provider', 'epic', '--ref', input.sourceId, '--name', input.name,
      '--store', input.store ?? 'git', ...phaseArguments(input.phases)]];
  }
  if (input.kind === 'url') {
    return target.kind === 'story'
      ? [['documents', 'upload', '--url', input.url, '--name', input.label, ...phaseArguments(input.phases)]]
      : [['epic', 'sources', 'add', '--epic', target.id, '--url', input.url, '--label', input.label]];
  }
  if (target.kind === 'story') {
    // Storage is always stated: a repository whose policy defaults to this machine must not turn a
    // "Committed to Git" choice into a local copy. A folder (a Figma export) is always committed.
    const store = input.kind === 'figma-export' ? 'git' : input.store ?? 'git';
    return [[
      'documents', 'upload', ...input.paths,
      ...(input.names ?? []).flatMap((name) => ['--name', name]),
      ...(input.kind === 'figma-export' ? ['--kind', 'figma-export'] : []),
      '--store', store,
      ...phaseArguments(input.phases)
    ]];
  }
  // Epic source intake accepts one file at a time. Keep the order deterministic so a retry and its
  // receipts are understandable even when a complete Figma export directory was selected.
  return [...input.paths].sort().map((file) => [
    'epic', 'sources', 'add', '--epic', target.id, '--provider', 'local', '--file', file,
    ...(input.kind === 'figma-export' ? ['--label', `Figma export · ${path.basename(file)}`] : [])
  ]);
}

function phaseArguments(phases?: string[] | null): string[] {
  return phases?.length ? ['--phases', phases.join(',')] : [];
}

/**
 * The CLI change to which phases use a Story document. A dry run previews what the change would
 * invalidate and changes nothing; the real run carries the reviewed decision as `--yes`.
 */
export function evidenceScopeCommand(item: EvidenceCatalogItem, phases: string[], reason: string, { dryRun = false } = {}): string[] {
  return ['documents', 'scope', item.id, '--phases', phases.join(','), '--reason', reason,
    ...(dryRun ? ['--dry-run', '--json'] : ['--yes', '--json'])];
}

/** The phases a new Story document is offered to unless someone chooses otherwise. */
export function defaultEvidencePhases(phaseOrder: string[], currentPhase?: string | null): string[] {
  const start = currentPhase ? phaseOrder.indexOf(currentPhase) : 0;
  return phaseOrder.slice(Math.max(0, start));
}

/**
 * Where a Story's documents may be kept, from its pinned document policy: the allowed choices in a
 * stable order and the one used when nobody chooses. Mirrors the engine's documentStorageChoices.
 */
export function evidenceStorageChoices(policy: { storage?: { allowed?: unknown; default?: unknown } } | null | undefined): {
  allowed: Array<'git' | 'local'>; default: 'git' | 'local';
} {
  const kinds: Array<'git' | 'local'> = ['git', 'local'];
  const shared = kinds[0]!;
  const configured = Array.isArray(policy?.storage?.allowed) ? policy!.storage!.allowed as unknown[] : [];
  const allowed = configured.length ? kinds.filter((kind) => configured.includes(kind)) : kinds;
  const usable = allowed.length ? allowed : kinds;
  const fallback: 'git' | 'local' = usable.includes(shared) ? shared : usable[0]!;
  const chosen = policy?.storage?.default;
  return { allowed: usable, default: chosen === 'git' || chosen === 'local' ? (usable.includes(chosen) ? chosen : fallback) : fallback };
}

/** How a Story document's storage reads in a list. */
export function evidenceStorageLabel(item: EvidenceCatalogItem): string | null {
  if (item.storage === 'local') {
    return item.availability === 'available' ? 'Kept on this machine only'
      : item.availability === 'changed' ? 'Kept on this machine only · changed since it was added'
        : 'Kept on another machine · not available here';
  }
  return item.storage === 'git' ? 'Committed to Git' : null;
}

/**
 * Why a Story document name cannot be used, or null. The engine enforces the same rules; checking
 * here lets the input box say so before anything runs. `taken` holds the names already in the
 * Story (detached documents included) and those chosen earlier in this attach.
 */
export function validateEvidenceName(value: string, taken: Iterable<string> = []): string | null {
  const name = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!name) return 'A name is required.';
  if (name.length > 120) return 'Use at most 120 characters.';
  if (/[\u0000-\u001f\u007f]/u.test(name)) return 'Remove the control character.';
  if (/^(?:DOC|PKG)-\d+$/iu.test(name)) return 'That looks like a document ID. Use a descriptive name.';
  const key = name.toLowerCase();
  for (const existing of taken) {
    if (existing.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase() === key) return 'Another document in this Story already has that name.';
  }
  return null;
}

/** A first suggestion for a document's name: its file or folder name without the extension. */
export function suggestedEvidenceName(file: string): string {
  const stem = path.basename(file).replace(/\.[^.]+$/u, '').replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return (stem || path.basename(file)).slice(0, 120);
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
