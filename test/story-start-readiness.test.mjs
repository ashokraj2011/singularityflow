import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import {
  assertStoryStartReady, inspectStoryStartReadiness
} from '../src/story-start-readiness.mjs';

test('explicit baseline deferral admits intake without turning missing or failing tests into passing evidence', async () => {
  const definition = await shippedDefinition();
  definition.repositoryReadiness.baselinePolicy = 'choice';
  for (const evidence of [null, { repositories: { application: acceptedFailedTests() } }]) {
    const result = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: evidence, readinessBaseline: 'defer' }));
    assert.equal(result.ready, true, JSON.stringify(result.blockers));
    assert.ok(result.warnings.some(entry => entry.code === 'STORY_TEST_BASELINE_DEFERRED'));
    assert.ok(!result.checks.some(entry => entry.code === 'STORY_REPOSITORY_READINESS_VALID'));
    assert.equal(result.repositoryExecution.choice, 'defer');
    assert.notEqual(result.receipt.readinessSha256,
      inspectStoryStartReadiness(facts(definition, { repositoryReadiness: evidence, readinessBaseline: 'reuse' })).receipt.readinessSha256);
  }
});

test('baseline deferral cannot weaken strict, legacy, non-test or Git authority requirements', async () => {
  for (const policy of [
    { baselinePolicy: 'required' },
    { baselinePolicy: 'choice', dependencyHydration: 'required' },
    { baselinePolicy: 'choice', build: 'required' },
    { baselinePolicy: 'choice', applicationStart: 'required' }
  ]) {
    const definition = await shippedDefinition();
    Object.assign(definition.repositoryReadiness, policy);
    assert.equal(inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null, readinessBaseline: 'defer' })).ready, false);
    if (policy.baselinePolicy === 'choice') {
      const purpose = policy.dependencyHydration ? 'dependency' : policy.build ? 'build' : 'start';
      const receipt = { status: 'failing-tests', sourceCommit: BASE_COMMIT,
        prerequisitesCurrent: true, commandResults: [{ purpose, status: 'pass' }] };
      const inspect = value => inspectStoryStartReadiness(facts(definition, {
        repositoryReadiness: { repositories: { application: value } }, readinessBaseline: 'defer'
      }));
      assert.equal(inspect(receipt).ready, true, 'current non-test proof survives a deferred failing test');
      assert.equal(inspect({ ...receipt, status: 'stale' }).ready, false);
      assert.equal(inspect({ ...receipt, prerequisitesCurrent: false }).ready, false);
      assert.equal(inspect({ ...receipt, sourceCommit: 'c'.repeat(40) }).ready, false);
    }
    if (policy.baselinePolicy === 'required') {
      const passing = { repositories: { application: {
        status: 'pass', sourceCommit: BASE_COMMIT, commandResults: [],
        structuredTestContract: { status: 'available' }
      } } };
      const result = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: passing, readinessBaseline: 'defer' }));
      assert.equal(result.ready, false);
      assert.ok(result.blockers.some(entry => entry.code === 'TEST_BASELINE_DEFER_NOT_ALLOWED'));
    }
  }
  const definition = await shippedDefinition();
  definition.repositoryReadiness.baselinePolicy = 'choice';
  definition.initialization = { proof: { preStory: { requiredBeforeStory: true } } };
  const legacy = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null, readinessBaseline: 'defer' }));
  assert.equal(legacy.ready, false);
  assert.equal(legacy.repositoryExecution.baselinePolicy, 'required', 'the UI must not offer legacy-forbidden deferral');
  definition.initialization = { proof: { preStory: { requiredBeforeStory: false, build: 'required' } } };
  assert.equal(inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null, readinessBaseline: 'defer' })).ready, false);
  delete definition.initialization;
  const invalid = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null,
    readinessBaseline: 'defer', repositories: [{ id: 'application', baseCommit: null }] }));
  assert.equal(invalid.ready, false);
  assert.throws(() => inspectStoryStartReadiness(facts(definition, { readinessBaseline: 'skip-all' })), /reuse, run, or defer/);
});

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
    repositoryReadiness: {
      status: 'pass', sourceHead: BASE_COMMIT,
      receiptSha256: `sha256:${'9'.repeat(64)}`
    },
    publicationRequired: true,
    surface: 'test',
    ...overrides
  };
}

function acceptedFailedTests(baseCommit = BASE_COMMIT) {
  const now = Date.now();
  const sha = (letter) => `sha256:${letter.repeat(64)}`;
  return {
    status: 'accepted-known-failures', scope: 'dependency-test', sourceCommit: baseCommit,
    baselineSha256: sha('3'), sourceManifestSha256: sha('4'), planId: sha('5'),
    riskAssessment: { eligible: true, planCurrent: true, reasons: [] },
    riskAcceptance: {
      status: 'accepted-known-failures', baselineSha256: sha('3'),
      acceptanceSha256: sha('6'), sourceCommit: baseCommit,
      acceptedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 86_400_000).toISOString()
    },
    structuredTestContract: { status: 'available', commands: [{
      id: 'unit', adapter: 'junit-xml', minimumDiscovered: 1
    }] },
    testObservations: [{ commandId: 'unit', adapter: 'junit-xml', status: 'available',
      counts: { discovered: 2, passed: 1, failed: 1, skipped: 0 } }],
    commandResults: [
      { id: 'install', purpose: 'dependency', status: 'pass' },
      { id: 'unit', purpose: 'test', status: 'failed' }
    ]
  };
}

test('empty-plan preflight is not an execution receipt and cannot satisfy required test/build policy', async () => {
  const definition = await shippedDefinition();
  const preview = { status: 'no-commands-applicable', sourceCommit: BASE_COMMIT,
    scope: 'dependency-test', planId: `sha256:${'a'.repeat(64)}`, commandResults: [],
    structuredTestContract: { status: 'missing', satisfied: true, requiredForCode: false } };
  const input = facts(definition, { surface: 'vscode-preflight', repositoryReadiness: preview });
  assert.equal(inspectStoryStartReadiness(input).ready, true);
  assert.equal(inspectStoryStartReadiness({ ...input, surface: 'shell' }).ready, false);
  for (const key of ['dependencyHydration', 'build', 'applicationStart', 'structuredTests']) {
    const strict = structuredClone(definition);
    strict.repositoryReadiness = { ...strict.repositoryReadiness, [key]: 'required' };
    assert.equal(inspectStoryStartReadiness({ ...input, definition: strict }).ready, false, key);
  }
  assert.equal(inspectStoryStartReadiness({ ...input,
    repositoryReadiness: { ...preview, sourceCommit: 'c'.repeat(40) } }).ready, false);
});

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

test('an enforced pre-Story repository receipt must match the exact selected base', async () => {
  const definition = await shippedDefinition();
  definition.initialization = {
    proof: { preStory: { requiredBeforeStory: true } }
  };
  const missing = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null }));
  assert.equal(missing.ready, false);
  assert.ok(missing.blockers.some((entry) =>
    entry.code === 'STORY_REPOSITORY_READINESS_REQUIRED'));

  const stale = inspectStoryStartReadiness(facts(definition, {
    repositoryReadiness: {
      status: 'pass', sourceHead: 'c'.repeat(40),
      receiptSha256: `sha256:${'3'.repeat(64)}`
    }
  }));
  assert.equal(stale.ready, false);

  const ready = inspectStoryStartReadiness(facts(definition, {
    repositoryReadiness: {
      status: 'pass', sourceHead: BASE_COMMIT,
      receiptSha256: `sha256:${'4'.repeat(64)}`
    }
  }));
  assert.equal(ready.ready, true);
  assert.ok(ready.checks.some((entry) =>
    entry.code === 'STORY_REPOSITORY_READINESS_VALID'));
  assert.notEqual(ready.receipt.readinessSha256, missing.receipt.readinessSha256);
});

test('an accepted exact-base failure permits Story start as a warning but cannot waive full readiness', async () => {
  const definition = await shippedDefinition();
  definition.repositoryReadiness = {
    requiredBeforeStory: true, dependencyHydration: 'required',
    build: 'off', applicationStart: 'off', structuredTests: 'required'
  };
  const accepted = acceptedFailedTests();
  const ready = inspectStoryStartReadiness(facts(definition, {
    repositoryReadiness: accepted
  }));
  assert.equal(ready.ready, true);
  assert.equal(ready.status, 'ready-with-warnings');
  assert.equal(ready.checks.find((entry) => entry.id === 'repository-execution').code,
    'STORY_PRE_EXISTING_TEST_FAILURES_ACCEPTED');
  assert.notEqual(ready.receipt.readinessSha256,
    inspectStoryStartReadiness(facts(definition, {
      repositoryReadiness: { ...accepted,
        riskAcceptance: { ...accepted.riskAcceptance,
          acceptanceSha256: `sha256:${'7'.repeat(64)}` } }
    })).receipt.readinessSha256);

  for (const rejected of [
    { ...accepted, sourceCommit: 'c'.repeat(40) },
    { ...accepted, riskAcceptance: null },
    { ...accepted, commandResults: [{ id: 'unit', purpose: 'test', status: 'failed' }] },
    { ...accepted, structuredTestContract: { status: 'missing', commands: [] } },
    { ...accepted, structuredTestContract: { status: 'available', commands: [{
      id: 'unit', adapter: 'junit-xml', minimumDiscovered: 3
    }] } },
    { ...accepted, testObservations: [] }
  ]) assert.equal(inspectStoryStartReadiness(facts(definition, {
    repositoryReadiness: rejected
  })).ready, false);
  const full = structuredClone(definition);
  full.repositoryReadiness.build = 'required';
  assert.equal(inspectStoryStartReadiness(facts(full, {
    repositoryReadiness: accepted
  })).ready, false);
});

test('repository readiness remediation selects full scope for enabled build or start proof', async () => {
  const definition = await shippedDefinition();
  definition.repositoryReadiness = {
    requiredBeforeStory: true,
    dependencyHydration: 'required',
    build: 'required',
    structuredTests: 'required-for-code',
    applicationStart: 'off'
  };
  const result = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null }));

  assert.equal(result.repositoryExecution.scope, 'full');
  assert.throws(() => assertStoryStartReady(result), (error) => {
    assert.equal(error.details?.nextSkill, '/sf-ready --full');
    assert.equal(error.details?.nextAction,
      `singularity-flow precheck --run --base-commit ${BASE_COMMIT} --scope full --json`);
    return true;
  });
});

test('a legacy readiness block cannot disable the canonical pre-Story gate or narrow its scope', async () => {
  const definition = await shippedDefinition();
  definition.repositoryReadiness.requiredBeforeStory = true;
  definition.repositoryReadiness.build = 'required';
  definition.initialization = { proof: { preStory: {
    requiredBeforeStory: false, build: 'off', applicationStart: 'off'
  } } };
  const result = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null }));
  assert.equal(result.repositoryExecution.required, true);
  assert.equal(result.repositoryExecution.scope, 'full');
  assert.equal(result.ready, false);
  assert.ok(result.blockers.some((entry) => entry.id === 'repository-execution'));

  const incomplete = inspectStoryStartReadiness(facts(definition, {
    repositoryReadiness: {
      status: 'pass', sourceHead: BASE_COMMIT,
      receiptSha256: `sha256:${'7'.repeat(64)}`,
      commandResults: [{ purpose: 'test', status: 'pass' }]
    }
  }));
  assert.equal(incomplete.ready, false, 'legacy build:off must not accept a receipt without required build proof');
});

test('legacy when-detected build policy retains full-scope readiness', async () => {
  const definition = await shippedDefinition();
  definition.repositoryReadiness = {
    requiredBeforeStory: true,
    dependencyHydration: 'when-detected',
    build: 'when-detected',
    structuredTests: 'required-for-code',
    applicationStart: 'off'
  };
  const result = inspectStoryStartReadiness(facts(definition, { repositoryReadiness: null }));
  assert.equal(result.repositoryExecution.scope, 'full');
});

test('capability Story readiness requires an exact receipt for every repository', async () => {
  const definition = await shippedDefinition();
  definition.initialization = {
    proof: { preStory: { requiredBeforeStory: true } }
  };
  const repositories = [
    { id: 'frontend', baseBranch: 'main', baseCommit: 'd'.repeat(40), destinationRef: 'refs/heads/STORY-READY' },
    { id: 'backend', baseBranch: 'main', baseCommit: 'e'.repeat(40), destinationRef: 'refs/heads/STORY-READY' }
  ];
  const partial = inspectStoryStartReadiness(facts(definition, {
    repositories,
    repositoryReadiness: { repositories: {
      frontend: { status: 'pass', sourceHead: 'd'.repeat(40), receiptSha256: `sha256:${'5'.repeat(64)}` }
    } }
  }));
  assert.equal(partial.ready, false);

  const complete = inspectStoryStartReadiness(facts(definition, {
    repositories,
    repositoryReadiness: { repositories: {
      frontend: { status: 'pass', sourceHead: 'd'.repeat(40), receiptSha256: `sha256:${'5'.repeat(64)}` },
      backend: { status: 'pass', sourceHead: 'e'.repeat(40), receiptSha256: `sha256:${'6'.repeat(64)}` }
    } }
  }));
  assert.equal(complete.ready, true);
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
