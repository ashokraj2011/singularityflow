/**
 * Start Work paints the last complete catalog at once and says it is checking for changes. `[perf]`
 *
 * The cache only accelerates the first paint: entries are per repository, bound to the CLI build
 * that wrote them, and anything unreadable is no cache. Before any listing arrives the form says it
 * is reading, rather than claiming the repository has no workflow or no base branch.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IntakeCatalogCache, MAX_INTAKE_CATALOG_CACHE_BYTES, cliBuildIdentity
} from '../apps/vscode/src/intake-catalog-cache.ts';
import {
  EMPTY_INTAKE_FORM, intakeHtml, intakeProblems
} from '../apps/vscode/src/views/intake-form.ts';

async function fakeCli(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intake-catalog-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'cli', 'bin'), { recursive: true });
  await mkdir(path.join(root, 'cli', 'src'), { recursive: true });
  const cli = path.join(root, 'cli', 'bin', 'singularity-flow.mjs');
  await writeFile(cli, '// entry\n');
  await writeFile(path.join(root, 'cli', 'src', 'cli.mjs'), '// listing\n');
  await writeFile(path.join(root, 'cli', 'package.json'), '{"version":"0.9.0"}\n');
  return { root, cli, storage: path.join(root, 'storage') };
}

const LISTED = {
  choices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }],
  remote: 'origin',
  intake: { storyWorkflows: [{ id: 'feature', label: 'Feature', phases: ['intake'] }] }
};

test('a written catalog is read back for its repository key and no other', async (t) => {
  const f = await fakeCli(t);
  const cache = new IntakeCatalogCache(f.storage, f.cli);
  const bound = cache.bind('/work/service/.git');
  assert.equal(bound.read(), null, 'nothing cached yet');
  bound.write(LISTED);
  await cache.flush();
  const read = bound.read();
  assert.deepEqual(read.listed, LISTED);
  assert.ok(Date.parse(read.savedAt) > 0);
  assert.equal(cache.read('/work/other/.git'), null, 'another repository never sees this entry');
  const names = await readdir(path.join(f.storage, 'intake-catalog-cache-v1'));
  assert.deepEqual(names.filter((name) => !/^[a-f0-9]{64}\.json$/.test(name)), [],
    'entries are named by a hash, never by a path');
});

test('an entry written by another CLI build is no cache at all', async (t) => {
  const f = await fakeCli(t);
  const cache = new IntakeCatalogCache(f.storage, f.cli);
  cache.write('/work/service/.git', LISTED);
  await cache.flush();
  const before = cliBuildIdentity(f.cli);
  const later = new Date(Date.now() + 60_000);
  await utimes(path.join(path.dirname(f.cli), '..', 'src', 'cli.mjs'), later, later);
  assert.notEqual(cliBuildIdentity(f.cli), before, 'rebuilding the listing module changes the build');
  assert.equal(cache.read('/work/service/.git'), null);
});

test('unreadable, foreign-shaped and oversized entries are ignored', async (t) => {
  const f = await fakeCli(t);
  const cache = new IntakeCatalogCache(f.storage, f.cli);
  cache.write('/work/service/.git', LISTED);
  await cache.flush();
  const directory = path.join(f.storage, 'intake-catalog-cache-v1');
  const [name] = await readdir(directory);
  await writeFile(path.join(directory, name), '{"schemaVersion":1,"snapshot":{"schema":"other"}}\n');
  assert.equal(cache.read('/work/service/.git'), null, 'another schema');
  await writeFile(path.join(directory, name), 'not json');
  assert.equal(cache.read('/work/service/.git'), null, 'corrupt bytes');
  cache.write('/work/service/.git', { padding: 'x'.repeat(MAX_INTAKE_CATALOG_CACHE_BYTES) });
  await cache.flush();
  assert.equal(cache.read('/work/service/.git'), null, 'an oversized listing is never written');
});

test('before any listing arrives the Story form says it is reading, not that nothing is configured', () => {
  const form = { ...EMPTY_INTAKE_FORM, shape: 'story', catalogStatus: 'loading' };
  const html = intakeHtml(form);
  assert.match(html, /Reading the approved Story workflows…/);
  assert.match(html, /Reading the remote base branches…/);
  assert.doesNotMatch(html, /No Story workflow is configured/);
  assert.doesNotMatch(html, /No remote base branch is available/);
  assert.doesNotMatch(html, /data-workflow-refresh/, 'no repair is offered for a read still under way');
  const problems = intakeProblems(form);
  assert.ok(problems.includes('Reading the approved Story workflows…'));
  assert.ok(problems.includes('Reading the remote base branches…'));
  assert.match(html, /data-submit="start" disabled/);
});

test('a cached paint is labelled and still cannot start without a fresh readiness check', () => {
  const form = {
    ...EMPTY_INTAKE_FORM, shape: 'story', catalogStatus: 'cached', id: 'STORY-1',
    storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
    workType: 'feature', baseRemote: 'origin',
    baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }]
  };
  const html = intakeHtml(form);
  assert.match(html, /last known\s+branches and workflows\. Checking the remote for changes…/);
  assert.match(html, /data-base-branch="main"/);
  assert.doesNotMatch(html, /data-base-branch="main" checked/, 'no base is ever preselected');
  assert.ok(intakeProblems(form).includes('Choose the remote base branch from which the Story branch will be created.'));
  assert.doesNotMatch(intakeHtml({ ...form, catalogStatus: 'fresh' }), /last known/);
});
