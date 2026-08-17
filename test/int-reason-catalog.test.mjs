/**
 * The catalog is only worth having if it is complete, and completeness is not something a frozen
 * array can assert about itself. These tests are the other half of `[UXH:REQ-061]`: one sweeps the
 * source for codes the catalog has not heard of, and the rest hold the three runtime-composed
 * families level with the data they are composed from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMPOSED_CODES, KERNEL_CODES, READINESS_CODES, REASON_CODES, WORK_CODES, catalogued, isCatalogued
} from '../src/gateway/catalog.mjs';
import { BROAD_GOALS } from '../src/gateway/goals.mjs';
import { KERNEL_MESSAGES, KERNEL_OPERATIONS, createGatewayKernel } from '../src/gateway/kernel.mjs';
import { RESOLUTION_MESSAGES } from '../src/gateway/resolve.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { checklistSummary, noEffects, preservedAll, sflowResult } from '../src/gateway/result.mjs';
import { workContinueResult } from '../src/gateway/planners/work-continue.mjs';
import { workReadinessResult } from '../src/gateway/planners/work-readiness.mjs';

const GATEWAY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gateway');

async function gatewaySources(dir = GATEWAY) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await gatewaySources(full));
    else if (entry.name.endsWith('.mjs') && entry.name !== 'catalog.mjs') files.push(full);
  }
  return files;
}

test('every literal code in the gateway is in the catalog', async () => {
  /**
   * A source sweep rather than an exercise of every planner. Exercising them would only catch the
   * codes a fixture happens to reach, and the code most likely to be uncatalogued is the one on the
   * branch nobody wrote a fixture for.
   *
   * Matching on the *family prefix* rather than on a `code:` label is deliberate and was learned the
   * hard way: a first version keyed off `code:`/`reasonCode:` and missed five live codes, because
   * `refuse(id, 'gateway.read-only', …)` and `choice(entry, i, 'home.stable-choice')` pass theirs
   * positionally. A sweep that only sees the labelled form reports a clean catalog and is wrong.
   *
   * The families overlap with operation IDs and message IDs, which are also dotted lowercase and
   * are not reason codes. Both are enumerated, so they are excluded by identity rather than by a
   * pattern that would have to guess.
   */
  const families = [...new Set(REASON_CODES.map((code) => `${code.split('.')[0]}.`))];
  const registry = gatewayRegistry();
  const notCodes = new Set([
    ...registry.operations.map((operation) => operation.id),
    // The kernel operation a registry entry maps a UI action onto; an operation name, not a code.
    ...registry.operations.flatMap((operation) =>
      [operation.kernelOperation, operation.gateway?.kernelOperation]).filter(Boolean),
    ...KERNEL_OPERATIONS, ...BROAD_GOALS, ...KERNEL_MESSAGES, ...RESOLUTION_MESSAGES
  ]);
  const pattern = /'([a-z][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]+)'/g;
  const missing = [];
  for (const file of await gatewaySources()) {
    const source = await readFile(file, 'utf8');
    for (const [, code] of source.matchAll(pattern)) {
      if (!families.some((family) => code.startsWith(family))) continue;
      if (notCodes.has(code) || isCatalogued(code)) continue;
      missing.push(`${path.basename(file)}: ${code}`);
    }
  }
  assert.deepEqual(missing, [], `uncatalogued codes:\n  ${missing.join('\n  ')}`);
});

test('the catalog has no entry no producer uses', async () => {
  /**
   * The ratchet in the other direction. A catalog that only ever grows becomes a list of codes a
   * translator must cover and no surface will ever show — and the cost of that lands on whoever
   * writes the message file, who cannot tell which half is real.
   */
  const sources = await Promise.all((await gatewaySources()).map((file) => readFile(file, 'utf8')));
  const corpus = sources.join('\n');
  const composed = new Set(Object.values(COMPOSED_CODES).flat());
  const unused = REASON_CODES.filter((code) => !composed.has(code) && !corpus.includes(`'${code}'`));
  assert.deepEqual(unused, [], `catalogued but unreachable:\n  ${unused.join('\n  ')}`);
});

test('every handle failure code has a catalog entry', () => {
  /**
   * `handles.mjs` is the authority on how a handle can fail, and the kernel turns each of its codes
   * into `gateway.<kebab>`. Reading that file rather than restating the list is the point: adding a
   * rejection there and forgetting this file is exactly the drift being guarded.
   */
  const source = readFileSync(path.join(GATEWAY, 'handles.mjs'), 'utf8');
  const codes = [...source.matchAll(/reject\('([A-Z_]+)'/g)].map(([, code]) => code);
  assert.ok(codes.length >= 9, 'expected the handle rejection codes to be found');
  const handleFailures = codes.filter((code) => code.startsWith('HANDLE_'));
  for (const code of handleFailures) {
    const mapped = `gateway.${code.toLowerCase().replaceAll('_', '-')}`;
    assert.ok(KERNEL_CODES.includes(mapped), `${code} has no catalog entry (${mapped})`);
  }
});

test('an unrecognised blocker degrades to a named code instead of taking out the read', () => {
  /**
   * The whole reason the composing sites fall back rather than throw. A lifecycle that grows a
   * blocker must not cost the reader the rest of the answer.
   */
  const item = {
    id: 'WRK-9', kind: 'story', phase: 'implement', generation: 2, group: 'active',
    blockers: ['a-blocker-from-the-future'],
    nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' },
    lastMaterialEvent: null
  };
  const result = workContinueResult(item);
  const blocked = result.why.find((entry) => entry.code.startsWith('work.blocked.'));
  assert.equal(blocked.code, 'work.blocked.unrecognised');
  // The name survives, so the reader is told which blocker rather than that there was one.
  assert.equal(blocked.slots.blocker, 'a-blocker-from-the-future');

  const readiness = workReadinessResult(item);
  // Not `why[0]`, which is the `readiness.blocked` summary. The per-gate rows follow it.
  const row = readiness.why.find((entry) => entry.slots.gate === 'a-blocker-from-the-future');
  assert.equal(row.code, 'readiness.unrecognised-gate');

  /**
   * And it reaches the checklist, which is what the card and status bar count `[UXH:AC-002]`.
   * A gate outside the fixed list used to reach `why[]` and stop there, so a refusal rendered
   * beside "5 gates, all met".
   */
  const gateRow = readiness.checklist.find((entry) => entry.id === 'a-blocker-from-the-future');
  assert.equal(gateRow.state, 'unmet');
  assert.equal(checklistSummary(readiness).outstanding, 5, 'the unknown gates plus the new blocker');
});

test('a known blocker still gets its own code', () => {
  const item = {
    id: 'WRK-1', kind: 'story', phase: 'verify', generation: 1, group: 'active',
    blockers: ['approvals-outstanding'],
    nextAction: { operation: 'work.readiness', reasonCode: 'work.check-readiness' },
    lastMaterialEvent: null
  };
  assert.ok(workContinueResult(item).why.some((e) => e.code === 'work.blocked.approvals-outstanding'));
  assert.ok(workReadinessResult(item).why.some((e) => e.code === 'readiness.approvals-outstanding'));
});

test('a result carrying an uncatalogued code is rejected at construction', () => {
  assert.throws(() => sflowResult({
    kind: 'read',
    operation: { id: 'work.list', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.read' },
    effects: noEffects(),
    why: [{ code: 'work.something.nobody.declared', source: 'lifecycle' }],
    restState: 'informational'
  }), /not in the reason catalog/);
});

test('preserved, checklist and next reason codes are all held to the catalog', () => {
  const base = {
    kind: 'refusal',
    operation: { id: 'work.continue', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused' },
    effects: noEffects(),
    restState: 'blocked'
  };
  assert.throws(() => sflowResult({
    ...base, preserved: [{ code: 'work.invented', source: 'lifecycle', scope: 'all' }]
  }), /preserved\[0\] uses 'work.invented'/);

  assert.throws(() => sflowResult({
    ...base,
    preserved: preservedAll('work.nothing-was-carried-out'),
    checklist: [{ id: 'g', code: 'readiness.invented', state: 'unmet', source: 'lifecycle' }]
  }), /checklist\[0\] uses 'readiness.invented'/);

  assert.throws(() => sflowResult({
    ...base,
    preserved: preservedAll('work.nothing-was-carried-out'),
    next: [{
      handle: 'h', id: 'a', label: 'A', kind: 'read', reasonCode: 'work.invented',
      confirmation: 'none', interaction: 'read'
    }]
  }), /next\[0\]\.reasonCode uses 'work\.invented'/);
});

test('the fallback itself must be catalogued', () => {
  // Otherwise the safety valve is the one thing that can produce an uncatalogued code.
  assert.throws(() => catalogued('nope.nope', 'also.not.real'), /not a catalogued fallback/);
  assert.equal(catalogued('nope.nope', 'work.blocked.unrecognised'), 'work.blocked.unrecognised');
  assert.equal(catalogued('readiness.tests', 'readiness.unrecognised-gate'), 'readiness.tests');
});

test('a kernel refusal for an unknown handle names which failure it was', async () => {
  const kernel = createGatewayKernel({
    binding: {
      workspaceId: 'w', subjectKind: null, subjectId: null, sourceCommit: null, worktreeHash: null,
      worktreeAlgorithm: 'sflow-worktree-v2',
      repository: null, branch: null, lifecycleRevision: null,
      policyHash: 'p', registryHash: 'r', actorId: 'a', hostSessionId: 's'
    }
  });
  const result = await kernel.read({ resolutionId: 'rea_deadbeef' });
  assert.equal(result.kind, 'refusal');
  assert.equal(result.why[0].code, 'gateway.handle-unknown');
  // And a refusal still says what survived, which is what makes it readable `[DHR:REQ-061]`.
  assert.ok(result.preserved.length);
});

test('the readiness gate vocabulary is fully catalogued', () => {
  // Both halves: evaluated gates and the four the planner declares it cannot evaluate.
  for (const gate of ['publication-pending', 'approvals-outstanding', 'required-artifact-missing',
    'tests', 'stale-approvals', 'clarifications', 'unclaimed-changes']) {
    assert.ok(READINESS_CODES.includes(`readiness.${gate}`), `readiness.${gate} is not catalogued`);
    assert.ok(WORK_CODES.includes(`work.blocked.${gate}`) || !['publication-pending', 'approvals-outstanding',
      'required-artifact-missing'].includes(gate), `work.blocked.${gate} is not catalogued`);
  }
});
