/** Stable error/result identifiers mapped to reviewed help topics. */
const EXACT_CODES = Object.freeze({
  SINGULARITY_FLOW_UNINITIALIZED_REPOSITORY: 'installation-and-upgrades',
  SINGULARITY_FLOW_LEGACY_CONTROL_ROOT: 'installation-and-upgrades',
  DOCS_TOPICS_MISSING: 'help-and-docs',
  DOCS_MANIFEST_MISSING: 'help-and-docs',
  DOCS_MANIFEST_MISMATCH: 'help-and-docs',
  HELP_METRICS_LOCK_BUSY: 'activity-and-prompt-audit',
  HELP_METRICS_SETTINGS_INVALID: 'activity-and-prompt-audit',
  AST_WARM_TIMEOUT: 'ast-intelligence',
  GIT_COMMIT_IDENTITY_INVALID: 'capability-management',
  CAPABILITY_ACTIVATION_RECOVERY_CONFLICT: 'capability-management',
  CAPABILITY_ACTIVATION_AUDIT_PENDING: 'capability-management',
  CAPABILITY_PROJECTION_AUTHORITY_MOVED: 'capability-management',
  WFA_DEPENDENCY_UNAVAILABLE: 'repository-state-and-snapshots',
  WFA_RUNTIME_INCOMPATIBLE: 'repository-state-and-snapshots',
  WMC_INTENT_REPORT_MISMATCH: 'calm-architecture',
  WMC_INTENT_ALREADY_EXISTS: 'calm-architecture',
  WMC_INTENT_REVISION_CONFLICT: 'calm-architecture',
  WMC_INTENT_POLICY_INVALID: 'calm-architecture',
  WMC_INTENT_GENERATION_STALE: 'calm-architecture',
  WMC_INTENT_NOT_APPROVED: 'calm-architecture',
  WMC_INTENT_UNFULFILLED: 'calm-architecture',
  WMB_SOURCE_SNAPSHOT_REQUIRED: 'world-model',
  WMB_CACHE_INPUT_INVALID: 'world-model',
  UNKNOWN_COMMAND: 'help-and-docs'
});

const PREFIXES = Object.freeze([
  ['approval', 'approvals'],
  ['agent', 'agents-and-routing'],
  ['artifact', 'artifacts-and-generation'],
  ['ast', 'ast-intelligence'],
  ['capability', 'capability-management'],
  ['configuration', 'configuration'],
  ['docs', 'help-and-docs'],
  ['explain', 'help-and-docs'],
  ['fault', 'fault-intake-and-repair'],
  ['gateway', 'help-and-docs'],
  ['generation', 'artifacts-and-generation'],
  ['grounding', 'world-model'],
  ['identity', 'approvals'],
  ['phase', 'story-lifecycle'],
  ['prompt', 'activity-and-prompt-audit'],
  ['recovery', 'recovery'],
  ['sequence', 'sequence-gates'],
  ['story', 'story-lifecycle'],
  ['telemetry', 'telemetry-and-cost'],
  ['token', 'telemetry-and-cost'],
  ['workspace', 'workspaces-and-sessions'],
  ['world-model', 'world-model'],
  ['wm', 'world-model']
]);

const COMPATIBILITY_MESSAGES = Object.freeze([
  [/missing singularity\/workflow\.yml/i, 'installation-and-upgrades'],
  [/interrupted before (?:its )?governed commit completed/i, 'recovery'],
  [/adoption confirmation must equal the current change-set digest/i, 'recovery'],
  [/generation (?:is )?not publishable|generation intent .* consumed/i, 'artifacts-and-generation'],
  [/is not a member of:|authorized reviewer/i, 'approvals'],
  [/repository grounding is not ready/i, 'world-model']
]);

function topicForIdentifier(value) {
  const identifier = String(value ?? '').trim();
  if (!identifier) return null;
  if (EXACT_CODES[identifier]) return EXACT_CODES[identifier];
  const normalized = identifier.toLocaleLowerCase('en-US').replace(/_/g, '-');
  return PREFIXES.find(([prefix]) => normalized === prefix
    || normalized.startsWith(`${prefix}.`) || normalized.startsWith(`${prefix}-`))?.[1] ?? null;
}

export function helpTopicForError({ code = null, messageId = null, operation = null, message = null } = {}) {
  const identified = topicForIdentifier(code) ?? topicForIdentifier(messageId) ?? topicForIdentifier(operation);
  if (identified) return identified;
  const text = String(message ?? '').slice(0, 500);
  return COMPATIBILITY_MESSAGES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
