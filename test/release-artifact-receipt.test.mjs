import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  materializeExactHead, populateExactWorktree
} from '../scripts/build-release-artifacts.mjs';
import {
  createVerifiedReleaseArtifactSnapshot, signReleaseArtifactReceipt, verifyReleaseArtifactReceipt,
  verifyReleaseArtifactReceiptAuthority
} from '../src/release-artifact-receipt.mjs';
import { readSecurePrivateKey, readSecurePublicKey } from '../src/secure-private-key.mjs';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function unsignedReceipt() {
  return {
    schemaVersion: 1,
    kind: 'singularity-flow-release-artifact-receipt',
    generatedAt: '2026-09-11T00:00:00.000Z',
    sourceCommit: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    packageEntryManifestSha256: `sha256:${'c'.repeat(64)}`,
    packagingProfile: {
      nodeVersion: '22.18.0',
      npmVersion: '11.8.0',
      zlibVersion: '1.3.1',
      sourceDateEpoch: '1789084800',
      npmToolchainLockSha256: `sha256:${'d'.repeat(64)}`,
      productionDependencyLockSha256: `sha256:${'f'.repeat(64)}`,
      vsceToolchainLockSha256: `sha256:${'e'.repeat(64)}`
    },
    artifacts: [
      {
        kind: 'cli-and-copilot-plugin',
        name: 'singularity-flow-0.9.0.tgz',
        sizeBytes: 11,
        sha256: 'sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
      },
      {
        kind: 'vscode-extension',
        name: 'singularity-flow-vscode-0.9.0.vsix',
        sizeBytes: 10,
        sha256: 'sha256:1004ac31c5d110246ac972d8b57986aa034b84925306d1bcf9a6f8959abac056'
      }
    ]
  };
}

function git(directory, args) {
  const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitInput(directory, args, input) {
  const result = spawnSync('git', args, { cwd: directory, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function sourceRepository(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-head-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(directory, ['init', '-q', '-b', 'main']);
  git(directory, ['config', 'user.name', 'Release Test']);
  git(directory, ['config', 'user.email', 'release@example.test']);
  await mkdir(path.join(directory, 'src'));
  await writeFile(path.join(directory, '.gitignore'), '*.tgz\n');
  await writeFile(path.join(directory, 'src', 'build-info.mjs'), [
    'export const BUILD_INFO = {',
    '  commit: null,',
    '  sourceSha256: null,',
    '  branch: null,',
    '  dirty: null,',
    '  builtAt: null',
    '};',
    ''
  ].join('\n'));
  await writeFile(path.join(directory, 'src', 'value.txt'), 'line-one\nline-two\n');
  await writeFile(path.join(directory, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(path.join(directory, 'run.sh'), 0o755);
  git(directory, ['add', '.']);
  git(directory, ['commit', '-q', '-m', 'Exact source']);
  return directory;
}

test('artifact receipt requires the trusted builder and exact immutable bytes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-artifact-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageFile = path.join(directory, 'singularity-flow-0.9.0.tgz');
  const vsixFile = path.join(directory, 'singularity-flow-vscode-0.9.0.vsix');
  await writeFile(packageFile, 'hello world');
  await writeFile(vsixFile, 'hello vsix');
  const builder = keys();
  const receipt = signReleaseArtifactReceipt(unsignedReceipt(), builder.privateKey, 'builder@example.test');
  const authority = verifyReleaseArtifactReceiptAuthority(receipt, {
    trustedPublicKeyPem: builder.publicKey,
    expectedCommit: 'a'.repeat(40),
    expectedTree: 'b'.repeat(40)
  });
  assert.equal(authority.payloadSha256, receipt.signature.payloadSha256);
  assert.equal((await verifyReleaseArtifactReceipt(receipt, {
    trustedPublicKeyPem: builder.publicKey, packagePath: packageFile, vsixPath: vsixFile
  })).valid, true);

  const other = keys();
  assert.throws(() => verifyReleaseArtifactReceiptAuthority(receipt, {
    trustedPublicKeyPem: other.publicKey
  }), (error) => error.code === 'RELEASE_ARTIFACT_RECEIPT_UNTRUSTED');
  const tampered = structuredClone(receipt);
  tampered.artifacts[0].sizeBytes += 1;
  assert.throws(() => verifyReleaseArtifactReceiptAuthority(tampered, {
    trustedPublicKeyPem: builder.publicKey
  }), (error) => error.code === 'RELEASE_ARTIFACT_RECEIPT_SIGNATURE_INVALID');
  await writeFile(packageFile, 'changed bytes');
  await assert.rejects(verifyReleaseArtifactReceipt(receipt, {
    trustedPublicKeyPem: builder.publicKey, packagePath: packageFile, vsixPath: vsixFile
  }), (error) => error.code === 'RELEASE_ARTIFACT_MISMATCH');
});

test('artifact execution snapshots descriptor-verified bytes before a handoff path can change', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-artifact-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageFile = path.join(directory, 'singularity-flow-0.9.0.tgz');
  const vsixFile = path.join(directory, 'singularity-flow-vscode-0.9.0.vsix');
  await writeFile(packageFile, 'hello world');
  await writeFile(vsixFile, 'hello vsix');
  const builder = keys();
  const receipt = signReleaseArtifactReceipt(unsignedReceipt(), builder.privateKey, 'builder@example.test');
  const snapshot = await createVerifiedReleaseArtifactSnapshot(receipt, {
    trustedPublicKeyPem: builder.publicKey,
    packagePath: packageFile,
    vsixPath: vsixFile,
    tempRoot: directory
  });
  t.after(() => rm(snapshot.snapshotDirectory, { recursive: true, force: true }));

  await Promise.all([
    writeFile(packageFile, 'untrusted replacement'),
    writeFile(vsixFile, 'untrusted replacement')
  ]);
  assert.equal(await readFile(snapshot.packagePath, 'utf8'), 'hello world');
  assert.equal(await readFile(snapshot.vsixPath, 'utf8'), 'hello vsix');
  assert.equal((await verifyReleaseArtifactReceipt(receipt, {
    trustedPublicKeyPem: builder.publicKey,
    packagePath: snapshot.packagePath,
    vsixPath: snapshot.vsixPath
  })).valid, true);
  await assert.rejects(verifyReleaseArtifactReceipt(receipt, {
    trustedPublicKeyPem: builder.publicKey,
    packagePath: packageFile,
    vsixPath: vsixFile
  }), (error) => error.code === 'RELEASE_ARTIFACT_MISMATCH');
  await assert.rejects(verifyReleaseArtifactReceipt(receipt, {
    trustedPublicKeyPem: builder.publicKey,
    packagePath: snapshot.packagePath
  }), (error) => error.code === 'RELEASE_ARTIFACT_PAIR_REQUIRED');
});

test('exact HEAD materialization ignores CRLF, mode, untracked, and ignored checkout contaminants', async (t) => {
  const repository = await sourceRepository(t);
  await writeFile(path.join(repository, 'src', 'value.txt'), 'line-one\r\nline-two\r\n');
  await chmod(path.join(repository, 'src', 'value.txt'), 0o777);
  await writeFile(path.join(repository, 'src', 'ignored-probe.tgz'), 'must never enter release input');
  await writeFile(path.join(repository, 'src', 'untracked.txt'), 'must never enter release input');
  const destination = path.join(path.dirname(repository), `${path.basename(repository)}-materialized`);
  t.after(() => rm(destination, { recursive: true, force: true }));
  await materializeExactHead(repository, destination);
  assert.equal(await readFile(path.join(destination, 'src', 'value.txt'), 'utf8'), 'line-one\nline-two\n');
  const mode = (await lstat(path.join(destination, 'src', 'value.txt'))).mode & 0o777;
  assert.equal(mode, 0o644);
  await assert.rejects(readFile(path.join(destination, 'src', 'ignored-probe.tgz')));
  await assert.rejects(readFile(path.join(destination, 'src', 'untracked.txt')));
});

test('exact VSIX worktree population never invokes repository-local checkout filters', async (t) => {
  const repository = await sourceRepository(t);
  await mkdir(path.join(repository, '.git', 'info'), { recursive: true });
  await writeFile(path.join(repository, '.git', 'info', 'attributes'), 'src/value.txt filter=poison\n');
  git(repository, ['config', 'filter.poison.smudge', 'git hash-object --stdin']);
  git(repository, ['config', 'filter.poison.clean', 'git hash-object --stdin']);
  git(repository, ['config', 'filter.poison.required', 'true']);

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-vsix-worktree-'));
  const materialized = path.join(temporary, 'materialized');
  const ordinary = path.join(temporary, 'ordinary');
  const exact = path.join(temporary, 'exact');
  t.after(async () => {
    for (const worktree of [ordinary, exact]) {
      if ((await lstat(worktree).catch(() => null)) != null) {
        spawnSync('git', ['worktree', 'remove', '--force', worktree], {
          cwd: repository, encoding: 'utf8'
        });
      }
    }
    await rm(temporary, { recursive: true, force: true });
  });
  const source = await materializeExactHead(repository, materialized);

  git(repository, ['worktree', 'add', '--detach', ordinary, source.commit]);
  assert.notEqual(await readFile(path.join(ordinary, 'src', 'value.txt'), 'utf8'),
    'line-one\nline-two\n');
  git(repository, ['worktree', 'remove', '--force', ordinary]);

  git(repository, ['worktree', 'add', '--detach', '--no-checkout', exact, source.commit]);
  await populateExactWorktree(materialized, exact, source.entries);
  assert.equal(await readFile(path.join(exact, 'src', 'value.txt'), 'utf8'),
    'line-one\nline-two\n');
  assert.equal(await readFile(path.join(exact, 'src', 'build-info.mjs'), 'utf8'),
    await readFile(path.join(materialized, 'src', 'build-info.mjs'), 'utf8'));
});

test('exact HEAD materialization refuses tracked links and nested-parent Git identity', async (t) => {
  const repository = await sourceRepository(t);
  await symlink('src/value.txt', path.join(repository, 'linked.txt'));
  git(repository, ['add', 'linked.txt']);
  git(repository, ['commit', '-q', '-m', 'Add unsafe link']);
  await assert.rejects(
    materializeExactHead(repository, path.join(repository, '..', `${path.basename(repository)}-linked-output`)),
    /refuses symbolic link/
  );
  const nested = path.join(repository, 'nested-export');
  await mkdir(nested);
  await assert.rejects(materializeExactHead(nested, path.join(repository, '..', 'nested-output')),
    /exact Git repository root/);
});

test('exact HEAD materialization refuses Windows-reserved release paths', async (t) => {
  const repository = await sourceRepository(t);
  await writeFile(path.join(repository, 'CON.txt'), 'not portable\n');
  git(repository, ['add', 'CON.txt']);
  git(repository, ['commit', '-q', '-m', 'Add non-portable path']);
  const destination = path.join(path.dirname(repository), `${path.basename(repository)}-reserved-output`);
  t.after(() => rm(destination, { recursive: true, force: true }));
  await assert.rejects(materializeExactHead(repository, destination), /non-portable release path: CON\.txt/);
});

test('exact HEAD materialization refuses case-colliding parent directories from Git objects', async (t) => {
  const repository = await sourceRepository(t);
  const blob = gitInput(repository, ['hash-object', '-w', '--stdin'], 'value\n');
  const childTree = gitInput(repository, ['mktree', '-z'], `100644 blob ${blob}\tvalue.txt\0`);
  const sourceTree = git(repository, ['rev-parse', 'HEAD:src']);
  const rootTree = gitInput(repository, ['mktree', '-z'], [
    `040000 tree ${childTree}\tFoo\0`,
    `040000 tree ${sourceTree}\tsrc\0`,
    `040000 tree ${childTree}\tfoo\0`
  ].join(''));
  const commit = git(repository, ['commit-tree', rootTree, '-p', 'HEAD', '-m', 'Case collision']);
  git(repository, ['update-ref', 'refs/heads/main', commit]);
  const destination = path.join(path.dirname(repository), `${path.basename(repository)}-collision-output`);
  t.after(() => rm(destination, { recursive: true, force: true }));
  await assert.rejects(materializeExactHead(repository, destination),
    /collide on a case-insensitive filesystem: Foo and foo/);
});

test('exact HEAD materialization refuses Git, extended device, and overlong path components', async (t) => {
  for (const [name, expression] of [
    ['.GiT', /non-portable release path/],
    ['GIT~1', /non-portable release path/],
    ['CONOUT$.txt', /non-portable release path/],
    ['COM¹.log', /non-portable release path/],
    ['a'.repeat(256), /non-portable release path/]
  ]) {
    await t.test(name, async (subtest) => {
      const repository = await sourceRepository(subtest);
      const blob = gitInput(repository, ['hash-object', '-w', '--stdin'], 'value\n');
      const rootTree = gitInput(repository, ['mktree', '-z'], `100644 blob ${blob}\t${name}\0`);
      const commit = git(repository, ['commit-tree', rootTree, '-p', 'HEAD', '-m', 'Non-portable path']);
      git(repository, ['update-ref', 'refs/heads/main', commit]);
      const destination = path.join(path.dirname(repository), `${path.basename(repository)}-portable-output`);
      subtest.after(() => rm(destination, { recursive: true, force: true }));
      await assert.rejects(materializeExactHead(repository, destination), expression);
    });
  }
});

test('release signing keys are private ordinary files outside the repository', async (t) => {
  const repository = await sourceRepository(t);
  const keyFile = path.join(path.dirname(repository), `${path.basename(repository)}-signing.pem`);
  const linkFile = `${keyFile}.link`;
  const hardLinkFile = `${keyFile}.hard-link`;
  const privateKey = keys().privateKey;
  t.after(() => Promise.all([
    rm(keyFile, { force: true }), rm(linkFile, { force: true }), rm(hardLinkFile, { force: true })
  ]));
  await writeFile(keyFile, privateKey, { mode: 0o600 });
  await chmod(keyFile, 0o600);
  assert.equal((await readSecurePrivateKey(keyFile, { repository })).bytes.toString('utf8'), privateKey);

  if (process.platform !== 'win32') {
    await chmod(keyFile, 0o644);
    await assert.rejects(readSecurePrivateKey(keyFile, { repository }), /use mode 0600/);
    await chmod(keyFile, 0o600);
  }
  await symlink(keyFile, linkFile);
  await assert.rejects(readSecurePrivateKey(linkFile, { repository }), /non-symlink/);
  await link(keyFile, hardLinkFile);
  await assert.rejects(readSecurePrivateKey(keyFile, { repository }), /exactly one filesystem link/);
  await rm(hardLinkFile, { force: true });
  const inRepository = path.join(repository, 'private.pem');
  await writeFile(inRepository, privateKey, { mode: 0o600 });
  await chmod(inRepository, 0o600);
  await assert.rejects(readSecurePrivateKey(inRepository, { repository }), /outside the release repository/);
});

test('release public trust roots are bounded ordinary files outside the repository', async (t) => {
  const repository = await sourceRepository(t);
  const keyFile = path.join(path.dirname(repository), `${path.basename(repository)}-trusted-public.pem`);
  const linkFile = `${keyFile}.link`;
  const hardLinkFile = `${keyFile}.hard-link`;
  const publicKey = keys().publicKey;
  t.after(() => Promise.all([
    rm(keyFile, { force: true }), rm(linkFile, { force: true }), rm(hardLinkFile, { force: true })
  ]));
  await writeFile(keyFile, publicKey);
  assert.equal((await readSecurePublicKey(keyFile, { repository })).bytes.toString('utf8'), publicKey);
  await symlink(keyFile, linkFile);
  await assert.rejects(readSecurePublicKey(linkFile, { repository }), /non-symlink/);
  await link(keyFile, hardLinkFile);
  await assert.rejects(readSecurePublicKey(keyFile, { repository }), /unsafe file type, size, or link count/);
  await rm(hardLinkFile, { force: true });
  const inRepository = path.join(repository, 'trusted-public.pem');
  await writeFile(inRepository, publicKey);
  await assert.rejects(readSecurePublicKey(inRepository, { repository }), /outside the release repository/);
});

test('Windows release signing keys require a verified current-user-only ACL', async (t) => {
  const repository = await sourceRepository(t);
  const keyFile = path.join(path.dirname(repository), `${path.basename(repository)}-windows-signing.pem`);
  t.after(() => rm(keyFile, { force: true }));
  await writeFile(keyFile, keys().privateKey, { mode: 0o600 });
  let observed;
  await readSecurePrivateKey(keyFile, {
    repository,
    platform: 'win32',
    windowsAcl: async (target, options) => {
      observed = { target, options };
      return { protected: true, principal: 'current-user', access: 'full-control' };
    }
  });
  assert.equal(observed.target, await realpath(keyFile));
  assert.deepEqual(observed.options, { apply: false });
  await assert.rejects(readSecurePrivateKey(keyFile, {
    repository,
    platform: 'win32',
    windowsAcl: async () => { throw new Error('unsafe inherited ACL'); }
  }), /verified, non-inherited, current-user-only Windows ACL/);
});
