import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { expectedPhaseEvidencePaths } from '../src/recovery-preparation-context.mjs';
import { canonicalJson } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { run } from '../src/util.mjs';

const sha = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

async function fixture(t, phaseId = 'implementation') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = argv => run('git', argv, { cwd: root }).stdout.trim();
  git(['init', '-q', '-b', 'EV-1']);
  git(['config', 'user.name', 'Evidence Reviewer']);
  git(['config', 'user.email', 'evidence@example.test']);
  const itemRoot = 'governed/items/EV-1';
  const evidencePath = `${itemRoot}/evidence/conversion.png`;
  const claimPath = `${itemRoot}/context/claims/plan-gen1-planned.json`;
  await mkdir(path.join(root, itemRoot, 'context/claims'), { recursive: true });
  const record = { schemaVersion: currentSchemaVersion('specification-claim-map'),
    kind: 'planned', workId: 'EV-1', phase: 'plan', generation: 1,
    recordedAt: '2026-10-06T00:00:00.000Z', claims: {
      'EV-1:AC-001': { expectedPaths: [evidencePath], tests: ['test/conversion.test.mjs'],
        testDisposition: 'applicable', steps: [phaseId] }
    } };
  await writeFile(path.join(root, claimPath), canonicalJson(record));
  git(['add', '.']); git(['commit', '-qm', 'approved plan']);
  await mkdir(path.join(root, itemRoot, 'evidence'), { recursive: true });
  await writeFile(path.join(root, evidencePath), 'bounded screenshot bytes');
  const phase = { id: phaseId, generation: 0, status: 'in_progress' };
  const owner = { id: 'plan', status: 'approved', generation: 1,
    claimMaps: { planned: { path: claimPath, generation: 1, sha256: sha(record) } } };
  const workflow = { workItem: { id: 'EV-1' }, currentPhase: phaseId, phaseOrder: ['plan', phaseId],
    resolution: { plannedClaims: { mode: 'required', owners: { [phaseId]: 'plan' } } },
    phases: { plan: owner, [phaseId]: phase } };
  const config = { workItemRoot: 'governed/items' };
  const options = { itemRoot, generation: 1, changedPaths: [evidencePath] };
  const inspect = overrides => expectedPhaseEvidencePaths(root, config, workflow, phase, { ...options, ...overrides });
  const savePlan = async (commit = true) => {
    await writeFile(path.join(root, claimPath), canonicalJson(record));
    owner.claimMaps.planned.sha256 = sha(record);
    if (commit) { git(['add', claimPath]); git(['commit', '-qm', 'revised fixture plan']); }
  };
  return { root, git, itemRoot, evidencePath, claimPath, record, owner, phase, workflow, inspect, savePlan };
}

test('exact approved phase evidence is authoring ownership, across built-in and custom phases', async t => {
  for (const phaseId of ['implementation', 'verification', 'custom-code']) await t.test(phaseId, async t => {
    const f = await fixture(t, phaseId);
    const before = f.git(['status', '--porcelain=v1', '--untracked-files=all']);
    const bytes = await readFile(path.join(f.root, f.evidencePath));
    assert.deepEqual(await f.inspect(), [f.evidencePath]);
    assert.equal(f.git(['status', '--porcelain=v1', '--untracked-files=all']), before);
    assert.deepEqual(await readFile(path.join(f.root, f.evidencePath)), bytes);
    assert.deepEqual(await f.inspect({ generation: 2 }), []);
  });
});

test('undeclared, another Story and another phase evidence never enters the expected set', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.inspect({ changedPaths: [`${f.itemRoot}/evidence/unknown.png`, 'governed/items/OTHER/evidence/conversion.png'] }), []);
  f.record.claims['EV-1:AC-001'].steps = ['verification'];
  await f.savePlan();
  assert.deepEqual(await f.inspect(), []);
  f.record.claims['EV-1:AC-001'].steps = ['implementation'];
  f.record.claims['EV-1:AC-001'].expectedPaths = ['governed/items/OTHER/evidence/conversion.png'];
  await f.savePlan();
  assert.deepEqual(await f.inspect(), []);
});

test('evidence requires a preceding approved plan and an exact committed claim binding', async t => {
  for (const [label, change] of [
    ['unapproved', f => { f.owner.status = 'awaiting_approval'; }],
    ['later plan', f => { f.workflow.phaseOrder.reverse(); }],
    ['wrong generation', f => { f.owner.generation = 2; }],
    ['wrong pointer', f => { f.owner.claimMaps.planned.path = 'outside.json'; }],
    ['wrong digest', f => { f.owner.claimMaps.planned.sha256 = '0'.repeat(64); }],
    ['wrong Story', async f => { f.record.workId = 'OTHER'; await f.savePlan(); }],
    ['wrong phase', async f => { f.record.phase = 'other-plan'; await f.savePlan(); }],
    ['dirty plan', async f => { f.record.recordedAt = '2026-10-06T01:00:00.000Z'; await f.savePlan(false); }]
  ]) await t.test(label, async t => {
    const f = await fixture(t); await change(f);
    assert.deepEqual(await f.inspect(), []);
  });
});

test('linked, missing, oversized and directory evidence stays manual', async t => {
  for (const mode of ['missing', 'linked-file', 'linked-parent', 'oversized', 'directory']) await t.test(mode, async t => {
    const f = await fixture(t);
    const absolute = path.join(f.root, f.evidencePath);
    if (mode === 'oversized') await writeFile(absolute, Buffer.alloc(32 * 1024 * 1024 + 1));
    else if (mode === 'linked-parent') {
      const original = path.dirname(absolute); const moved = path.join(f.root, 'relocated-evidence');
      await rename(original, moved);
      try { await symlink(moved, original, 'dir'); }
      catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Symlink fixture unsupported'); return; } throw error; }
    } else {
      await unlink(absolute);
      if (mode === 'directory') await mkdir(absolute);
      if (mode === 'linked-file') {
        const moved = path.join(f.root, 'outside.png'); await writeFile(moved, 'other bytes');
        try { await symlink(moved, absolute); }
        catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) { t.skip('Symlink fixture unsupported'); return; } throw error; }
      }
    }
    assert.deepEqual(await f.inspect(), []);
  });
});
