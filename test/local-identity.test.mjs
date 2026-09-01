import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assignLocalStoryIds, currentLocalEpicReservation, nextLocalEpicId, reserveLocalEpicBranch,
  syncLocalEpicReservation
} from '../src/local-identity.mjs';
import { checkout, fetchRemote, governedCommitIdentity, hasUpstream, refExists } from '../src/git.mjs';
import { listInitiatives } from '../src/initiative-state.mjs';
import {
  readPendingPublication, verifyPendingPublicationCommit, writePendingPublication
} from '../src/publication-pending.mjs';
import { run } from '../src/util.mjs';

function policy(publish = 'off') {
  return {
    initiativeRoot: 'singularity/initiatives',
    git: { remote: 'origin', publish },
    identity: {
      authority: 'local',
      local: {
        epicPrefix: 'SF-E',
        storyPrefix: 'SF-S',
        pad: 3,
        scopeStoriesByEpic: true
      }
    }
  };
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-identity-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Planner'], { cwd: root });
  run('git', ['config', 'user.email', 'planner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Local IDs\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initial'], { cwd: root });
  return root;
}

test('local Epic allocation scans governed directories and branches', async () => {
  const root = await repository();
  await mkdir(path.join(root, 'singularity/initiatives/SF-E-002'), { recursive: true });
  run('git', ['branch', 'SF-E-004'], { cwd: root });
  const next = await nextLocalEpicId(root, policy());
  assert.equal(next.id, 'SF-E-005');
});

test('local Story IDs retain plan IDs and are scoped by reserved Epic', () => {
  const portfolio = policy();
  const initiative = {
    initiative: { id: 'SF-E-007' },
    resolution: { identity: portfolio.identity }
  };
  const breakdown = {
    epics: [{
      id: 'PLAN-EPIC-001',
      stories: [
        { id: 'STORY-001', planId: 'STORY-001' },
        { id: 'STORY-002', planId: 'STORY-002' }
      ]
    }]
  };
  const assigned = assignLocalStoryIds(breakdown, initiative, portfolio);
  assert.deepEqual(assigned.stories.map((story) => story.workId), ['SF-S-007-001', 'SF-S-007-002']);
  assert.deepEqual(assigned.stories.map((story) => story.planId), ['STORY-001', 'STORY-002']);
  assert.ok(assigned.stories.every((story) => story.idAuthority === 'local'));
});

test('local Epic reservation is a committed branch allocation', async () => {
  const root = await repository();
  const result = await reserveLocalEpicBranch(root, policy(), {
    base: 'main',
    actor: { name: 'Planner', email: 'planner@example.com' }
  });
  assert.equal(result.id, 'SF-E-001');
  assert.equal(result.pushed, false);
  assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), 'SF-E-001');
  assert.match(run('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: root }).stdout, /identity-reservations\/SF-E-001\.json/);
  const transaction = governedCommitIdentity(root, result.reservationCommit);
  assert.ok(transaction?.candidate, 'Epic reservation bypassed the universal Candidate boundary');
  assert.match(transaction.candidate.candidateId, /^CAN-/);
  const recoverable = await currentLocalEpicReservation(root, policy());
  assert.equal(recoverable.id, 'SF-E-001');
  assert.equal(recoverable.reservationCommit, result.reservationCommit);
  assert.equal(recoverable.recoverable, true);

  await mkdir(path.join(root, 'singularity/initiatives/SF-E-001'), { recursive: true });
  await writeFile(path.join(root, 'singularity/initiatives/SF-E-001/state.json'), '{}');
  assert.equal(await currentLocalEpicReservation(root, policy()), null);
});

test('Candidate failure restores the exact pre-reservation branch, tree, and checkout', async () => {
  const root = await repository();
  const before = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();

  await assert.rejects(
    () => reserveLocalEpicBranch(root, policy(), {
      base: 'main', actor: { name: 'Planner', email: 'planner@example.com' },
      fault: (stage) => {
        if (stage === 'after-candidate-verification') throw new Error('refuse reservation Candidate');
      }
    }),
    /refuse reservation Candidate/
  );

  assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), 'main');
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(), before);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');
  assert.equal(refExists(root, 'refs/heads/SF-E-001'), false);
  await assert.rejects(
    readFile(path.join(root, 'singularity/identity-reservations/SF-E-001.json')),
    (error) => error?.code === 'ENOENT'
  );
});

test('an interrupted local Epic reservation resumes only its exact Candidate commit', async () => {
  const root = await repository();
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reservation-origin-'));
  const remote = path.join(remoteRoot, 'origin.git');
  run('git', ['init', '--bare', remote], { cwd: remoteRoot });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

  await assert.rejects(
    () => reserveLocalEpicBranch(root, policy('required'), {
      base: 'main', actor: { name: 'Planner', email: 'planner@example.com' },
      fault: async (point) => {
        if (point === 'after-commit') throw new Error('simulated Epic reservation interruption');
      }
    }),
    /simulated Epic reservation interruption/
  );
  const retained = await currentLocalEpicReservation(root, policy('required'));
  assert.equal(retained.id, 'SF-E-001');
  assert.equal(retained.pushed, false);
  const transaction = governedCommitIdentity(root, retained.reservationCommit);
  assert.ok(transaction?.candidate);
  const pending = await readPendingPublication(root, { kind: 'initiative', id: retained.id });
  const verification = verifyPendingPublicationCommit(root, pending.record, {
    subject: { kind: 'initiative', id: retained.id }, branch: retained.id, remote: 'origin'
  });
  assert.equal(verification.valid, true, verification.failures.join('; '));
  assert.equal(verification.candidateVerified, true);
  assert.equal(pending.record.candidate.candidateTree, transaction.tree);

  const recovered = await syncLocalEpicReservation(root, policy('required'), retained);
  assert.equal(recovered.pushed, true);
  assert.equal(recovered.reservationCommit, retained.reservationCommit);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/SF-E-001'], {
    cwd: remoteRoot
  }).stdout.trim(), retained.reservationCommit);
});

test('a definitive create-only rejection never adopts another identical remote ref', async () => {
  const root = await repository();
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reservation-collision-'));
  const remote = path.join(remoteRoot, 'origin.git');
  run('git', ['init', '--bare', remote], { cwd: remoteRoot });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

  await assert.rejects(
    () => reserveLocalEpicBranch(root, policy('required'), {
      base: 'main', actor: { name: 'Planner', email: 'planner@example.com' },
      fault: async (point, context) => {
        if (point !== 'after-commit') return;
        // Another publisher installs the byte-identical object before this transaction's
        // create-only push. Equality is not proof that this invocation acquired the ref.
        run('git', [
          'push', 'origin', `${context.sourceCommit}:refs/heads/SF-E-001`
        ], { cwd: root });
      }
    }),
    (error) => error?.code === 'PUBLICATION_PUSH_FAILED'
  );
  const pending = await readPendingPublication(root, {
    kind: 'initiative', id: 'SF-E-001', migrate: false
  });
  assert.equal(pending?.record?.pushOutcome, 'rejected');
  assert.equal(pending?.record?.commit,
    run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/SF-E-001'], {
      cwd: remoteRoot
    }).stdout.trim());
});

test('a sealed indeterminate Epic reservation reconciles exact remote equality', async () => {
  const root = await repository();
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reservation-ambiguous-'));
  const remote = path.join(remoteRoot, 'origin.git');
  run('git', ['init', '--bare', remote], { cwd: remoteRoot });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });

  await assert.rejects(
    () => reserveLocalEpicBranch(root, policy('required'), {
      base: 'main', actor: { name: 'Planner', email: 'planner@example.com' },
      fault: async (point) => {
        if (point === 'after-commit') throw new Error('simulate death before transport result');
      }
    }),
    /simulate death/
  );
  const subject = { kind: 'initiative', id: 'SF-E-001' };
  const pending = await readPendingPublication(root, subject);
  await writePendingPublication(root, {
    ...subject,
    record: { ...pending.record, pushOutcome: 'transport-indeterminate' }
  });
  run('git', [
    'push', 'origin', `${pending.record.commit}:refs/heads/SF-E-001`
  ], { cwd: root });

  const recovered = await syncLocalEpicReservation(root, policy('required'));
  assert.equal(recovered.pushed, true);
  assert.equal(recovered.reservationCommit, pending.record.commit);
  assert.equal(await readPendingPublication(root, { ...subject, migrate: false }), null);
});

test('Epic home discovers committed initiative state from remote branches', async () => {
  const root = await repository();
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-origin-'));
  const remote = path.join(remoteRoot, 'origin.git');
  run('git', ['init', '--bare', remote], { cwd: remoteRoot });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });
  run('git', ['switch', '-c', 'SF-E-001'], { cwd: root });
  const directory = path.join(root, 'singularity/initiatives/SF-E-001');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({
    initiative: {
      id: 'SF-E-001',
      branch: 'SF-E-001',
      title: 'Remote business Epic',
      profile: 'epic-planning',
      profileLabel: 'Epic planning',
      createdAt: '2026-07-24T00:00:00.000Z'
    },
    lineage: { idAuthority: 'local', primaryId: 'SF-E-001', aliases: [] },
    phaseOrder: ['epic-intake', 'epic-requirements'],
    phases: {
      'epic-intake': { id: 'epic-intake', label: 'Epic intake', status: 'approved' },
      'epic-requirements': { id: 'epic-requirements', label: 'Requirements', status: 'awaiting_approval', submittedAt: '2026-07-24T01:00:00.000Z' }
    },
    currentPhase: 'epic-requirements',
    status: 'in_progress',
    history: [{ at: '2026-07-24T01:00:00.000Z', actor: 'owner@example.com', event: 'initiative_phase_published' }]
  }));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Add remote Epic'], { cwd: root });
  run('git', ['push', '-u', 'origin', 'SF-E-001'], { cwd: root });
  run('git', ['switch', 'main'], { cwd: root });
  const items = await listInitiatives(root, policy('required'));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'SF-E-001');
  assert.equal(items[0].currentPhaseLabel, 'Requirements');
  assert.equal(items[0].currentPhaseStatus, 'awaiting_approval');
  assert.equal(items[0].percentage, 50);
  assert.equal(items[0].source, 'origin/SF-E-001');
});

test('fetching repairs an existing single-branch workspace clone', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-narrow-clone-'));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Planner'], { cwd: source });
  run('git', ['config', 'user.email', 'planner@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# Remote branches\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'Initial'], { cwd: source });
  run('git', ['clone', '--bare', source, remote], { cwd: base });
  run('git', ['switch', '-c', 'KAN-8'], { cwd: source });
  await writeFile(path.join(source, 'epic.md'), '# KAN-8\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'Epic'], { cwd: source });
  run('git', ['push', remote, 'KAN-8'], { cwd: source });
  run('git', ['clone', '--branch', 'main', '--single-branch', remote, clone], { cwd: base });

  assert.equal(refExists(clone, 'refs/remotes/origin/KAN-8'), false);
  fetchRemote(clone);
  assert.equal(refExists(clone, 'refs/remotes/origin/KAN-8'), true);
  assert.equal(checkout(clone, 'KAN-8', { fetch: true, existingOnly: true }), 'tracked-remote');
  assert.equal(hasUpstream(clone), true);
});

test('a fetched new work branch starts from the refreshed remote base rather than stale local main', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-work-base-'));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Planner'], { cwd: source });
  run('git', ['config', 'user.email', 'planner@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# Initial source\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'Initial'], { cwd: source });
  run('git', ['clone', '--bare', source, remote], { cwd: base });
  run('git', ['clone', remote, clone], { cwd: base });

  // The clone's local main now stays behind while another contributor publishes the world model.
  const modelDirectory = path.join(source, 'singularity', 'world-model');
  await mkdir(modelDirectory, { recursive: true });
  await writeFile(path.join(modelDirectory, 'manifest.json'), '{"schema_version":"2.0"}\n');
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'Publish repository world model'], { cwd: source });
  run('git', ['push', remote, 'main'], { cwd: source });

  assert.equal(refExists(clone, 'refs/heads/WORK-999'), false);
  assert.equal(checkout(clone, 'WORK-999', { base: 'main', fetch: true }), 'created-from-origin/main');
  assert.equal(await readFile(path.join(clone, 'singularity/world-model/manifest.json'), 'utf8'),
    '{"schema_version":"2.0"}\n');
});

test('local Epic reservation inherits the refreshed remote base after identity allocation fetches', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-epic-base-'));
  const source = await repository();
  const remote = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  run('git', ['clone', '--bare', source, remote], { cwd: base });
  run('git', ['clone', remote, clone], { cwd: base });
  run('git', ['config', 'user.name', 'Planner'], { cwd: clone });
  run('git', ['config', 'user.email', 'planner@example.com'], { cwd: clone });

  await mkdir(path.join(source, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(source, 'singularity/world-model/manifest.json'), '{"schema_version":"2.0","marker":"remote"}\n');
  run('git', ['add', 'singularity/world-model/manifest.json'], { cwd: source });
  run('git', ['commit', '-m', 'Publish repository world model'], { cwd: source });
  run('git', ['push', remote, 'main'], { cwd: source });

  const reserved = await reserveLocalEpicBranch(clone, policy(), {
    base: 'main',
    actor: { name: 'Planner', email: 'planner@example.com' }
  });
  assert.equal(reserved.id, 'SF-E-001');
  assert.match(await readFile(path.join(clone, 'singularity/world-model/manifest.json'), 'utf8'), /"marker":"remote"/);
});

test('an Epic whose branch was never pushed is still listed from another branch', async () => {
  // The Epic list read the working tree and the remote, so an Epic whose push failed existed on
  // exactly one local branch and nowhere the app could see it. From main it was invisible, while
  // `initiative start` still refused to create it — the Epic was unreachable from the desktop,
  // which reported "use singularity-flow initiative resume" for a command it cannot run.
  const root = await repository();
  run('git', ['switch', '-c', 'SF-E-002'], { cwd: root });
  const directory = path.join(root, 'singularity/initiatives/SF-E-002');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({
    initiative: {
      id: 'SF-E-002',
      branch: 'SF-E-002',
      title: 'Unpushed business Epic',
      profile: 'epic-planning',
      profileLabel: 'Epic planning',
      createdAt: '2026-07-25T00:00:00.000Z'
    },
    lineage: { idAuthority: 'local', primaryId: 'SF-E-002', aliases: [] },
    phaseOrder: ['epic-intake', 'epic-requirements'],
    phases: {
      'epic-intake': { id: 'epic-intake', label: 'Epic intake', status: 'approved' },
      'epic-requirements': { id: 'epic-requirements', label: 'Requirements', status: 'in_progress' }
    },
    currentPhase: 'epic-requirements',
    status: 'in_progress',
    history: [{ at: '2026-07-25T01:00:00.000Z', actor: 'owner@example.com', event: 'initiative_started' }]
  }));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Start SF-E-002'], { cwd: root });
  run('git', ['switch', 'main'], { cwd: root });

  const items = await listInitiatives(root, policy('required'));
  assert.deepEqual(items.map((item) => item.id), ['SF-E-002']);
  assert.equal(items[0].source, 'local/SF-E-002');
  assert.equal(items[0].currentPhaseLabel, 'Requirements');
});
