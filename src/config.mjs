import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  secureRepositoryPath,
  SingularityFlowError,
  posix,
  readJson,
  snapshot,
  writeText
} from './util.mjs';
import { validateInjectionDefinition } from './inject.mjs';
import { scopedRead, withReadScope } from './read-scope.mjs';
import { groundingMode } from './grounding.mjs';
import {
  discoverAgents,
  isAgentTemplateReference,
  materializeAgentTemplate,
  parseAgentTemplateReference,
  validateAgentCatalog
} from './agents.mjs';
import { markdownWorldModelViews, structuredWorldModelViewReferences, WORLD_MODEL_VIEW_ID } from './world-model-views.mjs';
import { normalizeStorage } from './initiative-config.mjs';
import { normalizeLogging } from './logging.mjs';
import { normalizeContextPolicy } from './context-policy.mjs';
import {
  DEFAULT_APPROVAL_AUTHORITY, normalizeApprovalAuthorities, normalizeApprovalPolicy
} from './approval-authority.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { normalizeClarificationPolicy } from './clarifications.mjs';
import { specificationQualityPolicy } from './specification-quality.mjs';
import { normalizeArtifactSets } from './artifact-sets.mjs';
import { assertNoAutonomousConvergence } from './convergence.mjs';
import { analysisLimits } from './analysis-limits.mjs';
import { VERSION } from './version.mjs';
import { constitutionPolicy } from './constitution.mjs';
import { assertModelTask } from './model-tasks.mjs';
import { isTemplateReference, normalizeTemplateCatalog, parseTemplateReference, resolveTemplate } from './template-catalog.mjs';
import { normalizeMcpServers, normalizePhaseMcpPolicy, validateMcpAgentTools } from './mcp.mjs';
import { normalizeSpecPolicy } from './specifications.mjs';
import { normalizeHarnessImports } from './harness-imports.mjs';
import { loadImpactDefinition } from './impact-config.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { materializationPolicy } from './world-model-materialization.mjs';
import { normalizeRepairBudget } from './repair-budget.mjs';
import { normalizeSourceBoundary } from './source-boundary.mjs';
import { normalizeFaultRepairPolicy } from './fault-repair.mjs';
import { normalizeAstPolicy } from './ast-policy.mjs';
import {
  assertCodeDeliveryConfiguration, normalizeCodeDeliveryPolicy, pinCodeDeliveryTask
} from './code-delivery-policy.mjs';
import {
  normalizeWorkTypeIntelligence, worldModelModeForIntelligence
} from './intelligence-policy.mjs';
import { normalizeTokenEconomy } from './token-economy.mjs';
import { normalizeAutoPolicy, normalizeAutoWorkTypePolicy } from './auto/auto-policy.mjs';

export const WORKFLOW_PATH = 'singularity/workflow.yml';
export const CONTROL_ROOT = 'singularity';
const LEGACY_CONTROL_ROOT = '.singularity';
export const DEFAULT_PLANNING_PROMPT = 'singularity/prompts/copilot-planning.md';
const INITIALIZATION_MAPPINGS = [
  ['workflow.yml', WORKFLOW_PATH],
  ['portfolio.yml', 'singularity/portfolio.yml'],
  ['capabilities.yml', 'singularity/capabilities.yml'],
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['artifacts', 'singularity/templates'],
  ['agents', '.github/agents'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', DEFAULT_PLANNING_PROMPT]
];

function governedRoot(destination) {
  // `.github` also holds files Singularity Flow does not own, so its governed root is one level
  // deeper. Every other destination is owned wholesale by its first segment.
  const segments = destination.split('/');
  return segments[0] === '.github' ? segments.slice(0, 2).join('/') : segments[0];
}

/**
 * Everything `initializeDefinition` writes, expressed as the paths a caller must stage to commit
 * all of it. Derived from the mappings rather than restated beside them: `.github/agents` was
 * written from the beginning and staged by only one of the three call sites, which left the agent
 * definitions untracked after `bootstrap` — enough to fail the very next command's clean-tree check
 * and to omit them from the governance proposal. A new mapping under a new root now reaches every
 * stager automatically.
 */
export const GOVERNED_ROOTS = Object.freeze([
  ...new Set(INITIALIZATION_MAPPINGS.map(([, destination]) => governedRoot(destination)))
]);
const INPUT_MODES = new Set(['off', 'record', 'enforce']);
export const SEQUENCE_GATE_IDS = [
  'completion', 'currentPhase', 'phaseStatus', 'freshGeneration',
  'generationCommit', 'remoteGeneration', 'publicationPending', 'documentPhase', 'binding'
];
const SEQUENCE_GATE_MODES = new Set(['hard', 'soft']);
function assertId(value, label) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new SingularityFlowError(`${label} '${value}' must be lower-case kebab-case.`);
}

function assertRelative(value, label) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new SingularityFlowError(`${label} must be a repository-relative path without '..'.`);
}

/**
 * Three ways to name a template, checked in the order that makes each unambiguous.
 *
 * `template:<id>` is validated for shape here and for existence in `validateDefinition`, where the
 * catalog is in scope — a phase is parsed before the file has necessarily been read whole.
 */
function assertTemplate(value, label) {
  if (isTemplateReference(value)) parseTemplateReference(value, label);
  else if (isAgentTemplateReference(value)) parseAgentTemplateReference(value);
  else assertRelative(value, label);
}

export function configuredInputsMode(definition) {
  const mode = definition.inputsMode ?? 'off';
  if (!INPUT_MODES.has(mode)) throw new SingularityFlowError(`inputsMode must be off, record, or enforce; got '${mode}'.`);
  return mode;
}

export function normalizeSequenceGates(value = {}, overrides = {}) {
  for (const [label, source] of [['sequenceGates', value], ['work-type sequenceGates', overrides]]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SingularityFlowError(`${label} must be an object.`);
    for (const [gate, mode] of Object.entries(source)) {
      if (gate !== 'default' && !SEQUENCE_GATE_IDS.includes(gate)) throw new SingularityFlowError(`${label} contains unknown gate '${gate}'. Allowed: ${SEQUENCE_GATE_IDS.join(', ')}.`);
      if (!SEQUENCE_GATE_MODES.has(mode)) throw new SingularityFlowError(`${label}.${gate} must be hard or soft.`);
    }
  }
  const fallback = overrides.default ?? value.default ?? 'hard';
  return Object.fromEntries([
    ['default', fallback],
    ...SEQUENCE_GATE_IDS.map((gate) => [gate, overrides[gate] ?? value[gate] ?? fallback])
  ]);
}

export function normalizePhaseInputs(value, label = 'Phase inputs') {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new SingularityFlowError(`${label} must be an array.`);
  const seen = new Set();
  return value.map((entry, index) => {
    const source = typeof entry === 'string' ? { phase: entry } : entry;
    const entryLabel = `${label}[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SingularityFlowError(`${entryLabel} must be a phase ID or object.`);
    for (const key of Object.keys(source)) if (![
      'phase', 'optional', 'maxBytes', 'selector', 'projection', 'preserve',
      'maximumSummaryBytes', 'expansion', 'fallback'
    ].includes(key)) throw new SingularityFlowError(`${entryLabel} has unsupported field '${key}'.`);
    assertId(source.phase, `${entryLabel}.phase`);
    if (source.optional != null && typeof source.optional !== 'boolean') throw new SingularityFlowError(`${entryLabel}.optional must be boolean.`);
    if (source.maxBytes != null && (!Number.isInteger(source.maxBytes) || source.maxBytes < 1)) throw new SingularityFlowError(`${entryLabel}.maxBytes must be a positive integer.`);
    let selector = null;
    if (source.selector != null) {
      if (!source.selector || typeof source.selector !== 'object' || Array.isArray(source.selector)) throw new SingularityFlowError(`${entryLabel}.selector must be an object.`);
      for (const key of Object.keys(source.selector)) if (!['kind', 'ids', 'claims', 'includeDependencies', 'fallback'].includes(key)) throw new SingularityFlowError(`${entryLabel}.selector has unsupported field '${key}'.`);
      if (source.selector.kind !== 'clauses') throw new SingularityFlowError(`${entryLabel}.selector.kind must be clauses.`);
      if (source.selector.ids != null && (!Array.isArray(source.selector.ids) || source.selector.ids.some((id) => typeof id !== 'string'))) throw new SingularityFlowError(`${entryLabel}.selector.ids must be an array of clause IDs.`);
      if (source.selector.claims != null && !['planned', 'observed'].includes(source.selector.claims)) throw new SingularityFlowError(`${entryLabel}.selector.claims must be planned or observed.`);
      if (source.selector.includeDependencies != null && typeof source.selector.includeDependencies !== 'boolean') throw new SingularityFlowError(`${entryLabel}.selector.includeDependencies must be boolean.`);
      if (source.selector.fallback != null && !['whole', 'empty'].includes(source.selector.fallback)) throw new SingularityFlowError(`${entryLabel}.selector.fallback must be whole or empty.`);
      selector = {
        kind: 'clauses',
        ids: [...new Set(source.selector.ids ?? [])],
        claims: source.selector.claims ?? null,
        includeDependencies: source.selector.includeDependencies !== false,
        fallback: source.selector.fallback ?? 'whole'
      };
    }
    const projection = source.projection ?? 'full';
    if (!['full', 'approved-summary'].includes(projection)) throw new SingularityFlowError(`${entryLabel}.projection must be full or approved-summary.`);
    if (projection === 'full' && ['preserve', 'maximumSummaryBytes', 'expansion', 'fallback'].some((key) => source[key] != null)) {
      throw new SingularityFlowError(`${entryLabel} summary controls require projection: approved-summary.`);
    }
    if (projection === 'approved-summary' && selector) throw new SingularityFlowError(`${entryLabel} cannot combine projection: approved-summary with a clause selector.`);
    if (projection === 'approved-summary' && source.maxBytes != null) throw new SingularityFlowError(`${entryLabel} uses maximumSummaryBytes instead of maxBytes for an approved summary.`);
    const preserve = source.preserve ?? [];
    if (!Array.isArray(preserve) || preserve.some((heading) => typeof heading !== 'string' || !heading.trim())) {
      throw new SingularityFlowError(`${entryLabel}.preserve must be an array of non-empty Markdown heading names.`);
    }
    const preserveByHeading = new Map();
    for (const heading of preserve) {
      const display = heading.normalize('NFKC').trim();
      const key = display.toLocaleLowerCase('en-US');
      if (!preserveByHeading.has(key)) preserveByHeading.set(key, display);
    }
    const normalizedPreserve = [...preserveByHeading.values()];
    const maximumSummaryBytes = projection === 'approved-summary' ? source.maximumSummaryBytes ?? 8192 : null;
    if (maximumSummaryBytes != null && (!Number.isInteger(maximumSummaryBytes) || maximumSummaryBytes < 1024 || maximumSummaryBytes > 65536)) {
      throw new SingularityFlowError(`${entryLabel}.maximumSummaryBytes must be an integer from 1024 through 65536.`);
    }
    const expansion = projection === 'approved-summary' ? source.expansion ?? 'hash-bound-reference' : null;
    if (expansion != null && expansion !== 'hash-bound-reference') throw new SingularityFlowError(`${entryLabel}.expansion must be hash-bound-reference.`);
    const fallback = projection === 'approved-summary' ? source.fallback ?? 'whole' : null;
    if (fallback != null && !['whole', 'block'].includes(fallback)) throw new SingularityFlowError(`${entryLabel}.fallback must be whole or block.`);
    if (seen.has(source.phase)) throw new SingularityFlowError(`${label} references '${source.phase}' more than once.`);
    seen.add(source.phase);
    return {
      phase: source.phase,
      optional: source.optional ?? false,
      maxBytes: source.maxBytes ?? null,
      ...(projection === 'approved-summary' ? {
        projection,
        preserve: normalizedPreserve,
        maximumSummaryBytes,
        expansion,
        fallback
      } : {}),
      ...(selector ? { selector } : {})
    };
  });
}

export function normalizeGenerationPolicy(value = null, phaseId = 'phase') {
  const source = typeof value === 'string' ? { requirement: value } : (value ?? {});
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError(`Phase '${phaseId}' generation must be a mode or an object.`);
  }
  const requirement = source.requirement ?? source.mode ?? 'required';
  const legacyProducer = source.producer ?? null;
  const mappedProducer = legacyProducer === 'agent' ? 'governed-agent' : legacyProducer === 'manual' ? 'human' : legacyProducer;
  const defaultProducer = source.defaultProducer ?? mappedProducer ?? 'governed-agent';
  const allowedProducers = source.allowedProducers ?? (
    legacyProducer === 'manual' ? ['human']
      : legacyProducer === 'deterministic' ? ['deterministic']
        : ['governed-agent', 'human']
  );
  if (!['required', 'optional', 'none'].includes(requirement)) {
    throw new SingularityFlowError(`Phase '${phaseId}' generation requirement must be required, optional, or none.`);
  }
  const producers = ['human', 'governed-agent', 'deterministic', 'external-tool'];
  if (!producers.includes(defaultProducer)) {
    throw new SingularityFlowError(`Phase '${phaseId}' generation defaultProducer must be ${producers.join(', ')}.`);
  }
  if (!Array.isArray(allowedProducers) || !allowedProducers.length || allowedProducers.some((producer) => !producers.includes(producer))) {
    throw new SingularityFlowError(`Phase '${phaseId}' generation allowedProducers must be a non-empty array containing ${producers.join(', ')}.`);
  }
  if (!allowedProducers.includes(defaultProducer)) {
    throw new SingularityFlowError(`Phase '${phaseId}' generation defaultProducer '${defaultProducer}' must be included in allowedProducers.`);
  }
  return {
    requirement,
    defaultProducer,
    allowedProducers: [...new Set(allowedProducers)],
    /**
     * The model task this phase's generation performs `[ADP:REQ-012]`.
     *
     * Carried explicitly because this normalizer returns a fresh object rather than spreading its
     * input: a `task` declared in `workflow.yml` and not named here would be dropped before anything
     * could read it, and every phase would silently route as the default while the configuration
     * said otherwise. Validated here so a bad task fails at load, next to the line that wrote it.
     */
    task: source.task == null ? null : assertModelTask(source.task, `Phase '${phaseId}' generation task`),
    // Temporary internal compatibility for deterministic preparation paths.
    producer: defaultProducer === 'deterministic' ? 'deterministic' : defaultProducer === 'human' ? 'manual' : 'agent'
  };
}

export function normalizeDesignSourcePolicy(value = null, { phases = [] } = {}) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('designSources must be an object.');
  for (const key of Object.keys(value)) {
    if (!['capturePhase', 'consumeIn', 'staleness', 'requireApprovedSet', 'inventoryDigest'].includes(key)) {
      throw new SingularityFlowError(`designSources contains unknown field '${key}'.`);
    }
  }
  const capturePhase = value.capturePhase ?? 'design-intake';
  assertId(capturePhase, 'designSources.capturePhase');
  if (!phases.includes(capturePhase)) throw new SingularityFlowError(`designSources.capturePhase '${capturePhase}' is not active in this work type.`);
  const consumeIn = value.consumeIn ?? phases.filter((phase) => phase !== capturePhase);
  if (!Array.isArray(consumeIn) || consumeIn.some((phase) => typeof phase !== 'string')) throw new SingularityFlowError('designSources.consumeIn must be an array of phase IDs.');
  if (new Set(consumeIn).size !== consumeIn.length) throw new SingularityFlowError('designSources.consumeIn must not contain duplicates.');
  for (const phase of consumeIn) if (!phases.includes(phase)) throw new SingularityFlowError(`designSources.consumeIn references inactive phase '${phase}'.`);
  const staleness = value.staleness ?? 'warn';
  if (!['ignore', 'warn', 'fail'].includes(staleness)) throw new SingularityFlowError('designSources.staleness must be ignore, warn, or fail.');
  if (value.requireApprovedSet != null && typeof value.requireApprovedSet !== 'boolean') throw new SingularityFlowError('designSources.requireApprovedSet must be boolean.');
  if (value.inventoryDigest != null && !['off', 'optional', 'required'].includes(value.inventoryDigest)) throw new SingularityFlowError('designSources.inventoryDigest must be off, optional, or required.');
  return {
    capturePhase,
    consumeIn,
    staleness,
    requireApprovedSet: value.requireApprovedSet !== false,
    inventoryDigest: value.inventoryDigest ?? 'optional'
  };
}

export function normalizeVerificationPolicy(value = null, { phases = [] } = {}) {
  const source = value ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new SingularityFlowError('verification must be an object.');
  for (const key of Object.keys(source)) if (!['coverage', 'profiles', 'comparison'].includes(key)) throw new SingularityFlowError(`verification contains unknown field '${key}'.`);
  const coverage = source.coverage ?? 'warn';
  if (!['warn', 'enforce'].includes(coverage)) throw new SingularityFlowError('verification.coverage must be warn or enforce.');
  const profiles = source.profiles ?? [];
  if (!Array.isArray(profiles)) throw new SingularityFlowError('verification.profiles must be an array.');
  const seen = new Set();
  const normalizedProfiles = profiles.map((profile, index) => {
    const label = `verification.profiles[${index}]`;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new SingularityFlowError(`${label} must be an object.`);
    for (const key of Object.keys(profile)) if (!['id', 'label', 'width', 'height', 'deviceScaleFactor'].includes(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
    assertId(profile.id, `${label}.id`);
    if (seen.has(profile.id)) throw new SingularityFlowError(`verification.profiles contains duplicate ID '${profile.id}'.`);
    seen.add(profile.id);
    if (typeof profile.label !== 'string' || !profile.label.trim()) throw new SingularityFlowError(`${label}.label must be non-empty.`);
    for (const dimension of ['width', 'height']) if (!Number.isInteger(profile[dimension]) || profile[dimension] < 1 || profile[dimension] > 10000) throw new SingularityFlowError(`${label}.${dimension} must be an integer from 1 to 10000.`);
    const scale = Number(profile.deviceScaleFactor);
    if (!Number.isFinite(scale) || scale <= 0 || scale > 8) throw new SingularityFlowError(`${label}.deviceScaleFactor must be greater than 0 and at most 8.`);
    return { id: profile.id, label: profile.label.trim(), width: profile.width, height: profile.height, deviceScaleFactor: scale };
  });
  if (normalizedProfiles.length && !phases.includes('visual-verification')) throw new SingularityFlowError('verification.profiles require the visual-verification phase.');
  if (coverage === 'enforce' && !normalizedProfiles.length) throw new SingularityFlowError('verification.coverage enforce requires at least one profile.');
  const comparison = source.comparison ?? {};
  if (!comparison || typeof comparison !== 'object' || Array.isArray(comparison)) throw new SingularityFlowError('verification.comparison must be an object.');
  for (const key of Object.keys(comparison)) if (!['mode', 'channelTolerance', 'maxDifferingPixelRatio', 'maxDifferingPixels', 'maxPixels'].includes(key)) throw new SingularityFlowError(`verification.comparison contains unknown field '${key}'.`);
  const mode = comparison.mode ?? 'off';
  if (!['off', 'warn', 'enforce'].includes(mode)) throw new SingularityFlowError('verification.comparison.mode must be off, warn, or enforce.');
  const channelTolerance = comparison.channelTolerance ?? 0;
  if (!Number.isInteger(channelTolerance) || channelTolerance < 0 || channelTolerance > 255) throw new SingularityFlowError('verification.comparison.channelTolerance must be an integer from 0 to 255.');
  const ratio = comparison.maxDifferingPixelRatio ?? null;
  if (ratio != null && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) throw new SingularityFlowError('verification.comparison.maxDifferingPixelRatio must be null or a number from 0 to 1.');
  const pixels = comparison.maxDifferingPixels ?? null;
  if (pixels != null && (!Number.isInteger(pixels) || pixels < 0)) throw new SingularityFlowError('verification.comparison.maxDifferingPixels must be null or a non-negative integer.');
  // `enforce` has to be able to fail. Both thresholds are optional, and with neither set
  // `thresholdStatus` can never mark a comparison as exceeded — so every comparison returned `pass`
  // however different the images were, and the `mode === 'enforce'` branch was unreachable for pixel
  // differences. A team writing `mode: enforce` believes visual regressions now block the gate; they
  // never did. This is the same rule `coverage: enforce` already applies to profiles above.
  if (mode === 'enforce' && ratio == null && pixels == null) {
    throw new SingularityFlowError(
      'verification.comparison enforce requires maxDifferingPixels or maxDifferingPixelRatio; '
      + 'without a threshold no comparison can ever fail.'
    );
  }
  const maxPixels = comparison.maxPixels ?? 40_000_000;
  if (!Number.isInteger(maxPixels) || maxPixels < 1 || maxPixels > 100_000_000) throw new SingularityFlowError('verification.comparison.maxPixels must be an integer from 1 to 100000000.');
  return { coverage, profiles: normalizedProfiles, comparison: { mode, channelTolerance, maxDifferingPixelRatio: ratio, maxDifferingPixels: pixels, maxPixels } };
}

export function normalizeSessionPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('session must be an object.');
  for (const key of Object.keys(value)) if (!['workItemSelection', 'requireBeforeTools'].includes(key)) throw new SingularityFlowError(`session contains unknown field '${key}'.`);
  const workItemSelection = value.workItemSelection ?? 'off';
  if (!['off', 'reuse', 'prompt'].includes(workItemSelection)) throw new SingularityFlowError('session.workItemSelection must be off, reuse, or prompt.');
  if (value.requireBeforeTools != null && typeof value.requireBeforeTools !== 'boolean') throw new SingularityFlowError('session.requireBeforeTools must be boolean.');
  return {
    workItemSelection,
    requireBeforeTools: value.requireBeforeTools ?? false
  };
}

export function normalizePlanning(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('planning must be an object.');
  for (const key of Object.keys(value)) if (!['enabled', 'promptSource', 'maxContextBytes'].includes(key)) throw new SingularityFlowError(`planning contains unknown field '${key}'.`);
  if (value.enabled != null && typeof value.enabled !== 'boolean') throw new SingularityFlowError('planning.enabled must be boolean.');
  const promptSource = value.promptSource ?? DEFAULT_PLANNING_PROMPT;
  assertRelative(promptSource, 'planning.promptSource');
  const maxContextBytes = value.maxContextBytes ?? 1048576;
  if (!Number.isInteger(maxContextBytes) || maxContextBytes < 16384 || maxContextBytes > 10485760) {
    throw new SingularityFlowError('planning.maxContextBytes must be an integer from 16384 through 10485760.');
  }
  return { enabled: value.enabled !== false, promptSource, maxContextBytes };
}

export function normalizeModelProviders(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('models must be an object.');
  for (const key of Object.keys(value)) if (!['defaultProvider', 'providers'].includes(key)) throw new SingularityFlowError(`models contains unknown field '${key}'.`);
  const providers = value.providers ?? { 'copilot-cli': { type: 'copilot-cli' } };
  if (!providers || typeof providers !== 'object' || Array.isArray(providers) || !Object.keys(providers).length) {
    throw new SingularityFlowError('models.providers must contain at least one provider.');
  }
  const normalized = {};
  for (const [id, provider] of Object.entries(providers)) {
    assertId(id, 'Model provider');
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw new SingularityFlowError(`models.providers.${id} must be an object.`);
    for (const key of Object.keys(provider)) if (!['type', 'executable', 'arguments', 'model'].includes(key)) throw new SingularityFlowError(`models.providers.${id} contains unknown field '${key}'.`);
    if (provider.type !== 'copilot-cli') throw new SingularityFlowError(`models.providers.${id}.type '${provider.type}' is not supported.`);
    if (provider.executable != null && (typeof provider.executable !== 'string' || !provider.executable.trim())) throw new SingularityFlowError(`models.providers.${id}.executable must be a non-empty string.`);
    if (provider.arguments != null && (!Array.isArray(provider.arguments) || provider.arguments.some((item) => typeof item !== 'string'))) throw new SingularityFlowError(`models.providers.${id}.arguments must be an array of strings.`);
    if (provider.model != null && (typeof provider.model !== 'string' || !provider.model.trim())) throw new SingularityFlowError(`models.providers.${id}.model must be a non-empty string.`);
    normalized[id] = {
      type: provider.type,
      ...(provider.executable ? { executable: provider.executable.trim() } : {}),
      arguments: [...(provider.arguments ?? [])],
      ...(provider.model ? { model: provider.model.trim() } : {})
    };
  }
  const defaultProvider = value.defaultProvider ?? Object.keys(normalized)[0];
  if (!normalized[defaultProvider]) throw new SingularityFlowError(`models.defaultProvider references unknown provider '${defaultProvider}'.`);
  return { defaultProvider, providers: normalized };
}

export function validateDefinition(definition) {
  if (definition?.version !== 2) throw new SingularityFlowError('workflow.yml version must be 2. Version 1 is not supported and is not migrated. Run singularity-flow factory-reset --dry-run, review the reset plan, then apply its exact confirmation to install the current version-2 configuration.');
  if (Object.hasOwn(definition, 'personas') || Object.hasOwn(definition, 'personaPromptsRoot')) throw new SingularityFlowError('Legacy role-prompt configuration is no longer supported. Define governed Agent Markdown under .github/agents.');
  if (!definition.workTypes || !Object.keys(definition.workTypes).length) throw new SingularityFlowError('workflow.yml must define at least one work type.');
  if (!definition.phases || !Object.keys(definition.phases).length) throw new SingularityFlowError('workflow.yml must define phases.');
  assertRelative(definition.workItemRoot ?? 'singularity/work-items', 'workItemRoot');
  assertRelative(definition.templatesRoot, 'templatesRoot');
  /**
   * The catalog, and then every reference against it. Existence is checked here rather than in
   * `assertTemplate` because a phase is validated before the file is necessarily whole — a
   * reference to a template declared further down the same document must not fail on ordering.
   */
  const templateCatalog = normalizeTemplateCatalog(definition.templates);
  for (const [phaseId, phase] of Object.entries(definition.phases)) {
    if (phase?.defaultTemplate) resolveTemplate({ templates: templateCatalog }, phase.defaultTemplate, { label: `Phase '${phaseId}' defaultTemplate` });
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes)) {
    for (const [phaseId, value] of Object.entries(workType?.templateOverrides ?? {})) {
      resolveTemplate({ templates: templateCatalog }, value, { label: `Work type '${workTypeId}' templateOverrides '${phaseId}'` });
    }
  }
  configuredInputsMode(definition);
  normalizeSequenceGates(definition.sequenceGates ?? {});
  normalizeSessionPolicy(definition.session ?? {});
  normalizeContextPolicy(definition.contextPolicy ?? {}, { phaseIds: Object.keys(definition.phases) });
  definition.tokenEconomy = normalizeTokenEconomy(definition.tokenEconomy ?? {});
  normalizePlanning(definition.planning ?? {});
  definition.models = normalizeModelProviders(definition.models ?? {});
  definition.auto = normalizeAutoPolicy(definition.auto);
  definition.harnessImports = normalizeHarnessImports(definition.harnessImports);
  normalizeLogging(definition.logging ?? {});
  definition.mcpServers = normalizeMcpServers(definition.mcpServers ?? {}, {
    agents: definition.agentCatalog ?? [],
    phases: Object.keys(definition.phases)
  });
  validateMcpAgentTools(definition);
  definition.ledger = normalizeLedgerConfig(definition.ledger ?? {});
  definition.spec = normalizeSpecPolicy(definition.spec ?? {});
  definition.faultRepair = normalizeFaultRepairPolicy(definition.faultRepair ?? {});
  definition.ast = normalizeAstPolicy(definition.ast ?? {});
  definition.approvalAuthorities = normalizeApprovalAuthorities(definition.approvalAuthorities);
  groundingMode(definition);
  if (definition.worldModel?.runner != null) throw new SingularityFlowError('worldModel.runner is not supported. Configure models.providers with a trusted executable and argument array.');
  if (definition.worldModel?.outputDir) assertRelative(definition.worldModel.outputDir, 'worldModel.outputDir');
  if (definition.worldModel?.promptSource && definition.worldModel.promptSource !== 'builtin') assertRelative(definition.worldModel.promptSource, 'worldModel.promptSource');
  if (definition.worldModel?.stateFetchTimeoutMs != null
      && (!Number.isInteger(definition.worldModel.stateFetchTimeoutMs)
        || definition.worldModel.stateFetchTimeoutMs < 250
        || definition.worldModel.stateFetchTimeoutMs > 60_000)) {
    throw new SingularityFlowError('worldModel.stateFetchTimeoutMs must be an integer from 250 through 60000.');
  }
  if (definition.worldModel?.views != null) {
    if (!Array.isArray(definition.worldModel.views) || !definition.worldModel.views.length) throw new SingularityFlowError('worldModel.views must be a non-empty array when configured.');
    if (new Set(definition.worldModel.views).size !== definition.worldModel.views.length) throw new SingularityFlowError('worldModel.views must not contain duplicates.');
    for (const view of definition.worldModel.views) if (!WORLD_MODEL_VIEW_ID.test(view)) throw new SingularityFlowError(`World-model view '${view}' must be lower-case kebab-case.`);
  }
  if (definition.worldModel?.generation != null) {
    const generation = definition.worldModel.generation;
    if (!generation || typeof generation !== 'object' || Array.isArray(generation)) throw new SingularityFlowError('worldModel.generation must be an object.');
    for (const key of Object.keys(generation)) if (!['parallel', 'maxWorkers', 'strategy'].includes(key)) throw new SingularityFlowError(`worldModel.generation contains unknown field '${key}'.`);
    if (generation.parallel != null && typeof generation.parallel !== 'boolean') throw new SingularityFlowError('worldModel.generation.parallel must be boolean.');
    if (generation.maxWorkers != null && (!Number.isInteger(generation.maxWorkers) || generation.maxWorkers < 1 || generation.maxWorkers > 16)) {
      throw new SingularityFlowError('worldModel.generation.maxWorkers must be an integer from 1 through 16.');
    }
    if (generation.strategy != null && generation.strategy !== 'view') throw new SingularityFlowError("worldModel.generation.strategy must be 'view'.");
  }
  if (definition.worldModel?.materialization != null) {
    const materialization = definition.worldModel.materialization;
    if (!materialization || typeof materialization !== 'object' || Array.isArray(materialization)) throw new SingularityFlowError('worldModel.materialization must be an object.');
    for (const key of Object.keys(materialization)) if (!['mode', 'publish', 'lookahead', 'depth', 'confirmation'].includes(key)) throw new SingularityFlowError(`worldModel.materialization contains unknown field '${key}'.`);
    materializationPolicy(definition);
  }
  // `grounding` throws on an unknown mode when it is read, but `staleness` was only ever compared
  // against the two strings that do something. A typo like `Fail` or `strict` therefore matched
  // neither branch and silently degraded to "ignore" — the freshness guard was off and nothing said
  // so. Validate it here so a misspelled mode fails loudly at load instead of quietly disarming.
  if (definition.worldModel?.staleness != null && !['warn', 'fail', 'ignore'].includes(definition.worldModel.staleness)) {
    throw new SingularityFlowError("worldModel.staleness must be 'warn', 'fail', or 'ignore'.");
  }
  validateInjectionDefinition(definition);
  definition.codeDelivery = normalizeCodeDeliveryPolicy(definition.codeDelivery ?? {});
  if (definition.tokens?.mode && definition.tokens.mode !== 'exact-or-unavailable') throw new SingularityFlowError("tokens.mode must be 'exact-or-unavailable'.");
  for (const [model, pricing] of Object.entries(definition.tokens?.pricing ?? {})) {
    if (!model.trim()) throw new SingularityFlowError('tokens.pricing model names must not be empty.');
    if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) throw new SingularityFlowError(`Token pricing for '${model}' must be an object.`);
    for (const field of ['input', 'output', 'cachedInput']) {
      if (pricing[field] != null && (!Number.isFinite(pricing[field]) || pricing[field] < 0)) throw new SingularityFlowError(`tokens.pricing.${model}.${field} must be a non-negative number.`);
    }
    if (pricing.input == null && pricing.output == null && pricing.cachedInput == null) throw new SingularityFlowError(`Token pricing for '${model}' must define input, output, or cachedInput.`);
  }
  for (const phaseId of definition.documents?.allowedPhases ?? []) if (!definition.phases[phaseId]) throw new SingularityFlowError(`Document policy references unknown phase '${phaseId}'.`);
  if (definition.documents?.maxFileBytes != null && (!Number.isInteger(definition.documents.maxFileBytes) || definition.documents.maxFileBytes < 1)) throw new SingularityFlowError('documents.maxFileBytes must be a positive integer.');
  // Optional per-work-item storage providers (OneDrive/SharePoint, Artifactory, S3, …) let the
  // documents feature fetch governed bytes. Same normalizer as the initiative portfolio, so the
  // schema never drifts between the two surfaces.
  if (definition.storage != null) definition.storage = normalizeStorage(definition.storage);
  if (definition.collaboration != null) {
    if (!definition.collaboration || typeof definition.collaboration !== 'object' || Array.isArray(definition.collaboration)) throw new SingularityFlowError('collaboration must be an object.');
    if (definition.collaboration.assignmentMode && !['off', 'suggested', 'required'].includes(definition.collaboration.assignmentMode)) throw new SingularityFlowError('collaboration.assignmentMode must be off, suggested, or required.');
    if (definition.collaboration.approvalReminderAfterHours != null && (!Number.isFinite(definition.collaboration.approvalReminderAfterHours) || definition.collaboration.approvalReminderAfterHours < 0)) throw new SingularityFlowError('collaboration.approvalReminderAfterHours must be a non-negative number.');
    for (const channel of definition.collaboration.notifications ?? []) if (!['terminal', 'teams-webhook'].includes(channel)) throw new SingularityFlowError(`Unsupported collaboration notification channel '${channel}'.`);
  }
  for (const [id, workType] of Object.entries(definition.workTypes)) {
    assertId(id, 'Work type');
    if (!workType.label || !Array.isArray(workType.phases) || !workType.phases.length) throw new SingularityFlowError(`Work type '${id}' requires label and phases.`);
    for (const phaseId of workType.phases) if (!definition.phases[phaseId]) throw new SingularityFlowError(`Work type '${id}' references unknown phase '${phaseId}'.`);
    for (const phaseId of Object.keys(workType.templateOverrides ?? {})) if (!workType.phases.includes(phaseId)) throw new SingularityFlowError(`Work type '${id}' has a template override for inactive phase '${phaseId}'.`);
    for (const phaseId of Object.keys(workType.phaseOverrides ?? {})) if (!workType.phases.includes(phaseId)) throw new SingularityFlowError(`Work type '${id}' has an override for inactive phase '${phaseId}'.`);
    for (const phaseId of workType.documents?.allowedPhases ?? []) if (!workType.phases.includes(phaseId)) throw new SingularityFlowError(`Work type '${id}' allows document upload in inactive phase '${phaseId}'.`);
    normalizeSequenceGates(definition.sequenceGates ?? {}, workType.sequenceGates ?? {});
    // `[SPK:REQ-090]`: one constitution per approved configuration, named by the work type that
    // is held to it. Validated here so a typo cannot resolve into a policy that governs nothing.
    constitutionPolicy(workType.constitution);
    workType.designSources = normalizeDesignSourcePolicy(workType.designSources, { phases: workType.phases });
    workType.verification = normalizeVerificationPolicy(workType.verification, { phases: workType.phases });
    workType.intelligence = normalizeWorkTypeIntelligence(workType.intelligence, `Work type '${id}' intelligence`);
    workType.auto = normalizeAutoWorkTypePolicy(workType.auto, `Work type '${id}' auto`, workType.phases);
  }
  if (definition.noModel != null) {
    if (!definition.noModel || typeof definition.noModel !== 'object' || Array.isArray(definition.noModel)) throw new SingularityFlowError('noModel must be an object.');
    if (!['warn', 'block'].includes(definition.noModel.unknownExternalCommands ?? 'warn')) throw new SingularityFlowError('noModel.unknownExternalCommands must be warn or block.');
  }
  analysisLimits(definition.analysisLimits);
  const sets = normalizeArtifactSets(definition.artifactSets);
  for (const [id, phase] of Object.entries(definition.phases)) {
    assertId(id, 'Phase');
    if (!phase.label || !phase.artifact?.path) throw new SingularityFlowError(`Phase '${id}' requires label and artifact.path.`);
    assertRelative(phase.artifact.path, `Phase '${id}' artifact.path`);
    for (const field of ['minimumBytes', 'maximumBytes']) {
      if (phase.artifact[field] != null
          && (!Number.isSafeInteger(phase.artifact[field]) || phase.artifact[field] < 1)) {
        throw new SingularityFlowError(`Phase '${id}' artifact.${field} must be a positive safe integer.`);
      }
    }
    if (phase.artifact.maximumBytes != null && phase.artifact.maximumBytes < (phase.artifact.minimumBytes ?? 1)) {
      throw new SingularityFlowError(`Phase '${id}' artifact.maximumBytes must be greater than or equal to artifact.minimumBytes.`);
    }
    for (const [field, pattern] of [
      ['allowedExtensions', /^\.[A-Za-z0-9]+$/],
      ['allowedMediaTypes', /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/]
    ]) {
      const values = phase.artifact[field];
      if (values != null && (!Array.isArray(values) || !values.length || new Set(values).size !== values.length || values.some((value) => typeof value !== 'string' || !pattern.test(value)))) {
        throw new SingularityFlowError(`Phase '${id}' artifact.${field} must be a non-empty unique array of valid values.`);
      }
    }
    if (phase.artifact.validation != null
        && (!phase.artifact.validation || typeof phase.artifact.validation !== 'object' || Array.isArray(phase.artifact.validation))) {
      throw new SingularityFlowError(`Phase '${id}' artifact.validation must be an object.`);
    }
    for (const field of ['requiredHeadings', 'forbiddenPlaceholders']) {
      const values = phase.artifact.validation?.[field];
      if (values != null
          && (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())
            || new Set(values.map((value) => value.trim().toLocaleLowerCase('en-US'))).size !== values.length)) {
        throw new SingularityFlowError(`Phase '${id}' artifact.validation.${field} must be an array of non-empty unique strings.`);
      }
    }
    const template = phase.defaultTemplate;
    if (template) assertTemplate(template, `Phase '${id}' defaultTemplate`);
    for (const [workTypeId, workType] of Object.entries(definition.workTypes)) if (workType.templateOverrides?.[id]) assertTemplate(workType.templateOverrides[id], `Work type '${workTypeId}' template override for '${id}'`);
    if (!template && !Object.values(definition.workTypes).some((type) => type.templateOverrides?.[id])) throw new SingularityFlowError(`Phase '${id}' has no default or work-type template.`);
    normalizeApprovalPolicy(phase.approval ?? {}, definition.approvalAuthorities, id);
    normalizeSourceBoundary(phase.sourceBoundary, id);
    normalizeGenerationPolicy(phase.generation, id);
    phase.mcp = normalizePhaseMcpPolicy(phase.mcp, { servers: definition.mcpServers, phaseId: id });
    phase.repairBudget = normalizeRepairBudget(phase.repairBudget, { phaseId: id, phases: Object.keys(definition.phases) });
    for (const [index, command] of (phase.qualityCommands ?? []).entries()) normalizeExternalCommand(command, index);
    normalizePhaseInputs(phase.inputs, `Phase '${id}' inputs`);
    normalizeClarificationPolicy(phase.clarification);
    // Validated here rather than only where it is consumed. A `specificationQuality` block reached
    // resolution untouched by the phase spread below, so `mode: enfroce` would have loaded cleanly,
    // resolved cleanly, and quietly enforced nothing — the exact failure this codebase keeps
    // producing when a declared policy has no validator standing between it and its consumer.
    if (phase.specificationQuality !== undefined) specificationQualityPolicy(phase.specificationQuality);
    // `[SPK:CON-037]`: refused at load, because by the time a self-repeating loop is running there is
    // no honest place to stop it. Both the phase's own keys and a nested `convergence:` block, since
    // either would express the same thing.
    assertNoAutonomousConvergence(phase, `Phase '${id}'`);
    assertNoAutonomousConvergence(phase.convergence, `Phase '${id}' convergence`);
    // A phase naming a set that does not exist would catalogue nothing and refuse nothing, so the
    // reference is resolved at load rather than at the first publication that needed it.
    if (phase.artifactSet !== undefined && !sets[phase.artifactSet]) {
      throw new SingularityFlowError(`Phase '${id}' declares unknown artifact set '${phase.artifactSet}'.`);
    }
    if (phase.artifactSet !== undefined) {
      const primary = path.posix.basename(posix(String(phase.artifact?.path ?? '')));
      if (sets[phase.artifactSet].primary !== primary) {
        throw new SingularityFlowError(
          `Phase '${id}' artifact is '${primary}' but artifact set '${phase.artifactSet}' names '${sets[phase.artifactSet].primary}' as its primary member.`
        );
      }
    }
  }
  for (const [workTypeId, workType] of Object.entries(definition.workTypes)) {
    const resolved = resolveWorkType(definition, workTypeId);
    for (const consumer of resolved.phases) {
      for (const input of consumer.inputs) {
        const producer = resolved.phases.find((phase) => phase.id === input.phase);
        if (!producer) throw new SingularityFlowError(`Work type '${workTypeId}' phase '${consumer.id}' input references inactive phase '${input.phase}'.`);
        if (producer.order >= consumer.order) throw new SingularityFlowError(`Work type '${workTypeId}' phase '${consumer.id}' input '${input.phase}' must precede the consumer.`);
        if (input.projection === 'approved-summary' && input.expansion === 'hash-bound-reference'
          && definition.harnessImports.mode === 'off') {
          throw new SingularityFlowError(
            `Work type '${workTypeId}' phase '${consumer.id}' approved-summary input '${input.phase}' requires harnessImports.mode record or enforce for hash-bound expansion.`
          );
        }
      }
    }
    const projectedInputs = resolved.phases.slice(1).map((phase) => ({
      phase: phase.id,
      summaries: phase.inputs.filter((input) => input.projection === 'approved-summary').length
    }));
    if (resolved.intelligence.agentBriefs === 'required') {
      const missing = projectedInputs.filter((entry) => entry.summaries === 0).map((entry) => entry.phase);
      if (missing.length) {
        throw new SingularityFlowError(
          `Work type '${workTypeId}' requires approved agent briefs, but phase(s) ${missing.join(', ')} have no approved-summary input.`
        );
      }
    }
    if (resolved.intelligence.agentBriefs === 'off') {
      const projected = projectedInputs.filter((entry) => entry.summaries > 0).map((entry) => entry.phase);
      if (projected.length) {
        throw new SingularityFlowError(
          `Work type '${workTypeId}' disables agent briefs, but phase(s) ${projected.join(', ')} use approved-summary inputs.`
        );
      }
    }
  }
  if (definition.worldModel?.views) {
    const configuredViews = new Set(definition.worldModel.views);
    for (const [view, references] of structuredWorldModelViewReferences(definition)) {
      if (!configuredViews.has(view)) throw new SingularityFlowError(`World-model view '${view}' is used by ${references.join(', ')} but is not declared in worldModel.views.`);
    }
  }
  return definition;
}

async function markdownFiles(root, relativeDirectory) {
  const boundary = await secureRepositoryPath(root, relativeDirectory, {
    label: 'Prompt dependency directory',
    type: 'directory'
  });
  if (!boundary.exists) return [];
  const files = [];
  for (const entry of await readdir(boundary.absolute, { withFileTypes: true })) {
    const absolute = path.join(boundary.absolute, entry.name);
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new SingularityFlowError(`Prompt dependency cannot be a symbolic link: ${relative}`);
    if (entry.isDirectory()) files.push(...await markdownFiles(root, relative));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(absolute);
  }
  return files;
}

export async function worldModelPromptViewReferences(root, definition) {
  const repository = await secureRepositoryPath(root, '.', {
    label: 'Repository root',
    mustExist: true,
    type: 'directory'
  });
  const locations = [
    definition.templatesRoot,
    '.github/skills',
    '.github/agents'
  ];
  const source = definition.worldModel?.promptSource;
  const promptFiles = [];
  if (source && source !== 'builtin') {
    const prompt = await secureRepositoryPath(root, source, {
      label: 'World-model prompt',
      type: 'file'
    });
    if (prompt.exists) promptFiles.push(prompt.absolute);
  }
  for (const location of locations) promptFiles.push(...await markdownFiles(root, location));
  const references = new Map();
  for (const file of [...new Set(promptFiles)]) {
    const content = await readFile(file, 'utf8');
    for (const view of markdownWorldModelViews(content)) {
      const list = references.get(view) ?? [];
      const relative = path.relative(repository.root, file).replaceAll(path.sep, '/');
      if (!list.includes(relative)) list.push(relative);
      references.set(view, list);
    }
  }
  return references;
}

export async function validateWorldModelPromptViewReferences(root, definition) {
  if (!definition.worldModel?.views) return new Map();
  const configured = new Set(definition.worldModel.views);
  const references = await worldModelPromptViewReferences(root, definition);
  for (const [view, files] of references) {
    if (!configured.has(view)) throw new SingularityFlowError(`World-model view '${view}' is referenced by ${files.join(', ')} but is not declared in worldModel.views.`);
  }
  return references;
}

/**
 * Reuse one parsed definition for the duration of an explicitly read-only operation.
 *
 * `loadDefinition` is not cheap — a realpath walk, a YAML parse, three agent-directory scans, a
 * sha256 of every agent Markdown file, then validation — and one `snapshot --json` called it **seven
 * times** for the same unchanged file.
 *
 * It is opt-in, and that is the whole design. A process-wide memo would be the same mistake as
 * memoizing `identity()`: `bootstrap` self-heals a repository by writing `workflow.yml` and then
 * reading it back, and handing it the pre-repair definition would make the repair look like it did
 * not happen. Writers never opt in, so they cannot be affected by a cache they do not open.
 *
 * Nested calls share the outermost scope, and the cache is dropped on the way out whether the
 * operation succeeded or threw.
 */
/**
 * The read scope lives in `read-scope.mjs`, which imports nothing.
 *
 * It was here, and `git.mjs` needed the same scope for `branch()` — which made every fast command
 * statically reach this module and `agents.mjs` behind it. `dx-performance.test.mjs` refuses that
 * by name. `withDefinitionCache` is kept as the name callers already know; it is the read scope.
 */
export { inReadScope, scopedRead, scopedReadSync, withReadScope } from './read-scope.mjs';

/** The name callers already know. It is the read scope, under the label it was introduced with. */
export async function withDefinitionCache(fn) {
  return withReadScope(fn);
}

export async function loadDefinition(root) {
  // The scope stores the promise, so seven concurrent callers share one parse rather than race.
  return scopedRead(`config.definition:${root}`, () => loadDefinitionUncached(root));
}

async function loadDefinitionUncached(root) {
  const workflow = await secureRepositoryPath(root, WORKFLOW_PATH, {
    label: 'Workflow configuration',
    type: 'file'
  });
  if (workflow.exists) {
    const definition = YAML.parse(await readFile(workflow.absolute, 'utf8'));
    const agents = await discoverAgents(root);
    definition.agents = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
    definition.agentCatalog = agents;
    definition.agentPromptsRoot = '.github/agents';
    /**
     * Refusing an unknown field is right; refusing it without naming the likely cause is not.
     *
     * A repository whose governed configuration was written by a newer release carries policy keys
     * this build has never heard of, and every normalizer correctly refuses them — failing closed,
     * because silently ignoring `clarification.markers` would mean enforcing less than the
     * repository asked for, which is the one outcome a governance tool must never produce.
     *
     * But the bare message names a field and nothing else. Found by pointing an older CLI at a
     * repository upgraded by this work: `clarification contains unknown field 'markers'`, on every
     * command, with no hint that the fix is upgrading the tool rather than editing the file. The
     * VS Code extension, CI, and a teammate's laptop all hit this the moment one person upgrades.
     */
    try {
      validateDefinition(definition);
    } catch (error) {
      if (error instanceof SingularityFlowError && /contains unknown field/.test(error.message)) {
        throw new SingularityFlowError(
          `${error.message} This build is ${VERSION}. A governed configuration written by a newer release carries policy `
          + 'this version cannot enforce, so it is refused rather than partly applied. Upgrade Singularity Flow, or check '
          + 'out the configuration revision that matches this build.',
          { code: error.code ?? 'CONFIGURATION_UNKNOWN_FIELD', cause: error }
        );
      }
      throw error;
    }
    validateAgentCatalog(agents, definition);
    for (const workTypeId of Object.keys(definition.workTypes)) for (const phase of resolveWorkType(definition, workTypeId).phases) {
      if (isAgentTemplateReference(phase.template)) continue;
      const template = await secureRepositoryPath(root, path.join(definition.templatesRoot, phase.template), {
        label: `Template for work type '${workTypeId}' phase '${phase.id}'`,
        type: 'file'
      });
      if (!template.exists) throw new SingularityFlowError(`Template missing for work type '${workTypeId}' phase '${phase.id}': ${path.posix.join(definition.templatesRoot, phase.template)}`);
    }
    await validateWorldModelPromptViewReferences(root, definition);
    return definition;
  }
  if (existsSync(path.join(root, LEGACY_CONTROL_ROOT)) || existsSync(path.join(root, 'singularity/config.json'))) {
    throw new SingularityFlowError('Legacy workflow configuration is not supported by the governed-agent model. Recreate it with singularity-flow init.');
  }
  throw new SingularityFlowError(`Missing ${WORKFLOW_PATH}. Run: singularity-flow init`);
}

// Ensure the repository's workflow.yml declares at least `requiredViews` under worldModel.views,
// generating or extending the block in place. Used during onboarding/portfolio-bootstrap so a repo
// created without a worldModel block does not fail initiative validation. Comments and existing
// structure are preserved via YAML.parseDocument. Returns the sorted declared views, or null when
// nothing changed (already covered, or no workflow.yml on disk).
export async function ensureRepositoryWorldModelViews(root, requiredViews = []) {
  const file = await secureRepositoryPath(root, WORKFLOW_PATH, { label: 'Workflow configuration', type: 'file' });
  if (!file.exists) return null;
  const text = await readFile(file.absolute, 'utf8');
  const doc = YAML.parseDocument(text);
  const definition = doc.toJSON() ?? {};
  // Agent Markdown owns agent-specific view requirements. Raw workflow.yml does not repeat
  // those declarations, so onboarding must discover the same effective catalog loadDefinition
  // will validate after this repair.
  const agents = await discoverAgents(root);
  definition.agents = Object.fromEntries(agents.map((agent) => [agent.id, agent]));
  // A declared worldModel.views must cover every view the repository phase and agent contracts reference,
  // reference (validateDefinition enforces this), plus the views the initiative portfolio needs.
  const referenced = [...structuredWorldModelViewReferences(definition)].map(([view]) => view);
  const wanted = [...new Set([...requiredViews.map(String), ...referenced].filter(Boolean))];
  if (!wanted.length) return null;
  const declared = (doc.getIn(['worldModel', 'views'])?.toJSON?.() ?? doc.getIn(['worldModel', 'views']) ?? []);
  const declaredSet = new Set(Array.isArray(declared) ? declared.map(String) : []);
  const missing = wanted.filter((view) => !declaredSet.has(view));
  if (!missing.length) return [...declaredSet].sort();
  const merged = [...new Set([...declaredSet, ...wanted])].sort();
  doc.setIn(['worldModel', 'views'], merged);
  await writeFile(file.absolute, doc.toString());
  return merged;
}

// Copy every file from `source` that is absent at `destination`, recursively, without touching
// files that already exist. A whole-directory copyIfMissing is skipped once the destination exists,
// so template files added to the package in later versions never reach a repository initialized by
// an earlier one. This merges them in while preserving every local edit. Returns the relative paths
// that were installed.
export async function copyMissingFiles(source, destination, installed = [], relative = '') {
  if (!existsSync(source)) return installed;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await copyMissingFiles(from, to, installed, key);
    else if (entry.isFile() && !existsSync(to)) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(from, to);
      installed.push(key);
    }
  }
  return installed;
}

// Install any packaged template files the repository is missing (for example the initiatives/
// subtree required by the Epic profiles) into the templates root that will be read. The portfolio
// declares its own templatesRoot independently of the workflow definition, so callers resolving
// initiative templates must pass that root explicitly — healing the other one installs files
// nothing reads.
export async function ensureRepositoryTemplates(root, definition = null, { templatesRoot = null } = {}) {
  const target = templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates';
  assertRelative(target, 'templatesRoot');
  return copyMissingFiles(path.join(PACKAGE_ROOT, 'templates', 'artifacts'), path.join(root, target));
}

async function copyIfMissing(source, destination) {
  if (existsSync(destination)) return false;
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return true;
}

export async function initializeDefinition(root) {
  if (!existsSync(path.join(root, CONTROL_ROOT)) && existsSync(path.join(root, LEGACY_CONTROL_ROOT))) {
    throw new SingularityFlowError(`This repository contains unsupported ${LEGACY_CONTROL_ROOT}/ state. Run singularity-flow factory-reset to create a clean current configuration.`);
  }
  const wrote = [];
  for (const [source, destination] of INITIALIZATION_MAPPINGS) {
    if (await copyIfMissing(path.join(PACKAGE_ROOT, 'templates', source), path.join(root, destination))) wrote.push(destination);
  }
  // Directory mappings above are skipped once the destination exists, so re-running init on a
  // repository created by an earlier version would never receive template files added since.
  // Merge in any missing ones without overwriting local edits.
  for (const [source, destination] of [['artifacts', 'singularity/templates'], ['agents', '.github/agents']]) {
    if (wrote.includes(destination)) continue;
    for (const file of await copyMissingFiles(path.join(PACKAGE_ROOT, 'templates', source), path.join(root, destination))) {
      wrote.push(path.posix.join(destination, file));
    }
  }
  return wrote;
}

async function initializationFiles(source, destination, output = []) {
  if (!existsSync(source)) return output;
  const entries = await readdir(source, { withFileTypes: true });
  if (!entries.length) {
    output.push(destination);
    return output;
  }
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.posix.join(destination, entry.name);
    if (entry.isDirectory()) await initializationFiles(from, to, output);
    else if (entry.isFile()) output.push(to);
  }
  return output;
}

export async function initializationStatus(root) {
  const expectedFiles = [];
  for (const [source, destination] of INITIALIZATION_MAPPINGS) {
    const absolute = path.join(PACKAGE_ROOT, 'templates', source);
    if ((await readdir(path.dirname(absolute), { withFileTypes: true })).some((entry) => entry.name === path.basename(absolute) && entry.isDirectory())) {
      await initializationFiles(absolute, destination, expectedFiles);
    } else expectedFiles.push(destination);
  }
  expectedFiles.sort();
  const missingFiles = expectedFiles.filter((file) => !existsSync(path.join(root, file)));
  let configurationError = null;
  if (existsSync(path.join(root, WORKFLOW_PATH))) {
    try {
      await loadDefinition(root);
      await loadImpactDefinition(root, { required: true });
    }
    catch (error) { configurationError = error.message; }
  } else configurationError = `${WORKFLOW_PATH} is missing.`;
  return {
    schemaVersion: 1,
    complete: missingFiles.length === 0 && configurationError == null,
    expectedFiles,
    presentFiles: expectedFiles.filter((file) => !missingFiles.includes(file)),
    missingFiles,
    configurationError
  };
}

export function resolveWorkType(definition, workTypeId) {
  const workType = definition.workTypes[workTypeId];
  if (!workType) throw new SingularityFlowError(`Unknown work type '${workTypeId}'.`);
  let phases = workType.phases.map((id, order) => {
    const phase = structuredClone(definition.phases[id]);
    const override = structuredClone(workType.phaseOverrides?.[id] ?? {});
    const merged = {
      ...phase,
      ...override,
      artifact: { ...(phase.artifact ?? {}), ...(override.artifact ?? {}) },
      worldModel: { ...(phase.worldModel ?? {}), ...(override.worldModel ?? {}) },
      approval: override.approval === undefined
        ? phase.approval
        : typeof override.approval === 'string'
          ? override.approval
          : { ...(phase.approval ?? {}), ...override.approval },
      generation: override.generation === undefined
        ? phase.generation
        : typeof override.generation === 'string'
          ? override.generation
          : { ...(phase.generation ?? {}), ...override.generation },
      comparison: { ...(phase.comparison ?? {}), ...(override.comparison ?? {}) }
    };
    // A catalog id resolves to its path here, so every downstream reader — generation, the
    // designer, the catalog view — receives a path and never has to know which form was written.
    const declaredTemplate = workType.templateOverrides?.[id] ?? phase.defaultTemplate;
    const resolvedTemplate = resolveTemplate(definition, declaredTemplate, { label: `Work type '${workTypeId}' phase '${id}' template` });
    const template = resolvedTemplate?.source === 'catalog' ? resolvedTemplate.path : declaredTemplate;
    const inputs = normalizePhaseInputs(merged.inputs, `Work type '${workTypeId}' phase '${id}' inputs`);
    const approval = normalizeApprovalPolicy(merged.approval ?? {}, definition.approvalAuthorities, id);
    const sourceBoundary = normalizeSourceBoundary(merged.sourceBoundary, id);
    let generation = normalizeGenerationPolicy(merged.generation, id);
    generation = pinCodeDeliveryTask({ ...merged, generation }, 'generation');
    const mcp = normalizePhaseMcpPolicy(merged.mcp, { servers: definition.mcpServers, phaseId: id });
    const repairBudget = normalizeRepairBudget(merged.repairBudget, { phaseId: id, phases: workType.phases });
    const clarification = normalizeClarificationPolicy(merged.clarification);
    const specificationQuality = specificationQualityPolicy(merged.specificationQuality ?? {});
    const resolvedPhase = { id, order, ...merged, approval, generation, mcp, repairBudget, clarification, specificationQuality, sourceBoundary, inputs, template };
    assertCodeDeliveryConfiguration(resolvedPhase, `Work type '${workTypeId}' phase '${id}'`);
    return resolvedPhase;
  });
  const phaseById = Object.fromEntries(phases.map((phase) => [phase.id, phase]));
  phases = phases.map((phase) => ({
    ...phase,
    defaultAgent: definition.agentCatalog?.find((agent) => agent.defaultFor.includes(phase.id))?.id ?? null,
    inputs: phase.inputs.map((input) => ({ ...input, path: phaseById[input.phase]?.artifact?.path ?? null }))
  }));
  const documents = { ...(definition.documents ?? {}), ...(workType.documents ?? {}) };
  documents.allowedPhases = (documents.allowedPhases ?? []).filter((phaseId) => workType.phases.includes(phaseId));
  const sequenceGates = normalizeSequenceGates(definition.sequenceGates ?? {}, workType.sequenceGates ?? {});
  const contextPolicy = normalizeContextPolicy(definition.contextPolicy ?? {}, { phaseIds: Object.keys(definition.phases) });
  const tokenEconomy = normalizeTokenEconomy(definition.tokenEconomy ?? {});
  const intelligence = normalizeWorkTypeIntelligence(workType.intelligence, `Work type '${workTypeId}' intelligence`);
  return {
    id: workTypeId,
    label: workType.label,
    auto: normalizeAutoWorkTypePolicy(workType.auto, `Work type '${workTypeId}' auto`, workType.phases),
    inputsMode: configuredInputsMode(definition),
    approvalAuthorities: structuredClone(definition.approvalAuthorities),
    sequenceGates,
    contextPolicy,
    tokenEconomy,
    intelligence,
    worldModelGrounding: worldModelModeForIntelligence(groundingMode(definition), intelligence),
    ledger: normalizeLedgerConfig(definition.ledger ?? {}),
    // Pinned into the Story's resolution like every other policy `[SPK:REQ-110]`, so a later edit to
    // the shared set cannot change what an in-flight Story owes.
    artifactSets: normalizeArtifactSets(definition.artifactSets),
    // Pinned into the Story's resolution like every other policy `[SPK:CON-039]`, so a Story keeps
    // the constitution it started under while the configuration branch moves on.
    constitution: constitutionPolicy(workType.constitution),
    // `[SPK:REQ-130]`: the right bound for a small service is wrong for a monorepo, so it is
    // configuration rather than a constant, and pinned per Story like every other policy.
    analysisLimits: analysisLimits(definition.analysisLimits),
    spec: normalizeSpecPolicy(definition.spec ?? {}),
    codeDelivery: normalizeCodeDeliveryPolicy(definition.codeDelivery ?? {}),
    // Fault policy is pinned with the Story resolution so a repair requested for that Story cannot
    // acquire more authority merely because shared configuration changed later.
    faultRepair: normalizeFaultRepairPolicy(definition.faultRepair ?? {}),
    harnessImports: normalizeHarnessImports(definition.harnessImports),
    documents,
    designSources: normalizeDesignSourcePolicy(workType.designSources, { phases: workType.phases }),
    verification: normalizeVerificationPolicy(workType.verification, { phases: workType.phases }),
    phases
  };
}

export async function snapshotResolution(root, definition, resolved) {
  const workflow = await secureRepositoryPath(root, WORKFLOW_PATH, {
    label: 'Workflow configuration',
    mustExist: true,
    type: 'file'
  });
  const definitionSnapshot = await snapshot(workflow.absolute);
  const agents = {};
  for (const agent of definition.agentCatalog ?? []) {
    agents[agent.id] = {
      source: agent.source,
      sha256: agent.sha256,
      phases: agent.phases,
      defaultFor: agent.defaultFor,
      worldModelViews: agent.worldModelViews
    };
  }
  const templates = {};
  for (const phase of resolved.phases) {
    if (isAgentTemplateReference(phase.template)) {
      templates[phase.id] = await materializeAgentTemplate(root, phase.template, { phaseId: phase.id });
      continue;
    }
    const file = await secureRepositoryPath(root, path.join(definition.templatesRoot, phase.template), {
      label: `Template for phase '${phase.id}'`,
      mustExist: true,
      type: 'file'
    });
    templates[phase.id] = { path: path.posix.join(definition.templatesRoot, phase.template), sha256: (await snapshot(file.absolute)).sha256 };
  }
  const impact = await loadImpactDefinition(root);
  return {
    configSha256: definitionSnapshot.sha256,
    inputsMode: resolved.inputsMode ?? configuredInputsMode(definition),
    worldModelGrounding: resolved.worldModelGrounding ?? groundingMode(definition),
    worldModelMaterialization: materializationPolicy(definition),
    worldModelSourceScope: structuredClone(resolved.worldModelSourceScope ?? null),
    approvalAuthorities: structuredClone(resolved.approvalAuthorities ?? normalizeApprovalAuthorities(definition.approvalAuthorities)),
    sequenceGates: resolved.sequenceGates ?? normalizeSequenceGates(definition.sequenceGates ?? {}),
    contextPolicy: resolved.contextPolicy ?? normalizeContextPolicy(definition.contextPolicy ?? {}, { phaseIds: Object.keys(definition.phases) }),
    tokenEconomy: structuredClone(resolved.tokenEconomy ?? normalizeTokenEconomy(definition.tokenEconomy ?? {})),
    ledger: structuredClone(resolved.ledger ?? normalizeLedgerConfig(definition.ledger ?? {})),
    spec: structuredClone(resolved.spec ?? normalizeSpecPolicy(definition.spec ?? {})),
    codeDelivery: structuredClone(resolved.codeDelivery ?? normalizeCodeDeliveryPolicy(definition.codeDelivery ?? {})),
    /**
     * The constitution policy the Story is held to `[SPK:CON-039]`.
     *
     * Carried here as well as resolved, because this snapshot — not `resolveWorkType` — is what a
     * Story reads for the rest of its life. Resolving a policy that the snapshot then drops is how
     * `mode: enforce` reached a publication gate as `undefined` and enforced nothing.
     */
    constitution: structuredClone(resolved.constitution ?? constitutionPolicy(definition.constitution)),
    analysisLimits: structuredClone(resolved.analysisLimits ?? analysisLimits(definition.analysisLimits)),
    artifactSets: structuredClone(resolved.artifactSets ?? normalizeArtifactSets(definition.artifactSets)),
    harnessImports: structuredClone(resolved.harnessImports ?? normalizeHarnessImports(definition.harnessImports)),
    intelligence: structuredClone(resolved.intelligence ?? normalizeWorkTypeIntelligence()),
    impact: impact ? structuredClone(impact) : null,
    agents,
    mcpServers: structuredClone(definition.mcpServers ?? {}),
    designSources: structuredClone(resolved.designSources ?? null),
    verification: structuredClone(resolved.verification ?? normalizeVerificationPolicy()),
    templates
  };
}

export const ARTIFACT_TEMPLATE_TOKENS = Object.freeze({
  workId: '{{work.id}}',
  workTitle: '{{work.title}}',
  workType: '{{work.type}}',
  phaseId: '{{phase.id}}',
  phaseLabel: '{{phase.label}}',
  inputs: '{{inputs}}'
});

/** Render legacy packaged tokens in already-created repositories without permitting new use. */
export function normalizeArtifactTemplateCompatibility(text, variables) {
  return text.replaceAll('{{WORK_ID}}', variables.id ?? '');
}

export async function renderArtifactTemplate(root, definition, resolvedPhase, variables) {
  const relative = variables.templateSnapshot?.source === 'agent'
    ? path.join(root, variables.templateSnapshot.path)
    : path.join(root, definition.templatesRoot, resolvedPhase.template);
  const file = await secureRepositoryPath(root, relative, {
    label: `Artifact template for phase '${resolvedPhase.id}'`,
    mustExist: true,
    type: 'file'
  });
  const current = await snapshot(file.absolute);
  if (variables.templateSnapshot?.sha256 && current.sha256 !== variables.templateSnapshot.sha256) {
    throw new SingularityFlowError(`Artifact template for phase '${resolvedPhase.id}' changed after this work item was created. Restore ${file.relative} to ${variables.templateSnapshot.sha256} or start a new work item.`);
  }
  let text = normalizeArtifactTemplateCompatibility(await readFile(file.absolute, 'utf8'), variables);
  const replacements = {
    [ARTIFACT_TEMPLATE_TOKENS.workId]: variables.id,
    [ARTIFACT_TEMPLATE_TOKENS.workTitle]: variables.title,
    [ARTIFACT_TEMPLATE_TOKENS.workType]: variables.workType,
    [ARTIFACT_TEMPLATE_TOKENS.phaseId]: resolvedPhase.id,
    [ARTIFACT_TEMPLATE_TOKENS.phaseLabel]: resolvedPhase.label,
    [ARTIFACT_TEMPLATE_TOKENS.inputs]: variables.inputs ?? ''
  };
  const unsupported = [...new Set(text.match(/\{\{[^{}\r\n]+\}\}/g) ?? [])]
    .filter((token) => !Object.hasOwn(replacements, token));
  if (unsupported.length) {
    throw new SingularityFlowError(
      `Artifact template for phase '${resolvedPhase.id}' contains unsupported token(s): ${unsupported.join(', ')}. `
      + `Supported tokens: ${Object.keys(replacements).join(', ')}.`
    );
  }
  for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value ?? '');
  return text;
}

export async function agentPrompt(root, definition, agentId) {
  const agent = definition.agents?.[agentId] ?? (await discoverAgents(root)).find((candidate) => candidate.id === agentId);
  if (!agent) throw new SingularityFlowError(`Unknown governed agent '${agentId}'.`);
  return agent.prompt;
}
