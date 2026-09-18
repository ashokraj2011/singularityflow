import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { consumeRepairAttempt, repairBudgetPhaseForRejection } from '../src/repair-budget.mjs';
import { installWorkflow, simulateWorkflow, workflowCatalog } from '../src/workflow-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const WORK_TYPE = 'spec-code-test-loop';
const PHASES = ['specification', 'implementation', 'testing', 'conformance'];

async function packaged() {
  return YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Spec Code Test Reviewer' }
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test('spec-code-test-loop pins a distinct spec, Code, Playwright review, and conformance contract', async () => {
  const definition = validateDefinition(await packaged());
  const profile = definition.workTypes[WORK_TYPE];
  const phases = resolveWorkType(definition, WORK_TYPE).phases;
  assert.deepEqual(profile.phases, PHASES);
  assert.deepEqual(phases.map((phase) => phase.label), [
    'Specification', 'Code', 'Playwright testing review', 'Spec, code and test checking'
  ]);
  assert.equal(profile.spec.mode, 'enforce');
  assert.deepEqual(profile.plannedClaims, {
    mode: 'required', clausePhases: ['specification'], owners: { implementation: 'specification' }
  });
  assert.deepEqual(profile.documents.allowedPhases, ['specification']);
  assert.equal(phaseRequiresCodeDelivery(phases[1]), true);
  assert.deepEqual(phases.slice(1).map((phase) => phase.inputs.map((input) => input.phase)), [
    ['specification'], ['specification', 'implementation'],
    ['specification', 'implementation', 'testing']
  ]);
  assert.deepEqual(phases.slice(2).map((phase) => phase.testEvidenceFrom), [
    'implementation', 'implementation'
  ]);
  assert.ok(phases.slice(2).every((phase) => phase.writeScope === 'artifact-only'));
  assert.deepEqual(phases[2].mcp.requiredServers, ['playwright']);
  assert.equal(phases[2].mcp.requireSmoke, true);
  assert.deepEqual(phases[2].mcp.evidence.map(({ tool }) => tool), [
    'browser_navigate', 'browser_snapshot', 'browser_take_screenshot'
  ]);
  assert.deepEqual(phases[1].repairBudget, { maxAttempts: 3, resetOnPhase: 'specification' });
  assert.equal(phases[2].repairBudget, null);
  assert.deepEqual(phases[2].approval.rejectTo, ['specification', 'implementation', 'testing']);
  assert.ok(phases[3].approval.rejectTo.includes('specification'));
  assert.equal(phases[2].qualityCommands.length, 0,
    'MCP observations must not be represented as independent structured test execution');

  const classic = resolveWorkType(definition, 'classic-delivery').phases;
  assert.deepEqual(classic.map((phase) => phase.id), ['intake', 'implementation', 'testing', 'conformance']);
  assert.deepEqual(classic[2].mcp.requiredServers, [],
    'the new work type must not make Classic Delivery require Playwright');
});

test('Testing to Code consumes the bounded repair budget, while Testing-only review does not', async () => {
  const definition = validateDefinition(await packaged());
  const resolution = resolveWorkType(definition, WORK_TYPE);
  const phases = resolution.phases;
  const workflow = {
    resolution,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, {
      ...phase, generation: 1, validationVerdict: 'passed'
    }]))
  };
  const testing = workflow.phases.testing;
  assert.equal(repairBudgetPhaseForRejection(workflow, testing, 'testing'), null);
  const code = repairBudgetPhaseForRejection(workflow, testing, 'implementation');
  assert.equal(code?.id, 'implementation');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const receipt = consumeRepairAttempt(workflow, code, {
      targetPhase: 'implementation', actor: { email: 'reviewer@example.test' },
      at: `2026-09-18T00:00:0${attempt}.000Z`, changeRequestId: `CR-00${attempt}`
    });
    assert.equal(receipt.attempts.length, attempt);
  }
  assert.throws(() => consumeRepairAttempt(workflow, code, {
    targetPhase: 'implementation', actor: { email: 'reviewer@example.test' },
    at: '2026-09-18T00:00:04.000Z', changeRequestId: 'CR-004'
  }), (error) => error.code === 'REPAIR_BUDGET_EXHAUSTED');
});

test('spec-code-test-loop refuses a Playwright requirement when its phase is not allowlisted', async () => {
  const definition = await packaged();
  definition.mcpServers.playwright.phases = definition.mcpServers.playwright.phases
    .filter((phase) => phase !== 'testing');
  assert.throws(() => validateDefinition(definition),
    /requires MCP server 'playwright'.*not allowed in the phase/);
});

test('new and refreshed repositories receive the versioned workflow and honest review templates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-code-test-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  const phases = resolveWorkType(definition, WORK_TYPE).phases;
  assert.deepEqual(phases.map((phase) => phase.id), PHASES);
  assert.deepEqual(phases.map((phase) => phase.defaultAgent), [
    'product-owner', 'developer', 'qa', 'qa'
  ]);
  const specificationTemplate = await readFile(path.join(root, definition.templatesRoot, phases[0].template), 'utf8');
  for (const heading of ['Actors', 'User scenarios', 'Requirements', 'Planned implementation evidence']) {
    assert.ok(specificationTemplate.includes(`## ${heading}\n`), `Specification lacks '${heading}'`);
  }
  assert.match(specificationTemplate, /\| Clause \| Expected paths \| Planned tests \|/);
  assert.equal((await workflowCatalog(root)).find((entry) => entry.id === WORK_TYPE).status, 'current');
  const simulation = (await simulateWorkflow(root, WORK_TYPE))[0];
  assert.deepEqual(simulation.reworkLoops, [{ from: 'testing', to: 'implementation',
    maxAttempts: 3, resetOnPhase: 'specification' }]);
  assert.deepEqual(simulation.phases.map((phase) => phase.label), [
    'Specification', 'Code', 'Playwright testing review', 'Spec, code and test checking'
  ]);
  for (const phase of phases.slice(2)) {
    const template = await readFile(path.join(root, definition.templatesRoot, phase.template), 'utf8');
    for (const heading of phase.artifact.validation.requiredHeadings) {
      assert.ok(template.includes(`## ${heading}\n`), `${phase.id} template lacks '${heading}'`);
    }
    assert.match(template, /structured (?:Code )?test (?:receipt|execution|result)/i);
  }
  const testingTemplate = await readFile(path.join(root, definition.templatesRoot, phases[2].template), 'utf8');
  assert.match(testingTemplate, /observation only/i);
  assert.match(testingTemplate, /Do not edit source in Testing/i);

  const old = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  delete old.workTypes[WORK_TYPE];
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(old));
  assert.equal((await workflowCatalog(root)).find((entry) => entry.id === WORK_TYPE).status, 'available');
  await installWorkflow(root, WORK_TYPE);
  assert.deepEqual(resolveWorkType(await loadDefinition(root), WORK_TYPE).phases.map((phase) => phase.id), PHASES);
});

test('a new Story pins the specification-first workflow and routes its next step to generation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-code-story-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Spec Code Test Reviewer'], root);
  run('git', ['config', 'user.email', 'spec-code@example.test'], root);
  run(process.execPath, [CLI, '--no-model', 'init'], root);
  await writeFile(path.join(root, 'README.md'), 'Spec-code-test Story fixture.\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize spec-code-test fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);

  run(process.execPath, [CLI, '--no-model', 'start', 'SPEC-CODE-1',
    '--from-branch', 'main', '--work-type', WORK_TYPE,
    '--title', 'Exercise spec-code-test loop', '--description', 'Review one browser behavior.'], root);
  const workflow = JSON.parse(await readFile(path.join(root,
    'singularity/work-items/SPEC-CODE-1/workflow.json'), 'utf8'));
  assert.deepEqual(workflow.phaseOrder, PHASES);
  assert.equal(workflow.currentPhase, 'specification');
  assert.equal(workflow.phases.specification.status, 'in_progress');
  assert.equal(workflow.resolution.plannedClaims.owners.implementation, 'specification');
  assert.deepEqual(workflow.resolution.reworkLoops, [{ from: 'testing', to: 'implementation',
    maxAttempts: 3, resetOnPhase: 'specification' }]);
  assert.deepEqual(workflow.resolution.phases.find((phase) => phase.id === 'testing').mcp.requiredServers,
    ['playwright']);
  const next = run(process.execPath, [CLI, '--no-model', 'nextsteps', '--json'], root);
  assert.match(next, /specification/);
});
