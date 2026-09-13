import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { schemaFamily } from '../src/schema-migrations.mjs';
import {
  createTkrComposerContract,
  createTkrDeduplicationRules,
  createTkrNormalizationRules,
  createTkrOrderingRules,
  createTkrProtectedTextRules,
  createTkrRepresentationRules,
  parseCanonicalTkrContractBytes,
  TKR_COMPOSER_LIMITS,
  TKR_CONTRACT_FAMILIES,
  TKR_ERROR_CODES,
  tkrContractReference,
  tkrLogicalComposerContract,
  validateTkrComposerContract,
  validateTkrContractSet
} from '../src/token-reduction/contracts.mjs';
import { canonicalJson, sealRecord } from '../src/world-model/canonicalize.mjs';
import { WMP_RECORD_FAMILIES } from '../src/world-model/history/contracts.mjs';
import {
  createTkrRuntimeRendererRegistration,
  validateTkrRuntimeRendererClosure,
  validateTkrRuntimeRendererRegistration
} from '../src/token-reduction/renderer-contracts.mjs';
import { TKR_GENERATED_RENDERER_REF } from '../src/token-reduction/generated-renderer.mjs';

const HASH = (character) => `sha256:${character.repeat(64)}`;

function ruleContracts() {
  const common = { owner: 'sflow-core', contractId: 'tkr.default' };
  return [
    createTkrRepresentationRules({
      ...common,
      representations: [
        { id: 'full', completeness: 'complete', expansion: 'not-required' },
        { id: 'exact-excerpt', completeness: 'selected', expansion: 'required' },
        { id: 'deterministic-brief', completeness: 'selected', expansion: 'required' },
        { id: 'reference-only', completeness: 'selected', expansion: 'required' }
      ],
      undeclaredInputBehavior: 'preserve-existing-required-representation',
      emptyContentBehavior: 'refuse',
      unknownRequiredApplicabilityBehavior: 'refuse'
    }),
    createTkrDeduplicationRules({
      ...common,
      identity: 'owner-qualified-subject-revision-role',
      textEqualitySufficient: false,
      coverageProofRequired: true,
      revalidateAfterBudgeting: true,
      carrierRemoval: 'refuse-when-required-claims-depend'
    }),
    createTkrProtectedTextRules({
      ...common,
      sourceModes: ['verbatim', 'lossless-encoded'],
      normalizationScope: 'generated-framing-only',
      continuityProofRequired: true,
      verifyAfterComposition: true
    }),
    createTkrOrderingRules({
      ...common,
      stableOrder: 'declared-section-order',
      dynamicOrder: 'purpose-rule-qualified-subject',
      dependencyPolicy: 'preserve',
      rolePolicy: 'preserve',
      setOrdering: 'unicode-code-point'
    }),
    createTkrNormalizationRules({
      ...common,
      scope: 'generated-framing-only',
      sourceBytes: 'unchanged',
      authorityBytes: 'unchanged',
      generatedLineEndings: 'lf',
      generatedWhitespace: 'preserve'
    })
  ];
}

function renderer(purpose, character) {
  return `sflow-core/tkr/renderer/${purpose}.default@1#${HASH(character)}`;
}

function rendererContracts(refs) {
  return refs.map((rendererRef) => {
    const match = /^([^/]+)\/tkr\/renderer\/([^@]+)@/u.exec(rendererRef);
    return createTkrRuntimeRendererRegistration({
      owner: match[1], rendererId: match[2], rendererRef,
      mode: 'source-pass-through', format: 'literal-utf8',
      implementationSha256: rendererRef.slice(rendererRef.indexOf('#') + 1)
    });
  });
}

function composerFixture(overrides = {}) {
  const contracts = overrides.contracts ?? ruleContracts();
  const byKind = new Map(contracts.map((record) => [record.kind, record]));
  const values = {
    owner: 'sflow-core',
    contractId: 'tkr.default',
    sectionRules: [
      {
        id: 'phase-contract', slot: 'governed-context',
        orderGroup: 'governed-contracts', stability: 'invariant',
        permittedRoles: ['policy'], dependencies: [], generator: null, rendererRef: null
      },
      {
        id: 'active-clause-capsule', slot: 'governed-context',
        orderGroup: 'governed-contracts', stability: 'dynamic',
        permittedRoles: ['evidence'], dependencies: ['phase-contract'],
        generator: null, rendererRef: null
      }
    ],
    representationRulesRef: tkrContractReference(byKind.get('tkr/representation-rules')),
    deduplicationRulesRef: tkrContractReference(byKind.get('tkr/deduplication-rules')),
    renderers: [
      renderer('capsule', '1'), renderer('input-projection', '2'),
      renderer('phase-contract', '3'), renderer('label', '4')
    ],
    protectedTextRulesRef: tkrContractReference(byKind.get('tkr/protected-text-rules')),
    orderingRulesRef: tkrContractReference(byKind.get('tkr/ordering-rules')),
    normalizationRulesRef: tkrContractReference(byKind.get('tkr/normalization-rules')),
    limits: { ...TKR_COMPOSER_LIMITS },
    ...overrides.values
  };
  const registeredRenderers = overrides.rendererContracts ?? rendererContracts(values.renderers);
  return {
    contracts,
    rendererContracts: registeredRenderers,
    composer: createTkrComposerContract(values, {
      contracts, rendererContracts: registeredRenderers
    })
  };
}

function reseal(value) {
  const core = structuredClone(value);
  delete core.contractSha256;
  return sealRecord(core, 'contractSha256');
}

test('TKR M0 families are frozen immutable identities and do not change WMP families', () => {
  assert.equal(TKR_CONTRACT_FAMILIES.length, 6);
  for (const familyId of TKR_CONTRACT_FAMILIES) {
    const family = schemaFamily(familyId);
    assert.equal(family.currentVersion, 1, familyId);
    assert.equal(family.immutable, true, familyId);
    assert.equal(family.migrationPolicy, 'frozen-identity', familyId);
  }
  assert.deepEqual(WMP_RECORD_FAMILIES, [
    'world-model-model-binding', 'world-model-view-inputs', 'world-model-view-binding',
    'world-model-grounding-reference', 'world-model-handoff',
    'world-model-source-adoption'
  ]);
  assert.deepEqual(TKR_ERROR_CODES, [
    'TKR_ALIAS_INVALID', 'TKR_CONTRACT_UNSUPPORTED', 'TKR_COVERAGE_UNPROVEN',
    'TKR_LIMIT_EXCEEDED', 'TKR_PROTECTED_CONTENT_CHANGED', 'TKR_RENDER_CONFLICT'
  ]);
});

test('a composer closes over five exact owner/version/digest rule contracts', () => {
  const accepted = composerFixture();
  const set = validateTkrContractSet(accepted);
  assert.equal(set.composer.kind, 'tkr/composer-contract');
  assert.equal(set.composer.schemaVersion, 1);
  assert.equal(set.composer.version, 1);
  assert.equal(set.contracts.length, 5);
  assert.equal(set.rendererContracts.length, 4);
  assert.ok(Object.isFrozen(set.composer));
  assert.ok(Object.isFrozen(set.composer.limits));
  assert.deepEqual(tkrLogicalComposerContract(set.composer, {
    contracts: set.contracts,
    rendererContracts: set.rendererContracts
  }), {
    kind: 'tkr/composer-contract',
    version: 1,
    sectionRules: set.composer.sectionRules,
    representationRulesRef: set.composer.representationRulesRef,
    deduplicationRulesRef: set.composer.deduplicationRulesRef,
    renderers: set.composer.renderers,
    protectedTextRulesRef: set.composer.protectedTextRulesRef,
    orderingRulesRef: set.composer.orderingRulesRef,
    normalizationRulesRef: set.composer.normalizationRulesRef,
    limits: set.composer.limits
  });

  const bytes = Buffer.from(canonicalJson(set.composer), 'utf8');
  assert.throws(() => parseCanonicalTkrContractBytes(
    'token-reduction-composer-contract', bytes
  ), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');
  assert.deepEqual(parseCanonicalTkrContractBytes(
    'token-reduction-composer-contract', bytes, {
      contracts: set.contracts, rendererContracts: set.rendererContracts
    }
  ), set.composer);
});

test('every referenced contract family accepts canonical bytes and refuses malformed or wrong-owner records', () => {
  const accepted = composerFixture();
  for (const [index, contract] of accepted.contracts.entries()) {
    const family = `token-reduction-${contract.kind.slice('tkr/'.length)}`;
    const canonical = Buffer.from(canonicalJson(contract), 'utf8');
    assert.deepEqual(parseCanonicalTkrContractBytes(family, canonical), contract, family);

    const malformed = reseal({ ...contract, ambientPolicy: 'latest' });
    assert.throws(() => parseCanonicalTkrContractBytes(
      family, Buffer.from(canonicalJson(malformed), 'utf8')
    ), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && error.details.unknown.includes('ambientPolicy'), `${family}: malformed fixture`);

    const wrongOwner = structuredClone(contract);
    wrongOwner.owner = 'unreviewed-owner';
    const contracts = accepted.contracts.map((entry, candidateIndex) => (
      candidateIndex === index ? reseal(wrongOwner) : entry
    ));
    assert.throws(() => validateTkrContractSet({
      composer: accepted.composer,
      contracts,
      rendererContracts: accepted.rendererContracts
    }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED',
    `${family}: referenced owner validation`);
  }
});

test('unknown fields, duplicate JSON keys, duplicates, and unsupported versions fail closed', () => {
  const accepted = composerFixture();
  const unknown = reseal({ ...accepted.composer, ambientRenderer: 'latest' });
  assert.throws(() => validateTkrComposerContract(unknown), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && error.details.unknown.includes('ambientRenderer')
  ));

  const duplicateSection = structuredClone(accepted.composer);
  duplicateSection.sectionRules.push(structuredClone(duplicateSection.sectionRules[0]));
  assert.throws(() => validateTkrComposerContract(reseal(duplicateSection)), (error) => (
    error.code === 'TKR_RENDER_CONFLICT'
  ));

  const duplicateRenderer = structuredClone(accepted.composer);
  duplicateRenderer.renderers[1] = duplicateRenderer.renderers[0];
  assert.throws(() => validateTkrComposerContract(reseal(duplicateRenderer)), (error) => (
    error.code === 'TKR_RENDER_CONFLICT'
  ));

  const unsupportedLogical = reseal({ ...accepted.composer, version: 2 });
  assert.throws(() => validateTkrComposerContract(unsupportedLogical), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
  ));
  const unsupportedSchema = reseal({ ...accepted.composer, schemaVersion: 2 });
  assert.throws(() => validateTkrComposerContract(unsupportedSchema), (error) => (
    error.code === 'TKR_CONTRACT_UNSUPPORTED'
  ));

  const canonical = canonicalJson(accepted.composer);
  const duplicateKey = Buffer.from(canonical.replace(
    '{\n', '{\n  "schemaVersion": 1,\n'
  ), 'utf8');
  assert.throws(() => parseCanonicalTkrContractBytes(
    'token-reduction-composer-contract', duplicateKey, {
      contracts: accepted.contracts, rendererContracts: accepted.rendererContracts
    }
  ), (error) => error.code === 'TKR_RENDER_CONFLICT');
});

test('hash, owner binding, dependency order, and finite limits cannot be weakened', () => {
  const accepted = composerFixture();
  const altered = structuredClone(accepted.composer);
  altered.sectionRules[0].stability = 'dynamic';
  assert.throws(() => validateTkrComposerContract(altered), (error) => (
    error.code === 'TKR_RENDER_CONFLICT' && /integrity/.test(error.message)
  ));

  const wrongOwner = structuredClone(accepted.composer);
  wrongOwner.representationRulesRef = wrongOwner.representationRulesRef.replace(
    /^sflow-core\//, 'unreviewed-owner/'
  );
  assert.throws(() => validateTkrContractSet({
    composer: reseal(wrongOwner), contracts: accepted.contracts,
    rendererContracts: accepted.rendererContracts
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
    && error.details.owner === 'unreviewed-owner');

  const futureDependency = structuredClone(accepted.composer);
  futureDependency.sectionRules[0].dependencies = ['active-clause-capsule'];
  assert.throws(() => validateTkrComposerContract(reseal(futureDependency)), (error) => (
    error.code === 'TKR_RENDER_CONFLICT'
  ));

  for (const [field, value] of [
    ['maximumSections', 0],
    ['maximumCandidatesPerSubject', 5],
    ['maximumCoverageClaims', 4097],
    ['maximumAliases', 1025],
    ['maximumWorkingMetadataBytes', 16777217]
  ]) {
    const invalid = structuredClone(accepted.composer);
    invalid.limits[field] = value;
    assert.throws(() => validateTkrComposerContract(reseal(invalid)), (error) => (
      error.code === 'TKR_LIMIT_EXCEEDED' && error.details.limit.endsWith(field)
    ), field);
  }
});

test('runtime renderer registrations are exact, self-hashed, and close every composer renderer', () => {
  const accepted = composerFixture();
  for (const registration of accepted.rendererContracts) {
    assert.deepEqual(validateTkrRuntimeRendererRegistration(registration), registration);
    assert.ok(Object.isFrozen(registration));
    assert.match(registration.registrationSha256, /^sha256:[a-f0-9]{64}$/u);
  }

  const tampered = structuredClone(accepted.rendererContracts[0]);
  tampered.format = 'canonical-json-utf8';
  assert.throws(() => validateTkrRuntimeRendererRegistration(tampered), (error) => (
    error.code === 'TKR_RENDER_CONFLICT'
  ));

  const invented = structuredClone(accepted.composer);
  invented.renderers[0] = renderer('invented', '9');
  const resealed = reseal(invented);
  assert.throws(() => validateTkrContractSet({
    composer: resealed,
    contracts: accepted.contracts,
    rendererContracts: accepted.rendererContracts
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && error.details.missing.includes(invented.renderers[0]));
  assert.throws(() => tkrLogicalComposerContract(accepted.composer, {
    contracts: accepted.contracts
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');
  assert.throws(() => validateTkrContractSet({
    composer: accepted.composer,
    contracts: accepted.contracts,
    rendererContracts: [
      ...accepted.rendererContracts,
      accepted.rendererContracts[0]
    ]
  }), (error) => error.code === 'TKR_RENDER_CONFLICT');
});

test('runtime renderer closure enforces its finite count before reading entries', () => {
  const accepted = composerFixture();
  const oversized = Array.from({ length: TKR_COMPOSER_LIMITS.maximumSections + 1 }, () => null);
  Object.defineProperty(oversized, 0, {
    get() {
      throw new Error('renderer entry was read before the count guard');
    }
  });
  assert.throws(
    () => validateTkrRuntimeRendererClosure(accepted.composer, oversized),
    (error) => error.code === 'TKR_LIMIT_EXCEEDED'
      && error.details.limit === 'maximumRendererContracts'
      && error.details.maximum === TKR_COMPOSER_LIMITS.maximumSections
      && error.details.required === TKR_COMPOSER_LIMITS.maximumSections + 1
  );
});

test('runtime renderer closure rejects a self-hashed generated renderer it cannot execute', () => {
  const inventedRef = renderer('invented-generated', '9');
  const invented = createTkrRuntimeRendererRegistration({
    owner: 'sflow-core',
    rendererId: 'invented-generated.default',
    rendererRef: inventedRef,
    mode: 'generated-framing',
    format: 'canonical-json-utf8',
    implementationSha256: HASH('9')
  });
  assert.notEqual(invented.rendererRef, TKR_GENERATED_RENDERER_REF);
  assert.throws(() => validateTkrRuntimeRendererClosure({
    renderers: [inventedRef],
    sectionRules: [{
      id: 'alias-table', generator: 'alias-table', rendererRef: inventedRef
    }]
  }, [invented]), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
      && error.details.supportedRendererRef === TKR_GENERATED_RENDERER_REF);
});

test('packaged TKR schemas are closed and pinned to registered v1 owners', async () => {
  for (const family of TKR_CONTRACT_FAMILIES) {
    const schema = JSON.parse(await readFile(new URL(
      `../schemas/${family}.schema.json`, import.meta.url
    ), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.schemaVersion.const, schemaFamily(family).currentVersion);
    assert.equal(schema.properties.kind.const,
      family.replace(/^token-reduction-/, 'tkr/').replace(/-(rules|contract)$/, '-$1')
        .replace('composer-contract', 'composer-contract'));
  }
});
