#!/usr/bin/env node
/** Install and exercise only a disposable VS Code profile; never user's extension/profile roots. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstalledUiFixture } from '../test/trp-installed-ui.fixture.mjs';
import { activateWorkspaceContext } from '../src/workspace-context.mjs';
import { head } from '../src/git.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const argument of process.argv.slice(2)) assert.match(argument, /^--(?:vsix|code)=.+$/u,
  'Only explicit --vsix and --code paths are accepted; fixture/profile roots are always newly generated.');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const vsix = path.resolve(option('vsix') ?? path.join(root, 'apps/vscode/singularity-flow-vscode-0.9.0.vsix'));
const code = option('code') ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
const fixture = await createInstalledUiFixture();
assert.equal(fixture.purpose, 'disposable-installed-ui-qualification');
assert.match(path.basename(fixture.base), /^sftrp-ui-[A-Za-z0-9]+$/u);
assert.equal(await realpath(fixture.base), fixture.base);
for (const target of [fixture.userData, fixture.extensions, ...Object.values(fixture.fixtures)
  .flatMap(value => [value.root, value.workspace, value.remote])]) {
  assert.ok(target.startsWith(fixture.base + path.sep));
  assert.equal(await realpath(target), target, 'qualification targets must not redirect outside the generated fixture');
}
const env = { ...process.env, ...fixture.environment, HOME: path.join(fixture.base, 'm'), VSCODE_CLI: '1',
  PATH: process.env.PATH ?? '' };
delete env.ELECTRON_RUN_AS_NODE;
const version = execFileSync(code, ['--version'], { env, encoding: 'utf8', timeout: 30000 }).trim();
execFileSync(code, ['--user-data-dir', fixture.userData, '--extensions-dir', fixture.extensions,
  '--install-extension', vsix, '--force'], { env, stdio: 'inherit', timeout: 60000 });
const installed = execFileSync(code, ['--user-data-dir', fixture.userData, '--extensions-dir', fixture.extensions,
  '--list-extensions', '--show-versions'], { env, encoding: 'utf8', timeout: 30000 });
assert.match(installed, /singularityflow\.singularity-flow-vscode@/u);
const driver = path.join(fixture.base, 'driver'); await mkdir(driver, { recursive: true });
await writeFile(path.join(driver, 'package.json'), JSON.stringify({ name: 'trp-isolated-host-driver',
  publisher: 'qualification-fixture', version: '0.0.0', engines: { vscode: '^1.90.0' } }));
await activateWorkspaceContext(fixture.environment.SINGULARITY_FLOW_WORKSPACE_REGISTRY,
  fixture.environment.SINGULARITY_FLOW_ACTIVE_WORKSPACE, fixture.fixtures.risk.id,
  { repositoryId: 'application', detectStory: true });
const repository = fixture.fixtures.risk.root;
const headBefore = head(repository);
const workflowPath = path.join(repository, 'singularity/work-items/TRP-UI-RISK/workflow.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const workflowBefore = digest(await readFile(workflowPath));
const reportPath = path.join(fixture.base, 'installed-host-report.json');
const packageEvidence = { schemaVersion: 1, kind: 'installed-extension-package', vsix, vsixSha256: digest(await readFile(vsix)),
  vscodeVersion: version, installed: installed.trim().split(/\r?\n/u), fixture: fixture.base,
  repositoryHead: headBefore, startedAt: new Date().toISOString() };
await writeFile(path.join(fixture.base, 'installed-package.json'), JSON.stringify(packageEvidence, null, 2));
const app = code.match(/^(.*\.app)\/Contents\/Resources\/app\/bin\/code$/u)?.[1];
const executable = app ? path.join(app, 'Contents/MacOS', execFileSync('/usr/libexec/PlistBuddy',
  ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 10000 }).trim()) : code;
const args = [repository, `--user-data-dir=${fixture.userData}`, `--extensions-dir=${fixture.extensions}`,
  `--extensionDevelopmentPath=${driver}`, `--extensionTestsPath=${path.join(root, 'apps/vscode/test/trp-installed-host-runner.cjs')}`,
  '--disable-workspace-trust', '--use-inmemory-secretstorage', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--new-window'];
console.log(JSON.stringify({ fixture: fixture.base, reportPath, ...packageEvidence }, null, 2));
const status = await new Promise((resolve, reject) => {
  const child = spawn(executable, args, { env: { ...env, SF_TRP_HOST_REPORT: reportPath,
    SF_TRP_EXTENSION_ROOT: fixture.extensions }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = bytes => { if (output.length < 262144) output += bytes; };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Isolated host exceeded 120s: ${output.slice(-3000)}`)); }, 120000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
});
await writeFile(path.join(fixture.base, 'installed-host-process.log'), status.output);
assert.equal(head(repository), headBefore, 'host preview/staging must not commit fixture Story state');
assert.equal(digest(await readFile(workflowPath)), workflowBefore, 'host preview/staging must leave Story bytes unchanged');
assert.equal(status.code, 0, status.output.slice(-4000));
const report = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(report.passed, true);
console.log(JSON.stringify({ reportPath, unchangedStory: true, report }, null, 2));
