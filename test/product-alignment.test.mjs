/**
 * One build on every product surface. Every test runs against a fake machine: a private HOME with
 * a real installation receipt and real content-addressed tarball and VSIX artifacts, and an
 * injected command runner. No real npm, VS Code or Copilot command is ever run.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { stampBuildInfo } from '../src/build-info-stamp.mjs';
import { versionLine } from '../src/build-info.mjs';
import { runningStampedBuild } from '../src/commands/product.mjs';
import {
  alignBeforeFirstMutation, applyProductAlignment, compareBuilds, observeProductSurfaces, parseBuildLine,
  parseStampedBuildInfo, planProductAlignment, recordedAlignment, stampedBuildLine
} from '../src/product-alignment.mjs';
import { productAlignmentDue } from '../src/product-alignment-gate.mjs';
import { VERSION } from '../src/version.mjs';
import {
  acquireActivationLease, inspectNpmTarballBuildSources, inspectVsixBuildSources,
  releaseActivationLease
} from '../scripts/install-staged-artifacts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUILD_INFO_SOURCE = await readFile(path.join(here, '..', 'src', 'build-info.mjs'), 'utf8');
const VERSION_SOURCE = `export const VERSION = '${VERSION}';\n`;
const EXTENSION = 'singularityflow.singularity-flow-vscode';

const stamp = (letter, builtAt) => Object.freeze({
  commit: letter.repeat(40), sourceSha256: null, branch: null, dirty: false, builtAt
});
const OLDER = stamp('a', '2026-09-01T00:00:00.000Z');
const INSTALLED = stamp('b', '2026-09-20T00:00:00.000Z');
const NEWER = stamp('c', '2026-09-27T00:00:00.000Z');
const DEVELOPMENT = Object.freeze({ commit: null, sourceSha256: null, branch: null, dirty: null, builtAt: null });
const line = (info) => versionLine(info);

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function tarball(entries) {
  const parts = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    parts.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

/** A stored (uncompressed) ZIP with several entries, enough for the VSIX reader. */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const body = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, body);
    centrals.push(central, filename);
    offset += local.length + filename.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

const sourcesFor = (info) => ({
  version: VERSION_SOURCE, buildInfo: stampBuildInfo(BUILD_INFO_SOURCE, info)
});

async function retain(installations, kind, bytes, extra) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(installations, 'versions', 'sha256', digest);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, kind === 'tarball' ? 'singularity-flow.tgz' : 'singularity-flow.vsix');
  await writeFile(file, bytes);
  return { path: file, sha256: `sha256:${digest}`, version: VERSION, ...extra };
}

/** Synchronous, like the real command runner the fake `code --install-extension` stands in for. */
function writeExtension(directory, info) {
  const sources = sourcesFor(info);
  mkdirSync(path.join(directory, 'cli', 'src'), { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    publisher: 'singularityflow', name: 'singularity-flow-vscode', version: VERSION
  }));
  writeFileSync(path.join(directory, 'cli', 'src', 'version.mjs'), sources.version);
  writeFileSync(path.join(directory, 'cli', 'src', 'build-info.mjs'), sources.buildInfo);
  writeFileSync(path.join(directory, 'cli', 'package.json'), JSON.stringify({ name: 'singularity-flow', version: VERSION }));
}

/**
 * A machine whose receipt installed `installed` for the CLI and `installedVsix` for VS Code, and
 * whose surfaces currently run `cli`, `vscode`, and a Copilot plugin that is or is not verified.
 */
async function machine(t, {
  installed = INSTALLED, installedVsix = installed, cli = installed, vscode = installed,
  copilotVerified = true, receipt = true, surfaces = { cli: true, vscode: true, copilot: true, telemetry: false, manifest: true },
  status = 'complete'
} = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-product-alignment-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installations = path.join(home, '.singularity-flow', 'installations');
  await mkdir(installations, { recursive: true });
  const cliSources = sourcesFor(installed);
  const vsixSources = sourcesFor(installedVsix);
  const artifacts = {
    tarball: await retain(installations, 'tarball', tarball({
      'package/package.json': JSON.stringify({ name: 'singularity-flow', version: VERSION }),
      'package/src/version.mjs': cliSources.version,
      'package/src/build-info.mjs': cliSources.buildInfo
    }), { package: 'singularity-flow' }),
    vsix: await retain(installations, 'vsix', storedZip({
      'extension/package.json': JSON.stringify({
        publisher: 'singularityflow', name: 'singularity-flow-vscode', version: VERSION
      }),
      'extension/cli/src/version.mjs': vsixSources.version,
      'extension/cli/src/build-info.mjs': vsixSources.buildInfo
    }), { extensionId: EXTENSION })
  };
  if (receipt) {
    await writeFile(path.join(installations, 'current.json'), JSON.stringify({
      schemaVersion: 2, status, version: VERSION, build: { cli: line(installed) },
      checkout: path.join(home, 'checkout'), source: null, artifacts, surfaces,
      workspaceRefresh: 'skipped', activation: null, installedAt: '2026-09-20T00:00:00.000Z'
    }, null, 2));
  }
  const extensionDirectory = path.join(home, '.vscode', 'extensions', `${EXTENSION}-${VERSION}`);
  if (vscode) writeExtension(extensionDirectory, vscode);
  const state = {
    cli, vscode, copilotVerified, copilotInstalled: true, calls: [],
    npmInstallBuild: installed, codeInstallBuild: installedVsix, pluginInstallFixes: true
  };
  const environment = { SINGULARITY_FLOW_COPILOT_SKILLS_DIR: path.join(home, 'skills') };
  const execute = (command, args, options = {}) => {
    state.calls.push([command, ...args]);
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    const joined = [command, ...args].join(' ');
    if (joined.startsWith('npm list --global')) {
      return state.cli
        ? ok(JSON.stringify({ dependencies: { 'singularity-flow': { version: VERSION } } }))
        : { status: 1, stdout: '{}', stderr: '' };
    }
    if (joined === 'npm config get registry') return ok('https://registry.example.test/npm\n');
    if (command === 'npm' && args[0] === 'install') {
      assert.equal(args[2], artifacts.tarball.path, 'the CLI is installed only from its retained artifact');
      state.cli = state.npmInstallBuild;
      return ok();
    }
    if (joined === 'singularity-flow --build') {
      return state.cli ? ok(`${line(state.cli)}\n`) : { status: 127, stdout: '', stderr: 'not found' };
    }
    if (joined === 'singularity-flow plugin verify --json') {
      return state.copilotVerified ? ok('{}') : { status: 1, stdout: '', stderr: 'direct skill content is stale' };
    }
    if (joined === 'singularity-flow plugin install') {
      state.copilotVerified = state.pluginInstallFixes;
      return ok();
    }
    if (joined === 'copilot plugin list') return ok(state.copilotInstalled ? 'singularity-flow\n' : '');
    if (command === 'singularity-flow' && args[0] === 'next') {
      state.handedOff = { args, env: options.env, stdio: options.stdio, build: state.cli };
      return { status: 3, stdout: '', stderr: '' };
    }
    if (joined === 'code --list-extensions --show-versions') {
      return ok(state.vscode ? `${EXTENSION}@${VERSION}\n` : '');
    }
    if (command === 'code' && args[0] === '--install-extension') {
      assert.equal(args[1], artifacts.vsix.path, 'VS Code is installed only from its retained artifact');
      writeExtension(extensionDirectory, state.codeInstallBuild);
      state.vscode = state.codeInstallBuild;
      return ok();
    }
    throw new Error(`unexpected command in the fake machine: ${joined} ${JSON.stringify(options.env ?? {}).length}`);
  };
  const exists = (command) => ['npm', 'code', 'copilot', 'node'].includes(command);
  const options = { execute, exists, homeDirectory: home, environment };
  return { home, installations, artifacts, state, options, extensionDirectory };
}

const INSTALL_COMMANDS = (calls) => calls.filter(([command, ...args]) =>
  (command === 'npm' && args[0] === 'install') || (command === 'code' && args[0] === '--install-extension')
  || (command === 'singularity-flow' && args.join(' ') === 'plugin install'));

async function observedPlan(item) {
  return planProductAlignment(await observeProductSurfaces(item.options));
}

const surface = (plan, id) => plan.surfaces.find((entry) => entry.id === id);

test('build stamps parse as the exact inverse of the stamper, and artifacts report their own build', async (t) => {
  for (const info of [INSTALLED, { ...INSTALLED, branch: 'main', dirty: true }, DEVELOPMENT,
    { commit: null, sourceSha256: `sha256:${'d'.repeat(64)}`, branch: null, dirty: null, builtAt: '2026-09-21T00:00:00.000Z' }]) {
    const source = stampBuildInfo(BUILD_INFO_SOURCE, info);
    assert.deepEqual(parseStampedBuildInfo(source), info);
    assert.equal(stampedBuildLine(VERSION_SOURCE, source).line, line(info));
  }
  assert.equal(parseStampedBuildInfo(BUILD_INFO_SOURCE.replace('commit: null', 'commit: someVariable')), null,
    'a value that is not a literal the stamper writes is refused, not guessed');
  assert.equal(stampedBuildLine(VERSION_SOURCE, stampBuildInfo(BUILD_INFO_SOURCE, DEVELOPMENT)).stamped, false);

  const item = await machine(t);
  const cli = await inspectNpmTarballBuildSources(item.artifacts.tarball.path);
  const vsix = await inspectVsixBuildSources(item.artifacts.vsix.path);
  assert.equal(stampedBuildLine(cli.versionSource, cli.buildInfoSource).line, line(INSTALLED));
  assert.equal(stampedBuildLine(vsix.versionSource, vsix.buildInfoSource).line, line(INSTALLED));
  assert.equal(runningStampedBuild(DEVELOPMENT), null, 'a development checkout never runs an alignment pass');
  assert.equal(runningStampedBuild(INSTALLED), line(INSTALLED));
});

test('builds order by their stamp instant, and only stamped builds can be ordered', () => {
  assert.equal(compareBuilds(parseBuildLine(line(OLDER)), parseBuildLine(line(INSTALLED))), -1);
  assert.equal(compareBuilds(parseBuildLine(line(NEWER)), parseBuildLine(line(INSTALLED))), 1);
  assert.equal(compareBuilds(parseBuildLine(line(INSTALLED)), parseBuildLine(line(INSTALLED))), 0);
  assert.equal(compareBuilds(parseBuildLine(line(DEVELOPMENT)), parseBuildLine(line(INSTALLED))), null);
  assert.equal(parseBuildLine('not a build line'), null);
});

test('a machine on the installed build everywhere is aligned and alignment does nothing', async (t) => {
  const item = await machine(t);
  const plan = await observedPlan(item);
  assert.equal(plan.verdict, 'aligned');
  assert.deepEqual(plan.surfaces.map((entry) => [entry.id, entry.state]),
    [['vscode', 'aligned'], ['cli', 'aligned'], ['copilot', 'aligned']]);
  const result = await applyProductAlignment({ ...item.options, runningBuild: line(INSTALLED) });
  assert.equal(result.status, 'aligned');
  assert.deepEqual(result.steps, []);
  assert.deepEqual(INSTALL_COMMANDS(item.state.calls), []);
  assert.equal((await recordedAlignment({ homeDirectory: item.home, runningBuild: line(INSTALLED) })).outcome,
    'aligned', 'the pass is recorded so the build does not repeat it');
});

test('drifted surfaces are brought back to the installed build from its retained bytes', async (t) => {
  const item = await machine(t, { cli: OLDER, vscode: OLDER, copilotVerified: false });
  const plan = await observedPlan(item);
  assert.equal(plan.verdict, 'repairable');
  assert.deepEqual(plan.actions.map((entry) => entry.kind),
    ['install-vscode', 'install-cli', 'copilot-plugin-install'],
    'VS Code first, the CLI before the Copilot plugin it installs');
  const result = await applyProductAlignment({ ...item.options, runningBuild: line(INSTALLED) });
  assert.equal(result.status, 'aligned', JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map((entry) => [entry.surface, entry.outcome]),
    [['vscode', 'aligned'], ['cli', 'aligned'], ['copilot', 'aligned']]);
  assert.equal(item.state.cli, INSTALLED);
  assert.equal(item.state.vscode, INSTALLED);
  assert.equal(item.state.copilotVerified, true);
  assert.equal((await observedPlan(item)).verdict, 'aligned');
  assert.equal(await lstat(path.join(item.installations, 'activation-current.json.lock')).catch(() => null), null,
    'the installer lease is released');
});

test('a surface newer than the installed build is never downgraded', async (t) => {
  const item = await machine(t, { vscode: NEWER });
  const plan = await observedPlan(item);
  assert.equal(surface(plan, 'vscode').state, 'held-newer');
  assert.equal(plan.verdict, 'split');
  assert.deepEqual(plan.actions, []);
  assert.ok(plan.next.some((entry) => /full install/u.test(entry.command)));
  const result = await applyProductAlignment({ ...item.options, runningBuild: line(INSTALLED) });
  assert.deepEqual(result.steps, []);
  assert.equal(item.state.vscode, NEWER);
});

test('a development checkout is never replaced, and Copilot follows it', async (t) => {
  const item = await machine(t, { cli: DEVELOPMENT, copilotVerified: false });
  const plan = await observedPlan(item);
  assert.equal(surface(plan, 'cli').state, 'held-development');
  assert.equal(surface(plan, 'copilot').state, 'held-development');
  assert.deepEqual(plan.actions, []);
});

test('a partial install that left VS Code on an older build is reported with one full-install step', async (t) => {
  const item = await machine(t, { installedVsix: OLDER, vscode: OLDER, status: 'partial-by-request' });
  const plan = await observedPlan(item);
  assert.equal(surface(plan, 'vscode').state, 'aligned', 'VS Code runs the build its receipt retained');
  assert.equal(plan.verdict, 'split');
  assert.deepEqual(plan.split, { cli: line(INSTALLED), vscode: line(OLDER) });
  assert.match(plan.next.at(-1).command, new RegExp(path.join(item.home, 'checkout').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
});

test('retained bytes that no longer match their digest are never installed', async (t) => {
  const item = await machine(t, { cli: OLDER });
  await writeFile(item.artifacts.tarball.path, Buffer.from('tampered'));
  const plan = await observedPlan(item);
  assert.equal(surface(plan, 'cli').state, 'unverifiable');
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.verdict, 'split');
});

test('a machine no installer recorded has nothing to align and writes nothing', async (t) => {
  const item = await machine(t, { receipt: false });
  const result = await applyProductAlignment({ ...item.options, runningBuild: line(INSTALLED) });
  assert.equal(result.status, 'no-receipt');
  assert.equal(await recordedAlignment({ homeDirectory: item.home, runningBuild: line(INSTALLED) }), null);
});

test('alignment never runs while an install or its recovery owns the surfaces', async (t) => {
  const pending = await machine(t, { cli: OLDER });
  await writeFile(path.join(pending.installations, 'distribution-install-pending.json'), '{}');
  await assert.rejects(applyProductAlignment(pending.options), { code: 'PRODUCT_ALIGNMENT_INSTALL_RECOVERY_PENDING' });
  assert.equal(pending.state.cli, OLDER);

  const active = await machine(t, { cli: OLDER });
  const journal = path.join(active.installations, 'activation-current.json');
  const lease = await acquireActivationLease({ journal, checkout: active.home, mode: 'create' });
  t.after(() => releaseActivationLease({ journal, operationId: lease.operationId }));
  assert.ok((await lstat(`${journal}.lock`)).isDirectory(), 'the lease another install holds is the one alignment checks');
  await assert.rejects(applyProductAlignment(active.options), { code: 'PRODUCT_ALIGNMENT_INSTALL_ACTIVE' });
  assert.deepEqual(INSTALL_COMMANDS(active.state.calls), []);
});

test('a step whose result cannot be verified stops the pass before any later surface', async (t) => {
  const item = await machine(t, { cli: OLDER, copilotVerified: false });
  item.state.npmInstallBuild = OLDER;
  const result = await applyProductAlignment({ ...item.options, runningBuild: line(INSTALLED) });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.steps.map((entry) => [entry.surface, entry.outcome]), [['cli', 'failed']]);
  assert.match(result.steps[0].reason, /reports .* after installing/u);
  assert.ok(!item.state.calls.some((call) => call.join(' ') === 'singularity-flow plugin install'),
    'Copilot is not reinstalled from a CLI that did not verify');
  assert.equal((await recordedAlignment({ homeDirectory: item.home, runningBuild: line(INSTALLED) })).outcome, 'failed');
});

test('the VS Code launcher a window passes is used when code is not on PATH', async (t) => {
  const item = await machine(t, { vscode: OLDER });
  const launcher = path.join(item.home, 'bin', 'code');
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(launcher, '#!/bin/sh\n');
  const seen = [];
  const options = {
    ...item.options,
    environment: { ...item.options.environment, SINGULARITY_FLOW_CODE_CLI: launcher },
    exists: (command) => command !== 'code' && item.options.exists(command),
    execute: (command, args, rest) => {
      seen.push(command);
      return item.options.execute(command === launcher ? 'code' : command, args, rest);
    }
  };
  const result = await applyProductAlignment({ ...options, runningBuild: line(INSTALLED) });
  assert.equal(result.status, 'aligned', JSON.stringify(result.steps));
  assert.ok(seen.includes(launcher));
  assert.ok(!seen.includes('code'));
});

test('only a stamped build with an installed receipt and no recorded pass owes the machine a pass', async (t) => {
  const item = await machine(t);
  const due = (overrides = {}) => productAlignmentDue({
    command: 'next', classification: 'mutation', homeDirectory: item.home, environment: {}, info: INSTALLED,
    ...overrides
  });
  assert.equal(await due(), line(INSTALLED));
  assert.equal(await due({ classification: 'read' }), null, 'reads never align');
  assert.equal(await due({ command: 'plugin' }), null, 'alignment never re-enters a command it runs');
  assert.equal(await due({ environment: { SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off' } }), null);
  assert.equal(await due({ info: DEVELOPMENT }), null);
  const bare = await machine(t, { receipt: false });
  assert.equal(await due({ homeDirectory: bare.home }), null);
  await applyProductAlignment({ ...item.options, runningBuild: line(INSTALLED) });
  assert.equal(await due(), null, 'a recorded pass is not repeated by the same build');
  assert.equal(await due({ info: NEWER }), line(NEWER), 'a different build owes its own pass');
});

test('an outdated running CLI aligns itself and hands the command to the installed build', async (t) => {
  const item = await machine(t, { cli: OLDER });
  const lines = [];
  const result = await alignBeforeFirstMutation({
    ...item.options, runningBuild: line(OLDER), argv: ['next', '--json'], write: (entry) => lines.push(entry)
  });
  assert.deepEqual(result, { status: 'handed-off', exitCode: 3 });
  assert.deepEqual(item.state.handedOff.args, ['next', '--json']);
  assert.equal(item.state.handedOff.build, INSTALLED, 'the command runs on the build just installed');
  assert.equal(item.state.handedOff.stdio, 'inherit');
  assert.equal(item.state.handedOff.env.SINGULARITY_FLOW_PRODUCT_ALIGNMENT, 'off', 'the handed-off command cannot loop');
  assert.ok(lines.some((entry) => /continuing this command on the newly aligned build/u.test(entry)));
});

test('a first-mutation pass that aligns another surface lets the command continue', async (t) => {
  const item = await machine(t, { vscode: OLDER });
  const result = await alignBeforeFirstMutation({
    ...item.options, runningBuild: line(INSTALLED), argv: ['next'], write: () => {}
  });
  assert.deepEqual(result, { status: 'aligned' });
  assert.equal(item.state.handedOff, undefined);
  assert.equal(item.state.vscode, INSTALLED);
});

test('a first-mutation pass never fails the command it precedes', async (t) => {
  const failing = await machine(t, { cli: OLDER });
  failing.state.npmInstallBuild = OLDER;
  const lines = [];
  assert.deepEqual(await alignBeforeFirstMutation({
    ...failing.options, runningBuild: line(INSTALLED), argv: ['next'], write: (entry) => lines.push(entry)
  }), { status: 'failed' });
  assert.ok(lines.some((entry) => /Retry with: singularity-flow product align/u.test(entry)));

  const busy = await machine(t, { cli: OLDER });
  const journal = path.join(busy.installations, 'activation-current.json');
  const lease = await acquireActivationLease({ journal, checkout: busy.home, mode: 'create' });
  t.after(() => releaseActivationLease({ journal, operationId: lease.operationId }));
  const skipped = await alignBeforeFirstMutation({
    ...busy.options, runningBuild: line(INSTALLED), argv: ['next'], write: () => {}
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(await recordedAlignment({ homeDirectory: busy.home, runningBuild: line(INSTALLED) }), null,
    'a pass an install pre-empted is not recorded, so the next mutation retries it');
});

test('a development host\'s extension checkout is never replaced by the installed VSIX', async (t) => {
  const item = await machine(t, { vscode: OLDER });
  const checkout = path.join(item.home, 'checkout', 'apps', 'vscode');
  await mkdir(checkout, { recursive: true });
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({
    publisher: 'singularityflow', name: 'singularity-flow-vscode', version: VERSION
  }));
  const plan = planProductAlignment(await observeProductSurfaces({ ...item.options, extensionPath: checkout }));
  assert.equal(surface(plan, 'vscode').state, 'held-development');
  assert.ok(!plan.actions.some((entry) => entry.surface === 'vscode'));
});

