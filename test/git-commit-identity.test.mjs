import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  gitCommitIdentityArgs, gitCommitIdentityEnvironment, gitCommitSigningArgs,
  preflightGitCommitIdentity, resolveGitCommitIdentity, resolveGitCommitSigning
} from '../src/git.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-commit-identity-'));
  const root = path.join(parent, 'repo');
  await mkdir(root);
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return { parent, root };
}

test('frozen Git identity ignores ambient author and committer overrides', async () => {
  const { root } = await repository();
  run('git', ['config', 'user.name', ' Zoë Reviewer '], { cwd: root });
  run('git', ['config', 'user.email', 'zoe@example.test'], { cwd: root });
  const hostile = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Ambient Author', GIT_AUTHOR_EMAIL: 'ambient-author@example.test',
    GIT_COMMITTER_NAME: 'Ambient Committer', GIT_COMMITTER_EMAIL: 'ambient-committer@example.test',
    git_author_name: 'Windows Case Variant', git_author_email: 'case-variant@example.test',
    Git_Committer_Name: 'Windows Case Variant', Git_Committer_Email: 'case-variant@example.test'
  };
  const frozen = resolveGitCommitIdentity(root, { env: hostile });
  assert.deepEqual(frozen, {
    name: 'Zoë Reviewer', email: 'zoe@example.test', source: 'configured'
  });
  assert.equal(Object.isFrozen(frozen), true);
  preflightGitCommitIdentity(root, frozen, { env: hostile });
  await writeFile(path.join(root, 'evidence.txt'), 'frozen\n');
  run('git', ['add', 'evidence.txt'], { cwd: root, env: hostile });
  const commitEnv = gitCommitIdentityEnvironment(hostile, frozen);
  assert.equal(Object.keys(commitEnv).some((key) =>
    key !== key.toUpperCase() && /^(git_author|git_committer)_/i.test(key)), false,
  'case variants cannot survive into a Windows child environment');
  run('git', [...gitCommitIdentityArgs(frozen), 'commit', '-qm', 'frozen identity'], {
    cwd: root, env: commitEnv
  });
  const fields = run('git', [
    'show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', 'HEAD'
  ], { cwd: root }).stdout.trim().split('\0');
  assert.deepEqual(fields, [
    'Zoë Reviewer', 'zoe@example.test', 'Zoë Reviewer', 'zoe@example.test'
  ]);
});

test('commit identity uses a labelled fallback only for absence and rejects malformed config', async () => {
  const { parent, root } = await repository();
  const empty = path.join(parent, 'empty.gitconfig');
  await writeFile(empty, '');
  const isolated = {
    ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: os.devNull
  };
  assert.deepEqual(resolveGitCommitIdentity(root, { env: isolated }), {
    name: 'Singularity Flow', email: 'unknown@invalid', source: 'service-fallback'
  });

  run('git', ['config', 'user.name', 'Invalid <Reviewer>'], { cwd: root, env: isolated });
  run('git', ['config', 'user.email', 'reviewer@example.test'], { cwd: root, env: isolated });
  assert.throws(() => resolveGitCommitIdentity(root, { env: isolated }), (error) => {
    assert.equal(error.code, 'GIT_COMMIT_IDENTITY_INVALID');
    assert.equal(error.details?.field, 'user.name');
    return true;
  });
});

test('frozen signing preserves Git alias order and a custom signer through isolation', async () => {
  const { parent, root } = await repository();
  const empty = path.join(parent, 'empty.gitconfig');
  await writeFile(empty, '');
  const isolated = {
    ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: os.devNull
  };
  const missingProgram = path.join(parent, 'missing-gpg');
  // `gpg.program` and `gpg.openpgp.program` are aliases processed in file order. The final legacy
  // alias is therefore the effective value; blindly preferring the format-specific key is wrong.
  run('git', ['config', 'user.signingkey', 'test-key'], { cwd: root, env: isolated });
  run('git', ['config', 'gpg.openpgp.program', missingProgram], { cwd: root, env: isolated });
  run('git', ['config', 'gpg.program', process.execPath], { cwd: root, env: isolated });

  const signing = resolveGitCommitSigning(root, { env: isolated, required: true });
  assert.deepEqual(signing, {
    required: true,
    key: 'test-key',
    format: 'openpgp',
    program: await realpath(process.execPath)
  });
  assert.equal(Object.isFrozen(signing), true);

  const { root: isolatedCheckout } = await repository();
  const identity = {
    name: 'Frozen Signer', email: 'signer@example.test', source: 'configured'
  };
  preflightGitCommitIdentity(isolatedCheckout, identity, { env: isolated, signing });
  const selected = run('git', [
    ...gitCommitSigningArgs(signing), 'config', '--get', 'gpg.openpgp.program'
  ], { cwd: isolatedCheckout, env: isolated }).stdout.trim();
  assert.equal(selected, signing.program);

  const { root: reverseOrder } = await repository();
  run('git', ['config', 'user.signingkey', 'test-key'], { cwd: reverseOrder, env: isolated });
  run('git', ['config', 'gpg.program', missingProgram], { cwd: reverseOrder, env: isolated });
  run('git', ['config', 'gpg.openpgp.program', process.execPath], {
    cwd: reverseOrder, env: isolated
  });
  assert.equal(
    resolveGitCommitSigning(reverseOrder, { env: isolated, required: true }).program,
    await realpath(process.execPath)
  );
});

test('SSH signing freezes relative key paths and ignores the OpenPGP legacy program', async () => {
  const { parent, root } = await repository();
  const empty = path.join(parent, 'empty.gitconfig');
  const keyDirectory = path.join(root, 'keys');
  const keyPath = path.join(keyDirectory, 'reviewer.pub');
  await writeFile(empty, '');
  await mkdir(keyDirectory);
  await writeFile(keyPath, 'ssh-ed25519 AAAATEST reviewer@example.test\n');
  const isolated = {
    ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: os.devNull
  };
  run('git', ['config', 'gpg.format', 'ssh'], { cwd: root, env: isolated });
  run('git', ['config', 'user.signingkey', 'keys/reviewer.pub'], { cwd: root, env: isolated });
  run('git', ['config', 'gpg.program', path.join(parent, 'missing-openpgp')], {
    cwd: root, env: isolated
  });
  run('git', ['config', 'gpg.ssh.program', process.execPath], { cwd: root, env: isolated });

  const signing = resolveGitCommitSigning(root, { env: isolated, required: true });
  assert.equal(signing.format, 'ssh');
  assert.equal(signing.key, await realpath(keyPath));
  assert.equal(signing.program, await realpath(process.execPath));

  // Preflight takes place from the isolated activation checkout, not the initiating repository.
  // The absolute frozen path must still refer to the initiating repository's reviewed key.
  const { root: isolatedCheckout } = await repository();
  preflightGitCommitIdentity(isolatedCheckout, {
    name: 'SSH Signer', email: 'ssh@example.test', source: 'configured'
  }, { env: isolated, signing });
  await rename(keyPath, `${keyPath}.removed`);
  assert.throws(
    () => preflightGitCommitIdentity(isolatedCheckout, {
      name: 'SSH Signer', email: 'ssh@example.test', source: 'configured'
    }, { env: isolated, signing }),
    (error) => error.code === 'GIT_COMMIT_SIGNING_INVALID'
      && error.details?.setting === 'user.signingkey'
  );
});

test('required signing rejects deterministically unavailable programs and SSH keys', async () => {
  const { parent, root } = await repository();
  const empty = path.join(parent, 'empty.gitconfig');
  await writeFile(empty, '');
  const isolated = {
    ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: os.devNull
  };
  run('git', ['config', 'user.signingkey', 'test-key'], { cwd: root, env: isolated });
  run('git', ['config', 'gpg.program', path.join(parent, 'missing-gpg')], {
    cwd: root, env: isolated
  });
  assert.throws(
    () => resolveGitCommitSigning(root, { env: isolated, required: true }),
    (error) => error.code === 'GIT_COMMIT_SIGNING_INVALID'
      && error.details?.setting === 'gpg.openpgp.program'
  );

  run('git', ['config', 'gpg.format', 'ssh'], { cwd: root, env: isolated });
  run('git', ['config', 'gpg.ssh.program', process.execPath], { cwd: root, env: isolated });
  run('git', ['config', 'user.signingkey', 'keys/missing.pub'], { cwd: root, env: isolated });
  assert.throws(
    () => resolveGitCommitSigning(root, { env: isolated, required: true }),
    (error) => error.code === 'GIT_COMMIT_SIGNING_INVALID'
      && error.details?.setting === 'user.signingkey'
  );
});

test('required signing leaves Git built-in signer discovery intact when no program is configured', async () => {
  const { parent, root } = await repository();
  const empty = path.join(parent, 'empty.gitconfig');
  await writeFile(empty, '');
  const isolated = {
    ...process.env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: os.devNull
  };
  run('git', ['config', 'user.signingkey', 'test-key'], { cwd: root, env: isolated });
  const signing = resolveGitCommitSigning(root, { env: isolated, required: true });
  assert.deepEqual(signing, {
    required: true, key: 'test-key', format: 'openpgp', program: null
  });
  assert.deepEqual(gitCommitSigningArgs(signing), [
    '-c', 'user.signingkey=test-key', '-c', 'gpg.format=openpgp'
  ]);
});
