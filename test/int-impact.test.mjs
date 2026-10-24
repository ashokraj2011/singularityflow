/**
 * Deterministic quick impact, and an interpretation that can only stand beside it. `[INT:AC-012]`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGatewayKernel } from '../src/gateway/kernel.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { impactQuick, impactQuickAssisted, ownersOf } from '../src/gateway/planners/impact-quick.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { run } from '../src/util.mjs';

const git = (root, ...args) => run('git', args, { cwd: root }).stdout.trim();
const binding = {
  workspaceId: null, repository: 'checkout-service', branch: 'main', subjectKind: null, subjectId: null, sourceCommit: null,
  worktreeHash: null, worktreeAlgorithm: 'sflow-worktree-v2', lifecycleRevision: null, policyHash: 'sha256:policy',
  registryHash: 'sha256:registry', actorId: 'dev@example.test', hostSessionId: 'sess-impact'
};

async function changeRange(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-int-impact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  await mkdir(path.join(root, 'src', 'address'), { recursive: true });
  await mkdir(path.join(root, '.github'), { recursive: true });
  await writeFile(path.join(root, '.github', 'CODEOWNERS'), '* @platform\n/src/address/ @checkout-team\n*.md @docs\n');
  await writeFile(path.join(root, 'src', 'address', 'postal.mjs'), 'export const required = false;\n');
  await writeFile(path.join(root, 'README.md'), '# checkout\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'address', 'postal.mjs'), 'export const required = true;\n');
  await writeFile(path.join(root, 'src', 'order.mjs'), 'export const order = 1;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'postal codes fail closed');
  return { root, base, target: git(root, 'rev-parse', 'HEAD') };
}

test('facts-and-interpretation-stay-separated', async (t) => {
  const { root, base, target } = await changeRange(t);
  const facts = validateSflowResult(await impactQuick({ root, arguments: { baseRef: base, targetRef: target } }));

  // Deterministic facts, from the exact revisions, with what they were computed from.
  assert.deepEqual(facts.data.affected.paths, ['src/address/postal.mjs', 'src/order.mjs']);
  assert.deepEqual(facts.data.revisions, { baseline: base, target });
  assert.deepEqual(facts.data.owners, [
    { path: 'src/address/postal.mjs', owners: ['@checkout-team'] }, { path: 'src/order.mjs', owners: ['@platform'] }
  ]);
  assert.match(facts.data.binding.evidenceHandle, /^sha256:[0-9a-f]{64}$/);
  assert.ok(facts.data.binding.generatedAt);
  assert.ok(facts.data.evidenceGaps.includes('build-provenance'), 'no provider is configured, and that is said');
  assert.equal(facts.data.semanticImpact, null);
  assert.ok(Object.values(facts.effects).every((value) => value === false));

  // The relay: the same facts with stable IDs and the one response shape that is accepted.
  const offered = await impactQuickAssisted({ root, arguments: { baseRef: base, targetRef: target } });
  const relay = offered.data.assisted.relay;
  assert.deepEqual(offered.data.facts, facts.data.facts);
  const [first] = relay.facts;
  const answer = (body) => impactQuickAssisted({ root, arguments: { baseRef: base, targetRef: target, interpretation: JSON.stringify(body) } });

  // A grounded interpretation is accepted, labelled assisted, and changes no fact.
  const grounded = await answer({ factSetHash: relay.factSetHash, interpretations: [
    { kind: 'risk', text: 'Checkout callers that omit postal codes now fail.', cites: [first.id] },
    { kind: 'question', text: 'Which clients omit postal codes?', cites: ['F-not-a-fact'] }
  ] });
  assert.deepEqual(grounded.data.assisted.accepted.map((entry) => [entry.kind, entry.source]), [['risk', 'assisted']]);
  assert.deepEqual(grounded.data.assisted.rejected, [{ index: 1, reason: 'cites-unknown-fact' }]);
  assert.deepEqual(grounded.data.facts, facts.data.facts);
  assert.deepEqual(grounded.data.affected, facts.data.affected);

  // One that tries to add, delete or reclassify a fact is refused whole, and the facts stand.
  for (const reach of [{ facts: [] }, { add: [{ kind: 'changed-path', statement: 'src/secret.mjs' }] }, { reclassify: { [first.id]: 'owner' } }]) {
    const refused = await answer({ factSetHash: relay.factSetHash, interpretations: [], ...reach });
    assert.equal(refused.data.assisted.reason, 'interpretation-touches-facts');
    assert.deepEqual(refused.data.affected, facts.data.affected);
  }
  // An answer to a different fact set — the world moved — is not this answer.
  assert.equal((await answer({ factSetHash: 'sha256:other', interpretations: [] })).data.assisted.reason, 'fact-set-mismatch');

  // Work creation is a separate reviewed plan: the finding opens an intake, which creates nothing.
  const kernel = createGatewayKernel({ binding, planners: gatewayPlanners(), root });
  const resolved = await kernel.resolve({ utterance: 'quick impact analysis', arguments: { baseRef: base, targetRef: target } });
  const read = await kernel.read({ resolutionId: resolved.next[0].handle });
  const start = read.next.find((action) => action.id === 'impact:start-from-finding');
  assert.ok(start && start.executable === false);
  const intake = await kernel.resolve({ selectionHandle: start.handle });
  assert.equal(intake.operation.id, 'work.start.intake');
  assert.notEqual(intake.kind, 'plan');
  assert.ok(Object.values(intake.effects).every((value) => value === false));
});

test('owners follow CODEOWNERS precedence: the last matching rule wins', () => {
  assert.deepEqual(ownersOf('* @all\ndocs/ @docs\n/src/**/*.mjs @js\n# comment\n', ['docs/a.md', 'src/x/y.mjs', 'z.txt']), [
    { path: 'docs/a.md', owners: ['@docs'] }, { path: 'src/x/y.mjs', owners: ['@js'] }, { path: 'z.txt', owners: ['@all'] }
  ]);
});
