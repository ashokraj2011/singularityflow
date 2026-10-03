import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { isConvergencePhase } from '../src/phase-roles.mjs';

/**
 * The packaged definition with every step renamed everywhere a workflow refers to it, so nothing
 * the product decides can hang on a step's name [E2G-001, E2G-032].
 */
function renameEveryStep(definition, rename) {
  const renamed = structuredClone(definition);
  const ids = new Set(Object.keys(definition.phases));
  const id = (value) => (typeof value === 'string' && ids.has(value) ? rename(value) : value);
  const list = (value) => (Array.isArray(value) ? value.map(id) : value);
  const input = (entry) => (typeof entry === 'string' ? id(entry) : entry && typeof entry === 'object' ? { ...entry, phase: id(entry.phase) } : entry);
  const rekey = (map) => (map && typeof map === 'object' ? Object.fromEntries(Object.entries(map).map(([key, value]) => [id(key), value])) : map);
  const references = (phase) => {
    if (!phase || typeof phase !== 'object') return;
    if (Array.isArray(phase.inputs)) phase.inputs = phase.inputs.map(input);
    if (Array.isArray(phase.approval?.rejectTo)) phase.approval.rejectTo = list(phase.approval.rejectTo);
    if (phase.testEvidenceFrom) phase.testEvidenceFrom = id(phase.testEvidenceFrom);
    if (phase.repairBudget?.resetOnPhase) phase.repairBudget = { ...phase.repairBudget, resetOnPhase: id(phase.repairBudget.resetOnPhase) };
  };
  renamed.phases = rekey(renamed.phases);
  Object.values(renamed.phases).forEach(references);
  for (const server of Object.values(renamed.mcpServers ?? {})) server.phases = list(server.phases);
  if (Array.isArray(renamed.documents?.allowedPhases)) renamed.documents.allowedPhases = list(renamed.documents.allowedPhases);
  for (const key of ['allowedPhases', 'blockRequiredUnfulfilledAt']) {
    if (Array.isArray(renamed.architectureIntent?.[key])) renamed.architectureIntent[key] = list(renamed.architectureIntent[key]);
  }
  for (const workType of Object.values(renamed.workTypes)) {
    workType.phases = list(workType.phases);
    workType.templateOverrides = rekey(workType.templateOverrides);
    workType.phaseOverrides = rekey(workType.phaseOverrides);
    Object.values(workType.phaseOverrides ?? {}).forEach(references);
    for (const verb of Object.values(workType.fastPath ?? {})) if (Array.isArray(verb?.phases)) verb.phases = list(verb.phases);
    if (Array.isArray(workType.reworkLoops)) {
      workType.reworkLoops = workType.reworkLoops.map((loop) => ({ ...loop, from: id(loop.from), to: id(loop.to), ...(loop.resetOnPhase ? { resetOnPhase: id(loop.resetOnPhase) } : {}) }));
    }
    if (Array.isArray(workType.sourceReview?.phases)) workType.sourceReview.phases = list(workType.sourceReview.phases);
    if (Array.isArray(workType.documents?.allowedPhases)) workType.documents.allowedPhases = list(workType.documents.allowedPhases);
    if (workType.designSources?.capturePhase) workType.designSources.capturePhase = id(workType.designSources.capturePhase);
    if (Array.isArray(workType.designSources?.consumeIn)) workType.designSources.consumeIn = list(workType.designSources.consumeIn);
    if (workType.plannedClaims) {
      workType.plannedClaims.clausePhases = list(workType.plannedClaims.clausePhases);
      if (workType.plannedClaims.owners) {
        workType.plannedClaims.owners = Object.fromEntries(Object.entries(workType.plannedClaims.owners).map(([key, value]) => [id(key), id(value)]));
      }
    }
    for (const decision of workType.decisions ?? []) {
      decision.after = id(decision.after);
      for (const route of decision.routes ?? []) { if (route.to) route.to = id(route.to); }
    }
  }
  return renamed;
}

const rename = (value) => `renamed-${value}`;

test('every packaged workflow starts, and a copy with every step renamed resolves to the same obligations and roles [E2G-032]', async () => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const original = validateDefinition(structuredClone(definition));
  const renamed = validateDefinition(renameEveryStep(definition, rename));
  const workTypes = Object.keys(definition.workTypes).sort();
  assert.ok(workTypes.length >= 10, `the packaged catalog shrank to ${workTypes.length} work types`);
  for (const workTypeId of workTypes) {
    const left = resolveWorkType(original, workTypeId);
    const right = resolveWorkType(renamed, workTypeId);
    // Every packaged workflow guarantees each responsibility on every route, or omits it with a reason.
    assert.doesNotThrow(() => assertWorkTypeStartable(left), `${workTypeId} cannot start a Story`);
    assert.doesNotThrow(() => assertWorkTypeStartable(right), `renamed ${workTypeId} cannot start a Story`);
    assert.equal(right.obligationGraph.shapeDigest, left.obligationGraph.shapeDigest, `${workTypeId}: renaming changed the obligations`);
    assert.deepEqual(right.obligationGraph.findings.map(({ code, severity }) => [code, severity]),
      left.obligationGraph.findings.map(({ code, severity }) => [code, severity]), `${workTypeId}: renaming changed the findings`);
    assert.deepEqual(right.phases.map((phase) => phase.id), left.phases.map((phase) => rename(phase.id)));
    for (const [index, phase] of left.phases.entries()) {
      const other = right.phases[index];
      const label = `${workTypeId}/${phase.id}`;
      assert.equal(phaseRequiresCodeDelivery(other), phaseRequiresCodeDelivery(phase), `${label}: code delivery follows the name`);
      assert.equal(isConvergencePhase(other), isConvergencePhase(phase), `${label}: convergence follows the name`);
      assert.deepEqual(other.approval?.rejectTo ?? other.approvalPolicy?.rejectTo ?? null,
        (phase.approval?.rejectTo ?? phase.approvalPolicy?.rejectTo ?? null)?.map(rename) ?? null, `${label}: its returns changed`);
    }
    assert.equal(right.plannedClaims?.mode ?? null, left.plannedClaims?.mode ?? null, `${workTypeId}: planned-claim mode changed`);
    assert.deepEqual(right.plannedClaims?.clausePhases ?? [], (left.plannedClaims?.clausePhases ?? []).map(rename));
    assert.deepEqual(right.plannedClaims?.owners ?? {}, Object.fromEntries(Object.entries(left.plannedClaims?.owners ?? {}).map(([code, owner]) => [rename(code), rename(owner)])));
  }
});
