/**
 * Types over `desktop snapshot --json`, plus the small accessors the views need.
 *
 * These describe what the extension reads, not everything the snapshot carries. The snapshot is a
 * large object serving a whole desktop application; mirroring all of it here would create a second
 * schema that drifts from src/desktop.mjs the first time either changes, and a type that lies is
 * worse than one that admits it does not know. Unread regions stay `unknown`, so touching them is a
 * compile error that forces a look at the engine rather than a guess.
 *
 * Every accessor tolerates absence. A snapshot legitimately has no selected initiative, no
 * breakdown, and no world model, and each of those is a normal state to render rather than an error.
 */

/**
 * Phase and artifact status vocabularies are the engine's, not this extension's.
 *
 * They are typed as a union of the known values *plus* string, deliberately. A closed union would
 * make an engine that adds a status a compile error here, which sounds like a good alarm but is the
 * wrong one: the extension is a reader, and a reader that refuses to render an unfamiliar state is
 * worse than one that renders it plainly. Every lookup below falls back rather than producing
 * `undefined`, which is what a closed Record silently did — later phases showed no icon at all
 * because the real value is `not_started` and this file had guessed `pending`.
 */
/** The value of any policy field; the vocabulary is wide, the shapes are these four. */
export type CapabilityPolicyValue = string | number | boolean | string[] | null;

export interface CapabilityNode {
  id: string;
  name: string;
  kind: string;
  description?: string;
  owner?: string | null;
  /** Tech or business. Absent on capabilities mapped before the field existed. */
  type?: 'tech' | 'business' | null;
  /** True when this capability ships, which the engine infers from naming a repository. */
  delivery?: boolean;
  /** The first repository, kept for readers that predate a capability shipping from several. */
  repository?: string | null;
  /** Every repository this ships from. A capability may ship from several and still contain others. */
  repositories?: string[];
  /** Which of them holds the governed state; the others are governed by it. */
  leadRepository?: string | null;
  /** Application and shared directory scopes for monorepo grounding. */
  sourceRoots?: string[];
  sharedRoots?: string[];
  /** Organisation-defined key/value attributes such as application ID or cost centre. */
  metadata?: Record<string, string>;
  /** Named links to whatever describes this capability — Confluence pages, briefs, runbooks. */
  documentation?: Record<string, string>;
  /** Named links to whatever it runs on — an AWS account, a dashboard, a queue. */
  resources?: Record<string, string>;
  jira?: { projectKey?: string; board?: string; component?: string } | null;
  teams?: string[];
  owns?: string[];
  /** What this capability's own entry declares. */
  policy?: Record<string, CapabilityPolicyValue>;
  /** What it will be held to once every ancestor's policy has folded in. */
  effectivePolicy?: Record<string, CapabilityPolicyValue>;
  children: CapabilityNode[];
}

export type PhaseStatus =
  | 'not_started' | 'in_progress' | 'awaiting_approval' | 'approved' | 'rejected' | 'stale'
  | (string & {});

/** `not_generated` before a phase runs, `published` once it has, `approved` once it is signed off. */
export type OutputStatus =
  | 'not_generated' | 'draft' | 'published' | 'awaiting_approval' | 'approved' | 'rejected' | 'stale'
  | (string & {});

export interface InitiativeOutput {
  id: string;
  label: string;
  kind: string;
  /** Relative to the initiative directory in phase state; already repository-relative in `documents`. */
  path: string;
  repositoryPath?: string;
  phase?: string;
  required: boolean;
  status: OutputStatus;
  generation: number;
  sha256: string | null;
  bytes?: number | null;
  generatedBy?: string | null;
  generatedPersona?: string | null;
  /** Present only on `initiative.documents`, where renderable artifacts are inlined. */
  content?: string | null;
}

export interface InitiativePhase {
  id: string;
  label: string;
  order: number;
  status: PhaseStatus;
  startedAt?: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
  generation: number;
  outputs: Record<string, InitiativeOutput>;
  checklist?: Record<string, unknown>;
  invalidatedBy?: string | null;
}

export interface ApprovalPolicy {
  mode: string;
  authorities: string[] | null;
  minimum: number;
  allowSelfApproval: boolean;
  chain: Array<{ authority: string; minimum: number }> | null;
}

export interface InitiativeResolutionPhase {
  id: string;
  label: string;
  order: number;
  lanes?: unknown;
  worldModelViews?: string[];
  outputs: Array<{
    id: string;
    label: string;
    kind: string;
    path: string;
    required: boolean;
    approval?: ApprovalPolicy;
  }>;
  checklist?: Array<{ id: string; label?: string }>;
  bundleApproval?: ApprovalPolicy;
}

export interface InitiativeState {
  initiative: { id: string; title?: string; branch?: string; createdAt?: string };
  currentPhase: string | null;
  phaseOrder: string[];
  phases: Record<string, InitiativePhase>;
  status?: string;
  resolution: {
    profile: string;
    phases: InitiativeResolutionPhase[];
    packs?: Array<{ id: string; label?: string; members: string[] }>;
    worldModelGrounding?: 'off' | 'warn' | 'enforce';
    [key: string]: unknown;
  };
  history?: Array<{ event: string; detail?: string; at?: string }>;
  childStories?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BreakdownStory {
  id: string;
  planId: string;
  workId: string;
  title: string;
  repository: string;
  epicId: string;
  blocking: boolean;
  dependsOn: Array<{ story: string; requiredPhase: string }>;
  /** The Epic requirements and acceptance criteria this Story is allocated. */
  requirements?: string[];
  acceptanceCriteria?: string[];
}

export interface InitiativeBreakdown {
  version: 1 | 2;
  initiativeId: string | null;
  epics: Array<{ id: string; planId: string; title: string; stories: BreakdownStory[] }>;
  stories: BreakdownStory[];
}

export interface NextAction {
  action: string;
  command: string;
  /** Why the engine is asking for this, shown as-is: it is already written for a human. */
  reason: string;
  modelPolicy?: 'never' | 'optional' | 'required';
  availability?: 'available' | 'fallback' | 'blocked';
  route?: 'model' | 'manual' | 'deterministic';
}

export interface ModelFreedomSnapshot {
  schemaVersion: number;
  mode: 'auto' | 'disabled';
  modeSource: string;
  modelFreeLifecycleReady: boolean;
  blockers: string[];
  warnings?: string[];
  summary?: { status: 'complete' | 'partial' | 'blocked'; modelFreeLifecycleReady: boolean };
  surfaces?: Record<string, { status: 'complete' | 'partial' | 'blocked' | 'outside-guarantee'; control?: string; reason?: string }>;
}

export interface InitiativeSnapshot {
  state: InitiativeState;
  progress?: unknown;
  breakdown: InitiativeBreakdown | null;
  materialization?: unknown;
  report?: unknown;
  phaseGate: {
    ready: boolean;
    errors: string[];
    warnings: string[];
    passes: string[];
    bundleSha256?: string;
    checklist?: unknown;
  } | null;
  nextActions: NextAction[];
  journey?: unknown;
  phaseWork?: unknown;
  outputChoicesByPhase?: Record<string, {
    editable: boolean;
    choices: Array<{ id: string; label: string; required: boolean; included: boolean; authored: boolean }>;
  }>;
  sources?: { version: number; initiativeId: string; sources: EpicSourceRecord[]; jiraSnapshot?: unknown };
  detachedSources?: EpicSourceRecord[];
  documents: InitiativeOutput[];
  delivery?: unknown;
  [key: string]: unknown;
}

export interface WorkItemSummary {
  id: string;
  branch?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface StoryArtifact {
  id?: string;
  label?: string;
  type?: string;
  kind?: string;
  path: string;
  url?: string;
  mimeType?: string;
  size?: number;
  sha256?: string | null;
  status?: string;
  packageId?: string;
  detachReason?: string;
  detachedAt?: string;
  detachedBy?: { name?: string; email?: string; login?: string };
  generation?: number;
  phase?: string | null;
  generatedBy?: string | null;
}

export interface EpicSourceRecord {
  sourceId: string;
  name?: string;
  provider?: string;
  recordPath?: string;
  sha256?: string;
  bytes?: number;
  mimeType?: string;
  status?: string;
  detachReason?: string;
  detachedAt?: string;
  detachedBy?: { name?: string; email?: string; login?: string };
  [key: string]: unknown;
}

export interface StoryApproval {
  decision?: string;
  invalidatedAt?: string | null;
  selfApproval?: boolean;
  at?: string;
  actor?: { name?: string; email?: string; login?: string };
  authorityGroup?: string;
}

export interface StoryPhase {
  id: string;
  label: string;
  status: PhaseStatus;
  generation: number;
  submittedAt?: string | null;
  generatedBy?: { name?: string; email?: string; login?: string } | null;
  requiredArtifact?: { path: string } | null;
  artifacts: StoryArtifact[];
  approvals: StoryApproval[];
  approvalPolicy?: {
    authorities?: string[];
    minimum?: number;
    rejectTo?: string[];
    changeRequests?: { commentRequired?: boolean; reopenCompleted?: boolean };
  };
}

export interface StoryWorkflow {
  workItem: { id: string; title?: string; branch?: string; workType?: string };
  currentPhase: string | null;
  phaseOrder: string[];
  phases: Record<string, StoryPhase>;
  status?: string;
  cancellation?: {
    status: 'cancelled';
    phase: string;
    generation?: number;
    reason: string;
    cancelledAt: string;
    cancelledBy?: { name?: string; email?: string; login?: string };
    agent?: string | null;
  };
  changeRequests?: Array<{
    id: string;
    status: 'open' | 'resolved';
    sourcePhase: string;
    targetPhase: string;
    comment: string;
    requestedAt: string;
    requestedBy?: { name?: string; email?: string; login?: string } | null;
    resolvedAt?: string | null;
  }>;
  resolution?: {
    approvalAuthorities?: Record<string, { members?: Array<{ name?: string; email?: string }> }>;
    [key: string]: unknown;
  };
  lineage?: {
    submissions?: Array<{
      packetSha256: string;
      phase: string;
      generation: number;
      path?: string;
      sourceTreeSha256?: string;
      projection?: { sourceCommit?: string; sourceTreeSha256?: string };
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface StoryModelUsage {
  provider: string;
  model: string;
  records: number;
  exactRecords: number;
  unavailableRecords: number;
  totalTokens: number;
  cost: number | null;
  costStatus: string;
}

export interface StoryPhaseReport {
  id: string;
  label: string;
  status: PhaseStatus;
  generations: number;
  elapsedMs: number | null;
  activeMs: number | null;
  waitingMs: number | null;
  openSubmission: string | null;
  approvals: number;
  selfApprovals: number;
  rejections: unknown[];
  usageRecords: number;
  pendingTelemetry: number;
  tokens: number;
  tokenStatus: string;
  models: string[];
  modelUsage: StoryModelUsage[];
  agents: string[];
  cost: number | null;
  costStatus: string;
}

/** The deterministic lifecycle report produced by `deriveReport`; never recalculated in VS Code. */
export interface StoryWorkflowReport {
  schemaVersion: number;
  generatedAt: string;
  workItem: { id: string; title: string | null; workType: string | null; branch: string | null; status?: string };
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  waitingMs: number;
  activeMs: number | null;
  reworkCycles: number;
  rejections: unknown[];
  selfApprovals: number;
  sequenceOverrides: unknown[];
  tokens: {
    total: number;
    exactRecords: number | null;
    unavailableRecords: number | null;
    byAgent: Record<string, unknown>;
    byPhase: Record<string, unknown>;
    byModel: StoryModelUsage[];
  };
  cost: number | null;
  costStatus: string;
  costCoverage: {
    usageRecords: number;
    exactUsageRecords: number;
    pendingRecords: number;
    pricedRecords: number;
    fullyPricedRecords: number;
    providerCostRecords: number;
    configuredPriceRecords: number;
    missingModels: string[];
  };
  bottleneck: { phase: string; waitingMs: number; share: number | null } | null;
  phases: StoryPhaseReport[];
}

export interface InitiativeSummary {
  id: string;
  branch?: string;
  title?: string;
  status?: string;
  profile?: string;
  [key: string]: unknown;
}

/** One verb of the fast path, as the engine planned it. */
export interface FastPathVerb {
  verb: string;
  /** The phases this verb routes, so the rail can expand into them `[SPK:REQ-151]`. */
  phases: string[];
  milestone: string;
  /** True only when workflow state proves the milestone — never because a command succeeded. */
  reached: boolean;
  checkpoint: { kind: string; reason?: string } | null;
  operations: string[];
  next: Array<{ id: string; label: string; command: string; skill?: string | null; rank: string }>;
}

export interface FastPathProjection {
  profile: string;
  verbs: FastPathVerb[];
  /** The verb that owns the phase the Story is standing in — the rail's "you are here". */
  context: string | null;
  active: string | null;
  next: string | null;
}

/** One task's resolution: the model it reaches, how, and who routes by it. `[ADP:REQ-020]` */
export interface ModelRoutingTask {
  task: string;
  model: string;
  /** The rest of the ladder, preferred-first. Empty when the tier offers no alternative. */
  fallback: string[];
  /** The tier this one borrowed, or null when it names its own model. */
  aliasOf: string | null;
  params: Record<string, unknown> | null;
  /** Phases whose generation declares this task. Empty is normal, not a fault. */
  phases: string[];
}

export interface ModelRoutingProjection {
  /** False when the repository has no mapping at all — routing is opt-in, not missing. */
  configured: boolean;
  /** A mapping that exists but cannot be read. Distinct from `configured: false`. */
  error: string | null;
  path: string;
  revision: string | null;
  tasks: ModelRoutingTask[];
}

export interface RepositorySnapshot {
  /** Read-model slices currently present in this projection. */
  included?: SnapshotSlice[];
  /** True when the requested slice revision already matched and no payload was serialized. */
  notModified?: boolean;
  /** Content-aware revision for the selected slice set. */
  revision?: {
    branch?: string | null;
    head?: string | null;
    worktreeHash?: string;
    subjectRevision?: string;
    slices?: Partial<Record<SnapshotSlice, string>>;
  };
  repository?: {
    root?: string;
    branch?: string;
    changes?: string[];
    configurationChanges?: string[];
    unrelatedChanges?: string[];
    publishReady?: boolean;
    [key: string]: unknown;
  };
  workItems: WorkItemSummary[];
  initiatives: InitiativeSummary[];
  selectedWorkId: string | null;
  selectedInitiativeId: string | null;
  initiative: InitiativeSnapshot | null;
  workflow: StoryWorkflow | null;
  /**
   * Governed mobile/design evidence joined by the engine from committed Story state. Reading this
   * never contacts an MCP server; network readiness is an explicit user action in the panel.
   */
  visualAssurance?: VisualAssuranceSnapshot | null;
  report?: StoryWorkflowReport | null;
  /**
   * The five verbs, planned by the engine. `[SPK:REQ-150]` `[SPK:REQ-151]`
   *
   * Projected, never recomputed. The milestone and checkpoint here are the ones `sflow specify` and
   * its siblings print, because they come from the same `planFastPath` call — which is the only way
   * the rail and the CLI can be guaranteed to agree about where a Story stands.
   *
   * Null for a work type that declares no fast path. Nothing invents verbs for a profile that does
   * not have them, and the phase rail stays what it always was.
   */
  fastPath?: FastPathProjection | null;
  modelFreedom?: ModelFreedomSnapshot;
  documents?: StoryArtifact[];
  detachedDocuments?: StoryArtifact[];
  worldModel?: {
    root: string;
    generatedAt: string | null;
    rebuildReason: string | null;
    readiness?: {
      status: string;
      ready: boolean;
      source: string | null;
      staleness?: {
        policy: 'ignore' | 'warn' | 'fail';
        fresh: boolean;
        stale: boolean;
        blocks: boolean;
        warns: boolean;
        ignored: boolean;
        status: string;
        message: string | null;
      };
      command: string;
    } | null;
    views: Array<{ id: string; references: string[] }>;
    files?: Array<{ path: string; content?: string }>;
  };
  /**
   * The portfolio, of which only the approval authorities are read: an Epic cannot start until at
   * least one is populated, and finding that out after asking five questions is a poor greeting.
   */
  portfolio?: {
    approvalAuthorities?: Record<string, {
      label?: string; allowAnyGitIdentity?: boolean;
      members?: Array<{ name?: string; email?: string; githubLogin?: string; login?: string }>;
    }>;
    [key: string]: unknown;
  } | null;
  portfolioPath?: string;
  portfolioText?: string;
  /**
   * What this organisation builds, as a tree, held by the lead repository. Distinct from the
   * repositories: one business capability is often several repositories, and the shape of what is
   * built is not the shape of where it is stored.
   */
  capabilityMap?: {
    capabilities?: CapabilityNode[];
    repositories?: string[];
    error?: string;
  } | null;
  capabilityMapPath?: string;
  /**
   * The workflow definition, of which only the working lenses are read: starting an Epic has to
   * offer the lenses this repository declares, not a list this extension keeps.
   */
  definition?: {
    approvalSecurity?: {
      profile?: 'poc' | 'team' | 'regulated';
      allowSelfApproval?: boolean;
      autoEnrollNewIdentities?: boolean;
    };
    approvalAuthorities?: Record<string, {
      label?: string; allowAnyGitIdentity?: boolean;
      members?: Array<{ name?: string; email?: string; githubLogin?: string; login?: string }>;
    }>;
    personas?: Record<string, { label?: string; description?: string }>;
    phases?: Record<string, {
      label?: string;
      agents?: string[];
      worldModel?: { views?: string[] };
    }>;
    planning?: { promptSource?: string };
    ast?: {
      mode?: 'auto' | 'off';
      fallback?: 'host-and-text' | 'text-only';
      evidence?: { mode?: 'replayable' | 'identified' | 'off'; store?: string };
      generatedRoots?: string[];
      budgets?: { maxFiles?: number; maxBytes?: number; maxFileBytes?: number };
      languages?: Record<string, {
        mode?: 'auto' | 'off'; minimumAssurance?: 'text' | 'syntax' | 'semantic';
        syntaxProvider?: string; semanticProvider?: string; semanticProfile?: string;
      }>;
      predicates?: Array<{
        id?: string; mode?: 'required' | 'advisory'; type?: 'path-exists' | 'symbol-exists';
        path?: string; symbol?: string; minimumAssurance?: 'text' | 'syntax' | 'semantic';
      }>;
    };
    worldModel?: {
      views?: string[];
      outputDir?: string;
      promptSource?: string;
      stateFetchTimeoutMs?: number;
      generation?: { parallel?: boolean; maxWorkers?: number; strategy?: 'view' };
      materialization?: {
        mode?: 'explicit' | 'on-demand' | 'disabled';
        publish?: 'governed' | 'local';
        lookahead?: 'none' | 'next-phase';
        depth?: 'light' | 'phase';
        confirmation?: 'prompt' | 'automatic';
      };
      grounding?: 'off' | 'warn' | 'enforce';
      staleness?: 'warn' | 'fail' | 'ignore';
      injection?: {
        placeholder?: string;
        mode?: 'replace' | 'append' | 'off';
        maxBytes?: number;
        rules?: unknown[];
      };
      [key: string]: unknown;
    };
    /** Whether workflow progress is recorded on an orphan branch, and which one. */
    ledger?: { enabled?: boolean; branch?: string };
    [key: string]: unknown;
  };
  definitionPath?: string;
  definitionText?: string;
  /** Validation may fail while the configuration inventory remains safely readable. */
  configurationValid?: boolean;
  configurationError?: string | null;
  /**
   * Which model each task routes to, joined to the phases that route by it `[ADP:REQ-020]`.
   *
   * The indirection that makes routing maintainable also makes it invisible: `workflow.yml` says
   * `task: code` and never says which model that is. The engine resolves the join and this renders
   * it; recomputing the resolution here would be a second opinion about which model the kernel is
   * going to use, and a reader seeing two answers has no way to tell which one is real.
   */
  modelRouting?: ModelRoutingProjection | null;
  /**
   * The editable file sets: artifact templates, working-lens prompts, repository skills and prompt
   * packs. They arrive with their contents, but the extension only reads their paths — editing
   * happens in ordinary editor tabs, against the files on disk.
   */
  /**
   * Artifact templates, each carrying its catalog name and what references it.
   *
   * A bare filename cannot tell a reader which of eleven templates the specification phase renders,
   * or whether deleting one would break four work types. `catalogId` is null for a template no
   * catalog entry names — which is every template in a repository that has not adopted one, and is
   * a normal state rather than a missing value.
   */
  templates?: Array<{
    path: string; name: string; bytes?: number; content?: string;
    catalogId?: string | null; catalogLabel?: string | null; catalogKind?: string | null;
    usedBy?: string[];
  }>;
  agentPrompts?: Array<{ path: string; name: string; bytes?: number; content?: string }>;
  personaPrompts?: Array<{ path: string; name: string; bytes?: number; content?: string }>;
  prompts?: Array<{ path: string; name: string; bytes?: number; content?: string }>;
  repositorySkills?: Array<{ path: string; name: string; bytes?: number; content?: string }>;
  /**
   * The prompt packs that ship with the product, as opposed to the ones a repository wrote.
   *
   * The snapshot has always carried these; nothing here read them, so a repository with no packs of
   * its own was shown "none" while every packaged pack sat unlisted beside it.
   */
  flowSkills?: Array<{
    id?: string; name?: string; description?: string; path: string; command?: string;
    packagePath?: string; repositoryPath?: string; argumentHint?: string | null;
    content?: string; bytes?: number; scope?: string; readOnly?: boolean;
  }>;
  agents?: Array<{
    id: string; scope: string; path: string; packagePath?: string | null; editable?: boolean;
    content?: string; sha256?: string; remoteResources?: number;
  }>;
  agentStatus?: Array<{
    id: string; scope: string; source: string; sourceSha256: string; locked: boolean;
    sourceChanged: boolean; status: 'local-only' | 'unlocked' | 'stale' | 'needs-sync' | 'ready';
    dependencies: Array<{
      id: string; type: 'skill' | 'template' | 'generated'; optional: boolean; locked: boolean;
      sha256: string | null; status: string;
    }>;
  }>;
  agentMappings?: {
    path: string; exists: boolean; content?: string;
    rows?: Array<{ copilotAgent: string; agentId: string; source: string }>;
  };
  agentsLock?: { path: string; exists: boolean; content?: string };
  /** Governed MCP policy joined to host configuration by server name; never contains credentials. */
  mcp?: {
    servers: Array<{
      id: string; label: string; hostReference: string; agents: string[]; phases: string[];
      tools: string[]; required: boolean; approval: string; configured: boolean; sources: string[];
      readiness?: 'ready' | 'needs-host-setup' | 'misconfigured'; readinessReasons?: string[];
      evidence?: { captureToolCalls?: boolean; captureResults?: boolean };
    }>;
    inventory: Array<{ surface: string; path: string; name: string | null; error: string | null }>;
    errors: string[];
    warnings: string[];
  };
  /** Who this repository will attribute a decision to. Approvals turn on it. */
  identities?: {
    git?: { name?: string; email?: string; login?: string | null };
    github?: string | null;
    assurance?: Record<string, string>;
  };
  session?: { persona?: string; workId?: string | null } | null;
  /** `doctor`, as the engine reports it: what would stop governed work from running here. */
  diagnostics?: {
    repository?: string;
    branch?: string;
    healthy?: boolean;
    counts?: Record<string, number>;
    checks?: Array<{ id: string; status: string; message: string; fix?: string | null }>;
  };
  /** Approvals waiting on this person, as `inbox` reports them. */
  approvalInbox?: { count?: number; fetched?: boolean; items?: unknown[] };
  /** The append-only workflow ledger, which is what makes progress recoverable from Git. */
  ledger?: { enabled?: boolean; config?: { branch?: string } };
  [key: string]: unknown;
}

export type SnapshotSlice = 'repository' | 'lifecycle' | 'configuration' | 'capabilities' | 'integrations' | 'diagnostics';

export interface VisualEvidenceRecord {
  id: string;
  kind: 'tool-call' | 'design-source' | 'visual-artifact' | string;
  server?: string; tool?: string; phase?: string; targetGeneration?: number;
  agent?: string; recordedAt?: string;
  fileKey?: string; fileVersion?: string; fileVersionCreatedAt?: string | null;
  nodes?: string[]; format?: string;
  profileId?: string; screenId?: string; stateId?: string;
  outputSha256?: string;
  output?: { path?: string; sha256?: string; bytes?: number; mediaType?: string } | null;
}

export interface VisualComparison {
  id: string; status: 'pass' | 'warn' | 'fail' | string; disposition?: string;
  profileId?: string; generatedAt?: string; differingPixels?: number;
  differingPixelRatio?: number; path?: string;
  expected?: { recordId?: string | null; path?: string; sha256?: string };
  actual?: { recordId?: string | null; path?: string; sha256?: string };
  diffImage?: { path?: string; sha256?: string; bytes?: number } | null;
}

export interface VisualAssuranceSnapshot {
  schemaVersion: 1;
  configured: boolean;
  workId: string;
  phase: string | null;
  itemDirectory: string;
  policy: {
    designSources?: Record<string, unknown> | null;
    verification?: {
      coverage?: string;
      profiles?: Array<{ id: string; label?: string; width?: number; height?: number; deviceScaleFactor?: number }>;
      comparison?: Record<string, unknown>;
    } | null;
  };
  designSources: {
    approvedSet?: {
      path?: string; sha256?: string; setSha256?: string; phase?: string; generation?: number;
      records?: Array<{ recordId: string; fileKey?: string; fileVersion?: string; nodes?: string[]; outputPath?: string; outputSha256?: string }>;
    } | null;
    candidates: Array<{ fileKey?: string; approvedRecordId?: string; approvedVersion?: string; candidateRecordId?: string; candidateVersion?: string; classification?: string }>;
    stale: Array<{ fileKey?: string; candidateVersion?: string; classification?: string }>;
    errors: string[]; warnings: string[]; passes: string[];
  };
  inventory?: {
    path: string; sha256: string; bytes: number;
    digest: {
      digestSha256: string; generatedAt?: string;
      counts: { nodes: number; components: number; componentSets: number; instances: number; nodeTypes?: Record<string, number> };
      names?: string[]; variantProperties?: string[]; variables?: string[]; styles?: string[];
    };
  } | null;
  evidence: { records: VisualEvidenceRecord[]; errors: string[]; warnings: string[]; passes: string[] };
  coverage?: {
    status: string; mode: string; phase: string; generation: number | null;
    profiles: Array<{ id: string; label?: string; width?: number; height?: number; deviceScaleFactor?: number }>;
    covered: Array<{ profileId: string; recordId: string; outputSha256?: string; dimensions?: { width: number; height: number } | null }>;
    uncovered: string[]; stale: string[];
    duplicates: Array<{ profileId: string; records: string[] }>;
    warnings: string[]; errors: string[];
  } | null;
  comparisons: VisualComparison[];
  readiness: { status: 'not-configured' | 'blocked' | 'attention' | 'ready'; errors: string[]; warnings: string[]; passes: string[] };
}

/** The phases in declared order, joined to the state each one is in. */
export function phasesInOrder(initiative: InitiativeSnapshot): Array<{
  id: string;
  label: string;
  status: PhaseStatus;
  current: boolean;
  outputs: InitiativeOutput[];
}> {
  const { state } = initiative;
  return state.phaseOrder.map((id) => {
    const phase = state.phases[id];
    return {
      id,
      label: phase?.label ?? id,
      status: phase?.status ?? 'pending',
      current: state.currentPhase === id,
      outputs: Object.values(phase?.outputs ?? {})
    };
  });
}

/**
 * Packs, joined to the outputs they contain.
 *
 * Members are `<phase>/<output>`, and a member may legitimately not be authored yet — that is the
 * normal state before a phase runs, so a missing output is reported as absent rather than skipped.
 */
export function packsWithMembers(initiative: InitiativeSnapshot): Array<{
  id: string;
  label: string;
  members: Array<{ phase: string; output: string; authored: boolean; artifact: InitiativeOutput | null }>;
}> {
  const packs = initiative.state.resolution.packs ?? [];
  return packs.map((pack) => ({
    id: pack.id,
    label: pack.label ?? pack.id,
    members: pack.members.map((member) => {
      const separator = member.indexOf('/');
      const phase = separator < 0 ? member : member.slice(0, separator);
      const output = separator < 0 ? '' : member.slice(separator + 1);
      const artifact = initiative.state.phases[phase]?.outputs?.[output] ?? null;
      return { phase, output, authored: Boolean(artifact?.sha256), artifact };
    })
  }));
}

/** Stories grouped by the repository they land in, matching how `epic impact` reports them. */
export function storiesByRepository(initiative: InitiativeSnapshot): Array<{ repository: string; stories: BreakdownStory[] }> {
  const stories = initiative.breakdown?.stories ?? [];
  const grouped = new Map<string, BreakdownStory[]>();
  for (const story of stories) {
    const existing = grouped.get(story.repository);
    if (existing) existing.push(story);
    else grouped.set(story.repository, [story]);
  }
  return [...grouped.entries()]
    .map(([repository, entries]) => ({ repository, stories: entries }))
    .sort((left, right) => left.repository.localeCompare(right.repository));
}

/**
 * True when editing this artifact in place would break something.
 *
 * An approved artifact is pinned by hash into a bundle and into whatever consumed it downstream, so
 * editing it silently invalidates approvals that already happened. A merely *generated* artifact is
 * still being worked on — that is exactly when a human should be able to correct it — so it stays
 * writable. The distinction is the phase's own record, not a guess from the file.
 */
export function isApprovalPinned(output: InitiativeOutput): boolean {
  return output.status === 'approved' && Boolean(output.sha256);
}
