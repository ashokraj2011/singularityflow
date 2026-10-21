import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, lstat, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aboutBuilds, aboutBuildsMarkdown } from '../src/about-builds.mjs';
import { stampBuildInfo } from '../src/build-info-stamp.mjs';
import { versionLine } from '../src/build-info.mjs';
import { aboutHtml, isAboutInfo } from '../apps/vscode/src/views/about-page.ts';

const source = await readFile(new URL('../src/build-info.mjs', import.meta.url), 'utf8');
const old = { commit: 'a'.repeat(40), sourceSha256: null, branch: null, dirty: false, builtAt: '2026-10-17T00:00:00.000Z' };
const current = { ...old, commit: 'b'.repeat(40), builtAt: '2026-10-18T01:02:03.000Z' };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-about-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = path.join(root, '.vscode/extensions/singularityflow.singularity-flow-vscode-0.9.0');
  await mkdir(path.join(extension, 'cli/src'), { recursive: true });
  await writeFile(path.join(extension, 'package.json'), JSON.stringify({ publisher: 'singularityflow', name: 'singularity-flow-vscode', version: '0.9.0' }));
  await writeFile(path.join(extension, 'cli/src/version.mjs'), "export const VERSION = '0.9.0';\n");
  await writeFile(path.join(extension, 'cli/src/build-info.mjs'), stampBuildInfo(source, current));
  const calls = [];
  const options = { homeDirectory: root, environment: {}, packageRoot: '/selected/cli', runningInfo: current,
    execute: (command, args, options) => { calls.push({ command, args, options }); return { status: 0, stdout: versionLine(old) }; } };
  return { root, extension, calls, options };
}

test('About reports exact builds and dates without a receipt, Git or package-manager inventory', async t => {
  const f = await fixture(t);
  const sentinel = path.join(f.root, 'workspace.txt');
  await writeFile(sentinel, 'preserve workspace and selected Story');
  const info = await aboutBuilds({ ...f.options, extensionPath: f.extension });
  assert.equal(info.cli.version, '0.9.0');
  assert.equal(info.cli.builtAt, old.builtAt);
  assert.equal(info.vscode[0].builtAt, current.builtAt);
  assert.equal(info.vscode[0].version, '0.9.0');
  assert.equal(info.alignment, 'mismatch');
  assert.equal(info.runningMatchesPath, false);
  assert.equal(info.receipt.status, 'missing');
  assert.deepEqual(f.calls.map(({ command, args }) => [command, args]), [['singularity-flow', ['--build']]]);
  assert.equal(f.calls[0].options.env.SINGULARITY_FLOW_PRODUCT_ALIGNMENT, 'off');
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve workspace and selected Story');
  assert.equal(isAboutInfo(info), true);
  const markdown = aboutBuildsMarkdown(info);
  assert.match(markdown, /\| Surface \| Version \| Build identity \| Build date \(UTC\) \|/);
  assert.match(markdown, /mismatch/);
  assert.match(markdown, /2026-10-18T01:02:03/);
  const offset = await aboutBuilds({ ...f.options, extensionPath: f.extension,
    execute: () => ({ status: 0, stdout: versionLine({ ...current, builtAt: '2026-10-18T08:00:00+05:30' }) }) });
  assert.equal(offset.cli.builtAt, '2026-10-18T02:30:00.000Z');
});

test('About discovers indexed and conventional installations without executing extension sources', async t => {
  const f = await fixture(t);
  const index = path.join(path.dirname(f.extension), 'extensions.json');
  await writeFile(index, JSON.stringify([{ identifier: { id: 'singularityflow.singularity-flow-vscode' }, relativeLocation: path.basename(f.extension) }]));
  const info = await aboutBuilds({ ...f.options, execute: () => ({ status: 0, stdout: versionLine(current) }) });
  assert.equal(info.vscode.length, 1);
  assert.equal(info.alignment, 'matched');
  assert.equal(info.vscode[0].path, f.extension);
  await writeFile(path.join(f.extension, 'cli/src/version.mjs'), "export const VERSION = '0.9.0';\r\n");
  const crlf = await aboutBuilds({ ...f.options, extensionPath: f.extension });
  assert.equal(crlf.vscode[0].status, 'available', 'Windows CRLF metadata must retain its stamp');
  await writeFile(index, '{invalid JSON');
  const fallback = await aboutBuilds(f.options);
  assert.equal(fallback.vscode.length, 1);
  assert.ok(fallback.warnings.some(warning => /extension index/.test(warning)));
  await writeFile(path.join(f.extension, 'cli/src/build-info.mjs'), 'throw new Error("must never execute this metadata");');
  const invalid = await aboutBuilds({ ...f.options, extensionPath: f.extension });
  assert.equal(invalid.vscode[0].status, 'unavailable');
  assert.equal(invalid.vscode[0].version, '0.9.0');
  assert.equal(invalid.vscode[0].builtAt, null);
  assert.equal(invalid.alignment, 'unknown');
});

test('missing CLI, timeout, and development builds remain unknown rather than falsely aligned', async t => {
  const f = await fixture(t);
  for (const result of [{ status: 1, stderr: 'command unavailable' }, { status: null, timedOut: true },
    { status: 0, stdout: '0.9.0 (development checkout, not a stamped package)' }]) {
    const info = await aboutBuilds({ ...f.options, execute: () => result, extensionPath: f.extension });
    assert.equal(info.alignment, 'unknown');
    assert.equal(info.cli.builtAt, null);
    if (result.timedOut) assert.equal(info.cli.timedOut, true);
  }
  await writeFile(path.join(f.extension, 'package.json'), JSON.stringify({ publisher: 'singularityflow', name: 'singularity-flow-vscode', version: '9.9.9' }));
  const skew = await aboutBuilds({ ...f.options, extensionPath: f.extension });
  assert.equal(skew.alignment, 'mismatch', 'extension/package and bundled engine versions must agree');
});

test('multiple installed extensions and invalid receipts never pretend to identify a loaded window', async t => {
  const f = await fixture(t);
  const second = `${f.extension}-other-platform`;
  await cp(f.extension, second, { recursive: true });
  await writeFile(path.join(path.dirname(f.extension), 'extensions.json'), JSON.stringify([f.extension, second].map(directory => ({
    identifier: { id: 'singularityflow.singularity-flow-vscode' }, relativeLocation: path.basename(directory)
  }))));
  await mkdir(path.join(f.root, '.singularity-flow/installations'), { recursive: true });
  await writeFile(path.join(f.root, '.singularity-flow/installations/current.json'), '{unreadable JSON');
  const info = await aboutBuilds(f.options);
  assert.equal(info.vscode.length, 2);
  assert.equal(info.receipt.status, 'invalid');
  assert.ok(info.receipt.reason);
  assert.ok(info.warnings.some(warning => /cannot determine which VS Code window/.test(warning)));
  const selected = await aboutBuilds({ ...f.options, extensionPath: second });
  assert.equal(selected.vscode.length, 1);
  assert.equal(selected.vscode[0].path, second);
});

test('legacy receipt diagnostics give the automatic install route without changing metadata', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, '.singularity-flow/installations');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'current.json');
  const bytes = '{"schemaVersion":1,"status":"complete","version":"0.9.0"}\n';
  await writeFile(file, bytes);
  const info = await aboutBuilds({ ...f.options, extensionPath: f.extension });
  assert.equal(info.receipt.status, 'invalid');
  assert.match(info.receipt.reason, /full \.\/install\.sh/);
  assert.match(info.receipt.reason, /automatically.*upgrades/);
  assert.doesNotMatch(info.receipt.reason, /archival reader/);
  assert.match(aboutBuildsMarkdown(info), /automatically.*upgrades/);
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(isAboutInfo(info), true);
});

test('About UI renders loaded-window identity separately and escapes metadata and diagnostics', async t => {
  const f = await fixture(t);
  const info = await aboutBuilds({ ...f.options, extensionPath: f.extension });
  const html = aboutHtml(info, { version: '0.9.0', build: 'abc 2026-10-17T12:00Z', editorVersion: '1.90.0', reloadRequired: true }, '<script>bad</script>');
  assert.match(html, /Loaded UI build/);
  assert.match(html, /2026-10-17T12:00Z/);
  assert.match(html, /2026-10-18T01:02:03/);
  assert.match(html, /CLI on PATH/);
  assert.match(html, /Reload VS Code/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  for (const invalid of [null, {}, { ...info, vscode: [null] }, { ...info, warnings: [{}] },
    { ...info, alignment: 'invented' }, { ...info, cli: { ...info.cli, version: {} } }]) assert.equal(isAboutInfo(invalid), false);
});

test('shell About and standalone shortcut render the table and provide structured JSON outside a repository', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const shortcut = fileURLToPath(new URL('../bin/sflow-about.mjs', import.meta.url));
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, PATH: f.root,
    SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off' };
  const git = path.join(f.root, process.platform === 'win32' ? 'git.cmd' : 'git');
  await writeFile(git, process.platform === 'win32'
    ? '@echo called>>"%USERPROFILE%\\git-called"\r\n@exit /b 99\r\n'
    : '#!/bin/sh\nprintf called >> "$HOME/git-called"\nexit 99\n');
  await chmod(git, 0o755);
  for (const [entry, args] of [[cli, ['about', '--json']], [shortcut, ['--json']]]) {
    const result = spawnSync(process.execPath, [entry, ...args, '--extension-path', f.extension], { cwd: f.root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(isAboutInfo(info), true);
    assert.match(info.markdown, /Build information/);
    assert.equal(info.vscode[0].builtAt, current.builtAt);
  }
  const text = spawnSync(process.execPath, [shortcut, '--markdown', '--extension-path', f.extension], { cwd: f.root, env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\| Surface \| Version \|/);
  assert.match(text.stdout, /VS Code extension/);
  const invalid = spawnSync(process.execPath, [cli, 'about', '--json', '--markdown'], { cwd: f.root, env, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  await assert.rejects(lstat(path.join(f.root, 'git-called')), { code: 'ENOENT' }, 'About must never probe Git');
});

test('About is contributed to the UI and the Copilot skill requires visible rendering', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'singularityFlow.about' && /Build Dates/.test(command.title)));
  const skill = await readFile(new URL('../plugin/skills/sflow-about/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /sflow-about --markdown/);
  assert.match(skill, /Render the build-information table visibly in Copilot/);
  assert.match(skill, /Do not initialize a repository/);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /registerCommand\('singularityFlow.about'/);
  assert.match(extension, /probe\(location.executable, \[location.cli, '--version'\]/);
  const sidebar = await readFile(new URL('../apps/vscode/src/views/sidebar.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /'help-tools':[^\n]*'about'/);
});
