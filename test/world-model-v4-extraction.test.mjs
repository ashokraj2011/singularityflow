import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { extractImports, extractSymbols } from '../src/repository-facts.mjs';
import {
  registerExtractionDrafts, runDeterministicRegistration
} from '../src/world-model/extract/runner.mjs';
import {
  allocateDerivationIdentities, createDerivationCatalog, derivationIdentityFromRecord,
  validateDerivationRecord
} from '../src/world-model/extract/derivation-catalog.mjs';
import { createFactLedger, factIdentityFromRecord } from '../src/world-model/extract/fact-ledger.mjs';
import { BUILTIN_EXTRACTOR_REGISTRY } from '../src/world-model/registry/extractors.mjs';
import { sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import { classifyScopePath } from '../src/world-model/scope/matcher.mjs';
import { createExactSourceSnapshot } from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-extract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'WMB Tests');
  await mkdir(path.join(root, 'src', 'excluded'), { recursive: true });
  await mkdir(path.join(root, 'vendor'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.mjs'), [
    "import { b } from './b.mjs';",
    'export function a() { /* SECRET_BODY_TOKEN */ return b; }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'src', 'b.mjs'), 'export const b = 1;\n');
  await writeFile(path.join(root, 'src', 'legacy.py'), 'def hidden_body():\n    return 7\n');
  await writeFile(path.join(root, 'src', 'excluded', 'ignored.mjs'), 'export const ignored = true;\n');
  await writeFile(path.join(root, 'vendor', 'secret.mjs'), 'export const vendorSecret = true;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

test('exact source and normalized scope produce repeatable, body-free registered extraction', async (t) => {
  const root = await fixture(t);
  const scope = createScopeManifest({
    capabilityId: 'fixture',
    allowedPaths: ['./src/**', 'src/**'],
    excludedPaths: ['src/excluded/**'],
    allowedSubjects: ['dependency-edge', 'file', 'symbol']
  });
  assert.deepEqual(scope.allowedPaths, ['src/**']);
  assert.equal(classifyScopePath('src/a.mjs', scope).status, 'inside');
  assert.equal(classifyScopePath('src/excluded/ignored.mjs', scope).status, 'excluded');
  assert.equal(classifyScopePath('vendor/secret.mjs', scope).status, 'outside');

  const snapshot = createExactSourceSnapshot(root, { subjectId: 'fixture' });
  assert.equal(createExactSourceSnapshot(root, { subjectId: 'fixture' }).sourceManifestSha256, snapshot.sourceManifestSha256);
  const first = runDeterministicRegistration({ root, sourceSnapshot: snapshot, scopeManifest: scope });
  const second = runDeterministicRegistration({ root, sourceSnapshot: snapshot, scopeManifest: scope });
  assert.equal(first.evidenceCatalog.catalogSha256, second.evidenceCatalog.catalogSha256);
  assert.equal(first.derivationCatalog.catalogSha256, second.derivationCatalog.catalogSha256);
  assert.equal(first.factLedger.ledgerSha256, second.factLedger.ledgerSha256);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /SECRET_BODY_TOKEN|vendorSecret|ignored = true/);
  assert.ok(first.evidenceCatalog.items.every((item) => item.locator.path.startsWith('src/')));
  assert.ok(first.evidenceCatalog.items.every((item) => !item.locator.path.startsWith('src/excluded/')));
  assert.ok(first.factLedger.facts.some((fact) => fact.factType === 'symbol-exists'));
  assert.ok(first.factLedger.facts.some((fact) => fact.factType === 'dependency-edge'));
  assert.ok(first.factLedger.facts.some((fact) => fact.factType === 'symbol-exists'
    && fact.subject.id === 'src/legacy.py#hidden_body'));

  const evidenceIds = new Set(first.evidenceCatalog.items.map((item) => item.id));
  const derivationIds = new Set(first.derivationCatalog.derivations.map((item) => item.id));
  for (const fact of first.factLedger.facts) {
    assert.ok(derivationIds.has(fact.derivationId));
    assert.ok(fact.evidenceIds.every((id) => evidenceIds.has(id)));
  }
  for (const derivation of first.derivationCatalog.derivations) {
    const manifest = BUILTIN_EXTRACTOR_REGISTRY.manifests.find(
      (entry) => entry.id === derivation.extractor.id
        && entry.version === derivation.extractor.version
    );
    assert.equal(
      derivation.grammarSha256,
      manifest.producer.parser.grammarSha256,
      `${derivation.extractor.id} derivation must bind its reviewed parser grammar`
    );
  }

  const registered = first.derivationCatalog.derivations[0];
  const counterfeit = sealRecord({
    ...structuredClone(registered),
    extractor: {
      ...structuredClone(registered.extractor),
      implementationSha256: sha256({ counterfeit: true })
    }
  }, 'derivationSha256');
  assert.throws(
    () => validateDerivationRecord(counterfeit, {
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY
    }),
    (error) => error.code === 'WMB_EXTRACTOR_REGISTRY_MISMATCH'
  );
  const counterfeitGrammar = sealRecord({
    ...structuredClone(registered),
    grammarSha256: sha256({ counterfeit: 'grammar' })
  }, 'derivationSha256');
  assert.throws(
    () => validateDerivationRecord(counterfeitGrammar, {
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY
    }),
    (error) => error.code === 'WMB_DERIVATION_BINDING_INVALID'
      && Boolean(error.details.expectedGrammarSha256)
      && Boolean(error.details.receivedGrammarSha256)
  );

  const dirty = path.join(root, 'untracked.txt');
  await writeFile(dirty, 'dirty\n');
  assert.throws(
    () => createExactSourceSnapshot(root),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
  );
  await unlink(dirty);
});

test('Fact registration enforces the exact allowed subject set', async (t) => {
  const root = await fixture(t);
  const scope = createScopeManifest({
    capabilityId: 'files-only', allowedPaths: ['src/**'], excludedPaths: ['src/excluded/**'],
    allowedSubjects: ['file']
  });
  assert.throws(
    () => runDeterministicRegistration({ root, scopeManifest: scope }),
    (error) => error.code === 'WMB_SCOPE_VIOLATION'
      && ['dependency-edge', 'symbol'].includes(error.details.subjectKind)
  );
});

test('registration retains an exact reconstructable Fact, Evidence, and Derivation graph', async (t) => {
  const root = await fixture(t);
  const scope = createScopeManifest({
    capabilityId: 'provenance-graph', allowedPaths: ['src/**'], excludedPaths: ['src/excluded/**'],
    allowedSubjects: ['file']
  });
  const snapshot = createExactSourceSnapshot(root, { subjectId: 'provenance-graph' });
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const subject = { kind: 'file', id: 'src/a.mjs' };
  const otherSubject = { kind: 'file', id: 'src/b.mjs' };
  const localEvidence = {
    kind: 'file',
    locator: { path: 'src/a.mjs' },
    subjectSha256: sha256(subject),
    sourceContentSha256: files.get('src/a.mjs').contentSha256,
    scope: { status: 'inside' }
  };
  const standaloneObservation = {
    kind: 'file',
    locator: { path: 'src/b.mjs' },
    subjectSha256: sha256(otherSubject),
    sourceContentSha256: files.get('src/b.mjs').contentSha256,
    scope: { status: 'inside' }
  };
  const manifest = BUILTIN_EXTRACTOR_REGISTRY.manifests.find((entry) => entry.id === 'repository-files');
  const extraction = {
    manifest,
    producerId: manifest.id,
    // Exercise the original defect: Fact-local evidence is not repeated here. The unrelated
    // observation remains valid catalog evidence but is not a dependency of this Fact derivation.
    observations: [standaloneObservation],
    facts: [{
      factType: 'file-exists', subject,
      claim: 'src/a.mjs exists as an exact pinned source file.',
      status: 'available', assurance: 'source-exact', evidence: [localEvidence],
      conflictsWith: [], scopeStatus: 'inside'
    }]
  };
  const registered = registerExtractionDrafts({
    sourceSnapshot: snapshot,
    scopeManifest: scope,
    extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
    extractionResults: [extraction]
  });
  const [fact] = registered.factLedger.facts;
  const [derivation] = registered.derivationCatalog.derivations;
  assert.deepEqual(derivation.inputEvidenceIds, fact.evidenceIds);
  assert.equal(registered.evidenceCatalog.items.length, 2);
  assert.ok(!derivation.inputEvidenceIds.includes(
    registered.evidenceCatalog.items.find((item) => item.locator.path === 'src/b.mjs').id
  ));

  const counterfeitSubject = structuredClone(extraction);
  counterfeitSubject.facts[0].evidence[0].subjectSha256 = sha256(otherSubject);
  assert.throws(
    () => registerExtractionDrafts({
      sourceSnapshot: snapshot,
      scopeManifest: scope,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      extractionResults: [counterfeitSubject]
    }),
    (error) => error.code === 'WMB_EVIDENCE_SUBJECT_MISMATCH'
  );

  const makeCounterfeitGraph = (inputEvidenceIds) => {
    const identity = {
      ...derivationIdentityFromRecord(derivation),
      inputEvidenceIds: [...inputEvidenceIds].sort()
    };
    const counterfeitDerivationId = allocateDerivationIdentities([identity])[0].id;
    const draft = {
      ...factIdentityFromRecord(fact),
      derivationId: counterfeitDerivationId
    };
    const counterfeitLedger = createFactLedger({
      sourceSnapshot: snapshot,
      scopeManifest: scope,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY,
      evidenceCatalog: registered.evidenceCatalog,
      derivationIds: new Set([counterfeitDerivationId]),
      factDrafts: [draft]
    });
    return () => createDerivationCatalog({
      identities: [identity],
      outputFactIdsByDerivationId: {
        [counterfeitDerivationId]: counterfeitLedger.facts.map((entry) => entry.id)
      },
      evidenceCatalog: registered.evidenceCatalog,
      factLedger: counterfeitLedger,
      extractorRegistry: BUILTIN_EXTRACTOR_REGISTRY
    });
  };

  assert.throws(
    makeCounterfeitGraph([]),
    (error) => error.code === 'WMB_DERIVATION_EVIDENCE_MISMATCH'
  );
  const standaloneId = registered.evidenceCatalog.items.find(
    (item) => item.locator.path === 'src/b.mjs'
  ).id;
  assert.throws(
    makeCounterfeitGraph([...fact.evidenceIds, standaloneId]),
    (error) => error.code === 'WMB_DERIVATION_EVIDENCE_MISMATCH'
      && error.details.expectedEvidenceIds.length === 1
      && error.details.actualEvidenceIds.length === 2
  );
});

test('trusted JavaScript extraction ignores declaration and import decoys in comments and literals', async (t) => {
  const root = await fixture(t);
  const source = [
    '// export function lineCommentDecoy() {}',
    "// require('./line-comment-decoy.mjs');",
    '/*',
    'export class blockCommentDecoy {}',
    "import blockDecoy from './block-comment-decoy.mjs';",
    '*/',
    'const quotedDecoy = "require(\'./quoted-decoy.mjs\')";',
    "const declarationDecoy = 'export const quotedExportDecoy = true';",
    'const templateDecoys = `',
    'export function templateExportDecoy() {}',
    "import templateDecoy from './template-decoy.mjs';",
    "require('./template-require-decoy.mjs');",
    '${`nested ${"require(\'./nested-template-decoy.mjs\')"}`}',
    '`;',
    "import { real } from './real.mjs';",
    "export { real as reexportedReal } from './real.mjs';",
    "const required = require('./required.cjs');",
    'export async function actualExport() { return real + required; }',
    ''
  ].join('\n');

  assert.deepEqual(extractSymbols(source, 'src/malicious.ts'), [{
    name: 'actualExport', kind: 'function', at: 'src/malicious.ts:18'
  }]);
  assert.deepEqual(extractImports(source), ['./real.mjs', './required.cjs']);

  await writeFile(path.join(root, 'src', 'malicious.ts'), source);
  await writeFile(path.join(root, 'src', 'real.mjs'), 'export const real = 1;\n');
  await writeFile(path.join(root, 'src', 'required.cjs'), 'module.exports = 2;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'add adversarial lexical fixture');

  const registration = runDeterministicRegistration({
    root,
    scopeManifest: createScopeManifest({
      capabilityId: 'lexical-trust-boundary',
      allowedPaths: ['src/**'],
      excludedPaths: ['src/excluded/**'],
      allowedSubjects: ['dependency-edge', 'file', 'symbol']
    })
  });
  const serialized = JSON.stringify(registration);
  assert.doesNotMatch(serialized, /lineCommentDecoy|blockCommentDecoy|quotedExportDecoy|templateExportDecoy/);
  assert.doesNotMatch(serialized, /line-comment-decoy|block-comment-decoy|quoted-decoy|template-decoy|nested-template-decoy/);
  assert.match(serialized, /actualExport/);
  assert.match(serialized, /src\/malicious\.ts imports the in-scope module src\/real\.mjs/);
  assert.match(serialized, /src\/malicious\.ts imports the in-scope module src\/required\.cjs/);
});
