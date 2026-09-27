import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import {
  simulateWorkflow, simulationText, WORKFLOW_SIMULATION_CATALOG_LIMITS
} from '../src/workflow-catalog.mjs';

async function repository(t, change = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-installed-simulation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  change(definition, root);
  await writeFile(workflowPath, YAML.stringify(definition));
  return { root, definition: await loadDefinition(root) };
}

async function tree(root, relative = '') {
  const output = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await tree(root, file));
    else output.push([file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]);
  }
  return output.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

test('installed workflow simulation retains the array and phase projection contracts', async (t) => {
  const { root, definition } = await repository(t);
  const before = await tree(root);
  const all = await simulateWorkflow(root);
  assert.ok(Array.isArray(all));
  assert.deepEqual(all.map((entry) => entry.id), Object.keys(definition.workTypes));
  const one = await simulateWorkflow(root, 'feature');
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], all.find((entry) => entry.id === 'feature'));
  const resolved = resolveWorkType(definition, 'feature');
  assert.equal(one[0].label, resolved.label);
  assert.equal(one[0].inputsMode, resolved.inputsMode);
  assert.deepEqual(one[0].documents, resolved.documents);
  assert.deepEqual(one[0].sequenceGates, resolved.sequenceGates);
  assert.deepEqual(one[0].reworkLoops, resolved.reworkLoops ?? []);
  assert.deepEqual(one[0].phases.map((entry) => entry.id), resolved.phases.map((entry) => entry.id));
  for (const [index, phase] of resolved.phases.entries()) {
    const selected = one[0].phases[index];
    assert.equal(selected.order, index + 1);
    assert.equal(selected.label, phase.label);
    assert.equal(selected.template, phase.template);
    assert.deepEqual(selected.inputs, phase.inputs.map((input) => input.phase));
    assert.deepEqual(selected.authorities, phase.approval.authorities);
    assert.equal(selected.minimumApprovals, phase.approval.minimum);
    assert.deepEqual(selected.qualityCommands, phase.qualityCommands ?? []);
    assert.deepEqual(selected.worldModelViews, phase.worldModel?.views ?? []);
    assert.deepEqual(selected.rejectTo, phase.approval.rejectTo);
    assert.deepEqual(selected.repairBudget, phase.repairBudget);
  }
  assert.ok(one[0].lifecycle, 'installed simulation must include the structural lifecycle report');
  assert.equal(one[0].lifecycle.profile, 'story-structural-lifecycle/v1');
  assert.equal(one[0].lifecycle.coverage.phaseCount, resolved.phases.length);
  assert.deepEqual(one[0].lifecycle.effects, { stateChanged: false, filesChanged: false,
    configurationWritten: false, approvalGranted: false, executed: false, modelCalls: 0, externalCalls: 0 });
  assert.ok(one[0].lifecycle.coverage.excluded.includes('human-availability'));
  assert.ok(one[0].lifecycle.coverage.excluded.includes('native-host-enforcement'));
  assert.match(simulationText(one), /Feature \(feature\)/);
  assert.deepEqual(await tree(root), before, 'simulation cannot write an artifact, state, or configuration');
});

test('normalized none approvals do not become phantom human waits and catalog templates resolve to paths', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    value.templates = { ...value.templates, 'simulation-intake': { path: 'common/intake.md' } };
    value.workTypes['simulation-none'] = {
      label: 'Simulation without approval', phases: ['intake'],
      templateOverrides: { intake: 'template:simulation-intake' },
      phaseOverrides: { intake: { inputs: [], approval: 'none' } }
    };
  });
  const [simulation] = await simulateWorkflow(root, 'simulation-none');
  const resolved = resolveWorkType(definition, 'simulation-none');
  assert.equal(simulation.phases[0].template, resolved.phases[0].template);
  assert.equal(simulation.phases[0].template, 'common/intake.md');
  assert.equal(simulation.phases[0].approvalMode, 'none');
  assert.equal(simulation.phases[0].minimumApprovals, 0);
  assert.deepEqual(simulation.phases[0].authorities, []);
  assert.deepEqual(simulation.phases[0].rejectTo, ['intake']);
  assert.equal(simulation.lifecycle.status, 'complete-for-profile');
  assert.equal(simulation.lifecycle.scenarios.some((scenario) => scenario.id === 'human-wait:intake'), false);
});

test('partial phase approval overrides retain inherited authority rather than reporting an empty group', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    value.approvalAuthorities['simulation-reviewers'] = {
      members: [{ email: 'first@example.test' }, { email: 'second@example.test' }]
    };
    value.phases.intake.approval = { authorities: ['simulation-reviewers'], minimum: 1, rejectTo: ['intake'] };
    value.workTypes['simulation-review'] = {
      label: 'Simulation inherited approval', phases: ['intake'],
      phaseOverrides: { intake: { approval: { minimum: 2 } } }
    };
  });
  const [simulation] = await simulateWorkflow(root, 'simulation-review');
  const resolved = resolveWorkType(definition, 'simulation-review');
  assert.deepEqual(simulation.phases[0].authorities, ['simulation-reviewers']);
  assert.equal(simulation.phases[0].minimumApprovals, 2);
  assert.equal(simulation.phases[0].approvalMode, resolved.phases[0].approval.mode);
  assert.deepEqual(simulation.phases[0].rejectTo, resolved.phases[0].approval.rejectTo);
  assert.equal(simulation.lifecycle.status, 'complete-for-profile');
  assert.equal(simulation.lifecycle.scenarios.find((scenario) => scenario.id === 'human-wait:intake').outcome,
    'expected-wait', 'configured human review is a legitimate wait, not an assumed real approval');
});

test('ordinary template artifact paths retain the existing repository-relative contract', async (t) => {
  const { root } = await repository(t, (value) => {
    value.phases.intake.artifact.path = 'notes/intake.md';
    value.workTypes['simulation-relative-path'] = { label: 'Existing relative artifact path',
      phases: ['intake'], phaseOverrides: { intake: { approval: 'none', inputs: [] } } };
  });
  const [simulation] = await simulateWorkflow(root, 'simulation-relative-path');
  assert.equal(simulation.lifecycle.status, 'complete-for-profile');
  assert.deepEqual(simulation.lifecycle.findings, []);
});

test('legacy configuration remains readable without certifying an unmigrated new Story route', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    for (const authority of Object.values(value.approvalAuthorities)) authority.allowAnyGitIdentity = true;
    value.workTypes['legacy-custom'] = structuredClone(value.workTypes['quick-fix']);
    delete value.workTypes['legacy-custom'].plannedClaims;
    delete value.workTypes['quick-fix'].plannedClaims;
  });
  assert.equal(resolveWorkType(definition, 'legacy-custom').plannedClaims.mode, 'migration-required');
  assert.equal(resolveWorkType(definition, 'quick-fix').plannedClaims.mode, 'legacy-opt-out');
  const [unmigrated] = await simulateWorkflow(root, 'legacy-custom');
  assert.notEqual(unmigrated.lifecycle.status, 'complete-for-profile');
  assert.ok(unmigrated.lifecycle.findings.some((finding) => /CLAIM|MIGRATION/.test(finding.code)));
  const [historicalPackaged] = await simulateWorkflow(root, 'quick-fix');
  assert.equal(historicalPackaged.lifecycle.status, 'complete-for-profile');
});

test('an unresolved effective artifact-set promise cannot be certified by a primary-only simulation', async (t) => {
  let value;
  try {
    value = await repository(t, (definition) => {
      definition.workTypes['simulation-missing-set'] = { label: 'Unresolved effective bundle',
        phases: ['intake'], phaseOverrides: { intake: { approval: 'none', artifactSet: 'missing' } } };
    });
  } catch (error) {
    // Earlier refusal by the configuration owner is equally valid; a silently ignored promise is not.
    assert.match(error.message, /artifact.?set/i);
    return;
  }
  const [simulation] = await simulateWorkflow(value.root, 'simulation-missing-set');
  assert.notEqual(simulation.lifecycle.status, 'complete-for-profile');
  assert.ok(simulation.lifecycle.findings.some((finding) => /ARTIFACT.*SET|BUNDLE/.test(finding.code)));
});

test('installed bounded rework uses normalized target budget and reports full-range invalidation', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    for (const authority of Object.values(value.approvalAuthorities)) authority.allowAnyGitIdentity = true;
    value.workTypes['simulation-rework'] = {
      label: 'Bounded existing rework', phases: ['intake', 'implementation', 'verification'],
      phaseOverrides: {
        implementation: { generation: { task: 'analyze' }, inputs: ['intake'] },
        verification: { inputs: ['implementation'] }
      }, reworkLoops: [{ from: 'verification', to: 'implementation', maxAttempts: 2, resetOnPhase: 'intake' }]
    };
  });
  const [simulation] = await simulateWorkflow(root, 'simulation-rework');
  const resolved = resolveWorkType(definition, 'simulation-rework');
  assert.deepEqual(simulation.reworkLoops, resolved.reworkLoops);
  assert.deepEqual(simulation.phases[1].repairBudget, { maxAttempts: 2, resetOnPhase: 'intake' });
  assert.equal(simulation.lifecycle.status, 'complete-for-profile');
  const rework = simulation.lifecycle.scenarios.find((scenario) => scenario.id === 'rework:verification:implementation');
  assert.equal(rework.outcome, 'expected-transition');
  assert.deepEqual(rework.affectedPhases, ['implementation', 'verification']);
  const exhaustion = simulation.lifecycle.scenarios.find((scenario) => scenario.id === 'rework-budget-exhaustion:verification:implementation');
  assert.equal(exhaustion.stateUnchanged, true);
  assert.ok(exhaustion.events.some((event) => event.disposition === 'refused-budget-exhausted'));
  assert.equal(simulation.lifecycle.scenarios.find((scenario) => scenario.id === 'budget-reset:verification:implementation').outcome,
    'expected-transition');
});

test('configured quality commands remain inert during simulation', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    value.workTypes['simulation-inert'] = {
      label: 'Simulation inert command', phases: ['intake'], phaseOverrides: { intake: {
        approval: 'none', qualityCommands: [{ id: 'must-not-run', modelPolicy: 'never', kind: 'other',
          argv: [process.execPath, '-e', 'require("node:fs").writeFileSync("SIMULATION_EXECUTED", "forbidden")'] }]
      } }
    };
  });
  const before = await tree(root);
  const [simulation] = await simulateWorkflow(root, 'simulation-inert');
  assert.deepEqual(simulation.phases[0].qualityCommands,
    resolveWorkType(definition, 'simulation-inert').phases[0].qualityCommands);
  assert.deepEqual(await tree(root), before);
});

test('unknown installed workflow selection refuses visibly and leaves configuration unchanged', async (t) => {
  const { root } = await repository(t);
  const before = await tree(root);
  await assert.rejects(() => simulateWorkflow(root, 'not-installed'), /Unknown workflow 'not-installed'/);
  assert.deepEqual(await tree(root), before);
});

function repeatFeatureCatalog(definition, count) {
  const feature = definition.workTypes.feature;
  for (const authority of Object.values(definition.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  definition.workTypes = Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `catalog-feature-${String(index).padStart(2, '0')}`, structuredClone(feature)
  ]));
}

function catalogLimit(error) {
  assert.equal(error.code, 'WCA_SIMULATION_LIMIT');
  assert.match(error.message, /singularity-flow workflow simulate <WORKFLOW-ID> --json/);
  assert.match(error.message, /\/sf-workflows simulate <WORKFLOW-ID> --json/);
  assert.match(error.message, /no partial catalog/i);
  return true;
}

test('simulate-all refuses a catalog above the workflow count bound while exact selection remains available', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    repeatFeatureCatalog(value, WORKFLOW_SIMULATION_CATALOG_LIMITS.workflows + 1);
  });
  assert.equal(Object.keys(definition.workTypes).length, WORKFLOW_SIMULATION_CATALOG_LIMITS.workflows + 1);
  const before = await tree(root);
  let catalog;
  await assert.rejects(async () => { catalog = await simulateWorkflow(root); }, catalogLimit);
  assert.equal(catalog, undefined, 'no prefix of the over-budget catalog may be returned as success');
  const selected = await simulateWorkflow(root, 'catalog-feature-00');
  assert.deepEqual(selected.map((entry) => entry.id), ['catalog-feature-00']);
  assert.equal(selected[0].lifecycle.status, 'complete-for-profile');
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) < WORKFLOW_SIMULATION_CATALOG_LIMITS.outputBytes);
  assert.deepEqual(await tree(root), before);
});

test('simulate-all refuses aggregate bytes above the bound without truncating otherwise valid workflows', async (t) => {
  const { root, definition } = await repository(t, (value) => {
    repeatFeatureCatalog(value, WORKFLOW_SIMULATION_CATALOG_LIMITS.workflows);
  });
  assert.equal(Object.keys(definition.workTypes).length, WORKFLOW_SIMULATION_CATALOG_LIMITS.workflows,
    'the fixture must not trigger the earlier count guard');
  const before = await tree(root);
  const selected = await simulateWorkflow(root, 'catalog-feature-00');
  assert.equal(selected[0].lifecycle.status, 'complete-for-profile');
  // All IDs have the same byte length and all 64 definitions have the same valid feature policy.
  // Per-workflow source hashes differ, but their fixed-size digest representation does not shrink.
  const rowBytes = Buffer.byteLength(JSON.stringify(selected[0]));
  assert.ok(rowBytes < WORKFLOW_SIMULATION_CATALOG_LIMITS.outputBytes);
  assert.ok(rowBytes * WORKFLOW_SIMULATION_CATALOG_LIMITS.workflows
    > WORKFLOW_SIMULATION_CATALOG_LIMITS.outputBytes, 'valid rows must naturally exceed the aggregate byte budget');
  let catalog;
  await assert.rejects(async () => { catalog = await simulateWorkflow(root); }, catalogLimit);
  assert.equal(catalog, undefined, 'byte overflow must not acknowledge a truncated successful catalog');
  assert.deepEqual((await simulateWorkflow(root, 'catalog-feature-63')).map((entry) => entry.id), ['catalog-feature-63']);
  assert.deepEqual(await tree(root), before);
});
