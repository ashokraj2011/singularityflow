import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { invokeCliProcess, validateRepositoryDirectory } from '../apps/desktop/electron/cli-runner.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Electron repository validation explains invalid and uninitialized selections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-repository-'));
  await assert.rejects(() => validateRepositoryDirectory(root), /not a Git repository/);
  await mkdir(path.join(root, '.git'));
  await assert.rejects(() => validateRepositoryDirectory(root), /not initialized with Singularity Flow/);
  await mkdir(path.join(root, '.singularity'));
  await writeFile(path.join(root, '.singularity', 'workflow.yml'), 'version: 1\n');
  assert.equal(await validateRepositoryDirectory(root), root);
});

test('Electron CLI runner returns JSON and bounds a stuck child process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-runner-'));
  const fixture = path.join(root, 'fixture.mjs');
  await writeFile(fixture, `
if (process.argv[2] === 'wait') setInterval(() => {}, 1000);
else process.stdout.write(JSON.stringify({ opened: process.cwd() }));
`);
  const opened = await invokeCliProcess({ executable: process.execPath, cli: fixture, repository: root, args: ['open'], env: process.env, timeoutMs: 1000 });
  assert.equal(await realpath(opened.opened), await realpath(root));
  await assert.rejects(
    () => invokeCliProcess({ executable: process.execPath, cli: fixture, repository: root, args: ['wait'], env: process.env, timeoutMs: 50 }),
    /did not finish within 1 seconds/
  );
});

test('Electron welcome screen renders persistent repository errors and loading feedback', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  assert.match(source, /Opening repository…/);
  assert.match(source, /Validating the repository and loading workflow state/);
  assert.match(source, /if \(!data\).*<Toast toast=\{toast\}/s);
  assert.doesNotMatch(source, /finally \{ setBusy\(false\); setTimeout\(\(\) => setToast\(null\)/);
});

test('Electron desktop exposes guided workflow and portable repository configuration controls', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const styles = await readFile(path.join(packageRoot, 'apps/desktop/src/styles.css'), 'utf8');
  const preload = await readFile(path.join(packageRoot, 'apps/desktop/electron/preload.cjs'), 'utf8');
  assert.match(source, />＋ Workflow</);
  assert.match(source, />＋ New stage</);
  assert.match(source, /Artifact path/);
  assert.match(source, /Inputs from earlier stages/);
  assert.match(source, /Create artifact template/);
  assert.match(source, /Create persona and prompt/);
  assert.match(source, /Create repository skill/);
  assert.match(source, /Repository-owned world model/);
  assert.match(source, /Editable builder prompt/);
  assert.match(source, /World-model views/);
  assert.match(source, /referenced view cannot be removed/i);
  assert.match(styles, /Avenir Next/);
  assert.match(styles, /Iowan Old Style/);
  assert.match(styles, /color-scheme: light/);
  assert.match(styles, /--navy-950/);
  assert.match(styles, /background: #347c32/);
  assert.match(styles, /border-radius: 999px/);
  assert.match(source, />Download config</);
  assert.match(preload, /deleteTemplate/);
  assert.match(preload, /downloadFile/);
  assert.match(preload, /importFile/);
  assert.match(preload, /exportBundle/);
});
