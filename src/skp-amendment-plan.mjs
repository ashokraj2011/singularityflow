/**
 * Pure dependency projection for a *proposed*, human-reviewed SKP package amendment.
 *
 * The caller must supply the verified accepted Story resolution, not mutable workflow YAML or a
 * live skill folder. This function does not approve an amendment, replace a WFA snapshot, reopen
 * a phase, or authenticate an output receipt. `preservedPhaseIds` means only that the accepted
 * dependency declarations prove no route from the replaced package to that phase. Reusing any
 * preserved bytes still requires the existing immutable receipt and lifecycle owners.
 *
 * Template phases have no SKP read-scope closure. A template after a changed/unknown phase is
 * therefore unknown unless its *declared* input proves it affected; an empty inputs array is not
 * proof that a template read nothing. Unknown is a blocker, never a preservation claim.
 */

import { SingularityFlowError } from './util.mjs';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

function refuse(message) {
  throw new SingularityFlowError(message, { code: 'SKP_AMENDMENT_PLAN_INVALID' });
}

function uniqueIds(value, label) {
  const ids = value instanceof Set ? [...value] : value;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !ID.test(id))
      || new Set(ids).size !== ids.length) {
    refuse(`${label} must be a non-empty set of distinct lower-case IDs.`);
  }
  return ids;
}

function phaseInputs(phase, index, phases, phaseById) {
  const declared = phase.inputs;
  if (!Array.isArray(declared)) return { reason: 'The accepted phase has no explicit input list.', edges: [] };
  const edges = [];
  const seen = new Set();
  for (const input of declared) {
    const sourceId = typeof input === 'string' ? input : input?.phase;
    const source = phaseById.get(sourceId);
    if (!source || phases.indexOf(source) >= index || seen.has(sourceId)) {
      return { reason: 'The accepted phase input order or identity is ambiguous.', edges: [] };
    }
    seen.add(sourceId);
    edges.push({ fromPhase: sourceId, outputId: null, toPhase: phase.id });
  }
  return { edges, reason: null };
}

function skillInputs(phase, index, phases, phaseById) {
  const refs = phase.skillBinding?.bindingRefs;
  if (!refs || !ID.test(String(refs.skill?.id ?? ''))
      || !SHA256.test(String(refs.skill?.packageSha256 ?? ''))
      || !SHA256.test(String(refs.contractSha256 ?? ''))
      || !SHA256.test(String(phase.skillBinding?.compilationSha256 ?? ''))
      || !Array.isArray(refs.inputs)
      || !Array.isArray(refs.outputs) || !refs.readScope
      || typeof refs.readScope.inputs !== 'boolean'
      || !Array.isArray(refs.readScope.sourcePaths)
      || !['artifact-only', 'source-and-artifact'].includes(phase.writeScope)) {
    return { reason: 'The selected skill binding has no complete accepted read/write declaration.', edges: [] };
  }
  if (refs.inputs.length && !refs.readScope.inputs) {
    return { reason: 'The selected skill consumes inputs but its read scope denies them.', edges: [] };
  }
  const declared = phaseInputs(phase, index, phases, phaseById);
  if (declared.reason) return declared;
  const edges = [];
  const seen = new Set();
  for (const input of refs.inputs) {
    const source = phaseById.get(input?.phase);
    const sourceIndex = phases.indexOf(source);
    const key = `${input?.phase}\0${input?.output}`;
    if (!source || sourceIndex < 0 || sourceIndex >= index || seen.has(key)
        || !ID.test(String(input.output ?? '')) || typeof input.path !== 'string'
        || input.state !== 'approved' || typeof input.required !== 'boolean') {
      return { reason: 'The selected skill input has an invalid or ambiguous prior output.', edges: [] };
    }
    seen.add(key);
    const outputs = source.kind === 'skill'
      ? source.skillBinding?.bindingRefs?.outputs
      : [{ id: 'primary', path: source.artifact?.path }];
    if (!Array.isArray(outputs) || outputs.filter((output) =>
      output?.id === input.output && output?.path === input.path).length !== 1) {
      return { reason: 'The selected skill input is not bound to one exact prior output.', edges: [] };
    }
    edges.push({ fromPhase: input.phase, outputId: input.output, toPhase: phase.id });
  }
  const boundPhases = [...new Set(edges.map((edge) => edge.fromPhase))];
  const declaredPhases = declared.edges.map((edge) => edge.fromPhase);
  if (boundPhases.length !== declaredPhases.length
      || boundPhases.some((source, position) => source !== declaredPhases[position])) {
    return { reason: 'The ordinary phase inputs differ from the exact skill input binding.', edges: [] };
  }
  return { edges, reason: null, refs };
}

function immutable(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutable(entry)])));
  }
  return value;
}

/**
 * Return a dependency-only invalidation plan for selected skill-package replacements.
 *
 * `status: blocked` means at least one phase's preservation cannot be proven; the caller must not
 * perform selective reuse from this plan. The conservative lifecycle fallback is a reviewed reopen
 * from the earliest changed phase with fresh downstream publication and approvals.
 */
export function planSkillAmendmentEvidence(resolution, { replacedSkillIds } = {}) {
  const replaced = uniqueIds(replacedSkillIds, 'Replaced skill IDs');
  const phases = resolution?.phases;
  if (!Array.isArray(phases) || !phases.length || phases.length > 256
      || phases.some((phase, index) => !phase || !ID.test(String(phase.id ?? ''))
        || (phase.order != null && phase.order !== index))
      || new Set(phases.map((phase) => phase.id)).size !== phases.length) {
    refuse('The accepted Story resolution must contain one ordered, distinct phase list.');
  }
  const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
  const replacedSet = new Set(replaced);
  const selected = new Set(phases.filter((phase) => phase.kind === 'skill'
    && replacedSet.has(phase.skillBinding?.bindingRefs?.skill?.id))
    .map((phase) => phase.skillBinding.bindingRefs.skill.id));
  const missing = replaced.filter((id) => !selected.has(id));
  if (missing.length) refuse(`No selected accepted phase uses replaced skill(s): ${missing.join(', ')}.`);

  const status = new Map();
  const unknown = [];
  const dependencyEdges = [];
  let changedSource = false;
  let earlierUncertain = false;
  for (const [index, phase] of phases.entries()) {
    const selectedSkill = phase.kind === 'skill';
    const directlyChanged = selectedSkill
      && replacedSet.has(phase.skillBinding?.bindingRefs?.skill?.id);
    const inspected = selectedSkill
      ? skillInputs(phase, index, phases, phaseById)
      : phaseInputs(phase, index, phases, phaseById);
    dependencyEdges.push(...inspected.edges);
    const inputAffected = inspected.edges.some((edge) => status.get(edge.fromPhase) === 'affected');
    const inputUnknown = inspected.edges.some((edge) => status.get(edge.fromPhase) === 'unknown');
    let classification;
    let reason = null;
    if (directlyChanged || inputAffected) classification = 'affected';
    else if (inspected.reason) {
      classification = 'unknown';
      reason = inspected.reason;
    } else if (inputUnknown) {
      classification = 'unknown';
      reason = 'A declared input has unproven amendment lineage.';
    } else if (selectedSkill) {
      if (changedSource && inspected.refs.readScope.sourcePaths.length) {
        classification = 'unknown';
        reason = 'An earlier changed code-producing skill may affect this source-read scope.';
      } else classification = 'preserved';
    } else if (earlierUncertain) {
      // Ordinary template input declarations are not a complete read-scope contract. In
      // particular, an empty list cannot prove that an agent did not read an earlier artifact.
      classification = 'unknown';
      reason = 'A template phase has no complete read-scope proof after changed evidence.';
    } else classification = 'preserved';
    status.set(phase.id, classification);
    // A changed phase is certainly affected, but malformed accepted metadata can still make
    // its *outgoing* dependency/source effects unprovable. Keep it affected and block selective
    // reuse rather than silently treating the direct root as a complete proof.
    if (classification === 'affected' && inspected.reason) reason = inspected.reason;
    if (classification === 'unknown' || reason) unknown.push({ phaseId: phase.id,
      code: 'SKP_AMENDMENT_DEPENDENCY_UNPROVEN', reason });
    if (classification !== 'preserved') earlierUncertain = true;
    if (classification === 'affected' && phase.writeScope === 'source-and-artifact') {
      changedSource = true;
    }
  }
  return immutable({
    schemaVersion: 1,
    resultType: 'skp-amendment-evidence-plan',
    status: unknown.length ? 'blocked' : 'ready',
    assurance: 'dependency-only',
    replacedSkillIds: [...replaced].sort(),
    affectedPhaseIds: phases.filter((phase) => status.get(phase.id) === 'affected').map((phase) => phase.id),
    preservedPhaseIds: phases.filter((phase) => status.get(phase.id) === 'preserved').map((phase) => phase.id),
    unknown,
    dependencyEdges
  });
}
