import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_PAYLOAD, VSCE_TOOLCHAIN, configureLocalDemoWorkflow, stageCli, vsceToolManifest
} from '../scripts/vscode-dev.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the installed VS Code CLI carries the canonical Help manual', async () => {
  assert.ok(CLI_PAYLOAD.includes('HELP.md'), 'HELP.md is part of the declared installed payload');
  assert.ok(CLI_PAYLOAD.includes('LICENSE'), 'the bundled polyglot pack license is part of the installed payload');

  const extension = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-package-'));
  const staged = await stageCli({ rootDir: root, extensionDir: extension });
  const result = spawnSync(process.execPath, [
    path.join(staged, 'bin', 'singularity-flow.mjs'), 'help', '--json'
  ], { cwd: extension, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manual = JSON.parse(result.stdout);
  assert.equal(manual.title, 'Singularity Flow Help');
  assert.ok(manual.topics.some((topic) => topic.id === 'story-intake'));
  assert.ok(manual.topics.some((topic) => topic.id === 'workspaces-and-capabilities'));
  const providerImport = spawnSync(process.execPath, [
    '--input-type=module', '-e', 'await import("./src/model-providers/copilot-cli.mjs")'
  ], { cwd: staged, encoding: 'utf8' });
  assert.equal(providerImport.status, 0,
    `the staged CLI cannot load its locked ACP production dependency closure: ${providerImport.stderr}`);
  const sourceDigestImport = spawnSync(process.execPath, [
    '--input-type=module', '-e', [
      'const value = await import("./src/world-model/source-digest.mjs");',
      'process.stdout.write(value.WMB_V4_KERNEL_SOURCE_SHA256);'
    ].join('')
  ], { cwd: staged, encoding: 'utf8' });
  assert.equal(sourceDigestImport.status, 0,
    `the staged CLI cannot hash its installed WMB implementation bytes: ${sourceDigestImport.stderr}`);
  assert.match(sourceDigestImport.stdout, /^sha256:[a-f0-9]{64}$/);
  assert.equal(existsSync(path.join(staged, 'node_modules', 'singularity-flow-vscode')), false,
    'the staged production closure must exclude npm workspace links');
});

test('the CommonJS extension build uses a host-safe package root without import.meta warnings', () => {
  const extension = path.join(root, 'apps', 'vscode');
  const result = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: extension, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /empty-import-meta|import\.meta.*not available/i, output);
});

test('the single-file extension package contains dynamically loaded gateway helpers', async () => {
  const extension = path.join(root, 'apps', 'vscode');
  const built = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: extension, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
  const manifest = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
  const bundle = await readFile(path.join(extension, 'dist', 'extension.cjs'), 'utf8');
  assert.equal(manifest.activationEvents.includes('workspaceContains:workspace.json'), false);
  assert.match(bundle, /investigate-problem/,
    'the dynamically loaded conversation router was left outside the packaged CommonJS bundle');
  assert.match(bundle, /function primaryAction\(/,
    'the dynamically loaded result selector was left outside the packaged CommonJS bundle');
});

test('VS Code packaging pins one Artifactory-compatible MSAL dependency graph', () => {
  const manifest = vsceToolManifest();
  assert.deepEqual(manifest.dependencies, { '@vscode/vsce': '3.9.2' });
  assert.deepEqual(manifest.overrides, {
    '@azure/identity': '4.13.1',
    '@azure/msal-node': '5.1.0',
    '@azure/msal-browser': '5.5.0',
    '@azure/msal-common': '16.3.0'
  });
  assert.equal(VSCE_TOOLCHAIN.msalCommon, '16.3.0');
});

test('the local VS Code demo does not require a remote it deliberately omits', () => {
  const configured = configureLocalDemoWorkflow([
    'git:',
    '  remote: origin',
    '  publish: required',
    'worldModel:',
    '  grounding: warn'
  ].join('\n'));
  assert.match(configured, /publish: off/);
  assert.match(configured, /grounding: off/);
  assert.doesNotMatch(configured, /publish: required/);
});
