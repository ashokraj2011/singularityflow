import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  autoAttemptId, discoverAutoCandidateRecoveryAuthority, freezeAutoCandidate,
  publishAutoCandidateRecoveryAuthority, restoreAutoCandidateWorktree
} from '../src/auto/auto-candidate.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture(t, suffix) {
  const producer = await mkdtemp(path.join(os.tmpdir(), `sflow-auto-crash-${suffix}-`));
  const remote = `${producer}.git`;
  t.after(() => rm(producer, { recursive: true, force: true }));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(producer, 'init', '-q', '-b', 'main');
  git(producer, 'config', 'user.name', 'Auto Crash Test');
  git(producer, 'config', 'user.email', 'auto-crash@example.invalid');
  await mkdir(path.join(producer, 'src'), { recursive: true });
  await writeFile(path.join(producer, 'src', 'app.mjs'), 'export const value = 1;\n');
  git(producer, 'add', '.');
  git(producer, 'commit', '-qm', 'baseline');
  git(producer, 'init', '--bare', '-q', remote);
  git(producer, 'remote', 'add', 'origin', remote);
  git(producer, 'push', '-u', 'origin', 'main');
  return { producer, remote, baseline: git(producer, 'rev-parse', 'HEAD') };
}

function freezeThenHardExit(root, options) {
  const moduleUrl = new URL('../src/auto/auto-candidate.mjs', import.meta.url).href;
  const encoded = Buffer.from(JSON.stringify(options)).toString('base64');
  const script = [
    "const api = await import(process.argv[1]);",
    "const options = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));",
    'await api.freezeAutoCandidate(process.argv[2], options);',
    // Deliberately leave no finally/checkpoint/state-attachment opportunity after freeze returns.
    'process.exit(73);'
  ].join('\n');
  return spawnSync(process.execPath, [
    '--input-type=module', '-e', script, moduleUrl, root, encoded
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
}

for (const [index, disposition] of ['authored', 'preserved-after-failure'].entries()) {
  test(`a fresh clone reconstructs the exact ${disposition} Candidate after the freeze crash boundary`, async (t) => {
    const { producer, remote, baseline } = await fixture(t, `${index}`);
    const flightId = `AFL-${String.fromCharCode(65 + index).repeat(26)}`;
    const attemptId = autoAttemptId({
      flightId, phase: 'implementation', attemptNumber: index + 1, generationIntentId: 'GEN-1'
    });
    const baseCheckpointSha256 = `sha256:${String(index + 1).repeat(64)}`;
    await writeFile(path.join(producer, 'src', 'app.mjs'),
      `export const value = ${index + 2};\n`);

    const crashed = freezeThenHardExit(producer, {
      flightId, attemptId, baselineCommit: baseline, executionUnitId: 'copilot-cli',
      recoveryAuthority: {
        phase: 'implementation', baseCheckpointSha256, disposition,
        attemptNumber: index + 1, modelInvocations: index + 1, remote: 'origin'
      }
    });
    assert.equal(crashed.status, 73, crashed.stderr || crashed.stdout);

    // This is the injected hard-crash boundary: no flight-state attachment or governed checkpoint
    // follows freeze. A separate clone has only ordinary Git remote authority to recover from.
    const recoveredClone = await mkdtemp(path.join(os.tmpdir(), `sflow-auto-recovered-${index}-`));
    t.after(() => rm(recoveredClone, { recursive: true, force: true }));
    git(producer, 'clone', '-q', '--branch', 'main', remote, recoveredClone);
    const recovered = await discoverAutoCandidateRecoveryAuthority(recoveredClone, {
      flightId, phase: 'implementation', baseCheckpointSha256, remote: 'origin'
    });

    assert.equal(recovered.disposition, disposition);
    assert.equal(recovered.attemptNumber, index + 1);
    assert.equal(recovered.modelInvocations, index + 1);
    assert.equal(recovered.binding.attemptId, attemptId);
    assert.match(recovered.binding.bindingSha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(recovered.binding.repository.candidateCommit, /^[a-f0-9]{40,64}$/);
    await restoreAutoCandidateWorktree(recoveredClone, recovered.binding);
    assert.equal(await readFile(path.join(recoveredClone, 'src', 'app.mjs'), 'utf8'),
      `export const value = ${index + 2};\n`);
  });
}

test('failure preservation monotonically wins over an authored journal for the same Candidate', async (t) => {
  const { producer, baseline } = await fixture(t, 'precedence');
  const flightId = `AFL-${'C'.repeat(26)}`;
  const attemptId = autoAttemptId({
    flightId, phase: 'implementation', attemptNumber: 2, generationIntentId: 'GEN-2'
  });
  const baseCheckpointSha256 = `sha256:${'3'.repeat(64)}`;
  await writeFile(path.join(producer, 'src', 'app.mjs'), 'export const value = 9;\n');
  const binding = await freezeAutoCandidate(producer, {
    flightId, attemptId, baselineCommit: baseline, executionUnitId: 'copilot-cli',
    recoveryAuthority: {
      phase: 'implementation', baseCheckpointSha256, disposition: 'authored',
      attemptNumber: 2, modelInvocations: 2, remote: 'origin'
    }
  });
  await publishAutoCandidateRecoveryAuthority(producer, binding, {
    phase: 'implementation', baseCheckpointSha256,
    disposition: 'preserved-after-failure', attemptNumber: 2,
    modelInvocations: 2, remote: 'origin'
  });
  const recovered = await discoverAutoCandidateRecoveryAuthority(producer, {
    flightId, phase: 'implementation', baseCheckpointSha256, remote: 'origin'
  });
  assert.equal(recovered.disposition, 'preserved-after-failure');
  assert.equal(recovered.binding.bindingSha256, binding.bindingSha256);
  await publishAutoCandidateRecoveryAuthority(producer, binding, {
    phase: 'implementation', baseCheckpointSha256,
    disposition: 'preserved-after-failure', attemptNumber: 2,
    modelInvocations: 3, remote: 'origin'
  });
  await assert.rejects(
    discoverAutoCandidateRecoveryAuthority(producer, {
      flightId, phase: 'implementation', baseCheckpointSha256, remote: 'origin'
    }),
    (error) => error.code === 'AUTO_CANDIDATE_RECOVERY_CONFLICT'
  );
});
