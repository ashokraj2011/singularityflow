import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { IMPACT_EVIDENCE_GAPS, affectedCapabilities, impactQuick } from '../src/gateway/planners/impact-quick.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';

const WORKSPACE = {
  repositories: {
    checkout: { id: 'checkout', path: 'repos/checkout-service', capabilities: ['checkout', 'payments'] },
    billing: { id: 'billing', path: 'repos/billing', capabilities: ['payments'] },
    docs: { id: 'docs', path: 'repos/docs', capabilities: [] }
  }
};

async function emptyRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-'));
  await mkdir(path.join(root, 'singularity', 'work-items'), { recursive: true });
  return root;
}

test('capabilities come from the declared map, never from a path that looks familiar', () => {
  const hits = affectedCapabilities(WORKSPACE, ['repos/checkout-service/src/pay.ts']);
  assert.deepEqual(hits, [
    { capability: 'checkout', repositories: ['checkout'] },
    { capability: 'payments', repositories: ['checkout'] }
  ]);

  // A directory named after a capability in a repository that declares none is not that capability.
  assert.deepEqual(affectedCapabilities(WORKSPACE, ['repos/docs/payments/guide.md']), []);
  assert.deepEqual(affectedCapabilities(WORKSPACE, ['unrelated/file.ts']), []);
});

test('one capability across two repositories is reported once, naming both', () => {
  const hits = affectedCapabilities(WORKSPACE, ['repos/checkout-service/a.ts', 'repos/billing/b.ts']);
  const payments = hits.find((entry) => entry.capability === 'payments');
  assert.deepEqual(payments.repositories, ['billing', 'checkout']);
});

test('the report names what it was computed from and claims no semantic impact', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({
    root,
    arguments: { baseRef: 'main', targetRef: 'wi/WRK-1', includeWorktree: true },
    context: { workspace: WORKSPACE, changedPaths: ['repos/checkout-service/src/pay.ts'] }
  });
  validateSflowResult(result);
  assert.equal(result.kind, 'read');
  assert.equal(result.data.baseline, 'main');
  assert.equal(result.data.target, 'wi/WRK-1');
  assert.equal(result.data.semanticImpact, null, 'the report never says whether anything is broken');
  assert.deepEqual(result.data.affected.repositories, ['checkout']);
});

test('a missing input is a declared gap, never an empty result', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({ root, context: { workspace: WORKSPACE, changedPaths: [] } });
  for (const field of IMPACT_EVIDENCE_GAPS) {
    const warning = result.warnings.find((entry) => entry.slots.field === field);
    assert.ok(warning, `${field} should be disclosed as unread`);
    assert.equal(warning.source, 'unavailable');
  }
  // Build provenance in particular: absent adapters must not read as "no builds affected".
  assert.ok(IMPACT_EVIDENCE_GAPS.includes('build-provenance'));
});

test('tests matched by path convention say that is what they are', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({
    root,
    context: { workspace: WORKSPACE, changedPaths: ['repos/checkout-service/tests/pay.test.ts', 'repos/checkout-service/src/pay.ts'] }
  });
  assert.deepEqual(result.data.affected.testsByConvention, ['repos/checkout-service/tests/pay.test.ts']);
  const heuristic = result.warnings.find((entry) => entry.code === 'impact.tests-by-path-convention');
  assert.equal(heuristic.slots.matched, '1');
});

test('quick impact changes nothing and offers no shortcut into creating work', async () => {
  const root = await emptyRepository();
  const result = await impactQuick({ root, context: { workspace: WORKSPACE, changedPaths: ['repos/billing/x.ts'] } });
  // `[INT:CON-070]` and `[INT:REQ-075]`.
  assert.equal(Object.values(result.effects).some(Boolean), false);
  assert.equal(result.next.every((entry) => entry.executable === false), true);
});

test('impact.quick refuses without a root rather than reading the working directory', async () => {
  await assert.rejects(() => impactQuick({ context: { workspace: WORKSPACE, changedPaths: [] } }),
    (error) => error.code === 'IMPACT_QUICK_NO_ROOT');
});
