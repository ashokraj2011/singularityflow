/** Install an existing VSIX into a disposable profile and test native navigation, never personal state.
 * SFLOW_UI_CODE_CLI and SFLOW_UI_CODE_HOST must name installed editor executables.
 * Usage: node scripts/verify-sidebar-installed.mjs /absolute/path/to/package.vsix
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vsix = process.argv[2];
const code = process.env.SFLOW_UI_CODE_CLI;
const host = process.env.SFLOW_UI_CODE_HOST;
if (!vsix || !path.isAbsolute(vsix) || !code || !host) throw new Error('Supply an absolute VSIX path and explicit SFLOW_UI_CODE_CLI / SFLOW_UI_CODE_HOST.');
const output = await mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'sfui-'));
const machine = path.join(output, 'm');
const repository = path.join(output, 'r');
const harness = path.join(output, 'h');
const userData = path.join(output, 'u');
const extensions = path.join(output, 'e');
await Promise.all([machine, repository, harness, extensions, path.join(userData, 'User')].map(p => mkdir(p, { recursive: true })));
const env = {
  ...process.env,
  SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_NO_NETWORK: '1',
  SINGULARITY_FLOW_HOME: path.join(machine, 'home'),
  SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
  SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
  SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
  SINGULARITY_FLOW_VSCODE_RESET_MARKER: path.join(machine, 'reset.json'),
  SINGULARITY_FLOW_AST_PREFERENCE_FILE: path.join(machine, 'ast.json'),
  SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(machine, 'outbox'),
  SFLOW_UI_EXTENSION_ROOT: extensions,
  SFLOW_UI_REPORT: path.join(output, 'installed-navigation.json')
};
delete env.ELECTRON_RUN_AS_NODE;
async function run(executable, args, cwd = repository) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit' });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Isolated UI verification timed out.')); }, 120_000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Verification process exited ${code}.`)); });
  });
}
// The only repository written is this freshly allocated, local-only fixture.
await run('git', ['init', '-q', '-b', 'main']);
await run('git', ['config', 'user.name', 'UI Verification']);
await run('git', ['config', 'user.email', 'ui-verification@example.test']);
await writeFile(path.join(repository, 'README.md'), '# Isolated navigation fixture\n');
await run(process.execPath, [path.join(root, 'bin/singularity-flow.mjs'), 'init']);
await run('git', ['add', '.']);
await run('git', ['commit', '-qm', 'UI fixture']);
await writeFile(path.join(harness, 'package.json'), JSON.stringify({
  name: 'navigation-qualification-harness', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.90.0' }
}));
await writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
  'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false
}));
await run(code, ['--user-data-dir', userData, '--extensions-dir', extensions, '--install-extension', vsix, '--force']);
await run(host, [repository, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${harness}`,
  `--extensionTestsPath=${path.join(root, 'apps/vscode/test/sidebar-installed-runner.cjs')}`,
  '--disable-updates', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window']);
console.log(JSON.stringify({ output, verification: JSON.parse(await readFile(env.SFLOW_UI_REPORT, 'utf8')) }));
