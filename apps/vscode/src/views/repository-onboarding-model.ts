/**
 * Closed VS Code projection of the repository-onboarding CLI contract.
 *
 * The extension deliberately does not infer setup state from prose or Git refs. It accepts only
 * the versioned plan/result vocabulary emitted by `capability onboard`, then owns the concise UI
 * labels locally. Unknown/newer values stay incompatible instead of silently enabling a write.
 */

import { createHash } from 'node:crypto';
import { sameGitRepository } from '../repository-refresh-model.ts';

export const REPOSITORY_ONBOARDING_STATUSES = [
  'ready',
  'ready-to-restore',
  'update-available',
  'linked-to-team-configuration',
  'sflow-repository-capability-not-mapped',
  'not-set-up',
  'state-branch-not-recognized',
  'could-not-check-git',
  'needs-a-choice',
  'newer-version-required'
] as const;

export type RepositoryOnboardingStatus = (typeof REPOSITORY_ONBOARDING_STATUSES)[number];
export type RepositoryOnboardingResultStatus =
  | RepositoryOnboardingStatus | 'ready-state-refresh-pending'
  | 'configuration-review-required' | 'local-registration-pending';
export type RepositoryOnboardingMode = 'auto' | 'migrate' | 'recreate' | 'reset-local';
export type RepositoryOnboardingExplicitMode = Exclude<RepositoryOnboardingMode, 'auto'>;
export type RepositoryStateKind =
  | 'configuration-mirror' | 'delivery-locator' | 'lifecycle-only' | 'none' | 'invalid';

export type RepositoryOnboardingPrimaryAction =
  | 'continue' | 'restore-and-continue' | 'migrate-and-continue' | 'map-capability'
  | 'set-up-sflow' | 'choose-another-state-branch' | 'retry' | 'review-choices'
  | 'install-newer-version' | 'recreate-configuration' | 'reset-local-registration';

export interface RepositoryOnboardingChoice {
  id: string;
  label: string;
  description: string;
  mode: RepositoryOnboardingExplicitMode;
}

export interface RepositoryOnboardingPlan {
  schemaVersion: 1;
  kind: 'repository-onboarding-plan/v1';
  repository: { url: string; identity: string; inputIdentity?: string };
  mode: RepositoryOnboardingMode;
  status: RepositoryOnboardingStatus;
  primaryAction: RepositoryOnboardingPrimaryAction;
  state: {
    kind: RepositoryStateKind;
    branch: string;
    commit: string | null;
  } & Record<string, unknown>;
  configuration: {
    branch: 'sflow/config';
    commit: string | null;
    status: 'current' | 'missing' | 'migration-required' | 'invalid' | 'future' | 'unchecked';
    schemaVersion: number | null;
    currentSchemaVersion: number;
  };
  observedRefs: Record<string, string | null>;
  effects: Array<{ kind: string; target: string; action: string }>;
  preserved: string[];
  localCleanupWarnings?: string[];
  omitted: string[];
  choices: RepositoryOnboardingChoice[];
  /** Explicit alternate previews the engine permits for this exact observation. */
  availableModes: RepositoryOnboardingExplicitMode[];
  routing: { leadUrl: string; capabilityIds: string[] } | null;
  organisation: unknown | null;
  canApply: boolean;
  planId: string;
  nextActions: { shell: string; copilot: string };
  dryRun: true;
}

export interface RepositoryOnboardingResult {
  schemaVersion: 1;
  kind: 'repository-onboarding-result/v1';
  planId: string;
  mode: RepositoryOnboardingMode;
  status: RepositoryOnboardingResultStatus;
  primaryAction: RepositoryOnboardingPrimaryAction;
  applied: true;
  changed: boolean;
  effects: Array<{ kind: string; target: string; action: string }>;
  preserved: string[];
  localCleanupWarnings?: string[];
  nextActions: { shell: string; copilot: string };
  routing: { leadUrl: string; capabilityIds: string[] } | null;
  organisation: unknown | null;
  receipt: unknown;
  configuration: { commit: string } | null;
  stateRefresh: RepositoryOnboardingStateRefresh | null;
  review: RepositoryOnboardingReview | null;
  localRegistration: RepositoryOnboardingLocalRegistration | null;
}

export interface RepositoryOnboardingStateRefresh {
  status: 'current' | 'updated' | 'not-applicable' | 'policy-disabled' | 'failed' | 'pending';
  pending: boolean;
  retry: { shell: string; copilot: string } | null;
}

export interface RepositoryOnboardingReview {
  status: 'review-required' | 'proposal-conflict';
  configurationReady: false;
  sourceBranch: string;
  targetBranch: 'sflow/config';
  proposalCommit: string;
  candidateCommit: string;
  published: boolean;
  existing: boolean;
  conflict: boolean;
  recovery: {
    action: 'merge-proposal' | 'resolve-proposal-conflict';
    sourceBranch: string;
    targetBranch: 'sflow/config';
    proposalCommit: string;
    afterMerge: string;
  };
}

export interface RepositoryOnboardingLocalRegistration {
  status: 'pending';
  remembered: false;
  target: string;
  code: 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED';
  causeCode?: string;
  reason: string;
  retry: { shell: string; copilot: string };
}

const STATUS_SET = new Set<string>(REPOSITORY_ONBOARDING_STATUSES);
const RESULT_STATUS_SET = new Set<string>([
  ...REPOSITORY_ONBOARDING_STATUSES,
  'ready-state-refresh-pending',
  'configuration-review-required',
  'local-registration-pending'
]);
const MODE_SET = new Set<string>(['auto', 'migrate', 'recreate', 'reset-local']);
const EXPLICIT_MODE_SET = new Set<string>(['migrate', 'recreate', 'reset-local']);
const STATE_KIND_SET = new Set<string>([
  'configuration-mirror', 'delivery-locator', 'lifecycle-only', 'none', 'invalid'
]);
const CONFIGURATION_STATUS_SET = new Set<string>([
  'current', 'missing', 'migration-required', 'invalid', 'future', 'unchecked'
]);
const ACTION_SET = new Set<string>([
  'continue', 'restore-and-continue', 'migrate-and-continue', 'map-capability',
  'set-up-sflow', 'choose-another-state-branch', 'retry', 'review-choices',
  'install-newer-version', 'recreate-configuration', 'reset-local-registration'
]);
const PLAN_ID = /^sha256:[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40,64}$/i;
const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safeStateBranch(value: string): boolean {
  return value.length <= 1024 && value !== '@' && !value.startsWith('-')
    && !value.startsWith('.') && !value.startsWith('refs/')
    && !value.endsWith('.') && !value.endsWith('/') && !value.endsWith('.lock')
    && !/(?:\.\.|\/\/|@\{|[\u0000-\u0020\u007f~^:?*\[\\])/.test(value)
    && value.split('/').every((part) => Boolean(part) && !part.startsWith('.') && !part.endsWith('.lock'));
}

function safeObservedRef(value: string): boolean {
  if (value === 'HEAD') return true;
  const prefix = value.startsWith('refs/heads/')
    ? 'refs/heads/' : value.startsWith('refs/tags/') ? 'refs/tags/' : null;
  return prefix != null && safeStateBranch(value.slice(prefix.length));
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function strictStringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
  const parsed = value.map((entry) => entry.trim());
  if (parsed.some((entry) => !entry) || new Set(parsed).size !== parsed.length) return null;
  return parsed;
}

function effects(value: unknown): Array<{ kind: string; target: string; action: string }> | null {
  if (!Array.isArray(value)) return null;
  const parsed: Array<{ kind: string; target: string; action: string }> = [];
  for (const entry of value) {
    const candidate = record(entry);
    const kind = text(candidate?.kind);
    const target = text(candidate?.target);
    const action = text(candidate?.action);
    if (!kind || !target || !action) return null;
    parsed.push({ kind, target, action });
  }
  return parsed;
}

function nextActions(value: unknown): { shell: string; copilot: string } | null {
  const candidate = record(value);
  const shell = text(candidate?.shell);
  const copilot = text(candidate?.copilot);
  return shell && copilot ? { shell, copilot } : null;
}

function routing(value: unknown): { leadUrl: string; capabilityIds: string[] } | null | undefined {
  if (value == null) return null;
  const candidate = record(value);
  const leadUrl = text(candidate?.leadUrl);
  const capabilityIds = stringList(candidate?.capabilityIds);
  if (!candidate || !leadUrl || !capabilityIds
    || capabilityIds.some((entry) => !CAPABILITY_ID.test(entry))) return undefined;
  return { leadUrl, capabilityIds: [...new Set(capabilityIds)] };
}

function choices(value: unknown): RepositoryOnboardingChoice[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const parsed: RepositoryOnboardingChoice[] = [];
  for (const entry of value) {
    const candidate = record(entry);
    const id = text(candidate?.id);
    const label = text(candidate?.label);
    const description = text(candidate?.description);
    const mode = text(candidate?.mode);
    if (!id || !label || !description || !mode || !EXPLICIT_MODE_SET.has(mode)) return null;
    parsed.push({ id, label, description, mode: mode as RepositoryOnboardingExplicitMode });
  }
  return parsed;
}

function availableModes(value: unknown): RepositoryOnboardingExplicitMode[] | null {
  // `choices` supplies conflict-resolution copy; only this field authorizes More-options modes.
  if (!Array.isArray(value) || value.some((mode) =>
    typeof mode !== 'string' || !EXPLICIT_MODE_SET.has(mode))) return null;
  return [...new Set(value)] as RepositoryOnboardingExplicitMode[];
}

function onboardingReview(value: unknown): RepositoryOnboardingReview | null {
  const candidate = record(value);
  const recovery = record(candidate?.recovery);
  const status = text(candidate?.status);
  const sourceBranch = text(candidate?.sourceBranch);
  const proposalCommit = text(candidate?.proposalCommit);
  const candidateCommit = text(candidate?.candidateCommit);
  const action = text(recovery?.action);
  const recoverySource = text(recovery?.sourceBranch);
  const recoveryCommit = text(recovery?.proposalCommit);
  const afterMerge = text(recovery?.afterMerge);
  if (!candidate || !['review-required', 'proposal-conflict'].includes(status ?? '')
    || candidate.configurationReady !== false || !sourceBranch || !safeStateBranch(sourceBranch)
    || candidate.targetBranch !== 'sflow/config' || !proposalCommit || !COMMIT.test(proposalCommit)
    || !candidateCommit || !COMMIT.test(candidateCommit)
    || typeof candidate.published !== 'boolean' || typeof candidate.existing !== 'boolean'
    || typeof candidate.conflict !== 'boolean' || !recovery
    || !['merge-proposal', 'resolve-proposal-conflict'].includes(action ?? '')
    || !recoverySource || recoverySource !== sourceBranch
    || recovery.targetBranch !== 'sflow/config' || !recoveryCommit
    || recoveryCommit !== proposalCommit || !afterMerge) return null;
  return {
    status: status as RepositoryOnboardingReview['status'],
    configurationReady: false,
    sourceBranch,
    targetBranch: 'sflow/config',
    proposalCommit,
    candidateCommit,
    published: candidate.published,
    existing: candidate.existing,
    conflict: candidate.conflict,
    recovery: {
      action: action as RepositoryOnboardingReview['recovery']['action'],
      sourceBranch: recoverySource,
      targetBranch: 'sflow/config',
      proposalCommit: recoveryCommit,
      afterMerge
    }
  };
}

function localRegistration(value: unknown): RepositoryOnboardingLocalRegistration | null {
  const candidate = record(value);
  const target = text(candidate?.target);
  const reason = text(candidate?.reason);
  const retry = nextActions(candidate?.retry);
  const causeCode = candidate?.causeCode == null ? null : text(candidate.causeCode);
  if (!candidate || candidate.status !== 'pending' || candidate.remembered !== false
    || !target || candidate.code !== 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED' || !reason || !retry
    || (causeCode != null && !/^[A-Z][A-Z0-9_]*$/u.test(causeCode))) return null;
  return {
    status: 'pending', remembered: false, target,
    code: 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED',
    ...(causeCode ? { causeCode } : {}), reason, retry
  };
}

function stateRefresh(value: unknown): RepositoryOnboardingStateRefresh | null {
  const candidate = record(value);
  const status = text(candidate?.status);
  const parsedRetry = candidate?.retry == null ? null : nextActions(candidate.retry);
  if (!candidate || !['current', 'updated', 'not-applicable', 'policy-disabled', 'failed', 'pending']
    .includes(status ?? '') || typeof candidate.pending !== 'boolean'
    || (candidate.retry != null && !parsedRetry)
    || (candidate.pending === true && !parsedRetry)) return null;
  return {
    status: status as RepositoryOnboardingStateRefresh['status'],
    pending: candidate.pending,
    retry: parsedRetry
  };
}

/** Parse a preview without accepting a mutation-shaped or future contract. */
export function parseRepositoryOnboardingPlan(value: unknown): RepositoryOnboardingPlan | null {
  const candidate = record(value);
  const repository = record(candidate?.repository);
  const state = record(candidate?.state);
  const configuration = record(candidate?.configuration);
  const observedRefs = record(candidate?.observedRefs);
  const status = text(candidate?.status);
  const primaryAction = text(candidate?.primaryAction);
  const mode = text(candidate?.mode);
  const planId = text(candidate?.planId);
  const parsedEffects = effects(candidate?.effects);
  const preserved = stringList(candidate?.preserved);
  const parsedCleanupWarnings = candidate?.localCleanupWarnings == null
    ? null : strictStringList(candidate.localCleanupWarnings);
  const omitted = stringList(candidate?.omitted);
  const parsedNext = nextActions(candidate?.nextActions);
  const parsedRouting = routing(candidate?.routing);
  const parsedChoices = choices(candidate?.choices);
  const parsedAvailableModes = availableModes(candidate?.availableModes);
  const stateKind = text(state?.kind);
  const configurationStatus = text(configuration?.status);
  const repositoryUrl = text(repository?.url);
  const repositoryIdentity = text(repository?.identity);
  const repositoryInputIdentity = repository?.inputIdentity == null
    ? null : text(repository.inputIdentity);
  const stateBranch = text(state?.branch);
  const stateCommit = state?.commit == null ? null : text(state.commit);
  const configurationCommit = configuration?.commit == null ? null : text(configuration.commit);
  const schemaVersion = configuration?.schemaVersion == null
    ? null : configuration.schemaVersion;
  if (!candidate || candidate.schemaVersion !== 1
    || candidate.kind !== 'repository-onboarding-plan/v1' || candidate.dryRun !== true
    || !repository || !repositoryUrl || !repositoryIdentity || !PLAN_ID.test(repositoryIdentity)
    || (repository?.inputIdentity != null
      && (!repositoryInputIdentity || !PLAN_ID.test(repositoryInputIdentity)))
    || !mode || !MODE_SET.has(mode) || !status || !STATUS_SET.has(status)
    || !primaryAction || !ACTION_SET.has(primaryAction)
    || !state || !stateKind || !STATE_KIND_SET.has(stateKind)
    || !stateBranch || !safeStateBranch(stateBranch)
    || (state.commit != null && (!stateCommit || !COMMIT.test(stateCommit)))
    || !configuration || configuration.branch !== 'sflow/config'
    || !configurationStatus || !CONFIGURATION_STATUS_SET.has(configurationStatus)
    || (configuration.commit != null && (!configurationCommit || !COMMIT.test(configurationCommit)))
    || (schemaVersion != null && (typeof schemaVersion !== 'number'
      || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1))
    || !Number.isSafeInteger(configuration.currentSchemaVersion)
    || Number(configuration.currentSchemaVersion) < 1
    || !observedRefs || Object.entries(observedRefs).some(([ref, commit]) =>
      !safeObservedRef(ref) || (commit != null && (typeof commit !== 'string' || !COMMIT.test(commit))))
    || !parsedEffects || !preserved || !omitted || !parsedNext || !parsedChoices
    || (candidate.localCleanupWarnings != null && !parsedCleanupWarnings)
    || !parsedAvailableModes
    || parsedChoices.some((choice) => !parsedAvailableModes.includes(choice.mode))
    || parsedRouting === undefined || typeof candidate.canApply !== 'boolean'
    || !planId || !PLAN_ID.test(planId)) return null;
  return {
    schemaVersion: 1,
    kind: 'repository-onboarding-plan/v1',
    repository: {
      url: repositoryUrl,
      identity: repositoryIdentity,
      ...(repositoryInputIdentity ? { inputIdentity: repositoryInputIdentity } : {})
    },
    mode: mode as RepositoryOnboardingMode,
    status: status as RepositoryOnboardingStatus,
    primaryAction: primaryAction as RepositoryOnboardingPrimaryAction,
    state: { ...state, kind: stateKind as RepositoryStateKind, branch: stateBranch, commit: stateCommit },
    configuration: {
      branch: 'sflow/config', commit: configurationCommit,
      status: configurationStatus as RepositoryOnboardingPlan['configuration']['status'],
      schemaVersion: schemaVersion as number | null,
      currentSchemaVersion: Number(configuration.currentSchemaVersion)
    },
    observedRefs: Object.fromEntries(Object.entries(observedRefs) as Array<[string, string | null]>),
    effects: parsedEffects,
    preserved,
    ...(parsedCleanupWarnings ? { localCleanupWarnings: parsedCleanupWarnings } : {}),
    omitted,
    choices: parsedChoices,
    availableModes: parsedAvailableModes,
    routing: parsedRouting,
    organisation: candidate.organisation ?? null,
    canApply: candidate.canApply,
    planId,
    nextActions: parsedNext,
    dryRun: true
  };
}

/** Parse only a confirmed apply result bound to the expected preview. */
export function parseRepositoryOnboardingResult(
  value: unknown,
  expectedPlanId?: string
): RepositoryOnboardingResult | null {
  const candidate = record(value);
  const planId = text(candidate?.planId);
  const mode = text(candidate?.mode);
  const status = text(candidate?.status);
  const primaryAction = text(candidate?.primaryAction);
  const parsedEffects = effects(candidate?.effects);
  const preserved = stringList(candidate?.preserved);
  const parsedCleanupWarnings = candidate?.localCleanupWarnings == null
    ? null : strictStringList(candidate.localCleanupWarnings);
  const parsedNext = nextActions(candidate?.nextActions);
  const parsedRouting = routing(candidate?.routing);
  const configuration = candidate?.configuration == null ? null : record(candidate.configuration);
  const configurationCommit = configuration == null ? null : text(configuration.commit);
  const parsedReview = candidate?.review == null ? null : onboardingReview(candidate.review);
  const parsedLocalRegistration = candidate?.localRegistration == null
    ? null : localRegistration(candidate.localRegistration);
  const parsedStateRefresh = candidate?.stateRefresh == null
    ? null : stateRefresh(candidate.stateRefresh);
  if (!candidate || candidate.schemaVersion !== 1
    || candidate.kind !== 'repository-onboarding-result/v1' || candidate.applied !== true
    || typeof candidate.changed !== 'boolean' || !planId || !PLAN_ID.test(planId)
    || (expectedPlanId != null && planId !== expectedPlanId)
    || !mode || !MODE_SET.has(mode) || !status || !RESULT_STATUS_SET.has(status)
    || !primaryAction || !ACTION_SET.has(primaryAction)
    || !parsedEffects || !preserved || !parsedNext || parsedRouting === undefined
    || (candidate.localCleanupWarnings != null && !parsedCleanupWarnings)
    || (candidate.review != null && !parsedReview)
    || (candidate.localRegistration != null && !parsedLocalRegistration)
    || (candidate.stateRefresh != null && !parsedStateRefresh)
    || (candidate.configuration != null && (!configurationCommit || !COMMIT.test(configurationCommit)))
    || (status === 'configuration-review-required' && !parsedReview)
    || (status === 'local-registration-pending' && !parsedLocalRegistration)) return null;
  return {
    schemaVersion: 1,
    kind: 'repository-onboarding-result/v1',
    planId,
    mode: mode as RepositoryOnboardingMode,
    status: status as RepositoryOnboardingResultStatus,
    primaryAction: primaryAction as RepositoryOnboardingPrimaryAction,
    applied: true,
    changed: candidate.changed,
    effects: parsedEffects,
    preserved,
    ...(parsedCleanupWarnings ? { localCleanupWarnings: parsedCleanupWarnings } : {}),
    nextActions: parsedNext,
    routing: parsedRouting,
    organisation: candidate.organisation ?? null,
    receipt: candidate.receipt ?? null,
    configuration: configurationCommit ? { commit: configurationCommit } : null,
    stateRefresh: parsedStateRefresh,
    review: parsedReview,
    localRegistration: parsedLocalRegistration
  };
}

export function repositoryOnboardingPreviewArgv(
  repository: string,
  mode: RepositoryOnboardingMode = 'auto',
  stateBranch?: string
): string[] {
  const args = ['capability', 'onboard', repository];
  if (mode !== 'auto') args.push(`--${mode}`);
  if (stateBranch?.trim()) {
    const branch = stateBranch.trim();
    if (!safeStateBranch(branch)) throw new Error('Invalid repository onboarding state branch.');
    args.push('--state-branch', branch);
  }
  args.push('--dry-run', '--json');
  return args;
}

export function repositoryOnboardingApplyArgv(
  repository: string,
  plan: Pick<RepositoryOnboardingPlan, 'mode' | 'planId' | 'state'>
): string[] {
  const args = ['capability', 'onboard', repository];
  if (plan.mode !== 'auto') args.push(`--${plan.mode}`);
  const stateBranch = plan.state.branch.trim();
  if (!safeStateBranch(stateBranch)) throw new Error('Invalid repository onboarding state branch.');
  if (stateBranch && stateBranch !== 'state') args.push('--state-branch', stateBranch);
  args.push('--confirm-plan', plan.planId, '--json');
  return args;
}

/** The engine plan is the sole authority for optional recovery-mode previews. */
export function repositoryOnboardingModeAvailable(
  plan: Pick<RepositoryOnboardingPlan, 'availableModes'>,
  mode: string
): mode is RepositoryOnboardingExplicitMode {
  return EXPLICIT_MODE_SET.has(mode) && plan.availableModes.includes(
    mode as RepositoryOnboardingExplicitMode
  );
}

export const REPOSITORY_ONBOARDING_COPY: Record<RepositoryOnboardingStatus, {
  title: string;
  message: string;
  action: string;
}> = {
  ready: {
    title: 'Ready',
    message: 'Existing SFlow setup is current and can be used.',
    action: 'Continue'
  },
  'ready-to-restore': {
    title: 'Ready to restore',
    message: 'Recognized SFlow state can restore the missing configuration.',
    action: 'Restore and continue'
  },
  'update-available': {
    title: 'Update available',
    message: 'Existing setup can be preserved and upgraded to this SFlow version.',
    action: 'Migrate and continue'
  },
  'linked-to-team-configuration': {
    title: 'Linked to team configuration',
    message: 'This repository already points to the team setup it uses.',
    action: 'Continue'
  },
  'sflow-repository-capability-not-mapped': {
    title: 'SFlow repository · capability not mapped',
    message: 'SFlow history is recognized; choose where this repository belongs.',
    action: 'Map capability'
  },
  'not-set-up': {
    title: 'Not set up',
    message: 'This repository has no recognized SFlow setup yet.',
    action: 'Set up SFlow'
  },
  'state-branch-not-recognized': {
    title: 'State branch not recognized',
    message: 'The branch may belong to the application and will not be overwritten.',
    action: 'Choose another state branch'
  },
  'could-not-check-git': {
    title: 'Could not check Git',
    message: 'Git access must succeed before setup can be determined.',
    action: 'Retry'
  },
  'needs-a-choice': {
    title: 'Needs a choice',
    message: 'More than one safe setup path is available.',
    action: 'Review choices'
  },
  'newer-version-required': {
    title: 'A newer SFlow version is required',
    message: 'This setup was written by a newer version and will not be changed.',
    action: 'Install newer version'
  }
};

export function repositoryOnboardingCanContinue(plan: RepositoryOnboardingPlan): boolean {
  return plan.mode !== 'reset-local'
    && (plan.status === 'ready' || plan.status === 'linked-to-team-configuration'
      || plan.status === 'sflow-repository-capability-not-mapped');
}

/** Bind a preview to the exact local locator while retaining compatibility with URL-only v1 plans. */
export function repositoryOnboardingPlanMatchesInput(
  plan: RepositoryOnboardingPlan,
  repositoryInput: string
): boolean {
  const input = repositoryInput.trim();
  if (!input) return false;
  if (plan.repository.inputIdentity) {
    const digest = createHash('sha256').update(input).digest('hex');
    return plan.repository.inputIdentity === `sha256:${digest}`;
  }
  return sameGitRepository(plan.repository.url, input);
}
