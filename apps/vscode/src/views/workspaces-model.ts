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
import path from 'node:path';

/** One entry of `workspace list --json`. */
export const WORKSPACE_ACTION_CANCELLED = '__sflow_workspace_action_cancelled__';

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
  /** Readiness of the selected repository; present only for the active workspace. */
  repositoryState?: string | null;
}

/** The richer result of `workspace open <DIRECTORY> --json`. */
export interface WorkspaceStatus {
  workspace: {
    id: string;
    name: string;
    path: string;
    leadRepository: string;
    /** Credential-free Git authority persisted by the workspace manifest. */
    capabilityAuthority?: { url?: string } | null;
    capabilities?: string[];
    anchor?: {
      provider?: string;
      key?: string;
      title?: string;
      baseUrl?: string;
      issueTypeName?: string;
      hierarchyLevel?: number;
    };
  };
  healthy: boolean;
  leadRepositoryPath: string;
  repositories: WorkspaceRepositoryStatus[];
  warnings?: Array<{ code?: string; repository?: string; message: string }>;
  counts?: {
    repositories?: number;
    ready?: number;
    dirty?: number;
    stagedDocuments?: number;
    worldModels?: number;
  };
  /**
   * The capability map read through the workspace's lead repository.
   *
   * `workspace open` owns repository health. The extension adds this optional inventory from
   * `capability organisation` so editing a workspace chooses governed capability identifiers
   * instead of accepting free text.
   */
  availableCapabilities?: WorkspaceCapabilityChoice[];
  /** A local, read-only proof that every repository has no non-terminal Story. */
  archiveReadiness?: WorkspaceArchiveReadiness;
}

/**
 * A repository inspection may open Workspaces for one exact capability authority. Keep the
 * authority revision with the request so a retained panel cannot silently choose the active (or
 * first) workspace from another organisation.
 */
export interface WorkspaceCapabilityAttachScope {
  capabilityIds: string[];
  authority: {
    leadUrl: string;
    configurationBranch: string;
    configurationCommit: string;
  };
  /** Workspace registry paths whose manifests name this exact lead authority. */
  matchingPaths: string[];
  /** A bounded explanation when the authority moved or no local workspace matches it. */
  issue?: string | null;
}

export interface CapabilityAuthorityLease {
  leadUrl: string;
  configurationBranch: string;
  configurationCommit: string;
}

export interface CapabilityAuthorityLeaseRequest extends CapabilityAuthorityLease {
  identityKind: 'configuration' | 'legacy-projection';
}

export interface ObservedCapabilityAuthority {
  governed?: boolean;
  stale?: boolean;
  configurationBranch?: string | null;
  configurationCommit?: string | null;
  sourceBranch?: string | null;
  sourceCommit?: string | null;
  remoteFailure?: {
    code?: unknown;
    classification?: unknown;
    retryable?: unknown;
    advice?: unknown;
  } | null;
  diagnosticAction?: {
    command?: unknown;
    skill?: unknown;
    copilotCommand?: unknown;
  } | null;
}

export type CapabilityAuthorityLeaseVerification =
  | { status: 'verified'; authority: CapabilityAuthorityLease; upgradedLegacyProjection: boolean }
  | { status: 'ungoverned' | 'unavailable' | 'invalid' | 'changed'; authority: null };

/**
 * Reconcile a Map-panel authority lease with one fresh organisation observation.
 *
 * Current panels lease `sflow/config`. Panels retained from the older, single-identity schema may
 * lease the state projection instead. The latter is safe only when it still exactly matches the
 * freshly observed projection; the result is then upgraded to the approved configuration identity
 * before any preview or mutation is allowed to use it.
 */
export function verifyCapabilityAuthorityLease(
  requested: CapabilityAuthorityLeaseRequest,
  observed: ObservedCapabilityAuthority
): CapabilityAuthorityLeaseVerification {
  if (observed.stale === true) return { status: 'unavailable', authority: null };
  if (observed.governed !== true) return { status: 'ungoverned', authority: null };
  const configurationBranch = observed.configurationBranch?.trim();
  const configurationCommit = observed.configurationCommit?.trim().toLowerCase();
  if (configurationBranch !== 'sflow/config' || !configurationCommit
    || !/^[0-9a-f]{40,64}$/u.test(configurationCommit)) {
    return { status: 'invalid', authority: null };
  }
  const requestedBranch = requested.configurationBranch.trim();
  const requestedCommit = requested.configurationCommit.trim().toLowerCase();
  const matches = (branch?: string | null, commit?: string | null): boolean =>
    branch?.trim() === requestedBranch && commit?.trim().toLowerCase() === requestedCommit;
  const matchesConfiguration = matches(configurationBranch, configurationCommit);
  const matchesProjection = requested.identityKind === 'legacy-projection'
    && matches(observed.sourceBranch, observed.sourceCommit);
  if (!matchesConfiguration && !matchesProjection) {
    return { status: 'changed', authority: null };
  }
  return {
    status: 'verified',
    authority: {
      leadUrl: requested.leadUrl,
      configurationBranch,
      configurationCommit
    },
    upgradedLegacyProjection: !matchesConfiguration && matchesProjection
  };
}

export interface WorkspaceArchiveReadiness {
  eligible: boolean;
  checkedAt: string;
  fetched: boolean;
  activeStories: Array<{
    repository: string;
    id: string;
    title: string;
    status: string;
    phase: string | null;
    branch: string;
  }>;
  blockers: string[];
}

export interface WorkspaceCapabilityChoice {
  id: string;
  name: string;
  depth: number;
  ancestors: string[];
  repository: string | null;
}

export interface WorkspaceCapabilityChangePreview {
  planId: string;
  changed: boolean;
  action: 'attach' | 'detach';
  capabilityId: string;
  dropLocal: boolean;
  authority: {
    url: string;
    configurationBranch: string;
    configurationCommit: string;
    sourceBranch: string;
    sourceCommit: string;
  };
  selectedBefore: string[];
  selectedAfter: string[];
  /** Exact approved repositories that attachment will have to clone/materialize. */
  materializeRepositories: string[];
  addedRepositories: string[];
  dropRepositories: Array<{
    id: string;
    path: string;
    state: string;
    removable: boolean;
  }>;
  preservedRepositories: string[];
  preservedLeadRepository?: string | null;
  workspace: { id: string; path: string };
}

export interface WorkspaceCapabilityChangeResult {
  changed: boolean;
  planId: string;
  workspace: WorkspaceStatus['workspace'];
  status: WorkspaceStatus;
  materializationError?: string | null;
  repairCommand?: string | null;
  retained?: Array<{ id: string; path: string; recoveryPath: string; reason: string }>;
  /** True when a dropped participant was the machine-wide active repository selection. */
  activeSelectionCleared?: boolean;
}

export interface WorkspaceRepositoryStatus {
  id: string;
  role?: string;
  absolutePath?: string;
  path?: string;
  state?: string;
  branch?: string | null;
  dirty?: boolean | null;
  url?: string;
  defaultBranch?: string;
  metadata?: Record<string, unknown>;
  jira?: Record<string, unknown>;
  worldModel?: { state?: string; warning?: string | null } | null;
}

export type WorkspaceFosAction = 'attach' | 'refresh-authority' | 'offline-authority'
  | 'git-acceleration' | 'clear-cache' | 'local-authority' | 'doctor' | 'resume-bootstrap'
  | 'factory-reset';

/** Transient presentation result returned by an existing guarded FOS command to the Workspaces UI. */
export interface WorkspaceFosOutcome {
  action: WorkspaceFosAction;
  status: 'completed' | 'attention';
  headline: string;
  summary: string;
  repositoryPath: string | null;
  recordedAt: string;
  details?: string[];
}

export type WorkspaceConfigurationResolution = 'local' | 'bundled' | 'merge';

/** One inert, operator-reviewed recovery command returned by the engine. */
export interface WorkspaceRecoveryAction {
  command: string;
  argv?: string[];
  shell?: 'posix' | 'powershell';
  cwd?: string;
  skill?: string;
  copilotCommand?: string;
}

/** The complete UI context which one configuration preview or apply is allowed to affect. */
export interface WorkspaceConfigurationRequestContext {
  selectedPath: string | null;
  scope: 'selected' | 'all';
  /** Optional exact repository selected by a Git-URL recovery handoff. */
  repositoryId?: string | null;
}

/** Opaque, panel-owned authority for one asynchronous configuration request. */
export interface WorkspaceConfigurationRequestLease {
  revision: number;
  context: string;
}

function configurationRequestContextKey(context: WorkspaceConfigurationRequestContext): string {
  return JSON.stringify([
    context.selectedPath,
    context.scope,
    context.repositoryId ?? null
  ]);
}

/**
 * Monotonic authority for retained-panel configuration requests.
 *
 * Comparing only the selected path is insufficient: while a request is in flight the reader can
 * travel A → B → A, change from one/all, or select a different repository and arrive at values
 * that look identical to an older request. The revision makes every such older response stale;
 * the context key additionally proves that callers passed the exact path, scope, and repository
 * which the lease was issued for.
 */
export class WorkspaceConfigurationRequestLeases {
  private revision = 0;

  issue(context: WorkspaceConfigurationRequestContext): WorkspaceConfigurationRequestLease {
    return { revision: ++this.revision, context: configurationRequestContextKey(context) };
  }

  invalidate(): void {
    this.revision += 1;
  }

  isCurrent(
    lease: WorkspaceConfigurationRequestLease,
    context: WorkspaceConfigurationRequestContext
  ): boolean {
    return lease.revision === this.revision
      && lease.context === configurationRequestContextKey(context);
  }
}

export interface WorkspaceConfigurationConflict {
  path: string;
  resolution: string;
  local?: unknown;
  bundled?: unknown;
  localSha256?: string | null;
  bundledSha256?: string | null;
}

export interface WorkspaceConfigurationRefreshRepository {
  status: string;
  repository: string;
  remote: string;
  configurationChanged?: boolean;
  stateChanged?: boolean;
  stateStatus?: string;
  configurationCommit?: string;
  stateCommit?: string | null;
  proposalBranch?: string;
  files?: string[];
  missingStatePaths?: string[];
  changedStatePaths?: string[];
  extraStatePaths?: string[];
  removedStatePaths?: string[];
  conflicts?: WorkspaceConfigurationConflict[];
  /** A preflight-owned, still-unapplied repair that the UI may select for a new preview. */
  repair?: {
    kind: 'packaged-agents';
    label: string;
    paths: string[];
  } | null;
  error?: string | null;
}

export interface WorkspaceConfigurationRefreshResult {
  status: string;
  dryRun: boolean;
  planId?: string;
  total: number;
  updated: number;
  failed?: number;
  results: WorkspaceConfigurationRefreshRepository[];
  /** Present for the composed `workspace reinitialize` report. */
  resultType?: 'workspace-reinitialization';
  capabilityPortability?: {
    status: string;
    /** Always false for safe reinitialization; capability publication is a separate command. */
    changed?: boolean;
    statement?: string;
    plannedLeads: Array<{
      lead: string;
      workspaceIds: string[];
      triggeredByRepositories: string[];
    }>;
    results: Array<{
      lead: string;
      workspaceIds: string[];
      triggeredByRepositories: string[];
      status: string;
      reason?: string;
      nextAction?: WorkspaceRecoveryAction | null;
    }>;
  };
  schemaMigrationPolicy?: {
    mode: string;
    validatesStoredVersions: boolean;
    rewritesStoredRecords: boolean;
    immutableRecordsRewritten: boolean;
    statement: string;
  };
  schemaCensuses?: Array<{
    repository: string;
    remote: string;
    path: string;
    status: string;
    healthy?: boolean;
    records?: number;
    readTimeMigrationRecords?: number;
    outsideReadableRange?: number;
    unreadable?: number;
    unregistered?: number;
    truncated?: boolean;
    reason?: string;
    nextAction?: WorkspaceRecoveryAction | null;
  }>;
  topologyIssues?: Array<{
    workspaceId?: string;
    repositoryId?: string;
    lead?: string;
    status: string;
    reason: string;
    nextAction?: WorkspaceRecoveryAction | null;
  }>;
  nextAction?: WorkspaceRecoveryAction | null;
}

const SAFE_REINITIALIZATION_CONFLICT_RESOLUTIONS = new Set([
  'preserved-local', 'preserved-local-deletion'
]);

/**
 * Prove that a CLI result is the exact, read-only preview contract which may authorize safe
 * workspace reinitialization.
 *
 * The webview is not an authority boundary: a retained page, a direct host message, or an older
 * configured CLI can all supply a shape which the current UI would never enable. Keep this runtime
 * check shared by rendering and the native message handler, and call it again after confirmation so
 * mutating the reviewed object while the input box is open cannot turn a safe plan into an ownership
 * transfer.
 */
export function isSafeWorkspaceReinitializationPreview(
  result: WorkspaceConfigurationRefreshResult | null | undefined
): result is WorkspaceConfigurationRefreshResult & {
  resultType: 'workspace-reinitialization';
  planId: string;
  capabilityPortability: NonNullable<WorkspaceConfigurationRefreshResult['capabilityPortability']> & {
    changed: false;
  };
} {
  if (!result || result.resultType !== 'workspace-reinitialization'
    || result.status !== 'preview' || result.dryRun !== true
    || typeof result.planId !== 'string' || !result.planId.trim()
    || result.capabilityPortability?.changed !== false
    || !Array.isArray(result.results)) return false;
  return result.results.every((repository) => {
    if (!repository || typeof repository !== 'object') return false;
    if (repository.conflicts === undefined) return true;
    return Array.isArray(repository.conflicts) && repository.conflicts.every((conflict) =>
      Boolean(conflict && typeof conflict === 'object'
        && SAFE_REINITIALIZATION_CONFLICT_RESOLUTIONS.has(conflict.resolution)));
  });
}

export interface WorkspaceRow extends WorkspaceEntry {
  /** The directory a person actually works in, which is what the list is really about. */
  directory: string;
  lead: string;
  archived: boolean;
  /** True when another row occupies the same directory — which the engine forbids. */
  collides: boolean;
  /**
   * True when another row carries the same identifier.
   *
   * The registry de-duplicates by path, so creating the same `--id` in two directories keeps both.
   * Every lookup by id is then ambiguous — including `workspace use` — so it is worth seeing.
   */
  sharesId: boolean;
}

function pathImplementation(value: string): typeof path.posix | typeof path.win32 {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/u.test(value) ? path.win32 : path.posix;
}

/** Stable presentation key only; the engine still proves filesystem identity before mutation. */
function workspaceDirectoryKey(value: string): string {
  const implementation = pathImplementation(value);
  const normalized = implementation.normalize(value);
  return implementation === path.win32 ? normalized.toLocaleLowerCase('en-US') : normalized;
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
  const ids = new Map<string, number>();
  for (const entry of entries) {
    const key = workspaceDirectoryKey(entry.path);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const id = (entry.id ?? '').toLowerCase();
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }
  return entries.map((entry) => ({
    ...entry,
    directory: entry.path,
    // `repos/<id>` is the layout every workspace uses, so the lead's identifier is its last segment.
    lead: entry.leadRepositoryPath
      ? pathImplementation(entry.leadRepositoryPath).basename(entry.leadRepositoryPath)
      : '',
    archived: Boolean(entry.archivedAt),
    collides: (counts.get(workspaceDirectoryKey(entry.path)) ?? 0) > 1,
    sharesId: (ids.get((entry.id ?? '').toLowerCase()) ?? 0) > 1
  }));
}

/** Where a copy of this workspace would go, so the form can say before the engine does. */
export function duplicateBaseDirectory(row: WorkspaceRow): string {
  return pathImplementation(row.directory).dirname(row.directory);
}

export function duplicateDirectory(row: WorkspaceRow, id: string, base: string | null): string {
  const requestedBase = base?.trim();
  const implementation = pathImplementation(requestedBase || row.directory);
  const parent = requestedBase || duplicateBaseDirectory(row);
  return implementation.join(parent, id.trim());
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
    const taken = rows.find((entry) => workspaceDirectoryKey(entry.directory)
      === workspaceDirectoryKey(target));
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
  return ['workspace', 'rename', row.directory, '--name', name.trim(),
    '--confirm', row.anchorKey, '--json'];
}

/** Archiving is local and reversible, but the engine proves there is no active Story first. */
export function archiveCommand(row: WorkspaceRow): string[] {
  return ['workspace', 'archive', row.directory, '--confirm', row.anchorKey, '--fetch', '--json'];
}

export function restoreCommand(row: WorkspaceRow): string[] {
  return ['workspace', 'restore', row.directory, '--json'];
}

/** Preview or apply one exact, non-destructive workspace reinitialization plan. */
export function workspaceReinitializeCommand(
  row: Pick<WorkspaceRow, 'directory'> | null,
  request: {
    dryRun: boolean;
    planId?: string | null;
    repositoryIds?: readonly string[];
  }
): string[] {
  const { dryRun, planId = null, repositoryIds = [] } = request;
  // Upgraded retained panels can outlive the extension code which created them. Fail closed if an
  // older caller attempts to carry conflict choices into safe reinitialization: this route restores
  // only ownership-proven framework seeds and can never adopt packaged bytes over repository work.
  const legacyResolutions = (request as typeof request & {
    resolutions?: Record<string, WorkspaceConfigurationResolution>;
  }).resolutions;
  if (legacyResolutions && Object.keys(legacyResolutions).length) {
    throw new Error(
      'Safe reinitialization does not accept ownership resolutions. Use the separately reviewed configuration refresh journey.'
    );
  }
  const args = ['workspace', 'reinitialize'];
  if (row) args.push(row.directory);
  for (const repositoryId of [...new Set(repositoryIds)].sort()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(repositoryId)) {
      throw new Error(`Invalid repository identifier '${repositoryId}'.`);
    }
    args.push('--repository', repositoryId);
  }
  if (dryRun) args.push('--dry-run');
  if (!dryRun && planId) args.push('--confirm-plan', planId);
  args.push('--json');
  return args;
}

/** Preserve the narrower configuration-only command for callers that deliberately request it. */
export function configurationRefreshCommand(
  row: Pick<WorkspaceRow, 'directory'> | null,
  request: Parameters<typeof workspaceReinitializeCommand>[1] & {
    resolutions?: Record<string, WorkspaceConfigurationResolution>;
  }
): string[] {
  const { resolutions = {}, ...safeRequest } = request;
  const args = workspaceReinitializeCommand(row, safeRequest);
  args[1] = 'refresh-configuration';
  args.splice(-1, 0, ...Object.entries(resolutions)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([conflictPath, resolution]) => ['--resolve', `${conflictPath}=${resolution}`]));
  return args;
}

/**
 * The one workspace edit exposed by the VS Code screen.
 *
 * Name edits are deliberately separate from capability attachment transitions. The latter must use
 * capabilityChangeCommand so repository bindings and checkout recovery cannot be bypassed.
 */
export function updateCommand(
  row: WorkspaceRow,
  name: string
): string[] {
  return ['workspace', 'update', row.directory, '--name', name.trim(),
    '--confirm', row.anchorKey, '--json'];
}

/** Preview and apply commands for one engine-owned capability attachment transition. */
export function capabilityChangeCommand(
  row: Pick<WorkspaceRow, 'directory'>,
  capabilityId: string,
  action: 'attach' | 'detach',
  { dropLocal = false, planId = null }: { dropLocal?: boolean; planId?: string | null } = {}
): string[] {
  const args = ['workspace', `${action}-capability`, row.directory, capabilityId.trim()];
  if (action === 'detach' && dropLocal) args.push('--drop-local');
  if (planId) args.push('--confirm-plan', planId);
  else args.push('--dry-run');
  args.push('--json');
  return args;
}
