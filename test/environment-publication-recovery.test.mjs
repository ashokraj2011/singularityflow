import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configuredRemoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { bindLifecycleEvent, lifecycleEvent } from '../src/lifecycle-event.mjs';
import {
  readPendingPublication, syncPendingLifecyclePublication, writePendingPublication
} from '../src/publication-pending.mjs';
import { recordSha256 } from '../src/records.mjs';

function git(root, args, { input = null } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', input });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-env-recovery-'));
  const root = path.join(base, 'repository');
  const remote = path.join(base, 'origin.git');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Environment Recovery']);
  git(root, ['config', 'user.email', 'environment-recovery@example.invalid']);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# environment recovery fixture\n');
  await writeFile(path.join(root, 'singularity', 'environments.yml'), `schemaVersion: 1
environments:
  qa:
    requires:
      - { name: API_TOKEN, kind: secret }
    localFiles:
      - config/qa.private.yml
checks: {}
neverCommit: []
`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  git(base, ['init', '-q', '--bare', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  return { root, remote };
}

async function installLegacyPendingCommit(root, subject, relative, content) {
  const expectedHead = git(root, ['rev-parse', 'HEAD']);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), content);
  // Raw Git deliberately simulates an authenticated pending receipt produced before Candidate and
  // ENV admission existed. Current publication APIs would refuse this tree before creating it.
  git(root, ['add', '-f', '--', relative]);
  const tree = git(root, ['write-tree']);
  const event = lifecycleEvent({
    type: 'artifact-generated',
    subject,
    phaseId: 'intake',
    generation: 1,
    actor: {
      kind: 'human', id: 'environment-recovery@example.invalid',
      name: 'Environment Recovery', email: 'environment-recovery@example.invalid'
    },
    payload: { legacyRecoveryFixture: true }
  });
  const eventSha256 = `sha256:${recordSha256(event)}`;
  const transactionId = `legacy-env-${subject.id}`;
  const remoteFingerprint = configuredRemoteFingerprint(root, 'origin');
  const stateSha256 = `sha256:${recordSha256({
    transactionId,
    expectedHead,
    branch: 'main',
    tree,
    eventSha256,
    publicationMode: 'required',
    remoteFingerprint,
    expectedRemoteSha: expectedHead
  })}`;
  const message = `[${subject.id}] legacy environment recovery fixture\n\n`
    + `Singularity-Flow-Transaction: ${transactionId}\n`
    + `Singularity-Flow-Event-SHA256: ${eventSha256}\n`
    + `Singularity-Flow-State-SHA256: ${stateSha256}\n`
    + 'Singularity-Flow-Publication-Mode: required\n';
  const commit = git(root, ['commit-tree', tree, '-p', expectedHead], { input: message });
  git(root, ['update-ref', 'refs/heads/main', commit, expectedHead]);
  git(root, ['reset', '-q', '--hard', commit]);
  const record = {
    schemaVersion: 3,
    subject,
    branch: 'main',
    remote: 'origin',
    remoteFingerprint,
    commit,
    transactionId,
    tree,
    eventSha256,
    stateSha256,
    publicationMode: 'required',
    candidate: null,
    expectedRemoteSha: expectedHead,
    pushOutcome: 'rejected',
    event: bindLifecycleEvent(event, commit),
    createdAt: '2026-09-22T00:00:00.000Z'
  };
  await writePendingPublication(root, { ...subject, record });
  return { expectedHead, commit };
}

test('legacy pending publication recovery re-admits exact environment-local and secret bytes', async (t) => {
  for (const fixture of [
    {
      id: 'ENV-LEGACY-LOCAL',
      relative: 'config/qa.private.yml',
      content: 'safe-looking: true\n',
      code: 'ENVIRONMENT_LOCAL_CONTENT_REFUSED'
    },
    {
      id: 'ENV-LEGACY-SECRET',
      relative: 'src/credential.txt',
      content: `token = "ghp_${'Z'.repeat(36)}"\n`,
      code: 'SECRET_DETECTED'
    }
  ]) {
    await t.test(fixture.id, async (t) => {
      const { root, remote } = await repository(t);
      const subject = { kind: 'story', id: fixture.id, branch: 'main' };
      const { expectedHead } = await installLegacyPendingCommit(
        root, subject, fixture.relative, fixture.content
      );

      await assert.rejects(
        syncPendingLifecyclePublication(root, subject),
        (error) => error?.code === fixture.code
      );
      assert.equal(git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']), expectedHead,
        'refused recovery advanced the remote branch');
      assert.ok(await readPendingPublication(root, { ...subject, migrate: false }),
        'refused recovery removed its exact retry marker');
    });
  }
});
