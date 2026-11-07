import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine-sdk/index.mjs';
import { summarizeWorkflowAssets, workflowAssetInventory } from '../src/kernel/workflow-assets.mjs';

function fixture({ changeContext = value => value, changeFacts = value => value, hook = () => {} } = {}) {
  const bundle = { workflows: [{ governs: 'story', id: 'example' }],
    objects: { story: { phases: { intake: {} }, artifactSets: {}, approvalAuthorities: {}, mcpServers: {}, templates: {} },
      initiative: { initiativePhases: {}, approvalAuthorities: {} } },
    assets: [{ kind: 'agent', id: 'analyst', content: 'PRIVATE MODEL WORDING MUST STAY IN THE ADAPTER' },
      { kind: 'instruction', id: 'standards', content: 'PRIVATE INSTRUCTION BODY' }] };
  const selection = { workflows: bundle.workflows, bundleSha256: 'sha256:' + 'a'.repeat(64), source: { kind: 'working-configuration', revision: null } };
  const calls = [];
  const port = {
    async load(inputs) { calls.push(['load', inputs]); await hook('load'); return changeContext({ selection, bundle }); },
    async read() { calls.push(['read']); await hook('read'); return changeFacts({ bundleSha256: selection.bundleSha256,
      dependencies: workflowAssetInventory(bundle), summary: summarizeWorkflowAssets(bundle) }); }
  };
  return { engine: createEngine({ ports: { workflowAssets: port } }), calls, port };
}

test('registered inventory is a detached read-only manifest, and private bodies never become model instructions', async () => {
  const f = fixture(), input = { workflowIds: [' example ', 'story:example', 'example'] };
  const running = f.engine.run('workflow.assets', input); input.workflowIds[0] = 'different';
  const result = await running;
  assert.equal(result.manifest.contract, 'sflow-workflow-assets/v1');
  assert.deepEqual(result.manifest.dependencies.workflows, ['story:example']);
  assert.deepEqual(result.manifest.dependencies.agents, ['analyst']);
  assert.deepEqual(result.manifest.dependencies.instructions, ['standards']);
  assert.deepEqual(result.effects, { committed: false, pushed: false, humanReviewRecorded: false, approvalRecorded: false });
  assert.deepEqual(f.calls, [['load', { workflowIds: ['example', 'story:example'] }], ['read']]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|content.*MUST STAY/u);
  assert.equal(result.manifest.contentIncluded, false);
  assert.equal(Object.isFrozen(result.manifest.dependencies.agents), true);
});

test('invalid inputs and pre-cancellation cannot enter a configuration reader', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  for (const input of [{}, { workflowIds: 'example' }, { workflowIds: [null] }, { workflowIds: ['example'], root: '/another' },
    { workflowIds: Array(8193).fill('example') }]) {
    await assert.rejects(f.engine.run('workflow.assets', input), { code: 'ENGINE_INPUT_INVALID' });
  }
  await assert.rejects(f.engine.run('workflow.assets', { workflowIds: ['example'] }, { signal: controller.signal }), { code: 'ENGINE_OPERATION_CANCELLED' });
  assert.deepEqual(f.calls, []);
});

test('a reader cannot substitute another selected workflow, provenance or digest', async () => {
  for (const changeContext of [
    context => ({ ...context, selection: { ...context.selection, workflows: [{ governs: 'story', id: 'other' }] } }),
    context => ({ ...context, selection: { ...context.selection, workflows: [...context.selection.workflows, { governs: 'initiative', id: 'example' }] } }),
    context => ({ ...context, selection: { ...context.selection, source: { kind: 'approved-snapshot', revision: null } } }),
    context => ({ ...context, selection: { ...context.selection, bundleSha256: 'unknown' } })
  ]) {
    const f = fixture({ changeContext });
    await assert.rejects(f.engine.run('workflow.assets', { workflowIds: ['example'] }), { code: 'ENGINE_PORT_RESULT_INVALID' });
    assert.equal(f.calls.length, 1);
  }
});

test('malformed inventory, body fields and non-JSON port facts cannot be reported as a successful inventory', async () => {
  for (const changeFacts of [
    facts => ({ ...facts, bundleSha256: 'sha256:' + 'b'.repeat(64) }),
    facts => ({ ...facts, dependencies: { ...facts.dependencies, workflows: ['story:other'] } }),
    facts => ({ ...facts, summary: { ...facts.summary, workflows: 999 } }),
    facts => ({ ...facts, summary: { ...facts.summary, agents: 999 } }),
    facts => ({ ...facts, prompt: 'unrequested prompt body' }),
    facts => ({ ...facts, dependencies: { ...facts.dependencies, agents: new Date() } }),
    facts => ({ ...facts, dependencies: { ...facts.dependencies, skillPackages: [{ skillId: 'example', packageSha256: 'bad', phases: [] }] } })
  ]) await assert.rejects(fixture({ changeFacts }).engine.run('workflow.assets', { workflowIds: ['example'] }), { code: 'ENGINE_PORT_RESULT_INVALID' });
});

test('actual reader failures preserve their identity, timeout details and causes without retry', async () => {
  const cause = new Error('the actual filesystem timeout');
  const failure = Object.freeze(Object.assign(new Error('configuration is unavailable', { cause }), {
    code: 'CONFIGURATION_UNAVAILABLE', details: { stage: 'asset-read', timedOut: true }
  }));
  for (const stage of ['load', 'read']) {
    const f = fixture({ hook(current) { if (current === stage) throw failure; } });
    await assert.rejects(f.engine.run('workflow.assets', { workflowIds: ['example'] }), error => error === failure && error.cause === cause);
    assert.equal(f.calls.filter(([name]) => name === stage).length, 1);
  }
});

test('cancellation after closure capture stops the remaining read without claiming a mutation', async () => {
  const controller = new AbortController(), f = fixture({ hook(stage) { if (stage === 'load') controller.abort(); } });
  await assert.rejects(f.engine.run('workflow.assets', { workflowIds: ['example'] }, { signal: controller.signal }), { code: 'ENGINE_OPERATION_CANCELLED' });
  assert.equal(f.calls.length, 1);
});
