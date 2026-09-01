import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sealRecord } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { selectViewFacts } from '../src/world-model/extract/selection.mjs';
import { validateFactLedger } from '../src/world-model/extract/fact-ledger.mjs';
import { resolveBuiltInViewContract } from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { buildWorldModelV4 } from '../src/world-model/runtime.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMB Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export function service() { return 1; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

test('required view coverage is explicit typed unavailability and selection is deterministic', async (t) => {
  const root = await fixture(t);
  const scope = createScopeManifest({
    capabilityId: 'service',
    allowedPaths: ['src/**'],
    allowedSubjects: ['analysis', 'dependency-edge', 'file', 'symbol']
  });
  const first = runDeterministicRegistration({
    root, scopeManifest: scope, requestedViews: ['dev.impact@4']
  });
  const second = runDeterministicRegistration({
    root, scopeManifest: scope, requestedViews: ['dev.impact@4']
  });
  assert.equal(first.factLedger.ledgerSha256, second.factLedger.ledgerSha256);
  assert.equal(first.viewFactLedgers[0].ledgerSha256, second.viewFactLedgers[0].ledgerSha256);
  const unavailable = first.factLedger.facts.filter((fact) => fact.status === 'unavailable');
  assert.ok(unavailable.some((fact) => fact.factType === 'changed-symbol'));
  assert.ok(unavailable.some((fact) => fact.factType === 'contract-change'));
  assert.ok(unavailable.some((fact) => fact.factType === 'dependency-edge'));
  assert.ok(unavailable.some((fact) => fact.factType === 'runtime-frequency'
    && fact.reason.code === 'NO_RUNTIME_EVIDENCE'));
  assert.ok(unavailable.every((fact) => fact.claim === null
    && fact.assurance === 'not-applicable'
    && typeof fact.reason.attemptedProducer === 'string'));

  const viewLedger = first.viewFactLedgers[0];
  assert.ok(viewLedger.requiredFactIds.length >= 3);
  assert.equal(viewLedger.requiredUnavailableFactIds.length, 1);
  assert.ok(viewLedger.facts.length <= resolveBuiltInViewContract('dev.impact@4').facts.maximumSelectedFacts);

  const allViews = runDeterministicRegistration({
    root,
    scopeManifest: scope,
    requestedViews: ['arch.contracts@4', 'biz.rules@4', 'dev.hotspots@4', 'dev.impact@4']
  });
  assert.deepEqual(allViews.viewFactLedgers.map((ledger) => `${ledger.viewId}@${ledger.viewVersion}`), [
    'arch.contracts@4', 'biz.rules@4', 'dev.hotspots@4', 'dev.impact@4'
  ]);
  assert.ok(allViews.viewFactLedgers.every((ledger) => ledger.requiredFactIds.length > 0));
  assert.ok(allViews.viewFactLedgers.every((ledger) => ledger.requiredUnavailableFactIds.length > 0));

  const withoutRuntime = sealRecord({
    ...first.factLedger,
    facts: first.factLedger.facts.filter((fact) => fact.factType !== 'runtime-frequency')
  }, 'ledgerSha256');
  validateFactLedger(withoutRuntime);
  assert.throws(
    () => selectViewFacts({ factLedger: withoutRuntime, viewContract: resolveBuiltInViewContract('dev.impact@4') }),
    (error) => error.code === 'WMB_REQUIRED_UNAVAILABLE_FACT_MISSING'
  );

  const tampered = structuredClone(first.factLedger);
  tampered.facts[0].claim = tampered.facts[0].claim === null ? 'invented' : `${tampered.facts[0].claim} invented`;
  assert.throws(() => validateFactLedger(tampered));

  const runtime = await buildWorldModelV4(root, {
    views: ['dev.impact@4'],
    composer: 'deterministic',
    allowedPaths: ['src/**'],
    generatedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(runtime.status, 'ready-to-publish');
  assert.equal(runtime.availableViews.length, 1);
  assert.match(runtime.availableViews[0].markdown, /view: dev\.impact@4/);
});
