import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FosGitObjectService } from '../src/fos-object-service.mjs';
import { captureSkillConfigurationAncestry, verifySkillConfigurationAncestry }
  from '../src/skp-amendment-audit.mjs';
import { removeTemporaryTree, run } from '../src/util.mjs';

const repository = '/approved/configuration.git';

function commit(format, parents, message = 'configuration change') {
  const width = format === 'sha1' ? 40 : 64;
  const bytes = Buffer.from(`tree ${'a'.repeat(width)}\n`
    + parents.map((parent) => `parent ${parent}\n`).join('')
    + 'author Approved Publisher <publisher@example.invalid> 1 +0000\n'
    + 'committer Approved Publisher <publisher@example.invalid> 1 +0000\n\n'
    + `${message}\n`);
  const oid = createHash(format).update(`commit ${bytes.length}\0`).update(bytes).digest('hex');
  return { oid, bytesBase64: bytes.toString('base64') };
}

function proof(format = 'sha1') {
  const ancestorCommit = '1'.repeat(format === 'sha1' ? 40 : 64);
  const intermediate = commit(format, [ancestorCommit]);
  const descendant = commit(format, ['2'.repeat(ancestorCommit.length), intermediate.oid]);
  const retained = { schemaVersion: 1, kind: 'skill-configuration-ancestry', repository,
    ancestorCommit, descendantCommit: descendant.oid, objectFormat: format,
    commits: [descendant, intermediate] };
  const subject = { repository, ancestorCommit, descendantCommit: descendant.oid };
  return { retained, subject };
}

for (const format of ['sha1', 'sha256']) {
  test(`portable ${format} ancestry verifies exact commit hashes and a merge-parent path offline`, () => {
    const { retained, subject } = proof(format);
    assert.equal(verifySkillConfigurationAncestry(retained, subject), true);
  });
}

test('configuration ancestry cannot treat commit-message prose as a parent edge', () => {
  const { retained, subject } = proof();
  const forged = commit('sha1', ['2'.repeat(40)], `parent ${subject.ancestorCommit}`);
  retained.descendantCommit = forged.oid;
  retained.commits = [forged];
  assert.throws(() => verifySkillConfigurationAncestry(retained, {
    ...subject, descendantCommit: forged.oid
  }), { code: 'SKP_AMENDMENT_ANCESTRY_INVALID' });
});

test('portable ancestry refuses future dialects, incomplete chains and ambiguous retained bytes', () => {
  const { retained, subject } = proof();
  for (const change of [
    (copy) => { copy.schemaVersion = 2; },
    (copy) => { copy.commits.pop(); },
    (copy) => { copy.commits.reverse(); },
    (copy) => { copy.commits[0].bytesBase64 += '\n'; },
    (copy) => { copy.commits[0].oid = 'f'.repeat(40); },
    (copy) => { copy.repository = '/another-authority.git'; },
    (copy) => { copy.extraAuthority = true; }
  ]) {
    const corrupt = structuredClone(retained); change(corrupt);
    assert.throws(() => verifySkillConfigurationAncestry(corrupt, subject), {
      code: 'SKP_AMENDMENT_ANCESTRY_INVALID'
    });
  }
});

async function cleanupFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-ancestry-cache-'));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Approved Publisher');
  git('config', 'user.email', 'publisher@example.invalid');
  await writeFile(path.join(root, 'configuration.txt'), 'approved configuration one\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'approved configuration one');
  const ancestorCommit = git('rev-parse', 'HEAD');
  await writeFile(path.join(root, 'configuration.txt'), 'approved configuration two\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'approved configuration two');
  const descendantCommit = git('rev-parse', 'HEAD');
  return { root, snapshot: Object.freeze({ authority: Object.freeze({ remote: root }),
    sourceCommit: descendantCommit }), prior: { repository: root, commit: ancestorCommit } };
}

for (const fault of ['unproven termination', 'scratch removal failure']) {
  test(`configuration ancestry cache cannot bypass ${fault} on same-snapshot retry`, async (t) => {
    const { root, snapshot, prior } = await cleanupFixture();
    const scratches = [];
    let faultEnabled = true;
    let closeCalls = 0;
    const originalClose = FosGitObjectService.prototype.close;
    const originalCreate = fs.promises.mkdtemp;
    const originalRemove = fs.promises.rm;
    const productionPrefix = path.join(os.tmpdir(), 'sflow-skp-ancestry-');
    // Faults stay in the isolated test process; no injectable cleanup bypass is added to the API.
    const createMock = t.mock.method(fs.promises, 'mkdtemp', async (prefix, ...options) => {
      const directory = await originalCreate(prefix, ...options);
      if (prefix === productionPrefix) scratches.push(directory);
      return directory;
    });
    const closeMock = t.mock.method(FosGitObjectService.prototype, 'close', async function () {
      closeCalls += 1;
      const outcome = await originalClose.call(this);
      assert.equal(outcome.terminated, true, 'real test worker must retire before fault injection');
      return faultEnabled && fault === 'unproven termination'
        ? { ...outcome, terminated: false } : outcome;
    });
    const removeMock = t.mock.method(fs.promises, 'rm', async (directory, ...options) => {
      if (faultEnabled && fault === 'scratch removal failure' && scratches.includes(directory)) {
        throw Object.assign(new Error('injected isolated scratch lock'), { code: 'EBUSY' });
      }
      return originalRemove(directory, ...options);
    });
    syncBuiltinESMExports();
    try {
      const expected = { code: fault === 'unproven termination'
        ? 'SKP_AMENDMENT_ANCESTRY_UNAVAILABLE' : 'EBUSY' };
      await assert.rejects(captureSkillConfigurationAncestry(snapshot, prior), expected);
      await assert.rejects(captureSkillConfigurationAncestry(snapshot, prior), expected);
      assert.equal(closeCalls, 2, 'same snapshot retry must perform capture and cleanup again');
      assert.equal(scratches.length, 2, 'failed cleanup must not publish a cache entry');
      faultEnabled = false;
      const proof = await captureSkillConfigurationAncestry(snapshot, prior);
      assert.equal(closeCalls, 3);
      assert.equal(scratches.length, 3);
      assert.deepEqual(await captureSkillConfigurationAncestry(snapshot, prior), proof);
      assert.equal(closeCalls, 3, 'cache is available only after successful complete cleanup');
      assert.equal(scratches.length, 3);
    } finally {
      closeMock.mock.restore(); createMock.mock.restore(); removeMock.mock.restore();
      syncBuiltinESMExports();
      for (const scratch of scratches) await removeTemporaryTree(scratch);
      await removeTemporaryTree(root);
    }
  });
}
