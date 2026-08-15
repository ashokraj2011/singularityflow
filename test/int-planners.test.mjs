import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { EXPLAIN_PREVIEW_BYTES, helpExplain } from '../src/gateway/planners/help-explain.mjs';
import { WORKSPACE_LIST_EVIDENCE_GAPS, workspaceList } from '../src/gateway/planners/workspace-list.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';

const binding = {
  workspaceId: 'payments',
  subjectKind: null,
  subjectId: null,
  sourceCommit: null,
  worktreeHash: null,
  lifecycleRevision: null,
  policyHash: 'sha256:policy',
  registryHash: 'sha256:registry',
  actorId: 'dev-1',
  hostSessionId: 'sess-1'
};

/**
 * A registry of our own, never the machine's.
 *
 * `workspace.list` reads whatever `SINGULARITY_FLOW_WORKSPACE_REGISTRY` points at, and a test that
 * read the developer's real registry would pass or fail depending on whose laptop it ran on.
 */
async function fixtureRegistry(entries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-gateway-'));
  const file = path.join(directory, 'workspaces.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, workspaces: entries }));
  return { file, env: { SINGULARITY_FLOW_WORKSPACE_REGISTRY: file } };
}

test('explain answers from a compiled topic and cites it with a resolvable handle', async () => {
  const result = await helpExplain({ arguments: { question: 'approvals' } });
  validateSflowResult(result);
  assert.equal(result.kind, 'read');
  assert.equal(result.operation.id, 'help.explain');
  assert.equal(result.data.topic, 'approvals');
  assert.ok(result.data.body.length);

  // `[INT:REQ-037]`: source class plus a handle that resolves, on the material statement.
  const cited = result.why.find((entry) => entry.code === 'explain.cited');
  assert.equal(cited.source, 'evidence');
  assert.match(cited.reference, /^sfdoc:v1:approvals:[0-9a-f]{12}$/);
  assert.equal(result.data.handle, cited.reference);
  assert.ok(result.data.docsContentSha256, 'a stamped build cites its docs digest');
});

test('a question the documentation cannot answer is not answered by the nearest topic', async () => {
  const result = await helpExplain({ arguments: { question: 'how do I file my taxes' } });
  validateSflowResult(result);
  assert.equal(result.kind, 'clarification');
  assert.equal(result.why[0].code, 'explain.no-match');
  assert.equal(result.why[0].source, 'unavailable');
  assert.ok(result.next.length, 'a dead end is not an acceptable answer');
  assert.equal(result.next.every((entry) => entry.executable === false), true);
  // Suggestions are offered, never served: no body came back.
  assert.equal(result.data.body, undefined);
});

test('an ambiguous topic prefix offers the candidates rather than picking one', async () => {
  // `work` prefixes more than one topic in the shipped package.
  const result = await helpExplain({ arguments: { topic: 'work' } });
  validateSflowResult(result);
  if (result.why[0].code === 'explain.ambiguous') {
    assert.equal(result.kind, 'clarification');
    assert.ok(result.next.length > 1);
  } else {
    assert.equal(result.kind, 'read', 'a unique prefix resolves, which is also correct');
  }
});

test('an explanation is bounded rather than pasted whole', async () => {
  const result = await helpExplain({ arguments: { question: 'approvals' } });
  assert.ok(Buffer.byteLength(result.data.body, 'utf8') <= EXPLAIN_PREVIEW_BYTES + 512);
  assert.equal(typeof result.data.truncated, 'boolean');
});

test('workspace.list reads the configured registry and nothing else', async () => {
  const { file, env } = await fixtureRegistry([
    { id: 'payments', name: 'Payments', path: '/tmp/ws/payments', lastUsedAt: '2026-08-01T00:00:00.000Z' },
    { id: 'billing', name: 'Billing', path: '/tmp/ws/billing' },
    { id: 'retired', name: 'Retired', path: '/tmp/ws/retired', archivedAt: '2026-01-01T00:00:00.000Z' }
  ]);
  const result = await workspaceList({ env });
  validateSflowResult(result);

  assert.deepEqual(result.data.workspaces.map((entry) => entry.id), ['payments', 'billing']);
  assert.equal(result.data.registryFile, file);
  assert.equal(result.why[0].code, 'workspace.from-registry');
  assert.equal(result.why[0].reference, file);
  for (const workspace of result.data.workspaces) {
    assert.equal(workspace.visibleBecause, 'registered-on-this-machine');
  }
});

test('what the registry cannot answer is declared as a gap, not invented', async () => {
  const { env } = await fixtureRegistry([{ id: 'payments', name: 'Payments', path: '/tmp/ws/payments' }]);
  const result = await workspaceList({ env });
  assert.deepEqual([...result.data.evidenceGaps], [...WORKSPACE_LIST_EVIDENCE_GAPS]);
  for (const field of WORKSPACE_LIST_EVIDENCE_GAPS) {
    const warning = result.warnings.find((entry) => entry.slots.field === field);
    assert.ok(warning, `${field} should be disclosed as missing`);
    assert.equal(warning.source, 'unavailable');
  }
  // No health badge, no repository count. Absent beats fabricated.
  assert.equal(result.data.workspaces[0].health, undefined);
});

test('an empty registry is an answer with somewhere to stop', async () => {
  const { env } = await fixtureRegistry([]);
  const result = await workspaceList({ env });
  validateSflowResult(result);
  assert.equal(result.data.workspaces.length, 0);
  assert.equal(result.next.length, 0);
  assert.equal(result.restState, 'informational');
});

test('a workspace row is selectable but never switchable from the list', async () => {
  const { env } = await fixtureRegistry([{ id: 'payments', name: 'Payments', path: '/tmp/ws/payments' }]);
  const result = await workspaceList({ env });
  assert.equal(result.next[0].executable, false);
  assert.equal(result.next[0].confirmation, 'host-confirm');
  assert.match(result.next[0].fallback.command, /^sflow workspace use /);
});

test('the kernel routes a resolved read to the planner that now exists', async () => {
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners() });
  const explained = await kernel.explain({ question: 'approvals' });
  assert.equal(explained.kind, 'read');
  assert.equal(explained.data.topic, 'approvals');

  // And the ones still missing keep saying so by name rather than returning empty.
  const resolved = kernel.resolve({ utterance: 'what am I working on' });
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(read.kind, 'refusal');
  assert.equal(read.why[0].slots.planner, 'work-list');
});
