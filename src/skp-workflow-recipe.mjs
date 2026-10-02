/**
 * Read-only expansion of the SKP authoring recipe using existing configured phase owners.
 *
 * The caller supplies the effective approved definition through the configuration reader. This
 * module does not import skills, authenticate approval, write policy, or grant execution. New
 * skill contracts must already have been compiled/admitted by their configuration owner; local
 * inspection output and skill prose are not accepted in place of those configured phase IDs.
 */
import { assertWorkTypeStartable, resolveWorkType, validateDefinition } from './config.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { validateConfiguredSkillPhase } from './skp-contract.mjs';
import { isSpecificationDefinitionPhase, skillPhasePrimaryOutputRole } from './specifications.mjs';
import { SingularityFlowError } from './util.mjs';

export const SKP_WORKFLOW_RECIPE_FORMAT = 'sflow-skill-workflow-recipe/v1';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAXIMUM_SELECTED_PHASES = 32;

function fail(code, message) {
  throw new SingularityFlowError(message, { code });
}

function requireId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('SKP_RECIPE_INVALID', `${label} must be a lower-case kebab-case ID.`);
  }
  return value;
}

function checkedWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    fail('SKP_RECIPE_INVALID', 'The recipe needs a concrete new team workflow.');
  }
  for (const field of Object.keys(workflow)) {
    if (!['id', 'label', 'description', 'plannedClaims', 'omits'].includes(field)) {
      fail('SKP_RECIPE_INVALID', `Recipe workflow contains unsupported field '${field}'.`);
    }
  }
  const id = requireId(workflow.id, 'Workflow id');
  if (id === 'skills-workflow') {
    fail('SKP_RECIPE_INVALID', 'skills-workflow is an authoring recipe; choose a distinct team work-type ID.');
  }
  if (typeof workflow.label !== 'string' || !workflow.label.trim()
      || (workflow.description !== undefined && typeof workflow.description !== 'string')) {
    fail('SKP_RECIPE_INVALID', 'The team workflow needs a label and a string description when supplied.');
  }
  return { id, label: workflow.label.trim(), description: workflow.description ?? '' };
}

function exactTopology(workflow, phases) {
  const codePhases = phases.filter(phaseRequiresCodeDelivery);
  if (!codePhases.length) {
    if (workflow.plannedClaims !== undefined) {
      fail('SKP_CLAIM_TOPOLOGY_UNRESOLVED', 'A non-code recipe has no code planned-claim topology; omit plannedClaims.');
    }
    return null;
  }
  const policy = workflow.plannedClaims;
  if (!policy || policy.mode !== 'required' || !Array.isArray(policy.clausePhases)
      || !policy.clausePhases.length || !policy.owners || Array.isArray(policy.owners)
      || typeof policy.owners !== 'object') {
    fail('SKP_CLAIM_TOPOLOGY_UNRESOLVED',
      'A code recipe must explicitly select mode required, earlier criterion phases, and a planning owner for every code phase.');
  }
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const firstCode = Math.min(...codePhases.map((phase) => phase.order));
  for (const phaseId of policy.clausePhases) {
    const phase = byId.get(phaseId);
    if (!phase || !isSpecificationDefinitionPhase(phase) || phase.order >= firstCode) {
      fail('SKP_CLAIM_TOPOLOGY_UNRESOLVED',
        `Criterion source '${phaseId}' must be an authoritative selected phase before code delivery.`);
    }
    if (phase.kind === 'skill') {
      const output = phase.skillBinding.bindingRefs.outputs.find((entry) => entry.path === phase.artifact.path);
      if (output.clauses !== 'required' || output.encoding === 'binary') {
        fail('SKP_CLAIM_TOPOLOGY_UNRESOLVED', `Criterion source '${phaseId}' must require textual clauses.`);
      }
    }
  }
  if (Object.keys(policy.owners).length !== codePhases.length
      || Object.keys(policy.owners).some((id) => !codePhases.some((phase) => phase.id === id))) {
    fail('SKP_CLAIM_TOPOLOGY_UNRESOLVED', 'The code recipe must name exactly one planning owner per selected code phase.');
  }
  for (const code of codePhases) {
    const owner = byId.get(policy.owners[code.id]);
    if (!owner || owner.order >= code.order || phaseRequiresCodeDelivery(owner)
        || (owner.kind === 'skill' && skillPhasePrimaryOutputRole(owner) !== 'planning')
        || !policy.clausePhases.some((id) => byId.get(id).order < owner.order)) {
      fail('SKP_CLAIM_TOPOLOGY_UNRESOLVED',
        `Code phase '${code.id}' needs an earlier planning owner after its criterion source.`);
    }
  }
  return structuredClone(policy);
}

/** A candidate preview only. The normal configuration proposal owner applies any eventual edit. */
export function previewSkillWorkflowRecipe({ definition, workflow, phases } = {}) {
  const selected = checkedWorkflow(workflow);
  if (!Array.isArray(phases) || !phases.length || phases.length > MAXIMUM_SELECTED_PHASES) {
    fail('SKP_RECIPE_INVALID', `Select 1-${MAXIMUM_SELECTED_PHASES} concrete skill/catalog phase IDs.`);
  }
  phases.forEach((id) => requireId(id, 'Selected phase'));
  if (new Set(phases).size !== phases.length || phases.some((id) => ['intake', 'conformance'].includes(id))) {
    fail('SKP_RECIPE_INVALID', 'Select unique middle phases; intake and conformance are retained by the recipe.');
  }
  // Validation mutates defaults. Both passes operate on a clone so authoring/Show stay read-only.
  const candidateDefinition = structuredClone(definition);
  validateDefinition(candidateDefinition);
  if (Object.hasOwn(candidateDefinition.workTypes, selected.id)) {
    fail('SKP_RECIPE_INVALID', `Workflow '${selected.id}' already exists; choose a distinct team work-type ID.`);
  }
  const order = ['intake', ...phases, 'conformance'];
  for (const id of order) {
    if (!Object.hasOwn(candidateDefinition.phases, id)) {
      fail('SKP_RECIPE_INVALID', `Recipe phase '${id}' is absent from the effective configuration.`);
    }
  }
  if (!phases.some((id) => candidateDefinition.phases[id].kind === 'skill')) {
    fail('SKP_RECIPE_INVALID', 'Bring my skills requires at least one admitted configured skill phase.');
  }
  const phaseCandidates = order.map((id, index) => ({
    ...candidateDefinition.phases[id], id, order: index
  }));
  for (const id of phases) {
    if (candidateDefinition.phases[id].kind === 'skill') {
      validateConfiguredSkillPhase(candidateDefinition.phases[id], id);
    }
  }
  const topology = exactTopology(workflow, phaseCandidates);
  candidateDefinition.workTypes[selected.id] = {
    label: selected.label, description: selected.description, phases: order,
    ...(topology ? { plannedClaims: topology } : {}),
    // A recipe that leaves a responsibility undone says so, with the group that decides why it does
    // not apply; the obligation compiler checks each entry.
    ...(workflow.omits !== undefined ? { omits: structuredClone(workflow.omits) } : {})
  };
  validateDefinition(candidateDefinition);
  const resolved = assertWorkTypeStartable(resolveWorkType(candidateDefinition, selected.id));
  const codePhases = resolved.phases.filter(phaseRequiresCodeDelivery);
  const core = {
    format: SKP_WORKFLOW_RECIPE_FORMAT,
    recipe: 'skills-workflow', status: 'candidate', workflow: selected,
    sequence: resolved.phases.map((phase) => ({
      id: phase.id, kind: phase.kind ?? 'template',
      ...(phase.kind === 'skill' ? {
        skillId: phase.skillBinding.bindingRefs.skill.id,
        packageSha256: phase.skillBinding.bindingRefs.skill.packageSha256,
        compilationSha256: phase.skillBinding.compilationSha256,
        claimRole: skillPhasePrimaryOutputRole(phase)
      } : {})
    })),
    plannedClaims: resolved.plannedClaims,
    conformance: {
      artifacts: 'pending', checks: 'not-run', humanApproval: 'pending',
      codeTraceability: codePhases.length ? 'pending' : 'not-applicable',
      codePhases: codePhases.map((phase) => phase.id)
    },
    readiness: {
      definition: 'complete', configuration: 'candidate', dependencies: 'not-checked',
      humanAvailability: 'not-checked', host: 'unavailable', execution: 'not-run'
    },
    candidateDefinitionSha256: `sha256:${recordSha256(candidateDefinition)}`
  };
  return JSON.parse(canonicalJson({
    ...core, planSha256: `sha256:${recordSha256(core)}`, candidateDefinition
  }));
}
