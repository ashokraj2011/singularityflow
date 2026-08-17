import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { installWorkflow } from '../src/workflow-catalog.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PHASES = [
  'poc-intake',
  'poc-impact-analysis',
  'poc-ui-exploration',
  'poc-test-generation',
  'poc-validation',
  'poc-publication-review'
];

async function starter() {
  return YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
}

test('the packaged POC workflow is isolated, ordered, and fully governed', async () => {
  const definition = await starter();
  validateDefinition(definition);

  const profile = definition.workTypes['poc-workflow'];
  assert.equal(profile.label, 'POC workflow');
  assert.deepEqual(profile.phases, PHASES);

  for (const [id, other] of Object.entries(definition.workTypes)) {
    if (id === 'poc-workflow') continue;
    assert.deepEqual(other.phases.filter((phase) => PHASES.includes(phase)), [],
      `POC policy leaked into packaged workflow '${id}'`);
  }

  const resolved = resolveWorkType(definition, 'poc-workflow');
  for (const [index, phase] of resolved.phases.entries()) {
    assert.equal(phase.id, PHASES[index]);
    assert.ok(phase.inputs.every((input) => PHASES.indexOf(input.phase) < index),
      `${phase.id} consumes a phase that does not precede it`);
    assert.match(phase.template, /^poc-workflow\/.+\.md$/);
  }

  assert.equal(resolved.phases.find((phase) => phase.id === 'poc-ui-exploration').writeScope, 'artifact-only');
  assert.equal(resolved.phases.find((phase) => phase.id === 'poc-test-generation').writeScope, 'source-and-artifact');
  assert.deepEqual(
    resolved.phases.find((phase) => phase.id === 'poc-validation').approval.rejectTo,
    ['poc-intake', 'poc-ui-exploration', 'poc-test-generation', 'poc-validation']
  );
  const exploration = resolved.phases.find((phase) => phase.id === 'poc-ui-exploration');
  const validation = resolved.phases.find((phase) => phase.id === 'poc-validation');
  assert.deepEqual(exploration.mcp.requiredServers, ['playwright']);
  assert.equal(exploration.mcp.requireSmoke, true);
  assert.deepEqual(validation.repairBudget, { maxAttempts: 2, resetOnPhase: 'poc-intake' });
  assert.ok(validation.qualityCommands.some((command) => command.id === 'typescript-compile'));
  assert.ok(validation.qualityCommands.some((command) => command.id === 'playwright-tests'));
  const publication = resolved.phases.find((phase) => phase.id === 'poc-publication-review');
  assert.equal(publication.approval.minimum, 2);
  assert.deepEqual(publication.approval.authorities, ['quality-reviewers', 'engineering-reviewers']);
});

test('POC browser access is allowlisted, confirmed, and evidence-capturing', async () => {
  const definition = await starter();
  const playwright = validateDefinition(definition).mcpServers.playwright;

  assert.ok(playwright.agents.includes('poc-automation'));
  assert.ok(playwright.phases.includes('poc-ui-exploration'));
  assert.ok(playwright.phases.includes('poc-validation'));
  for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill_form',
    'browser_hover', 'browser_press_key', 'browser_resize', 'browser_take_screenshot']) {
    assert.ok(playwright.tools.includes(tool), `${tool} is not allowlisted`);
  }
  assert.equal(playwright.approval, 'confirm');
  assert.deepEqual(playwright.evidence, { captureToolCalls: true, captureResults: true });
});

test('fresh initialization activates the dedicated POC agent and ships every template', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const definition = await loadDefinition(root);
  const resolved = resolveWorkType(definition, 'poc-workflow');

  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), [
    'poc-analyst', 'poc-analyst', 'poc-explorer', 'poc-test-developer', 'poc-validator', 'poc-validator'
  ]);
  for (const phase of resolved.phases) {
    const template = await readFile(path.join(root, definition.templatesRoot, phase.template), 'utf8');
    for (const heading of definition.phases[phase.id].artifact.validation.requiredHeadings) {
      assert.match(template, new RegExp(`^## ${heading}$`, 'm'), `${phase.id} template is missing '${heading}'`);
    }
  }
});

test('the repair and publication templates refuse autonomous success', async () => {
  const validation = await readFile(path.join(ROOT, 'templates/artifacts/poc-workflow/validation.md'), 'utf8');
  const publication = await readFile(path.join(ROOT, 'templates/artifacts/poc-workflow/publication-review.md'), 'utf8');
  const agent = await readFile(path.join(ROOT, 'templates/agents/poc-automation.agent.md'), 'utf8');
  const validator = await readFile(path.join(ROOT, 'templates/agents/poc-validator.agent.md'), 'utf8');

  assert.match(validation, /maximum two human-authorized attempts/i);
  assert.match(validation, /Do not retry automatically/i);
  assert.match(agent, /Never start a retry yourself/i);
  assert.match(agent, /--target-url/);
  assert.match(validator, /mcp record playwright/);
  assert.match(validator, /--target-url/);
  assert.match(publication, /does not create a pull request/i);
  assert.match(publication, /never\s+write or force-update the selected base/i);
  assert.doesNotMatch(`${validation}\n${publication}\n${agent}`, /failed payment|retry a payment/i);
});

test('catalog installation upgrades an older repository with POC agents and MCP routing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);

  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const old = YAML.parse(await readFile(workflowPath, 'utf8'));
  delete old.workTypes['poc-workflow'];
  for (const phase of PHASES) delete old.phases[phase];
  old.mcpServers.playwright.agents = old.mcpServers.playwright.agents.filter((agent) => agent !== 'poc-automation');
  old.mcpServers.playwright.phases = old.mcpServers.playwright.phases.filter((phase) => !PHASES.includes(phase));
  old.mcpServers.playwright.tools = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_take_screenshot'];
  await writeFile(workflowPath, YAML.stringify(old));
  await rm(path.join(root, '.github/agents/poc-automation.agent.md'));
  for (const agent of ['poc-analyst', 'poc-explorer', 'poc-test-developer', 'poc-validator']) {
    await rm(path.join(root, `.github/agents/${agent}.agent.md`));
  }
  await rm(path.join(root, 'singularity/templates/poc-workflow'), { recursive: true });

  const result = await installWorkflow(root, 'poc-workflow');
  for (const agent of ['poc-analyst', 'poc-explorer', 'poc-test-developer', 'poc-validator']) {
    assert.ok(result.files.includes(`.github/agents/${agent}.agent.md`));
  }
  const upgraded = await loadDefinition(root);
  const resolved = resolveWorkType(upgraded, 'poc-workflow');
  assert.ok(upgraded.mcpServers.playwright.phases.includes('poc-ui-exploration'));
  assert.ok(upgraded.mcpServers.playwright.tools.includes('browser_fill_form'));
  assert.ok(upgraded.mcpServers.playwright.agents.includes('poc-explorer'));
  assert.ok(upgraded.mcpServers.playwright.agents.includes('poc-validator'));
  assert.deepEqual(resolved.phases.map((phase) => phase.defaultAgent), [
    'poc-analyst', 'poc-analyst', 'poc-explorer', 'poc-test-developer', 'poc-validator', 'poc-validator'
  ]);
});
