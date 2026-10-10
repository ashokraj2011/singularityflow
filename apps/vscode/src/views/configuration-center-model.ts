/** Pure models and governed YAML edits for the Configuration Center. */
import YAML from 'yaml';
import type { ModelRoutingProjection, RepositorySnapshot } from '../cli/snapshot.ts';
export {
  configurationSaveDisposition, configurationSavePlan, configurationSavePlanCliArgs,
  type ConfigurationSaveDisposition, type ConfigurationSavePlan
} from './configuration-save.ts';

/**
 * Every tab, in the order the strip renders them.
 *
 * A list rather than a bare union because the panel has to check an incoming tab name at runtime,
 * and the hand-written allowlist it used to check against had already drifted: 'models' shipped as a
 * rendered tab whose own strip button was silently dropped. Deriving the type from the list makes
 * adding a tab and accepting it the same edit.
 */
export const CONFIGURATION_TABS = ['overview', 'tests', 'auto', 'world-model', 'models', 'people', 'mcp'] as const;

export type ConfigurationTab = (typeof CONFIGURATION_TABS)[number];

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
/**
 * The World Model is the Repository brief read from the source; the only settings it has here are
 * which directories it reads. The registered World Model and its settings were removed.
 */
export interface WorldModelSettingsView {
  sourceRoots: string[];
  sharedRoots: string[];
}
export type AutoEligibility = 'disabled' | 'plan-only' | 'bounded';
export interface AutoSettingsView {
  enabled: boolean;
  workTypes: Array<{ id: string; label: string; eligibility: AutoEligibility }>;
}
export interface ConfigurationCenterView {
  profile: ProfileView;
  /** The repository identity the kernel will attribute governed decisions to. */
  gitIdentity: AuthorityMemberView | null;
  approvalSecurityProfile: 'poc' | 'team' | 'regulated';
  approvalAllowSelfApproval: boolean;
  approvalAutoEnrollNewIdentities: boolean;
  /** Artifact templates with their catalog names and usage, absorbed from the sidebar. */
  authorities: AuthorityView[];
  mcpServers: McpServerView[];
  agents: Array<{ id: string; label: string }>;
  phases: Array<{ id: string; label: string }>;
  mcpErrors: string[];
  mcpWarnings: string[];
  worldModel: WorldModelSettingsView;
  /** Approved policy and an optional validated working-tree draft are intentionally distinct. */
  configurationState: {
    editor: 'effective' | 'candidate';
    effective: { kind: string; ref: string | null; commit: string | null; sha256: string } | null;
    candidate: { status: 'valid' | 'invalid'; error: string | null; changes: string[]; sha256: string } | null;
  };
  /** Repository master switch and work-type opt-ins. Capability policy can only tighten these. */
  auto: AutoSettingsView;
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
export type WorldModelDraft = WorldModelSettingsView;
export interface AutoDraft {
  enabled: boolean;
  workTypes: Array<{ id: string; eligibility: AutoEligibility }>;
}

export interface ConfigurationTextRevision {
  definitionText: string;
  portfolioText: string;
}

/** Stable identity of the authority a panel rendered, not merely the bytes of one file. */
export function configurationAuthorityRevision(
  source: RepositorySnapshot['configurationSource'] | null | undefined
): string | null {
  const effective = source?.effective;
  if (!effective) return null;
  return JSON.stringify([
    effective.kind,
    effective.remoteFingerprint ?? null,
    effective.commit ?? null,
    effective.sourceCommit ?? null
  ]);
}

export interface PendingConfigurationProposal {
  branch: string;
  baseBranch: string;
  proposalCommit: string;
}

export interface ConfigurationProposalObservation {
  branch: string;
  proposalCommit: string;
  targetBranch?: string;
  merged: boolean;
}

/** Restore the durable save-file proposal guard after a panel or extension restart. */
export function pendingConfigurationProposal(
  observations: ConfigurationProposalObservation[]
): PendingConfigurationProposal | null {
  const pending = observations.filter((entry) => entry.merged !== true
    && entry.branch.startsWith('sflow/config-change/workflow/save-file-')
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(entry.proposalCommit))
    .sort((left, right) => left.branch.localeCompare(right.branch))[0];
  return pending ? {
    branch: pending.branch,
    baseBranch: pending.targetBranch ?? 'sflow/config',
    proposalCommit: pending.proposalCommit
  } : null;
}

/** Clear a retained guard only when Git proves that exact proposal commit was merged. */
export function configurationPendingProposalStatus(
  pending: PendingConfigurationProposal,
  observations: ConfigurationProposalObservation[]
): 'pending' | 'merged' {
  const exact = observations.find((entry) => entry.branch === pending.branch
    && entry.proposalCommit === pending.proposalCommit);
  return exact?.merged === true ? 'merged' : 'pending';
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

export function configurationCenterView(snapshot: RepositorySnapshot, profile: ProfileView): ConfigurationCenterView {
  const definition = snapshot.definition ?? {};
  const worldModel = definition.worldModel ?? {};
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
    configurationState: snapshot.configurationSource ?? {
      editor: 'effective', effective: null, candidate: null
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
      sourceRoots: Array.isArray(worldModel.sourceRoots) ? worldModel.sourceRoots : [],
      sharedRoots: Array.isArray(worldModel.sharedRoots) ? worldModel.sharedRoots : []
    }
  };
}

export { configurationPathTarget, type ConfigurationPathTarget } from './configuration-path-target.ts';

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

/** Reject malformed/retained postMessage payloads before any property is dereferenced. */
export function validateWorldModelDraftShape(draft: unknown): string[] {
  const strings = (value: unknown): value is string[] => Array.isArray(value)
    && value.every((entry) => typeof entry === 'string');
  if (!draft || typeof draft !== 'object'
      || !strings((draft as Partial<WorldModelDraft>).sourceRoots)
      || !strings((draft as Partial<WorldModelDraft>).sharedRoots)) {
    return ['Source scope settings are incomplete. Reload Configuration Center and try again.'];
  }
  return [];
}

export function validateWorldModelDraft(draft: WorldModelDraft): string[] {
  const shapeErrors = validateWorldModelDraftShape(draft);
  if (shapeErrors.length) return shapeErrors;
  const errors: string[] = [];
  for (const [label, roots] of [
    ['Source roots', draft.sourceRoots], ['Shared roots', draft.sharedRoots]
  ] as const) {
    if (new Set(roots).size !== roots.length) errors.push(`${label} must not contain duplicates.`);
    roots.forEach((root) => {
      if (!root.trim() || root.trim() === '.' || root.includes('\\') || unsafeRelative(root.trim()) || /[*?\[\]{}]/.test(root)) {
        errors.push(`${label} entry '${root}' must be a repository-relative directory without '..' or glob characters.`);
      }
    });
  }
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

/** Update only the source scope; every other World Model setting in the file stays as it is. */
export function updateWorldModelYaml(text: string, draft: WorldModelDraft): string {
  const parsed = document(text, 'workflow.yml');
  const errors = validateWorldModelDraft(draft);
  if (errors.length) throw new Error(errors.join(' '));
  // [] is a deliberate choice of the whole repository, so it is written too.
  parsed.setIn(['worldModel', 'sourceRoots'], draft.sourceRoots);
  parsed.setIn(['worldModel', 'sharedRoots'], draft.sharedRoots);
  return String(parsed);
}
