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

export const REPOSITORY_ONBOARDING_FAILURE_CLASSIFICATIONS = [
  'network-transient',
  'offline',
  'git-unavailable',
  'working-directory-unavailable',
  'credential-helper-unavailable',
  'authentication-required',
  'sso-authorization-required',
  'authorization-denied',
  'tls-trust',
  'proxy-configuration',
  'remote-not-found',
  'branch-not-found',
  'rate-limited',
  'policy-rejected',
  'atomic-push-unsupported',
  'protocol-unsupported',
  'unknown'
] as const;

export type RepositoryOnboardingFailureClassification =
  (typeof REPOSITORY_ONBOARDING_FAILURE_CLASSIFICATIONS)[number];

/** Bounded public Git diagnosis emitted by the onboarding preview. */
export interface RepositoryOnboardingFailure {
  code: string;
  classification: RepositoryOnboardingFailureClassification;
  retryable: boolean;
  advice: string;
}

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
  failure?: RepositoryOnboardingFailure;
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
  reason?: 'guarded-source-refs' | 'remote-policy-rejected' | 'normal-review';
  guardedSourceRefs?: string[];
  inspectCommand?: string;
  activateCommand?: string;
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
const FAILURE_CLASSIFICATION_SET = new Set<string>(REPOSITORY_ONBOARDING_FAILURE_CLASSIFICATIONS);
const PLAN_ID = /^sha256:[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40,64}$/i;
const CAPABILITY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const FAILURE_ADVICE_MAX_CHARS = 2_000;

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

/** Recover only a validated refusal identifier from a CLI error/result envelope. */
export function repositoryOnboardingFailureCode(value: unknown): string | null {
  if (typeof value === 'string') {
    const code = value.trim();
    return code && FAILURE_CODE.test(code) ? code : null;
  }
  const candidate = record(value);
  const result = record(candidate?.result);
  const nestedError = record(result?.error);
  const code = text(nestedError?.code) ?? text(candidate?.code);
  return code && FAILURE_CODE.test(code) ? code : null;
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

function onboardingFailure(value: unknown): RepositoryOnboardingFailure | null | undefined {
  if (value == null) return null;
  const candidate = record(value);
  const code = text(candidate?.code);
  const classification = text(candidate?.classification);
  const advice = text(candidate?.advice);
  if (!candidate || !code || !FAILURE_CODE.test(code)
    || !classification || !FAILURE_CLASSIFICATION_SET.has(classification)
    || typeof candidate.retryable !== 'boolean' || !advice
    || advice.length > FAILURE_ADVICE_MAX_CHARS) return undefined;
  return {
    code,
    classification: classification as RepositoryOnboardingFailureClassification,
    retryable: candidate.retryable,
    advice
  };
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
  const reason = candidate?.reason == null ? null : text(candidate.reason);
  const guardedSourceRefs = candidate?.guardedSourceRefs == null
    ? null : strictStringList(candidate.guardedSourceRefs);
  const inspectCommand = candidate?.inspectCommand == null ? null : text(candidate.inspectCommand);
  const activateCommand = candidate?.activateCommand == null ? null : text(candidate.activateCommand);
  if (!candidate || !['review-required', 'proposal-conflict'].includes(status ?? '')
    || (candidate.reason != null && !['guarded-source-refs', 'remote-policy-rejected', 'normal-review'].includes(reason ?? ''))
    || (candidate.guardedSourceRefs != null && (!guardedSourceRefs
      || guardedSourceRefs.length > 32 || guardedSourceRefs.some((ref) => !safeObservedRef(ref))))
    || (candidate.inspectCommand != null && (!inspectCommand || inspectCommand.length > 8192))
    || (candidate.activateCommand != null && (!activateCommand || activateCommand.length > 8192))
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
    ...(reason ? { reason: reason as RepositoryOnboardingReview['reason'] } : {}),
    ...(guardedSourceRefs ? { guardedSourceRefs } : {}),
    ...(inspectCommand ? { inspectCommand } : {}),
    ...(activateCommand ? { activateCommand } : {}),
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
  const parsedFailure = onboardingFailure(candidate?.failure);
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
    || parsedFailure === undefined
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
    ...(parsedFailure ? { failure: parsedFailure } : {}),
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

export interface RepositoryOnboardingCopy {
  title: string;
  message: string;
  action: string;
}

export const REPOSITORY_ONBOARDING_COPY: Record<RepositoryOnboardingStatus, RepositoryOnboardingCopy> = {
  ready: {
    title: 'Ready',
    message: 'Repository setup is current. Continue to check whether a capability still needs to be mapped.',
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
    message: 'The repository inspection did not complete. Retry or open Diagnostics.',
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

function retryCopy(title: string, message: string): RepositoryOnboardingCopy {
  return { title, message, action: 'Retry' };
}

/**
 * Translate the closed Git failure vocabulary into user-facing setup guidance.
 *
 * The engine advice is useful supporting detail, but it is not trusted to choose the headline.
 * Snapshot and timeout codes win over a broad transport classification because they establish
 * that Git was reached and the later bounded inspection is what failed.
 */
function repositoryOnboardingFailureCopy(
  failure: RepositoryOnboardingFailure | null | undefined
): RepositoryOnboardingCopy {
  if (!failure) return REPOSITORY_ONBOARDING_COPY['could-not-check-git'];
  const code = failure.code;
  const snapshot = code.includes('SNAPSHOT');
  const timeout = /(?:^|_)TIMEOUT(?:_|$)|TIMED_OUT/u.test(code);
  if (snapshot && code.includes('WORK_LIMIT_EXCEEDED')) {
    return retryCopy(
      'Repository inspection work limit reached',
      'The governed snapshot may fit the size limit, but SFlow cannot prove another admission pass will remain within the bounded transfer budget. Open Diagnostics before retrying.'
    );
  }
  if (snapshot && code.includes('LIMIT_EXCEEDED')) {
    return retryCopy(
      'Repository snapshot is too large',
      'Git access succeeded, but the repository snapshot exceeded the bounded inspection limit. Open Diagnostics before retrying.'
    );
  }
  if (snapshot && timeout) {
    return retryCopy(
      'Repository snapshot timed out',
      'Git access succeeded, but SFlow could not finish inspecting the repository snapshot within the time limit.'
    );
  }
  if (snapshot) {
    return retryCopy(
      'Could not inspect repository snapshot',
      'Git access succeeded, but SFlow could not inspect the repository snapshot. Retry or open Diagnostics.'
    );
  }
  if (timeout) {
    return retryCopy(
      'Git check timed out',
      'The bounded Git check did not finish within its time limit. Check connectivity or open Diagnostics, then retry.'
    );
  }
  switch (failure.classification) {
    case 'git-unavailable':
      return retryCopy(
        'Git is unavailable to VS Code',
        'VS Code could not find an approved Git executable. Add Git to PATH, restart VS Code, then retry.'
      );
    case 'working-directory-unavailable':
      return retryCopy(
        'Working directory is unavailable',
        'The directory used for the Git check is unavailable. Reopen or restore it, then retry.'
      );
    case 'credential-helper-unavailable':
      return retryCopy(
        'Git credential helper is unavailable',
        'Repair the configured Git credential helper, sign in, then retry without putting a token in the URL.'
      );
    case 'authentication-required':
      return retryCopy(
        'Git sign-in is required',
        'Sign in with Git or its approved credential helper, then retry without putting a token in the URL.'
      );
    case 'sso-authorization-required':
      return retryCopy(
        'Git SSO authorization is required',
        'Authorize the Git credential for the organisation’s SSO, then retry.'
      );
    case 'authorization-denied':
      return retryCopy(
        'Git access was denied',
        'The Git provider was reached, but this account cannot read the repository. Ask the repository owner for access, then retry.'
      );
    case 'network-transient':
      return retryCopy(
        'Git network check failed',
        'Check DNS and network reachability, then retry the same repository check.'
      );
    case 'offline':
      return retryCopy(
        'Network is offline',
        'Reconnect to the network, then retry the repository check.'
      );
    case 'rate-limited':
      return retryCopy(
        'Git provider rate limit reached',
        'Wait for the provider limit to reset, then retry the repository check.'
      );
    case 'tls-trust':
      return retryCopy(
        'Git TLS trust needs attention',
        'Install the organisation trust chain through the approved system or Git configuration, then retry.'
      );
    case 'proxy-configuration':
      return retryCopy(
        'Git proxy configuration needs attention',
        'Correct the approved Git or operating-system proxy configuration, then retry.'
      );
    case 'remote-not-found':
      return retryCopy(
        'Repository was not found',
        'Verify the repository URL and this account’s read access, then retry.'
      );
    case 'branch-not-found':
      return retryCopy(
        'Expected Git branch was not found',
        'Choose an existing state branch or publish the expected branch, then retry.'
      );
    case 'protocol-unsupported':
      return retryCopy(
        'Git protocol is unsupported',
        'Use a Git transport supported by this installation and the repository provider.'
      );
    default:
      return REPOSITORY_ONBOARDING_COPY['could-not-check-git'];
  }
}

/** Resolve the dynamic copy for a parsed preview without trusting failure prose as UI control. */
export function repositoryOnboardingCopy(
  plan: Pick<RepositoryOnboardingPlan, 'status' | 'failure'>
): RepositoryOnboardingCopy {
  return plan.status === 'could-not-check-git'
    ? repositoryOnboardingFailureCopy(plan.failure)
    : REPOSITORY_ONBOARDING_COPY[plan.status];
}

/** A scrubbed diagnostic line suitable for the repository-setup webview. */
export function repositoryOnboardingFailureDiagnosis(
  plan: Pick<RepositoryOnboardingPlan, 'status' | 'failure'>
): string | null {
  if (plan.status !== 'could-not-check-git' || !plan.failure) return null;
  // Advice is provider-originated prose and can contain a private remote or path with arbitrary
  // quoting and whitespace. The closed classification and validated code are sufficient for the
  // webview; exact scrubbed prose remains available in the output channel.
  return `Git diagnosis (${plan.failure.classification}; ${plan.failure.code}).`;
}

/**
 * Safe fallback for a CLI failure that happened before a versioned preview could be returned.
 * Only the category influences the webview; raw command prose remains in the scrubbed output log.
 */
export function repositoryOnboardingCommandFailureCopy(value: unknown): RepositoryOnboardingCopy {
  const structuredCode = repositoryOnboardingFailureCode(value);
  if (!structuredCode) {
    return retryCopy(
      'Repository setup check failed',
      'SFlow could not complete the repository setup check. Retry or open Diagnostics.'
    );
  }
  const diagnostic = structuredCode.toUpperCase();
  // Only versioned error identifiers may select a remediation. Free-form prose can contain a
  // repository named `snapshot`, `tls`, or `proxy`; classifying operands would give false advice.
  if (/\bREPOSITORY_ONBOARDING_SNAPSHOT_WORK_LIMIT_EXCEEDED\b/u.test(diagnostic)) {
    return retryCopy(
      'Repository inspection work limit reached',
      'The governed snapshot may fit the size limit, but SFlow cannot prove another admission pass will remain within the bounded transfer budget. Open Diagnostics before retrying.'
    );
  }
  if (/\bREPOSITORY_ONBOARDING_SNAPSHOT_LIMIT_EXCEEDED\b/u.test(diagnostic)) {
    return retryCopy(
      'Repository snapshot is too large',
      'Git access succeeded, but the repository snapshot exceeded the bounded inspection limit. Open Diagnostics before retrying.'
    );
  }
  if (/\bREPOSITORY_ONBOARDING_SNAPSHOT_[A-Z0-9_]*(?:TIMEOUT|TIMED_OUT)\b/u.test(diagnostic)) {
    return retryCopy(
      'Repository snapshot timed out',
      'Git access succeeded, but SFlow could not finish inspecting the repository snapshot within the time limit.'
    );
  }
  if (/\bREPOSITORY_ONBOARDING_SNAPSHOT_[A-Z0-9_]+\b/u.test(diagnostic)) {
    return retryCopy(
      'Could not inspect repository snapshot',
      'Git access succeeded, but SFlow could not inspect the repository snapshot. Retry or open Diagnostics.'
    );
  }
  if (/\bREMOTE_GIT_UNAVAILABLE\b/u.test(diagnostic)) {
    return repositoryOnboardingFailureCopy({
      code: 'REMOTE_GIT_UNAVAILABLE', classification: 'git-unavailable', retryable: false, advice: ''
    });
  }
  if (/\bREMOTE_TLS_TRUST\b/u.test(diagnostic)) {
    return repositoryOnboardingFailureCopy({
      code: 'REMOTE_TLS_TRUST', classification: 'tls-trust', retryable: false, advice: ''
    });
  }
  if (/\bREMOTE_PROXY_CONFIGURATION\b/u.test(diagnostic)) {
    return repositoryOnboardingFailureCopy({
      code: 'REMOTE_PROXY_CONFIGURATION', classification: 'proxy-configuration', retryable: false, advice: ''
    });
  }
  if (/\bREMOTE_(?:CREDENTIAL_HELPER_UNAVAILABLE|AUTHENTICATION_REQUIRED|SSO_AUTHORIZATION_REQUIRED|AUTHORIZATION_DENIED)\b/u.test(diagnostic)) {
    return repositoryOnboardingFailureCopy({
      code: 'REMOTE_AUTHENTICATION_REQUIRED', classification: 'authentication-required', retryable: false, advice: ''
    });
  }
  if (/\bREMOTE_TIMEOUT\b/u.test(diagnostic)) {
    return repositoryOnboardingFailureCopy({
      code: 'REMOTE_TIMEOUT', classification: 'network-transient', retryable: true, advice: ''
    });
  }
  if (/\bREMOTE_(?:NETWORK_TRANSIENT|OFFLINE)\b/u.test(diagnostic)) {
    return repositoryOnboardingFailureCopy({
      code: 'REMOTE_NETWORK_TRANSIENT', classification: 'network-transient', retryable: true, advice: ''
    });
  }
  return retryCopy(
    'Repository setup check failed',
    'SFlow could not complete the repository setup check. Retry or open Diagnostics.'
  );
}

export function repositoryOnboardingCanContinue(plan: RepositoryOnboardingPlan): boolean {
  return plan.mode !== 'reset-local'
    && (plan.status === 'ready' || plan.status === 'linked-to-team-configuration'
      || plan.status === 'sflow-repository-capability-not-mapped');
}

/**
 * A current approved map can be read before its optional portable state index is refreshed.
 * Keep every other planned effect behind the exact-plan confirmation; in particular, this must
 * never skip configuration restoration, migration, or an unfamiliar future effect.
 */
export function repositoryOnboardingCanDeferStateRefresh(plan: RepositoryOnboardingPlan): boolean {
  return plan.mode === 'auto'
    && plan.status === 'ready'
    && plan.primaryAction === 'continue'
    && plan.configuration.status === 'current'
    && plan.configuration.commit != null
    && plan.effects.length > 0
    && plan.effects.every((effect) => effect.kind === 'state-projection'
      && effect.action === 'refresh'
      && effect.target === plan.state.branch);
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
