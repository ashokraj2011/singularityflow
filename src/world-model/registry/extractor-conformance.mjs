import { canonicalJson, sealRecord, sha256 } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { extractImports, extractSymbols } from '../../repository-facts.mjs';
import {
  scanLocalCallAndReferenceEdges,
  scanClauseBindings, scanCodeowners, scanInterfaceContracts, scanProtocolFields,
  scanRuleObjects, scanSchemaContract, scanSignaturesAndExports, scanTestIdentities,
  parseConfigurationObject,
  extractLanguages, extractPolyglotImports, extractPolyglotSymbols, extractRepositoryFiles,
  extractRequiredFactCoverage,
  parseUnifiedZeroContextDiff, parseRuntimeObservationImport,
  parseHumanConfirmedKnowledgeImport,
  CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256, CALL_REFERENCE_EDGE_VERSION,
  CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256, CLAUSE_CODE_BINDING_VERSION,
  CHANGE_REGION_IMPLEMENTATION_SHA256, CHANGE_REGION_VERSION,
  CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256, CONFIGURATION_OBJECT_VERSION,
  IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256, IMPORT_DEPENDENCY_VERSION,
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256,
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION,
  INTERFACE_CONTRACT_IMPLEMENTATION_SHA256, INTERFACE_CONTRACT_VERSION,
  LANGUAGE_DETECTION_IMPLEMENTATION_SHA256, LANGUAGE_DETECTION_VERSION,
  LEGACY_MIGRATION_RESOLUTION_IMPLEMENTATION_SHA256, LEGACY_MIGRATION_RESOLUTION_VERSION,
  OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256, OWNERSHIP_MAINTAINER_RECORD_VERSION,
  REPOSITORY_FILES_IMPLEMENTATION_SHA256, REPOSITORY_FILES_VERSION,
  REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256, REQUIRED_FACT_COVERAGE_VERSION,
  RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256, RUNTIME_OBSERVATION_IMPORT_VERSION,
  RULE_DEFINITION_IMPLEMENTATION_SHA256, RULE_DEFINITION_VERSION,
  SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256, SIGNATURE_AND_EXPORT_VERSION,
  SYMBOL_SKELETON_IMPLEMENTATION_SHA256, SYMBOL_SKELETON_VERSION,
  TEST_IDENTITY_IMPLEMENTATION_SHA256, TEST_IDENTITY_VERSION
} from '../extract/adapters/index.mjs';
import { extractLegacyMigrationUnavailableFacts } from '../extract/adapters/legacy-migration-resolution.mjs';
import { createScopeManifest } from '../scope/manifest.mjs';
import { contractFailure } from '../contracts.mjs';
import { BUILTIN_VIEW_REGISTRY, resolveViewContract } from './views.mjs';

const JS_FIXTURE = [
  '// export function commentDecoy() {}',
  "const text = \"require('./string-decoy.mjs')\";",
  "import { real } from './real.mjs';",
  "const required = require('./required.cjs');",
  'export function actual() { return real + required; }',
  ''
].join('\n');

const JAVA_FIXTURE = [
  'package com.acme;',
  'import com.acme.RealDependency;',
  '// import com.acme.Decoy;',
  'public final class OrderService {',
  '  private String decoy = "class Hidden {}";',
  '  public void calculate() {}',
  '}',
  ''
].join('\n');

const PYTHON_FIXTURE = [
  'from collections import defaultdict',
  '"""class Hidden:',
  '    pass',
  '"""',
  'class Calculator:',
  '    def compute(self):',
  '        return defaultdict(int)',
  ''
].join('\n');

const INTERFACE_FIXTURE = [
  'export interface Gateway {',
  '  send(value: string): void;',
  '}',
  'export class Client implements Gateway {',
  '  send(value: string) {}',
  '}',
  'const decoy = "interface Hidden {}";',
  ''
].join('\n');

const CONFIGURATION_FIXTURE = [
  'version: 1',
  'rules:',
  '  allow-write:',
  '    when: actor',
  'secret: do-not-copy',
  ''
].join('\n');

const SCHEMA_FIXTURE = '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"}},"secret":"DO_NOT_EMIT"}';

const TEST_FIXTURE = [
  "test('real case', () => 1);",
  "// test('comment decoy', () => 1);",
  'const text = "test(\\\'string decoy\\\')";',
  ''
].join('\n');

const CLAUSE_FIXTURE = [
  '// @ac:AC-001',
  'const text = "// @ac:AC-999";',
  '/* @clause:REQ-002 */',
  ''
].join('\n');

const CODEOWNERS_FIXTURE = [
  '# /decoy/** @nobody',
  '/src/** @acme/backend @alice',
  '/docs/** @acme/docs',
  'invalid\\ pattern @owner',
  ''
].join('\n');

const EDGE_FIXTURE = [
  'export function target() { return 1; }',
  'export function invoke() { return target(); }',
  'export const reference = target;',
  'const decoy = "target()";',
  '// target();',
  ''
].join('\n');

const CHANGE_DIFF_FIXTURE = [
  'diff --git a/src/a.ts b/src/a.ts',
  '@@ -2,0 +3,2 @@',
  '+changed',
  '+changed again',
  '@@ -10 +12 @@',
  '-old',
  '+new',
  '@@ -20 +22,0 @@',
  '-deleted',
  ''
].join('\n');

const RUNTIME_RECORD_FIXTURE = sealRecord({
  schemaVersion: 1,
  kind: 'world-model-runtime-observation',
  id: 'checkout-frequency',
  metric: 'frequency',
  subjectId: 'checkout',
  count: 7,
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-01-02T00:00:00.000Z',
  producerId: 'otel-exporter',
  producerVersion: '1.0.0',
  receiptSha256: sha256('runtime-receipt')
}, 'recordSha256');
const RUNTIME_IMPORT_FIXTURE = canonicalJson({
  schemaVersion: 1,
  kind: 'world-model-runtime-observation-import',
  records: [RUNTIME_RECORD_FIXTURE]
});

const HUMAN_RECORD_FIXTURE = sealRecord({
  schemaVersion: 1,
  kind: 'world-model-human-confirmed-knowledge',
  id: 'annual-percentage-rate',
  factType: 'business-glossary',
  term: 'APR',
  statement: 'Annual percentage rate used for the governed interest calculation.',
  confirmation: {
    status: 'confirmed',
    authorityId: 'product-approvers',
    identitySha256: sha256('reviewer-identity'),
    confirmedAt: '2026-01-01T00:00:00.000Z',
    receiptSha256: sha256('approval-receipt')
  }
}, 'recordSha256');
const HUMAN_IMPORT_FIXTURE = canonicalJson({
  schemaVersion: 1,
  kind: 'world-model-human-confirmed-knowledge-import',
  records: [HUMAN_RECORD_FIXTURE]
});

const SUITES = Object.freeze({
  'call-reference-edge': Object.freeze({
    extractor: Object.freeze({
      version: CALL_REFERENCE_EDGE_VERSION,
      implementationSha256: CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({
      id: 'closed-local-call-reference-candidates', version: '1.0.0',
      grammarSha256: sha256('single-pass-bounded-same-file-declaration-call-and-reference-candidates-v2')
    }),
    fixtures: Object.freeze([
      {
        id: 'calls-references-and-decoys', class: 'positive-security',
        inputSha256: sha256(EDGE_FIXTURE),
        expected: ['call-edge:target:2', 'reference-edge:target:3']
      }
    ])
  }),
  'clause-code-binding': Object.freeze({
    extractor: Object.freeze({
      version: CLAUSE_CODE_BINDING_VERSION,
      implementationSha256: CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'explicit-clause-comment-tags', version: '1.0.0', grammarSha256: sha256('explicit-clause-comment-tags-v1') }),
    fixtures: Object.freeze([
      { id: 'explicit-tags-and-string-decoy', class: 'positive-security', inputSha256: sha256(CLAUSE_FIXTURE), expected: ['AC-001:1', 'REQ-002:3'] }
    ])
  }),
  'change-region': Object.freeze({
    extractor: Object.freeze({
      version: CHANGE_REGION_VERSION,
      implementationSha256: CHANGE_REGION_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({
      id: 'git-zero-context-current-ranges', version: '1.0.0',
      grammarSha256: sha256('git-unified-zero-context-current-ranges-v1')
    }),
    fixtures: Object.freeze([
      {
        id: 'current-ranges-and-deletion', class: 'positive-negative',
        inputSha256: sha256(CHANGE_DIFF_FIXTURE),
        expected: ['3-4', '12-12']
      }
    ])
  }),
  'configuration-object': Object.freeze({
    extractor: Object.freeze({
      version: CONFIGURATION_OBJECT_VERSION,
      implementationSha256: CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-configuration-object', version: '1.0.0', grammarSha256: sha256('closed-json-yaml-toml-properties-configuration-v1') }),
    fixtures: Object.freeze([
      { id: 'yaml-key-inventory-with-secret-value', class: 'positive-security', inputSha256: sha256(CONFIGURATION_FIXTURE), expected: ['rules', 'secret', 'version'] },
      { id: 'duplicate-json-key-refused', class: 'negative', inputSha256: sha256('{"a":1,"a":2}'), expected: 'PARSE_FAILURE' }
    ])
  }),
  'human-confirmed-knowledge-import': Object.freeze({
    extractor: Object.freeze({
      version: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION,
      implementationSha256: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({
      id: 'sealed-human-confirmed-business-knowledge', version: '1.0.0',
      grammarSha256: sha256('sealed-bounded-human-confirmed-business-knowledge-import-v1')
    }),
    fixtures: Object.freeze([
      {
        id: 'sealed-confirmed-glossary', class: 'positive-security',
        inputSha256: sha256(HUMAN_IMPORT_FIXTURE),
        expected: ['annual-percentage-rate:business-glossary:APR']
      }
    ])
  }),
  'import-dependency': Object.freeze({
    extractor: Object.freeze({
      version: IMPORT_DEPENDENCY_VERSION,
      implementationSha256: IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'sflow-polyglot-lexical-imports', version: '3.0.0', grammarSha256: sha256('reviewed-polyglot-import-grammar-v3') }),
    fixtures: Object.freeze([
      { id: 'imports-positive-and-decoys', class: 'positive-security', inputSha256: sha256(JS_FIXTURE), expected: ['./real.mjs', './required.cjs'] },
      { id: 'imports-comments-only', class: 'negative', inputSha256: sha256("// require('./no.mjs')\n"), expected: [] },
      { id: 'java-import-and-decoy', class: 'positive-security', inputSha256: sha256(JAVA_FIXTURE), expected: ['com.acme.RealDependency'] },
      { id: 'python-import-and-docstring-decoy', class: 'positive-security', inputSha256: sha256(PYTHON_FIXTURE), expected: ['collections'] }
    ])
  }),
  'language-detection': Object.freeze({
    extractor: Object.freeze({
      version: LANGUAGE_DETECTION_VERSION,
      implementationSha256: LANGUAGE_DETECTION_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-extension-map', version: '1.0.0', grammarSha256: sha256('wmb-language-extension-v1') }),
    fixtures: Object.freeze([
      { id: 'known-and-unknown-extensions', class: 'positive-negative', inputSha256: sha256(['src/a.ts', 'src/readme.txt']), expected: ['typescript'] }
    ])
  }),
  'legacy-migration-resolution': Object.freeze({
    extractor: Object.freeze({
      version: LEGACY_MIGRATION_RESOLUTION_VERSION,
      implementationSha256: LEGACY_MIGRATION_RESOLUTION_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({
      id: 'legacy-claim-digest-resolution', version: '1.0.0',
      grammarSha256: sha256('legacy-claim-identity-and-current-registration-v1')
    }),
    fixtures: Object.freeze([
      {
        id: 'unresolved-prose-is-not-promoted', class: 'negative-security',
        inputSha256: sha256({ sourceClaimIndex: 3, sourceClaimSha256: sha256('untrusted prose') }),
        expected: ['runtime-frequency:unavailable:legacy-migration-resolution']
      }
    ])
  }),
  'interface-contract': Object.freeze({
    extractor: Object.freeze({
      version: INTERFACE_CONTRACT_VERSION,
      implementationSha256: INTERFACE_CONTRACT_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-interface-contract', version: '2.0.0', grammarSha256: sha256('closed-explicit-interface-implementation-field-schema-v2') }),
    fixtures: Object.freeze([
      { id: 'typescript-interface-fields-implementation-and-string-decoy', class: 'positive-security', inputSha256: sha256(INTERFACE_FIXTURE), expected: ['interface:Gateway:1', 'implementation:Client:Gateway:4', 'field:Gateway:send:2'] },
      { id: 'json-schema-fields-with-value-exclusion', class: 'positive-security', inputSha256: sha256(SCHEMA_FIXTURE), expected: ['schema:id,name'] }
    ])
  }),
  'ownership-maintainer-record': Object.freeze({
    extractor: Object.freeze({
      version: OWNERSHIP_MAINTAINER_RECORD_VERSION,
      implementationSha256: OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-codeowners-records', version: '1.0.0', grammarSha256: sha256('closed-codeowners-records-v1') }),
    fixtures: Object.freeze([
      { id: 'owners-comment-and-unsupported-escape', class: 'positive-negative', inputSha256: sha256(CODEOWNERS_FIXTURE), expected: ['@acme/backend:/src/**:2', '@alice:/src/**:2', '@acme/docs:/docs/**:3', 'unavailable:4'] }
    ])
  }),
  'repository-files': Object.freeze({
    extractor: Object.freeze({
      version: REPOSITORY_FILES_VERSION,
      implementationSha256: REPOSITORY_FILES_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'pinned-git-tree-projection', version: '1.0.0', grammarSha256: sha256('git-tree-entry-v1') }),
    fixtures: Object.freeze([
      { id: 'inside-and-excluded-files', class: 'positive-scope', inputSha256: sha256(['src/a.ts', 'vendor/no.ts']), expected: ['src/a.ts'] }
    ])
  }),
  'required-fact-coverage': Object.freeze({
    extractor: Object.freeze({
      version: REQUIRED_FACT_COVERAGE_VERSION,
      implementationSha256: REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-fact-requirement-coverage', version: '1.0.0', grammarSha256: sha256('wmb-fact-types-v1') }),
    fixtures: Object.freeze([
      { id: 'missing-runtime-fact', class: 'negative-unavailable', inputSha256: sha256('runtime-frequency'), expected: ['runtime-frequency'] }
    ])
  }),
  'runtime-observation-import': Object.freeze({
    extractor: Object.freeze({
      version: RUNTIME_OBSERVATION_IMPORT_VERSION,
      implementationSha256: RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({
      id: 'sealed-runtime-frequency-observations', version: '1.0.0',
      grammarSha256: sha256('sealed-bounded-runtime-frequency-record-import-v1')
    }),
    fixtures: Object.freeze([
      {
        id: 'sealed-runtime-frequency', class: 'positive-security',
        inputSha256: sha256(RUNTIME_IMPORT_FIXTURE),
        expected: ['checkout-frequency:checkout:7']
      }
    ])
  }),
  'rule-definition': Object.freeze({
    extractor: Object.freeze({
      version: RULE_DEFINITION_VERSION,
      implementationSha256: RULE_DEFINITION_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-rule-object', version: '1.0.0', grammarSha256: sha256('closed-named-rule-container-v1') }),
    fixtures: Object.freeze([
      { id: 'named-rule-with-condition-presence', class: 'positive-security', inputSha256: sha256(CONFIGURATION_FIXTURE), expected: ['rules.allow-write:when'] }
    ])
  }),
  'signature-and-export': Object.freeze({
    extractor: Object.freeze({
      version: SIGNATURE_AND_EXPORT_VERSION,
      implementationSha256: SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-structural-signature', version: '1.0.0', grammarSha256: sha256('closed-body-free-signature-export-v1') }),
    fixtures: Object.freeze([
      { id: 'javascript-export-and-decoys', class: 'positive-security', inputSha256: sha256(JS_FIXTURE), expected: ['actual:export function actual():export'] },
      { id: 'comments-only', class: 'negative', inputSha256: sha256('// export class No {}\n'), expected: [] }
    ])
  }),
  'symbol-skeleton': Object.freeze({
    extractor: Object.freeze({
      version: SYMBOL_SKELETON_VERSION,
      implementationSha256: SYMBOL_SKELETON_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'sflow-polyglot-lexical-symbols', version: '3.0.0', grammarSha256: sha256('reviewed-polyglot-symbol-grammar-v3') }),
    fixtures: Object.freeze([
      { id: 'symbols-positive-and-decoys', class: 'positive-security', inputSha256: sha256(JS_FIXTURE), expected: ['actual'] },
      { id: 'symbols-comments-only', class: 'negative', inputSha256: sha256('// export class No {}\n'), expected: [] },
      { id: 'java-symbols-and-decoys', class: 'positive-security', inputSha256: sha256(JAVA_FIXTURE), expected: ['OrderService', 'calculate'] },
      { id: 'python-symbols-and-docstring-decoy', class: 'positive-security', inputSha256: sha256(PYTHON_FIXTURE), expected: ['Calculator', 'compute'] }
    ])
  }),
  'test-identity': Object.freeze({
    extractor: Object.freeze({
      version: TEST_IDENTITY_VERSION,
      implementationSha256: TEST_IDENTITY_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'closed-test-identity', version: '1.0.0', grammarSha256: sha256('closed-framework-test-identities-v1') }),
    fixtures: Object.freeze([
      { id: 'javascript-test-and-decoys', class: 'positive-security', inputSha256: sha256(TEST_FIXTURE), expected: ['test:real case:1'] }
    ])
  })
});

function syntheticContext() {
  const scopeManifest = createScopeManifest({
    capabilityId: 'extractor-conformance', allowedPaths: ['src/**'], excludedPaths: ['vendor/**']
  });
  const sourceSnapshot = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-source-snapshot'),
    kind: 'world-model-source-snapshot',
    subject: { kind: 'repository', id: 'extractor-conformance' },
    revision: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
    files: [
      { path: 'src/a.ts', type: 'regular', mode: '100644', contentSha256: sha256('source-a'), bytes: 8 },
      { path: 'vendor/no.ts', type: 'regular', mode: '100644', contentSha256: sha256('source-no'), bytes: 9 }
    ],
    lineEndingPolicy: 'preserve-source', pathNormalization: 'posix-relative'
  }, 'sourceManifestSha256');
  return { scopeManifest, sourceSnapshot };
}

function observedFixtureOutputs() {
  const context = syntheticContext();
  const coverage = extractRequiredFactCoverage({
    viewContracts: [{
      id: 'fixture.view', version: 1,
      factPolicy: { requiredFactTypes: ['runtime-frequency'], requiredUnavailableSubjects: [] }
    }],
    existingFacts: []
  });
  const migration = extractLegacyMigrationUnavailableFacts({
    sourceViewSha256: sha256('legacy-view'),
    unresolvedClaims: [{
      sourceClaimIndex: 3,
      sourceClaimSha256: sha256({ text: 'untrusted prose' }),
      status: 'unavailable',
      reason: 'no-registered-fact-match',
      evidenceCandidates: []
    }],
    scopeManifest: context.scopeManifest,
    viewContract: resolveViewContract(BUILTIN_VIEW_REGISTRY, 'dev.impact@4')
  });
  return {
    'call-reference-edge': [scanLocalCallAndReferenceEdges(
      EDGE_FIXTURE, 'src/edge.ts', 'typescript'
    ).edges.map((item) => `${item.edgeKind}:${item.name}:${item.referenceLine}`)],
    'clause-code-binding': [scanClauseBindings(CLAUSE_FIXTURE).map((item) => `${item.clause}:${item.line}`)],
    'change-region': [parseUnifiedZeroContextDiff(CHANGE_DIFF_FIXTURE).map((item) => (
      `${item.startLine}-${item.endLine}`
    ))],
    'configuration-object': [
      parseConfigurationObject(CONFIGURATION_FIXTURE, 'singularity/rules.yml').topLevelKeys,
      (() => { try { parseConfigurationObject('{"a":1,"a":2}', 'config.json'); return 'accepted'; } catch { return 'PARSE_FAILURE'; } })()
    ],
    'import-dependency': [
      extractImports(JS_FIXTURE),
      extractImports("// require('./no.mjs')\n"),
      extractPolyglotImports(JAVA_FIXTURE, 'java').map((entry) => entry.target),
      extractPolyglotImports(PYTHON_FIXTURE, 'python').map((entry) => entry.target)
    ],
    'human-confirmed-knowledge-import': [parseHumanConfirmedKnowledgeImport(
      HUMAN_IMPORT_FIXTURE
    ).map((item) => `${item.id}:${item.factType}:${item.term}`)],
    'language-detection': [[...new Set(extractLanguages(context).facts.map((fact) => (
      fact.claim.match(/registered ([a-z]+) source extension/)?.[1]
    )).filter(Boolean))].sort()],
    'legacy-migration-resolution': [migration.facts.map((fact) => (
      `${fact.factType}:${fact.status}:${fact.reason.attemptedProducer}`
    ))],
    'interface-contract': [
      [
        ...scanInterfaceContracts(INTERFACE_FIXTURE, 'typescript').map((item) => (
          item.kind === 'interface'
            ? `interface:${item.name}:${item.line}`
            : `implementation:${item.implementation}:${item.interface}:${item.line}`
        )),
        ...scanProtocolFields(INTERFACE_FIXTURE, 'typescript').map((item) => (
          `field:${item.interface}:${item.name}:${item.line}`
        ))
      ],
      [`schema:${scanSchemaContract(
        parseConfigurationObject(SCHEMA_FIXTURE, 'contract.schema.json').root,
        { explicitSchemaPath: true }
      ).properties.join(',')}`]
    ],
    'ownership-maintainer-record': [(() => {
      const parsed = scanCodeowners(CODEOWNERS_FIXTURE);
      return [
        ...parsed.records.map((item) => `${item.owner}:${item.pattern}:${item.line}`),
        ...parsed.malformed.map((item) => `unavailable:${item.line}`)
      ];
    })()],
    'repository-files': [extractRepositoryFiles(context).facts.map((fact) => fact.subject.id)],
    'required-fact-coverage': [coverage.facts.map((fact) => fact.factType)],
    'runtime-observation-import': [parseRuntimeObservationImport(
      RUNTIME_IMPORT_FIXTURE
    ).map((item) => `${item.id}:${item.subjectId}:${item.count}`)],
    'rule-definition': [scanRuleObjects(
      parseConfigurationObject(CONFIGURATION_FIXTURE, 'singularity/rules.yml').root
    ).map((item) => `${item.container}.${item.name}:${item.conditionFields.join(',')}`)],
    'signature-and-export': [
      scanSignaturesAndExports(JS_FIXTURE, 'javascript').map((item) => (
        `${item.name}:${item.signature}:${item.exported ? 'export' : 'local'}`
      )),
      scanSignaturesAndExports('// export class No {}\n', 'javascript').map((item) => item.name)
    ],
    'symbol-skeleton': [
      extractSymbols(JS_FIXTURE, 'src/a.ts').map((entry) => entry.name),
      extractSymbols('// export class No {}\n', 'src/a.ts').map((entry) => entry.name),
      extractPolyglotSymbols(JAVA_FIXTURE, 'java').map((entry) => entry.name),
      extractPolyglotSymbols(PYTHON_FIXTURE, 'python').map((entry) => entry.name)
    ],
    'test-identity': [scanTestIdentities(TEST_FIXTURE, 'javascript').map((item) => (
      `${item.framework}:${item.name}:${item.line}`
    ))]
  };
}

export function extractorConformanceDeclaration(id) {
  const suite = SUITES[id];
  if (!suite) contractFailure(`Extractor '${id}' has no reviewed conformance suite.`, 'WMB_EXTRACTOR_CONFORMANCE_MISSING');
  return suite;
}

export function extractorConformanceReceiptSha256({ id, version, implementationSha256 }) {
  const suite = extractorConformanceDeclaration(id);
  if (version !== suite.extractor.version
      || implementationSha256 !== suite.extractor.implementationSha256) {
    contractFailure(
      `Extractor '${id}@${version}' implementation is not the reviewed conformance subject.`,
      'WMB_EXTRACTOR_CONFORMANCE_FAILED',
      {
        expectedVersion: suite.extractor.version,
        expectedImplementationSha256: suite.extractor.implementationSha256
      }
    );
  }
  return sha256({
    kind: 'world-model-extractor-conformance-receipt',
    suiteVersion: 1,
    extractor: { id, ...suite.extractor },
    parser: suite.parser,
    fixtureCorpusSha256: sha256(suite.fixtures),
    expectedOutputSha256: sha256(suite.fixtures.map((fixture) => fixture.expected)),
    fixtureCount: suite.fixtures.length,
    negativeFixtureCount: suite.fixtures.filter((fixture) => (
      fixture.class.includes('negative') || fixture.class.includes('security')
    )).length,
    securityReview: 'reviewed'
  });
}

/** Execute the packaged fixture corpus through the real deterministic parser boundaries. */
export function verifyBuiltInExtractorConformance() {
  const observed = observedFixtureOutputs();
  for (const [id, suite] of Object.entries(SUITES)) {
    const expected = suite.fixtures.map((fixture) => fixture.expected);
    if (canonicalJson(observed[id]) !== canonicalJson(expected)) {
      contractFailure(`Extractor '${id}' failed its reviewed conformance fixture corpus.`, 'WMB_EXTRACTOR_CONFORMANCE_FAILED', {
        expectedSha256: sha256(expected), observedSha256: sha256(observed[id])
      });
    }
  }
  return Object.freeze(Object.keys(SUITES).sort());
}

export const BUILTIN_EXTRACTOR_CONFORMANCE_IDS = Object.freeze(Object.keys(SUITES).sort());
