/**
 * Regressions for a round of audit findings whose common shape was a value produced by one side and
 * never reached by the other: a root written but not staged, a branch set resolved to one name, an
 * authority mode no producer could satisfy, a guard that answered "clean" when it had failed to look.
 *
 * Each test here fails against the code as it was, which is the only reason to keep it.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireSubjectLock, subjectLockPath } from '../src/subject-lock.mjs';
import { GOVERNED_ROOTS, initializeDefinition } from '../src/config.mjs';
import { assertNotDefaultBranch, defaultBranchName, protectedBranchNames } from '../src/git.mjs';
import { DEFAULT_IMPACT_METRIC_AUTHORITIES } from '../src/impact-config.mjs';
import { selectAuthoritativeImpactEvidence } from '../src/impact.mjs';
import { run } from '../src/util.mjs';

async function repository(branch = 'main', { remoteDefault = branch } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-audit-round-'));
  run('git', ['init', '-q', '-b', branch], { cwd: root });
  run('git', ['config', 'user.name', 'Audit Round'], { cwd: root });
  run('git', ['config', 'user.email', 'audit@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'initial'], { cwd: root });
  run('git', ['remote', 'add', 'origin', root], { cwd: root });
  run('git', ['update-ref', `refs/remotes/origin/${remoteDefault}`, 'HEAD'], { cwd: root });
  run('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${remoteDefault}`], { cwd: root });
  return root;
}

test('every root the initializer writes is a root a bootstrap stages', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-audit-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);

  // `.github/agents` was written from the beginning and staged by only one of three call sites, so
  // bootstrap left it untracked: enough to fail the next command's clean-tree check and to omit the
  // agent definitions from the governance proposal it opens.
  const written = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.name !== '.git')
    .map((entry) => entry.name);
  for (const name of written) {
    const covered = GOVERNED_ROOTS.some((governed) => governed === name || governed.startsWith(`${name}/`));
    assert.ok(covered, `${name} is written by initializeDefinition but no governed root stages it`);
  }
  assert.ok(GOVERNED_ROOTS.includes('singularity'));
  assert.ok(GOVERNED_ROOTS.includes('.github/agents'));
});

test('the branch guard protects main even when work is cut from another branch', async (t) => {
  const root = await repository('main');
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitflow = { defaultBaseBranch: 'develop' };

  // Two different questions. `defaultBaseBranch` says what work is cut from; under gitflow that is
  // `develop` while `main` is still the protected branch. Resolving only the configured value left
  // `main` unguarded in exactly the repositories most likely to protect it.
  assert.equal(defaultBranchName(root, gitflow), 'develop', 'the cut-from branch is unchanged');
  assert.deepEqual([...protectedBranchNames(root, gitflow)].sort(), ['develop', 'main', 'master']);
  assert.throws(
    () => assertNotDefaultBranch(root, gitflow, 'World-model publication'),
    /cannot run on protected application branch 'main'/
  );
});

test('a repository whose default is not main is still guarded on its own default', async (t) => {
  const root = await repository('trunk', { remoteDefault: 'trunk' });
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(defaultBranchName(root), 'trunk');
  assert.throws(() => assertNotDefaultBranch(root, {}, 'Publication'), /protected application branch 'trunk'/);
});

test('the reset guard refuses rather than reporting a clean tree it could not read', async (t) => {
  const root = await repository('main');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { factoryResetPlan } = await import('../src/factory-reset.mjs');
  await initializeDefinition(root);

  // A readable repository plans normally.
  assert.ok(await factoryResetPlan(root));

  // Now make `git status` itself fail, the way a corrupt or concurrently-held index does. The guard
  // used to answer [] here — "nothing uncommitted" — and the reset went on to `rm -rf` the control
  // root, taking the operator's uncommitted governed edits with it. Its own premise is that Git
  // history is the recovery path, which is exactly the claim that does not hold for those files.
  await writeFile(path.join(root, '.git', 'index'), 'not-an-index');
  await assert.rejects(
    () => factoryResetPlan(root),
    /Cannot determine whether .* has uncommitted governed changes/
  );
});

test('an expired lock whose PID has been recycled is still reclaimable', async (t) => {
  const root = await repository('main');
  t.after(() => rm(root, { recursive: true, force: true }));
  const subject = { kind: 'story', id: 'LOCK-1', branch: 'main' };
  const directory = subjectLockPath(root, subject);
  await mkdir(directory, { recursive: true });

  // `process.pid` stands in for a PID the OS recycled to an unrelated live process: the owner is
  // long expired, but `pidAlive` says yes. The liveness check used to run before the TTL and return
  // "held" outright, so this lock could never be broken except by hand.
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1, subject, pid: process.pid, host: os.hostname(),
    processToken: 'gone', lockToken: 'gone', acquiredAt: past, expiresAt: past
  })}\n`);

  const owner = await acquireSubjectLock(root, subject);
  assert.equal(owner.subject.id, 'LOCK-1');
  assert.notEqual(owner.lockToken, 'gone');
});

test('a live holder still keeps its lock until the lock expires', async (t) => {
  const root = await repository('main');
  t.after(() => rm(root, { recursive: true, force: true }));
  const subject = { kind: 'story', id: 'LOCK-2', branch: 'main' };
  await acquireSubjectLock(root, subject);
  await assert.rejects(() => acquireSubjectLock(root, subject), /is locked by PID/);
});

test('two processes cannot both reclaim the same abandoned lock', async (t) => {
  const root = await repository('main');
  t.after(() => rm(root, { recursive: true, force: true }));
  const subject = { kind: 'story', id: 'LOCK-3', branch: 'main' };
  const directory = subjectLockPath(root, subject);
  await mkdir(directory, { recursive: true });
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1, subject, pid: 999_999, host: 'a-machine-that-is-not-this-one',
    processToken: 'dead', lockToken: 'dead', acquiredAt: past, expiresAt: past
  })}\n`);

  // Read-decide-delete let both callers judge the lock stale and both delete — the second removing
  // the live replacement the first had just written. The reclaim is an atomic rename now, so exactly
  // one caller can win and the other is told the lock is held.
  const results = await Promise.allSettled([
    acquireSubjectLock(root, subject),
    acquireSubjectLock(root, subject)
  ]);
  const granted = results.filter((entry) => entry.status === 'fulfilled');
  assert.equal(granted.length, 1, 'exactly one caller may hold the lock');
});

test('a publication refuses when another process wrote the aggregate uncommitted', async (t) => {
  const root = await repository('main');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { GitPublicationUnitOfWork } = await import('../src/publication-unit-of-work.mjs');
  const { lifecycleEvent } = await import('../src/lifecycle-event.mjs');
  const { stateFingerprint } = await import('../src/util.mjs');

  const target = 'story-state.json';
  const statePath = path.join(root, target);
  await writeFile(statePath, '{"status":"loaded"}\n');
  run('git', ['add', target], { cwd: root });
  run('git', ['commit', '-qm', 'canonical state'], { cwd: root });

  const subject = { kind: 'story', id: 'RACE-1', branch: 'main' };
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const expectedRevision = { branch: 'main', head, statePath, stateSha256: stateFingerprint(statePath) };

  // A second process edits the work item and does not commit. HEAD is unchanged, so the old CAS saw
  // nothing and this publication would have saved its stale in-memory copy straight over that work.
  await writeFile(statePath, '{"status":"written by someone else"}\n');

  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    expectedRevision,
    event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),
    commit: { message: '[RACE-1] publish' },
    publication: { mode: 'off', branch: 'main' },
    allowedPaths: [target],
    state: { write: () => writeFile(statePath, '{"status":"mine"}\n') }
  }), /was modified by another process/);

  // And it refused before writing: the other process's work is still there.
  assert.match(await readFile(statePath, 'utf8'), /written by someone else/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(), head, 'no commit was made');
});

test('the escaped-defects default is a shape its own validator accepts', () => {
  // It defaulted to external-provider with an empty allowlist — the exact shape
  // `normalizeMetricAuthority` rejects — reached only because the defaults bypassed it. Nothing
  // could satisfy it, so the metric was unrecordable and any study naming it as a guardrail failed
  // permanently regardless of the data.
  const escaped = DEFAULT_IMPACT_METRIC_AUTHORITIES['escaped-defects'];
  assert.equal(escaped.authority, 'attested');
  assert.equal(escaped.providers, undefined);
});

test('external-provider authority accepts an allowlisted provider observation', () => {
  const workflow = {
    resolution: { impact: { metricAuthorities: { 'escaped-defects': { authority: 'external-provider', providers: ['quality-system'] } } } }
  };
  const collected = {
    evidenceId: 'e1',
    provider: { id: 'quality-system', version: '1', assurance: 'attested' },
    actor: { name: 'Reviewer', email: 'reviewer@example.com' },
    observation: { metric: 'escaped-defects', value: 3 }
  };

  // `collect` stamps 'attested' and `import` stamps 'unverified-import', so requiring
  // provider-verified/provider-signed made the mode unsatisfiable by any user action.
  const selected = selectAuthoritativeImpactEvidence(workflow, [collected]);
  assert.equal(selected.selected.get('escaped-defects').evidenceId, 'e1');

  // A hand-edited import still is not a provider observation, whatever provider ID it names.
  assert.throws(
    () => selectAuthoritativeImpactEvidence(workflow, [{
      ...collected, evidenceId: 'e2', provider: { ...collected.provider, assurance: 'unverified-import' }
    }]),
    /is not authoritative/
  );
});
