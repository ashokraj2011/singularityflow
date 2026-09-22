import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { exactEnvironmentDeclarationAtRef } from '../src/git.mjs';
import { worldModelRebuildReason, worldModelSourceSnapshot } from '../src/grounding.mjs';
import {
  environmentWorldModelExcludedRoots, loadEnvironmentDeclarationSync
} from '../src/environment-declaration.mjs';
import { configuredWorldModelV4ScopeOptions } from '../src/world-model/scope/configuration.mjs';
import { createScopeManifest } from '../src/world-model/scope/manifest.mjs';
import {
  createExactSourceSnapshot, createExactSourceSnapshotAtRevision
} from '../src/world-model/source/snapshot.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-environment-wm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'environment-world-model@example.invalid');
  git(root, 'config', 'user.name', 'Environment World Model');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const application = true;\n');
  await writeFile(path.join(root, '.env.local'), 'TOKEN=historically-tracked-secret\n');
  await writeFile(path.join(root, '.ENV.QA'), 'TOKEN=portable-case-alias-secret\n');
  await writeFile(path.join(root, 'config', 'qa.env'), 'API_TOKEN=historically-tracked-secret\n');
  await writeFile(path.join(root, 'singularity', 'environments.yml'), [
    'schemaVersion: 1',
    'environments:',
    '  qa:',
    '    requires:',
    '      - name: API_TOKEN',
    '        kind: secret',
    '    localFiles:',
    '      - config/*.env',
    'checks: {}',
    'neverCommit:',
    '  - .env*',
    ''
  ].join('\n'));
  // Raw Git intentionally simulates a repository which tracked local content before ENV existed.
  // Governed SFlow commit admission refuses these paths in new repositories.
  git(root, 'add', '-f', '.');
  git(root, 'commit', '-qm', 'legacy repository with tracked environment-local content');
  return root;
}

function registeredScope(root) {
  const options = configuredWorldModelV4ScopeOptions(root, {
    definition: { worldModel: {
      excludedRoots: environmentWorldModelExcludedRoots(
        loadEnvironmentDeclarationSync(root, { optional: true })
      )
    } },
    repositoryCapability: { id: 'environment-fixture' }
  });
  return createScopeManifest(options);
}

test('configuration projects environment-local paths through the existing v4 exclusion policy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-environment-wm-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'), { recursive: true });
  await initializeDefinition(root);
  await writeFile(path.join(root, 'singularity', 'environments.yml'), [
    'schemaVersion: 1',
    'environments:',
    '  qa:',
    '    requires:',
    '      - name: API_TOKEN',
    '        kind: secret',
    '    localFiles:',
    '      - config/*.env',
    'checks: {}',
    'neverCommit:',
    '  - .env*',
    ''
  ].join('\n'));

  const definition = await loadDefinition(root);
  assert.deepEqual(definition.worldModel.excludedRoots, ['.env*', 'config/*.env']);
  const scope = createScopeManifest(configuredWorldModelV4ScopeOptions(root, {
    definition, repositoryCapability: { id: 'environment-config-fixture' }
  }));
  assert.ok(scope.excludedPaths.includes('.env*'));
  assert.ok(scope.excludedPaths.includes('config/*.env'));
});

test('legacy-v3 and registered-v4 exclude historically tracked environment-local content', async (t) => {
  const root = await fixture(t);

  const legacyBefore = await worldModelSourceSnapshot(root, {});
  assert.ok(legacyBefore.files.some((entry) => entry.path === 'src/app.mjs'));
  assert.ok(!legacyBefore.files.some((entry) => entry.path === '.env.local'));
  assert.ok(!legacyBefore.files.some((entry) => entry.path === '.ENV.QA'));
  assert.ok(!legacyBefore.files.some((entry) => entry.path === 'config/qa.env'));

  const scope = registeredScope(root);
  assert.ok(scope.excludedPaths.includes('.env*'));
  assert.ok(scope.excludedPaths.includes('config/*.env'));
  const registeredBefore = createExactSourceSnapshot(root, {
    subjectId: 'environment-fixture', scopeManifest: scope
  });
  assert.deepEqual(registeredBefore.files.map((entry) => entry.path), ['src/app.mjs']);
  const initialCommit = git(root, 'rev-parse', 'HEAD');
  const historical = createExactSourceSnapshotAtRevision(root, initialCommit, {
    subjectId: 'environment-fixture', scopeManifest: scope
  });
  assert.deepEqual(historical.files.map((entry) => entry.path), ['src/app.mjs']);

  // Updating only a historically tracked local file must not make either model format stale.
  await writeFile(path.join(root, 'config', 'qa.env'), 'API_TOKEN=changed-local-value\n');
  await writeFile(path.join(root, '.ENV.QA'), 'TOKEN=changed-portable-alias-value\n');
  git(root, 'add', '-f', 'config/qa.env', '.ENV.QA');
  git(root, 'commit', '-qm', 'rotate local environment value');
  const legacyAfter = await worldModelSourceSnapshot(root, {});
  const registeredAfter = createExactSourceSnapshot(root, {
    subjectId: 'environment-fixture', scopeManifest: registeredScope(root)
  });
  assert.equal(legacyAfter.sha256, legacyBefore.sha256);
  assert.equal(registeredAfter.sourceManifestSha256, registeredBefore.sourceManifestSha256);
  assert.doesNotMatch(
    JSON.stringify({ legacyAfter, registeredAfter }),
    /changed-local-value|changed-portable-alias-value/
  );
});

test('legacy world-model capture retains committed exclusions across unstaged weakening', async (t) => {
  const root = await fixture(t);
  const declarationPath = path.join(root, 'singularity', 'environments.yml');
  const declaration = await readFile(declarationPath, 'utf8');
  await writeFile(declarationPath, declaration
    .replace('    localFiles:\n      - config/*.env', '    localFiles: []')
    .replace('neverCommit:\n  - .env*', 'neverCommit: []'));

  const source = await worldModelSourceSnapshot(root, {});
  assert.ok(source.files.some((entry) => entry.path === 'src/app.mjs'));
  assert.ok(!source.files.some((entry) => entry.path === '.env.local'));
  assert.ok(!source.files.some((entry) => entry.path === '.ENV.QA'));
  assert.ok(!source.files.some((entry) => entry.path === 'config/qa.env'));
});

test('historical declaration reads bypass the current approved configuration overlay', async (t) => {
  const root = await fixture(t);
  const configurationRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-environment-config-'));
  t.after(() => rm(configurationRoot, { recursive: true, force: true }));
  await mkdir(path.join(configurationRoot, 'singularity'), { recursive: true });
  await writeFile(path.join(configurationRoot, 'singularity', 'environments.yml'), [
    'schemaVersion: 1',
    'environments:',
    '  qa:',
    '    requires:',
    '      - name: API_TOKEN',
    '        kind: secret',
    '    localFiles: []',
    'checks: {}',
    'neverCommit: []',
    ''
  ].join('\n'));
  const historicalCommit = git(root, 'rev-parse', 'HEAD');

  await withConfigurationReadRoot(root, configurationRoot, {}, async () => {
    const selected = exactEnvironmentDeclarationAtRef(root, historicalCommit);
    const historical = exactEnvironmentDeclarationAtRef(root, historicalCommit, undefined, {
      allowMissingRef: false,
      useConfigurationOverlay: false
    });
    assert.equal(selected.environments.qa.localFiles.length, 0);
    assert.deepEqual(historical.environments.qa.localFiles, ['config/*.env']);
  });
});

test('legacy world-model capture fails closed when the exact committed declaration is invalid', async (t) => {
  const root = await fixture(t);
  const declarationPath = path.join(root, 'singularity', 'environments.yml');
  const valid = await readFile(declarationPath, 'utf8');
  await writeFile(declarationPath, valid.replace('kind: secret', 'kind: unsupported'));
  git(root, 'add', 'singularity/environments.yml');
  git(root, 'commit', '-qm', 'invalid historical declaration');
  await writeFile(declarationPath, valid);

  await assert.rejects(
    () => worldModelSourceSnapshot(root, {}),
    (error) => error.code === 'ENVIRONMENT_DECLARATION_INVALID'
  );
});

test('world-model capture fails closed when the approved environment declaration is invalid', async (t) => {
  const root = await fixture(t);
  const declaration = path.join(root, 'singularity', 'environments.yml');
  await writeFile(declaration, (await readFile(declaration, 'utf8')).replace(
    'kind: secret', 'kind: unsupported'
  ));

  await assert.rejects(
    () => worldModelSourceSnapshot(root, {}),
    (error) => error.code === 'ENVIRONMENT_DECLARATION_INVALID'
  );
  assert.throws(
    () => configuredWorldModelV4ScopeOptions(root, {
      definition: { worldModel: {
        excludedRoots: environmentWorldModelExcludedRoots(
          loadEnvironmentDeclarationSync(root, { optional: true })
        )
      } },
      repositoryCapability: { id: 'environment-fixture' }
    }),
    (error) => error.code === 'ENVIRONMENT_DECLARATION_INVALID'
  );
});

test('tightening environment exclusions makes an older legacy model stale even with no visible path delta', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'src', 'newly-private.txt'), 'historical local configuration\n');
  git(root, 'add', 'src/newly-private.txt');
  git(root, 'commit', '-qm', 'track legacy configuration before policy');
  const modelSourceCommit = git(root, 'rev-parse', 'HEAD');
  const source = await worldModelSourceSnapshot(root, {});
  assert.ok(source.files.some((entry) => entry.path === 'src/newly-private.txt'));

  const modelDirectory = path.join(root, 'singularity', 'world-model');
  await mkdir(modelDirectory, { recursive: true });
  await writeFile(path.join(modelDirectory, 'manifest.json'), `${JSON.stringify({
    source_tree_sha256: source.sha256,
    repository_commit: modelSourceCommit
  }, null, 2)}\n`);
  git(root, 'add', 'singularity/world-model/manifest.json');
  git(root, 'commit', '-qm', 'publish legacy model fixture');

  const declarationPath = path.join(root, 'singularity', 'environments.yml');
  const declaration = await readFile(declarationPath, 'utf8');
  await writeFile(declarationPath, declaration.replace(
    '      - config/*.env',
    '      - config/*.env\n      - src/newly-private.txt'
  ));
  // Raw Git simulates an approved configuration update arriving from an older release.  Current
  // governed publication would refuse grandfathering the tracked local-only path.
  git(root, 'add', 'singularity/environments.yml');
  git(root, 'commit', '-qm', 'tighten environment-local policy');

  const current = await worldModelSourceSnapshot(root, {});
  assert.ok(!current.files.some((entry) => entry.path === 'src/newly-private.txt'));
  assert.notEqual(current.sha256, source.sha256);
  assert.equal(
    await worldModelRebuildReason(root, { worldModel: { outputDir: 'singularity/world-model' } }),
    'The repository world model is stale for the current source tree.'
  );
});
