import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { EXPLAIN_PREVIEW_BYTES, helpExplain } from '../src/gateway/planners/help-explain.mjs';
import { WORKSPACE_LIST_EVIDENCE_GAPS, workspaceList } from '../src/gateway/planners/workspace-list.mjs';
import { workStartIntake } from '../src/gateway/planners/work-start-intake.mjs';
import { gatewayRegistry, unimplementedPlanners } from '../src/gateway/operations.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import {
  ACTION_EMPHASIS, INTERACTION_CLASSES, PRESERVATION_SCOPES, validateSflowResult
} from '../src/gateway/result.mjs';
import { loadTopics, resolveTopic } from '../src/docs-topics.mjs';

const binding = {
  workspaceId: 'payments',
  repository: 'payments-api',
  branch: 'main',
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

test('start intake carries bounded conversational defaults and changes nothing', () => {
  const result = workStartIntake({ arguments: {
    source: 'bug-report', shape: 'story', workType: 'bug-fix', summary: 'Retry checkout safely'
  } });
  validateSflowResult(result);
  assert.equal(result.operation.id, 'work.start.intake');
  assert.deepEqual({ ...result.effects }, {
    contextChanged: false, stateChanged: false, filesChanged: false,
    gitRefsChanged: false, publicationCreated: false, externalSystemsChanged: false
  });
  assert.deepEqual(result.data.defaults, {
    source: 'bug-report', workspaceId: null, repositoryId: null, shape: 'story',
    workType: 'bug-fix', summary: 'Retry checkout safely'
  });
  assert.ok(result.data.requiredInputs.includes('remote base branch'));
});

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

  /**
   * And the ones still missing keep saying so by name rather than returning empty.
   *
   * The unimplemented planner is derived rather than named. Naming one made this test fail every
   * time that planner got written — which is the ratchet working, but it turns a correctness check
   * into a chore, and a chore gets deleted.
   */
  const missing = unimplementedPlanners(gatewayPlanners());
  assert.ok(missing.length, 'nothing left to assert once every planner exists');
  const candidates = gatewayRegistry().operations
    .filter((entry) => entry.classification === 'read' && missing.includes(entry.gateway.planner));
  // One whose arguments are all optional, so resolution reaches a handle instead of asking a question.
  const pick = candidates
    .map((entry) => ({ entry, resolved: kernel.resolve({ utterance: entry.gateway.aliases.en.phrases[0] }) }))
    .find(({ resolved }) => resolved.kind === 'read');
  assert.ok(pick, 'no unimplemented read resolves without arguments');
  const operation = pick.entry;
  const read = await kernel.read({ resolutionId: pick.resolved.next[0].handle });
  assert.equal(read.kind, 'refusal');
  assert.equal(read.why[0].code, 'gateway.planner-unavailable');
  assert.equal(read.why[0].slots.planner, operation.gateway.planner);
});

// ---------------------------------------------------------------------------
// Contract sweeps: what every planner owes the shell, checked across all of them at once.

/**
 * Collect a result from every planner this build has, by whatever route reaches it.
 *
 * A sweep rather than a per-planner assertion, because the failure this guards against is the
 * *next* planner — one written after the contract settles, tested on its own terms, and never
 * checked against the rules the shell relies on for every card it renders.
 */
async function everyPlannerResult() {
  const env = { SINGULARITY_FLOW_WORKSPACES: path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-sweep-')), 'registry.json') };
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners() });
  const results = [
    await helpExplain({ arguments: { topic: 'approvals' } }),
    await helpExplain({ arguments: { question: 'nothing the documentation covers at all' } }),
    await workspaceList({ env }),
    kernel.resolve({ utterance: 'explain approvals' }),
    kernel.resolve({ utterance: 'zzzz not a phrase anyone would say' }),
    kernel.next({}),
    // The two refusal paths every host will meet: a handle that died, and a planner this build
    // declares but does not have.
    kernel.resolve({ selectionHandle: 'sel_never_issued' }),
    await kernel.read({ resolutionId: 'rea_never_issued' })
  ];
  return results.filter(Boolean);
}

test('every planner offers actions the shell can render', async () => {
  // [UXH:REQ-030]. The fields are enforced at construction; this asserts the set of producers is
  // actually covered by that enforcement rather than each one being individually remembered.
  for (const result of await everyPlannerResult()) {
    validateSflowResult(result);
    for (const action of result.next) {
      assert.ok(action.id, `${result.operation.id} produced an action with no stable id`);
      assert.ok(INTERACTION_CLASSES.includes(action.interaction),
        `${result.operation.id} produced interaction '${action.interaction}'`);
      assert.ok(ACTION_EMPHASIS.includes(action.emphasis));
    }
    assert.ok(result.next.filter((action) => action.emphasis === 'primary').length <= 1,
      `${result.operation.id} offered more than one filled button`);
  }
});

test('no planner asks for model consent in v1', async () => {
  // [UXH:AC-015] and [DHR:CON-004] as a gate rather than a promise. v1 ships model-free, so the
  // class is declared and unproduced — and the day that changes, this fails loudly.
  for (const result of await everyPlannerResult()) {
    const consent = result.next.filter((action) => action.interaction === 'model-consent');
    assert.equal(consent.length, 0, `${result.operation.id} asked for model consent`);
  }
});

test('every topic a planner names is a topic that exists', async () => {
  // A next action pointing at documentation that was renamed is a "learn more" that dead-ends. The
  // topics are compiled, so this is checkable rather than a convention.
  const topics = await loadTopics();
  for (const result of await everyPlannerResult()) {
    for (const action of result.next.filter((entry) => entry.topic)) {
      assert.ok(resolveTopic(topics, action.topic).topic,
        `${result.operation.id} points at topic '${action.topic}', which does not exist`);
    }
  }
});

test('every refusal states what it preserved, whoever produced it', async () => {
  // [DHR:REQ-061]. Enforced at construction, swept here so the enforcement is known to bite on the
  // refusal paths that actually run rather than only on the ones a test constructs by hand.
  const refusals = (await everyPlannerResult()).filter((result) => result.outcome.status === 'refused');
  assert.ok(refusals.length, 'no refusal reached this sweep, so it asserts nothing');
  for (const result of refusals) {
    assert.ok(result.preserved.length, `${result.operation.id} refused without saying what survived`);
    assert.ok(result.preserved.every((entry) => PRESERVATION_SCOPES.includes(entry.scope)));
  }
});
