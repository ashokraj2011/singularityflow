import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildRepositorySubjectIndexFromRefs } from '../src/repository-subject-index.mjs';
import { run } from '../src/util.mjs';

function git(root, ...args) { return run('git', args, { cwd: root }).stdout.trim(); }
function story(id, title) { return { schemaVersion: 2, workItem: { id, title, branch: 'main', workType: 'chore' },
  status: 'active', currentPhase: 'intake', phaseOrder: ['intake'],
  phases: { intake: { id: 'intake', status: 'in_progress', generation: 0 } },
  lineage: { canonicalBranch: 'main', childBranches: [], requiredChecks: [] }, history: [] }; }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-subject-pinned-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Pinned subject fixture');
  git(root, 'config', 'user.email', 'subject@example.invalid');
  const make = async (workRoot, initiativeRoot, title) => {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, 'singularity/workflow.yml'), `version: 2\nworkItemRoot: ${workRoot}\n`);
    await writeFile(path.join(root, 'singularity/portfolio.yml'), `version: 1\ninitiativeRoot: ${initiativeRoot}\n`);
    await mkdir(path.join(root, workRoot, 'STORY-1'), { recursive: true });
    await writeFile(path.join(root, workRoot, 'STORY-1/workflow.json'), JSON.stringify(story('STORY-1', title)));
    await mkdir(path.join(root, initiativeRoot, 'EPIC-1'), { recursive: true });
    await writeFile(path.join(root, initiativeRoot, 'EPIC-1/state.json'), JSON.stringify({ schemaVersion: 1,
      initiative: { id: 'EPIC-1', title, branch: 'main' }, status: 'active', currentPhase: 'intake',
      phaseOrder: ['intake'], phases: { intake: { id: 'intake', status: 'in_progress', generation: 0 } }, lineage: {} }));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', title); return git(root, 'rev-parse', 'HEAD');
  };
  const first = await make('old/stories', 'old/initiatives', 'Exact first revision');
  const second = await make('new/stories', 'new/initiatives', 'Exact second revision');
  git(root, 'update-ref', 'refs/heads/main', first);
  return { root, first, second };
}

test('a ref moving after capture cannot mix roots, record bytes or cache identity', async (t) => {
  const f = await fixture(t); const original = childProcess.spawnSync; let moved = false;
  childProcess.spawnSync = function (program, args, options) {
    const result = original(program, args, options);
    if (!moved && options?.cwd === f.root && args?.join('\0') === 'rev-parse\0--verify\0main') {
      moved = true;
      const changed = original(program, ['update-ref', 'refs/heads/main', f.second], options);
      assert.equal(changed.status, 0, String(changed.stderr));
    }
    return result;
  };
  syncBuiltinESMExports();
  let index;
  try { index = await buildRepositorySubjectIndexFromRefs(f.root, { refs: [{ ref: 'main', branch: 'main' }] }); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  assert.equal(moved, true, 'the actual Git ref moved between captured OID and policy reads');
  const selected = index.list('story')[0]; assert.equal(selected.state.workItem.title, 'Exact first revision');
  assert.equal(selected.location.path, 'old/stories/STORY-1/workflow.json'); assert.equal(selected.location.commit, f.first);
  const epic = index.list('initiative')[0]; assert.equal(epic.location.path, 'old/initiatives/EPIC-1/state.json');
  assert.equal(epic.state.initiative.title, 'Exact first revision');
  const next = await buildRepositorySubjectIndexFromRefs(f.root, { refs: [{ ref: 'main', branch: 'main' }] });
  assert.equal(next.list('story')[0].location.commit, f.second);
  assert.equal(next.list('story')[0].state.workItem.title, 'Exact second revision');
  git(f.root, 'update-ref', 'refs/heads/main', f.first);
  const again = await buildRepositorySubjectIndexFromRefs(f.root, { refs: [{ ref: 'main', branch: 'main' }] });
  assert.equal(again.list('story')[0].state.workItem.title, 'Exact first revision', 'later bytes were never cached beneath the first OID');
});

test('missing refs are explicit unavailable evidence, never a null-key shared summary', async (t) => {
  const f = await fixture(t);
  const index = await buildRepositorySubjectIndexFromRefs(f.root, { refs: ['missing-a', 'missing-b'] });
  assert.equal(index.list().length, 0); assert.equal(index.unreadable.length, 2);
  assert.deepEqual(index.unreadable.map((entry) => entry.ref), ['missing-a', 'missing-b']);
  assert.ok(index.unreadable.every((entry) => entry.code === 'SUBJECT_STATE_UNAVAILABLE' && entry.commit === null));
});

test('fresh archive-style reads do not consume the optional process-local summary', async (t) => {
  const f = await fixture(t); const original = childProcess.spawnSync; let rootReads = 0;
  childProcess.spawnSync = function (program, args, options) {
    if (options?.cwd === f.root && args?.[0] === 'show' && args?.[1] === `${f.first}:singularity/workflow.yml`) rootReads += 1;
    return original(program, args, options);
  };
  syncBuiltinESMExports();
  try {
    await buildRepositorySubjectIndexFromRefs(f.root, { refs: ['main'] });
    await buildRepositorySubjectIndexFromRefs(f.root, { refs: ['main'] });
    assert.equal(rootReads, 1);
    await buildRepositorySubjectIndexFromRefs(f.root, { refs: ['main'], fresh: true });
    assert.equal(rootReads, 2, 'fresh deletion-readiness pays for an independent exact policy/object proof');
    await buildRepositorySubjectIndexFromRefs(f.root, { refs: ['main'], env: { ...process.env } });
    await buildRepositorySubjectIndexFromRefs(f.root, { refs: ['main'], env: { ...process.env } });
    assert.equal(rootReads, 4, 'explicit environment capabilities are not collapsed into a shared cache key');
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});
