import { SingularityFlowError } from '../util.mjs';

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  entry: Object.freeze({
    allowExplicitStart: true,
    allowUnstartedLanding: true,
    defaultMode: 'in-place'
  }),
  baseline: Object.freeze({
    requireExactRevision: true,
    dirtyStart: 'ask',
    upstreamUse: 'confirm-if-commits-ahead'
  }),
  localWork: Object.freeze({ allowed: true }),
  executionUnits: Object.freeze({ allowed: true, default: null }),
  scope: Object.freeze({
    // ADH v1 deliberately ships the specification's thin-pilot ceiling first.
    maximumTouchedResources: 20,
    maximumRepositoriesForDirectLanding: 1
  }),
  externalEffects: Object.freeze({
    mode: 'governed-device-only', outsideGovernanceBehavior: 'promote-or-reconcile'
  }),
  protectedPaths: Object.freeze({ behavior: 'promote' }),
  directLanding: Object.freeze({
    enabled: true,
    maximumRisk: 'low',
    requireIntentConfirmation: true,
    requireDispositionCoverage: true,
    requireVerification: true,
    requireHumanDecision: 'policy'
  }),
  promotion: Object.freeze({
    triggers: Object.freeze({
      repositoriesGreaterThan: 1,
      protectedPathTouched: true,
      architectureDecisionRequired: true,
      externalEffectRequired: true,
      estimatedRemainingTasksGreaterThan: 3,
      uncertainEffect: true
    })
  }),
  executionCeilings: Object.freeze({
    activeMinutes: 480, modelInvocations: 30, deviceCalls: 100
  }),
  discard: Object.freeze({ backup: 'required', backupRetentionDays: 14 }),
  telemetry: Object.freeze({ contentFree: true, individualScoring: false })
});

function object(value, label) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  return value;
}

function known(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
  }
}

function bool(value, fallback, label) {
  const actual = value ?? fallback;
  if (typeof actual !== 'boolean') throw new SingularityFlowError(`${label} must be boolean.`);
  return actual;
}

function integer(value, fallback, minimum, maximum, label) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < minimum || actual > maximum) {
    throw new SingularityFlowError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return actual;
}

export function normalizeAdhocPolicy(source = {}) {
  const value = object(source, 'adhoc');
  known(value, [
    'enabled', 'entry', 'baseline', 'localWork', 'executionUnits', 'scope', 'externalEffects',
    'protectedPaths', 'directLanding', 'promotion', 'executionCeilings', 'discard', 'telemetry'
  ], 'adhoc');

  const entry = object(value.entry, 'adhoc.entry');
  known(entry, ['allowExplicitStart', 'allowUnstartedLanding', 'defaultMode'], 'adhoc.entry');
  const defaultMode = entry.defaultMode ?? DEFAULT_POLICY.entry.defaultMode;
  if (!['in-place', 'isolated'].includes(defaultMode)) {
    throw new SingularityFlowError("adhoc.entry.defaultMode must be 'in-place' or 'isolated'.");
  }

  const baseline = object(value.baseline, 'adhoc.baseline');
  known(baseline, ['requireExactRevision', 'dirtyStart', 'upstreamUse'], 'adhoc.baseline');
  const dirtyStart = baseline.dirtyStart ?? DEFAULT_POLICY.baseline.dirtyStart;
  if (dirtyStart !== 'ask') throw new SingularityFlowError("adhoc.baseline.dirtyStart must be 'ask'.");
  const upstreamUse = baseline.upstreamUse ?? DEFAULT_POLICY.baseline.upstreamUse;
  if (upstreamUse !== 'confirm-if-commits-ahead') {
    throw new SingularityFlowError("adhoc.baseline.upstreamUse must be 'confirm-if-commits-ahead'.");
  }

  const localWork = object(value.localWork, 'adhoc.localWork');
  known(localWork, ['allowed'], 'adhoc.localWork');
  const executionUnits = object(value.executionUnits, 'adhoc.executionUnits');
  known(executionUnits, ['allowed', 'default'], 'adhoc.executionUnits');
  const defaultExecutionUnit = executionUnits.default ?? null;
  if (defaultExecutionUnit !== null && (typeof defaultExecutionUnit !== 'string' || !defaultExecutionUnit.trim())) {
    throw new SingularityFlowError('adhoc.executionUnits.default must be null or a non-empty execution-unit identifier.');
  }

  const scope = object(value.scope, 'adhoc.scope');
  known(scope, ['maximumTouchedResources', 'maximumRepositoriesForDirectLanding'], 'adhoc.scope');
  const externalEffects = object(value.externalEffects, 'adhoc.externalEffects');
  known(externalEffects, ['mode', 'outsideGovernanceBehavior'], 'adhoc.externalEffects');
  if ((externalEffects.mode ?? DEFAULT_POLICY.externalEffects.mode) !== 'governed-device-only') {
    throw new SingularityFlowError("adhoc.externalEffects.mode must be 'governed-device-only'.");
  }
  if ((externalEffects.outsideGovernanceBehavior ?? DEFAULT_POLICY.externalEffects.outsideGovernanceBehavior) !== 'promote-or-reconcile') {
    throw new SingularityFlowError("adhoc.externalEffects.outsideGovernanceBehavior must be 'promote-or-reconcile'.");
  }
  const protectedPaths = object(value.protectedPaths, 'adhoc.protectedPaths');
  known(protectedPaths, ['behavior'], 'adhoc.protectedPaths');
  if ((protectedPaths.behavior ?? 'promote') !== 'promote') {
    throw new SingularityFlowError("adhoc.protectedPaths.behavior must be 'promote'.");
  }

  const directLanding = object(value.directLanding, 'adhoc.directLanding');
  known(directLanding, [
    'enabled', 'maximumRisk', 'requireIntentConfirmation', 'requireDispositionCoverage',
    'requireVerification', 'requireHumanDecision'
  ], 'adhoc.directLanding');
  const maximumRisk = directLanding.maximumRisk ?? DEFAULT_POLICY.directLanding.maximumRisk;
  if (!['low', 'medium', 'high'].includes(maximumRisk)) {
    throw new SingularityFlowError("adhoc.directLanding.maximumRisk must be 'low', 'medium', or 'high'.");
  }
  const requireHumanDecision = directLanding.requireHumanDecision
    ?? DEFAULT_POLICY.directLanding.requireHumanDecision;
  if (!['always', 'policy', 'off'].includes(requireHumanDecision)) {
    throw new SingularityFlowError("adhoc.directLanding.requireHumanDecision must be 'always', 'policy', or 'off'.");
  }

  const promotion = object(value.promotion, 'adhoc.promotion');
  known(promotion, ['triggers'], 'adhoc.promotion');
  const triggers = object(promotion.triggers, 'adhoc.promotion.triggers');
  known(triggers, [
    'repositoriesGreaterThan', 'protectedPathTouched', 'architectureDecisionRequired',
    'externalEffectRequired', 'estimatedRemainingTasksGreaterThan', 'uncertainEffect'
  ], 'adhoc.promotion.triggers');

  const executionCeilings = object(value.executionCeilings, 'adhoc.executionCeilings');
  known(executionCeilings, ['activeMinutes', 'modelInvocations', 'deviceCalls'], 'adhoc.executionCeilings');
  const discard = object(value.discard, 'adhoc.discard');
  known(discard, ['backup', 'backupRetentionDays'], 'adhoc.discard');
  if ((discard.backup ?? DEFAULT_POLICY.discard.backup) !== 'required') {
    throw new SingularityFlowError("adhoc.discard.backup must be 'required'.");
  }

  const telemetry = object(value.telemetry, 'adhoc.telemetry');
  known(telemetry, ['contentFree', 'individualScoring'], 'adhoc.telemetry');
  if ((telemetry.contentFree ?? true) !== true || (telemetry.individualScoring ?? false) !== false) {
    throw new SingularityFlowError('ADH v1 requires content-free telemetry with individual scoring disabled.');
  }

  return Object.freeze({
    enabled: bool(value.enabled, DEFAULT_POLICY.enabled, 'adhoc.enabled'),
    entry: Object.freeze({
      allowExplicitStart: bool(entry.allowExplicitStart, true, 'adhoc.entry.allowExplicitStart'),
      allowUnstartedLanding: bool(entry.allowUnstartedLanding, true, 'adhoc.entry.allowUnstartedLanding'),
      defaultMode
    }),
    baseline: Object.freeze({
      requireExactRevision: bool(baseline.requireExactRevision, true, 'adhoc.baseline.requireExactRevision'),
      dirtyStart,
      upstreamUse
    }),
    localWork: Object.freeze({
      allowed: bool(localWork.allowed, true, 'adhoc.localWork.allowed')
    }),
    executionUnits: Object.freeze({
      allowed: bool(executionUnits.allowed, true, 'adhoc.executionUnits.allowed'),
      default: defaultExecutionUnit == null ? null : defaultExecutionUnit.trim()
    }),
    scope: Object.freeze({
      maximumTouchedResources: integer(scope.maximumTouchedResources, 20, 1, 10_000, 'adhoc.scope.maximumTouchedResources'),
      maximumRepositoriesForDirectLanding: integer(
        scope.maximumRepositoriesForDirectLanding, 1, 1, 100,
        'adhoc.scope.maximumRepositoriesForDirectLanding'
      )
    }),
    externalEffects: Object.freeze({
      mode: 'governed-device-only', outsideGovernanceBehavior: 'promote-or-reconcile'
    }),
    protectedPaths: Object.freeze({ behavior: 'promote' }),
    directLanding: Object.freeze({
      enabled: bool(directLanding.enabled, true, 'adhoc.directLanding.enabled'),
      maximumRisk,
      requireIntentConfirmation: bool(
        directLanding.requireIntentConfirmation, true,
        'adhoc.directLanding.requireIntentConfirmation'
      ),
      requireDispositionCoverage: bool(
        directLanding.requireDispositionCoverage, true,
        'adhoc.directLanding.requireDispositionCoverage'
      ),
      requireVerification: bool(
        directLanding.requireVerification, true,
        'adhoc.directLanding.requireVerification'
      ),
      requireHumanDecision
    }),
    promotion: Object.freeze({
      triggers: Object.freeze({
        repositoriesGreaterThan: integer(
          triggers.repositoriesGreaterThan, 1, 1, 100,
          'adhoc.promotion.triggers.repositoriesGreaterThan'
        ),
        protectedPathTouched: bool(
          triggers.protectedPathTouched, true, 'adhoc.promotion.triggers.protectedPathTouched'
        ),
        architectureDecisionRequired: bool(
          triggers.architectureDecisionRequired, true,
          'adhoc.promotion.triggers.architectureDecisionRequired'
        ),
        externalEffectRequired: bool(
          triggers.externalEffectRequired, true, 'adhoc.promotion.triggers.externalEffectRequired'
        ),
        estimatedRemainingTasksGreaterThan: integer(
          triggers.estimatedRemainingTasksGreaterThan, 3, 0, 10_000,
          'adhoc.promotion.triggers.estimatedRemainingTasksGreaterThan'
        ),
        uncertainEffect: bool(
          triggers.uncertainEffect, true, 'adhoc.promotion.triggers.uncertainEffect'
        )
      })
    }),
    executionCeilings: Object.freeze({
      activeMinutes: integer(
        executionCeilings.activeMinutes, 480, 1, 525_600, 'adhoc.executionCeilings.activeMinutes'
      ),
      modelInvocations: integer(
        executionCeilings.modelInvocations, 30, 0, 10_000,
        'adhoc.executionCeilings.modelInvocations'
      ),
      deviceCalls: integer(
        executionCeilings.deviceCalls, 100, 0, 100_000, 'adhoc.executionCeilings.deviceCalls'
      )
    }),
    discard: Object.freeze({
      backup: 'required',
      backupRetentionDays: integer(
        discard.backupRetentionDays, 14, 1, 3650, 'adhoc.discard.backupRetentionDays'
      )
    }),
    telemetry: Object.freeze({ contentFree: true, individualScoring: false })
  });
}

export const DEFAULT_ADHOC_POLICY = DEFAULT_POLICY;
