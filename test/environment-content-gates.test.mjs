import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  admitGovernedPublication, assertNoSecrets, commit
} from '../src/git.mjs';
import {
  environmentWorldModelExcludedRoots, loadEnvironmentDeclarationSync
} from '../src/environment-declaration.mjs';
import { configuredWorldModelV4ScopeOptions } from '../src/world-model/scope/configuration.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-env-gate-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Environment Gate Tester']);
  git(root, ['config', 'user.email', 'environment-gate@example.invalid']);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
    localFiles:
      - config/qa.private.yml
checks:
  browser-tests:
    environment: qa
neverCommit:
  - .env*
  - "**/*.local.yml"
`);
  await writeFile(path.join(root, 'README.md'), '# Environment gate fixture\n');
  git(root, ['add', 'README.md', 'singularity/environments.yml']);
  git(root, ['commit', '-q', '-m', 'initialize environment declaration']);
  return root;
}

test('commit and governed publication refuse force-added environment-local paths', async () => {
  const root = await repository();
  await writeFile(path.join(root, '.ENV.QA'), 'API_TOKEN=private-value\n');
  git(root, ['add', '-f', '.ENV.QA']);

  assert.throws(() => assertNoSecrets(root), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /\.ENV\.QA matches neverCommit rule '\.env\*'/);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
  git(root, ['reset', '-q', 'HEAD', '--', '.ENV.QA']);

  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'qa.private.yml'), 'safe-looking: true\n');
  git(root, ['add', '-f', 'config/qa.private.yml']);
  assert.throws(() => commit(root, 'must refuse environment-local file', ['config']), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /environments\.qa\.localFiles/);
    return true;
  });
  git(root, ['reset', '-q', 'HEAD', '--', 'config/qa.private.yml']);

  assert.throws(() => admitGovernedPublication(root, ['config']), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /Governed publication was refused/);
    return true;
  });
});

test('governed publication ignores replace refs while admitting its exact prospective tree', async () => {
  const root = await repository();
  const baselineTree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  const credential = `ghp_${'R'.repeat(36)}`;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'credential.txt'), `token = "${credential}"\n`);
  git(root, ['add', 'src/credential.txt']);
  const prospectiveTree = git(root, ['write-tree']).trim();
  git(root, ['reset', '-q', 'HEAD', '--', 'src/credential.txt']);

  // Without replacement suppression, diff/ls-tree/show make this malicious tree look identical to
  // the clean baseline even though the retained OID still names the credential-bearing bytes.
  git(root, ['replace', prospectiveTree, baselineTree]);
  assert.throws(() => admitGovernedPublication(root, ['src/credential.txt']), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    assert.doesNotMatch(error.message, new RegExp(credential));
    return true;
  });
});

test('whole-index secret admission reads the indexed blob without replacement substitution', async () => {
  const root = await repository();
  const credential = `ghp_${'S'.repeat(36)}`;
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'credential.txt'), `token = "${credential}"\n`);
  git(root, ['add', 'src/credential.txt']);
  const secretBlob = git(root, ['rev-parse', ':src/credential.txt']).trim();
  await writeFile(path.join(root, 'safe.txt'), 'safe=true\n');
  const safeBlob = git(root, ['hash-object', '-w', 'safe.txt']).trim();
  git(root, ['replace', secretBlob, safeBlob]);

  assert.throws(() => assertNoSecrets(root), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    assert.doesNotMatch(error.message, new RegExp(credential));
    return true;
  });
});

test('registered-v4 scope excludes every declared environment-local path', async () => {
  const root = await repository();
  const resolved = configuredWorldModelV4ScopeOptions(root, {
    definition: { worldModel: {
      excludedRoots: environmentWorldModelExcludedRoots(
        loadEnvironmentDeclarationSync(root, { optional: true })
      )
    } },
    repositoryCapability: { id: 'environment-gate' }
  });
  assert.ok(resolved.excludedPaths.includes('.env*'));
  assert.ok(resolved.excludedPaths.includes('**/*.local.yml'));
  assert.ok(resolved.excludedPaths.includes('config/qa.private.yml'));
  assert.notEqual(resolved.policySnapshotSha256, null);
});

test('index commits enforce the staged declaration rather than mutable worktree YAML', async () => {
  const root = await repository();
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'qa.private.yml'), 'not-a-secret: true\n');
  git(root, ['add', '-f', 'singularity/environments.yml', 'config/qa.private.yml']);

  // Loosen only the worktree copy after staging. Reading the worktree declaration here would let
  // the already-staged local-only file escape in the exact index commit.
  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
checks: {}
neverCommit: []
`);

  assert.throws(() => assertNoSecrets(root), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /config\/qa\.private\.yml/);
    return true;
  });
});

test('deleting or weakening the declaration cannot grandfather a forbidden tracked file', async () => {
  const root = await repository();
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'qa.private.yml'), 'historical: true\n');
  // Simulate a repository created before ENV enforcement. The product gate must repair, not
  // silently grandfather, this already-tracked local-only path.
  git(root, ['add', '-f', 'config/qa.private.yml']);
  git(root, ['commit', '-q', '-m', 'historical local file']);

  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
checks: {}
neverCommit: []
`);
  git(root, ['add', 'singularity/environments.yml']);
  assert.throws(() => assertNoSecrets(root), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /config\/qa\.private\.yml/);
    return true;
  });

  git(root, ['reset', '-q', '--hard', 'HEAD']);
  git(root, ['rm', '-q', 'singularity/environments.yml']);
  assert.throws(() => assertNoSecrets(root), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /config\/qa\.private\.yml/);
    return true;
  });
});

test('a tightened declaration applies to every path in the prospective tree', async () => {
  const root = await repository();
  await writeFile(path.join(root, 'legacy.env'), 'SAFE_NAME=value\n');
  git(root, ['add', 'legacy.env']);
  git(root, ['commit', '-q', '-m', 'historical ordinary file']);

  const declarationPath = path.join(root, 'singularity', 'environments.yml');
  const current = await readFile(declarationPath, 'utf8');
  await writeFile(declarationPath, current.replace(
    'neverCommit:\n  - .env*',
    'neverCommit:\n  - .env*\n  - legacy.env'
  ));
  git(root, ['add', 'singularity/environments.yml']);
  assert.throws(() => assertNoSecrets(root), (error) => {
    assert.equal(error.code, 'ENVIRONMENT_LOCAL_CONTENT_REFUSED');
    assert.match(error.message, /legacy\.env/);
    return true;
  });
});
