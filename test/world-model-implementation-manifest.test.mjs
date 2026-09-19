import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  auditReviewedImplementationSourceManifest
} from '../scripts/world-model-implementation-manifest-lint.mjs';
import {
  PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST,
  PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST
} from '../src/world-model/history/persisted-view-source-manifests.mjs';
import { reviewedImplementationSourceManifest } from '../src/world-model/source-digest.mjs';

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('installed persisted-view manifests exactly cover their TypeScript-AST source closures', () => {
  for (const manifest of [
    PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST,
    PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST
  ]) {
    const closure = auditReviewedImplementationSourceManifest(manifest, { packageRoot });
    assert.deepEqual(closure.modules, manifest.modules.map((entry) => entry.path));
    assert.deepEqual(closure.builtins, manifest.builtins);
    assert.deepEqual(closure.packages, manifest.packages);
  }
  assert.deepEqual(
    PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST.modules.map((entry) => entry.path),
    ['src/world-model/materialize/persisted-overview-renderer-v1.mjs']
  );
  assert.deepEqual(
    PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST.modules.map((entry) => entry.path),
    [
      'src/world-model/history/persisted-overview-validator-v1.mjs',
      'src/world-model/materialize/persisted-overview-renderer-v1.mjs'
    ]
  );
  assert.deepEqual(PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST.builtins, ['node:crypto']);
  assert.deepEqual(PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST.builtins, ['node:crypto']);
  assert.deepEqual(PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST.resources, []);
  assert.deepEqual(PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST.resources, []);
});

test('actual v1 executable closure imports without shared globals and ignores unrelated drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-v1-isolated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererPath = 'src/world-model/materialize/persisted-overview-renderer-v1.mjs';
  const validatorPath = 'src/world-model/history/persisted-overview-validator-v1.mjs';
  for (const relative of [rendererPath, validatorPath]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), await readFile(path.join(packageRoot, relative)));
  }
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(path.join(root, 'global-runtime.mjs'), 'throw new Error("must not load");\n');

  const materializeIsolated = (id, entry, files) => reviewedImplementationSourceManifest({
    packageRoot: root,
    id,
    version: 1,
    entries: [entry],
    reviewedFiles: files,
    reviewedBuiltins: ['node:crypto'],
    reviewedPackages: [],
    resources: []
  });
  const rendererBefore = materializeIsolated('renderer-v1', rendererPath, [rendererPath]);
  const validatorBefore = materializeIsolated(
    'validator-v1', validatorPath, [rendererPath, validatorPath]
  );
  assert.doesNotThrow(() => auditReviewedImplementationSourceManifest(rendererBefore, {
    packageRoot: root
  }));
  assert.doesNotThrow(() => auditReviewedImplementationSourceManifest(validatorBefore, {
    packageRoot: root
  }));
  const isolatedValidator = await import(pathToFileURL(path.join(root, validatorPath)).href);
  assert.equal(typeof isolatedValidator.verifyPersistedOverviewCandidateV1, 'function');

  await writeFile(path.join(root, 'global-runtime.mjs'), [
    'import "./another-global.mjs";',
    'throw new Error("advanced global runtime must remain outside v1");',
    ''
  ].join('\n'));
  const rendererAfter = materializeIsolated('renderer-v1', rendererPath, [rendererPath]);
  const validatorAfter = materializeIsolated(
    'validator-v1', validatorPath, [rendererPath, validatorPath]
  );
  assert.equal(rendererAfter.sourceSha256, rendererBefore.sourceSha256);
  assert.equal(rendererAfter.manifestSha256, rendererBefore.manifestSha256);
  assert.equal(validatorAfter.sourceSha256, validatorBefore.sourceSha256);
  assert.equal(validatorAfter.manifestSha256, validatorBefore.manifestSha256);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-source-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'owner'), { recursive: true });
  await mkdir(path.join(root, 'schemas'), { recursive: true });
  await writeFile(path.join(root, 'src', 'owner', 'entry.mjs'), [
    '// import "./not-real.mjs"',
    'const expression = /import\\(["\']/u;',
    'const description = `literal ${expression.source}`;',
    'export { value } from "../../shared.mjs";',
    'export { description };',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'shared.mjs'), [
    'import path from "node:path";',
    'export const value = path.posix.normalize("stable/value");',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'schemas', 'owner.schema.json'), '{"version":1}\n');
  return root;
}

function materialize(root, reviewedFiles = ['shared.mjs', 'src/owner/entry.mjs']) {
  return reviewedImplementationSourceManifest({
    packageRoot: root,
    id: 'fixture-owner-v1',
    version: 1,
    entries: ['src/owner/entry.mjs'],
    reviewedFiles,
    reviewedBuiltins: ['node:path'],
    reviewedPackages: [],
    resources: ['schemas/owner.schema.json']
  });
}

test('out-of-subtree dependencies and resources are identity-bearing exact bytes', async (t) => {
  const root = await fixture(t);
  const original = materialize(root);
  const closure = auditReviewedImplementationSourceManifest(original, { packageRoot: root });
  assert.deepEqual(closure.modules, ['shared.mjs', 'src/owner/entry.mjs']);

  await writeFile(path.join(root, 'shared.mjs'), [
    'import path from "node:path";',
    'export const value = path.posix.normalize("drifted/value");',
    ''
  ].join('\n'));
  const dependencyDrift = materialize(root);
  assert.notEqual(dependencyDrift.sourceSha256, original.sourceSha256);
  assert.notEqual(dependencyDrift.manifestSha256, original.manifestSha256);

  await writeFile(path.join(root, 'schemas', 'owner.schema.json'), '{"version":2}\n');
  const resourceDrift = materialize(root);
  assert.notEqual(resourceDrift.sourceSha256, dependencyDrift.sourceSha256);
  assert.notEqual(resourceDrift.manifestSha256, dependencyDrift.manifestSha256);
});

test('manifest audit rejects unmanifested and extra local modules', async (t) => {
  const root = await fixture(t);
  const missing = materialize(root, ['src/owner/entry.mjs']);
  assert.throws(
    () => auditReviewedImplementationSourceManifest(missing, { packageRoot: root }),
    (error) => error?.code === 'WMP_IMPLEMENTATION_SOURCE_MANIFEST_MISMATCH'
      && error?.details?.missing?.includes('shared.mjs')
  );

  await writeFile(path.join(root, 'unused.mjs'), 'export const unused = true;\n');
  const extra = materialize(root, ['shared.mjs', 'src/owner/entry.mjs', 'unused.mjs']);
  assert.throws(
    () => auditReviewedImplementationSourceManifest(extra, { packageRoot: root }),
    (error) => error?.code === 'WMP_IMPLEMENTATION_SOURCE_MANIFEST_MISMATCH'
      && error?.details?.extra?.includes('unused.mjs')
  );
});

test('manifest audit rejects nonliteral dynamic imports and unsafe loaders', async (t) => {
  const root = await fixture(t);
  for (const [source, code] of [
    ['const target = "../../shared.mjs"; await import(target);\n',
      'WMP_IMPLEMENTATION_DYNAMIC_IMPORT_NONLITERAL'],
    ['require("../../shared.mjs");\n', 'WMP_IMPLEMENTATION_COMMONJS_IMPORT_UNSUPPORTED'],
    ['eval("1 + 1");\n', 'WMP_IMPLEMENTATION_EVAL_UNSUPPORTED'],
    ['createRequire(import.meta.url);\n', 'WMP_IMPLEMENTATION_CREATE_REQUIRE_UNSUPPORTED']
  ]) {
    await writeFile(path.join(root, 'src', 'owner', 'entry.mjs'), source);
    const manifest = reviewedImplementationSourceManifest({
      packageRoot: root,
      id: 'unsafe-fixture', version: 1,
      entries: ['src/owner/entry.mjs'], reviewedFiles: ['src/owner/entry.mjs']
    });
    assert.throws(
      () => auditReviewedImplementationSourceManifest(manifest, { packageRoot: root }),
      (error) => error?.code === code,
      code
    );
  }
});
