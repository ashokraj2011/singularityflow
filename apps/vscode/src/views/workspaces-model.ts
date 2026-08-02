/**
 * The workspaces a person has on this machine.
 *
 * A workspace is local and disposable: a working directory plus the capabilities worked on in it.
 * That makes three things ordinary that a governed artifact would never allow — editing one after
 * it exists, copying one somewhere else, and forgetting one without consequence.
 *
 * The rule that holds it together is that no two workspaces share a working directory. Two sets of
 * governed state writing into one tree is not a conflict to resolve later; it is corruption. The
 * engine refuses it, and this reports it before the engine has to.
 */

/** One entry of `workspace list --json`. */
export interface WorkspaceEntry {
  id: string;
  path: string;
  name: string;
  anchorKey: string;
  leadRepositoryPath?: string;
  openedAt?: string;
  archivedAt?: string | null;
  /** Non-empty when this is the workspace commands currently act on. */
  active?: string;
}

export interface WorkspaceRow extends WorkspaceEntry {
  /** The directory a person actually works in, which is what the list is really about. */
  directory: string;
  lead: string;
  archived: boolean;
  /** True when another row occupies the same directory — which the engine forbids. */
  collides: boolean;
}

/**
 * The rows to draw, newest first, with directory collisions marked.
 *
 * A collision cannot normally happen — the engine refuses to create one — but a registry is a file
 * on disk that survives moves, restores and hand edits. Showing it is cheaper than the alternative,
 * which is two workspaces quietly writing over one directory.
 */
export function workspaceRows(entries: WorkspaceEntry[]): WorkspaceRow[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.path.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.map((entry) => ({
    ...entry,
    directory: entry.path,
    // `repos/<id>` is the layout every workspace uses, so the lead's identifier is its last segment.
    lead: (entry.leadRepositoryPath ?? '').split('/').filter(Boolean).at(-1) ?? '',
    archived: Boolean(entry.archivedAt),
    collides: (counts.get(entry.path.toLowerCase()) ?? 0) > 1
  }));
}

/** Where a copy of this workspace would go, so the form can say before the engine does. */
export function duplicateDirectory(row: WorkspaceRow, id: string, base: string | null): string {
  const parent = base?.trim() || row.directory.split('/').slice(0, -1).join('/');
  return `${parent}/${id.trim()}`;
}

/**
 * What still stands between this and a copy.
 *
 * The identifier rule is the engine's own; the directory rule is the one this whole screen exists
 * to keep. Both are checked here so they are answered on the form rather than by a failed command.
 */
export function duplicateProblems(
  row: WorkspaceRow | null,
  id: string,
  base: string | null,
  rows: WorkspaceRow[]
): string[] {
  const problems: string[] = [];
  if (!row) return ['Choose a workspace to copy.'];
  if (!id.trim()) problems.push('Give the copy an identifier.');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id.trim())) {
    problems.push('The identifier may contain letters, numbers, dots, underscores and hyphens.');
  } else {
    const target = duplicateDirectory(row, id, base);
    const taken = rows.find((entry) => entry.directory.toLowerCase() === target.toLowerCase());
    if (taken) {
      problems.push(`${target} is already workspace '${taken.name}'. No two workspaces may share a working directory.`);
    }
  }
  return problems;
}

/** The argv a copy describes, once it has no problems. */
export function duplicateCommand(row: WorkspaceRow, id: string, base: string | null, name: string): string[] {
  const args = ['workspace', 'duplicate', row.directory, '--id', id.trim(), '--json'];
  if (base?.trim()) args.push('--base', base.trim());
  if (name.trim()) args.push('--name', name.trim());
  return args;
}

/** The argv a rename describes. Editing a workspace is editing a local convenience, not a record. */
export function renameCommand(row: WorkspaceRow, name: string): string[] {
  return ['workspace', 'update', row.directory, '--name', name.trim(),
    '--confirm', row.anchorKey, '--json'];
}
