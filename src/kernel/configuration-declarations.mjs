/** Shared configuration declarations and bounds. No host, backend selection, provider or storage I/O. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { generationTask, phaseRequiresCodeDelivery } from './phase-policy.mjs';

// analysis-limits.mjs


export const DEFAULT_ANALYSIS_LIMITS = Object.freeze({
  /** Refused above this: analysing a document this large is answering the wrong question. */
  maxArtifactBytes: 2 * 1024 * 1024,
  /** Reconciliation findings convergence will join before it starts capping. */
  maxChangedPaths: 2000,
  /** Clauses convergence will consider. `extractClauses` bounds the index itself. */
  maxClauses: 2000,
  /** Evidence records bound into one iteration. */
  maxEvidenceRecords: 500,
  /** Facts or findings a single report will carry. */
  maxFacts: 500,
  /** The serialized record, so one iteration cannot become a file nothing can open. */
  maxOutputBytes: 4 * 1024 * 1024
});

// Keep initialization data-only; the ordered keys are checked against the default declaration.
const KEYS = Object.freeze(["maxArtifactBytes","maxChangedPaths","maxClauses","maxEvidenceRecords","maxFacts","maxOutputBytes"]);


/** Normalize and validate a configured `analysisLimits` block. */
export function analysisLimits(value = {}) {
  if (value == null) return DEFAULT_ANALYSIS_LIMITS;
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('analysisLimits must be an object.');
  for (const key of Object.keys(value)) {
    if (!KEYS.includes(key)) throw new SingularityFlowError(`analysisLimits contains unknown field '${key}'. Allowed: ${KEYS.join(', ')}.`);
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new SingularityFlowError(`analysisLimits.${key} must be a positive integer.`);
    }
  }
  return Object.freeze({ ...DEFAULT_ANALYSIS_LIMITS, ...value });
}

// story-branch-name.mjs

const PLACEHOLDER = /\{([A-Za-z]+)\}/gu;

const PLACEHOLDERS = new Set(['id', 'title']);


/** `git.branchNaming` in workflow.yml: `{ pattern }`, the pattern naming every new Story's branch. */
export function assertStoryBranchNaming(value, label = 'git.branchNaming') {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be a mapping with a pattern, for example { pattern: 'feature/{id}-{title}' }.`);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'pattern') throw new SingularityFlowError(`${label}.${key} is not a setting. The only setting is pattern.`);
  }
  const { pattern } = value;
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new SingularityFlowError(`${label}.pattern must be a non-empty string, for example 'feature/{id}-{title}'.`);
  }
  const used = [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1]);
  const unknown = used.find((name) => !PLACEHOLDERS.has(name));
  if (unknown) throw new SingularityFlowError(`${label}.pattern uses {${unknown}}. The placeholders are {id} and {title}.`);
  if (!used.includes('id')) {
    throw new SingularityFlowError(`${label}.pattern must contain {id}, so that every Story gets its own branch.`);
  }
}

// source-boundary.mjs


export const SOURCE_BOUNDARIES = Object.freeze(['unrestricted', 'test-automation']);


export function normalizeSourceBoundary(value = 'unrestricted', phaseId = 'unknown') {
  const boundary = value ?? 'unrestricted';
  if (!SOURCE_BOUNDARIES.includes(boundary)) {
    throw new SingularityFlowError(
      `Phase '${phaseId}' sourceBoundary must be ${SOURCE_BOUNDARIES.join(' or ')}.`
    );
  }
  return boundary;
}

// logging.mjs


// Ordered severities. `off` disables everything; `all` is an alias for `trace` because that is what
// people type when they want the lot.
export const LOG_LEVELS = Object.freeze({ off: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4 });

const LEVEL_ALIASES = Object.freeze({ all: 'trace', verbose: 'debug', quiet: 'error', silent: 'off', warning: 'warn' });

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

const DEFAULT_KEEP = 3;


export function normalizeLogLevel(value, fallback = 'info') {
  const raw = String(value ?? '').trim().toLowerCase();
  const resolved = LEVEL_ALIASES[raw] ?? raw;
  return resolved in LOG_LEVELS ? resolved : fallback;
}


export function normalizeLogging(value = {}) {
  if (value == null) return { level: 'info', console: 'warn', maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_KEEP };
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('logging must be an object.');
  for (const key of Object.keys(value)) {
    if (!['level', 'console', 'maxBytes', 'keep'].includes(key)) throw new SingularityFlowError(`logging contains unknown field '${key}'.`);
  }
  const maxBytes = value.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = value.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(maxBytes) || maxBytes < 4096) throw new SingularityFlowError('logging.maxBytes must be an integer of at least 4096.');
  if (!Number.isInteger(keep) || keep < 1 || keep > 20) throw new SingularityFlowError('logging.keep must be an integer between 1 and 20.');
  return { level: normalizeLogLevel(value.level, 'info'), console: normalizeLogLevel(value.console, 'warn'), maxBytes, keep };
}

// ledger-config.mjs


const BEHIND_MODES = new Set(['warn', 'block']);

const ENFORCEMENT_MODES = new Set(['shadow', 'required']);

const SIGNING_MODES = new Set(['off', 'commit']);

const TRUST_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);

const PIN_TRANSPORTS = new Set(['refs', 'branches', 'none']);

const PUBLICATION_MODES = new Set(['off', 'warn', 'required']);


function string(value, fallback, label) {
  const result = value ?? fallback;
  if (typeof result !== 'string' || !result.trim()) throw new SingularityFlowError(`${label} must be a non-empty string.`);
  return result.trim();
}


export function normalizeLedgerConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('ledger must be an object.');
  for (const key of Object.keys(value)) {
    if (!['enabled', 'branch', 'remote', 'behind', 'enforcement', 'signing', 'trustTier', 'maxRetries', 'pinTransport', 'retentionDays', 'publication', 'configurationHistory'].includes(key)) {
      throw new SingularityFlowError(`ledger contains unknown field '${key}'.`);
    }
  }
  if (value.enabled != null && typeof value.enabled !== 'boolean') throw new SingularityFlowError('ledger.enabled must be boolean.');
  const branch = string(value.branch, 'state', 'ledger.branch');
  const remote = string(value.remote, 'origin', 'ledger.remote');
  const behind = value.behind ?? 'warn';
  if (!BEHIND_MODES.has(behind)) throw new SingularityFlowError('ledger.behind must be warn or block.');
  const enforcement = value.enforcement ?? 'shadow';
  if (!ENFORCEMENT_MODES.has(enforcement)) throw new SingularityFlowError('ledger.enforcement must be shadow or required.');
  const signing = value.signing ?? 'off';
  if (!SIGNING_MODES.has(signing)) throw new SingularityFlowError('ledger.signing must be off or commit.');
  const trustTier = value.trustTier ?? 'T0';
  if (!TRUST_TIERS.has(trustTier)) throw new SingularityFlowError('ledger.trustTier must be T0, T1, T2, or T3.');
  const pinTransport = value.pinTransport ?? 'refs';
  if (!PIN_TRANSPORTS.has(pinTransport)) throw new SingularityFlowError('ledger.pinTransport must be refs, branches, or none.');
  const publication = value.publication ?? 'warn';
  if (!PUBLICATION_MODES.has(publication)) throw new SingularityFlowError('ledger.publication must be off, warn, or required.');
  const retentionDays = value.retentionDays ?? 2555;
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 36500) {
    throw new SingularityFlowError('ledger.retentionDays must be an integer from 0 through 36500.');
  }
  const maxRetries = value.maxRetries ?? 4;
  if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 20) {
    throw new SingularityFlowError('ledger.maxRetries must be an integer from 1 through 20.');
  }
  if (['T2', 'T3'].includes(trustTier) && signing === 'off') {
    throw new SingularityFlowError(`${trustTier} requires ledger.signing: commit or a future event-signature driver.`);
  }
  const configurationHistory = value.configurationHistory == null ? null
    : normalizeConfigurationHistory(value.configurationHistory);
  return {
    enabled: value.enabled === true,
    branch,
    remote,
    behind,
    enforcement,
    signing,
    trustTier,
    maxRetries,
    pinTransport,
    publication,
    retentionDays,
    // Only when set, so a pinned Story resolution reads the same as before the field existed.
    ...(configurationHistory ? { configurationHistory } : {})
  };
}


/** `ledger.configurationHistory`: auto-clear of old `sflow/config-history/*` branches (on, 10 kept). */
export function normalizeConfigurationHistory(value) {
  const label = 'ledger.configurationHistory';
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'autoClear' && key !== 'keepRecent')) {
    throw new SingularityFlowError(`${label} takes only autoClear (boolean) and keepRecent (1-100).`);
  }
  const keepRecent = value.keepRecent ?? 10;
  if ((value.autoClear != null && typeof value.autoClear !== 'boolean')
    || !Number.isInteger(keepRecent) || keepRecent < 1 || keepRecent > 100) {
    throw new SingularityFlowError(`${label} takes only autoClear (boolean) and keepRecent (1-100).`);
  }
  return { autoClear: value.autoClear !== false, keepRecent };
}

// initiative-config.mjs

export const STORAGE_PROVIDER_TYPES = new Set(['jira-attachment', 'artifactory', 'sharepoint', 's3', 'https-reference', 'local']);


function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} must be an object.`);
  return value;
}


function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new SingularityFlowError(`${label} must be a safe identifier containing letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}


function unique(values, label) {
  if (new Set(values).size !== values.length) throw new SingularityFlowError(`${label} contains duplicates.`);
}


export function normalizeStorage(value = {}) {
  object(value, 'storage');
  const providers = object(value.providers ?? {}, 'storage.providers');
  const normalized = {};
  for (const [id, raw] of Object.entries(providers)) {
    safeId(id, 'Storage provider ID');
    object(raw, `Storage provider '${id}'`);
    const type = raw.type;
    if (!STORAGE_PROVIDER_TYPES.has(type)) throw new SingularityFlowError(`Storage provider '${id}' has unsupported type '${type}'.`);
    if (raw.maxBytes != null && (!Number.isInteger(raw.maxBytes) || raw.maxBytes < 1)) throw new SingularityFlowError(`Storage provider '${id}' maxBytes must be a positive integer.`);
    const allowedMimeTypes = [...(raw.allowedMimeTypes ?? [])].map(String);
    unique(allowedMimeTypes, `Storage provider '${id}' allowedMimeTypes`);
    const provider = { ...structuredClone(raw), type, maxBytes: raw.maxBytes ?? null, allowedMimeTypes };
    if (type === 'artifactory') {
      if (!raw.baseUrl || !raw.repository) throw new SingularityFlowError(`Artifactory provider '${id}' requires baseUrl and repository.`);
      provider.baseUrl = new URL(raw.baseUrl).toString().replace(/\/$/, '');
      if (!provider.baseUrl.startsWith('https://')) throw new SingularityFlowError(`Artifactory provider '${id}' must use HTTPS.`);
      provider.repository = safeId(raw.repository, `Artifactory provider '${id}' repository`);
    }
    if (type === 'sharepoint') {
      for (const field of ['tenantId', 'clientId', 'siteId', 'driveId']) if (!raw[field]) throw new SingularityFlowError(`SharePoint provider '${id}' requires ${field}.`);
      provider.scopes = [...(raw.scopes ?? ['offline_access', 'User.Read', 'Files.ReadWrite.All'])].map(String);
      unique(provider.scopes, `SharePoint provider '${id}' scopes`);
      if (!provider.scopes.length || provider.scopes.some((scope) => !scope.trim() || /\s/.test(scope))) {
        throw new SingularityFlowError(`SharePoint provider '${id}' scopes must be non-empty values without whitespace.`);
      }
    }
    if (type === 's3') {
      if (!raw.bucket) throw new SingularityFlowError(`S3 provider '${id}' requires bucket.`);
      provider.prefix = String(raw.prefix ?? 'singularity-flow').replace(/^\/+|\/+$/g, '');
    }
    normalized[id] = provider;
  }
  const defaultProvider = value.defaultProvider ?? Object.keys(normalized)[0] ?? null;
  if (defaultProvider && !normalized[defaultProvider]) throw new SingularityFlowError(`storage.defaultProvider references unknown provider '${defaultProvider}'.`);
  const maxBytes = value.maxBytes ?? 100 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new SingularityFlowError('storage.maxBytes must be a positive integer.');
  const allowedMimeTypes = [...(value.allowedMimeTypes ?? [])].map(String);
  unique(allowedMimeTypes, 'storage.allowedMimeTypes');
  return { defaultProvider, maxBytes, allowedMimeTypes, providers: normalized };
}

// removed-features.mjs


/**
 * Settings and commands of removed features: the registered World Model (WMB v4 views, its state-branch
 * publication and the Story history pins), the CALM architecture projection and architecture
 * intent. A configuration that still carries them loads unchanged: they are dropped when it is
 * validated, `doctor` names them, and nothing reads them. Removing them from
 * `singularity/workflow.yml` silences doctor. Their commands are refused by name, saying what
 * replaced them, so a script learns it instead of failing on an unknown command.
 */

const DROPPED = new WeakMap();


/** The top-level settings that belong only to removed features. */
const REMOVED_TOP_LEVEL = Object.freeze(['architectureIntent']);


/**
 * The `worldModel.*` settings still read: the Repository brief (`knowledge`), the source scope the
 * brief and capabilities share, and the state-branch aliases the ledger honours. Every other
 * `worldModel` setting belonged to the removed registered World Model.
 */
const KEPT_WORLD_MODEL = Object.freeze(new Set([
  'knowledge', 'sourceRoots', 'sharedRoots', 'excludedRoots', 'stateBranch', 'remote'
]));


function record(definition, name) {
  if (!DROPPED.has(definition)) DROPPED.set(definition, []);
  DROPPED.get(definition).push(name);
}


/** Drop removed-feature settings from a definition being validated; returns their names. */
export function dropRemovedSettings(definition) {
  if (!definition || typeof definition !== 'object') return [];
  for (const key of REMOVED_TOP_LEVEL) {
    if (Object.hasOwn(definition, key)) {
      delete definition[key];
      record(definition, key);
    }
  }
  const worldModel = definition.worldModel;
  if (worldModel && typeof worldModel === 'object' && !Array.isArray(worldModel)) {
    for (const key of Object.keys(worldModel)) {
      if (KEPT_WORLD_MODEL.has(key)) continue;
      delete worldModel[key];
      record(definition, `worldModel.${key}`);
    }
  }
  // Phase World Model views and depth, in the shared phases and in workflow phase overrides.
  let phaseSettings = 0;
  for (const phase of Object.values(definition.phases ?? {})) {
    if (phase && typeof phase === 'object' && Object.hasOwn(phase, 'worldModel')) { delete phase.worldModel; phaseSettings += 1; }
  }
  for (const workType of Object.values(definition.workTypes ?? {})) {
    for (const override of Object.values(workType?.phaseOverrides ?? {})) {
      if (override && typeof override === 'object' && Object.hasOwn(override, 'worldModel')) { delete override.worldModel; phaseSettings += 1; }
    }
  }
  if (phaseSettings) record(definition, `World Model views on ${phaseSettings} phase(s)`);
  return removedSettings(definition);
}


/** The removed-feature settings a validated definition carried. */
export function removedSettings(definition) {
  return definition && typeof definition === 'object' ? [...(DROPPED.get(definition) ?? [])] : [];
}


/** Architecture intent as every Story pins it now: the removed feature, disabled. */
export function disabledArchitectureIntent() {
  return { enabled: false, allowedPhases: [], blockRequiredUnfulfilledAt: [] };
}

// agent-document-parser.mjs


export function parseAgentTemplateReference(value) {
  const match = /^agent:([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(value ?? '');
  if (!match) throw new SingularityFlowError(`Remote template reference '${value}' must use agent:<agent-id>/<template-id>.`);
  return { agentId: match[1], templateId: match[2] };
}


export function isAgentTemplateReference(value) { return typeof value === 'string' && value.startsWith('agent:'); }

// convergence.mjs


/**
 * Refuse a configuration that would loop implementation and convergence on its own `[SPK:CON-037]`.
 *
 * The temptation is obvious — "keep implementing and converging until no findings remain" — and it
 * is the one shape this loop must not take. Convergence exists so a human decides what an absence of
 * evidence means; a machine that repeats the cycle until the facts go quiet has removed exactly that
 * step while appearing to honour it. Refused at configuration load, because by the time it is
 * running there is no honest place to stop it.
 */
const AUTONOMOUS_KEYS = Object.freeze(['repeatUntil', 'autoRepeat', 'autoAdvance', 'loopUntil', 'maxIterationsAuto']);


export function assertNoAutonomousConvergence(value, label = 'convergence') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of AUTONOMOUS_KEYS) {
    if (value[key] !== undefined) {
      throw new SingularityFlowError(
        `${label}.${key} would repeat implementation and convergence until a condition became true, which the kernel refuses [SPK:CON-037]. `
        + 'Each iteration needs a human disposition; run the next one deliberately.'
      );
    }
  }
}

// token-reporting-policy.mjs


export function validateTokenReportingPolicy(tokens) {
  if (tokens?.mode && tokens.mode !== 'exact-or-unavailable') throw new SingularityFlowError("tokens.mode must be 'exact-or-unavailable'.");
  for (const [model, pricing] of Object.entries(tokens?.pricing ?? {})) {
    if (!model.trim()) throw new SingularityFlowError('tokens.pricing model names must not be empty.');
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw new SingularityFlowError(`Token pricing for '${model}' must be an object.`);
    for (const field of ['input', 'output', 'cachedInput']) {
      if (pricing[field] != null && (!Number.isFinite(pricing[field]) || pricing[field] < 0)) throw new SingularityFlowError(`tokens.pricing.${model}.${field} must be a non-negative number.`);
    }
    if (pricing.input == null && pricing.output == null && pricing.cachedInput == null) throw new SingularityFlowError(`Token pricing for '${model}' must define input, output, or cachedInput.`);
  }
  // Premium-request multipliers are GitHub's per-model rates. They change, so none are bundled.
  const multipliers = tokens?.premiumMultipliers;
  if (multipliers != null && (typeof multipliers !== 'object' || Array.isArray(multipliers))) throw new SingularityFlowError('tokens.premiumMultipliers must map model names to numbers.');
  for (const [model, multiplier] of Object.entries(multipliers ?? {})) {
    if (!model.trim()) throw new SingularityFlowError('tokens.premiumMultipliers model names must not be empty.');
    if (!Number.isFinite(multiplier) || multiplier < 0) throw new SingularityFlowError(`tokens.premiumMultipliers.${model} must be a non-negative number.`);
  }
}

// code-delivery-policy.mjs


function generationRequirement(phase) {
  const generation = phase?.generationPolicy ?? phase?.generation;
  return typeof generation === 'string' ? generation : generation?.requirement ?? null;
}


/**
 * What a step produces, by the engine's own contract: `none`, `code`, `analysis` or `document`.
 *
 * Configuration validation, routing, Workflow Studio and its picker all use this one
 * classification. Write scope is deliberately not consulted: a verification or testing step may
 * write tests against source without delivering code, and an explicit `analyze` task is an
 * analysis whatever its scope.
 */
export function stepOutputKind(phase) {
  if (!phase) return 'document';
  if (generationRequirement(phase) === 'none') return 'none';
  if (phaseRequiresCodeDelivery(phase)) return 'code';
  return generationTask(phase) === 'analyze' ? 'analysis' : 'document';
}


/** A version-3 compiled skill step: its reviewed binding decides how it is drafted. */
export function compiledSkillStep(phase) {
  return phase?.kind === 'skill';
}


/** Pin the inferred legacy contract into newly resolved or hydrated workflow state. */
export function pinCodeDeliveryTask(phase, policyField = 'generation') {
  if (!phaseRequiresCodeDelivery(phase)) return phase?.[policyField] ?? null;
  const current = phase?.[policyField] ?? {};
  if (current.task != null) return current;
  return { ...current, task: 'code' };
}


/** Refuse unsafe code phases while configuration is loaded, not at their first publication. */
export function assertCodeDeliveryConfiguration(phase, label = `Phase '${phase?.id ?? 'unknown'}'`) {
  if (!phaseRequiresCodeDelivery(phase)) return;
  if ((phase.writeScope ?? 'artifact-only') !== 'source-and-artifact') {
    throw new SingularityFlowError(
      `${label} is a code-delivery phase but writeScope is not 'source-and-artifact'. `
      + 'A document-only implementation is forbidden.',
      { code: 'CODE_DELIVERY_SCOPE_INVALID' }
    );
  }
}
// Internal bindings keep native execution/presentation on the same declarations.
export { PLACEHOLDER as storyBranchNamePLACEHOLDER, DEFAULT_MAX_BYTES as loggingDEFAULTMAXBYTES, DEFAULT_KEEP as loggingDEFAULTKEEP, object as initiativeConfigObject, unique as initiativeConfigUnique, safeId as initiativeConfigSafeId };


// Existing Git-configuration value precedence only; this does not select or open a backend.
/**
 * Resolve the reusable World-Model state authority from approved repository configuration.
 *
 * The ledger owns state publication. `git.remote` is the application-code transport and may point
 * at a different server, so it is only the final configured fallback. Keeping this one pure join
 * prevents read-only UI, gateway, workspace, and planning surfaces from selecting different refs.
 */
export function worldModelStateAuthority(definition = {}, {
  branch: fallbackBranch = null,
  remote: fallbackRemote = null
} = {}) {
  const branch = definition.worldModel?.stateBranch
    ?? fallbackBranch
    ?? definition.ledger?.branch
    ?? 'state';
  const remote = definition.ledger?.remote
    ?? definition.worldModel?.remote
    ?? fallbackRemote
    ?? definition.git?.remote
    ?? 'origin';
  return Object.freeze({ branch, remote });
}
