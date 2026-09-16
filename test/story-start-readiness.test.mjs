import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { inspectStoryStartReadiness } from '../src/story-start-readiness.mjs';

const CONFIG_COMMIT = 'a'.repeat(40);
const BASE_COMMIT = 'b'.repeat(40);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function shippedDefinition() {
  const definition = YAML.parse(await readFile(
    new URL('../templates/workflow.yml', import.meta.url), 'utf8'
  ));
  const phaseIds = Object.keys(definition.phases);
  definition.agentCatalog = phaseIds.map((phaseId) => ({
    id: `agent-${phaseId}`,
    defaultFor: [phaseId]
  }));
  definition.agents = Object.fromEntries(
    definition.agentCatalog.map((agent) => [agent.id, { id: agent.id }])
  );
  return definition;
}

function facts(definition, overrides = {}) {
  return {
    workId: 'STORY-READY',
    definition,
    configurationSnapshot: {
      authority: { branch: 'sflow/config', commit: CONFIG_COMMIT },
      sourceCommit: CONFIG_COMMIT,
      assets: [
        { relative: 'singularity/workflow.yml', sha256: `sha256:${'1'.repeat(64)}` },
        { relative: '.github/agents/product-owner.agent.md', sha256: `sha256:${'2'.repeat(64)}` }
      ]
    },
    workType: 'feature',
    capabilityId: 'payments',
    baseBranch: 'main',
    repositories: [{
      id: 'application',
      baseBranch: 'main',
      baseCommit: BASE_COMMIT,
      destinationRef: 'refs/heads/STORY-READY',
      publishRequired: true
    }],
    publicationRequired: true,
    surface: 'test',
    ...overrides
  };
}

test('Story-start readiness has a deterministic receipt for equivalent facts', async () => {
  const definition = await shippedDefinition();
  const firstFacts = facts(definition);
  const secondFacts = facts(definition, {
    configurationSnapshot: {
      ...firstFacts.configurationSnapshot,
      assets: [...firstFacts.configurationSnapshot.assets].reverse()
    },
    repositories: [{
      destinationRef: 'refs/heads/STORY-READY',
      publishRequired: true,
      baseCommit: BASE_COMMIT,
      baseBranch: 'main',
      id: 'application'
    }]
  });

  const first = inspectStoryStartReadiness(firstFacts);
  const second = inspectStoryStartReadiness(secondFacts);

  assert.equal(first.ready, true);
  assert.equal(first.receipt.readinessSha256, second.receipt.readinessSha256);
  assert.equal(first.authority.filesSha256, second.authority.filesSha256);
});

test('optional intelligence is explicitly non-blocking at Story start', async () => {
  const result = inspectStoryStartReadiness(facts(await shippedDefinition()));
  const optional = result.checks.find((entry) => entry.id === 'optional-intelligence');

  assert.deepEqual(optional, {
    id: 'optional-intelligence',
    status: 'pass',
    code: 'STORY_OPTIONAL_INTELLIGENCE_NON_BLOCKING',
    message: 'World Model, AST, model-provider, telemetry, and Copilot availability do not block Story creation.'
  });
  assert.equal(result.blockers.length, 0);
});

test('a workflow phase without an installed default agent blocks Story start', async () => {
  const definition = await shippedDefinition();
  const featurePhase = definition.workTypes.feature.phases[0];
  const agent = definition.agentCatalog.find((entry) => entry.defaultFor.includes(featurePhase));
  delete definition.agents[agent.id];

  const result = inspectStoryStartReadiness(facts(definition));

  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((entry) =>
    entry.code === 'STORY_PHASE_DEFAULT_AGENT_INVALID'
      && entry.message.includes(`Phase '${featurePhase}'`)));
});

test('incomplete exact Git evidence blocks Story start', async () => {
  const definition = await shippedDefinition();
  const result = inspectStoryStartReadiness(facts(definition, {
    repositories: [{
      id: 'application', baseBranch: 'main', baseCommit: null,
      destinationRef: 'refs/heads/STORY-READY', publishRequired: true
    }]
  }));

  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((entry) => entry.code === 'STORY_GIT_PREFLIGHT_INCOMPLETE'));
});

test('readiness is a synchronous projection and never mutates frozen caller evidence', async () => {
  const input = deepFreeze(facts(await shippedDefinition()));
  const before = JSON.stringify(input);

  const result = inspectStoryStartReadiness(input);

  assert.equal(typeof result?.then, 'undefined', 'readiness must not schedule asynchronous I/O');
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.checks), true);
  assert.equal(result.provisional, true, 'the pure preview never grants mutation authority');
});
