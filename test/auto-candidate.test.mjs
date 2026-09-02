import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertAutoCandidateMatches, autoAttemptId, autoCandidateEnvironment,
  autoCandidateFromEnvironment, autoCandidatePublicationFromEnvironment,
  freezeAutoCandidate, observeAutoCandidateWorktree, publishAutoCandidateAuthority,
  readAutoCandidateBinding, readAutoCandidateVerification, restoreAutoCandidateAuthority,
  restoreAutoCandidateWorktree, validateAutoCandidateBinding,
  validateAutoCandidateVerification, verifyAutoCandidate
} from '../src/auto/auto-candidate.mjs';
import { gitCommonDir } from '../src/git.mjs';
import { canonicalJson } from '../src/records.mjs';
import {
  buildRepositoryChangeSet, compareRepositoryIdentity
} from '../src/repository-change-set.mjs';
import { sourceTreeHash } from '../src/state.mjs';
import { applicationChangeSetProjection } from '../src/work-intervals.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-test-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Auto Test');
  git(root, 'config', 'user.email', 'auto@example.invalid');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'src', 'delete.mjs'), 'export const removed = true;\n');
  await writeFile(path.join(root, 'src', 'rename.mjs'), 'export const renamed = true;\n');
  await writeFile(path.join(root, 'src', 'mode.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'schemaVersion: 1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

test('Auto Candidate freezes an exact Git authority for add/delete/rename/mode/symlink changes', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 2;\n');
  await unlink(path.join(root, 'src', 'delete.mjs'));
  await rename(path.join(root, 'src', 'rename.mjs'), path.join(root, 'src', 'renamed.mjs'));
  await chmod(path.join(root, 'src', 'mode.sh'), 0o755);
  await writeFile(path.join(root, 'src', 'added.mjs'), 'export const added = true;\n');
  if (process.platform !== 'win32') await symlink('app.mjs', path.join(root, 'src', 'link.mjs'));

  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: baselineCommit });
  const applicationChangeSet = applicationChangeSetProjection(changeSet);
  const flightId = `AFL-${'A'.repeat(26)}`;
  const attemptId = autoAttemptId({
    flightId, phase: 'implementation', attemptNumber: 1, generationIntentId: 'GEN-1'
  });
  const candidate = await freezeAutoCandidate(root, {
    flightId, attemptId, baselineCommit, executionUnitId: 'copilot-cli'
  });

  assert.equal(candidate.candidateSha256, await sourceTreeHash(root));
  assert.equal(candidate.applicationChangeSetDigest, candidate.resourceManifest.changeSetDigest);
  assert.deepEqual(
    new Set(candidate.resourceManifest.entries.map((entry) => entry.status)),
    new Set(process.platform === 'win32'
      ? ['added', 'deleted', 'modified', 'renamed']
      : ['added', 'deleted', 'modified', 'renamed'])
  );
  assert.ok(candidate.resourceManifest.entries.some((entry) => entry.newMode === '100755'));
  if (process.platform !== 'win32') {
    assert.ok(candidate.resourceManifest.entries.some((entry) => entry.newMode === '120000'));
  }
  assert.equal(git(root, 'rev-parse', candidate.repository.retainedRef), candidate.repository.candidateCommit);
  assert.equal(git(root, 'rev-parse', `${candidate.repository.candidateCommit}^{tree}`), candidate.repository.candidateTree);

  const reread = await readAutoCandidateBinding(root, {
    flightId, candidateId: candidate.candidateId
  });
  assert.deepEqual(reread, candidate);
  const fromEnvironment = await autoCandidateFromEnvironment(root, autoCandidateEnvironment(candidate));
  assert.equal(fromEnvironment.bindingSha256, candidate.bindingSha256);

  await writeFile(path.join(root, 'src', 'late.mjs'), 'export const late = true;\n');
  const changed = await observeAutoCandidateWorktree(root, candidate);
  assert.throws(
    () => assertAutoCandidateMatches(candidate, changed),
    (error) => error.code === 'AUTO_CANDIDATE_CHANGED'
  );
  assert.notEqual(await sourceTreeHash(root), candidate.candidateSha256);
});

test('Auto Candidate rejects an oversized resource manifest before hashing or iterating it', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 2;\n');
  const flightId = `AFL-${'B'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const oversized = structuredClone(candidate);
  oversized.resourceManifest.entries = Array.from(
    { length: 20_001 }, () => structuredClone(candidate.resourceManifest.entries[0])
  );
  assert.throws(
    () => validateAutoCandidateBinding(oversized),
    (error) => error.code === 'AUTO_CANDIDATE_RESOURCE_LIMIT'
      && /at most 20000/.test(error.message)
  );
});

test('Candidate and change-set identities never consult the host locale', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  for (const name of ['I.mjs', 'i.mjs', 'ı.mjs', 'ä.mjs']) {
    await writeFile(path.join(root, 'src', name), `export default ${JSON.stringify(name)};\n`);
  }
  const flightId = `AFL-${'E'.repeat(26)}`;
  const attemptId = autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 });
  const expectedChangeSet = await buildRepositoryChangeSet(root, { baseCommit: baselineCommit });
  const expectedCandidate = await freezeAutoCandidate(root, {
    flightId, attemptId, baselineCommit, executionUnitId: 'copilot-cli'
  });

  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = () => {
    throw new Error('durable repository ordering consulted the host locale');
  };
  try {
    assert.ok(compareRepositoryIdentity('ä', 'z') > 0);
    const observedChangeSet = await buildRepositoryChangeSet(root, { baseCommit: baselineCommit });
    const observedCandidate = await freezeAutoCandidate(root, {
      flightId, attemptId, baselineCommit, executionUnitId: 'copilot-cli'
    });
    assert.equal(observedChangeSet.digest, expectedChangeSet.digest);
    assert.equal(observedCandidate.candidateSha256, expectedCandidate.candidateSha256);
    assert.equal(observedCandidate.bindingSha256, expectedCandidate.bindingSha256);
  } finally {
    String.prototype.localeCompare = original;
  }
});

test('Auto Candidate binds gitlink commits exactly and refuses dirty nested submodule files', async (t) => {
  const root = await repository();
  const child = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-submodule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(child, { recursive: true, force: true }));
  git(child, 'init', '-q');
  git(child, 'config', 'user.name', 'Submodule Test');
  git(child, 'config', 'user.email', 'submodule@example.invalid');
  await writeFile(path.join(child, 'library.mjs'), 'export const version = 1;\n');
  git(child, 'add', '.');
  git(child, 'commit', '-qm', 'submodule baseline');
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/library');
  git(root, 'commit', '-qam', 'add exact submodule');
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  const nested = path.join(root, 'vendor', 'library');
  git(nested, 'config', 'user.name', 'Submodule Test');
  git(nested, 'config', 'user.email', 'submodule@example.invalid');

  const flightId = `AFL-${'F'.repeat(26)}`;
  const baselineCandidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  await writeFile(path.join(nested, 'library.mjs'), 'export const version = 2;\n');
  git(nested, 'add', '.');
  git(nested, 'commit', '-qm', 'submodule pointer update');
  const nestedHead = git(nested, 'rev-parse', 'HEAD');
  const changedCandidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 2 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  assert.notEqual(changedCandidate.candidateSha256, baselineCandidate.candidateSha256);
  assert.equal(changedCandidate.candidateSha256, await sourceTreeHash(root));
  assert.ok(changedCandidate.resourceManifest.entries.some((entry) => (
    entry.newPath === 'vendor/library' && entry.newMode === '160000'
      && entry.newObject === nestedHead
  )));

  await writeFile(path.join(nested, 'uncommitted.mjs'), 'export const dirty = true;\n');
  await assert.rejects(
    () => freezeAutoCandidate(root, {
      flightId,
      attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 3 }),
      baselineCommit,
      executionUnitId: 'copilot-cli'
    }),
    (error) => error.code === 'AUTO_CANDIDATE_DIRTY_SUBMODULE'
  );
});

test('Auto Candidate verifies the stored-version hash before migration and never rewrites tampering', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 3;\n');
  const applicationChangeSet = applicationChangeSetProjection(
    await buildRepositoryChangeSet(root, { baseCommit: baselineCommit })
  );
  const flightId = `AFL-${'B'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const target = path.join(
    gitCommonDir(root), 'singularity-flow', 'auto-flights', flightId, 'candidates',
    `${candidate.candidateId}.json`
  );
  const original = await readFile(target, 'utf8');
  const tampered = JSON.parse(original);
  tampered.candidateSha256 = `sha256:${'f'.repeat(64)}`;
  await writeFile(target, JSON.stringify(tampered));
  await assert.rejects(
    readAutoCandidateBinding(root, { flightId, candidateId: candidate.candidateId }),
    (error) => error.code === 'AUTO_CANDIDATE_CORRUPT'
  );
  assert.equal(await readFile(target, 'utf8'), JSON.stringify(tampered));
});

test('a fresh clone restores the exact frozen Candidate from its remote immutable ref', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'HEAD:main');
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 8;\n');
  const flightId = `AFL-${'F'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const verification = await verifyAutoCandidate(root, candidate, {
    verifiedAt: '2026-01-02T03:04:05.000Z',
    commands: [{
      id: 'candidate-smoke', modelPolicy: 'never', workingDirectory: '.',
      argv: [process.execPath, '-e', 'process.exit(0)']
    }]
  });
  await publishAutoCandidateAuthority(root, candidate);
  assert.match(git(root, 'ls-remote', '--refs', 'origin', candidate.repository.retainedRef),
    new RegExp(`^${candidate.repository.candidateCommit}\\s`));

  const clone = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-clone-'));
  t.after(() => rm(clone, { recursive: true, force: true }));
  git(root, 'clone', '-q', '--branch', 'main', remote, clone);
  await restoreAutoCandidateAuthority(clone, candidate, verification);
  const restored = await readAutoCandidateBinding(clone, {
    flightId, candidateId: candidate.candidateId
  });
  assert.equal(restored.bindingSha256, candidate.bindingSha256);
  await restoreAutoCandidateWorktree(clone, restored);
  assert.equal(await readFile(path.join(clone, 'src', 'app.mjs'), 'utf8'),
    'export const value = 8;\n');
  assert.equal(git(clone, 'rev-parse', restored.repository.retainedRef),
    candidate.repository.candidateCommit);
  const restoredVerification = await readAutoCandidateVerification(clone, {
    flightId, candidateId: candidate.candidateId,
    verificationReceiptSha256: verification.verificationReceiptSha256
  });
  assert.deepEqual(restoredVerification, verification);
});

test('isolated Candidate verification allows disposable result output and is crash-idempotent', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 4;\n');
  const flightId = `AFL-${'C'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const first = await verifyAutoCandidate(root, candidate, {
    verifiedAt: '2026-01-02T03:04:05.000Z',
    commands: [{
      id: 'write-result', modelPolicy: 'never', workingDirectory: '.',
      result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/result.json' },
      argv: [process.execPath, '-e',
        "require('fs').mkdirSync('.sflow/results',{recursive:true});require('fs').writeFileSync('.sflow/results/result.json','{}')"]
    }]
  });
  assert.equal(first.status, 'passed');
  assert.equal(first.candidateTreeUnchanged, true);

  const duplicateReceipt = structuredClone(first);
  duplicateReceipt.commands.push(structuredClone(duplicateReceipt.commands[0]));
  delete duplicateReceipt.verificationReceiptSha256;
  duplicateReceipt.verificationReceiptSha256 = `sha256:${createHash('sha256')
    .update(canonicalJson(duplicateReceipt)).digest('hex')}`;
  assert.throws(() => validateAutoCandidateVerification(duplicateReceipt),
    (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_CORRUPT'
      && /duplicate command IDs/i.test(error.message));

  const reused = await verifyAutoCandidate(root, candidate, {
    verifiedAt: '2099-01-01T00:00:00.000Z',
    commands: [{ id: 'must-not-run', argv: [process.execPath, '-e', 'process.exit(99)'] }]
  });
  assert.deepEqual(reused, first);
  const publication = await autoCandidatePublicationFromEnvironment(
    root, autoCandidateEnvironment(candidate, reused)
  );
  assert.equal(publication.binding.bindingSha256, candidate.bindingSha256);
  assert.equal(publication.verification.verificationReceiptSha256,
    first.verificationReceiptSha256);
});

test('isolated Candidate verification refuses a tracked symlink working directory', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation requires privileges on Windows');
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await symlink(outside, path.join(root, 'src', 'outside-workdir'));
  const flightId = `AFL-${'7'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const marker = path.join(outside, 'verifier-ran');

  await assert.rejects(verifyAutoCandidate(root, candidate, {
    commands: [{
      id: 'escaped-cwd', modelPolicy: 'never', workingDirectory: 'src/outside-workdir',
      argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
    }]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_INVALID'
    && /working directory.*not securely contained/i.test(error.message));
  await assert.rejects(readFile(marker), (error) => error.code === 'ENOENT');
});

test('isolated Candidate verification refuses a tracked symlink result parent', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation requires privileges on Windows');
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await symlink(outside, path.join(root, 'src', 'outside-results'));
  const flightId = `AFL-${'8'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const marker = path.join(outside, 'verifier-ran');

  await assert.rejects(verifyAutoCandidate(root, candidate, {
    commands: [{
      id: 'escaped-result', kind: 'test', modelPolicy: 'never', workingDirectory: '.',
      affectedRoots: ['src'],
      result: { adapter: 'node-tap', path: 'src/outside-results/result.tap' },
      argv: [process.execPath, '-e', [
        `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        "process.stdout.write('TAP version 13\\nnot ok 1 - failed\\n1..1\\n')",
        'process.exit(1)'
      ].join(';')]
    }]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_INVALID'
    && /evidence path.*not securely contained/i.test(error.message));
  await assert.rejects(readFile(marker), (error) => error.code === 'ENOENT');
  await assert.rejects(readFile(path.join(outside, 'result.tap')),
    (error) => error.code === 'ENOENT');
});

test('isolated Candidate verification refuses duplicate evidence output paths before execution', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  const flightId = `AFL-${'9'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const marker = path.join(root, 'verifier-ran');
  const command = (id) => ({
    id, modelPolicy: 'never', workingDirectory: '.',
    result: { adapter: 'sflow-test-result-v1', path: '.sflow/results/result.json' },
    argv: [process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
  });

  await assert.rejects(verifyAutoCandidate(root, candidate, {
    commands: [command('first'), command('second')]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_INVALID'
    && /distinct evidence output paths/i.test(error.message));
  await assert.rejects(readFile(marker), (error) => error.code === 'ENOENT');
});

test('isolated Candidate verification refuses duplicate command IDs before execution', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  const flightId = `AFL-${'A'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  const marker = path.join(root, 'verifier-ran');
  const command = (resultPath) => ({
    id: 'duplicate', modelPolicy: 'never', workingDirectory: '.',
    result: { adapter: 'sflow-test-result-v1', path: resultPath },
    argv: [process.execPath, '-e',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
  });

  await assert.rejects(verifyAutoCandidate(root, candidate, {
    commands: [
      command('.sflow/results/first.json'),
      command('.sflow/results/second.json')
    ]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_INVALID'
    && /distinct command IDs/i.test(error.message));
  await assert.rejects(readFile(marker), (error) => error.code === 'ENOENT');
});

test('isolated Candidate verification records and refuses source mutation', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 5;\n');
  const flightId = `AFL-${'D'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  await assert.rejects(verifyAutoCandidate(root, candidate, {
    verifiedAt: '2026-01-02T03:04:05.000Z',
    commands: [{
      id: 'mutate-source', modelPolicy: 'never', workingDirectory: '.',
      argv: [process.execPath, '-e',
        "require('fs').writeFileSync('src/app.mjs','export const value = 6;\\n')"]
    }]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_MUTATED');
  const failed = await readAutoCandidateVerification(root, {
    flightId, candidateId: candidate.candidateId
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.candidateTreeUnchanged, false);
  await assert.rejects(verifyAutoCandidate(root, candidate, {
    commands: [{ id: 'would-pass', argv: [process.execPath, '-e', 'process.exit(0)'] }]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_MUTATED');
});

test('isolated Candidate verification refuses tracked governance or harness mutation', async (t) => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const value = 7;\n');
  const flightId = `AFL-${'E'.repeat(26)}`;
  const candidate = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'copilot-cli'
  });
  await assert.rejects(verifyAutoCandidate(root, candidate, {
    commands: [{
      id: 'mutate-governance', modelPolicy: 'never', workingDirectory: '.',
      argv: [process.execPath, '-e',
        "require('fs').writeFileSync('singularity/workflow.yml','schemaVersion: 999\\n')"]
    }]
  }), (error) => error.code === 'AUTO_CANDIDATE_VERIFICATION_MUTATED');
});
