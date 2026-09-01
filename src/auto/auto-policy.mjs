import { SingularityFlowError } from '../util.mjs';

export const AUTO_ELIGIBILITY = Object.freeze(['disabled', 'plan-only', 'bounded']);
export const AUTO_PACES = Object.freeze(['step', 'continuous', 'phase', 'interval']);
export const AUTO_PROFILE_SELECTIONS = Object.freeze(['story', 'sgos', 'auto-select']);
// Automatic repair remains unavailable until deterministic machine-actionability is implemented.
// Accepting a configuration value without an enforcing classifier would silently turn policy into
// an unconditional retry, so the installed vocabulary fails closed at human-confirmed repair.
export const AUTO_REPAIR_POLICIES = Object.freeze(['never', 'ask']);
export const AUTO_STOP_KINDS = Object.freeze([
  'first-human-boundary', 'published', 'submitted', 'phase-complete', 'story-complete'
]);
// AUT never grants the execution host a terminal or generic command tool. Publication,
// submission, verification, and every lifecycle mutation remain registered kernel operations.
export const AUTO_AUTHORING_TOOLS = Object.freeze([
  'read_file', 'search', 'edit_file', 'create_file'
]);

const DEFAULT_CEILINGS = Object.freeze({
  maximumPhases: 3,
  // One initial attempt plus, when the separately ratified repair policy permits it, one repair.
  maximumAuthoringAttemptsPerPhase: 2,
  maximumModelInvocations: 6,
  maximumActiveMinutes: 20,
  maximumElapsedMinutes: 120,
  maximumTouchedPaths: 8,
  maximumTouchedChanges: 6,
  tokenBudget: Object.freeze({ maximum: 30_000, assurance: 'exact-required' })
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return value;
}

function keys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SingularityFlowError(`${label} contains unknown field '${key}'.`, { code: 'AUTO_PLAN_INVALID' });
    }
  }
}

function positive(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new SingularityFlowError(`${label} must be a positive safe integer.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return selected;
}

function unique(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Array.isArray(selected) || !selected.length
      || selected.some((entry) => typeof entry !== 'string' || !entry.trim())
      || new Set(selected).size !== selected.length) {
    throw new SingularityFlowError(`${label} must be a non-empty unique string array.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return [...selected];
}

export function parseAutoPace(value, label = 'Auto pace') {
  const pace = String(value ?? 'phase').trim();
  if (AUTO_PACES.includes(pace)) return { mode: pace, intervalMs: null, source: pace };
  const match = /^interval:(\d+)(m|h)$/.exec(pace);
  if (!match) {
    throw new SingularityFlowError(`${label} must be step, continuous, phase, or interval:<duration> such as interval:30m.`, {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  const amount = Number(match[1]);
  const intervalMs = amount * (match[2] === 'h' ? 60 * 60 * 1000 : 60 * 1000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 7 * 24 * 60 * 60 * 1000) {
    throw new SingularityFlowError(`${label} interval must be between 1 minute and 7 days.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return { mode: 'interval', intervalMs, source: pace };
}

function normalizeAutoProfile(value = null) {
  if (value == null) value = {};
  object(value, 'auto.profile');
  keys(value, ['default', 'allowed'], 'auto.profile');
  const allowed = unique(value.allowed, ['story'], 'auto.profile.allowed');
  for (const profile of allowed) {
    if (!['story', 'sgos'].includes(profile)) {
      throw new SingularityFlowError(`auto.profile.allowed contains unsupported profile '${profile}'.`, {
        code: 'AUTO_PLAN_INVALID'
      });
    }
  }
  const selected = value.default ?? 'story';
  if (!AUTO_PROFILE_SELECTIONS.includes(selected) || selected === 'auto-select' && !allowed.includes('story')) {
    throw new SingularityFlowError('auto.profile.default must be story, sgos, or auto-select and resolve to an allowed profile.', {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  if (selected !== 'auto-select' && !allowed.includes(selected)) {
    throw new SingularityFlowError(`auto.profile.default '${selected}' is not listed in auto.profile.allowed.`, {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  return { default: selected, allowed };
}

/** Resolve the currently implemented core profile without making SGOS a dependency of Story Auto. */
export function selectAutoProfile(policy, requested = null) {
  const profile = policy?.profile ?? normalizeAutoProfile();
  const selection = String(requested ?? profile.default ?? 'story').trim();
  if (!AUTO_PROFILE_SELECTIONS.includes(selection)) {
    throw new SingularityFlowError(`Auto profile '${selection}' must be story, sgos, or auto-select.`, {
      code: 'AUTO_PROFILE_INVALID'
    });
  }
  const resolved = selection === 'auto-select' ? 'story' : selection;
  if (!profile.allowed.includes(resolved)) {
    throw new SingularityFlowError(`Auto profile '${resolved}' is not allowed by repository policy.`, {
      code: 'AUTO_PROFILE_FORBIDDEN', details: { allowed: profile.allowed }
    });
  }
  if (resolved === 'sgos') {
    throw new SingularityFlowError(
      'The SGOS Auto profile adapter is not installed in this release. Use --profile story; ordinary Story Auto remains available.',
      { code: 'AUTO_PROFILE_UNAVAILABLE', details: { fallback: 'story' } }
    );
  }
  return { requested: selection, resolved: 'story', selectionReason: selection === 'auto-select' ? 'core-fallback' : 'explicit' };
}

export function parseAutoStopSelector(value, phaseIds = [], label = 'Auto stop selector') {
  const selector = String(value ?? 'first-human-boundary').trim();
  if (selector === 'first-human-boundary' || selector === 'story-complete') {
    return { kind: selector, phase: null, source: selector };
  }
  const match = /^(published|submitted|phase-complete):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(selector);
  if (!match) {
    throw new SingularityFlowError(`${label} is invalid.`, { code: 'AUTO_PLAN_INVALID', details: { selector } });
  }
  // Root and capability defaults are validated before a work type has been selected. Validate a
  // named phase as soon as the concrete Story rail is available; until then retain the selector
  // verbatim so policy loading does not reject a valid work-type-specific phase.
  if (phaseIds.length && !phaseIds.includes(match[2])) {
    throw new SingularityFlowError(`${label} references phase '${match[2]}', which is not in the selected Story rail.`, {
      code: 'AUTO_PLAN_INVALID', details: { selector, phase: match[2], phaseIds }
    });
  }
  return { kind: match[1], phase: match[2], source: selector };
}

export function normalizeAutoCeilings(value = {}, defaults = DEFAULT_CEILINGS, label = 'auto.ceilings') {
  object(value, label);
  keys(value, [
    'maximumPhases', 'maximumAuthoringAttemptsPerPhase', 'maximumModelInvocations',
    'maximumActiveMinutes', 'maximumElapsedMinutes', 'maximumTouchedPaths',
    'maximumTouchedChanges', 'tokenBudget'
  ], label);
  const token = object(value.tokenBudget ?? defaults.tokenBudget, `${label}.tokenBudget`);
  keys(token, ['maximum', 'assurance'], `${label}.tokenBudget`);
  const assurance = token.assurance ?? defaults.tokenBudget.assurance;
  if (!['exact-required', 'best-available'].includes(assurance)) {
    throw new SingularityFlowError(`${label}.tokenBudget.assurance must be exact-required or best-available.`, {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  return {
    maximumPhases: positive(value.maximumPhases, defaults.maximumPhases, `${label}.maximumPhases`),
    maximumAuthoringAttemptsPerPhase: positive(
      value.maximumAuthoringAttemptsPerPhase,
      defaults.maximumAuthoringAttemptsPerPhase,
      `${label}.maximumAuthoringAttemptsPerPhase`
    ),
    maximumModelInvocations: positive(value.maximumModelInvocations, defaults.maximumModelInvocations, `${label}.maximumModelInvocations`),
    maximumActiveMinutes: positive(value.maximumActiveMinutes, defaults.maximumActiveMinutes, `${label}.maximumActiveMinutes`),
    maximumElapsedMinutes: positive(value.maximumElapsedMinutes, defaults.maximumElapsedMinutes, `${label}.maximumElapsedMinutes`),
    maximumTouchedPaths: positive(value.maximumTouchedPaths, defaults.maximumTouchedPaths, `${label}.maximumTouchedPaths`),
    maximumTouchedChanges: positive(value.maximumTouchedChanges, defaults.maximumTouchedChanges, `${label}.maximumTouchedChanges`),
    tokenBudget: { maximum: positive(token.maximum, defaults.tokenBudget.maximum, `${label}.tokenBudget.maximum`), assurance }
  };
}

function tightenCeilings(parent, child = {}) {
  const normalized = normalizeAutoCeilings(child, parent, 'Auto policy ceilings');
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => {
    if (key !== 'tokenBudget') return [key, Math.min(parent[key], value)];
    return [key, {
      maximum: Math.min(parent.tokenBudget.maximum, value.maximum),
      assurance: parent.tokenBudget.assurance === 'exact-required' || value.assurance === 'exact-required'
        ? 'exact-required' : 'best-available'
    }];
  }));
}

function ceilingOverrides(value, label) {
  object(value, label);
  keys(value, [
    'maximumPhases', 'maximumAuthoringAttemptsPerPhase', 'maximumModelInvocations',
    'maximumActiveMinutes', 'maximumElapsedMinutes', 'maximumTouchedPaths',
    'maximumTouchedChanges', 'tokenBudget'
  ], label);
  const output = {};
  for (const field of [
    'maximumPhases', 'maximumAuthoringAttemptsPerPhase', 'maximumModelInvocations',
    'maximumActiveMinutes', 'maximumElapsedMinutes', 'maximumTouchedPaths', 'maximumTouchedChanges'
  ]) {
    if (value[field] != null) output[field] = positive(value[field], null, `${label}.${field}`);
  }
  if (value.tokenBudget != null) {
    const token = object(value.tokenBudget, `${label}.tokenBudget`);
    keys(token, ['maximum', 'assurance'], `${label}.tokenBudget`);
    output.tokenBudget = {};
    if (token.maximum != null) output.tokenBudget.maximum = positive(token.maximum, null, `${label}.tokenBudget.maximum`);
    if (token.assurance != null) {
      if (!['exact-required', 'best-available'].includes(token.assurance)) {
        throw new SingularityFlowError(`${label}.tokenBudget.assurance must be exact-required or best-available.`, {
          code: 'AUTO_PLAN_INVALID'
        });
      }
      output.tokenBudget.assurance = token.assurance;
    }
  }
  return output;
}

function tightenPartialCeilings(left = {}, right = {}) {
  const output = {};
  for (const field of [
    'maximumPhases', 'maximumAuthoringAttemptsPerPhase', 'maximumModelInvocations',
    'maximumActiveMinutes', 'maximumElapsedMinutes', 'maximumTouchedPaths', 'maximumTouchedChanges'
  ]) {
    if (left[field] != null || right[field] != null) {
      output[field] = left[field] == null ? right[field]
        : right[field] == null ? left[field] : Math.min(left[field], right[field]);
    }
  }
  if (left.tokenBudget || right.tokenBudget) {
    const maximum = left.tokenBudget?.maximum == null ? right.tokenBudget?.maximum
      : right.tokenBudget?.maximum == null ? left.tokenBudget.maximum
        : Math.min(left.tokenBudget.maximum, right.tokenBudget.maximum);
    const assurance = left.tokenBudget?.assurance === 'exact-required' || right.tokenBudget?.assurance === 'exact-required'
      ? 'exact-required' : left.tokenBudget?.assurance ?? right.tokenBudget?.assurance;
    output.tokenBudget = {
      ...(maximum == null ? {} : { maximum }),
      ...(assurance == null ? {} : { assurance })
    };
  }
  return output;
}

export function normalizeAutoPolicy(value = null) {
  if (value == null) value = {};
  object(value, 'auto');
  keys(value, [
    'enabled', 'profile', 'defaultPace', 'defaultUntil', 'workIdAllocator', 'planTtlMinutes',
    'concurrency', 'execution', 'ceilings', 'repair', 'reporting'
  ], 'auto');
  if (value.enabled != null && typeof value.enabled !== 'boolean') {
    throw new SingularityFlowError('auto.enabled must be boolean.', { code: 'AUTO_PLAN_INVALID' });
  }
  const pace = parseAutoPace(value.defaultPace ?? 'phase', 'auto.defaultPace');
  const stop = parseAutoStopSelector(value.defaultUntil ?? 'first-human-boundary', [], 'auto.defaultUntil');
  const workIdAllocator = value.workIdAllocator ?? 'ulid';
  if (!['require-explicit', 'workspace-sequence', 'ulid', 'jira-or-workspace'].includes(workIdAllocator)) {
    throw new SingularityFlowError('auto.workIdAllocator is unsupported.', { code: 'AUTO_PLAN_INVALID' });
  }
  const concurrency = object(value.concurrency ?? {}, 'auto.concurrency');
  keys(concurrency, ['maximumPerCapability', 'maximumPerWorkspace'], 'auto.concurrency');
  const execution = object(value.execution ?? {}, 'auto.execution');
  keys(execution, [
    'allowedHosts', 'requireManagedWorktree', 'automaticResume', 'allowPolicyWaivers',
    'allowClarificationAnswers', 'allowSequenceOverrides', 'allowScopeExpansion'
  ], 'auto.execution');
  const prohibited = [
    'automaticResume', 'allowPolicyWaivers', 'allowClarificationAnswers',
    'allowSequenceOverrides', 'allowScopeExpansion'
  ];
  for (const field of prohibited) {
    if (execution[field] === true) {
      throw new SingularityFlowError(`auto.execution.${field} cannot be true in AUT v1.`, {
        code: 'AUTO_OPERATION_FORBIDDEN'
      });
    }
  }
  if (execution.requireManagedWorktree === false) {
    throw new SingularityFlowError('AUT v1 requires managed worktrees.', { code: 'AUTO_OPERATION_FORBIDDEN' });
  }
  const reporting = object(value.reporting ?? {}, 'auto.reporting');
  keys(reporting, ['checkpoint', 'final'], 'auto.reporting');
  if (reporting.checkpoint != null && !['local', 'governed-when-publishing'].includes(reporting.checkpoint)) {
    throw new SingularityFlowError('auto.reporting.checkpoint is unsupported.', { code: 'AUTO_PLAN_INVALID' });
  }
  if (reporting.final != null && !['required'].includes(reporting.final)) {
    throw new SingularityFlowError('auto.reporting.final must be required.', { code: 'AUTO_PLAN_INVALID' });
  }
  const repair = object(value.repair ?? {}, 'auto.repair');
  keys(repair, ['policy', 'maximumAttempts'], 'auto.repair');
  const repairPolicy = repair.policy ?? 'ask';
  if (!AUTO_REPAIR_POLICIES.includes(repairPolicy)) {
    throw new SingularityFlowError(`auto.repair.policy must be ${AUTO_REPAIR_POLICIES.join(', ')}.`, {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  const maximumRepairAttempts = repair.maximumAttempts ?? 1;
  if (!Number.isSafeInteger(maximumRepairAttempts) || maximumRepairAttempts < 0 || maximumRepairAttempts > 1) {
    throw new SingularityFlowError('auto.repair.maximumAttempts must be 0 or 1.', { code: 'AUTO_PLAN_INVALID' });
  }
  return {
    enabled: value.enabled === true,
    profile: normalizeAutoProfile(value.profile),
    defaultPace: pace.source,
    defaultUntil: stop.source,
    workIdAllocator,
    planTtlMinutes: positive(value.planTtlMinutes, 30, 'auto.planTtlMinutes'),
    concurrency: {
      maximumPerCapability: positive(concurrency.maximumPerCapability, 1, 'auto.concurrency.maximumPerCapability'),
      maximumPerWorkspace: positive(concurrency.maximumPerWorkspace, 2, 'auto.concurrency.maximumPerWorkspace')
    },
    execution: {
      allowedHosts: unique(execution.allowedHosts, ['copilot-cli'], 'auto.execution.allowedHosts'),
      requireManagedWorktree: true,
      automaticResume: false,
      allowPolicyWaivers: false,
      allowClarificationAnswers: false,
      allowSequenceOverrides: false,
      allowScopeExpansion: false
    },
    ceilings: normalizeAutoCeilings(value.ceilings ?? {}),
    repair: { policy: repairPolicy, maximumAttempts: maximumRepairAttempts },
    reporting: { checkpoint: reporting.checkpoint ?? 'governed-when-publishing', final: 'required' }
  };
}

export function normalizeAutoWorkTypePolicy(value = null, label = 'workType.auto', phaseIds = []) {
  if (value == null) value = {};
  object(value, label);
  keys(value, ['eligibility', 'allowedPaces', 'defaultUntil', 'ceilings'], label);
  const eligibility = value.eligibility ?? 'disabled';
  if (!AUTO_ELIGIBILITY.includes(eligibility)) {
    throw new SingularityFlowError(`${label}.eligibility must be ${AUTO_ELIGIBILITY.join(', ')}.`, {
      code: 'AUTO_PLAN_INVALID'
    });
  }
  const allowedPaces = unique(value.allowedPaces, AUTO_PACES, `${label}.allowedPaces`);
  for (const pace of allowedPaces) {
    if (!AUTO_PACES.includes(pace)) throw new SingularityFlowError(`${label}.allowedPaces contains '${pace}'.`, { code: 'AUTO_PLAN_INVALID' });
  }
  parseAutoStopSelector(value.defaultUntil ?? 'first-human-boundary', phaseIds, `${label}.defaultUntil`);
  return {
    eligibility,
    allowedPaces,
    defaultUntil: value.defaultUntil ?? 'first-human-boundary',
    ceilings: value.ceilings == null ? null : ceilingOverrides(value.ceilings, `${label}.ceilings`)
  };
}

export function normalizeCapabilityAutoPolicy(value = null, label = 'Capability policy.auto') {
  if (value == null) return null;
  object(value, label);
  keys(value, [
    'eligibility', 'forbiddenWhenProtectedScopePredicted', 'maximumTouchedPaths',
    'maximumConcurrentFlights', 'ceilings'
  ], label);
  const eligibility = value.eligibility ?? 'bounded';
  if (!AUTO_ELIGIBILITY.includes(eligibility)) {
    throw new SingularityFlowError(`${label}.eligibility must be ${AUTO_ELIGIBILITY.join(', ')}.`, { code: 'AUTO_PLAN_INVALID' });
  }
  if (value.forbiddenWhenProtectedScopePredicted != null && typeof value.forbiddenWhenProtectedScopePredicted !== 'boolean') {
    throw new SingularityFlowError(`${label}.forbiddenWhenProtectedScopePredicted must be boolean.`, { code: 'AUTO_PLAN_INVALID' });
  }
  return {
    eligibility,
    forbiddenWhenProtectedScopePredicted: value.forbiddenWhenProtectedScopePredicted !== false,
    maximumTouchedPaths: value.maximumTouchedPaths == null ? null : positive(value.maximumTouchedPaths, null, `${label}.maximumTouchedPaths`),
    maximumConcurrentFlights: value.maximumConcurrentFlights == null ? null : positive(value.maximumConcurrentFlights, null, `${label}.maximumConcurrentFlights`),
    ceilings: value.ceilings == null ? null : ceilingOverrides(value.ceilings, `${label}.ceilings`)
  };
}

const ELIGIBILITY_ORDER = ['disabled', 'plan-only', 'bounded'];

function tighterEligibility(left, right) {
  return ELIGIBILITY_ORDER[Math.min(ELIGIBILITY_ORDER.indexOf(left), ELIGIBILITY_ORDER.indexOf(right))];
}

export function foldCapabilityAutoPolicy(parent = null, child = null) {
  if (!parent) return child ? normalizeCapabilityAutoPolicy(child) : null;
  if (!child) return normalizeCapabilityAutoPolicy(parent);
  const left = normalizeCapabilityAutoPolicy(parent);
  const right = normalizeCapabilityAutoPolicy(child);
  return {
    eligibility: tighterEligibility(left.eligibility, right.eligibility),
    forbiddenWhenProtectedScopePredicted: left.forbiddenWhenProtectedScopePredicted || right.forbiddenWhenProtectedScopePredicted,
    maximumTouchedPaths: left.maximumTouchedPaths == null ? right.maximumTouchedPaths
      : right.maximumTouchedPaths == null ? left.maximumTouchedPaths : Math.min(left.maximumTouchedPaths, right.maximumTouchedPaths),
    maximumConcurrentFlights: left.maximumConcurrentFlights == null ? right.maximumConcurrentFlights
      : right.maximumConcurrentFlights == null ? left.maximumConcurrentFlights : Math.min(left.maximumConcurrentFlights, right.maximumConcurrentFlights),
    ceilings: left.ceilings && right.ceilings
      ? tightenPartialCeilings(left.ceilings, right.ceilings)
      : left.ceilings ?? right.ceilings
  };
}

export function effectiveAutoPolicy(rootPolicy, workTypePolicy, capabilityPolicy = null) {
  const root = normalizeAutoPolicy(rootPolicy);
  const workType = normalizeAutoWorkTypePolicy(workTypePolicy);
  const capability = capabilityPolicy ? normalizeCapabilityAutoPolicy(capabilityPolicy) : null;
  const eligibility = capability
    ? tighterEligibility(workType.eligibility, capability.eligibility)
    : workType.eligibility;
  let ceilings = workType.ceilings ? tightenCeilings(root.ceilings, workType.ceilings) : root.ceilings;
  if (capability?.ceilings) ceilings = tightenCeilings(ceilings, capability.ceilings);
  if (capability?.maximumTouchedPaths != null) {
    ceilings = { ...ceilings, maximumTouchedPaths: Math.min(ceilings.maximumTouchedPaths, capability.maximumTouchedPaths) };
  }
  return { ...root, eligibility, ceilings, capability };
}
