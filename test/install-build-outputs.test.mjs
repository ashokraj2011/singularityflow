import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanInstallBuildOutputs, verifyInstallBuildOutputs } from '../scripts/install-build-outputs.mjs';

const obsoleteHost = ['git', 'example', 'corp'].join('.');
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow install build outputs '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return root;
}
async function put(root, relative, text = 'retained fixture bytes') {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function missing(file) {
  await assert.rejects(lstat(file), { code: 'ENOENT' });
}

test('old bundles and source maps are cleared without touching source, artifacts or recovery', async t => {
  const root = await fixture(t);
  const previous = ['bundle/cold-compatibility.mjs', 'apps/vscode/dist/lazy-panels-runtime.cjs.map'];
  const preserved = ['src/feature.mjs', 'plugin/skills/example/SKILL.md', 'apps/vscode/src/view.ts',
    'apps/vscode/cli/retained.mjs', 'apps/vscode/release/previous.vsix', 'previous.tgz',
    '.singularity-flow/installations/activation-current.json', '.singularity-flow/workspaces.json',
    '.singularity-flow/installations/transactions/recovery/exact.tgz'];
  for (const file of previous) await put(root, file, `https://${obsoleteHost}/previous.git`);
  for (const file of preserved) await put(root, file);
  assert.deepEqual(await cleanInstallBuildOutputs(root), ['bundle', 'apps/vscode/dist']);
  for (const file of previous) await missing(path.join(root, file));
  for (const file of preserved) assert.equal(await readFile(path.join(root, file), 'utf8'), 'retained fixture bytes');
  assert.deepEqual(await cleanInstallBuildOutputs(root), [], 'a repeat source preparation is safe');
});

test('tracked output files refuse cleanup before either output root is removed', async t => {
  const root = await fixture(t);
  await put(root, 'bundle/old.mjs');
  await put(root, 'apps/vscode/dist/tracked.mjs');
  const result = spawnSync('git', ['add', '--', 'apps/vscode/dist/tracked.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(cleanInstallBuildOutputs(root), /contain tracked files/);
  assert.equal(await readFile(path.join(root, 'bundle/old.mjs'), 'utf8'), 'retained fixture bytes');
  assert.equal(await readFile(path.join(root, 'apps/vscode/dist/tracked.mjs'), 'utf8'), 'retained fixture bytes');
});

for (const linked of ['apps', 'apps/vscode', 'apps/vscode/dist', 'bundle']) {
  test(`linked ${linked} refuses cleanup and preserves every candidate root`, async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    await put(outside, 'keep.txt');
    await put(root, 'bundle/keep.mjs');
    const link = path.join(root, linked);
    await mkdir(path.dirname(link), { recursive: true });
    if (linked === 'bundle') await rm(link, { recursive: true });
    await symlink(outside, link, linkType);
    await assert.rejects(cleanInstallBuildOutputs(root), /linked or is not a directory/);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'retained fixture bytes');
    if (linked !== 'bundle') assert.equal(await readFile(path.join(root, 'bundle/keep.mjs'), 'utf8'), 'retained fixture bytes');
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  });
}

test('removing generated subdirectory links does not follow them to retained files', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await put(outside, 'keep.txt');
  await mkdir(path.join(root, 'bundle'));
  await symlink(outside, path.join(root, 'bundle', 'linked-directory'), linkType);
  await cleanInstallBuildOutputs(root);
  await missing(path.join(root, 'bundle'));
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'retained fixture bytes');
});

test('a file at an expected output directory is preserved and stops preparation', async t => {
  const root = await fixture(t);
  await put(root, 'bundle');
  await assert.rejects(cleanInstallBuildOutputs(root), /not a directory/);
  assert.equal(await readFile(path.join(root, 'bundle'), 'utf8'), 'retained fixture bytes');
});

test('freshly rebuilt bundles and maps still fail privacy validation with exact file and line', async t => {
  const root = await fixture(t);
  await cleanInstallBuildOutputs(root);
  await put(root, 'bundle/cli.mjs', `neutral\nhttps://${obsoleteHost}/team/project.git`);
  await put(root, 'apps/vscode/dist/extension.cjs.map', 'neutral\nprivate-fixture-account');
  await assert.rejects(verifyInstallBuildOutputs(root, { personalTerms: ['private-fixture-account'] }), error => {
    const message = error.message.replaceAll('\\', '/');
    assert.match(message, /bundle\/cli.mjs:2: use the generic Git URL placeholder/);
    assert.match(message, /apps\/vscode\/dist\/extension.cjs.map:2: personal name or account reference/);
    assert.ok(!message.includes(obsoleteHost));
    assert.ok(!message.includes('private-fixture-account'));
    return true;
  });
});

test('clean rebuilt output passes and irrelevant directories are not swept into the output audit', async t => {
  const root = await fixture(t);
  await put(root, 'bundle/cli.mjs', 'const repository = "<git_url>.git";');
  await put(root, 'apps/vscode/dist/extension.cjs.map', '{"sourcesContent":["safe source"]}');
  await put(root, 'node_modules/third-party/index.js', obsoleteHost);
  assert.deepEqual(await verifyInstallBuildOutputs(root, { personalTerms: [] }), { files: 2 });
});
