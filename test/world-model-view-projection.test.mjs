import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/world-model/canonicalize.mjs';
import {
  createViewProjectionRegistration, runDeterministicRegistration
} from '../src/world-model/extract/index.mjs';
import {
  REQUIRED_FACT_COVERAGE_ID
} from '../src/world-model/extract/adapters/required-fact-coverage.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';
import { BUILTIN_VIEW_REGISTRY } from '../src/world-model/registry/views.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-view-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'projection@example.invalid');
  git(root, 'config', 'user.name', 'Projection Tests');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'service.mjs'), [
    "import { tax } from './tax.mjs';",
    'export function total(value) { return value + tax(value); }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'tax.mjs'), 'export const tax = (value) => value * 0.1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'projection fixture');
  return root;
}

function activeViews() {
  return BUILTIN_VIEW_REGISTRY.contracts.filter(
    (contract) => contract.validity.status === 'active'
  );
}

test('view projection overlays coverage without source extraction and matches a fresh registration', async (t) => {
  const root = await repository(t);
  const scopeManifest = createScopeManifest({
    capabilityId: 'view-projection', allowedPaths: ['src/**']
  });
  const base = runDeterministicRegistration({
    root, scopeManifest, requestedViews: []
  });
  const immutableBase = canonicalJson({
    evidenceCatalog: base.evidenceCatalog,
    derivationCatalog: base.derivationCatalog,
    factLedger: base.factLedger
  });
  assert.equal(base.derivationCatalog.derivations.some(
    (entry) => entry.extractor.id === REQUIRED_FACT_COVERAGE_ID
  ), false);

  // This pure call has no repository-root argument. It can only consume accepted records.
  const projected = createViewProjectionRegistration({
    sourceSnapshot: base.sourceSnapshot,
    scopeManifest: base.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    viewRegistry: BUILTIN_VIEW_REGISTRY,
    evidenceCatalog: base.evidenceCatalog,
    derivationCatalog: base.derivationCatalog,
    factLedger: base.factLedger,
    viewContracts: activeViews()
  });
  const fresh = runDeterministicRegistration({
    root, scopeManifest, requestedViews: activeViews()
  });

  assert.equal(projected.evidenceCatalog.catalogSha256, base.evidenceCatalog.catalogSha256);
  assert.equal(
    canonicalJson(projected.derivationCatalog), canonicalJson(fresh.derivationCatalog)
  );
  assert.equal(canonicalJson(projected.factLedger), canonicalJson(fresh.factLedger));
  assert.equal(
    canonicalJson(projected.viewFactLedgers), canonicalJson(fresh.viewFactLedgers)
  );
  assert.equal(canonicalJson({
    evidenceCatalog: base.evidenceCatalog,
    derivationCatalog: base.derivationCatalog,
    factLedger: base.factLedger
  }), immutableBase);
  assert.equal(Object.isFrozen(projected), true);
});

test('view projection refuses a base that already owns view-dependent coverage', async (t) => {
  const root = await repository(t);
  const scopeManifest = createScopeManifest({
    capabilityId: 'view-projection', allowedPaths: ['src/**']
  });
  const full = runDeterministicRegistration({
    root, scopeManifest, requestedViews: activeViews()
  });
  assert.throws(() => createViewProjectionRegistration({
    sourceSnapshot: full.sourceSnapshot,
    scopeManifest: full.scopeManifest,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    viewRegistry: BUILTIN_VIEW_REGISTRY,
    evidenceCatalog: full.evidenceCatalog,
    derivationCatalog: full.derivationCatalog,
    factLedger: full.factLedger,
    viewContracts: activeViews()
  }), (error) => error?.code === 'WMP_PROJECTION_BASE_INVALID');
});
