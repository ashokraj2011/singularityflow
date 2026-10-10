import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256 } from '../src/canonical-json.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import {
  buildCalmProjection, calmProjectionOptions, createArchitectureCapabilitySnapshot,
  createArchitectureConfigurationSnapshot, validateCalmProjectionCandidate
} from '../src/world-model/projections/calm/projection.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-calm-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'CALM Bridge Tests');
  git(root, 'config', 'user.email', 'calm@example.invalid');
  await mkdir(path.join(root, 'src', 'checkout'), { recursive: true });
  await mkdir(path.join(root, 'src', 'payments'), { recursive: true });
  await mkdir(path.join(root, 'shared'), { recursive: true });
  await writeFile(path.join(root, 'src', 'checkout', 'client.ts'), [
    "import { Payment } from '../payments/api';",
    "import { something } from 'reviewed-package';",
    "import missing from './missing';",
    'export interface Checkout { pay(value: string): void; }',
    'export class Client implements Checkout { pay(value: string) {} }', ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'payments', 'api.ts'), [
    'export interface Payment {',
    '  amount: number;',
    '}',
    'export const ready = true;', ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'payments', 'payment.schema.json'), JSON.stringify({
    type: 'object', properties: { amount: { type: 'number' } }
  }));
  await writeFile(path.join(root, 'shared', 'shared.ts'), 'export interface Shared { id: string; }\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'real extraction fixture');
  const scopeManifest = createScopeManifest({ capabilityId: 'checkout',
    allowedPaths: ['src'], sharedPaths: ['shared'] });
  const registration = runDeterministicRegistration({ root, scopeManifest });
  const definition = { capabilities: {
    checkout: { kind: 'delivery', sourceRoots: ['src/checkout'], architecture: { nodeType: 'webclient' },
      dependencies: [{ capability: 'payments', contract: { id: 'payments-api', version: '1.0.0',
        sha256: sha256('contract'), publicationSha256: sha256('publication'), publisherAuthority: 'architecture-reviewers' } }] },
    payments: { kind: 'delivery', sourceRoots: ['src/payments'], architecture: { nodeType: 'service' } }
  } };
  return { definition, input: {
    ...registration, subject: registration.sourceSnapshot.subject,
    sourceManifestSha256: registration.sourceSnapshot.sourceManifestSha256,
    scopeSha256: scopeManifest.scopeSha256,
    capabilitySnapshot: createArchitectureCapabilitySnapshot(definition),
    configurationSnapshot: createArchitectureConfigurationSnapshot({})
  } };
}

test('real registered prose facts produce source contracts and capability imports with exact provenance', async (t) => {
  const { input } = await fixture(t);
  const result = buildCalmProjection(input);
  assert.ok(input.factLedger.facts.some((fact) => fact.factType === 'interface' && !fact.claim.startsWith('{')));
  assert.ok(result.factSet.interfaces.some((item) => item.node === 'checkout'
    && item.value === 'src/checkout/client.ts#Checkout'));
  assert.ok(result.factSet.interfaces.some((item) => item.node === 'payments'
    && item.type === 'sflow-schema-contract'));
  assert.ok(result.factSet.interfaces.some((item) => item.type === 'sflow-source-field'));
  const edge = result.factSet.relationships.find((item) => item.source === 'checkout' && item.destination === 'payments');
  assert.equal(edge.status, 'confirmed');
  assert.equal(edge.protocol, null);
  assert.equal(edge.contract.id, 'payments-api');
  const source = edge.sources.find((item) => item.sourceKind === 'world-model-fact');
  const fact = input.factLedger.facts.find((item) => item.id === source.factId);
  assert.equal(source.sourceSha256, fact.factSha256);
  assert.deepEqual(source.evidenceIds, fact.evidenceIds);
  assert.equal(result.factSet.inputs.evidenceCatalogSha256, input.evidenceCatalog.catalogSha256);
  assert.ok(result.factSet.unavailable.some((item) => item.reason === 'capability-ownership-unavailable'));
  assert.ok(result.factSet.unavailable.some((item) => item.reason === 'import-target-not-architecture-classified'));
  assert.equal(result.factSet.relationships.some((item) => item.source === item.destination), false);
  const checked = await validateCalmProjectionCandidate(result);
  assert.equal(checked.validationResult.status, 'passed');
  assert.equal(buildCalmProjection(input).projectionBytes, result.projectionBytes);
});

test('external modules respect profile exclusion and never invent network protocols', async (t) => {
  const { input } = await fixture(t);
  const included = buildCalmProjection(input);
  const node = included.factSet.nodes.find((item) => item.layer === 'external');
  assert.equal(node.name, 'reviewed-package');
  assert.match(node.description, /no deployment or runtime transport/);
  const excluded = buildCalmProjection({ ...input, ...calmProjectionOptions({ profile: {
    includeExternalDependencies: 'off', includeFlows: false
  } }) });
  assert.equal(excluded.factSet.nodes.some((item) => item.layer === 'external'), false);
  assert.equal(excluded.factSet.relationships.some((item) => item.destination === node.id), false);
});

test('ambiguous source ownership is an explicit gap, not invented architecture', async (t) => {
  const { input, definition } = await fixture(t);
  definition.capabilities.shadow = { kind: 'delivery', sourceRoots: ['src/checkout'],
    architecture: { nodeType: 'system' } };
  const result = buildCalmProjection({ ...input,
    capabilitySnapshot: createArchitectureCapabilitySnapshot(definition) });
  assert.ok(result.factSet.unavailable.some((item) => item.reason === 'capability-ownership-ambiguous'));
  assert.equal(result.factSet.interfaces.some((item) => item.node === 'checkout'), false);
  assert.equal(result.factSet.relationships.some((item) => item.observed && item.source === 'checkout'), false);
});

test('the longest explicit capability prefix owns nested source, independent of input order', async (t) => {
  const { input, definition } = await fixture(t);
  definition.capabilities.platform = { kind: 'delivery', sourceRoots: ['src'], architecture: { nodeType: 'system' } };
  const result = buildCalmProjection({ ...input,
    capabilitySnapshot: createArchitectureCapabilitySnapshot(definition) });
  assert.ok(result.factSet.interfaces.some((item) => item.node === 'checkout'));
  assert.equal(result.factSet.interfaces.some((item) => item.node === 'platform'), false);
});

test('missing, edited or cross-source extraction catalogs cannot map CALM facts', async (t) => {
  const { input } = await fixture(t);
  assert.throws(() => buildCalmProjection({ ...input, evidenceCatalog: null }),
    (error) => error.code === 'WMC_FACT_SET_INVALID');
  assert.throws(() => buildCalmProjection({ ...input, sourceManifestSha256: sha256('other source') }),
    (error) => error.code === 'WMC_FACT_SET_INVALID');
  const edited = structuredClone(input.evidenceCatalog);
  edited.items[0].locator.path = 'src/other.ts';
  assert.throws(() => buildCalmProjection({ ...input, evidenceCatalog: edited }));
});

test('shared files do not inherit a selected capability without explicit ownership', async (t) => {
  const { input } = await fixture(t);
  const snapshot = createArchitectureCapabilitySnapshot({ capabilities: {
    checkout: { kind: 'delivery', sourceRoots: [], architecture: { nodeType: 'service' } }
  } });
  const result = buildCalmProjection({ ...input, capabilitySnapshot: snapshot });
  assert.ok(result.factSet.interfaces.some((item) => item.node === 'checkout'));
  assert.equal(result.factSet.interfaces.some((item) => item.value.startsWith('shared/')), false);
});
