/**
 * SDA M5: backup tooling, legacy import and writer fences of the local stores.
 *
 * - A backup carries the layouts of earlier builds (the single `drafts.json`, the document store
 *   inside the runtime directory) with their exact operation IDs and digests.
 * - It is never saved inside a checkout of the repository, nor over another directory's contents.
 * - A backup this build cannot fully trust restores nothing: one a newer build wrote
 *   (SCHEMA_VERSION_FUTURE), one with a damaged document, one interrupted before its manifest, one
 *   from another repository.
 * - The draft store refuses a record a newer build wrote instead of calling it damaged, and an older
 *   build's `drafts.json` written after the migration is imported once, without duplicates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackup, inspectBackup, readBackup, restoreBackup } from '../src/local-backup.mjs';
import { defaultDraftOperationId, describeChange, draftsDirectory, legacyDraftsPath, readDrafts } from '../src/configuration-drafts.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const skill = { op: 'skill.create', id: 'review', label: 'Review', description: 'Reviews.', instructions: 'Review it.' };
const attach = { op: 'skill.attach', skill: 'review', agent: 'qa', phases: ['verification'], use: '' };

async function repository(t, name = 'app') {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-m5-backup-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, name); const remote = path.join(base, `${name}.git`);
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'remote', 'add', 'origin', remote);
  return { base, root, common: path.join(root, '.git') };
}

/** An earlier build's layouts: one drafts.json, and the document store inside the runtime directory. */
async function legacyLayouts(f) {
  const legacy = { schema: 'sflow-configuration-drafts@1', proposed: null, changes: [
    { change: skill, description: describeChange(skill), addedAt: '2026-09-01T00:00:00.000Z' },
    { change: attach, description: describeChange(attach), addedAt: '2026-09-01T00:01:00.000Z' }] };
  await mkdir(path.dirname(legacyDraftsPath(f.root)), { recursive: true });
  await writeFile(legacyDraftsPath(f.root), JSON.stringify(legacy));
  const bytes = Buffer.from('A brief kept only on this laptop.\n');
  const folder = path.join(f.common, 'singularity-flow', 'local-documents', 'APP-1', sha256(bytes));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(path.join(folder, 'brief.md'), bytes, { mode: 0o600 });
  return { legacy, bytes };
}

test('a backup carries the layouts of earlier builds with their exact operation IDs and document digests', async (t) => {
  const f = await repository(t);
  const { legacy, bytes } = await legacyLayouts(f);
  const out = path.join(f.base, 'carry');
  const created = await createBackup(f.root, { out });
  assert.deepEqual([created.configurationDrafts, created.documents, created.bytes], [2, 1, bytes.length]);
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.configurationDrafts.map((draft) => draft.operationId),
    legacy.changes.map((entry) => defaultDraftOperationId(entry.change, entry.description)),
    'a migrated draft keeps the operation ID its change derives');
  assert.deepEqual(manifest.documents, [{ workId: 'APP-1', key: `${sha256(bytes)}/brief.md`, sha256: sha256(bytes), size: bytes.length }]);
  assert.deepEqual(await readFile(path.join(out, 'objects', sha256(bytes))), bytes);
  assert.ok(!JSON.stringify(manifest).includes(f.base), 'no path of this machine is carried');
  // Both layouts were migrated where they live, never deleted.
  assert.ok(await lstat(`${legacyDraftsPath(f.root)}.migrated-v2`));
  assert.ok(await lstat(path.join(f.common, 'singularity-flow-documents', 'APP-1', sha256(bytes), 'brief.md')));
  assert.equal((await readBackup(out)).manifest.backupId, created.backupId);
  // The same backup read here plans nothing new: both drafts are saved, and no Story holds the document.
  const preview = await inspectBackup(f.root, out);
  assert.deepEqual(preview.configurationDrafts.map((draft) => draft.status), ['already-saved', 'already-saved']);
  assert.deepEqual(preview.documents.map((document) => document.status), ['story-not-here']);
  assert.equal(preview.fromThisMachine, true);
});

test('a backup is never saved inside a checkout of the repository or over another directory', async (t) => {
  const f = await repository(t);
  await writeFile(path.join(f.root, 'README.md'), 'x\n');
  git(f.root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'add', '.');
  git(f.root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'seed');
  const linked = path.join(f.base, 'story-worktree');
  git(f.root, 'worktree', 'add', '-q', '-b', 'story', linked);
  for (const out of [path.join(f.root, 'backup'), path.join(linked, 'nested', 'backup'), path.join(f.common, 'backup')]) {
    await assert.rejects(createBackup(f.root, { out }), { code: 'BACKUP_INSIDE_CHECKOUT' }, out);
    assert.equal(await lstat(out).catch(() => null), null, 'nothing was written');
  }
  const occupied = path.join(f.base, 'occupied');
  await mkdir(occupied); await writeFile(path.join(occupied, 'keep.txt'), 'mine\n');
  await assert.rejects(createBackup(f.root, { out: occupied }), { code: 'BACKUP_DESTINATION_INVALID' });
  assert.deepEqual(await readdir(occupied), ['keep.txt']);
  await assert.rejects(createBackup(f.root, {}), { code: 'BACKUP_DESTINATION_INVALID' });
});

// D10 (sweep 2026-10-31): documents too large for one backup were refused only after the destination
// was created and partly written, so a retry with the same --out was refused as not empty.
test('a backup too large is refused before anything is written, says what is too large, and the same --out works again', async (t) => {
  const f = await repository(t);
  const { bytes } = await legacyLayouts(f);
  const out = path.join(f.base, 'too-large');
  for (const limits of [{ documents: 0, bytes: 1024 }, { documents: 10, bytes: bytes.length - 1 }]) {
    await assert.rejects(createBackup(f.root, { out, limits }), (error) => {
      assert.equal(error.code, 'BACKUP_TOO_LARGE');
      assert.match(error.message, /laptop-local documents \(1 documents, 1 MiB; most in APP-1 \(1 MiB\)\) are more than one backup carries/);
      assert.match(error.message, /Nothing was written to .*documents store <DOCUMENT-ID> --store git/);
      assert.deepEqual(error.details.stories, [{ workId: 'APP-1', bytes: bytes.length }]);
      assert.equal(error.details.nextAction.command, 'singularity-flow documents list APP-1 --all --json');
      return true;
    });
    assert.equal(await lstat(out).catch(() => null), null, 'nothing was created');
  }
  // An empty directory the person made stays, empty.
  const chosen = path.join(f.base, 'chosen');
  await mkdir(chosen);
  await assert.rejects(createBackup(f.root, { out: chosen, limits: { documents: 0, bytes: 1024 } }), { code: 'BACKUP_TOO_LARGE' });
  assert.deepEqual(await readdir(chosen), []);
  // The same --out works once the backup fits.
  assert.equal((await createBackup(f.root, { out })).documents, 1);
  assert.equal((await createBackup(f.root, { out: chosen })).documents, 1);
});

test('a backup a newer build wrote, a damaged or interrupted one, or another repository\'s restores nothing', async (t) => {
  const f = await repository(t);
  await legacyLayouts(f);
  const out = path.join(f.base, 'carry');
  await createBackup(f.root, { out });
  const store = draftsDirectory(f.root);
  const before = (await readdir(store)).sort();
  const variant = async (name, change) => {
    const copy = path.join(f.base, name);
    await cp(out, copy, { recursive: true });
    await change(copy);
    return copy;
  };
  // Writer fence: this build never restores part of a backup it cannot read whole.
  const newer = await variant('newer', async (copy) => {
    const manifest = JSON.parse(await readFile(path.join(copy, 'manifest.json'), 'utf8'));
    await writeFile(path.join(copy, 'manifest.json'), JSON.stringify({ ...manifest, schemaVersion: 2 }));
  });
  await assert.rejects(restoreBackup(f.root, newer), { code: 'SCHEMA_VERSION_FUTURE' });
  const damaged = await variant('damaged', async (copy) => {
    const [object] = await readdir(path.join(copy, 'objects'));
    await writeFile(path.join(copy, 'objects', object), 'changed bytes\n');
  });
  await assert.rejects(restoreBackup(f.root, damaged), { code: 'BACKUP_INTEGRITY_FAILED' });
  const interrupted = await variant('interrupted', (copy) => rm(path.join(copy, 'manifest.json')));
  await assert.rejects(inspectBackup(f.root, interrupted), { code: 'BACKUP_INVALID' });
  const forged = await variant('forged', async (copy) => {
    const manifest = JSON.parse(await readFile(path.join(copy, 'manifest.json'), 'utf8'));
    manifest.configurationDrafts[0].change = { ...manifest.configurationDrafts[0].change, instructions: 'Something else.' };
    await writeFile(path.join(copy, 'manifest.json'), JSON.stringify(manifest));
  });
  await assert.rejects(inspectBackup(f.root, forged), { code: 'BACKUP_INVALID' }, 'a draft whose change no longer matches its digest');
  const other = await repository(t, 'other');
  await assert.rejects(restoreBackup(other.root, out), { code: 'BACKUP_REPOSITORY_MISMATCH' });
  assert.deepEqual((await readdir(store)).sort(), before, 'no refused backup changed the drafts');
  assert.equal(await lstat(draftsDirectory(other.root)).catch(() => null), null);
});

test('the draft store refuses a newer build\'s record and imports an older build\'s drafts.json once', async (t) => {
  const f = await repository(t);
  const { legacy } = await legacyLayouts(f);
  assert.equal((await readDrafts(f.root)).changes.length, 2);
  // An older build on this machine (a window's bundled CLI) never saw the migration and writes drafts.json again.
  const instruction = { op: 'instruction.create', id: 'tone', label: 'Tone', description: 'How to phrase.', instructions: 'Be kind.' };
  await writeFile(legacyDraftsPath(f.root), JSON.stringify({ ...legacy, changes: [...legacy.changes,
    { change: instruction, description: describeChange(instruction), addedAt: '2026-10-30T00:00:00.000Z' }] }));
  const imported = await readDrafts(f.root);
  assert.deepEqual(imported.changes.map((draft) => draft.change.op), ['skill.create', 'skill.attach', 'instruction.create'],
    'the older build\'s drafts are imported once, the ones already migrated are not duplicated');
  assert.ok(await lstat(`${legacyDraftsPath(f.root)}.migrated-v2-1`), 'its file is kept beside the store');
  // A newer build's draft is refused with the upgrade, and nothing is written beside it.
  const store = draftsDirectory(f.root);
  const file = path.join(store, `cdr-${'a'.repeat(24)}.json`);
  const future = JSON.stringify({ schema: 'sflow-configuration-draft@3', draftId: `cdr-${'a'.repeat(24)}` });
  await writeFile(file, future);
  const before = (await readdir(store)).sort();
  await assert.rejects(readDrafts(f.root), { code: 'SCHEMA_VERSION_FUTURE' });
  await assert.rejects(createBackup(f.root, { out: path.join(f.base, 'carry') }), { code: 'SCHEMA_VERSION_FUTURE' });
  assert.equal(await readFile(file, 'utf8'), future);
  assert.deepEqual((await readdir(store)).sort(), before);
  assert.equal(await lstat(path.join(f.base, 'carry')).catch(() => null), null);
});
