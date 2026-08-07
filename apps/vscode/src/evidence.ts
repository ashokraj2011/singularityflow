import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RepositorySnapshot } from './cli/snapshot.ts';

export type EvidenceTarget = {
  kind: 'story' | 'epic';
  id: string;
  label: string;
};

export type EvidenceInput =
  | { kind: 'files' | 'figma-export'; paths: string[] }
  | { kind: 'url'; url: string; label: string };

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
