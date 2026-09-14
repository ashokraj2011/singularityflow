import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { installWorkflow } from '../src/workflow-catalog.mjs';

// URL.pathname leaves spaces percent-encoded, so the suite failed in otherwise valid checkouts
// such as `Downloads/package 2`. Convert the file URL through Node's platform-safe filesystem API.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const PHASES = [
  'poc-intake',
  'poc-impact-analysis',
  'poc-ui-exploration',
  'poc-test-generation',
  'poc-validation',
  'poc-publication-review'
];

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function removePocWorkflow(root) {
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const old = YAML.parse(await readFile(workflowPath, 'utf8'));
  delete old.workTypes['poc-workflow'];
  for (const phase of PHASES) delete old.phases[phase];
  old.mcpServers.playwright.agents = old.mcpServers.playwright.agents
    .filter((agent) => !['poc-automation', 'poc-explorer', 'poc-validator'].includes(agent));
  old.mcpServers.playwright.phases = old.mcpServers.playwright.phases
    .filter((phase) => !PHASES.includes(phase));
  old.mcpServers.playwright.tools = [
    'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_take_screenshot'
  ];
  await writeFile(workflowPath, YAML.stringify(old));
  for (const agent of [
    'poc-analyst', 'poc-automation', 'poc-explorer', 'poc-test-developer', 'poc-validator'
  ]) await rm(path.join(root, `.github/agents/${agent}.agent.md`));
  await rm(path.join(root, 'singularity/templates/poc-workflow'), { recursive: true });
}

async function starter() {
  return YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
}

test('the packaged POC workflow is isolated, ordered, and fully governed', async () => {
  const definition = await starter();
  validateDefinition(definition);

  const profile = definition.workTypes['poc-workflow'];
  assert.equal(profile.label, 'POC workflow — enterprise Playwright');
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
  assert.equal(resolved.phases.find((phase) => phase.id === 'poc-test-generation').sourceBoundary, 'test-automation');
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
  assert.equal(validation.sourceBoundary, 'test-automation');
  const publication = resolved.phases.find((phase) => phase.id === 'poc-publication-review');
  assert.equal(publication.approval.minimum, 1);
  assert.deepEqual(publication.approval.authorities, ['quality-reviewers', 'engineering-reviewers']);
  assert.deepEqual(publication.approval.requiredAuthorities, ['quality-reviewers']);
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

test('legacy init keeps exact packaged POC agents dormant and edited repository agents strict', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-legacy-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'poc-init@example.com');
  git(root, 'config', 'user.name', 'POC Init');
  await initializeDefinition(root);
  await removePocWorkflow(root);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'old configuration without the optional POC workflow');

  const machine = path.join(root, '.test-machine');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'lead-registry.json')
  };
  const repaired = spawnSync(process.execPath, [CLI, 'init', '--repair'], {
    cwd: root,
    encoding: 'utf8',
    env
  });
  assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);

  const definition = await loadDefinition(root);
  assert.equal(definition.workTypes['poc-workflow'], undefined);
  assert.equal(definition.phases['poc-intake'], undefined);
  const analyst = definition.agentCatalog.find((agent) => agent.id === 'poc-analyst');
  assert.ok(analyst, 'init --repair should have installed the missing packaged agent');
  assert.equal(analyst.scope, 'repository', 'the public repository ownership contract must not change');
  assert.equal(Object.hasOwn(analyst, 'packagedCopy'), false, 'package provenance stays private');

  const analystPath = path.join(root, '.github/agents/poc-analyst.agent.md');
  const customized = (await readFile(analystPath, 'utf8'))
    .replaceAll('poc-intake', 'poc-intake-typo');
  await writeFile(analystPath, customized);
  await assert.rejects(
    loadDefinition(root),
    (error) => error?.code === 'AGENT_PHASE_UNKNOWN'
      && error?.details?.agentId === 'poc-analyst'
      && error?.details?.phaseId === 'poc-intake-typo'
      && error?.details?.source === '.github/agents/poc-analyst.agent.md'
  );

});

test('the repair and publication templates refuse autonomous success', async () => {
  const validation = await readFile(path.join(ROOT, 'templates/artifacts/poc-workflow/validation.md'), 'utf8');
  const publication = await readFile(path.join(ROOT, 'templates/artifacts/poc-workflow/publication-review.md'), 'utf8');
  const agent = await readFile(path.join(ROOT, 'templates/agents/poc-automation.agent.md'), 'utf8');
  const validator = await readFile(path.join(ROOT, 'templates/agents/poc-validator.agent.md'), 'utf8');

  assert.match(validation, /maximum two human-authorized attempts/i);
  assert.match(validation, /Do not retry automatically/i);
  assert.match(agent, /Never start a retry yourself/i);
  assert.match(agent, /mcp smoke playwright --url/);
  assert.match(agent, /never manually declare `browser_navigate`/i);
  assert.match(validator, /mcp record playwright/);
  assert.match(validator, /mcp smoke playwright --url/);
  assert.match(validator, /Do not manually record `browser_navigate`/i);
  assert.match(publication, /does not create a pull request/i);
  assert.match(publication, /never\s+write or force-update the selected base/i);
  assert.doesNotMatch(`${validation}\n${publication}\n${agent}`, /failed payment|retry a payment/i);
});

test('catalog installation upgrades an older repository with POC agents and MCP routing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);

  await removePocWorkflow(root);

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
