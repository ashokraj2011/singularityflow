import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { createInitiative } from '../src/initiative-state.mjs';
import { registerEpicSource, verifyEpicSources } from '../src/epic-sources.mjs';
import { validatePortfolio } from '../src/initiative-config.mjs';
import { run } from '../src/util.mjs';

/** A repository with a local storage provider and no external system configured at all. */
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-source-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Source Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# sources\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'Source Owner', email: 'owner@example.com' }];
  }
  portfolio.storage = { defaultProvider: 'local-files', providers: { 'local-files': { type: 'local' } } };
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init'], { cwd: root });
  run('git', ['switch', '-c', 'INIT-SRC'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-SRC', title: 'Local sources', profile: 'epic-planning', persona: 'product-owner',
    source: { type: 'manual', description: 'Local intake.' }
  });
  return root;
}

test('a local provider is a valid storage type', () => {
  const portfolio = validatePortfolio({
    version: 1,
    repositories: {},
    approvalAuthorities: { owners: { members: [{ email: 'o@example.com' }] } },
    storage: { defaultProvider: 'local-files', providers: { 'local-files': { type: 'local' } } },
    initiativeProfiles: { lite: { phases: ['one'] } },
    initiativePhases: { one: { outputs: [{ id: 'a', kind: 'markdown', path: 'a.md', template: 'a.md' }], bundleApproval: { authorities: ['owners'] } } }
  });
  assert.equal(portfolio.storage.providers['local-files'].type, 'local');
});

test('a binary document pins and verifies with no external system configured', async () => {
  const root = await repository();
  // The most ordinary intake document there is, and until now it had no way in without Jira,
  // Artifactory, SharePoint or S3.
  const brief = path.join(os.tmpdir(), `brief-${process.pid}.pdf`);
  await writeFile(brief, Buffer.from('%PDF-1.4\n% product brief\n'));

  const registered = await registerEpicSource(root, {
    initiativeId: 'INIT-SRC', filePath: brief, label: 'Product brief', mimeType: 'application/pdf'
  });
  assert.match(registered.record.sourceId, /^SRC-[0-9A-F]{12}$/);
  assert.equal(registered.record.provider, 'local-files');

  const verified = await verifyEpicSources(root, 'INIT-SRC', { materialize: true });
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.results.map((entry) => entry.status), ['verified']);

  // Bytes are committed beside the initiative, not cached under .git — a pinned source has to
  // verify on a reviewer's machine, not only the author's.
  const blobs = await readdir(path.join(root, 'singularity/initiatives/INIT-SRC/sources/blobs'));
  assert.equal(blobs.length, 1);
  assert.match(blobs[0], /^[a-f0-9]{64}$/, 'the blob directory is the content hash');
});

test('re-registering identical bytes reuses the same object', async () => {
  const root = await repository();
  const brief = path.join(os.tmpdir(), `same-${process.pid}.pdf`);
  await writeFile(brief, Buffer.from('%PDF-1.4\n% identical\n'));
  const first = await registerEpicSource(root, { initiativeId: 'INIT-SRC', filePath: brief, mimeType: 'application/pdf' });
  const again = await registerEpicSource(root, { initiativeId: 'INIT-SRC', filePath: brief, mimeType: 'application/pdf' });
  assert.equal(first.record.sha256, again.record.sha256);
  const blobs = await readdir(path.join(root, 'singularity/initiatives/INIT-SRC/sources/blobs'));
  assert.equal(blobs.length, 1, 'content addressing means the same bytes are stored once');
});

test('a filename that is not portable is normalised without rejecting the upload', async () => {
  const root = await repository();
  const awkward = path.join(os.tmpdir(), `Auth V2 PRD ${process.pid}.pdf`);
  await writeFile(awkward, Buffer.from('%PDF-1.4\n% spaces in the name\n'));
  const registered = await registerEpicSource(root, { initiativeId: 'INIT-SRC', filePath: awkward, mimeType: 'application/pdf' });
  assert.match(registered.record.name, /Auth V2 PRD/, 'the record keeps the original name for citation');
  const verified = await verifyEpicSources(root, 'INIT-SRC', { materialize: true });
  assert.equal(verified.valid, true);
});
