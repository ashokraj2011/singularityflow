import { normalizeApplicationReview } from './code-delivery-policy.mjs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { assertStoryBranchNaming } from './story-branch-name.mjs';
import { readConfigurationSource } from './configuration-source.mjs';
import { validateTokenReportingPolicy } from './token-reporting-policy.mjs';
import { normalizeSessionPolicy } from "./kernel/configuration-policy.mjs";
export { normalizeSessionPolicy } from "./kernel/configuration-policy.mjs";
import {
  cp, mkdir, readFile, readdir
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { createWorkflowConfigurationCompiler, mergePhaseOverride, STEP_DESCRIPTION_LIMIT, DEFAULT_PLANNING_PROMPT, SEQUENCE_GATE_IDS } from './kernel/workflow-configuration.mjs';
export { STEP_DESCRIPTION_LIMIT, DEFAULT_PLANNING_PROMPT, SEQUENCE_GATE_IDS } from './kernel/workflow-configuration.mjs';

import { PACKAGE_ROOT } from './package-root.mjs';
import {
  ensureSecureRepositoryDirectory, mapLimit, repoRelative, secureRepositoryPath, SingularityFlowError, posix, run, snapshot, writeBytes
} from './util.mjs';
import { validateInjectionDefinition } from './inject.mjs';
import { scopedRead, withReadScope } from './read-scope.mjs';
import { configurationReadRoot, configurationReadDefinition } from './configuration-read-scope.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { assertAttachedLibrarySkills } from './skill-library.mjs';
import { isAgentTemplateReference, parseAgentTemplateReference } from './agent-document-parser.mjs';
import { loadPortfolio, normalizeStorage } from './initiative-config.mjs';
import { normalizeLogging } from './logging.mjs';
import { normalizeContextPolicy } from "./kernel/configuration-policy.mjs";
import { normalizeApprovalAuthorities } from './kernel/approval-policy.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';

import { specificationQualityPolicy } from './specification-quality.mjs';
import { normalizeArtifactSets } from './artifact-sets.mjs';
import { assertNoAutonomousConvergence } from './convergence.mjs';

import { assertPhaseTopology, PHASE_SEMANTICS_PROFILE, ARA_PHASE_SEMANTICS_PROFILE, phaseTopologyFindings } from './phase-semantics.mjs';
import { analysisLimits } from './analysis-limits.mjs';
import { VERSION } from './version.mjs';
import { constitutionPolicy } from './constitution.mjs';

import { normalizeMarketplaces } from './marketplace.mjs';
import { isSpecificationDefinitionPhase, skillPhasePrimaryOutputRole } from './specifications.mjs';
import { normalizeSpecPolicy } from "./kernel/configuration-policy.mjs";
import { normalizeHarnessImports } from "./kernel/configuration-policy.mjs";
import { loadImpactDefinition } from './impact-config.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';

import { compileObligationGraph, pinnedObligationGraph } from './evidence/obligation-compiler.mjs';
import { normalizeSourceBoundary } from './source-boundary.mjs';

import { normalizeWorkItemRoot } from './work-item-location.mjs';
import { normalizeFaultRepairPolicy } from './fault-repair.mjs';
import { normalizeTestRecoveryPolicy } from './test-recovery-intake.mjs';

import { normalizeAstPolicy } from './ast-policy.mjs';
import { assertCodeDeliveryConfiguration, compiledSkillStep, pinCodeDeliveryTask, stepOutputKind } from './code-delivery-policy.mjs';
import { normalizeCodeDeliveryPolicy } from "./kernel/configuration-policy.mjs";
import { AUTHORING_SKILL_ID, authoringSkillCatalog } from './authoring-skills.mjs';

import { normalizeWorkTypeIntelligence } from "./kernel/configuration-policy.mjs";
import { normalizeTokenEconomy } from "./kernel/configuration-policy.mjs";

import { normalizeSourceRoots, worldModelSourceScope } from './source-scope.mjs';
import { validateConfiguredSkillPhase } from './skp-contract.mjs';
import { disabledArchitectureIntent, dropRemovedSettings } from './removed-features.mjs';
import { worldModelStateAuthority } from './state-authority.mjs';
import { INITIALIZATION_MAPPINGS } from './initialization-assets.mjs';
import { GOVERNED_ROOTS } from './governed-roots.mjs';
import {
  hasRetiredPackagedAssetHistory, isCurrentPackagedAssetHash,
  isRetiredPackagedAsset, packagedAssetSha256
} from './packaged-asset-history.mjs';
import { normalizeMarkdownHeading, parseMarkdownStructure } from './kernel/artifact-content.mjs';
import {
  loadEnvironmentDeclaration, withEnvironmentWorldModelExclusions
} from './environment-declaration.mjs';
import { gateRefusal } from './evidence/gate-refusal.mjs';
import { renderClauseNamespaces } from './foundation/traceability-ids.mjs';

export const WORKFLOW_PATH = 'singularity/workflow.yml';
export const CONTROL_ROOT = 'singularity';

// This installed composition retains every existing policy validator. Operation inputs cannot
// supply these collaborators or create an approved configuration by returning a readiness flag.
const {
  normalizeReferenceRepositoryPolicy,
  normalizePlannedClaimsPolicy,
  configuredInputsMode,
  normalizeSequenceGates,
  applyWorkflowCompatibility,
  normalizePhaseInputs,
  normalizeGenerationPolicy,
  normalizeDesignSourcePolicy,
  normalizeVerificationPolicy,
  normalizeRepositoryReadinessPolicy,
  normalizePlanning,
  normalizeModelProviders,
  validateDefinition,
  resolveWorkType,
  assertRelative,
  declaredCatalogValue
} = createWorkflowConfigurationCompiler({
  ARA_PHASE_SEMANTICS_PROFILE,
  AUTHORING_SKILL_ID,
  PHASE_SEMANTICS_PROFILE,
  absolutePath: path.isAbsolute,
  analysisLimits,
  assertCodeDeliveryConfiguration,
  assertNoAutonomousConvergence,
  assertStoryBranchNaming,
  authoringSkillCatalog,
  compileObligationGraph,
  compiledSkillStep,
  constitutionPolicy,
  disabledArchitectureIntent,
  dropRemovedSettings,
  isAgentTemplateReference,
  isSpecificationDefinitionPhase,
  normalizeApplicationReview,
  normalizeArtifactSets,
  normalizeAstPolicy,
  normalizeCommitPolicyRuntime,
  normalizeExternalCommand,
  normalizeFaultRepairPolicy,
  normalizeLedgerConfig,
  normalizeLogging,
  normalizeMarketplaces,
  normalizeSourceBoundary,
  normalizeSourceRoots,
  normalizeStorage,
  normalizeTestRecoveryPolicy,
  normalizeWorkItemRoot,
  parseAgentTemplateReference,
  pathBasename: path.posix.basename,
  pinCodeDeliveryTask,
  posix,
  skillPhasePrimaryOutputRole,
  specificationQualityPolicy,
  stepOutputKind,
  validateConfiguredSkillPhase,
  validateInjectionDefinition,
  validateTokenReportingPolicy,
  worldModelSourceScope,
  worldModelStateAuthority
});
export {
  normalizeReferenceRepositoryPolicy,
  normalizePlannedClaimsPolicy,
  configuredInputsMode,
  normalizeSequenceGates,
  applyWorkflowCompatibility,
  normalizePhaseInputs,
  normalizeGenerationPolicy,
  normalizeDesignSourcePolicy,
  normalizeVerificationPolicy,
  normalizeRepositoryReadinessPolicy,
  normalizePlanning,
  normalizeModelProviders,
  validateDefinition,
  resolveWorkType
};

function normalizeCommitPolicyRuntime(value) {
  if (!process.features.require_module) throw new SingularityFlowError('Repository commit policy requires the SFlow-managed runtime or Node 22.12 or later.', {code: 'RCP_RUNTIME_UNSUPPORTED'});
  const policyModule = path.join(PACKAGE_ROOT, 'src/repository-commit-policy/policy.mjs');
  return createRequire(path.join(PACKAGE_ROOT, 'package.json'))(policyModule).normalizeCommitPolicy(value);
}
const LEGACY_CONTROL_ROOT = '.singularity';
/**
 * Everything `initializeDefinition` writes, expressed as the paths a caller must stage to commit
 * all of it. Derived from the mappings rather than restated beside them: `.github/agents` was
 * written from the beginning and staged by only one of the three call sites, which left the agent
 * definitions untracked after `bootstrap` — enough to fail the very next command's clean-tree check
 * and to omit them from the governance proposal. A new mapping under a new root now reaches every
 * stager automatically.
 */
export { GOVERNED_ROOTS };

/**
 * Refuse starting new work from a work type that cannot start: an unmigrated planned-claim
 * contract, or routes that would end a Story without one of its responsibilities [E2G-005].
 */
export function assertWorkTypeStartable(resolved) {
  assertPhaseTopology(resolved);
  assertPlannedClaimsReady(resolved);
  const errors = (resolved?.obligationGraph?.findings ?? []).filter((entry) => entry.severity === 'error');
  if (!errors.length) return resolved;
  throw new SingularityFlowError(
    `Workflow '${resolved.id}' cannot start a Story, because its routes would end one without a responsibility:\n- `
    + `${errors.map((entry) => entry.message).join('\n- ')}\nFix: ${errors[0].resolvingAction}`,
    {
      code: 'WORKFLOW_OBLIGATIONS_UNMET',
      details: {
        workType: resolved.id,
        findings: errors.map(({ code, message, resolvingAction, subject }) => ({ code, message, resolvingAction, subject })),
        gate: gateRefusal({
          code: 'WORKFLOW_OBLIGATIONS_UNMET', gate: 'intake-readiness',
          findings: errors.map(({ code, message }) => ({ code, message })),
          actions: ['singularity-flow workflow validate']
        })
      }
    }
  );
}

/** Refuse starting new work from a readable-but-unmigrated legacy workflow. */
export function assertPlannedClaimsReady(resolved) {
  if (resolved?.plannedClaims?.mode !== 'migration-required') return resolved;
  const id = resolved.id ?? 'unknown';
  throw new SingularityFlowError(
    `Workflow '${id}' predates the planned-claim contract and cannot start a new Story. `
    + 'Review it with singularity-flow workflow validate, then run workflow edit with '
    + '--planned-claims required --clause-phases <PHASES> --claim-owners <CODE>=<OWNER> (comma-separate several), '
    + 'or, for a workflow that defines no requirement clauses, declare omits for scope with a reason and the approval group that decides. Existing Stories keep their pinned policy.',
    {
      code: 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED',
      details: { workType: id, reason: resolved.plannedClaims.reason ?? null }
    }
  );
  return resolved;
}

function plannedClaimsReadinessShape(resolved) {
  return {
    spec: resolved.spec,
    phases: resolved.phases.map((phase) => ({
      id: phase.id,
      artifactKind: phase.artifact?.kind ?? null,
      generationTask: phase.generation?.task ?? null
    }))
  };
}

/**
 * Keep old catalogs readable, but do not let an authoring boundary introduce or reshape an
 * unresolved planned-claim topology. Presentation-only edits remain possible while the legacy
 * workflow is being migrated; phase order, specification policy, and the artifact/task signals
 * that determine clause ownership are the material contract.
 */
export function assertWorkflowReadinessChanges(previousDefinition, candidateDefinition) {
  for (const workTypeId of Object.keys(candidateDefinition?.workTypes ?? {})) {
    const candidate = resolveWorkType(candidateDefinition, workTypeId);
    // Own declarations only: a new workflow named constructor has no inherited previous version.
    const previous = declaredCatalogValue(previousDefinition?.workTypes, workTypeId)
      ? resolveWorkType(previousDefinition, workTypeId) : null;
    if (phaseTopologyFindings(candidate).length) {
      const topology = (resolved) => (resolved?.phases ?? []).map((phase) => ({
        id: phase.id, kind: phase.artifact?.kind, task: phase.generation?.task,
        requirement: phase.generation?.requirement, writeScope: phase.writeScope
      }));
      // Existing incomplete drafts may be relabelled and repaired. They may not be copied or
      // materially reshaped into another accepted-but-unexecutable workflow.
      if (!previous || JSON.stringify(topology(previous)) !== JSON.stringify(topology(candidate))) {
        assertPhaseTopology(candidate);
      }
    }
    if (candidate.plannedClaims.mode !== 'migration-required') continue;
    const unchangedLegacy = previous?.plannedClaims.mode === 'migration-required'
      && JSON.stringify(plannedClaimsReadinessShape(previous))
        === JSON.stringify(plannedClaimsReadinessShape(candidate));
    if (unchangedLegacy) continue;
    throw new SingularityFlowError(
      `Workflow '${workTypeId}' has a migration-required planned-claim contract and cannot be added or materially changed. `
      + (candidate.plannedClaims.reason ? `${candidate.plannedClaims.reason.replace(/\.+$/u, '')}. ` : '')
      + 'Declare a resolvable required topology: plannedClaims with mode required, clausePhases naming the step that '
      + 'writes requirements or an implementation spec, and owners mapping each code step to the step that plans it. '
      + 'A workflow that defines no requirement clauses declares omits for scope instead: '
      + 'omits with responsibility scope, a reason, and the approval group as authority.',
      {
        code: 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED',
        details: { workType: workTypeId, reason: candidate.plannedClaims.reason ?? null }
      }
    );
  }
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

export async function loadDefinition(root, { storyBootstrap = false } = {}) {
  // The scope stores the promise, so seven concurrent callers share one parse rather than race.
  // Story bootstrap deliberately has its own cache identity: it validates the machine-facing
  // configuration while deferring mutable authoring resources (live agents/templates) until the
  // accepted Story snapshot has been verified. Sharing that value with a normal load would let a
  // relaxed bootstrap accidentally weaken a repository-management command later in the scope.
  // Configuration overlays deliberately keep the application root stable while swapping the
  // bounded configuration root. Include both in the cache identity or a launch-checkout parse can
  // leak into a later exact-base/approved-authority read in the same command.
  const definitionRoot = configurationReadRoot(root);
  return scopedRead(`config.definition:${root}:${definitionRoot}:${storyBootstrap ? 'story-bootstrap' : 'current'}`,
    async () => {
      const compiled = !storyBootstrap && await configurationReadDefinition(root);
      if (compiled) {
        // The application checkout remains mutable. Never use an immutable configuration receipt
        // to skip containment of runtime output roots or today's environment-local exclusions.
        await validateDefinitionRuntimeRoots(root, compiled, await loadPortfolio(definitionRoot, { required: false }));
        return withEnvironmentWorldModelExclusions(compiled, await loadEnvironmentDeclaration(root, { optional: true }));
      }
      incrementCommandCounter('configuration.definition-load');
      return measureCommandSpan('configuration.definition-load', () => loadDefinitionUncached(root, { storyBootstrap }));
    });
}

async function validateDefinitionRuntimeRoots(root, definition, portfolio = null) {
  for (const [relative, label] of [
    [definition.workItemRoot, 'Story state root'],
    [definition.templatesRoot, 'Repository templates root'],
    ['singularity/world-model', 'World-model output root'],
    [definition.agentPromptsRoot, 'Agent prompt root'],
    [portfolio?.initiativeRoot ?? definition.initiativeRoot, 'Initiative state root'],
    [portfolio?.templatesRoot, 'Initiative templates root']
  ]) {
    if (!relative) continue;
    const secured = await secureRepositoryPath(root, relative, { label });
    if (secured.exists && !secured.entry?.isDirectory()) throw new SingularityFlowError(`${label} must be a directory: ${secured.relative}`);
  }
}

/**
 * Validate approved-summary section contracts against the producer template before a Story starts.
 *
 * Runtime brief generation still validates the authored artifact because people may remove or
 * empty a section while authoring. This earlier check catches impossible configuration — including
 * YAML flow-sequence commas that accidentally split one heading into several values — while the
 * configuration can still be reviewed and repaired safely.
 */
export async function validateAgentBriefHeadingContracts(root, definition) {
  const parsedByTemplate = new Map();
  for (const workTypeId of Object.keys(definition.workTypes ?? {})) {
    const resolved = resolveWorkType(definition, workTypeId);
    const phaseById = new Map(resolved.phases.map((phase) => [phase.id, phase]));
    for (const consumer of resolved.phases) {
      for (const declaration of consumer.inputs ?? []) {
        if (declaration.projection !== 'approved-summary' || !(declaration.preserve?.length)) continue;
        const producer = phaseById.get(declaration.phase);
        if (!producer) continue; // resolveWorkType reports invalid phase references independently.
        if (producer.kind === 'skill') {
          throw new SingularityFlowError(
            `Work type '${workTypeId}' phase '${consumer.id}' cannot prevalidate preserved headings from skill phase '${producer.id}'.`,
            { code: 'SKP_INPUT_PROJECTION_UNSUPPORTED' }
          );
        }
        if (isAgentTemplateReference(producer.template)) {
          throw new SingularityFlowError(
            `Work type '${workTypeId}' phase '${consumer.id}' cannot declare preserved headings for dynamic Agent template '${producer.template}'. Use a repository template so the heading contract can be validated before Story start.`,
            { code: 'AGENT_BRIEF_PRESERVE_TEMPLATE_DYNAMIC' }
          );
        }
        let parsed = parsedByTemplate.get(producer.template);
        if (!parsed) {
          const file = await secureRepositoryPath(
            root, path.join(definition.templatesRoot, producer.template),
            { label: `Template for work type '${workTypeId}' phase '${producer.id}'`, mustExist: true, type: 'file' }
          );
          parsed = parseMarkdownStructure(await readFile(file.absolute, 'utf8'));
          parsedByTemplate.set(producer.template, parsed);
        }
        validateAgentBriefHeadingStructure(parsed, { workTypeId, consumer, producer, declaration });
      }
    }
  }
}

function validateAgentBriefHeadingStructure(parsed, { workTypeId, consumer, producer, declaration }) {
  if (parsed.unclosedComments.length) {
    throw new SingularityFlowError(
      `Template '${producer.template}' has an unclosed HTML comment beginning at line ${parsed.unclosedComments[0].line}; preserved-heading contracts cannot be validated.`,
      { code: 'TEMPLATE_COMMENT_UNCLOSED', details: { workType: workTypeId, phase: producer.id,
        template: producer.template, line: parsed.unclosedComments[0].line } }
    );
  }
  for (const requested of declaration.preserve) {
    const normalized = normalizeMarkdownHeading(requested);
    const matches = parsed.headings.filter((heading) => heading.normalized === normalized);
    if (matches.length !== 1) {
      throw new SingularityFlowError(
        matches.length
          ? `Work type '${workTypeId}' phase '${consumer.id}' preserves ambiguous heading '${requested}' from ${producer.template}; matching headings are at lines ${matches.map((heading) => heading.line).join(', ')}.`
          : `Work type '${workTypeId}' phase '${consumer.id}' preserves heading '${requested}', but ${producer.template} has no visible heading with that name.`,
        { code: matches.length ? 'AGENT_BRIEF_PRESERVE_HEADING_AMBIGUOUS' : 'AGENT_BRIEF_PRESERVE_HEADING_MISSING',
          details: { workType: workTypeId, consumerPhase: consumer.id, producerPhase: producer.id,
            template: producer.template, heading: requested, matchingLines: matches.map((heading) => heading.line) } }
      );
    }
  }
}

/** Validate preserved sections from an exact caller-captured Map, without any filesystem read. */
export function validateCapturedAgentBriefHeadingContracts(definition, templates) {
  const parsedByTemplate = new Map();
  for (const workTypeId of Object.keys(definition.workTypes ?? {})) {
    const resolved = resolveWorkType(definition, workTypeId);
    const phaseById = new Map(resolved.phases.map((phase) => [phase.id, phase]));
    for (const consumer of resolved.phases) for (const declaration of consumer.inputs ?? []) {
      if (declaration.projection !== 'approved-summary' || !(declaration.preserve?.length)) continue;
      const producer = phaseById.get(declaration.phase);
      if (!producer) continue;
      if (producer.kind === 'skill') throw new SingularityFlowError(
        `Work type '${workTypeId}' phase '${consumer.id}' cannot prevalidate preserved headings from skill phase '${producer.id}'.`,
        { code: 'SKP_INPUT_PROJECTION_UNSUPPORTED' });
      if (isAgentTemplateReference(producer.template)) throw new SingularityFlowError(
        `Work type '${workTypeId}' phase '${consumer.id}' cannot declare preserved headings for dynamic Agent template '${producer.template}'. Use a repository template so the heading contract can be validated before Story start.`,
        { code: 'AGENT_BRIEF_PRESERVE_TEMPLATE_DYNAMIC' });
      let parsed = parsedByTemplate.get(producer.template);
      if (!parsed) {
        const content = templates.get(`${definition.templatesRoot}/${producer.template}`);
        if (typeof content !== 'string') throw new SingularityFlowError('An exact captured producer template is unavailable.',
          { code: 'WCA_CONTENT_UNRESOLVED' });
        parsed = parseMarkdownStructure(content); parsedByTemplate.set(producer.template, parsed);
      }
      validateAgentBriefHeadingStructure(parsed, { workTypeId, consumer, producer, declaration });
    }
  }
}

async function loadDefinitionUncached(root, { storyBootstrap = false } = {}) {
  const definitionRoot = configurationReadRoot(root);
  const source = await readConfigurationSource(root);
  const { workflow, workflowText } = source;
  if (workflow.exists) {
    // A broken workflow.yml is refused exactly as before; the refusal also carries every problem in
    // the file, located and with its fix. Only this failure path pays for the diagnosis.
    const diagnosed = error => withWorkflowDiagnostics(definitionRoot, workflowText, error, { storyBootstrap });
    if (source.error) throw await diagnosed(Object.create(
      Object.getPrototypeOf(source.error), Object.getOwnPropertyDescriptors(source.error)
    ));
    // Compatibility normalization and both validators may mutate their input. Share bytes and
    // parsing only, not a bootstrap result or mutable object with current-policy validation.
    const definition = applyWorkflowCompatibility(structuredClone(source.parsed));
    // Which agents APM deployed draft which steps; discovery applies them (agents.mjs) [APM A3]. One
    // that cannot be read binds nothing and never stops configuration loading; apm status says why.
    if (definition.apm != null) {
      try { definition.apm = (await import('./apm-configuration.mjs')).normalizeApmConfiguration(definition.apm); }
      catch { definition.apm = { agents: {} }; }
    }
    // An accepted Story owns exact governed-agent bytes in its WFA closure. Parsing today's live
    // files before that closure is even located would let a deleted or malformed replacement deny
    // offline resume. Bootstrap therefore loads only the declarative workflow shape; the shared
    // Story resolver installs the verified saved catalog before any agent is selected or rendered.
    // New-Story and repository-management reads keep the strict live discovery below.
    const agentServices = storyBootstrap ? null : await import('./agents.mjs');
    const agents = storyBootstrap ? [] : await measureCommandSpan('configuration.agents', () => agentServices.discoverAgents(definitionRoot));
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
      await measureCommandSpan('configuration.validate', () => validateDefinition(definition, { storyBootstrap }));
    } catch (error) {
      if (!(error instanceof SingularityFlowError && /contains unknown field/.test(error.message))) throw await diagnosed(error);
      throw await diagnosed(new SingularityFlowError(
        `${error.message} If you typed this field, check its spelling. This build is ${VERSION}. An approved configuration written by a newer release carries policy `
        + 'this version cannot enforce, so it is refused rather than partly applied. Upgrade Singularity Flow, or check '
        + 'out the configuration revision that matches this build.',
        { code: error.code ?? 'CONFIGURATION_UNKNOWN_FIELD', cause: error }
      ));
    }
    if (!storyBootstrap) {
      agentServices.validateAgentCatalog(agents, definition);
      await assertAttachedLibrarySkills(definitionRoot, agents, definition);
    }
    const portfolio = await loadPortfolio(definitionRoot, { required: false });
    const governedRoots = [...new Set([
      ...GOVERNED_ROOTS,
      definition.workItemRoot,
      definition.templatesRoot,
      definition.agentPromptsRoot,
      'singularity/world-model',
      portfolio?.initiativeRoot,
      portfolio?.templatesRoot
    ].filter(Boolean))].sort();
    // These are derived runtime context, not workflow.yml fields. Keep them available to every
    // path classifier without making YAML round-trips invent unsupported configuration keys.
    Object.defineProperties(definition, {
      initiativeRoot: { value: portfolio?.initiativeRoot ?? 'singularity/initiatives', enumerable: false },
      governedRoots: { value: Object.freeze(governedRoots), enumerable: false }
    });
    await validateDefinitionRuntimeRoots(root, definition, portfolio);
    if (!storyBootstrap) {
      // Several workflows reuse the same phase template. Prove each exact path once during this
      // load, not once per workflow. No proof survives this call or crosses a checkout/write.
      const checkedTemplates = new Map();
      for (const workTypeId of Object.keys(definition.workTypes)) for (const phase of resolveWorkType(definition, workTypeId).phases) {
        if (phase.kind === 'skill') {
          if (!phase.defaultAgent) {
            throw new SingularityFlowError(
              `Work type '${workTypeId}' skill phase '${phase.id}' has no selected agent.`,
              { code: 'SKP_AGENT_UNAVAILABLE' }
            );
          }
          continue;
        }
        if (isAgentTemplateReference(phase.template)) continue;
        const relativeTemplate = path.join(definition.templatesRoot, phase.template);
        if (checkedTemplates.has(relativeTemplate)) {
          incrementCommandCounter('configuration.template-reuses');
          continue;
        }
        incrementCommandCounter('configuration.template-checks');
        checkedTemplates.set(relativeTemplate, { workTypeId, phase, relativeTemplate });
      }
      // Independent read-only containment checks can overlap Windows file-open latency. Settle
      // every reader before returning; retain original catalog order for deterministic refusals.
      const templates = await measureCommandSpan('configuration.templates', () => mapLimit(checkedTemplates.values(), 4, async entry => {
        try {
          return { ...entry, template: await secureRepositoryPath(root, entry.relativeTemplate, {
            label: `Template for work type '${entry.workTypeId}' phase '${entry.phase.id}'`, type: 'file'
          }) };
        } catch (error) { return { ...entry, error }; }
      }));
      for (const { workTypeId, phase, template, error } of templates) {
        if (error) throw error;
        if (!template.exists) throw await diagnosed(new SingularityFlowError(`Template missing for work type '${workTypeId}' phase '${phase.id}': ${path.posix.join(definition.templatesRoot, phase.template)}`));
      }
      await validateAgentBriefHeadingContracts(root, definition);
    }
    return withEnvironmentWorldModelExclusions(
      definition,
      await loadEnvironmentDeclaration(root, { optional: true })
    );
  }
  if (existsSync(path.join(root, LEGACY_CONTROL_ROOT)) || existsSync(path.join(root, 'singularity/config.json'))) {
    throw new SingularityFlowError('Legacy workflow configuration is not supported by the agent model. Recreate it with singularity-flow init.');
  }
  throw new SingularityFlowError(`Missing ${WORKFLOW_PATH}. Run: singularity-flow init`, {
    code: 'WORKFLOW_CONFIGURATION_MISSING'
  });
}

/**
 * The same refusal, carrying every located problem in workflow.yml under
 * `details.configurationProblems`. A YAML syntax error becomes a SingularityFlowError in plain words
 * (code WORKFLOW_YAML_INVALID) instead of the parser's own message. If the diagnosis itself fails,
 * the original refusal stands untouched.
 */
async function withWorkflowDiagnostics(definitionRoot, text, error, { storyBootstrap = false } = {}) {
  try {
    const { diagnoseWorkflowText } = await import('./configuration-diagnostics.mjs');
    const problems = await diagnoseWorkflowText(text, {
      root: definitionRoot, validate: (candidate) => validateDefinition(candidate, { storyBootstrap }),
      prepare: applyWorkflowCompatibility, resolveWorkType: storyBootstrap ? null : resolveWorkType, isAgentTemplateReference
    });
    if (!problems.length) return error;
    if (!(error instanceof SingularityFlowError)) {
      const [first] = problems;
      return new SingularityFlowError(
        `${WORKFLOW_PATH} is not valid YAML at line ${first.line ?? '?'}: ${first.message}${first.fix ? ` ${first.fix}` : ''}`,
        { code: 'WORKFLOW_YAML_INVALID', details: { configurationProblems: problems }, cause: error }
      );
    }
    error.details = { ...(error.details ?? {}), configurationProblems: problems };
    return error;
  } catch {
    return error;
  }
}

// Copy every file from `source` that is absent at `destination`, recursively, without touching
// files that already exist. A whole-directory copyIfMissing is skipped once the destination exists,
// so template files added to the package in later versions never reach a repository initialized by
// an earlier one. This merges them in while preserving every local edit. Returns the relative paths
// that were installed.
export async function copyMissingFiles(source, destination, installed = [], relative = '', repositoryRoot = null) {
  if (!existsSync(source)) return installed;
  if (repositoryRoot) {
    await ensureSecureRepositoryDirectory(repositoryRoot, repoRelative(repositoryRoot, destination), {
      label: 'Repository template directory'
    });
  }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const key = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await copyMissingFiles(from, to, installed, key, repositoryRoot);
    else if (entry.isFile()) {
      if (repositoryRoot) {
        await secureRepositoryPath(repositoryRoot, repoRelative(repositoryRoot, to), {
          label: 'Repository template target'
        });
      }
      if (!existsSync(to)) {
        if (repositoryRoot) {
          await ensureSecureRepositoryDirectory(repositoryRoot, repoRelative(repositoryRoot, path.dirname(to)), {
            label: 'Repository template parent'
          });
        } else await mkdir(path.dirname(to), { recursive: true });
        await cp(from, to);
        installed.push(key);
      } else if (await replaceRetiredPackagedFile(from, to, repositoryRoot)) {
        installed.push(key);
      }
    }
  }
  return installed;
}

/**
 * Replace only a byte-for-byte historical package asset for this exact repository path.
 *
 * Repository-owned agent documents may be intentionally customized, so age, names and parsed
 * metadata are never sufficient authority to overwrite one. The reviewed history registry is the
 * complete compatibility boundary: any byte difference preserves the repository copy. The final
 * write is atomic so a crash cannot leave a partially-written governed agent.
 */
async function replaceRetiredPackagedFile(source, destination, repositoryRoot) {
  if (!repositoryRoot) return false;
  const relative = repoRelative(repositoryRoot, destination);
  if (!hasRetiredPackagedAssetHistory(relative)) return false;
  const secured = await secureRepositoryPath(repositoryRoot, relative, {
    label: 'Historical packaged asset', mustExist: true
  });
  if (!secured.entry?.isFile()) return false;
  const current = await readFile(secured.absolute);
  // The overwhelmingly common path is an already-current installation. Avoid one Git process per
  // packaged file merely to rediscover what its exact worktree digest already proves.
  if (isCurrentPackagedAssetHash(relative, packagedAssetSha256(current))) return false;
  if (!isRetiredPackagedAsset(relative, current)
      && !trackedRetiredPackagedAsset(repositoryRoot, relative, current)) return false;
  const bundled = await readFile(source);
  if (packagedAssetSha256(current) === packagedAssetSha256(bundled)) return false;
  await writeBytes(secured.absolute, bundled);
  return true;
}

/**
 * Prove that checkout-only CRLF conversion did not turn an exact package blob into a customization.
 *
 * Git stores the canonical bytes in the index, while `core.autocrlf=true` or an `eol=crlf`
 * attribute may materialize the same tracked file with CRLF in a Windows worktree. The raw-byte
 * path above remains the authority for untracked/fresh files. For a tracked file, accept only when
 * its exact index blob is a retired package revision and the worktree bytes are either that blob or
 * its one deterministic LF-to-CRLF checkout representation. Any other byte—including a BOM,
 * missing newline, content edit, or mixed/custom line ending—is preserved.
 */
function trackedRetiredPackagedAsset(repositoryRoot, relative, worktreeBytes) {
  const indexed = run('git', ['cat-file', 'blob', `:${relative}`], {
    cwd: repositoryRoot,
    allowFailure: true,
    encoding: 'buffer'
  });
  if (indexed.status !== 0 || !Buffer.isBuffer(indexed.stdout)
      || !isRetiredPackagedAsset(relative, indexed.stdout)) return false;
  if (worktreeBytes.equals(indexed.stdout)) return true;

  // Do this as a byte transform rather than decoding/re-encoding Markdown. That keeps provenance
  // exact and cannot normalize an unrelated Unicode or invalid-byte customization into a match.
  const output = [];
  for (let index = 0; index < indexed.stdout.length; index += 1) {
    const byte = indexed.stdout[index];
    if (byte === 0x0a && (index === 0 || indexed.stdout[index - 1] !== 0x0d)) output.push(0x0d);
    output.push(byte);
  }
  return worktreeBytes.equals(Buffer.from(output));
}

// Install any packaged template files the repository is missing (for example the initiatives/
// subtree required by the Epic profiles) into the templates root that will be read. The portfolio
// declares its own templatesRoot independently of the workflow definition, so callers resolving
// initiative templates must pass that root explicitly — healing the other one installs files
// nothing reads.
export async function ensureRepositoryTemplates(root, definition = null, { templatesRoot = null } = {}) {
  const target = templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates';
  assertRelative(target, 'templatesRoot');
  await ensureSecureRepositoryDirectory(root, target, { label: 'Repository templates root' });
  return copyMissingFiles(
    path.join(PACKAGE_ROOT, 'templates', 'artifacts'), path.join(root, target), [], '', root
  );
}

async function copyIfMissing(source, destination, repositoryRoot = null) {
  if (repositoryRoot) {
    await secureRepositoryPath(repositoryRoot, repoRelative(repositoryRoot, destination), {
      label: 'Configuration initialization target'
    });
    await ensureSecureRepositoryDirectory(
      repositoryRoot,
      repoRelative(repositoryRoot, path.dirname(destination)),
      { label: 'Configuration initialization parent' }
    );
  }
  if (existsSync(destination)) {
    return replaceRetiredPackagedFile(source, destination, repositoryRoot);
  }
  if (!repositoryRoot) await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
  return true;
}

/** Refuses a repository that holds only retired `.singularity/` state. */
export function refuseRetiredControlRoot(root) {
  if (!existsSync(path.join(root, CONTROL_ROOT)) && existsSync(path.join(root, LEGACY_CONTROL_ROOT))) {
    throw new SingularityFlowError(`This repository contains unsupported ${LEGACY_CONTROL_ROOT}/ state. Run singularity-flow factory-reset to create a clean current configuration.`, { details: { nextAction: { executable: 'singularity-flow', argv: ['factory-reset', '--dry-run'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
  }
}

export async function initializeDefinition(root) {
  refuseRetiredControlRoot(root);
  const wrote = [];
  for (const [source, destination] of INITIALIZATION_MAPPINGS) {
    if (await copyIfMissing(
      path.join(PACKAGE_ROOT, 'templates', source), path.join(root, destination), root
    )) wrote.push(destination);
  }
  // Directory mappings above are skipped once the destination exists, so re-running init on a
  // repository created by an earlier version would never receive template files added since.
  // Merge in any missing ones without overwriting local edits.
  for (const [source, destination] of [
    ['artifacts', 'singularity/templates'],
    ['starter-packs', 'singularity/templates/starter-packs'],
    ['agents', '.github/agents'],
    ['skill-library', 'singularity/skill-library'],
    ['instruction-library', 'singularity/instruction-library'],
    ['user-defined', 'singularity/user-defined']
  ]) {
    if (wrote.includes(destination)) continue;
    for (const file of await copyMissingFiles(
      path.join(PACKAGE_ROOT, 'templates', source), path.join(root, destination), [], '', root
    )) {
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
  // Read approved configuration through the request-local overlay when the application branch
  // intentionally has no `singularity/` copy. Outside that scope this resolves to `root`, so the
  // ordinary branch-local repair check keeps its existing behavior.
  const definitionRoot = configurationReadRoot(root);
  const expectedFiles = [];
  for (const [source, destination] of INITIALIZATION_MAPPINGS) {
    const absolute = path.join(PACKAGE_ROOT, 'templates', source);
    if ((await readdir(path.dirname(absolute), { withFileTypes: true })).some((entry) => entry.name === path.basename(absolute) && entry.isDirectory())) {
      await initializationFiles(absolute, destination, expectedFiles);
    } else expectedFiles.push(destination);
  }
  expectedFiles.sort();
  const missingFiles = expectedFiles.filter((file) => !existsSync(path.join(definitionRoot, file)));
  let configurationError = null;
  if (existsSync(path.join(definitionRoot, WORKFLOW_PATH))) {
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

/**
 * Initialization status of a canonical Story checkout, judged by its own verified pin.
 *
 * Validate the definition carried by this immutable Story, not today's package inventory. A later
 * SFlow release may add templates or agents, and a Story branch carries only its own workflow's
 * closure: neither makes the exact pin incomplete or authorizes `init --repair` to rewrite its
 * lifecycle input. `pin` is a valid `capabilityDoctorStoryPin` result.
 */
export async function pinnedInitializationStatus(root, pin) {
  const expectedFiles = Object.keys(pin.source?.assets ?? pin.source?.files ?? {}).sort();
  let configurationError = null;
  try {
    await loadDefinition(root);
  } catch (error) {
    configurationError = error.message;
  }
  return {
    schemaVersion: 1,
    pinned: true,
    complete: configurationError == null,
    expectedFiles,
    presentFiles: [...expectedFiles],
    missingFiles: [],
    configurationError
  };
}

/**
 * A phase as one work type runs it: the work type's `phaseOverrides` entry laid over the shared
 * definition. Artifact, world-model and comparison settings merge key by key, and so do approval
 * and generation unless the override names a mode outright; every other field it names replaces
 * the phase's own. Workflow Studio folds an override into a step copied for one workflow with this
 * same rule, so the copy runs exactly as the step it replaces.
 */
export { mergePhaseOverride };

export async function snapshotResolution(root, definition, resolved) {
  const workflow = await secureRepositoryPath(root, WORKFLOW_PATH, {
    label: 'Workflow configuration',
    mustExist: true,
    type: 'file'
  });
  const definitionSnapshot = await snapshot(workflow.absolute);
  const agents = {};
  // Discovery includes optional packaged agents whose workflows are not installed here. A
  // Story's portable selection catalog must contain only agents it can actually use, otherwise
  // capture tries to retain unrelated (and legitimately uninstalled) skills and instructions.
  const phaseIds = new Set(resolved.phases.map((phase) => phase.id));
  const requiredAgents = new Set([
    ...resolved.phases.map((phase) => phase.defaultAgent).filter(Boolean),
    resolved.sourceReview?.mode !== 'off' ? resolved.sourceReview?.reviewerAgent : null
  ].filter(Boolean));
  for (const agent of definition.agentCatalog ?? []) {
    if (agent.phases?.length && !agent.phases.some((id) => phaseIds.has(id))
        && !requiredAgents.has(agent.id)) continue;
    // An APM agent whose file is not the one apm install wrote is not offered to a new Story; it
    // never stops one from starting. Choosing it by name is still refused when it is captured.
    if (agent.apm && agent.apm.state !== 'intact' && !requiredAgents.has(agent.id)) continue;
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
    if (phase.kind === 'skill') continue;
    if (isAgentTemplateReference(phase.template)) {
      templates[phase.id] = await (await import('./agents.mjs')).materializeAgentTemplate(root, phase.template, { phaseId: phase.id });
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
    ...(definition.git?.commitPolicy == null ? {} : { repositoryCommitPolicy: structuredClone(definition.git.commitPolicy) }),
    // The state root is part of the immutable Story contract. Consumers that receive only the
    // workflow aggregate (visual evidence, reference handles, recovery) cannot safely fall back to
    // the product default when a repository selected a different governed location.
    workItemRoot: definition.workItemRoot ?? 'singularity/work-items',
    initiativeRoot: definition.initiativeRoot ?? 'singularity/initiatives',
    templatesRoot: definition.templatesRoot,
    agentPromptsRoot: definition.agentPromptsRoot ?? '.github/agents',
    worldModelOutputDir: 'singularity/world-model',
    governedRoots: [...(definition.governedRoots ?? GOVERNED_ROOTS)],
    inputsMode: resolved.inputsMode ?? configuredInputsMode(definition),
    worldModelGrounding: resolved.worldModelGrounding ?? 'off',
    worldModelMaterialization: null,
    // Prompt assembly is Story policy, not a live repository preference. Capture injection,
    // context, view, and agent-view semantics so a later configuration refresh cannot rewrite an
    // in-flight Story's instructions. Machine provider credentials remain outside this object.
    worldModelPolicy: structuredClone(definition.worldModel ?? {}),
    planning: structuredClone(normalizePlanning(definition.planning ?? {})),
    architectureIntent: structuredClone(resolved.architectureIntent ?? disabledArchitectureIntent()),
    worldModelSourceScope: structuredClone(resolved.worldModelSourceScope ?? null),
    approvalSecurity: structuredClone(resolved.approvalSecurity ?? definition.approvalSecurity),
    approvalAuthorities: structuredClone(resolved.approvalAuthorities
      ?? normalizeApprovalAuthorities(definition.approvalAuthorities, definition.approvalSecurity)),
    sequenceGates: resolved.sequenceGates ?? normalizeSequenceGates(definition.sequenceGates ?? {}),
    contextPolicy: resolved.contextPolicy ?? normalizeContextPolicy(definition.contextPolicy ?? {}, { phaseIds: Object.keys(definition.phases) }),
    tokenEconomy: structuredClone(resolved.tokenEconomy ?? normalizeTokenEconomy(definition.tokenEconomy ?? {})),
    ledger: structuredClone(resolved.ledger ?? normalizeLedgerConfig(definition.ledger ?? {})),
    spec: structuredClone(resolved.spec ?? normalizeSpecPolicy(definition.spec ?? {})),
    sourceReview: structuredClone(resolved.sourceReview ?? { mode: 'off', phases: [], reviewerAgent: null }),
    plannedClaims: structuredClone(resolved.plannedClaims ?? null),
    // The compiled responsibilities of every route, pinned so the evaluator judges this Story by the
    // routes it started with [E2G-005].
    ...(resolved.obligationGraph ? { obligationGraph: pinnedObligationGraph(resolved.obligationGraph) } : {}),
    ...(resolved.phaseSemantics ? { phaseSemantics: structuredClone(resolved.phaseSemantics) } : {}),
    ...(resolved.reworkLoops?.length ? { reworkLoops: structuredClone(resolved.reworkLoops) } : {}),
    // Only when a workflow declares decisions, so every existing Story resolution and its policy
    // digest stay byte-identical.
    ...(resolved.decisions?.length ? { decisions: structuredClone(resolved.decisions) } : {}),
    codeDelivery: structuredClone(resolved.codeDelivery ?? normalizeCodeDeliveryPolicy(definition.codeDelivery ?? {})),
    ...(resolved.applicationReview ? { applicationReview: structuredClone(resolved.applicationReview) } : {}),
    ...(resolved.testRecovery ? { testRecovery: structuredClone(resolved.testRecovery) } : {}),
    // Fault-repair is resolved per workflow just like code delivery. It must be pinned into the
    // Story snapshot; otherwise every later recovery gate silently falls back to product defaults.
    faultRepair: structuredClone(resolved.faultRepair ?? normalizeFaultRepairPolicy(definition.faultRepair ?? {})),
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
    referenceRepositoryPolicy: structuredClone(
      resolved.referenceRepositoryPolicy ?? normalizeReferenceRepositoryPolicy()
    ),
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
  return renderClauseNamespaces(text, '{{WORK_ID}}', variables.id).replaceAll('{{WORK_ID}}', variables.id ?? '');
}

/** Exact same token admission as the renderer, usable before any artifact is written. */
export function validateArtifactTemplateText(sourceText, variables = {}, phaseId = 'captured') {
  const text = normalizeArtifactTemplateCompatibility(sourceText, variables);
  const supported = new Set(Object.values(ARTIFACT_TEMPLATE_TOKENS));
  const unsupported = [...new Set(text.match(/\{\{[^{}\r\n]+\}\}/g) ?? [])].filter((token) => !supported.has(token));
  if (unsupported.length) throw new SingularityFlowError(
    `Artifact template for phase '${phaseId}' contains unsupported token(s): ${unsupported.join(', ')}. Supported tokens: ${[...supported].join(', ')}.`
  );
  return text;
}

export async function renderArtifactTemplate(root, definition, resolvedPhase, variables) {
  let sourceText;
  if (variables.retainedTemplate) {
    const retained = variables.retainedTemplate;
    const expectedSha256 = String(variables.templateSnapshot?.sha256 ?? '').replace(/^sha256:/, '');
    const actualBytes = Buffer.from(String(retained.text ?? ''), 'utf8');
    const actualSha256 = createHash('sha256').update(actualBytes).digest('hex');
    if (!expectedSha256
        || retained.logicalId !== `template:${resolvedPhase.id}`
        || retained.sha256 !== expectedSha256
        || actualSha256 !== expectedSha256
        || retained.bytes !== actualBytes.byteLength) {
      throw new SingularityFlowError(
        `Retained artifact template for phase '${resolvedPhase.id}' does not match this Story's accepted execution closure.`,
        { code: 'WFA_SNAPSHOT_INVALID' }
      );
    }
    sourceText = retained.text;
  } else {
    if (variables.templateSnapshot?.source === 'workflow-snapshot') {
      throw new SingularityFlowError(
        `Saved artifact template for phase '${resolvedPhase.id}' was not retained by the verified Story execution operation.`,
        { code: 'WFA_DEPENDENCY_UNAVAILABLE' }
      );
    }
    const relative = variables.templateSnapshot?.path
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
    sourceText = await readFile(file.absolute, 'utf8');
  }
  return renderArtifactTemplateText(sourceText, resolvedPhase, variables);
}

/**
 * The text a step's template renders to when a Story enters the step: the same token admission,
 * clause namespaces and replacements, from template bytes already read. `workflow check` renders
 * team templates through this so it judges exactly what an author would start from.
 */
export function renderArtifactTemplateText(sourceText, resolvedPhase, variables) {
  let text = renderClauseNamespaces(validateArtifactTemplateText(sourceText, variables, resolvedPhase.id), ARTIFACT_TEMPLATE_TOKENS.workId, variables.id);
  const replacements = {
    [ARTIFACT_TEMPLATE_TOKENS.workId]: variables.id,
    [ARTIFACT_TEMPLATE_TOKENS.workTitle]: variables.title,
    [ARTIFACT_TEMPLATE_TOKENS.workType]: variables.workType,
    [ARTIFACT_TEMPLATE_TOKENS.phaseId]: resolvedPhase.id,
    [ARTIFACT_TEMPLATE_TOKENS.phaseLabel]: resolvedPhase.label,
    [ARTIFACT_TEMPLATE_TOKENS.inputs]: variables.inputs ?? ''
  };
  for (const [token, value] of Object.entries(replacements)) text = text.replaceAll(token, value ?? '');
  return text;
}

export async function agentPrompt(root, definition, agentId) {
  const agent = definition.agents?.[agentId] ?? (await (await import('./agents.mjs')).discoverAgents(root)).find((candidate) => candidate.id === agentId);
  if (!agent) throw new SingularityFlowError(`Unknown agent '${agentId}'.`);
  return agent.prompt;
}
