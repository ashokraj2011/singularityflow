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
  await assert.rejects(
    () => validateRepositoryDirectory(root),
    (error) => error.code === 'SINGULARITY_FLOW_LEGACY_CONTROL_ROOT' && error.legacyRoot === '.singularity'
  );
  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
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
  const main = await readFile(path.join(packageRoot, 'apps/desktop/electron/main.mjs'), 'utf8');
  assert.match(source, />＋ Workflow</);
  assert.match(source, />＋ New stage</);
  assert.match(source, /Artifact path/);
  assert.match(source, /Inputs from earlier stages/);
  assert.match(source, /Copilot session policy/);
  assert.match(source, /Block mutating tools until both selections complete/);
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
  assert.match(styles, /background: #181817/);
  assert.match(styles, /border-radius: 999px/);
  assert.match(styles, /body \{[^}]*font-size: 15px/s);
  assert.match(source, /fontSize: 14/);
  assert.doesNotMatch(source, /className="publish-scope-notice"/);
  assert.doesNotMatch(styles, /\.publish-scope-notice/);
  assert.match(source, />Download config</);
  assert.match(source, /Approval inbox/);
  assert.match(source, /Initiative orchestration/);
  assert.match(source, /Portfolio designer/);
  assert.match(source, /Cross-repository control plane/);
  assert.match(source, /Assurance & freshness/);
  assert.match(source, /Repository delivery graph/);
  assert.match(source, /Interface contracts/);
  assert.match(source, /Branches stay isolated/);
  assert.match(source, /never merges them into a default branch automatically/);
  assert.match(source, /singularity\/<\/small>/);
  assert.match(source, /Pending approvals/);
  assert.match(source, /Fetch remote inbox/);
  assert.match(source, /Model usage & cost/);
  assert.match(source, /Cost by phase/);
  assert.match(source, /Cost by model/);
  assert.match(source, /Cost needs telemetry or pricing/);
  assert.match(source, /Workflow time/);
  assert.match(source, /Total elapsed/);
  assert.match(source, /Approval waiting/);
  assert.match(source, /Copilot capture inactive/);
  assert.match(source, /Telemetry setup is outdated/);
  assert.match(source, /Waiting for Copilot export/);
  assert.match(source, /pending export/);
  assert.match(source, /No estimate shown/);
  assert.match(source, /Recent repositories/);
  assert.match(source, /Saved locations/);
  assert.match(source, /Open another repository/);
  assert.match(source, /Remove .* from recent repositories/);
  assert.match(source, /The Git-backed/);
  assert.match(source, /Artifact Studio/);
  assert.match(source, /Requirement workspace/);
  assert.match(source, /Impact Analysis Studio/);
  assert.match(source, /Singularity intelligence/);
  assert.match(source, /Singularity analysis/);
  assert.doesNotMatch(source, /SDLC Planner/);
  assert.match(styles, /\.cost-dashboard/);
  assert.match(styles, /\.timing-dashboard/);
  assert.match(styles, /\.timing-row/);
  assert.match(styles, /\.cost-breakdown-grid/);
  assert.match(styles, /\.recent-repositories/);
  assert.match(styles, /\.initiative-flow/);
  assert.match(styles, /\.initiative-lanes/);
  assert.match(styles, /\.initiative-metrics/);
  assert.match(styles, /\.repository-menu/);
  assert.match(styles, /\.studio-flow-track/);
  assert.match(styles, /\.requirement-layout/);
  assert.match(styles, /\.impact-graph/);
  assert.match(styles, /\.welcome-visual/);
  assert.match(preload, /recentRepositories/);
  assert.match(preload, /openRepository/);
  assert.match(preload, /forgetRepository/);
  assert.match(main, /repository:recent/);
  assert.match(main, /repository:open/);
  assert.match(main, /repository:forget/);
  assert.match(main, /Migrate folder/);
  assert.match(main, /\['migrate-config'\]/);
  assert.match(main, /does not commit, push, merge, or rewrite Git history/);
  assert.match(preload, /deleteTemplate/);
  assert.match(preload, /refreshInbox/);
  assert.match(preload, /attachInboxItem/);
  assert.match(preload, /downloadFile/);
  assert.match(preload, /importFile/);
  assert.match(preload, /exportBundle/);
  assert.match(preload, /initiativeId/);
  assert.match(main, /--initiative/);
});
