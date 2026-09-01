import { canonicalJson, sealRecord, sha256 } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { extractImports, extractSymbols } from '../../repository-facts.mjs';
import {
  extractLanguages, extractRepositoryFiles, extractRequiredFactCoverage,
  IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256, IMPORT_DEPENDENCY_VERSION,
  LANGUAGE_DETECTION_IMPLEMENTATION_SHA256, LANGUAGE_DETECTION_VERSION,
  REPOSITORY_FILES_IMPLEMENTATION_SHA256, REPOSITORY_FILES_VERSION,
  REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256, REQUIRED_FACT_COVERAGE_VERSION,
  SYMBOL_SKELETON_IMPLEMENTATION_SHA256, SYMBOL_SKELETON_VERSION
} from '../extract/adapters/index.mjs';
import { createScopeManifest } from '../scope/manifest.mjs';
import { contractFailure } from '../contracts.mjs';

const JS_FIXTURE = [
  '// export function commentDecoy() {}',
  "const text = \"require('./string-decoy.mjs')\";",
  "import { real } from './real.mjs';",
  "const required = require('./required.cjs');",
  'export function actual() { return real + required; }',
  ''
].join('\n');

const SUITES = Object.freeze({
  'import-dependency': Object.freeze({
    extractor: Object.freeze({
      version: IMPORT_DEPENDENCY_VERSION,
      implementationSha256: IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'sflow-javascript-lexical-imports', version: '2.0.0', grammarSha256: sha256('ecmascript-import-grammar-v2') }),
    fixtures: Object.freeze([
      { id: 'imports-positive-and-decoys', class: 'positive-security', inputSha256: sha256(JS_FIXTURE), expected: ['./real.mjs', './required.cjs'] },
      { id: 'imports-comments-only', class: 'negative', inputSha256: sha256("// require('./no.mjs')\n"), expected: [] }
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
  'symbol-skeleton': Object.freeze({
    extractor: Object.freeze({
      version: SYMBOL_SKELETON_VERSION,
      implementationSha256: SYMBOL_SKELETON_IMPLEMENTATION_SHA256
    }),
    parser: Object.freeze({ id: 'sflow-javascript-lexical-symbols', version: '2.0.0', grammarSha256: sha256('ecmascript-exported-symbol-grammar-v2') }),
    fixtures: Object.freeze([
      { id: 'symbols-positive-and-decoys', class: 'positive-security', inputSha256: sha256(JS_FIXTURE), expected: ['actual'] },
      { id: 'symbols-comments-only', class: 'negative', inputSha256: sha256('// export class No {}\n'), expected: [] }
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
  return {
    'import-dependency': [
      extractImports(JS_FIXTURE), extractImports("// require('./no.mjs')\n")
    ],
    'language-detection': [[...new Set(extractLanguages(context).facts.map((fact) => (
      fact.claim.match(/registered ([a-z]+) source extension/)?.[1]
    )).filter(Boolean))].sort()],
    'repository-files': [extractRepositoryFiles(context).facts.map((fact) => fact.subject.id)],
    'required-fact-coverage': [coverage.facts.map((fact) => fact.factType)],
    'symbol-skeleton': [
      extractSymbols(JS_FIXTURE, 'src/a.ts').map((entry) => entry.name),
      extractSymbols('// export class No {}\n', 'src/a.ts').map((entry) => entry.name)
    ]
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
