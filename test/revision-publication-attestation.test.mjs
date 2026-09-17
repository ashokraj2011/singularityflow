import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordSha256 } from '../src/records.mjs';
import { withSubjectLock } from '../src/subject-lock.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { readPendingPublication } from '../src/publication-pending.mjs';
import { syncPublication } from '../src/state.mjs';
import {
  bindRevisionPublicationCommit,
  prepareRevisionPublicationAttestation,
  readRevisionPublicationAttestation,
  revisionPublicationAttestationPaths
} from '../src/revision/publication-attestation.mjs';

const digest = (value) => `sha256:${recordSha256(value)}`;
const subject = { kind: 'story', id: 'WRK-REV' };
const transactionId = 'txn-rev-test';
const h = (character) => `sha256:${character.repeat(64)}`;

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-attest-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'app.txt'), 'baseline\n');
    git(root, 'add', 'app.txt');
    git(root, 'commit', '-q', '-m', 'base');
    const parent = git(root, 'rev-parse', 'HEAD');
    await writeFile(path.join(root, 'app.txt'), 'candidate\n');
    git(root, 'add', 'app.txt');
    const tree = git(root, 'write-tree');
    return await fn({ root, parent, tree, branch: git(root, 'branch', '--show-current') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function selection(tree) {
  const core = {
    schemaVersion: 1, kind: 'revision-publication-selection',
    workId: subject.id, phaseId: 'implementation', phaseGeneration: 1,
    loopId: 'loop-1', loopRevision: 2, journalEntrySha256: h('a'),
    candidateId: 'CAN-revision-1', candidateSha256: h('b'),
    candidateRefSha256: h('c'), candidateTree: tree,
    headTransitionSha256: h('d'), headSnapshotSha256: h('e'),
    precheckSha256: h('f'), contextSha256: h('1'),
    applicationProjectionSha256: h('2'), prospectiveTree: tree
  };
  return { ...core, selectionSha256: digest(core) };
}

function lifecycleCandidate(tree) {
  return {
    candidateId: 'CAN-lifecycle-1', candidateSha256: h('3'),
    verificationReceiptSha256: h('4'), verificationProfileSha256: h('5'),
    candidateTree: tree
  };
}

function makeCommit(root, { parent, tree, candidate, eventSha256 = h('6'),
  stateSha256 = h('7'), mode = 'required', transaction = transactionId,
  revisionSelectionSha256 = selection(tree).selectionSha256 }) {
  const message = `Story publication\n\nSingularity-Flow-Transaction: ${transaction}`
    + `\nSingularity-Flow-Event-SHA256: ${eventSha256}`
    + `\nSingularity-Flow-State-SHA256: ${stateSha256}`
    + `\nSingularity-Flow-Publication-Mode: ${mode}`
    + (revisionSelectionSha256
      ? `\nSingularity-Flow-REV-Selection-SHA256: ${revisionSelectionSha256}` : '')
    + `\nSingularity-Flow-Candidate-ID: ${candidate.candidateId}`
    + `\nSingularity-Flow-Candidate-SHA256: ${candidate.candidateSha256}`
    + `\nSingularity-Flow-Candidate-Verification-SHA256: ${candidate.verificationReceiptSha256}`
    + `\nSingularity-Flow-Candidate-Profile-SHA256: ${candidate.verificationProfileSha256}`;
  const commit = git(root, 'commit-tree', tree, '-p', parent, '-m', message);
  git(root, 'update-ref', 'HEAD', commit, parent);
  return commit;
}

test('selected REV head and precheck bind to exact retained Story commit without a remote claim', async () => {
  await fixture(async ({ root, parent, tree, branch }) => {
    const selected = selection(tree);
    const candidate = lifecycleCandidate(tree);
    const paths = revisionPublicationAttestationPaths(root, { subject, transactionId });
    assert.equal((await readRevisionPublicationAttestation(root, { subject, transactionId })).status, 'absent');
    await withSubjectLock(root, subject, async () => {
      await prepareRevisionPublicationAttestation(root, {
        subject, selection: selected, transactionId, expectedHead: parent,
        branch, publicationMode: 'required'
      });
      assert.equal((await readRevisionPublicationAttestation(root, { subject, transactionId })).status,
        'prepared');
      const commit = makeCommit(root, { parent, tree, candidate });
      const receipt = await bindRevisionPublicationCommit(root, {
        subject, transactionId, commit, eventSha256: h('6'), stateSha256: h('7'),
        candidateBinding: candidate
      });
      assert.equal(receipt.commit, commit);
      assert.equal(receipt.outcome, 'commit-retained-local');
      assert.equal(receipt.precheckSha256, selected.precheckSha256);
      assert.equal(receipt.selectedHeadSnapshotSha256, selected.headSnapshotSha256);
      assert.equal(receipt.selectionSha256, selected.selectionSha256);
      assert.equal(receipt.tree, tree);
      assert.equal((await readRevisionPublicationAttestation(root, { subject, transactionId })).status,
        'commit-retained-local');
      assert.deepEqual(await bindRevisionPublicationCommit(root, {
        subject, transactionId, commit, eventSha256: h('6'), stateSha256: h('7'),
        candidateBinding: candidate
      }), receipt);
    });
    assert.match(await readFile(paths.prepared, 'utf8'), /revision-publication-prepared/);
    assert.match(await readFile(paths.committed, 'utf8'), /commit-retained-local/);
    assert.doesNotMatch(await readFile(paths.committed, 'utf8'), /remote-published/);
  });
});

test('mismatched transaction, event, tree, or lifecycle Candidate never creates commit claim', async () => {
  for (const mismatch of ['transaction', 'event', 'candidate', 'tree', 'missing-selection', 'other-selection']) {
    await fixture(async ({ root, parent, tree, branch }) => {
      const candidate = lifecycleCandidate(tree);
      await withSubjectLock(root, subject, async () => {
        await prepareRevisionPublicationAttestation(root, {
          subject, selection: selection(tree), transactionId, expectedHead: parent,
          branch, publicationMode: 'required'
        });
        let commitTree = tree;
        if (mismatch === 'tree') {
          await writeFile(path.join(root, 'extra.txt'), 'extra\n');
          git(root, 'add', 'extra.txt');
          commitTree = git(root, 'write-tree');
        }
        const commit = makeCommit(root, {
          parent, tree: commitTree, candidate,
          transaction: mismatch === 'transaction' ? 'another-txn' : transactionId,
          eventSha256: mismatch === 'event' ? h('8') : h('6'),
          revisionSelectionSha256: mismatch === 'missing-selection' ? null
            : mismatch === 'other-selection' ? h('9')
              : selection(tree).selectionSha256
        });
        await assert.rejects(() => bindRevisionPublicationCommit(root, {
          subject, transactionId, commit,
          eventSha256: h('6'), stateSha256: h('7'),
          candidateBinding: mismatch === 'candidate'
            ? { ...candidate, candidateSha256: h('9') } : candidate
        }), { code: 'REV_ATTESTATION_COMMIT_MISMATCH' });
        assert.equal((await readRevisionPublicationAttestation(root, { subject, transactionId })).status,
          'prepared');
      });
    });
  }
});

test('attestation writes require the subject lock and reject corrupt selections', async () => {
  await fixture(async ({ root, parent, tree, branch }) => {
    const options = {
      subject, selection: selection(tree), transactionId, expectedHead: parent,
      branch, publicationMode: 'required'
    };
    await assert.rejects(() => prepareRevisionPublicationAttestation(root, options),
      { code: 'REV_ATTESTATION_LOCK_REQUIRED' });
    await withSubjectLock(root, subject, async () => {
      await assert.rejects(() => prepareRevisionPublicationAttestation(root, {
        ...options, selection: { ...options.selection, precheckSha256: h('9') }
      }), { code: 'REV_ATTESTATION_SELECTION_INVALID' });
      await prepareRevisionPublicationAttestation(root, options);
      await assert.rejects(() => prepareRevisionPublicationAttestation(root, {
        ...options, selection: selection(tree), expectedHead: '0'.repeat(40)
      }), { code: 'REV_ATTESTATION_CONFLICT' });
    });
  });
});

async function publicationFixture(fn) {
  return fixture(async ({ root, parent, branch }) => {
    // The generic fixture leaves a staged candidate; the governed publisher admits its own
    // isolated index and must begin from an unrelated, clean user index.
    git(root, 'reset', '-q', 'HEAD', '--', 'app.txt');
    await writeFile(path.join(root, 'app.txt'), 'baseline\n');
    const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-attest-remote-'));
    try {
      git(remote, 'init', '--bare', '-q');
      git(root, 'remote', 'add', 'origin', remote);
      git(root, 'push', '-q', 'origin', `HEAD:${branch}`);
      const story = { ...subject, branch };
      const calls = [];
      const specification = {
        subject: story,
        allowedPaths: ['app.txt'],
        event: lifecycleEvent({
          type: 'artifact-generated', subject: story, phaseId: 'implementation', generation: 1
        }),
        commit: { message: '[WRK-REV] publication attestation fault test' },
        publication: {
          mode: 'required', branch, remote: 'origin', expectedRemoteSha: parent
        },
        state: { write: () => writeFile(path.join(root, 'app.txt'), 'transaction\n') },
        revisionAttestation: {
          beforeStateWrite: ({ expectedHead }) => {
            assert.equal(expectedHead, parent);
            calls.push('preflight');
            return { parent };
          },
          select: ({ preflight, prospectiveTree }) => {
            assert.deepEqual(preflight, { parent });
            calls.push('selection');
            return selection(prospectiveTree);
          }
        }
      };
      return await fn({ root, remote, parent, branch, story, calls, specification });
    } finally { await rm(remote, { recursive: true, force: true }); }
  });
}

test('a pre-ref failure leaves only prepared selection and restores the Story parent', async () => {
  await publicationFixture(async ({ root, parent, calls, specification }) => {
    await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
      ...specification,
      fault: (stage) => { if (stage === 'before-staging') throw new Error('pre-ref fault'); }
    }), /pre-ref fault/);
    assert.deepEqual(calls, ['preflight', 'selection']);
    assert.equal(git(root, 'rev-parse', 'HEAD'), parent);
    const directory = path.dirname(revisionPublicationAttestationPaths(root, {
      subject, transactionId
    }).prepared);
    const files = await readdir(directory);
    assert.equal(files.filter((name) => name.endsWith('.prepared.json')).length, 1);
    assert.equal(files.filter((name) => name.endsWith('.committed.json')).length, 0);
  });
});

test('a post-ref failure retains exact pending marker and local-only REV commit receipt', async () => {
  await publicationFixture(async ({ root, remote, parent, branch, story, specification }) => {
    await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
      ...specification,
      fault: (stage) => { if (stage === 'after-ref-update') throw new Error('post-ref fault'); }
    }), /post-ref fault/);
    const pending = await readPendingPublication(root, { kind: story.kind, id: story.id });
    assert.equal(pending.record.commit, git(root, 'rev-parse', 'HEAD'));
    assert.equal(pending.record.pushOutcome, 'not-attempted');
    assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), parent);
    const attestation = await readRevisionPublicationAttestation(root, {
      subject, transactionId: pending.record.transactionId
    });
    assert.equal(attestation.status, 'commit-retained-local');
    assert.equal(attestation.committed.commit, pending.record.commit);
    assert.equal(attestation.committed.tree, pending.record.tree);
    assert.equal(attestation.committed.eventSha256, pending.record.eventSha256);
  });
});

test('a local-only post-ref attestation failure retains an exact recoverable marker', async () => {
  await publicationFixture(async ({ root, parent, branch, story, specification }) => {
    let obstruction;
    await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
      ...specification,
      publication: { mode: 'off', branch, remote: 'origin' },
      fault: async (stage) => {
        if (stage !== 'after-commit-object') return;
        const directory = path.dirname(revisionPublicationAttestationPaths(root, {
          subject, transactionId
        }).prepared);
        const prepared = (await readdir(directory)).find((name) => name.endsWith('.prepared.json'));
        assert.ok(prepared);
        obstruction = path.join(directory, prepared.replace(/\.prepared\.json$/, '.committed.json'));
        await mkdir(obstruction);
      }
    }), { code: 'REV_ATTESTATION_COMMIT_PENDING_RECOVERY' });
    const pending = await readPendingPublication(root, { kind: story.kind, id: story.id });
    assert.ok(pending);
    assert.equal(pending.record.publicationMode, 'off');
    assert.equal(pending.record.localCommitted, true);
    assert.equal(pending.record.commit, git(root, 'rev-parse', 'HEAD'));
    assert.notEqual(pending.record.commit, parent);
    const markerBytes = await readFile(pending.path);
    const tampered = JSON.parse(markerBytes.toString('utf8'));
    tampered.error = 'edited after the governed transaction';
    await writeFile(pending.path, JSON.stringify(tampered));
    await assert.rejects(() => syncPublication(root, {
      git: { remote: 'origin' }, ledger: { enabled: false }
    }, { workItem: { id: story.id, branch } }), {
      code: 'REV_ATTESTATION_RECOVERY_UNPROVEN'
    });
    await writeFile(pending.path, markerBytes);
    await rm(obstruction, { recursive: true, force: true });
    const synced = await syncPublication(root, { git: { remote: 'origin' }, ledger: { enabled: false } }, {
      workItem: { id: story.id, branch }
    });
    assert.equal(synced.localOnly, true);
    assert.equal(synced.pushed, null);
    assert.equal(git(root, 'rev-parse', 'HEAD'), pending.record.commit);
    assert.equal(await readPendingPublication(root, { kind: story.kind, id: story.id }), null);
    const attestation = await readRevisionPublicationAttestation(root, {
      subject, transactionId: pending.record.transactionId
    });
    assert.equal(attestation.status, 'commit-retained-local');
    assert.equal(attestation.committed.commit, pending.record.commit);
  });
});

test('a process death after a local REV ref advance reconstructs its pending marker', async () => {
  await publicationFixture(async ({ root, branch, story }) => {
    const script = `
      import { writeFile } from 'node:fs/promises';
      import { GitPublicationUnitOfWork } from ${JSON.stringify(new URL('../src/publication-unit-of-work.mjs', import.meta.url).href)};
      import { lifecycleEvent } from ${JSON.stringify(new URL('../src/lifecycle-event.mjs', import.meta.url).href)};
      import { recordSha256 } from ${JSON.stringify(new URL('../src/records.mjs', import.meta.url).href)};
      const root = ${JSON.stringify(root)};
      const subject = ${JSON.stringify(story)};
      const h = (c) => 'sha256:' + c.repeat(64);
      await new GitPublicationUnitOfWork(root).execute({
        subject, allowedPaths: ['app.txt'],
        event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'implementation', generation: 1 }),
        commit: { message: '[WRK-REV] local crash attestation test' },
        publication: { mode: 'off', branch: ${JSON.stringify(branch)}, remote: 'origin' },
        state: { write: () => writeFile(root + '/app.txt', 'transaction\\n') },
        revisionAttestation: {
          beforeStateWrite: () => ({}),
          select: ({ prospectiveTree }) => {
            const core = {
              schemaVersion: 1, kind: 'revision-publication-selection',
              workId: subject.id, phaseId: 'implementation', phaseGeneration: 1,
              loopId: 'loop-1', loopRevision: 2, journalEntrySha256: h('a'),
              candidateId: 'CAN-revision-1', candidateSha256: h('b'),
              candidateRefSha256: h('c'), candidateTree: prospectiveTree,
              headTransitionSha256: h('d'), headSnapshotSha256: h('e'),
              precheckSha256: h('f'), contextSha256: h('1'),
              applicationProjectionSha256: h('2'), prospectiveTree
            };
            return { ...core, selectionSha256: 'sha256:' + recordSha256(core) };
          }
        },
        fault: (stage) => { if (stage === 'after-ref-update') process.exit(77); }
      });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root, encoding: 'utf8'
    });
    assert.equal(child.status, 77, child.stderr);
    const pending = await readPendingPublication(root, { kind: story.kind, id: story.id });
    assert.ok(pending);
    assert.equal(pending.record.publicationMode, 'off');
    assert.equal(pending.record.localCommitted, true);
    assert.equal(pending.record.commit, git(root, 'rev-parse', 'HEAD'));
    const synced = await syncPublication(root, { git: { remote: 'origin' }, ledger: { enabled: false } }, {
      workItem: { id: story.id, branch }
    });
    assert.equal(synced.localOnly, true);
    assert.equal(await readPendingPublication(root, { kind: story.kind, id: story.id }), null);
  });
});

test('rejected push leaves a local REV commit receipt and does not claim remote publication', async () => {
  await publicationFixture(async ({ root, remote, parent, branch, story, specification }) => {
    const hook = path.join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    await assert.rejects(() => new GitPublicationUnitOfWork(root).execute(specification),
      /push failed/i);
    const pending = await readPendingPublication(root, { kind: story.kind, id: story.id });
    assert.equal(pending.record.commit, git(root, 'rev-parse', 'HEAD'));
    assert.equal(pending.record.pushOutcome, 'rejected');
    assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), parent);
    const attestation = await readRevisionPublicationAttestation(root, {
      subject, transactionId: pending.record.transactionId
    });
    assert.equal(attestation.status, 'commit-retained-local');
    assert.equal(attestation.committed.commit, pending.record.commit);
    assert.equal(attestation.committed.outcome, 'commit-retained-local');
    assert.ok(!Object.hasOwn(attestation.committed, 'remote'));
    // Model a crash just after ref advancement but before sidecar completion. Recovery is allowed
    // to reconstruct the local binding only from the exact sealed pending marker and Candidate.
    const paths = revisionPublicationAttestationPaths(root, {
      subject, transactionId: pending.record.transactionId
    });
    await unlink(paths.committed);
    await assert.rejects(() => syncPublication(root, {
      git: { remote: 'origin' }, ledger: { enabled: false }
    }, { workItem: { id: story.id, branch } }), /Push still fails/);
    const recovered = await readRevisionPublicationAttestation(root, {
      subject, transactionId: pending.record.transactionId
    });
    assert.equal(recovered.status, 'commit-retained-local');
    assert.equal(recovered.committed.commit, pending.record.commit);
    assert.equal(recovered.committed.selectionSha256, pending.record.revisionSelectionSha256);
    assert.ok(await readPendingPublication(root, { kind: story.kind, id: story.id }));
  });
});
