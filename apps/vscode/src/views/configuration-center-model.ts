/** Pure models and governed YAML edits for the Configuration Center. */
import YAML from 'yaml';
import {
  BUILTIN_VIEW_IDS, normalizeBuiltInViewReference
} from '../../../../src/world-model/registry/views.mjs';
import {
  worldModelViewContractCatalog, worldModelViewIdentity
} from '../../../../src/world-model-views.mjs';
import type { ModelRoutingProjection, RepositorySnapshot } from '../cli/snapshot.ts';

/**
 * Every tab, in the order the strip renders them.
 *
 * A list rather than a bare union because the panel has to check an incoming tab name at runtime,
 * and the hand-written allowlist it used to check against had already drifted: 'models' shipped as a
 * rendered tab whose own strip button was silently dropped. Deriving the type from the list makes
 * adding a tab and accepting it the same edit.
 */
export const CONFIGURATION_TABS = ['overview', 'auto', 'world-model', 'models', 'templates', 'people', 'mcp'] as const;

export type ConfigurationTab = (typeof CONFIGURATION_TABS)[number];

/**
 * An artifact template as the Center shows it: the name the catalog gave it, and what references it.
 *
 * Moved here from the sidebar because a template is configuration, and the Center is where
 * configuration lives. The two facts that matter are the same ones the sidebar carried — what this
 * template is called, and whether anything would break if it went away.
 */
export interface ConfigurationFile {
  path: string;
  name: string;
  /** The catalog's name for it, or the filename when it is not catalogued. */
  label: string;
  catalogId: string | null;
  kind: string | null;
  /**
   * Which phases reference it. Three states, not two: `[]` means nothing does and it is safe to
   * remove, `null` means the engine did not compute usage, and answering "unused" there would be a
   * confident wrong answer to the one question the column exists for.
   */
  usedBy: string[] | null;
  /**
   * Packaged files ship with the product, so an edit to one is taken back by an upgrade. Only skills
   * carry this — `textFiles` gives templates and prompts a path, a name and bytes and nothing else,
   * so a packaged/repository split for those would be a field nothing can ever set.
   */
  packaged: boolean;
  description: string | null;
}

export interface FileSetView {
  id: 'templates' | 'prompts' | 'skills' | 'agents';
  label: string;
  files: ConfigurationFile[];
}
export type AuthorityScope = 'story' | 'initiative';

export interface ProfileView { name: string; role: string; }
export interface AuthorityMemberView { name: string; email: string; githubLogin: string; }
export interface AuthorityView {
  id: string; label: string; scope: AuthorityScope; allowAnyGitIdentity: boolean;
  members: AuthorityMemberView[];
}
export interface McpServerView {
  id: string; label: string; hostReference: string; agents: string[]; phases: string[];
  tools: string[]; required: boolean; approval: 'confirm' | 'host'; configured: boolean;
  sources: string[]; captureToolCalls: boolean; captureResults: boolean;
  readiness?: 'ready' | 'needs-host-setup' | 'misconfigured'; readinessReasons?: string[];
}
export interface WorldModelSettingsView {
  format: 'legacy-v3' | 'registered-v4';
  views: string[];
  sourceRoots: string[];
  sharedRoots: string[];
  outputDir: string;
  promptSource: string;
  stateFetchTimeoutMs: number;
  generation: { parallel: boolean; maxWorkers: number; strategy: 'view' };
  v4: {
    composer: 'deterministic' | 'model-optional' | 'model-required';
    consumer: 'developer' | 'architect' | 'tester' | 'business' | 'operations' | 'security' | 'release';
    cachePolicy: 'reuse-valid' | 'rebuild';
    totalMaximumOutputTokens: number;
  };
  materialization: {
    mode: 'explicit' | 'on-demand' | 'disabled'; publish: 'governed' | 'local';
    lookahead: 'none' | 'next-phase'; depth: 'light' | 'phase';
    confirmation: 'prompt' | 'automatic';
  };
  grounding: 'off' | 'warn' | 'enforce';
  staleness: 'warn' | 'fail' | 'ignore';
  injection: { placeholder: string; mode: 'replace' | 'append' | 'off'; maxBytes: number; rulesCount: number };
}
export type AutoEligibility = 'disabled' | 'plan-only' | 'bounded';
export interface AutoSettingsView {
  enabled: boolean;
  workTypes: Array<{ id: string; label: string; eligibility: AutoEligibility }>;
}
export interface WorldModelPhaseUsage {
  id: string;
  label: string;
  views: string[];
  depth: string;
  source: 'shared-phase' | 'workflow-override' | 'disabled';
}
export interface WorldModelWorkflowUsage {
  id: string;
  label: string;
  mode: string;
  phases: WorldModelPhaseUsage[];
}
export interface ConfigurationCenterView {
  profile: ProfileView;
  /** The repository identity the kernel will attribute governed decisions to. */
  gitIdentity: AuthorityMemberView | null;
  approvalSecurityProfile: 'poc' | 'team' | 'regulated';
  approvalAllowSelfApproval: boolean;
  approvalAutoEnrollNewIdentities: boolean;
  /** Artifact templates with their catalog names and usage, absorbed from the sidebar. */
  fileSets: FileSetView[];
  authorities: AuthorityView[];
  mcpServers: McpServerView[];
  agents: Array<{ id: string; label: string }>;
  phases: Array<{ id: string; label: string }>;
  mcpErrors: string[];
  mcpWarnings: string[];
  worldModel: WorldModelSettingsView;
  /** Repository master switch and work-type opt-ins. Capability policy can only tighten these. */
  auto: AutoSettingsView;
  /**
   * Grounding state, as opposed to grounding policy: whether the world model has been built, what
   * views exist, and the engine's own reason for rebuilding. Absorbed from the sidebar, which was
   * the only surface that showed it — the Center's world-model tab configured a thing whose current
   * state it never displayed.
   */
  worldModelStatus: {
    built: boolean;
    root: string;
    generatedAt: string | null;
    rebuildReason: string | null;
    readiness: NonNullable<RepositorySnapshot['worldModel']>['readiness'];
    format: string | null;
    summary: NonNullable<RepositorySnapshot['worldModel']>['summary'] | null;
    /** Content-addressed, inert drill-downs into the verified state-backed WMB store. */
    expansion: Array<{ kind: string; id: string; sha256: string; path?: string | null; ref: string }>;
    views: Array<{
      id: string; reference: string; path: string; references: string[]; generated: boolean;
      workflowCount: number; phaseCount: number;
      status: string | null; required: boolean; cache: string | null;
      counts: { total: number; available: number; partial: number; unavailable: number; contradicted: number; stale: number } | null;
      preview: { text: string; bytes: number; truncated: boolean } | null;
      expansion: Array<{ kind: string; id: string; sha256: string; path?: string | null; ref: string }>;
    }>;
    workflows: WorldModelWorkflowUsage[];
  };
  /** Validated configuration edits waiting to be published, and anything blocking that. */
  publish: { changes: string[]; unrelated: string[]; branch: string };
  /**
   * Whether workflow progress is recorded, and where. The sidebar said this in the Configuration
   * group's own description line; with the group gone it has to be said here or not at all.
   */
  ledger: { enabled: boolean; branch: string | null; summary: string; detail: string };
  /** Whether the lifecycle can run without a model, and what stops it. */
  modelFreedom: { status: string; mode: string; blockers: string[]; warnings: string[] } | null;
  /**
   * Task → model, as the engine resolves it. Read-only on purpose: the mapping is a governed file,
   * and a panel that edited it in place would be a second way to change policy that no review saw.
   */
  modelRouting: ModelRoutingProjection | null;
}

export interface McpDraft extends Omit<McpServerView, 'configured' | 'sources'> { previousId?: string; }
export interface AuthorityDraft extends AuthorityView { previousId?: string; }
export type WorldModelDraft = Omit<WorldModelSettingsView, 'format' | 'v4' | 'injection'> & {
  /** Optional so older extension messages preserve rather than erase the new policy. */
  format?: WorldModelSettingsView['format'];
  /** Optional so drafts created before registered-v4 remain valid and non-destructive. */
  v4?: Partial<WorldModelSettingsView['v4']>;
  injection: Omit<WorldModelSettingsView['injection'], 'rulesCount'>;
};
export interface AutoDraft {
  enabled: boolean;
  workTypes: Array<{ id: string; eligibility: AutoEligibility }>;
}

export interface ConfigurationTextRevision {
  definitionText: string;
  portfolioText: string;
}

export function configurationRefreshDecision(
  dirty: boolean,
  rendered: ConfigurationTextRevision,
  current: ConfigurationTextRevision
): 'render' | 'hold' | 'conflict' {
  if (!dirty) return 'render';
  return rendered.definitionText === current.definitionText && rendered.portfolioText === current.portfolioText
    ? 'hold'
    : 'conflict';
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORLD_MODEL_VIEW_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const WORLD_MODEL_FORMATS = new Set(['legacy-v3', 'registered-v4']);
const WORLD_MODEL_V4_COMPOSERS = new Set(['deterministic', 'model-optional', 'model-required']);
const WORLD_MODEL_V4_CONSUMERS = new Set([
  'developer', 'architect', 'tester', 'business', 'operations', 'security', 'release'
]);
const WORLD_MODEL_V4_CACHE_POLICIES = new Set(['reuse-valid', 'rebuild']);
const AUTO_ELIGIBILITIES = new Set<AutoEligibility>(['disabled', 'plan-only', 'bounded']);
const email = /^[^@\s]+@[^@\s]+$/;

function member(value: unknown): AuthorityMemberView {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    name: String(row.name ?? ''), email: String(row.email ?? ''),
    githubLogin: String(row.githubLogin ?? row.login ?? '')
  };
}

function authorityRows(source: unknown, scope: AuthorityScope): AuthorityView[] {
  const rows = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, Record<string, unknown>> : {};
  return Object.entries(rows).map(([id, value]) => ({
    id, scope, label: String(value.label ?? id),
    allowAnyGitIdentity: value.allowAnyGitIdentity === true,
    members: Array.isArray(value.members) ? value.members.map(member) : []
  }));
}

/**
 * The three editable file sets, absorbed from the Configuration sidebar.
 *
 * Ordering within a set is alphabetical by the name a reader sees, except that a repository's own
 * skills come before the packaged ones — those are the files a team wrote and can change.
 */
/** The append-only workflow ledger, in the words the sidebar used. */
function ledgerStatus(snapshot: RepositorySnapshot): ConfigurationCenterView['ledger'] {
  const ledger = snapshot.definition?.ledger as { enabled?: boolean; branch?: string } | undefined;
  const branch = ledger?.branch ?? null;
  return ledger?.enabled
    ? {
      enabled: true, branch,
      summary: `state on ${branch ?? 'ledger'}`,
      detail: `Workflow progress is recorded on the orphan branch '${branch}'.`
    }
    : {
      enabled: false, branch: null,
      summary: 'no state branch',
      detail: 'No append-only workflow ledger is enabled for this repository.'
    };
}

function fileSets(snapshot: RepositorySnapshot): FileSetView[] {
  const file = (entry: {
    path: string; name: string; catalogId?: string | null; catalogLabel?: string | null;
    catalogKind?: string | null; usedBy?: string[]; packaged?: boolean; description?: string;
  }): ConfigurationFile => ({
    path: entry.path,
    name: entry.name,
    label: entry.catalogLabel ?? entry.name,
    catalogId: entry.catalogId ?? null,
    kind: entry.catalogKind ?? null,
    usedBy: entry.usedBy ?? null,
    packaged: Boolean(entry.packaged),
    description: entry.description ?? null
  });
  const byName = (left: ConfigurationFile, right: ConfigurationFile): number => left.label.localeCompare(right.label);

  const skills = [
    ...(snapshot.repositorySkills ?? []).map((entry) => file(entry)).sort(byName),
    // The snapshot has carried the packaged skills as `flowSkills` all along. A repository that had
    // written none of its own used to be told it had no agents while every shipped pack sat unlisted.
    ...(snapshot.flowSkills ?? []).map((skill) => file({
      path: skill.packagePath ?? skill.path,
      name: skill.id ?? skill.name ?? skill.path,
      packaged: true,
      description: skill.description
    })).sort(byName)
  ];

  return [
    { id: 'templates', label: 'Artifact templates', files: (snapshot.templates ?? []).map((entry) => file(entry)).sort(byName) },
    {
      id: 'prompts',
      label: 'Repository prompts',
      files: (snapshot.prompts ?? snapshot.agentPrompts ?? snapshot.personaPrompts ?? []).map((entry) => file(entry)).sort(byName)
    },
    { id: 'skills', label: 'Skills and prompt packs', files: skills },
    {
      id: 'agents',
      label: 'Agents and prompts',
      files: [
        ...(snapshot.agents ?? []).map((agent) => file({
          path: agent.path,
          name: agent.id,
          // A packaged agent is read-only; only a repository one is the team's to change, and the
          // scope is the word the tree used for exactly that distinction.
          packaged: agent.editable === false,
          description: agent.scope
        })),
        ...(snapshot.agentMappings
          ? [file({
            path: snapshot.agentMappings.path,
            name: 'agent-mappings.yml',
            description: snapshot.agentMappings.exists ? 'Copilot → governed agent routing' : 'same-name routing'
          })]
          : [])
      ]
    }
  ];
}

/** Read the engine's effective workflow routing; the VS Code surface never re-resolves policy. */
export function worldModelWorkflowUsage(snapshot: RepositorySnapshot): WorldModelWorkflowUsage[] {
  return (snapshot.worldModel?.workflows ?? []).map((workflow) => ({
    ...workflow,
    phases: workflow.phases.map((phase) => ({ ...phase, views: [...phase.views] }))
  }));
}

export function configurationCenterView(snapshot: RepositorySnapshot, profile: ProfileView): ConfigurationCenterView {
  const definition = snapshot.definition ?? {};
  const worldModel = definition.worldModel ?? {};
  const generation = worldModel.generation ?? {};
  const materialization = worldModel.materialization ?? {};
  const injection = worldModel.injection ?? {};
  const phaseRows = definition.phases ?? {};
  const workTypeRows = definition.workTypes ?? {};
  const agentLabels = new Map((snapshot.agents ?? []).map((entry) => [entry.id, entry.id]));
  const gitIdentity = snapshot.identities?.git;
  const gitEmail = String(gitIdentity?.email ?? '').trim().toLowerCase();
  const gitLogin = String(gitIdentity?.login ?? snapshot.identities?.github ?? '').trim();
  const approvalSecurityProfile = definition.approvalSecurity?.profile;
  const normalizedApprovalSecurityProfile = approvalSecurityProfile === 'poc' || approvalSecurityProfile === 'regulated'
    ? approvalSecurityProfile : 'team';
  const approvalSecurityDefault = normalizedApprovalSecurityProfile !== 'regulated';
  const workflowUsage = worldModelWorkflowUsage(snapshot);
  const defaultWorldModelViews = worldModel.format === 'registered-v4'
    ? BUILTIN_VIEW_IDS.map((id) => normalizeBuiltInViewReference(id).reference)
    : ['business', 'architecture', 'development', 'testing', 'release', 'operations', 'security'];
  const built = Boolean(snapshot.worldModel?.generatedAt || snapshot.worldModel?.readiness?.ready);
  const modelRoot = snapshot.worldModel?.root ?? 'singularity/world-model';
  const catalog = worldModelViewContractCatalog(definition, [
    ...(worldModel.views ?? defaultWorldModelViews),
    ...(snapshot.worldModel?.views ?? []).map((view) => view.id),
    ...workflowUsage.flatMap((workflow) => workflow.phases.flatMap((phase) => phase.views))
  ]);
  const snapshotViews = new Map((snapshot.worldModel?.views ?? []).flatMap((view) => {
    const identity = worldModelViewIdentity(definition, view.id);
    return identity ? [[identity.id, view] as const] : [];
  }));
  const fileInventory = snapshot.worldModel?.files;
  const generatedPaths = new Set((fileInventory ?? []).map((file) => file.path));
  return {
    profile,
    gitIdentity: gitEmail || gitLogin ? {
      name: String(gitIdentity?.name ?? '').trim() || gitEmail || gitLogin,
      email: gitEmail,
      githubLogin: gitLogin
    } : null,
    approvalSecurityProfile: normalizedApprovalSecurityProfile,
    approvalAllowSelfApproval: definition.approvalSecurity?.allowSelfApproval ?? approvalSecurityDefault,
    approvalAutoEnrollNewIdentities: definition.approvalSecurity?.autoEnrollNewIdentities ?? approvalSecurityDefault,
    /**
     * Read straight from the snapshot the engine already annotates. The catalog join happens once,
     * server-side; recomputing "what uses this template" here would be the designer and the kernel
     * holding two opinions about whether a file is safe to delete.
     */
    worldModelStatus: {
      built,
      root: modelRoot,
      generatedAt: snapshot.worldModel?.generatedAt ?? null,
      rebuildReason: snapshot.worldModel?.rebuildReason ?? null,
      readiness: snapshot.worldModel?.readiness ?? null,
      format: snapshot.worldModel?.format ?? null,
      summary: snapshot.worldModel?.summary ?? null,
      expansion: [...(snapshot.worldModel?.expansion ?? [])],
      views: catalog.map(({ id, reference }) => {
        const snapshotView = snapshotViews.get(id);
        const path = snapshotView?.path ?? `${modelRoot}/views/${id}.md`;
        const workflowMatches = workflowUsage.filter((workflow) =>
          workflow.phases.some((phase) => phase.views.includes(id)));
        const phaseCount = workflowMatches.reduce((count, workflow) =>
          count + workflow.phases.filter((phase) => phase.views.includes(id)).length, 0);
        return {
          id, reference, path,
          references: [...(snapshotView?.references ?? [])],
          generated: snapshotView?.status
            ? snapshotView.status === 'available'
            : built && (fileInventory === undefined || generatedPaths.has(path)),
          workflowCount: workflowMatches.length,
          phaseCount,
          status: snapshotView?.status ?? null,
          required: snapshotView?.required === true,
          cache: snapshotView?.cache ?? null,
          counts: snapshotView?.counts ?? null,
          preview: snapshotView?.preview ?? null,
          expansion: [...(snapshotView?.expansion ?? [])]
        };
      }),
      workflows: workflowUsage
    },
    ledger: ledgerStatus(snapshot),
    publish: {
      changes: [...(snapshot.repository?.configurationChanges ?? [])],
      unrelated: [...(snapshot.repository?.unrelatedChanges ?? [])],
      branch: snapshot.repository?.branch ?? 'current branch'
    },
    modelFreedom: snapshot.modelFreedom
      ? {
        status: snapshot.modelFreedom.summary?.status ?? 'unknown',
        mode: snapshot.modelFreedom.mode,
        blockers: [...(snapshot.modelFreedom.blockers ?? [])],
        warnings: [...(snapshot.modelFreedom.warnings ?? [])]
      }
      : null,
    fileSets: fileSets(snapshot),
    authorities: [
      ...authorityRows(definition.approvalAuthorities, 'story'),
      ...authorityRows(snapshot.portfolio?.approvalAuthorities, 'initiative')
    ].sort((left, right) => left.scope.localeCompare(right.scope) || left.label.localeCompare(right.label)),
    mcpServers: (snapshot.mcp?.servers ?? []).map((server) => ({
      ...server,
      approval: server.approval === 'host' ? 'host' : 'confirm',
      captureToolCalls: server.evidence?.captureToolCalls !== false,
      captureResults: server.evidence?.captureResults === true
    })),
    agents: [...agentLabels].map(([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)),
    phases: Object.entries(phaseRows).map(([id, phase]) => ({ id, label: phase.label ?? id })),
    mcpErrors: snapshot.mcp?.errors ?? [], mcpWarnings: snapshot.mcp?.warnings ?? [],
    // Rendered exactly as the engine resolved it. Recomputing the join here would let the panel and
    // the kernel disagree about which model a task reaches.
    modelRouting: snapshot.modelRouting ?? null,
    auto: {
      enabled: definition.auto?.enabled === true,
      workTypes: Object.entries(workTypeRows).map(([id, workType]) => ({
        id,
        label: workType.label ?? id,
        eligibility: AUTO_ELIGIBILITIES.has(workType.auto?.eligibility as AutoEligibility)
          ? workType.auto!.eligibility as AutoEligibility
          : 'disabled'
      })).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
    },
    worldModel: {
      format: worldModel.format === 'registered-v4' ? 'registered-v4' : 'legacy-v3',
      views: worldModel.views ?? defaultWorldModelViews,
      sourceRoots: Array.isArray(worldModel.sourceRoots) ? worldModel.sourceRoots : [],
      sharedRoots: Array.isArray(worldModel.sharedRoots) ? worldModel.sharedRoots : [],
      outputDir: worldModel.outputDir ?? 'singularity/world-model',
      promptSource: worldModel.promptSource ?? 'singularity/prompts/worldmodel-builder.md',
      stateFetchTimeoutMs: worldModel.stateFetchTimeoutMs ?? 10_000,
      generation: {
        parallel: generation.parallel !== false,
        maxWorkers: generation.maxWorkers ?? 4,
        strategy: generation.strategy ?? 'view'
      },
      v4: {
        composer: worldModel.v4?.composer ?? 'deterministic',
        consumer: worldModel.v4?.consumer ?? 'developer',
        cachePolicy: worldModel.v4?.cachePolicy ?? 'reuse-valid',
        totalMaximumOutputTokens: worldModel.v4?.totalMaximumOutputTokens ?? 5600
      },
      materialization: {
        mode: materialization.mode ?? 'explicit', publish: materialization.publish ?? 'governed',
        lookahead: materialization.lookahead ?? 'none', depth: materialization.depth ?? 'phase',
        confirmation: materialization.confirmation ?? 'prompt'
      },
      grounding: worldModel.grounding ?? 'off',
      staleness: worldModel.staleness ?? 'warn',
      injection: {
        placeholder: injection.placeholder ?? '{{WORLD_MODEL}}',
        mode: injection.mode ?? 'append', maxBytes: injection.maxBytes ?? 32_768,
        rulesCount: injection.rules?.length ?? 0
      }
    }
  };
}

export function validateAutoDraft(draft: AutoDraft, knownWorkTypeIds?: Iterable<string>): string[] {
  const errors: string[] = [];
  if (typeof draft.enabled !== 'boolean') errors.push('Repository Auto must be enabled or disabled explicitly.');
  if (!Array.isArray(draft.workTypes)) return [...errors, 'Work-type Auto settings must be a list.'];
  const seen = new Set<string>();
  for (const entry of draft.workTypes) {
    if (!KEBAB_ID.test(entry.id)) errors.push(`Work type '${entry.id}' must be lower-case kebab-case.`);
    if (seen.has(entry.id)) errors.push(`Work type '${entry.id}' appears more than once.`);
    seen.add(entry.id);
    if (!AUTO_ELIGIBILITIES.has(entry.eligibility)) {
      errors.push(`Work type '${entry.id}' has unknown Auto eligibility '${entry.eligibility}'.`);
    }
  }
  if (knownWorkTypeIds) {
    const known = new Set(knownWorkTypeIds);
    for (const id of seen) if (!known.has(id)) errors.push(`Unknown work type '${id}'. Reload configuration and try again.`);
    for (const id of known) if (!seen.has(id)) errors.push(`Work type '${id}' is missing. Reload configuration and try again.`);
  }
  return errors;
}

function unsafeRelative(value: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(value) || value.split(/[\\/]+/).includes('..');
}

export function validateWorldModelDraft(draft: WorldModelDraft): string[] {
  const errors: string[] = [];
  const format = draft.format ?? 'legacy-v3';
  const v4 = {
    composer: draft.v4?.composer ?? 'deterministic',
    consumer: draft.v4?.consumer ?? 'developer',
    cachePolicy: draft.v4?.cachePolicy ?? 'reuse-valid',
    totalMaximumOutputTokens: draft.v4?.totalMaximumOutputTokens ?? 5600
  };
  if (!WORLD_MODEL_FORMATS.has(format)) errors.push(`Unknown world-model format '${format}'.`);
  if (format === 'registered-v4') {
    const normalized: string[] = [];
    const unsupported: string[] = [];
    for (const view of draft.views) {
      try { normalized.push(normalizeBuiltInViewReference(view).reference); }
      catch { unsupported.push(view); }
    }
    if (unsupported.length) {
      errors.push(
        `Registered-v4 views must use installed active contracts (${BUILTIN_VIEW_IDS.join(', ')}); unsupported: ${unsupported.join(', ')}.`
      );
    }
    if (new Set(normalized).size !== normalized.length) {
      errors.push('Registered-v4 views must not repeat one contract with and without its exact version.');
    }
  }
  if (!WORLD_MODEL_V4_COMPOSERS.has(v4.composer)) errors.push(`Unknown registered-v4 composer '${v4.composer}'.`);
  if (!WORLD_MODEL_V4_CONSUMERS.has(v4.consumer)) errors.push(`Unknown registered-v4 consumer '${v4.consumer}'.`);
  if (!WORLD_MODEL_V4_CACHE_POLICIES.has(v4.cachePolicy)) errors.push(`Unknown registered-v4 cache policy '${v4.cachePolicy}'.`);
  if (!Number.isInteger(v4.totalMaximumOutputTokens)
      || v4.totalMaximumOutputTokens < 1 || v4.totalMaximumOutputTokens > 1_000_000) {
    errors.push('Registered-v4 total output budget must be from 1 through 1000000 tokens.');
  }
  if (!draft.views.length) errors.push('Declare at least one world-model view.');
  if (new Set(draft.views).size !== draft.views.length) errors.push('World-model views must not contain duplicates.');
  if (format !== 'registered-v4') {
    draft.views.forEach((view) => { if (!WORLD_MODEL_VIEW_ID.test(view)) errors.push(`World-model view '${view}' must be a lower-case kebab-case or namespaced dot ID.`); });
  }
  for (const [label, roots] of [
    ['Source roots', draft.sourceRoots ?? []], ['Shared roots', draft.sharedRoots ?? []]
  ] as const) {
    if (new Set(roots).size !== roots.length) errors.push(`${label} must not contain duplicates.`);
    roots.forEach((root) => {
      if (!root.trim() || root.trim() === '.' || root.includes('\\') || unsafeRelative(root.trim()) || /[*?\[\]{}]/.test(root)) {
        errors.push(`${label} entry '${root}' must be a repository-relative directory without '..' or glob characters.`);
      }
    });
  }
  if (!draft.outputDir.trim() || unsafeRelative(draft.outputDir.trim())) errors.push('Output directory must be a repository-relative path.');
  if (!draft.promptSource.trim() || (draft.promptSource.trim() !== 'builtin' && unsafeRelative(draft.promptSource.trim()))) errors.push("Prompt source must be 'builtin' or a repository-relative path.");
  if (!Number.isInteger(draft.stateFetchTimeoutMs) || draft.stateFetchTimeoutMs < 250 || draft.stateFetchTimeoutMs > 60_000) errors.push('State fetch timeout must be from 250 through 60000 milliseconds.');
  if (!Number.isInteger(draft.generation.maxWorkers) || draft.generation.maxWorkers < 1 || draft.generation.maxWorkers > 16) errors.push('Parallel workers must be from 1 through 16.');
  if (draft.materialization.confirmation === 'automatic' && draft.materialization.depth !== 'light') errors.push('Automatic materialization requires deterministic light depth. Model-driven phase generation must be confirmed.');
  if (!draft.injection.placeholder) errors.push('Injection placeholder must not be empty.');
  if (!Number.isInteger(draft.injection.maxBytes) || draft.injection.maxBytes < 1) errors.push('Injection budget must be a positive whole number of bytes.');
  return errors;
}

export function validateMcpDraft(draft: McpDraft): string[] {
  const errors: string[] = [];
  if (!KEBAB_ID.test(draft.id)) errors.push('Server ID must be lower-case kebab-case.');
  if (!draft.label.trim()) errors.push('Give the server a display label.');
  if (!KEBAB_ID.test(draft.hostReference)) errors.push('Host reference must be lower-case kebab-case.');
  if (new Set(draft.tools).size !== draft.tools.length) errors.push('Tool names must not contain duplicates.');
  if (draft.tools.some((tool) => !/^[A-Za-z0-9_.-]+$/.test(tool))) errors.push('Tools must be unqualified MCP tool names.');
  return errors;
}

export function validateAuthorityDraft(draft: AuthorityDraft): string[] {
  const errors: string[] = [];
  if (!KEBAB_ID.test(draft.id)) errors.push('Authority ID must be lower-case kebab-case.');
  if (!draft.label.trim()) errors.push('Give the authority a display label.');
  if (!draft.members.length && (draft.scope === 'initiative' || !draft.allowAnyGitIdentity)) {
    errors.push(draft.scope === 'initiative'
      ? 'Initiative authorities require at least one named Git identity.'
      : 'Add a member or allow any configured Git identity.');
  }
  const identities = new Set<string>();
  draft.members.forEach((entry, index) => {
    if (!entry.name.trim()) errors.push(`Member ${index + 1} needs a display name.`);
    const normalizedEmail = entry.email.trim().toLowerCase();
    const normalizedLogin = entry.githubLogin.trim().toLowerCase();
    if (draft.scope === 'initiative' && !email.test(normalizedEmail)) {
      errors.push(`Member ${index + 1} needs a valid Git email for Initiative approval.`);
    } else if (draft.scope === 'story' && !email.test(normalizedEmail) && !normalizedLogin) {
      errors.push(`Member ${index + 1} needs a valid Git email or GitHub login.`);
    }
    const identity = normalizedEmail ? `email:${normalizedEmail}` : `github:${normalizedLogin}`;
    if (identities.has(identity)) errors.push(`Member ${index + 1} duplicates ${normalizedEmail || normalizedLogin}.`);
    identities.add(identity);
  });
  return errors;
}

function document(text: string, label: string): YAML.Document.Parsed {
  const parsed = YAML.parseDocument(text);
  if (parsed.errors.length) throw new Error(`${label} is not valid YAML: ${parsed.errors[0]?.message}`);
  return parsed;
}

export function updateMcpYaml(text: string, draft: McpDraft | null, deleteId: string | null = null): string {
  const parsed = document(text, 'workflow.yml');
  if (deleteId) parsed.deleteIn(['mcpServers', deleteId]);
  if (draft) {
    const errors = validateMcpDraft(draft);
    if (errors.length) throw new Error(errors.join(' '));
    if (draft.previousId && draft.previousId !== draft.id) parsed.deleteIn(['mcpServers', draft.previousId]);
    parsed.setIn(['mcpServers', draft.id], {
      label: draft.label.trim(), hostReference: draft.hostReference.trim(),
      agents: draft.agents, phases: draft.phases, tools: draft.tools,
      required: draft.required, approval: draft.approval,
      evidence: { captureToolCalls: draft.captureToolCalls, captureResults: draft.captureResults }
    });
  }
  return String(parsed);
}

export function updateAuthorityYaml(text: string, draft: AuthorityDraft | null, deleteId: string | null = null): string {
  const parsed = document(text, 'governed configuration');
  if (deleteId) parsed.deleteIn(['approvalAuthorities', deleteId]);
  if (draft) {
    const errors = validateAuthorityDraft(draft);
    if (errors.length) throw new Error(errors.join(' '));
    const source = parsed.toJS() as { approvalAuthorities?: Record<string, Record<string, unknown>> } | null;
    const previous = source?.approvalAuthorities?.[draft.previousId || draft.id] ?? {};
    if (draft.previousId && draft.previousId !== draft.id) parsed.deleteIn(['approvalAuthorities', draft.previousId]);
    parsed.setIn(['approvalAuthorities', draft.id], {
      ...previous,
      label: draft.label.trim(),
      ...(draft.scope === 'story' ? { allowAnyGitIdentity: draft.allowAnyGitIdentity } : {}),
      members: draft.members.map((entry) => ({
        name: entry.name.trim(), email: entry.email.trim().toLowerCase(),
        ...(draft.scope === 'story' && entry.githubLogin.trim() ? { githubLogin: entry.githubLogin.trim() } : {})
      }))
    });
  }
  return String(parsed);
}

/**
 * Add the resolved repository identity without producing duplicate authority members.
 *
 * Git email is the primary identity and authenticated GitHub login is the fallback. When a group
 * already has either one, enrich that row rather than creating a second person that could appear
 * to satisfy a multi-reviewer threshold.
 */
export function authorityWithMember(
  group: AuthorityView,
  identity: AuthorityMemberView
): { authority: AuthorityView; changed: boolean } {
  const normalized = {
    name: identity.name.trim(),
    email: identity.email.trim().toLowerCase(),
    githubLogin: identity.githubLogin.trim()
  };
  const emailKey = normalized.email.toLowerCase();
  const loginKey = normalized.githubLogin.toLowerCase();
  const index = group.members.findIndex((entry) => (
    Boolean(emailKey) && entry.email.trim().toLowerCase() === emailKey
  ) || (
    Boolean(loginKey) && entry.githubLogin.trim().toLowerCase() === loginKey
  ));
  if (index < 0) return {
    authority: { ...group, members: [...group.members, normalized] },
    changed: true
  };
  const existing = group.members[index]!;
  const merged = {
    name: existing.name.trim() || normalized.name,
    email: existing.email.trim().toLowerCase() || normalized.email,
    githubLogin: existing.githubLogin.trim() || normalized.githubLogin
  };
  if (JSON.stringify(existing) === JSON.stringify(merged)) return { authority: group, changed: false };
  const members = [...group.members]; members[index] = merged;
  return { authority: { ...group, members }, changed: true };
}

/** Switch future Story snapshots to the explicit lone-developer approval profile. */
export function updateApprovalSecurityProfileYaml(text: string, profile: 'poc' | 'team' | 'regulated'): string {
  const parsed = document(text, 'workflow.yml');
  parsed.setIn(['approvalSecurity', 'profile'], profile);
  return String(parsed);
}

/** Update only the two Auto enablement layers represented by this form, preserving every ceiling. */
export function updateAutoYaml(text: string, draft: AutoDraft): string {
  const parsed = document(text, 'workflow.yml');
  const source = parsed.toJS() as { workTypes?: Record<string, unknown> } | null;
  const workTypeIds = Object.keys(source?.workTypes ?? {});
  const errors = validateAutoDraft(draft, workTypeIds);
  if (errors.length) throw new Error(errors.join(' '));
  parsed.setIn(['auto', 'enabled'], draft.enabled);
  for (const entry of draft.workTypes) {
    parsed.setIn(['workTypes', entry.id, 'auto', 'eligibility'], entry.eligibility);
  }
  return String(parsed);
}

/** Update only guided world-model fields. Advanced context and injection rules remain untouched. */
export function updateWorldModelYaml(text: string, draft: WorldModelDraft): string {
  const parsed = document(text, 'workflow.yml');
  const errors = validateWorldModelDraft(draft);
  if (errors.length) throw new Error(errors.join(' '));
  // An older webview does not send these fields. In that case preserve the exact existing policy
  // instead of silently downgrading a registered-v4 repository during an otherwise unrelated save.
  if (draft.format !== undefined) parsed.setIn(['worldModel', 'format'], draft.format);
  if (draft.v4 !== undefined) {
    if (draft.v4.composer !== undefined) parsed.setIn(['worldModel', 'v4', 'composer'], draft.v4.composer);
    if (draft.v4.consumer !== undefined) parsed.setIn(['worldModel', 'v4', 'consumer'], draft.v4.consumer);
    if (draft.v4.cachePolicy !== undefined) parsed.setIn(['worldModel', 'v4', 'cachePolicy'], draft.v4.cachePolicy);
    if (draft.v4.totalMaximumOutputTokens !== undefined) {
      parsed.setIn(['worldModel', 'v4', 'totalMaximumOutputTokens'], draft.v4.totalMaximumOutputTokens);
    }
  }
  parsed.setIn(['worldModel', 'views'], draft.views);
  // Callers from before scoped world models omit these fields. Preserve the existing YAML in that
  // case; the current form always supplies arrays, including [] when the user deliberately selects
  // the whole repository.
  if (Array.isArray(draft.sourceRoots)) parsed.setIn(['worldModel', 'sourceRoots'], draft.sourceRoots);
  if (Array.isArray(draft.sharedRoots)) parsed.setIn(['worldModel', 'sharedRoots'], draft.sharedRoots);
  parsed.setIn(['worldModel', 'outputDir'], draft.outputDir.trim());
  parsed.setIn(['worldModel', 'promptSource'], draft.promptSource.trim());
  parsed.setIn(['worldModel', 'stateFetchTimeoutMs'], draft.stateFetchTimeoutMs);
  parsed.setIn(['worldModel', 'generation', 'parallel'], draft.generation.parallel);
  parsed.setIn(['worldModel', 'generation', 'maxWorkers'], draft.generation.maxWorkers);
  parsed.setIn(['worldModel', 'generation', 'strategy'], 'view');
  parsed.setIn(['worldModel', 'materialization', 'mode'], draft.materialization.mode);
  parsed.setIn(['worldModel', 'materialization', 'publish'], draft.materialization.publish);
  parsed.setIn(['worldModel', 'materialization', 'lookahead'], draft.materialization.lookahead);
  parsed.setIn(['worldModel', 'materialization', 'depth'], draft.materialization.depth);
  parsed.setIn(['worldModel', 'materialization', 'confirmation'], draft.materialization.confirmation);
  parsed.setIn(['worldModel', 'grounding'], draft.grounding);
  parsed.setIn(['worldModel', 'staleness'], draft.staleness);
  parsed.setIn(['worldModel', 'injection', 'placeholder'], draft.injection.placeholder);
  parsed.setIn(['worldModel', 'injection', 'mode'], draft.injection.mode);
  parsed.setIn(['worldModel', 'injection', 'maxBytes'], draft.injection.maxBytes);
  return String(parsed);
}
