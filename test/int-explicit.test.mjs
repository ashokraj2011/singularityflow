/**
 * The explicit path skips interpretation and reaches the same service. `[INT:AC-017]` `[INT:CON-021]`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const binding = {
  workspaceId: null, repository: null, branch: null, subjectKind: null, subjectId: null, sourceCommit: null, worktreeHash: null,
  worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null, policyHash: 'sha256:policy', registryHash: 'sha256:registry',
  actorId: 'dev@example.test', hostSessionId: 'sess-explicit'
};

test('explicit-path-is-direct-but-equivalent', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-int-explicit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sflow = (...args) => JSON.parse(spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', timeout: childTimeout(60_000) }).stdout);
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners() });

  // The CLI never resolves words: no resolution reason, straight to the documentation service.
  const explicit = sflow('explain', 'approvals', '--json');
  assert.ok(explicit.why.every((reason) => !reason.code.startsWith('resolution.')));
  // The gateway resolves, then reaches the same service, and both serve the same bytes and citation.
  const resolved = await kernel.resolve({ utterance: 'explain this to me', arguments: { question: 'approvals' } });
  assert.ok(resolved.why.some((reason) => reason.code.startsWith('resolution.matched')));
  const guided = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(guided.data.topic, explicit.data.topic.id);
  assert.equal(guided.data.citation, explicit.data.citation);
  assert.equal(guided.data.docsContentSha256, explicit.data.provenance.docsContentSha256);
  assert.equal(guided.why[0].code, explicit.why[0].code);
  assert.deepEqual([guided.schemaVersion, explicit.schemaVersion], [2, 2]);

  // Home is one projection whichever way it is reached: the same menu, in the same order.
  const home = sflow('home', '--json');
  const viaGateway = await kernel.read({ resolutionId: (await kernel.resolve({ utterance: 'home' })).next[0].handle });
  assert.equal(home.operation.id, viaGateway.operation.id);
  assert.deepEqual(home.next.map((action) => action.id), viaGateway.next.map((action) => action.id));
});
