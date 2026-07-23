import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import {
  interfaceContractStatus, registerInterfaceContract
} from '../src/initiative-contracts.mjs';
import {
  buildInitiativeGraph, downstreamCone, initiativeNode, invalidateInitiativeCone
} from '../src/initiative-graph.mjs';
import {
  createInitiative, loadInitiative, saveInitiative
} from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-initiative-graph-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Initiative Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Initiative\n');
  await initializeDefinition(root);
  const file = path.join(root, '.singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Initiative Owner', email: 'owner@example.com' }];
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize portfolio'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-GRAPH'], { cwd: root });
  const created = await createInitiative(root, { id: 'INIT-GRAPH', profile: 'initiative-lite' });
  created.initiative.childStories = {
    'API-1': { id: 'API-1', repository: 'api', blocking: true, dependsOn: [] },
    'MOB-1': { id: 'MOB-1', repository: 'mobile', blocking: true, dependsOn: [{ story: 'API-1', requiredPhase: 'implementation-spec' }] },
    'DOC-1': { id: 'DOC-1', repository: 'docs', blocking: false, dependsOn: [] }
  };
  await saveInitiative(root, created.portfolio, created.initiative);
  return root;
}

test('justification graph invalidates only the transitive consumer cone', async () => {
  const root = await repository();
  const { initiative } = await loadInitiative(root, 'INIT-GRAPH');
  const graph = buildInitiativeGraph(initiative);
  const cone = downstreamCone(graph, [initiativeNode('output', 'define', 'scope-and-outcomes')]);
  assert.ok(cone.includes('output:plan/architecture-summary'));
  assert.ok(cone.includes('output:plan/interface-contracts'));
  assert.ok(cone.includes('phase:plan'));
  assert.ok(cone.includes('output:build/implementation-index'));
  assert.ok(cone.includes('phase:release'));
  assert.ok(!cone.includes('output:define/acceptance-criteria'));
  assert.ok(!cone.includes('output:plan/story-plan'));

  const invalidation = await invalidateInitiativeCone(root, {
    initiativeId: 'INIT-GRAPH',
    starts: ['output:define/scope-and-outcomes'],
    reason: 'Scope changed after stakeholder review.',
    cause: 'output-regenerated'
  });
  assert.deepEqual(invalidation.affected, cone);
  const reloaded = (await loadInitiative(root, 'INIT-GRAPH')).initiative;
  assert.equal(reloaded.phases.plan.outputs['architecture-summary'].status, 'stale');
  assert.equal(reloaded.phases.plan.outputs['story-plan'].status, 'not_generated');
});

test('versioned interface contracts pin exact bytes and stale only declared consumers', async () => {
  const root = await repository();
  const v1 = path.join(root, 'customer-api-v1.yaml');
  const v2 = path.join(root, 'customer-api-v2.yaml');
  await writeFile(v1, 'openapi: 3.1.0\ninfo: { title: Customer, version: 1 }\n');
  await writeFile(v2, 'openapi: 3.1.0\ninfo: { title: Customer, version: 2 }\n');
  const first = await registerInterfaceContract(root, {
    initiativeId: 'INIT-GRAPH',
    contractId: 'customer-api',
    version: '1',
    format: 'openapi',
    sourcePath: v1,
    producers: ['API-1'],
    consumers: ['MOB-1']
  });
  assert.equal(first.invalidations.length, 0);
  let status = await interfaceContractStatus(root, 'INIT-GRAPH');
  assert.equal(status[0].integrity, 'verified');

  const second = await registerInterfaceContract(root, {
    initiativeId: 'INIT-GRAPH',
    contractId: 'customer-api',
    version: '2',
    format: 'openapi',
    sourcePath: v2,
    producers: ['API-1'],
    consumers: ['MOB-1']
  });
  assert.equal(second.invalidations.length, 1);
  const initiative = (await loadInitiative(root, 'INIT-GRAPH')).initiative;
  assert.equal(initiative.contracts['customer-api@1'].status, 'stale');
  assert.equal(initiative.contracts['customer-api@2'].status, 'active');
  assert.equal(initiative.childStories['MOB-1'].stale, true);
  assert.notEqual(initiative.childStories['DOC-1'].stale, true);

  await writeFile(path.join(root, initiative.contracts['customer-api@2'].path), 'tampered: true\n');
  status = await interfaceContractStatus(root, 'INIT-GRAPH');
  assert.equal(status.find((contract) => contract.key === 'customer-api@2').integrity, 'stale');
});

test('an existing contract version cannot be rewritten', async () => {
  const root = await repository();
  const source = path.join(root, 'contract.md');
  await writeFile(source, '# Contract v1\n');
  await registerInterfaceContract(root, {
    initiativeId: 'INIT-GRAPH',
    contractId: 'events',
    version: '1',
    format: 'markdown',
    sourcePath: source
  });
  await writeFile(source, '# Rewritten contract\n');
  await assert.rejects(() => registerInterfaceContract(root, {
    initiativeId: 'INIT-GRAPH',
    contractId: 'events',
    version: '1',
    format: 'markdown',
    sourcePath: source
  }), /Create a new version/);
});
