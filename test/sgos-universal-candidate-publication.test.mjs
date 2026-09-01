import assert from 'node:assert/strict';
import {
  access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

import { commitIsolated, governedCommitIdentity } from '../src/git.mjs';
import { configuredRemoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { syncInitiativePublication } from '../src/initiative-state.mjs';
import { promoteStoryBranch } from '../src/story-lineage.mjs';
import { bindLifecycleEvent, lifecycleEvent } from '../src/lifecycle-event.mjs';
import {
  clearPendingPublication, inspectPendingPublication, localPendingPublicationPath, readPendingPublication,
  syncPendingLifecyclePublication, verifyPendingPublicationCommit,
  verifyPendingPublicationIntegrity, writePendingPublication
} from '../src/publication-pending.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { recordSha256 } from '../src/records.mjs';
import { syncPublication } from '../src/state.mjs';
import {
  freezeAndVerifySgosExistingLifecycleCommit, freezeAndVerifySgosLifecycleCandidate,
  freezeSgosCandidate,
  planSgosCandidatePublication, sgosLifecycleCandidateId, sgosLifecycleCandidateIdentity,
  verifySgosCandidate, verifySgosLifecycleCandidateBinding
} from '../src/sgos/candidate-lifecycle.mjs';
import { publishSgosCandidateVerifierPolicy } from './helpers/sgos-candidate-authority.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository(t, { remote = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-universal-candidate-'));
  const root = path.join(base, 'repository');
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Candidate Boundary']);
  git(root, ['config', 'user.email', 'candidate-boundary@example.com']);
  await writeFile(path.join(root, 'README.md'), '# universal Candidate fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  if (remote) {
    const bare = path.join(base, 'origin.git');
    git(base, ['init', '--bare', bare]);
    git(root, ['remote', 'add', 'origin', bare]);
    git(root, ['push', '-u', 'origin', 'main']);
    return { root, remote: bare };
  }
  return { root, remote: null };
}

function flow(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Candidate Boundary',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({
        workType: 'feature', agent: 'product-owner'
      })
    }
  });
  if (!allowFailure) {
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function eventFor(subject, payload = {}) {
  return lifecycleEvent({
    type: 'artifact-generated',
    subject,
    phaseId: 'intake',
    generation: 1,
    actor: {
      kind: 'human', id: 'candidate-boundary@example.com',
      name: 'Candidate Boundary', email: 'candidate-boundary@example.com'
    },
    payload
  });
}

async function publishFixture(root, subject, {
  publication = null, contents = null, event = null
} = {}) {
  const relative = `${subject.kind}-${subject.id}.json`;
  return new GitPublicationUnitOfWork(root).execute({
    subject,
    allowedPaths: [relative],
    event: event ?? eventFor(subject),
    commit: { message: `[${subject.id}] Candidate boundary fixture` },
    publication: publication ?? { mode: 'off', branch: 'main' },
    state: {
      write: () => writeFile(
        path.join(root, relative),
        contents ?? `${JSON.stringify({ kind: subject.kind, id: subject.id })}\n`
      )
    }
  });
}

async function installForgedCandidateRecoveryMarker(root, subject) {
  const expectedHead = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const relative = `${subject.kind}-${subject.id}-forged.json`;
  const event = eventFor(subject, { forgedCandidateAuthority: true });
  const candidateIdentity = sgosLifecycleCandidateIdentity(event);
  await writeFile(path.join(root, relative), '{"forged":true}\n');
  git(root, ['add', relative]);
  const candidateTree = git(root, ['write-tree']).stdout.trim();
  git(root, ['reset', '--', relative]);
  const fakeSha256 = `sha256:${'a'.repeat(64)}`;
  const candidate = {
    ...candidateIdentity,
    candidateSha256: fakeSha256,
    retainedCandidateSha256: fakeSha256,
    candidateTree,
    candidateCommit: expectedHead,
    verificationReceiptSha256: fakeSha256,
    verificationProfileSha256: fakeSha256
  };
  const eventSha256 = `sha256:${recordSha256(event)}`;
  const transactionId = `forged-candidate-${subject.kind}`;
  const remoteFingerprint = configuredRemoteFingerprint(root, 'origin');
  let stateSha256 = null;
  const commit = await commitIsolated(root, `[${subject.id}] forged Candidate recovery fixture`, [relative], {
    expectedHead,
    expectedRef: 'refs/heads/main',
    transaction: {
      id: transactionId,
      eventSha256,
      publicationMode: 'required',
      candidate,
      stateSha256ForTree: (tree) => {
        stateSha256 = `sha256:${recordSha256({
          transactionId, expectedHead, branch: 'main', tree, eventSha256,
          publicationMode: 'required', candidate, remoteFingerprint,
          expectedRemoteSha: expectedHead
        })}`;
        return stateSha256;
      }
    }
  });
  const marker = {
    schemaVersion: 3,
    subject,
    branch: 'main',
    remote: 'origin',
    remoteFingerprint,
    commit,
    transactionId,
    tree: candidateTree,
    eventSha256,
    stateSha256,
    publicationMode: 'required',
    candidate,
    expectedRemoteSha: expectedHead,
    pushOutcome: 'rejected',
    event: bindLifecycleEvent(event, commit),
    createdAt: '2026-08-30T00:00:00.000Z'
  };
  await writePendingPublication(root, { ...subject, record: marker });
  return { commit, expectedHead, marker };
}

test('Story, Initiative, and ad hoc lifecycle commits all publish the exact verified Candidate tree', async (t) => {
  for (const [kind, id] of [
    ['story', 'CAN-STORY'], ['initiative', 'CAN-INITIATIVE'], ['adhoc', 'AHS-CANDIDATE']
  ]) {
    await t.test(kind, async (t) => {
      const { root } = await repository(t);
      const result = await publishFixture(root, { kind, id, branch: 'main' });
      const identity = governedCommitIdentity(root, result.sha);

      assert.ok(result.candidate, `${kind} publication did not return its Candidate binding`);
      assert.ok(identity?.candidate && identity.candidate.invalid !== true,
        `${kind} governed commit did not carry one complete Candidate trailer binding`);
      assert.equal(result.candidate.candidateTree, identity.tree,
        `${kind} committed a tree other than the verified Candidate tree`);
      assert.deepEqual(identity.candidate, {
        candidateId: result.candidate.candidateId,
        candidateSha256: result.candidate.candidateSha256,
        verificationReceiptSha256: result.candidate.verificationReceiptSha256,
        verificationProfileSha256: result.candidate.verificationProfileSha256
      });
      assert.equal(
        git(root, ['rev-parse', `${result.candidate.candidateCommit}^{tree}`]).stdout.trim(),
        identity.tree,
        `${kind} retained Candidate does not reconstruct the published tree`
      );
    });
  }
});

test('a pending Story receipt proves the same Candidate as the governed commit trailers', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const subject = { kind: 'story', id: 'CAN-PENDING', branch: 'main' };
  const expectedRemoteSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  await assert.rejects(
    publishFixture(root, subject, {
      publication: {
        mode: 'required', branch: 'main', remote: 'origin', expectedRemoteSha
      }
    }),
    /push failed/i
  );

  const pending = await readPendingPublication(root, { ...subject, migrate: false });
  assert.ok(pending?.record?.candidate, 'Candidate binding was omitted from the recovery receipt');
  const identity = governedCommitIdentity(root, pending.record.commit);
  assert.ok(identity?.candidate && identity.candidate.invalid !== true,
    'pending commit has no complete Candidate trailer binding');
  assert.deepEqual(identity.candidate, {
    candidateId: pending.record.candidate.candidateId,
    candidateSha256: pending.record.candidate.candidateSha256,
    verificationReceiptSha256: pending.record.candidate.verificationReceiptSha256,
    verificationProfileSha256: pending.record.candidate.verificationProfileSha256
  });
  assert.equal(pending.record.candidate.candidateTree, identity.tree);

  const verification = verifyPendingPublicationCommit(root, pending.record, {
    subject, branch: 'main', remote: 'origin'
  });
  assert.equal(verification.valid, true,
    `Candidate-bound recovery receipt was not self-consistent: ${verification.failures.join('; ')}`);
  assert.equal(verification.candidateVerified, true);

  await rm(hook, { force: true });
  const recovered = await syncPublication(root, {
    git: { remote: 'origin' }, ledger: { enabled: false }
  }, {
    workItem: { id: subject.id, branch: subject.branch },
    lineage: { canonicalBranch: subject.branch, childBranches: [] },
    resolution: { ledger: { enabled: false } }
  });
  assert.equal(recovered.pushed, pending.record.commit,
    'sync did not publish the exact Candidate-bound recovery commit');
  assert.equal(
    git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(),
    pending.record.commit
  );
});

test('pending-record extensions cannot replace transaction recovery authority', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const subject = { kind: 'story', id: 'CAN-EXTENSION-BOUNDARY', branch: 'main' };
  const expectedRemoteSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const forged = '0'.repeat(expectedRemoteSha.length);

  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject,
      allowedPaths: ['extension-boundary.json'],
      event: eventFor(subject),
      commit: { message: '[CAN-EXTENSION-BOUNDARY] fixture' },
      publication: {
        mode: 'required', branch: 'main', remote: 'origin', expectedRemoteSha
      },
      pendingRecord: () => ({
        customRecoveryNote: 'retained',
        subject: { kind: 'goal', id: 'GEX-FORGED' },
        branch: 'forged', remote: 'forged', commit: forged, tree: forged,
        eventSha256: `sha256:${'0'.repeat(64)}`,
        stateSha256: `sha256:${'0'.repeat(64)}`,
        publicationMode: 'off', candidate: null, expectedRemoteSha: null
      }),
      state: {
        write: () => writeFile(path.join(root, 'extension-boundary.json'), '{}\n')
      }
    }),
    /push failed/i
  );

  const pending = await readPendingPublication(root, { ...subject, migrate: false });
  assert.equal(pending.record.customRecoveryNote, 'retained');
  assert.deepEqual(pending.record.subject, subject);
  assert.equal(pending.record.branch, 'main');
  assert.equal(pending.record.remote, 'origin');
  assert.notEqual(pending.record.commit, forged);
  assert.notEqual(pending.record.tree, forged);
  assert.equal(pending.record.publicationMode, 'required');
  assert.equal(pending.record.expectedRemoteSha, expectedRemoteSha);
  assert.ok(pending.record.candidate);
  const verification = verifyPendingPublicationCommit(root, pending.record, {
    subject, branch: 'main', remote: 'origin'
  });
  assert.equal(verification.valid, true, verification.failures.join('; '));
});

test('recovery refuses self-consistent Candidate trailers without the retained Candidate and receipt', async (t) => {
  for (const kind of ['story', 'initiative', 'adhoc']) {
    await t.test(kind, async (t) => {
      const { root, remote } = await repository(t, { remote: true });
      const subject = { kind, id: `FORGED-${kind.toUpperCase()}`, branch: 'main' };
      const { marker, expectedHead } = await installForgedCandidateRecoveryMarker(root, subject);
      const structural = verifyPendingPublicationCommit(root, marker, {
        subject, branch: 'main', remote: 'origin'
      });
      assert.equal(structural.valid, true,
        'fixture must prove the formerly exploitable self-consistent marker/trailer shape');
      assert.equal(structural.candidateVerified, true,
        'fixture must reach the Candidate authority check rather than an earlier shape refusal');

      const recovery = kind === 'story'
        ? syncPublication(root, { git: { remote: 'origin' }, ledger: { enabled: false } }, {
            workItem: { id: subject.id, branch: subject.branch },
            lineage: { canonicalBranch: subject.branch, childBranches: [] },
            resolution: { ledger: { enabled: false } }
          })
        : kind === 'initiative'
          ? syncInitiativePublication(root, { git: { remote: 'origin' } }, {
              initiative: { id: subject.id, branch: subject.branch },
              resolution: { ledger: { enabled: false } }
            })
          : syncPendingLifecyclePublication(root, subject);
      await assert.rejects(
        recovery,
        (error) => error?.code === 'PENDING_PUBLICATION_CANDIDATE_INVALID'
      );
      assert.equal(
        git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(),
        expectedHead,
        `${kind} recovery pushed a commit with no retained Candidate verification authority`
      );
      assert.ok(await readPendingPublication(root, { ...subject, migrate: false }),
        `${kind} recovery discarded the refused marker`);
    });
  }
});

test('lifecycle verification is offline, clone-free, and uses no checkout worktree', async (t) => {
  const { root } = await repository(t);
  git(root, ['remote', 'add', 'origin', 'https://127.0.0.1:9/must-not-be-contacted.git']);
  const result = await publishFixture(root, { kind: 'story', id: 'CAN-OFFLINE', branch: 'main' });
  const receipt = JSON.parse(await readFile(path.join(
    root, '.git', 'singularity-flow', 'sgos', 'candidates', result.candidate.candidateId,
    'verification', `${result.candidate.verificationReceiptSha256.slice('sha256:'.length)}.json`
  ), 'utf8'));
  assert.deepEqual({
    isolation: receipt.observations.isolation,
    networkUsed: receipt.observations.networkUsed,
    cloneUsed: receipt.observations.cloneUsed,
    worktreeCheckoutUsed: receipt.observations.worktreeCheckoutUsed,
    repositoryHooksExecuted: receipt.observations.repositoryHooksExecuted,
    workingTreeFiltersExecuted: receipt.observations.workingTreeFiltersExecuted,
    candidateCommandsExecuted: receipt.observations.candidateCommandsExecuted
  }, {
    isolation: 'hook-free-object-and-temporary-index',
    networkUsed: false,
    cloneUsed: false,
    worktreeCheckoutUsed: false,
    repositoryHooksExecuted: 0,
    workingTreeFiltersExecuted: 0,
    candidateCommandsExecuted: 0
  });
  assert.equal(git(root, ['worktree', 'list', '--porcelain']).stdout
    .split(/^worktree /m).filter(Boolean).length, 1,
  'lifecycle verifier left a registered temporary worktree behind');
  const source = await readFile(path.join(packageRoot, 'src/sgos/candidate-lifecycle.mjs'), 'utf8');
  const start = source.indexOf('export async function verifySgosLifecycleCandidate');
  const end = source.indexOf('export async function freezeAndVerifySgosLifecycleCandidate', start);
  assert.doesNotMatch(source.slice(start, end), /['"]clone['"]/,
    'lifecycle verifier regressed to repository cloning');
  assert.doesNotMatch(source.slice(start, end), /['"]worktree['"]|['"]checkout['"]/,
    'lifecycle verifier can materialize files and run repository hooks or filters');
});

test('lifecycle verification never executes a malicious post-checkout hook or smudge filter', async (t) => {
  const { root } = await repository(t);
  const hookSentinel = path.join(path.dirname(root), 'post-checkout-executed');
  const filterSentinel = path.join(path.dirname(root), 'smudge-filter-executed');
  const helper = path.join(path.dirname(root), 'malicious-smudge.sh');
  await writeFile(path.join(root, '.gitattributes'), '*.payload filter=sflow-malicious\n');
  git(root, ['add', '.gitattributes']);
  git(root, ['commit', '-m', 'configure malicious checkout fixture']);
  await writeFile(path.join(root, '.git', 'hooks', 'post-checkout'),
    `#!/bin/sh\ntouch ${JSON.stringify(hookSentinel)}\n`);
  await chmod(path.join(root, '.git', 'hooks', 'post-checkout'), 0o755);
  await writeFile(helper, `#!/bin/sh\ntouch ${JSON.stringify(filterSentinel)}\ncat\n`);
  await chmod(helper, 0o755);
  git(root, ['config', 'filter.sflow-malicious.smudge', helper]);

  const subject = { kind: 'story', id: 'CAN-NO-HOOKS', branch: 'main' };
  await new GitPublicationUnitOfWork(root).execute({
    subject,
    allowedPaths: ['payload.payload'],
    event: eventFor(subject),
    commit: { message: '[CAN-NO-HOOKS] hook-free Candidate verification' },
    publication: { mode: 'off', branch: 'main' },
    state: { write: () => writeFile(path.join(root, 'payload.payload'), 'verified bytes\n') }
  });

  await assert.rejects(access(hookSentinel), (error) => error?.code === 'ENOENT');
  await assert.rejects(access(filterSentinel), (error) => error?.code === 'ENOENT');
});

test('a pre-Candidate v2 pending Story commit remains recoverable without invented verification', async (t) => {
  const { root } = await repository(t);
  const subject = { kind: 'story', id: 'LEGACY-PENDING', branch: 'main' };
  const expectedHead = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const relative = 'legacy-state.json';
  await writeFile(path.join(root, relative), '{"legacy":true}\n');
  const event = eventFor(subject, { legacy: true });
  const eventSha256 = `sha256:${recordSha256(event)}`;
  const transactionId = 'legacy-v2-candidate-migration-fixture';
  let stateSha256 = null;
  const commit = await commitIsolated(root, '[LEGACY-PENDING] pre-Candidate transaction', [relative], {
    expectedHead,
    expectedRef: 'refs/heads/main',
    transaction: {
      id: transactionId,
      eventSha256,
      publicationMode: 'required',
      stateSha256ForTree: (tree) => {
        stateSha256 = `sha256:${recordSha256({
          transactionId, expectedHead, branch: 'main', tree, eventSha256,
          publicationMode: 'required', expectedRemoteSha: expectedHead
        })}`;
        return stateSha256;
      }
    }
  });
  const identity = governedCommitIdentity(root, commit);
  assert.equal(identity.candidate, null, 'fixture accidentally acquired post-migration Candidate authority');

  const record = {
    schemaVersion: 2,
    subject,
    branch: 'main',
    remote: 'origin',
    commit,
    transactionId,
    tree: identity.tree,
    eventSha256,
    stateSha256,
    publicationMode: 'required',
    expectedRemoteSha: expectedHead,
    pushOutcome: 'rejected',
    event: bindLifecycleEvent(event, commit),
    createdAt: '2026-08-30T00:00:00.000Z'
  };
  const marker = localPendingPublicationPath(root, subject.kind, subject.id);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, `${JSON.stringify(record, null, 2)}\n`);

  const migrated = await readPendingPublication(root, { ...subject, migrate: true });
  assert.ok(migrated, 'legacy pending marker disappeared during migration');
  assert.equal(migrated.record.candidate ?? null, null,
    'migration must not fabricate a Candidate or passed verification for legacy authority');
  const verification = verifyPendingPublicationCommit(root, migrated.record, {
    subject, branch: 'main', remote: 'origin'
  });
  assert.equal(verification.valid, true,
    `exact legacy commit could not use its bounded compatibility recovery: ${verification.failures.join('; ')}`);
});

test('sealed v2 Story and Initiative receipts authenticate before migration and recover exactly', async (t) => {
  for (const kind of ['story', 'initiative']) {
    await t.test(kind, async (t) => {
      const { root, remote } = await repository(t, { remote: true });
      const subject = { kind, id: `V2-${kind.toUpperCase()}`, branch: 'main' };
      const expectedHead = git(root, ['rev-parse', 'HEAD']).stdout.trim();
      const remoteFingerprint = configuredRemoteFingerprint(root, 'origin');
      const relative = `${kind}-legacy-state.json`;
      await writeFile(path.join(root, relative), `{"kind":${JSON.stringify(kind)}}\n`);
      const event = eventFor(subject, { legacySealedReceipt: true });
      const eventSha256 = `sha256:${recordSha256(event)}`;
      const transactionId = `sealed-v2-${kind}`;
      let stateSha256 = null;
      const commit = await commitIsolated(root, `[${subject.id}] sealed v2 recovery fixture`, [relative], {
        expectedHead,
        expectedRef: 'refs/heads/main',
        transaction: {
          id: transactionId,
          eventSha256,
          publicationMode: 'required',
          stateSha256ForTree: (tree) => {
            stateSha256 = `sha256:${recordSha256({
              transactionId, expectedHead, branch: 'main', tree, eventSha256,
              publicationMode: 'required', remoteFingerprint, expectedRemoteSha: expectedHead
            })}`;
            return stateSha256;
          }
        }
      });
      const identity = governedCommitIdentity(root, commit);
      assert.equal(identity.candidate, null);
      const marker = {
        schemaVersion: 2,
        subject,
        branch: 'main',
        remote: 'origin',
        remoteFingerprint,
        commit,
        transactionId,
        tree: identity.tree,
        eventSha256,
        stateSha256,
        publicationMode: 'required',
        expectedRemoteSha: expectedHead,
        pushOutcome: 'rejected',
        event: bindLifecycleEvent(event, commit),
        createdAt: '2026-08-30T00:00:00.000Z'
      };

      // Let the engine create the machine-local key and canonical target, then reproduce the exact
      // representation written by the prior v2 release and seal that historical shape.
      await writePendingPublication(root, { ...subject, record: marker });
      const key = Buffer.from((await readFile(path.join(
        root, '.git', 'singularity-flow', 'pending-publication-integrity.key'
      ), 'utf8')).trim(), 'base64');
      const payload = `sha256:${recordSha256(marker)}`;
      const sealedV2 = {
        ...marker,
        recoveryIntegrity: {
          scheme: 'machine-local-hmac-sha256-v1',
          keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
          mac: `sha256:${createHmac('sha256', key).update(payload).digest('hex')}`
        }
      };
      const markerPath = localPendingPublicationPath(root, subject.kind, subject.id);
      await writeFile(markerPath, `${JSON.stringify(sealedV2, null, 2)}\n`);

      const upgraded = await readPendingPublication(root, { ...subject, migrate: true });
      assert.equal(upgraded.integrityVerified, true,
        'v2 integrity was checked against a migrated payload instead of stored bytes');
      assert.equal(upgraded.schemaMigrated, true);
      assert.equal(upgraded.record.schemaVersion, 3);
      assert.equal(upgraded.record.candidate, null,
        'migration fabricated Candidate verification for a pre-Candidate receipt');
      const installed = JSON.parse(await readFile(markerPath, 'utf8'));
      assert.equal(installed.schemaVersion, 3);
      assert.equal(await verifyPendingPublicationIntegrity(root, installed), true,
        'the atomic v3 replacement was not resealed');

      const synced = kind === 'story'
        ? await syncPublication(root, { git: { remote: 'origin' }, ledger: { enabled: false } }, {
            workItem: { id: subject.id, branch: subject.branch },
            lineage: { canonicalBranch: subject.branch, childBranches: [] },
            resolution: { ledger: { enabled: false } }
          })
        : await syncInitiativePublication(root, { git: { remote: 'origin' } }, {
            initiative: { id: subject.id, branch: subject.branch },
            resolution: { ledger: { enabled: false } }
          });
      assert.equal(synced.pushed, commit);
      assert.equal(git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(), commit);
    });
  }
});

test('secret refusal happens before any Candidate commit or retention ref is created', async (t) => {
  const { root } = await repository(t);
  const subject = { kind: 'story', id: 'CAN-SECRET', branch: 'main' };
  const secret = `ghp_${'A'.repeat(36)}`;

  await assert.rejects(
    publishFixture(root, subject, { contents: `{"token":"${secret}"}\n` }),
    (error) => error?.code === 'SECRET_DETECTED'
  );
  assert.equal(
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/singularity-flow/candidates']).stdout.trim(),
    '',
    'a refused secret was retained as a durable Candidate Git object'
  );
  await assert.rejects(
    access(path.join(root, '.git', 'singularity-flow', 'publication-rescues')),
    (error) => error?.code === 'ENOENT',
    'rejected secret bytes were retained in a publication rescue'
  );
});

test('governed regular binary evidence follows the installed skip policy without weakening Candidate binding', async (t) => {
  const { root } = await repository(t);
  const subject = { kind: 'story', id: 'CAN-BINARY-EVIDENCE', branch: 'main' };
  const result = await new GitPublicationUnitOfWork(root).execute({
    subject,
    allowedPaths: ['governed-evidence'],
    event: eventFor(subject),
    commit: { message: '[CAN-BINARY-EVIDENCE] admit governed evidence' },
    publication: { mode: 'off', branch: 'main' },
    state: {
      write: async () => {
        await mkdir(path.join(root, 'governed-evidence'), { recursive: true });
        await writeFile(path.join(root, 'governed-evidence', 'screen.png'),
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80]));
        await writeFile(path.join(root, 'governed-evidence', 'spec.pdf'),
          Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80]));
      }
    }
  });

  assert.match(result.candidate?.candidateSha256 ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(git(root, ['show', `${result.sha}:governed-evidence/screen.png`], {
    allowFailure: true
  }).status, 0);
  assert.equal(git(root, ['show', `${result.sha}:governed-evidence/spec.pdf`], {
    allowFailure: true
  }).status, 0);
});

test('a nested untracked credential is scanned from the exact prospective index before retention', async (t) => {
  const { root } = await repository(t);
  const subject = { kind: 'story', id: 'CAN-NESTED-SECRET', branch: 'main' };
  const secret = `ghp_${'B'.repeat(36)}`;

  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject,
      allowedPaths: ['governed'],
      event: eventFor(subject),
      commit: { message: '[CAN-NESTED-SECRET] must refuse' },
      publication: { mode: 'off', branch: 'main' },
      state: {
        write: async () => {
          await mkdir(path.join(root, 'governed', 'nested'), { recursive: true });
          await writeFile(path.join(root, 'governed', 'nested', 'credential.txt'), `${secret}\n`);
        }
      }
    }),
    (error) => error?.code === 'SECRET_DETECTED'
  );
  assert.equal(
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/singularity-flow/candidates']).stdout.trim(),
    ''
  );
  const sidecars = path.join(root, '.git', 'singularity-flow', 'sgos', 'candidates');
  await assert.rejects(readdir(sidecars), (error) => error?.code === 'ENOENT');
});

test('a credential in a file-to-symlink type change is refused before Candidate retention', {
  skip: process.platform === 'win32' ? 'ordinary symlink creation is not portable without Windows developer mode' : false
}, async (t) => {
  const { root } = await repository(t);
  // A binary-looking extension may exempt a regular evidence blob, never a symlink target.
  const relative = 'governed-link.png';
  await writeFile(path.join(root, relative), 'ordinary tracked file\n');
  await chmod(path.join(root, relative), 0o751);
  const originalMode = (await lstat(path.join(root, relative))).mode & 0o777;
  git(root, ['add', relative]);
  git(root, ['commit', '-m', 'tracked file before type change']);
  const subject = { kind: 'story', id: 'CAN-TYPE-SECRET', branch: 'main' };
  const secret = `ghp_${'C'.repeat(36)}`;

  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject,
      allowedPaths: [relative],
      event: eventFor(subject),
      commit: { message: '[CAN-TYPE-SECRET] must refuse' },
      publication: { mode: 'off', branch: 'main' },
      state: {
        write: async () => {
          await unlink(path.join(root, relative));
          await symlink(secret, path.join(root, relative));
        }
      }
    }),
    (error) => error?.code === 'SECRET_DETECTED'
  );
  assert.equal(
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/singularity-flow/candidates']).stdout.trim(),
    ''
  );
  const restored = await lstat(path.join(root, relative));
  assert.equal(restored.isFile(), true, 'the rejected final symlink was not replaced by the regular preimage');
  assert.equal(restored.isSymbolicLink(), false);
  assert.equal(restored.mode & 0o777, originalMode, 'the regular-file mode was not restored exactly');
  assert.equal(await readFile(path.join(root, relative), 'utf8'), 'ordinary tracked file\n');
  await assert.rejects(
    access(path.join(root, '.git', 'singularity-flow', 'publication-rescues')),
    (error) => error?.code === 'ENOENT'
  );
});

test('a nested symlink secret is rejected and rollback neither follows nor retains its target', {
  skip: process.platform === 'win32' ? 'ordinary symlink creation is not portable without Windows developer mode' : false
}, async (t) => {
  const { root } = await repository(t);
  const governed = path.join(root, 'governed');
  const relative = path.join('governed', 'nested', 'state.txt');
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), 'trusted nested bytes\n');
  await chmod(path.join(root, relative), 0o741);
  const originalMode = (await lstat(path.join(root, relative))).mode & 0o777;
  git(root, ['add', 'governed']);
  git(root, ['commit', '-m', 'nested state before unsafe link']);

  const secret = `ghp_${'D'.repeat(36)}`;
  const outside = path.join(root, `outside-${secret}`);
  await writeFile(outside, 'outside target must survive exact-root rollback\n');
  const subject = { kind: 'story', id: 'CAN-NESTED-LINK', branch: 'main' };
  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject,
      allowedPaths: ['governed'],
      event: eventFor(subject),
      commit: { message: '[CAN-NESTED-LINK] must refuse' },
      publication: { mode: 'off', branch: 'main' },
      state: {
        write: async () => {
          await unlink(path.join(root, relative));
          await symlink(`../../${path.basename(outside)}`, path.join(root, relative));
        }
      }
    }),
    (error) => error?.code === 'SECRET_DETECTED'
  );

  const restored = await lstat(path.join(root, relative));
  assert.equal(restored.isFile(), true);
  assert.equal(restored.isSymbolicLink(), false);
  assert.equal(restored.mode & 0o777, originalMode);
  assert.equal(await readFile(path.join(root, relative), 'utf8'), 'trusted nested bytes\n');
  assert.equal(await readFile(outside, 'utf8'), 'outside target must survive exact-root rollback\n');
  await assert.rejects(
    access(path.join(root, '.git', 'singularity-flow', 'publication-rescues')),
    (error) => error?.code === 'ENOENT'
  );
  assert.equal((await readdir(governed)).includes('nested'), true);
});

test('renamed credential bytes are scanned and both path preimages are restored', async (t) => {
  const { root } = await repository(t);
  const source = 'governed-before.txt';
  const destination = 'governed-after.txt';
  await writeFile(path.join(root, source), 'trusted rename source\n');
  git(root, ['add', source]);
  git(root, ['commit', '-m', 'rename source baseline']);
  const subject = { kind: 'story', id: 'CAN-RENAME-SECRET', branch: 'main' };
  const secret = `ghp_${'E'.repeat(36)}`;

  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject,
      allowedPaths: [source, destination],
      event: eventFor(subject),
      commit: { message: '[CAN-RENAME-SECRET] must refuse' },
      publication: { mode: 'off', branch: 'main' },
      state: {
        write: async () => {
          await rename(path.join(root, source), path.join(root, destination));
          await writeFile(path.join(root, destination), `${secret}\n`);
        }
      }
    }),
    (error) => error?.code === 'SECRET_DETECTED'
  );

  assert.equal(await readFile(path.join(root, source), 'utf8'), 'trusted rename source\n');
  await assert.rejects(access(path.join(root, destination)), (error) => error?.code === 'ENOENT');
  assert.equal(
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/singularity-flow/candidates']).stdout.trim(),
    ''
  );
  await assert.rejects(
    access(path.join(root, '.git', 'singularity-flow', 'publication-rescues')),
    (error) => error?.code === 'ENOENT'
  );
});

test('Candidate identity binds the exact lifecycle event digest, not only its reusable event ID', () => {
  const subject = { kind: 'story', id: 'CAN-EVENT', branch: 'main' };
  const original = eventFor(subject, { decision: 'first' });
  const changed = { ...original, payload: { decision: 'changed-after-review' } };

  assert.equal(sgosLifecycleCandidateId(original), sgosLifecycleCandidateId(structuredClone(original)),
    'the same exact event must retain a stable Candidate identity');
  assert.notEqual(sgosLifecycleCandidateId(original), sgosLifecycleCandidateId(changed),
    'a changed event payload reused the Candidate authorized for different lifecycle bytes');
});

test('an existing-commit Candidate is independent of the developer checkout', async (t) => {
  const { root } = await repository(t);
  const selectedBase = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  await writeFile(path.join(root, 'later.txt'), 'unrelated checkout advance\n');
  git(root, ['add', 'later.txt']);
  git(root, ['commit', '-m', 'advance current checkout']);
  assert.notEqual(git(root, ['rev-parse', 'HEAD']).stdout.trim(), selectedBase);
  const event = eventFor({
    kind: 'story', id: 'CAN-EXISTING-BASE', branch: 'CAN-EXISTING-BASE'
  }, { selectedBase });

  const boundary = await freezeAndVerifySgosExistingLifecycleCommit(root, {
    event,
    candidateCommit: selectedBase,
    createdBy: { kind: 'system', id: 'singularity-flow-kernel' }
  });
  assert.equal(boundary.retained.repository.candidateCommit, selectedBase);
  assert.equal(boundary.verification.status, 'passed');
});

test('Candidate binding rejects non-digest receipt paths before private-sidecar lookup', async (t) => {
  const { root } = await repository(t);
  const result = await publishFixture(root, {
    kind: 'story', id: 'CAN-BINDING-PATH', branch: 'main'
  });
  await assert.rejects(
    verifySgosLifecycleCandidateBinding(root, {
      ...result.candidate,
      verificationReceiptSha256: '../../../../config'
    }, { publishedCommit: result.sha }),
    (error) => error?.code === 'SGOS_CANDIDATE_BINDING_INVALID'
  );
});

test('the lifecycle verifier refuses a Candidate without exact lifecycle admission evidence', async (t) => {
  const { root } = await repository(t);
  const subject = { kind: 'story', id: 'CAN-NO-ADMISSION', branch: 'main' };
  const event = eventFor(subject);
  await writeFile(path.join(root, 'candidate-without-admission.json'), '{"candidate":true}\n');

  await assert.rejects(
    freezeAndVerifySgosLifecycleCandidate(root, {
      event,
      paths: ['candidate-without-admission.json'],
      createdBy: { kind: 'human', id: 'candidate-boundary@example.com' },
      expectedBaseline: git(root, ['rev-parse', 'HEAD']).stdout.trim()
    }),
    (error) => /ADMISSION/.test(String(error?.code ?? ''))
  );
});

test('standalone Candidate publication cannot bypass an active Story lifecycle', async (t) => {
  const { root } = await repository(t, { remote: true });
  flow(root, ['init']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initialize workflow']);
  git(root, ['push', 'origin', 'main']);
  flow(root, ['start', 'CAN-BYPASS', '--from-branch', 'main']);
  await publishSgosCandidateVerifierPolicy(root);
  git(root, ['push', 'origin', 'refs/heads/sflow/config:refs/heads/sflow/config']);
  git(root, ['fetch', 'origin', 'sflow/config']);
  await writeFile(path.join(root, 'README.md'), '# generic Candidate must not bypass Story authority\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'generic-repository-tree',
    createdBy: { kind: 'human', id: 'candidate-boundary@example.com' },
    createdAt: '2026-08-30T00:00:00.000Z'
  });
  await verifySgosCandidate(root, retained.candidate.candidateId, {
    verifiedAt: '2026-08-30T00:01:00.000Z'
  });

  await assert.rejects(
    planSgosCandidatePublication(root, retained.candidate.candidateId, {
      targetBranch: 'CAN-BYPASS', remote: null
    }),
    (error) => /LIFECYCLE.*ADMISSION|ADMISSION.*LIFECYCLE/.test(String(error?.code ?? ''))
  );
});

test('an ad hoc push failure remains discoverable through a supported exact sync surface', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const subject = { kind: 'adhoc', id: 'AHS-PENDING', branch: 'main' };
  const expectedRemoteSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  await assert.rejects(
    publishFixture(root, subject, {
      publication: { mode: 'required', branch: 'main', remote: 'origin', expectedRemoteSha }
    }),
    /push failed/i
  );

  const inspection = await inspectPendingPublication(root, subject);
  assert.equal(inspection.status, 'pending', inspection.error);
  assert.equal(inspection.record.commit, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  const commandSource = await readFile(path.join(packageRoot, 'src', 'commands', 'adhoc.mjs'), 'utf8');
  assert.match(commandSource, /subcommand\s*===\s*['"]sync['"]/,
    "ad hoc recovery has no 'singularity-flow adhoc sync <SESSION-ID>' command");
  const operation = resolveOperation({
    requestedCommand: 'adhoc', positionals: ['adhoc', 'sync', subject.id]
  });
  assert.equal(operation.id, 'adhoc.sync',
    'the central command registry blocks the ad hoc recovery handler');
  assert.equal(operation.modelPolicy, 'never');
});

test('a local-only ad hoc commit retains its exact tail marker until finalization succeeds', async (t) => {
  const { root } = await repository(t);
  const subject = { kind: 'adhoc', id: 'AHS-LOCAL-TAIL', branch: 'main' };
  const relative = 'adhoc-local-tail.json';
  await assert.rejects(
    new GitPublicationUnitOfWork(root).execute({
      subject,
      allowedPaths: [relative],
      event: eventFor(subject, { localOnlyTail: true }),
      commit: { message: '[AHS-LOCAL-TAIL] local-only tail fixture' },
      publication: { mode: 'off', branch: 'main' },
      retainPendingOnSuccess: true,
      state: {
        write: () => writeFile(path.join(root, relative), '{"localOnly":true}\n')
      },
      fault: async (point) => {
        if (point === 'after-commit') throw new Error('simulated operational-tail interruption');
      }
    }),
    /operational-tail interruption/
  );

  const retained = await readPendingPublication(root, { ...subject, migrate: false });
  assert.equal(retained?.integrityVerified, true);
  assert.equal(retained?.record?.publicationMode, 'off');
  assert.equal(retained?.record?.localCommitted, true);
  assert.equal(retained?.record?.commit, git(root, ['rev-parse', 'HEAD']).stdout.trim());

  let finalizations = 0;
  let finalizationMode = null;
  await assert.rejects(
    syncPendingLifecyclePublication(root, {
      ...subject,
      finalize: async ({ localOnly }) => {
        finalizations += 1;
        finalizationMode = localOnly;
        throw new Error('simulated receipt write failure');
      }
    }),
    /receipt write failure/
  );
  assert.equal(finalizations, 1);
  assert.ok(await readPendingPublication(root, { ...subject, migrate: false }),
    'a failed local tail finalizer cleared its only exact retry receipt');

  const recovered = await syncPendingLifecyclePublication(root, {
    ...subject,
    finalize: async ({ localOnly }) => {
      finalizations += 1;
      finalizationMode = localOnly;
    }
  });
  assert.equal(recovered.localOnly, true);
  assert.equal(recovered.pushed, null);
  assert.equal(recovered.commit, retained.record.commit);
  assert.equal(finalizations, 2);
  assert.equal(finalizationMode, true,
    'a local-only operational tail was presented to its finalizer as remotely published');
  assert.equal(await readPendingPublication(root, { ...subject, migrate: false }), null);
});

test('ad hoc and Goal cleanup never delete a same-ID legacy Story marker', async (t) => {
  const { root } = await repository(t);
  for (const kind of ['adhoc', 'goal']) {
    const id = kind === 'adhoc' ? 'AHS-COLLISION' : 'GEX-COLLISION';
    const legacy = path.join(root, 'singularity', 'work-items', id, 'publication-pending.json');
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, `${JSON.stringify({ schemaVersion: 2, subject: { kind: 'story', id } })}\n`);
    await clearPendingPublication(root, { kind, id });
    assert.equal(await readFile(legacy, 'utf8').then(() => true, () => false), true,
      `${kind} cleanup removed an unrelated tracked Story recovery record`);
  }
});

test('ad hoc recovery refuses edited local tail metadata before any exact retry', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  const subject = { kind: 'adhoc', id: 'AHS-METADATA-TAMPER', branch: 'main' };
  const expectedRemoteSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  await assert.rejects(
    publishFixture(root, subject, {
      publication: { mode: 'required', branch: 'main', remote: 'origin', expectedRemoteSha }
    }),
    /push failed/i
  );
  const markerPath = localPendingPublicationPath(root, subject.kind, subject.id);
  const edited = JSON.parse(await readFile(markerPath, 'utf8'));
  edited.adhoc = {
    sessionId: subject.id,
    workId: 'ADH-20260901-edited-000000',
    packetSha256: `sha256:${'0'.repeat(64)}`
  };
  await writeFile(markerPath, `${JSON.stringify(edited, null, 2)}\n`);

  await assert.rejects(
    syncPendingLifecyclePublication(root, subject),
    (error) => error?.code === 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID'
  );
  assert.equal(git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(),
    expectedRemoteSha);
});

test('Story and Initiative sync gate the exact pending commit before recovery push', async () => {
  for (const fixture of [
    { file: 'src/state.mjs', start: 'export async function syncPublication', record: 'record' },
    {
      file: 'src/initiative-state.mjs', start: 'export async function syncInitiativePublication',
      record: 'currentRecord'
    }
  ]) {
    const source = await readFile(path.join(packageRoot, fixture.file), 'utf8');
    const start = source.indexOf(fixture.start);
    assert.notEqual(start, -1, `${fixture.file} lost its exact recovery entry point`);
    const tail = source.slice(start);
    const nextExport = tail.slice(fixture.start.length).search(/\nexport (?:async )?function /);
    const body = nextExport < 0 ? tail : tail.slice(0, fixture.start.length + nextExport);
    const verification = body.indexOf('verifyPendingPublicationCommit(');
    const refusal = body.indexOf('if (!verification.valid)', verification);
    const push = body.indexOf('pushCommitToBranch(', refusal);
    assert.ok(verification >= 0 && refusal > verification && push > refusal,
      `${fixture.file} can reach recovery push before exact pending-commit verification`);
    const pushCall = body.slice(push, body.indexOf(');', push) + 2);
    assert.match(pushCall, new RegExp(`${fixture.record}\\.commit`),
      `${fixture.file} recovery push does not name the exact verified marker commit`);
  }
});

test('no lifecycle module retains a direct commit, ref-advance, or push authority outside Candidate publication', async () => {
  // Configuration, world-model, ledger, and Candidate-retention refs are separate authorities and
  // deliberately not listed. These are the known lifecycle bypasses SGOS-P0-001 must remove or
  // route through one Candidate/ Candidate-set publication adapter.
  const forbidden = [
    ['src/initiative-repositories.mjs', /run\('git', \['commit'/g, 'materialized Story direct commit'],
    ['src/initiative-repositories.mjs', /runRemoteGit\(\['push'/g, 'materialized Story direct push'],
    ['src/local-identity.mjs', /\bcommit\(root,/g, 'Epic reservation direct commit'],
    ['src/local-identity.mjs', /\bpushBranch\(root,/g, 'Epic reservation direct push'],
    ['src/governed-goals.mjs', /git\([^\n]+, \['commit'/g, 'Goal direct commit'],
    ['src/governed-goals.mjs', /git\([^\n]+, \['update-ref'/g, 'Goal direct ref advance'],
    ['src/governed-goals.mjs', /git\([^\n]+, \['push'(?!, '--dry-run')/g, 'Goal direct push']
  ];
  const violations = [];
  for (const [relative, pattern, label] of forbidden) {
    const source = await readFile(path.join(packageRoot, relative), 'utf8');
    const matches = [...source.matchAll(pattern)];
    if (matches.length) violations.push(`${relative}: ${label} (${matches.length})`);
  }
  assert.deepEqual(violations, [],
    `parallel lifecycle publication authority remains outside Candidate boundary:\n${violations.join('\n')}`);
});

test('world-model transport recovery cannot overwrite lifecycle pending-publication authority', async () => {
  const source = await readFile(path.join(packageRoot, 'src', 'worldmodel.mjs'), 'utf8');
  assert.doesNotMatch(source, /writeJson\(pendingPublicationPath\(/,
    'world-model failure still writes an incompatible raw Story pending marker');
  assert.doesNotMatch(source, /recoveryCommand:\s*['"]singularity-flow sync['"]/,
    'world-model failure still routes a non-lifecycle commit through Story sync');
  assert.match(source, /singularity-flow wm recovery publish/,
    'world-model failure has no dedicated exact recovery surface');
});

test('capability sibling transport verifies the exact Candidate before its push', async () => {
  const capabilitySource = await readFile(
    path.join(packageRoot, 'src/capability-start.mjs'), 'utf8'
  );
  const capabilityStart = capabilitySource.indexOf(
    'export async function publishCapabilityRepositories'
  );
  const capabilityBody = capabilitySource.slice(
    capabilityStart, capabilitySource.indexOf('\n/**', capabilityStart)
  );
  assert.match(capabilityBody, /publishVerifiedSgosLifecycleCandidate\(/,
    'capability sibling publication bypasses the shared verified-Candidate transport');
  assert.doesNotMatch(capabilityBody, /pushCommitToBranch\(/,
    'capability sibling publication retains a direct push path beside the Candidate adapter');

  const candidateSource = await readFile(
    path.join(packageRoot, 'src/sgos/candidate-lifecycle.mjs'), 'utf8'
  );
  const adapterStart = candidateSource.indexOf(
    'export async function publishVerifiedSgosLifecycleCandidate'
  );
  const adapterBody = candidateSource.slice(
    adapterStart, candidateSource.indexOf('\nexport async function readSgosRetainedCandidate', adapterStart)
  );
  const verify = adapterBody.indexOf('verifySgosLifecycleCandidateBinding(');
  const push = adapterBody.indexOf('pushCommitToBranch(');
  assert.ok(verify >= 0 && push > verify,
    'the shared Candidate adapter can push before exact Candidate verification');
});

function promotionWorkflow(id) {
  return {
    workItem: { id, branch: 'main' },
    lineage: {
      canonicalBranch: 'main',
      childBranches: [{ name: 'CHILD' }],
      branchCompletionPolicy: 'direct'
    }
  };
}

async function finalizedChildCandidate(root, id) {
  git(root, ['switch', '-c', 'CHILD']);
  const subject = { kind: 'story', id, branch: 'CHILD' };
  const event = lifecycleEvent({
    type: 'work-completed',
    subject,
    phaseId: 'release',
    generation: 1,
    actor: {
      kind: 'human', id: 'candidate-boundary@example.com',
      name: 'Candidate Boundary', email: 'candidate-boundary@example.com'
    },
    payload: { workCompleted: true }
  });
  return publishFixture(root, subject, {
    event,
    publication: { mode: 'off', branch: 'CHILD' }
  });
}

test('direct Story promotion refuses a manual non-Candidate HEAD before remote publication', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const originalMain = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  git(root, ['switch', '-c', 'CHILD']);
  await writeFile(path.join(root, 'manual.txt'), 'not governed\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'manual non-Candidate commit']);

  await assert.rejects(
    promoteStoryBranch(root, { git: { remote: 'origin' } }, promotionWorkflow('PROMOTE-REFUSE'), {
      mode: 'direct'
    }),
    (error) => /CANDIDATE/.test(String(error?.code ?? ''))
  );
  assert.equal(
    git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(),
    originalMain
  );
});

test('direct Story promotion publishes only the exact finalized Candidate commit', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const finalized = await finalizedChildCandidate(root, 'PROMOTE-CANDIDATE');
  const promoted = await promoteStoryBranch(
    root, { git: { remote: 'origin' } }, promotionWorkflow('PROMOTE-CANDIDATE'), { mode: 'direct' }
  );
  assert.equal(promoted.commit, finalized.sha);
  assert.equal(
    git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(),
    finalized.sha
  );
});

test('failed direct Story promotion retains exact Candidate recovery and retries only that SHA', async (t) => {
  const { root, remote } = await repository(t, { remote: true });
  const finalized = await finalizedChildCandidate(root, 'PROMOTE-RECOVERY');
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);

  await assert.rejects(
    promoteStoryBranch(
      root, { git: { remote: 'origin' } }, promotionWorkflow('PROMOTE-RECOVERY'), { mode: 'direct' }
    ),
    (error) => error?.code === 'STORY_PROMOTION_PUSH_FAILED'
  );
  const pending = await readPendingPublication(root, {
    kind: 'story', id: 'PROMOTE-RECOVERY', migrate: false
  });
  assert.equal(pending?.record?.recoveryKind, 'story-branch-promotion');
  assert.equal(pending?.record?.commit, finalized.sha);
  assert.equal(pending?.integrityVerified, true);

  await rm(hook, { force: true });
  const recovered = await syncPublication(
    root,
    { git: { remote: 'origin' }, ledger: { enabled: false } },
    { ...promotionWorkflow('PROMOTE-RECOVERY'), resolution: { ledger: { enabled: false } } }
  );
  assert.equal(recovered.commit, finalized.sha);
  assert.equal(
    git(root, ['--git-dir', remote, 'rev-parse', 'refs/heads/main']).stdout.trim(),
    finalized.sha
  );
  assert.equal(await readPendingPublication(root, {
    kind: 'story', id: 'PROMOTE-RECOVERY', migrate: false
  }), null);
});
