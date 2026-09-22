import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  autoAttemptId, freezeAutoCandidate, restoreAutoCandidateAuthority
} from '../src/auto/auto-candidate.mjs';
import { canonicalJson } from '../src/records.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-env-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Candidate Admission Test');
  git(root, 'config', 'user.email', 'candidate-admission@example.invalid');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - name: API_TOKEN
        kind: secret
    localFiles:
      - config/qa.private.yml
checks: {}
neverCommit:
  - .env*
`);
  await writeFile(path.join(root, 'src', 'app.mjs'), 'export const ready = true;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

function noCandidateRefs(root, namespace) {
  return git(root, 'for-each-ref', '--format=%(refname)', namespace);
}

const secret = 'AKIA1234567890ABCDEF';
const actor = Object.freeze({ kind: 'human', id: 'candidate-admission@example.invalid' });

test('Auto Candidate issuance refuses environment-local paths and detected secrets before retention', async (t) => {
  for (const scenario of [
    { name: 'environment-local', file: '.ENV.QA', content: 'SAFE_NAME=value\n', code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' },
    { name: 'secret-bearing', file: 'src/credential.txt', content: `token=${secret}\n`, code: 'SECRET_DETECTED' }
  ]) {
    await t.test(scenario.name, async (st) => {
      const root = await repository(st);
      const baselineCommit = git(root, 'rev-parse', 'HEAD');
      await writeFile(path.join(root, scenario.file), scenario.content);
      const flightId = `AFL-${scenario.name === 'environment-local' ? 'D' : 'E'}`.padEnd(30, 'A');
      await assert.rejects(freezeAutoCandidate(root, {
        flightId,
        attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
        baselineCommit,
        executionUnitId: 'candidate-admission-test'
      }), (error) => {
        assert.equal(error.code, scenario.code);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
      assert.equal(noCandidateRefs(root, 'refs/singularity-flow/auto-candidates'), '');
    });
  }
});

test('SGOS Candidate issuance refuses environment-local paths and detected secrets before retention', async (t) => {
  for (const scenario of [
    { name: 'environment-local', file: '.ENV.QA', content: 'SAFE_NAME=value\n', code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' },
    { name: 'secret-bearing', file: 'src/credential.txt', content: `token=${secret}\n`, code: 'SECRET_DETECTED' }
  ]) {
    await t.test(scenario.name, async (st) => {
      const root = await repository(st);
      await writeFile(path.join(root, scenario.file), scenario.content);
      await assert.rejects(freezeSgosCandidate(root, {
        subjectId: `candidate-${scenario.name}`,
        createdBy: actor,
        createdAt: '2026-09-22T00:00:00.000Z'
      }), (error) => {
        assert.equal(error.code, scenario.code);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
      assert.equal(noCandidateRefs(root, 'refs/singularity-flow/candidates'), '');
    });
  }
});

async function maliciousCommit(root, file, content) {
  const baseline = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, file), content);
  git(root, 'add', '-f', '--', file);
  git(root, 'commit', '-qm', 'legacy candidate created before admission');
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', `${commit}^{tree}`);
  git(root, 'reset', '-q', '--hard', baseline);
  return { baseline, commit, tree };
}

function digest(value) {
  return `sha256:${createHash('sha256').update(Buffer.from(canonicalJson(value))).digest('hex')}`;
}

function bindLegacyAutoCandidate(safe, { commit, tree }) {
  const binding = structuredClone(safe);
  binding.repository.candidateCommit = commit;
  binding.repository.candidateTree = tree;
  delete binding.bindingSha256;
  binding.bindingSha256 = digest(binding);
  return binding;
}

test('Auto Candidate recovery re-admits legacy remote trees before restoring an immutable ref', async (t) => {
  for (const scenario of [
    { name: 'environment-local', file: '.ENV.RECOVERY', content: 'SAFE_NAME=value\n', code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' },
    { name: 'secret-bearing', file: 'src/recovery-token.txt', content: `token=${secret}\n`, code: 'SECRET_DETECTED' }
  ]) {
    await t.test(scenario.name, async (st) => {
      const root = await repository(st);
      const baselineCommit = git(root, 'rev-parse', 'HEAD');
      const flightId = `AFL-${scenario.name === 'environment-local' ? 'B' : 'C'}`.padEnd(30, 'A');
      const safe = await freezeAutoCandidate(root, {
        flightId,
        attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
        baselineCommit,
        executionUnitId: 'candidate-admission-test'
      });
      const malicious = await maliciousCommit(root, scenario.file, scenario.content);
      const binding = bindLegacyAutoCandidate(safe, malicious);

      const remote = `${root}.git`;
      st.after(() => rm(remote, { recursive: true, force: true }));
      git(root, 'init', '--bare', '-q', remote);
      git(root, 'remote', 'add', 'origin', remote);
      git(root, 'push', '-q', 'origin', `${baselineCommit}:refs/heads/main`);
      git(root, 'push', '-q', 'origin', `${malicious.commit}:${binding.repository.retainedRef}`);

      const clone = await mkdtemp(path.join(os.tmpdir(), 'sflow-env-candidate-clone-'));
      st.after(() => rm(clone, { recursive: true, force: true }));
      git(root, 'clone', '-q', '--branch', 'main', remote, clone);
      await assert.rejects(restoreAutoCandidateAuthority(clone, binding), (error) => {
        assert.equal(error.code, scenario.code);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
      assert.equal(noCandidateRefs(clone, 'refs/singularity-flow/auto-candidates'), '');
    });
  }
});

test('Auto recovery ignores a local replacement that disguises the retained remote tree', async (t) => {
  const root = await repository(t);
  const baselineCommit = git(root, 'rev-parse', 'HEAD');
  const flightId = `AFL-${'F'.repeat(26)}`;
  const safe = await freezeAutoCandidate(root, {
    flightId,
    attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
    baselineCommit,
    executionUnitId: 'candidate-admission-test'
  });
  const malicious = await maliciousCommit(
    root, 'src/replaced-recovery-token.txt', `token=${secret}\n`
  );
  const binding = bindLegacyAutoCandidate(safe, malicious);

  const remote = `${root}.git`;
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(root, 'init', '--bare', '-q', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', `${baselineCommit}:refs/heads/main`);
  git(root, 'push', '-q', 'origin', `${malicious.commit}:${binding.repository.retainedRef}`);

  const clone = await mkdtemp(path.join(os.tmpdir(), 'sflow-env-replace-clone-'));
  t.after(() => rm(clone, { recursive: true, force: true }));
  git(root, 'clone', '-q', '--branch', 'main', remote, clone);
  git(clone, 'fetch', '-q', 'origin', binding.repository.retainedRef);
  git(clone, 'replace', malicious.tree, safe.repository.candidateTree);

  await assert.rejects(restoreAutoCandidateAuthority(clone, binding), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.equal(noCandidateRefs(clone, 'refs/singularity-flow/auto-candidates'), '');
});

test('SGOS exact-commit recovery re-admits legacy trees before retaining them', async (t) => {
  for (const scenario of [
    { name: 'environment-local', file: '.ENV.RECOVERY', content: 'SAFE_NAME=value\n', code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED' },
    { name: 'secret-bearing', file: 'src/recovery-token.txt', content: `token=${secret}\n`, code: 'SECRET_DETECTED' }
  ]) {
    await t.test(scenario.name, async (st) => {
      const root = await repository(st);
      const malicious = await maliciousCommit(root, scenario.file, scenario.content);
      await assert.rejects(freezeSgosCandidate(root, {
        subjectId: `recovered-${scenario.name}`,
        createdBy: actor,
        createdAt: '2026-09-22T00:00:00.000Z',
        baselineCommit: malicious.baseline,
        exactCandidateCommit: malicious.commit,
        expectedCandidateTree: malicious.tree
      }), (error) => {
        assert.equal(error.code, scenario.code);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
      assert.equal(noCandidateRefs(root, 'refs/singularity-flow/candidates'), '');
    });
  }
});

test('SGOS exact-commit recovery ignores a replacement that disguises retained bytes', async (t) => {
  const root = await repository(t);
  const malicious = await maliciousCommit(
    root, 'src/replaced-sgos-token.txt', `token=${secret}\n`
  );
  const baselineTree = git(root, 'rev-parse', `${malicious.baseline}^{tree}`);
  git(root, 'replace', malicious.tree, baselineTree);

  await assert.rejects(freezeSgosCandidate(root, {
    subjectId: 'recovered-replace-ref',
    createdBy: actor,
    createdAt: '2026-09-22T00:00:00.000Z',
    baselineCommit: malicious.baseline,
    exactCandidateCommit: malicious.commit,
    expectedCandidateTree: malicious.tree
  }), (error) => {
    assert.equal(error.code, 'SECRET_DETECTED');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  assert.equal(noCandidateRefs(root, 'refs/singularity-flow/candidates'), '');
});
