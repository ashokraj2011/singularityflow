/**
 * VS Code's Update SFlow…: which VS Code it installs into, what each screen says, and that the VSIX
 * carries every updater file the menu runs. Pure functions and files only; the real menu is driven
 * in an isolated VS Code during development (see the commit that added it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  confirmationDetail, confirmationSummary, endScreen, linkProblem, updaterArguments, updaterSourceRoot, vscodeExtensionsDirectory, vscodeLauncher
} from '../apps/vscode/src/sflow-update-model.ts';
import { UPDATER_FILES } from '../runtime/updater/files.mjs';
import { VSIX_REQUIRED_CLI_RUNTIME, VSIX_CLI_PAYLOAD } from '../src/vsix-source-manifest.mjs';
import { STANDALONE_UPDATER_FILES } from '../scripts/build-package-updater.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('the VSIX goes into the VS Code that ran the menu: its own launcher on macOS, Windows, Linux and Insiders', () => {
  const only = (...files) => file => files.includes(file);
  assert.equal(vscodeLauncher('/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app', 'darwin', 'code-insiders',
    only('/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders')),
  '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders');
  const windows = 'C:\\Users\\P\\AppData\\Local\\Programs\\Microsoft VS Code';
  assert.equal(vscodeLauncher(windows + '\\resources\\app', 'win32', 'code', only(windows + '\\bin\\code.cmd')), windows + '\\bin\\code.cmd');
  assert.equal(vscodeLauncher(windows + '\\0f3c1a\\resources\\app', 'win32', 'code', only(windows + '\\bin\\code.cmd')), windows + '\\bin\\code.cmd',
    'newer Windows builds keep the app in a versioned folder');
  assert.equal(vscodeLauncher('/usr/share/code/resources/app', 'linux', 'code', only('/usr/share/code/bin/code')), '/usr/share/code/bin/code');
  assert.equal(vscodeLauncher('/x/resources/app', 'linux', '../../evil', only('/x/bin/code')), '/x/bin/code', 'a strange name falls back to code');
  assert.equal(vscodeLauncher('/nowhere', 'darwin', 'code', () => false), null);
});

test('the extensions folder is passed only when VS Code would not find it itself', () => {
  const base = { environment: {}, homeDirectory: '/Users/p', dataFolderName: '.vscode', platform: 'darwin' };
  assert.equal(vscodeExtensionsDirectory({ ...base, extensionPath: '/Users/p/.vscode/extensions/singularityflow.x-0.9.0', production: true }), null);
  assert.equal(vscodeExtensionsDirectory({ ...base, extensionPath: '/tmp/sfupd/ext/singularityflow.x-0.9.0', production: true }), '/tmp/sfupd/ext');
  assert.equal(vscodeExtensionsDirectory({ ...base, dataFolderName: '.vscode-insiders', extensionPath: '/Users/p/.vscode-insiders/extensions/s-1', production: true }), null);
  assert.equal(vscodeExtensionsDirectory({ ...base, environment: { VSCODE_EXTENSIONS: '/data/ext' }, extensionPath: '/checkout/apps/vscode', production: false }), '/data/ext');
  assert.equal(vscodeExtensionsDirectory({ ...base, environment: { VSCODE_PORTABLE: '/portable/data' }, extensionPath: '/portable/data/extensions/s-1', production: true }), null);
  assert.equal(vscodeExtensionsDirectory({ ...base, extensionPath: '/checkout/apps/vscode', production: false }), null);
  assert.equal(vscodeExtensionsDirectory({ environment: {}, homeDirectory: 'C:\\Users\\P', dataFolderName: '.vscode', platform: 'win32',
    extensionPath: 'c:\\users\\p\\.vscode\\extensions\\s-1', production: true }), null, 'Windows compares folders without case');
});

test('the menu runs the updater its own VSIX ships, and the VSIX ships every file of it', () => {
  assert.equal(updaterSourceRoot('/ext/singularityflow.x-0.9.0', file => file === '/ext/singularityflow.x-0.9.0/cli/package.json'), '/ext/singularityflow.x-0.9.0/cli');
  assert.equal(updaterSourceRoot('/checkout/apps/vscode', () => false), '/checkout');
  assert.equal(STANDALONE_UPDATER_FILES, UPDATER_FILES, 'the standalone ZIP and VS Code use one list');
  for (const file of UPDATER_FILES) {
    assert.ok(existsSync(path.join(root, file)), file);
    assert.ok(VSIX_REQUIRED_CLI_RUNTIME.includes(file), `${file} is a required VSIX CLI file, so packaging fails if it is missing`);
    assert.ok(VSIX_CLI_PAYLOAD.some(entry => file === entry || file.startsWith(entry + '/')), `${file} is in the VSIX CLI payload`);
  }
  assert.deepEqual(updaterArguments({ script: '/run/updater/runtime/update.mjs', source: { mode: 'folder', source: 'https://contoso.sharepoint.com/:f:/s/t/A' },
    resultFile: '/run/result.json', currentCli: '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs',
    launcher: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', extensionsDirectory: null }), [
    '/run/updater/runtime/update.mjs', '--source', 'https://contoso.sharepoint.com/:f:/s/t/A', '--reinstall-copilot', '--result', '/run/result.json',
    '--current-cli', '/opt/homebrew/lib/node_modules/singularity-flow/bin/singularity-flow.mjs',
    '--code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']);
  assert.deepEqual(updaterArguments({ script: 'u', source: { mode: 'local-folder', localFolder: 'D:\\Downloads' }, resultFile: 'r', currentCli: null,
    launcher: null, extensionsDirectory: 'D:\\ext' }), ['u', '--local-folder', 'D:\\Downloads', '--reinstall-copilot', '--result', 'r', '--code-extensions-dir', 'D:\\ext']);
});

test('one confirmation names the source, what is installed, and every step; end screens always offer a next action', () => {
  const detail = confirmationDetail({ source: { mode: 'folder', source: 'https://contoso.sharepoint.com/:f:/s/t/A' },
    installed: 'The SFlow CLI 0.9.0 is installed with npm in /opt/homebrew.', extensionVersion: '0.9.0',
    steps: ['Download the .tgz and .vsix from the SharePoint link.', 'Check that the two files are one SFlow build.',
      'Install the CLI from the .tgz with npm, into the same place (/opt/homebrew).',
      'Uninstall the SFlow Copilot plugin and its skills, then install them again.', 'Install the VS Code extension from the .vsix into this VS Code.'],
    others: [], settingChange: null });
  assert.match(detail, /^From: SharePoint link https:\/\/contoso/u);
  assert.match(detail, /Installed now: The SFlow CLI 0\.9\.0 is installed with npm in \/opt\/homebrew\. The VS Code extension is 0\.9\.0\./);
  assert.match(detail, /1\. Download[\s\S]*2\. Check[\s\S]*3\. Install the CLI[\s\S]*4\. Uninstall the SFlow Copilot plugin[\s\S]*5\. Install the VS Code extension/);
  assert.match(detail, /Nothing changes until you choose Update/);

  const summary = confirmationSummary({ source: { mode: 'folder', source: 'https://contoso.sharepoint.com/:f:/s/t/' + 'A'.repeat(200) }, route: 'npm-global',
    version: '0.9.0', prefix: '/opt/homebrew', extensionVersion: '0.9.0' });
  const lines = summary.split('\n');
  assert.equal(lines.length, 5, 'fits the native dialog without cutting a step');
  assert.ok(lines.every(line => line.length <= 140));
  assert.match(lines[1], /CLI 0\.9\.0 \(npm, \/opt\/homebrew\) · VS Code extension 0\.9\.0/);
  assert.match(lines[2], /1 download .* 2 check .* 3 npm install -g the CLI into \/opt\/homebrew/);
  assert.match(lines[3], /4 uninstall \+ reinstall the Copilot plugin · 5 install the \.vsix into this VS Code/);
  const success = endScreen({ status: 'complete', version: '0.9.1' });
  assert.deepEqual([success.kind, success.message, success.actions], ['success', 'SFlow 0.9.1 is installed', ['Reload Window']]);
  assert.match(success.detail, /Restart any Copilot CLI sessions/);
  const failed = endScreen({ status: 'failed', error: 'npm could not write to /usr/lib/node_modules.', work: '/u/stage-1' });
  assert.equal(failed.message, 'SFlow was not updated');
  assert.match(failed.detail, /npm could not write[\s\S]*kept in \/u\/stage-1/);
  assert.deepEqual(failed.actions, ['Try again', 'Change source…', 'Show log']);
  assert.deepEqual(endScreen({ status: 'failed', error: 'This link asks people to sign in…', sourceProblem: true }).actions[0], 'Change source…');
  assert.match(endScreen(null, { stopped: true }).detail, /stopped before it finished/);
  const long = endScreen({ status: 'failed', error: 'word '.repeat(200), work: '/kept' });
  assert.equal(long.summary.split('\n').length, 5);
  assert.ok(long.summary.split('\n').every(line => line.length <= 138) && long.summary.endsWith('…'));
  for (const screen of [success, failed, endScreen(null)]) assert.ok(screen.actions.length > 0, 'no dead end');
});

test('a pasted link is checked as it is typed, in plain words', () => {
  assert.equal(linkProblem(''), null);
  assert.equal(linkProblem('https://contoso.sharepoint.com/:f:/s/team/Ab1?e=x'), null);
  assert.match(linkProblem('contoso.sharepoint.com/x'), /starting with https/);
  assert.match(linkProblem('http://contoso.sharepoint.com/x'), /must start with https/);
  assert.match(linkProblem('https://contoso.sharepoint.com/:x:/s/team/Ab1'), /single file/);
});

test('Update SFlow… is in the palette, first in Upgrade or Repair…, in the navigator title and in Help & diagnostics', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  const command = manifest.contributes.commands.find(entry => entry.command === 'singularityFlow.updateSflow');
  assert.equal(command?.title, 'Singularity Flow: Update SFlow…');
  const title = manifest.contributes.menus['view/title'].filter(entry => /2_maintain/.test(entry.group ?? ''));
  assert.deepEqual(title.map(entry => [entry.command, entry.group]), [['singularityFlow.updateSflow', '2_maintain@0'], ['singularityFlow.upgradeOrRepair', '2_maintain@1']]);
  const sidebar = await readFile(path.join(root, 'apps/vscode/src/views/sidebar.ts'), 'utf8');
  assert.match(sidebar, /'help-tools': \{ title: 'Help & diagnostics', ids: \[[^\]]*'update-sflow', 'after-install'/);
  assert.match(sidebar, /'update-sflow': 'singularityFlow\.updateSflow'/);
  const extension = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  const picks = extension.slice(extension.indexOf("'singularityFlow.upgradeOrRepair', async"));
  assert.match(picks.slice(0, 400), /\$\(cloud-download\) Update SFlow…', command: 'singularityFlow\.updateSflow'/);
  assert.match(extension, /globalState\.get\('singularityFlow\.sflowUpdate\.pending\.v1'\)[\s\S]{0,120}resumeSflowUpdate/, 'a reloaded window resumes a running update');
  const flow = await readFile(path.join(root, 'apps/vscode/src/views/sflow-update.ts'), 'utf8');
  assert.match(flow, /'Paste the SharePoint link you were given to install SFlow'/);
  assert.match(flow, /Use files I already downloaded…/);
  assert.match(flow, /createTerminal\(\{\s*name: UPDATE_TERMINAL_NAME, shellPath: runtime\.executable/);
});
