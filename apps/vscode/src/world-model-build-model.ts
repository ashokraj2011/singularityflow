/** Pure host choreography for the native exact-confirm World Model build. */
import { currentGitSource } from './cli/git-observations.ts';
import { localGit, type LocalGitRunner } from './cli/runner.ts';

export type WorldModelBuildArguments = {
  readonly views: readonly string[];
  readonly depth: 'quick' | 'standard' | 'deep';
  readonly consumer: 'developer' | 'architect' | 'tester' | 'business' | 'operations' | 'security' | 'release';
  readonly composer: 'deterministic' | 'auto' | 'model';
  readonly cachePolicy: 'reuse-valid' | 'rebuild';
};

export type GatewayResult = {
  readonly kind: string;
  readonly operation?: { readonly id?: string; readonly classification?: string };
  readonly outcome?: { readonly status?: string; readonly messageId?: string };
  readonly why?: readonly { readonly code?: string; readonly slots?: Record<string, unknown> }[];
  readonly warnings?: readonly { readonly code?: string; readonly slots?: Record<string, unknown> }[];
  readonly next?: readonly { readonly handle?: string }[];
  readonly data?: Readonly<Record<string, any>>;
};

export type ExactBuildKernel = {
  resolve(request: { utterance: string; arguments: WorldModelBuildArguments }): GatewayResult | Promise<GatewayResult>;
  confirmPlan(request: { planId: string; requestSha256: string; planSha256: string }): {
    readonly receiptId: string; readonly value: string;
  };
  run(request: { planId: string }, confirmation: {
    confirmationReceiptId: string; confirmationValue: string;
  }): GatewayResult | Promise<GatewayResult>;
};

export type ExactWorldModelBuildOutcome = {
  readonly status: 'cancelled' | 'refused' | 'completed';
  readonly planned: GatewayResult | null;
  readonly result: GatewayResult | null;
  readonly capabilityId?: string | null;
  readonly format?: 'legacy-v3' | 'registered-v4';
};

export type ScopedWorldModelBuildConfig<T> = {
  readonly config: T;
  readonly capabilityId: string | null;
};

export type WorldModelBuildConfigurationBoundary = 'story-pinned' | 'approved-authority';

export type WorldModelBuildConfigurationSelection = {
  readonly boundary: WorldModelBuildConfigurationBoundary;
  readonly branch: string;
  readonly sourceCommit: string;
  readonly workId: string | null;
  readonly workflowPath: string | null;
};

export type TrackedStoryWorkflowRecord = {
  readonly path: string;
  /** Null means the tracked record cannot be read safely from this checkout. */
  readonly content: string | null;
};

const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CAPABILITY_CHOICES = 256;
const SOURCE_SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_TRACKED_STORY_WORKFLOWS = 2_048;
const MAX_TRACKED_STORY_WORKFLOW_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_STORY_CATALOG_BYTES = 32 * 1024 * 1024;

function buildBoundaryError(message: string, code: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, details });
}

function portableBranch(value: unknown): string | null {
  const branch = typeof value === 'string' ? value.trim() : '';
  return branch && !/[\u0000-\u001f\u007f]/u.test(branch) ? branch : null;
}

function portableRepositoryPath(value: unknown): string | null {
  const relative = typeof value === 'string' ? value.trim() : '';
  if (!relative || relative.startsWith('/') || relative.includes('\\')
      || relative.split('/').some((part) => !part || part === '.' || part === '..')
      || /[\u0000-\u001f\u007f]/u.test(relative)) return null;
  return relative;
}

type StoryIdentity = {
  readonly workId: string;
  readonly path: string;
  readonly branches: readonly string[];
  readonly active: boolean;
};

function storyIdentity(record: TrackedStoryWorkflowRecord): StoryIdentity | null {
  if (record.content == null) return null;
  let value: unknown;
  try { value = JSON.parse(record.content); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const workflow = value as Readonly<Record<string, any>>;
  const workId = typeof workflow.workItem?.id === 'string' ? workflow.workItem.id.trim() : '';
  const workItemRoot = portableRepositoryPath(workflow.resolution?.workItemRoot);
  const workflowPath = portableRepositoryPath(record.path);
  if (!WORK_ID.test(workId) || !workItemRoot || !workflowPath
      || !workflow.phases || typeof workflow.phases !== 'object' || Array.isArray(workflow.phases)
      || !Array.isArray(workflow.phaseOrder)
      || workflow.workflowSnapshot?.enrollment !== 'wfa'
      || workflowPath !== `${workItemRoot}/${workId}/workflow.json`) return null;
  const branches = [
    workflow.workItem?.branch,
    workflow.lineage?.canonicalBranch,
    ...(Array.isArray(workflow.lineage?.childBranches)
      ? workflow.lineage.childBranches.map((entry: unknown) => field(entry, 'name')) : [])
  ].map(portableBranch).filter((entry): entry is string => entry != null);
  if (!branches.length) return null;
  return Object.freeze({
    workId, path: workflowPath, branches: Object.freeze([...new Set(branches)]),
    active: workflow.status === 'in_progress'
      || Object.values(workflow.phases).some((phase: any) => (
        phase?.status === 'in_progress' || phase?.status === 'awaiting_approval'
      ))
  });
}

function selectStoryIdentity(
  currentBranch: string,
  records: readonly TrackedStoryWorkflowRecord[],
  pointedBranches: readonly string[] = []
): StoryIdentity | null {
  const branch = portableBranch(currentBranch);
  if (!branch) throw buildBoundaryError(
    'Git returned an invalid branch identity for World Model Build.',
    'WMB_STORY_CONFIGURATION_UNAVAILABLE'
  );
  const identities = records.map(storyIdentity).filter((entry): entry is StoryIdentity => entry != null);
  const matching = branch === 'HEAD'
    ? identities.filter((identity) => identity.branches.some((candidate) => pointedBranches.includes(candidate)))
    : identities.filter((identity) => identity.branches.includes(branch));
  const unique = [...new Map(matching.map((identity) => [identity.path, identity])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  if (unique.length > 1) {
    throw buildBoundaryError(
      `Current ${branch === 'HEAD' ? 'detached commit' : `branch '${branch}'`} matches more than one immutable Story record. Repair Story identity before building the World Model.`,
      'WMB_STORY_CONFIGURATION_AMBIGUOUS',
      { branch, paths: unique.map((entry) => entry.path) }
    );
  }
  if (unique.length === 1) return unique[0]!;
  if (branch === 'HEAD' && identities.some((identity) => identity.active)) {
    throw buildBoundaryError(
      'Detached HEAD contains active Story state but no branch ref proves which accepted Story owns this checkout. Attach or resume the Story before building the World Model.',
      'WMB_DETACHED_STORY_IDENTITY_REQUIRED',
      { paths: identities.filter((identity) => identity.active).map((identity) => identity.path).sort() }
    );
  }
  return null;
}

/**
 * Select the configuration authority before any workflow configuration is parsed.
 *
 * A native Build cannot use `loadDefinition()` to answer this question: on a storyless branch that
 * would parse the very working-tree draft the boundary exists to exclude. Tracked Story state is
 * the independent durable proof. Only a canonical WFA-enrolled Story record is identity; an
 * unrelated `workflow.json` can never select Story policy merely because its directory happens to
 * share the branch name.
 */
export function worldModelBuildConfigurationBoundary(
  currentBranch: string,
  records: readonly TrackedStoryWorkflowRecord[],
  pointedBranches: readonly string[] = []
): WorldModelBuildConfigurationBoundary {
  return selectStoryIdentity(currentBranch, records, pointedBranches)
    ? 'story-pinned' : 'approved-authority';
}

function gitResultError(message: string): Error {
  return buildBoundaryError(message, 'WMB_STORY_CONFIGURATION_UNAVAILABLE');
}

async function immutableStoryWorkflowRecords(
  root: string, sourceCommit: string, runner: LocalGitRunner
): Promise<readonly TrackedStoryWorkflowRecord[]> {
  const listed = await runner(['ls-tree', '-r', '-z', sourceCommit], {
    cwd: root, timeout: 10_000
  });
  if (listed.failure || listed.status !== 0 || (listed.stdout.length && listed.stdout.at(-1) !== 0)) {
    throw gitResultError('Git could not inspect immutable Story records before World Model Build.');
  }
  const framed: Buffer[] = [];
  for (let offset = 0; offset < listed.stdout.length;) {
    const nul = listed.stdout.indexOf(0, offset);
    if (nul < 0) throw gitResultError('Git returned a malformed immutable Story catalog.');
    framed.push(listed.stdout.subarray(offset, nul));
    offset = nul + 1;
  }
  const suffix = Buffer.from('/workflow.json');
  const entries = framed.flatMap((entry) => {
    const first = entry.indexOf(0x20);
    const second = entry.indexOf(0x20, first + 1);
    const tab = entry.indexOf(0x09, second + 1);
    const mode = first > 0 ? entry.subarray(0, first).toString('ascii') : '';
    const type = second > first ? entry.subarray(first + 1, second).toString('ascii') : '';
    const objectId = tab > second ? entry.subarray(second + 1, tab).toString('ascii') : '';
    const pathBytes = tab > second ? entry.subarray(tab + 1) : Buffer.alloc(0);
    if (pathBytes.length < suffix.length
        || !pathBytes.subarray(pathBytes.length - suffix.length).equals(suffix)) return [];
    let decodedPath: string;
    try { decodedPath = new TextDecoder('utf-8', { fatal: true }).decode(pathBytes); }
    catch { throw gitResultError('A candidate immutable Story path is not valid UTF-8.'); }
    const relative = portableRepositoryPath(decodedPath);
    if (!/^(?:100644|100755)$/u.test(mode) || type !== 'blob'
        || !GIT_OBJECT_ID.test(objectId) || !relative) {
      throw gitResultError('Git returned an unsafe immutable Story catalog entry.');
    }
    return [{ objectId, path: relative }];
  });
  if (entries.length > MAX_TRACKED_STORY_WORKFLOWS) {
    throw gitResultError(`World Model Build found more than ${MAX_TRACKED_STORY_WORKFLOWS} immutable Story records.`);
  }
  if (!entries.length) return Object.freeze([]);
  const objects = await runner(['cat-file', '--batch'], {
    cwd: root, timeout: 10_000, input: `${entries.map((entry) => entry.objectId).join('\n')}\n`
  });
  if (objects.failure || objects.status !== 0) {
    throw gitResultError('Git could not read immutable Story records before World Model Build.');
  }
  const records: TrackedStoryWorkflowRecord[] = [];
  let offset = 0;
  let total = 0;
  for (const entry of entries) {
    const newline = objects.stdout.indexOf(0x0a, offset);
    if (newline < 0) throw gitResultError('Git returned a malformed immutable Story object stream.');
    const header = objects.stdout.subarray(offset, newline).toString('ascii');
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/u.exec(header);
    const bytes = match ? Number(match[2]) : NaN;
    if (!match || match[1] !== entry.objectId || !Number.isSafeInteger(bytes) || bytes < 0
        || bytes > MAX_TRACKED_STORY_WORKFLOW_BYTES) {
      throw gitResultError('Git returned an invalid immutable Story object.');
    }
    total += bytes;
    if (total > MAX_TRACKED_STORY_CATALOG_BYTES || newline + 1 + bytes >= objects.stdout.length
        || objects.stdout[newline + 1 + bytes] !== 0x0a) {
      throw gitResultError('Immutable Story records exceed or violate the native inspection boundary.');
    }
    const contentBytes = objects.stdout.subarray(newline + 1, newline + 1 + bytes);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes); }
    catch { throw gitResultError('An immutable Story record is not valid UTF-8.'); }
    records.push(Object.freeze({ path: entry.path, content }));
    offset = newline + 1 + bytes + 1;
  }
  if (offset !== objects.stdout.length) throw gitResultError('Git returned surplus immutable Story object data.');
  return Object.freeze(records);
}

async function branchesPointingAt(
  root: string, sourceCommit: string, runner: LocalGitRunner
): Promise<readonly string[]> {
  const observed = await runner([
    'for-each-ref', '--points-at', sourceCommit, '--format=%(refname)', 'refs/heads', 'refs/remotes'
  ], { cwd: root, timeout: 10_000 });
  if (observed.failure || observed.status !== 0) {
    throw gitResultError('Git could not prove detached Story branch identity.');
  }
  const branches = observed.stdout.toString('utf8').split(/\r?\n/u).filter(Boolean).flatMap((ref) => {
    if (ref.startsWith('refs/heads/')) return [ref.slice('refs/heads/'.length)];
    if (ref.startsWith('refs/remotes/')) {
      const relative = ref.slice('refs/remotes/'.length);
      const slash = relative.indexOf('/');
      if (slash > 0 && !relative.endsWith('/HEAD')) return [relative.slice(slash + 1)];
    }
    return [];
  }).map(portableBranch).filter((entry): entry is string => entry != null);
  return Object.freeze([...new Set(branches)].sort());
}

/** Select one authority from immutable HEAD bytes, then prove the checkout did not move. */
export async function observeWorldModelBuildConfigurationSelection(
  root: string, { runner = localGit }: { runner?: LocalGitRunner } = {}
): Promise<WorldModelBuildConfigurationSelection> {
  const source = await currentGitSource(root, { runner });
  const records = await immutableStoryWorkflowRecords(root, source.sourceCommit, runner);
  const pointedBranches = source.branch === 'HEAD'
    ? await branchesPointingAt(root, source.sourceCommit, runner) : [];
  const identity = selectStoryIdentity(source.branch, records, pointedBranches);
  const latest = await currentGitSource(root, { runner });
  if (latest.branch !== source.branch || latest.sourceCommit !== source.sourceCommit) {
    throw buildBoundaryError(
      'The Git branch or commit changed while selecting World Model configuration authority. Reopen Build / refresh.',
      'WMB_CONFIGURATION_BOUNDARY_STALE'
    );
  }
  return Object.freeze({
    boundary: identity ? 'story-pinned' : 'approved-authority',
    branch: source.branch, sourceCommit: source.sourceCommit,
    workId: identity?.workId ?? null, workflowPath: identity?.path ?? null
  });
}

/** Repeat the immutable selection after UI review so a checkout switch cannot reuse stale authority. */
export async function assertWorldModelBuildConfigurationSelection(
  root: string, expected: WorldModelBuildConfigurationSelection,
  options: { runner?: LocalGitRunner } = {}
): Promise<void> {
  const actual = await observeWorldModelBuildConfigurationSelection(root, options);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw buildBoundaryError(
      'World Model source or configuration authority changed during review. Reopen Build / refresh.',
      'WMB_CONFIGURATION_BOUNDARY_STALE', { expected, actual }
    );
  }
}

type WorldModelBuildConfigurationBoundaryOperations<T> = {
  readonly readStoryPinned: () => Promise<T>;
  readonly withApprovedAuthority: (
    read: (authority: Readonly<Record<string, unknown>> | null) => Promise<T>
  ) => Promise<T>;
  readonly readInScope: () => Promise<T>;
};

/**
 * Keep the approved overlay alive for the complete native Build, including modal review and the
 * confirmed gateway execution. This prevents later CALM/capability reads from escaping the exact
 * configuration snapshot used to render the Plan. A working-tree fallback is never authority for
 * storyless Build; accepted Stories deliberately take the separate immutable-pin route.
 */
export async function withWorldModelBuildConfigurationBoundary<T>(
  boundary: WorldModelBuildConfigurationBoundary,
  operations: WorldModelBuildConfigurationBoundaryOperations<T>
): Promise<T> {
  if (boundary === 'story-pinned') return operations.readStoryPinned();
  if (boundary !== 'approved-authority') {
    throw buildBoundaryError(
      'The native World Model configuration boundary is invalid.',
      'WMB_CONFIGURATION_BOUNDARY_INVALID',
      { boundary }
    );
  }
  return operations.withApprovedAuthority(async (authority) => {
    if (!authority || !['approved-configuration-ref', 'verified-state-mirror'].includes(
      typeof authority.kind === 'string' ? authority.kind : ''
    )) {
      throw buildBoundaryError(
        'Storyless World Model Build requires an approved sflow/config or verified state authority; the local workflow draft was not used.',
        'WMB_APPROVED_CONFIGURATION_REQUIRED'
      );
    }
    return operations.readInScope();
  });
}

/** The legacy path is deliberately deterministic and state-only, including on a Story branch. */
export function legacyWorldModelLightArguments(
  capabilityId: string | null = null,
  expectedSourceTreeSha256: string
): readonly string[] {
  if (!SOURCE_SHA256.test(expectedSourceTreeSha256)) {
    throw Object.assign(new Error('The World Model source snapshot is not a verified SHA-256 digest.'), {
      code: 'WMB_SOURCE_SNAPSHOT_INVALID'
    });
  }
  const args = [
    'wm', 'light', '--format', 'legacy-v3', '--views', 'all', '--state-only',
    '--expected-source-tree-sha256', expectedSourceTreeSha256
  ];
  if (capabilityId != null) {
    if (!CAPABILITY_ID.test(capabilityId)) {
      throw Object.assign(new Error('The World Model capability scope is invalid.'), {
        code: 'WMB_CAPABILITY_SELECTION_INVALID'
      });
    }
    args.push('--capability', capabilityId);
  }
  return Object.freeze(args);
}

/** Exact review copy, including the fact that this does not touch the application branch. */
export function legacyWorldModelLightDetail({
  repository, branch, sourceCommit, sourceTreeSha256, views, remote, stateBranch, outputDir,
  capabilityId = null
}: {
  repository: string; branch: string; sourceCommit: string; sourceTreeSha256: string;
  views: readonly string[]; remote: string; stateBranch: string; outputDir: string;
  capabilityId?: string | null;
}): string {
  const argv = legacyWorldModelLightArguments(capabilityId, sourceTreeSha256);
  return [
    `Repository: ${repository}`,
    `Current branch: ${branch} · no model installation, commit, or push`,
    `Effective format: legacy-v3${capabilityId ? ` · capability ${capabilityId}` : ''}`,
    `Source commit: ${sourceCommit}`,
    `Source tree: ${sourceTreeSha256}`,
    `Concrete views: ${views.join(', ')}`,
    `Only publication target: ${remote}/${stateBranch} · ${outputDir}`,
    'Deterministic light inventory; zero model calls. This does not migrate the format to registered-v4.',
    'The remote state authority must be reachable, and in-scope application source must be committed.',
    '',
    `Shell: singularity-flow ${argv.join(' ')}`,
    'Copilot: /sf-worldmodel (review the same effective legacy-v3 repository and state target)'
  ].join('\n');
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Load the canonical build configuration without guessing repository ownership.
 *
 * A storyless repository can legitimately deliver more than one capability. The engine returns
 * the exact approved IDs in a structured refusal; the native host may present only that bounded
 * set, then it must reload through the same canonical loader with the selected ID. Cancelling the
 * picker performs no second read and cannot reach planning, confirmation, or execution.
 */
export async function loadScopedWorldModelBuildConfig<T>(
  load: (capabilityId: string | null) => Promise<T>,
  chooseCapability: (capabilityIds: readonly string[]) => Promise<string | null | undefined>,
  preferredCapabilityId: string | null = null
): Promise<ScopedWorldModelBuildConfig<T> | null> {
  if (preferredCapabilityId != null) {
    if (!CAPABILITY_ID.test(preferredCapabilityId)) {
      throw Object.assign(new Error('The requested World Model capability ID is invalid.'), {
        code: 'WMB_CAPABILITY_SELECTION_INVALID',
        details: { capabilityId: preferredCapabilityId }
      });
    }
    const config = await load(preferredCapabilityId);
    const resolved = field(field(config, 'repositoryCapability'), 'id');
    if (resolved !== preferredCapabilityId) {
      throw Object.assign(new Error('The World Model configuration did not retain the requested capability scope.'), {
        code: 'WMB_CAPABILITY_SELECTION_MISMATCH',
        details: { capabilityId: preferredCapabilityId, resolvedCapabilityId: resolved ?? null }
      });
    }
    return { config, capabilityId: preferredCapabilityId };
  }
  try {
    const config = await load(null);
    const resolved = field(field(config, 'repositoryCapability'), 'id');
    return { config, capabilityId: typeof resolved === 'string' && CAPABILITY_ID.test(resolved) ? resolved : null };
  } catch (error) {
    if (field(error, 'code') !== 'WMB_CAPABILITY_SELECTION_REQUIRED') throw error;
    const raw = field(field(error, 'details'), 'capabilityIds');
    if (!Array.isArray(raw)) throw error;
    const capabilityIds = [...new Set(raw)].filter((entry): entry is string => (
      typeof entry === 'string' && CAPABILITY_ID.test(entry)
    )).sort();
    // Do not turn malformed or unexpectedly large diagnostic data into an editor choice. The
    // engine validated map remains the authority; a changed contract must be repaired there.
    if (capabilityIds.length !== raw.length || capabilityIds.length < 2
        || capabilityIds.length > MAX_CAPABILITY_CHOICES) throw error;
    const selected = await chooseCapability(Object.freeze(capabilityIds));
    if (selected == null) return null;
    if (!capabilityIds.includes(selected)) {
      throw Object.assign(new Error('The selected World Model capability is not in the approved capability set.'), {
        code: 'WMB_CAPABILITY_SELECTION_INVALID',
        details: { capabilityId: selected }
      });
    }
    const config = await load(selected);
    const resolved = field(field(config, 'repositoryCapability'), 'id');
    if (resolved !== selected) {
      throw Object.assign(new Error('The World Model configuration did not retain the selected capability scope.'), {
        code: 'WMB_CAPABILITY_SELECTION_MISMATCH',
        details: { capabilityId: selected, resolvedCapabilityId: resolved ?? null }
      });
    }
    return { config, capabilityId: selected };
  }
}

/** Exact argv for the explicit authority refresh used by the native retry flow. */
export function worldModelAuthorityRefreshArguments(
  capabilityId: string | null = null
): readonly string[] {
  const args = ['wm', 'refresh-authority', '--format', 'registered-v4'];
  if (capabilityId != null) {
    if (!CAPABILITY_ID.test(capabilityId)) {
      throw Object.assign(new Error('The World Model capability retry scope is invalid.'), {
        code: 'WMB_CAPABILITY_SELECTION_INVALID', details: { capabilityId }
      });
    }
    args.push('--capability', capabilityId);
  }
  return Object.freeze(args);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

function records(value: unknown): ReadonlyArray<Readonly<Record<string, any>>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Readonly<Record<string, any>> => (
        entry != null && typeof entry === 'object' && !Array.isArray(entry)
      ))
    : [];
}

function requestedProjectionPolicies(
  review: Readonly<Record<string, any>> | null | undefined
): ReadonlyArray<Readonly<Record<string, any>>> {
  const policies = records(review?.projectionPolicies);
  if (policies.length) return policies;
  return Array.isArray(review?.requestedProjections)
    ? review.requestedProjections.filter((entry: unknown): entry is string => (
        typeof entry === 'string' && entry.length > 0
      )).map((reference: string) => Object.freeze({ reference }))
    : [];
}

function projectionReference(entry: Readonly<Record<string, any>>): string {
  if (typeof entry.reference === 'string' && entry.reference.length) return entry.reference;
  const id = stringField(entry.projectionId, 'unknown-projection');
  return Number.isInteger(entry.projectionVersion) ? `${id}@${entry.projectionVersion}` : id;
}

function reviewedProjectionText(entry: Readonly<Record<string, any>>): string {
  const policy = entry.required === true ? 'required' : entry.required === false ? 'optional' : 'policy unavailable';
  const strict = entry.validation?.strict === true
    ? 'strict validation'
    : entry.validation?.strict === false ? 'schema validation' : 'validation policy unavailable';
  const profile = entry.profile && typeof entry.profile === 'object'
    ? [
        entry.profile.includeGovernanceActors !== false ? 'actors' : null,
        entry.profile.includeControls !== false ? 'controls' : null,
        entry.profile.includeFlows !== false ? 'flows' : null
      ].filter(Boolean).join('+')
    : null;
  const external = typeof entry.profile?.includeExternalDependencies === 'string'
    ? `external ${entry.profile.includeExternalDependencies}` : null;
  const cache = typeof entry.cacheStatus === 'string' ? `cache ${entry.cacheStatus}` : null;
  return [projectionReference(entry), policy, strict, profile, external, cache]
    .filter(Boolean).join(' · ');
}

/** Content shown before the host issues the out-of-band confirmation receipt. */
export function exactWorldModelPlanDetail(
  review: Readonly<Record<string, any>>,
  { capabilityId = null }: { capabilityId?: string | null } = {}
): string {
  const publication = review.publication && typeof review.publication === 'object'
    ? review.publication as Readonly<Record<string, unknown>> : {};
  const remote = stringField(publication.remote, 'configured remote');
  const branch = stringField(publication.branch, 'state');
  const projectionPolicies = requestedProjectionPolicies(review);
  const lines = [
    `Request: ${stringField(review.requestSha256, 'unavailable')}`,
    `Plan: ${stringField(review.planSha256, 'unavailable')}`,
    `Source: ${stringField(review.sourceManifestSha256, 'unavailable')}`,
    `Scope: ${capabilityId ? `${capabilityId} · ` : ''}${stringField(review.scopeManifestSha256, 'unavailable')}`,
    `Views: ${Array.isArray(review.effectiveViews) ? review.effectiveViews.join(', ') : 'unavailable'}`,
    `Projections: ${projectionPolicies.length
      ? projectionPolicies.map(reviewedProjectionText).join('; ')
      : 'none requested'}`,
    `Depth / composer: ${stringField(review.depth, 'unavailable')} / ${stringField(review.composer, 'unavailable')}`,
    `Publish target: ${remote}/${branch} · ${stringField(publication.outputDir, 'singularity/world-model')}`
  ];
  const expected = Object.hasOwn(publication, 'expectedRemoteHead')
    ? publication.expectedRemoteHead
    : Object.hasOwn(publication, 'expectedTargetCommit')
      ? publication.expectedTargetCommit
      : Object.hasOwn(review, 'expectedRemoteHead')
        ? review.expectedRemoteHead : review.expectedTargetCommit;
  if (typeof expected === 'string' && expected.length) lines.push(`Expected target head: ${expected}`);
  else if (expected === null) lines.push('Expected target head: branch absent');
  lines.push('', 'No provider, Git ref, or repository file has been changed by this preview.');
  lines.push('If the source, scope, policy, or publication target moves, execution is refused and must be reviewed again.');
  return lines.join('\n');
}

/** One bounded completion message which keeps optional projection degradation visible. */
export function worldModelBuildCompletionMessage(outcome: ExactWorldModelBuildOutcome): string {
  const data = outcome.result?.data ?? {};
  const manifest = typeof data.manifestSha256 === 'string' ? data.manifestSha256 : null;
  const views = Array.isArray(data.views) ? data.views.length : 0;
  const headline = `World Model published${manifest ? ` as ${manifest.slice(0, 19)}` : ''} with ${views} view${views === 1 ? '' : 's'}.`;
  const review = outcome.planned?.data?.plan?.review;
  const policies = requestedProjectionPolicies(review);
  const policyById = new Map(policies.map((entry) => [
    stringField(entry.projectionId, projectionReference(entry).replace(/@\d+$/, '')), entry
  ]));
  const results = records(data.projections);
  if (!results.length && !policies.length) return headline;
  const refusals = records(data.refusals);
  const seen = new Set<string>();
  const summaries = results.map((entry) => {
    const id = stringField(entry.projectionId, 'unknown-projection');
    seen.add(id);
    const policy = policyById.get(id);
    const reference = policy ? projectionReference(policy) : projectionReference(entry);
    const requirement = policy?.required === true ? 'required'
      : policy?.required === false ? 'optional' : 'policy unavailable';
    const status = stringField(entry.status, 'status unavailable');
    const refusal = refusals.find((candidate) => (
      (typeof entry.refusalSha256 === 'string'
        && candidate.refusalSha256 === entry.refusalSha256)
      || candidate.projectionId === id
    ));
    const refusalCode = typeof refusal?.code === 'string' ? refusal.code : null;
    const refusalSha256 = typeof entry.refusalSha256 === 'string' ? entry.refusalSha256
      : typeof refusal?.refusalSha256 === 'string' ? refusal.refusalSha256 : null;
    const refusalText = status === 'unavailable'
      ? `; refusal ${refusalCode ?? 'recorded'}${refusalSha256 ? ` · ${refusalSha256.slice(0, 19)}` : ''}`
      : '';
    return `${reference}=${status} (${requirement}${refusalText})`;
  });
  for (const policy of policies) {
    const id = stringField(policy.projectionId, projectionReference(policy).replace(/@\d+$/, ''));
    if (!seen.has(id)) summaries.push(`${projectionReference(policy)}=status unavailable (${policy.required === true ? 'required' : 'optional'})`);
  }
  return `${headline} Projections: ${summaries.join('; ')}.`;
}

/** Host-only exact confirmation choreography, independent from VS Code widgets. */
export async function runExactWorldModelBuild(
  kernel: ExactBuildKernel,
  args: WorldModelBuildArguments,
  reviewPlan: (review: Readonly<Record<string, any>>) => boolean | Promise<boolean>,
  executeConfirmed: <T>(operation: () => Promise<T>) => PromiseLike<T> = (operation) => operation()
): Promise<ExactWorldModelBuildOutcome> {
  const planned = await kernel.resolve({
    utterance: 'build and publish registered world model', arguments: args
  });
  const plan = planned.data?.plan;
  const planId = stringField(plan?.handle ?? planned.next?.[0]?.handle, '');
  const review = plan?.review;
  if (planned.kind !== 'plan' || !planId || !review
      || typeof review.requestSha256 !== 'string' || typeof review.planSha256 !== 'string') {
    return { status: 'refused', planned, result: planned };
  }
  if (!await reviewPlan(review)) return { status: 'cancelled', planned, result: null };

  // Receipt id and secret stay in this lexical host boundary and are never rendered, logged, put in
  // command arguments, or returned to a model-facing tool.
  const receipt = kernel.confirmPlan({
    planId,
    requestSha256: review.requestSha256,
    planSha256: review.planSha256
  });
  const result = await executeConfirmed(() => Promise.resolve(kernel.run(
    { planId },
    { confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value }
  )));
  return {
    status: result.kind === 'refusal' || result.outcome?.status === 'refused' ? 'refused' : 'completed',
    planned,
    result
  };
}
