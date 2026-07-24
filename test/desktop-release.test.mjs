import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertReleaseTag,
  builderArtifactTemplate,
  combineDesktopReleaseFragments,
  createDesktopReleaseManifest,
  desktopArtifactNames,
  desktopVersionInfo,
  normalizeDesktopPlatform,
  parseDesktopReleaseArgs,
  publishDesktopReleaseToArtifactory,
  signingPlan,
  verifyDesktopReleaseDirectory,
  writeDesktopReleaseMetadata
} from '../src/desktop-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function temporaryDirectory(prefix = 'sflow-desktop-release-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function releaseFixture({ platform = 'mac', releaseMode = 'official', signed = true, version = '0.8.0', commit = 'a'.repeat(40) } = {}) {
  const directory = await temporaryDirectory();
  const names = desktopArtifactNames({ version, platform, releaseMode, signed });
  for (const name of names) await writeFile(path.join(directory, name), `${platform}:${name}\n`);
  const manifest = await createDesktopReleaseManifest({
    directory,
    version,
    commit,
    electronVersion: '43.1.1',
    platform,
    releaseMode,
    signed,
    notarized: platform === 'mac' && signed,
    builtAt: '2026-07-23T00:00:00.000Z',
    nodeVersion: 'v22.14.0'
  });
  await writeDesktopReleaseMetadata(directory, manifest);
  return { directory, manifest, names };
}

test('desktop release arguments are strict and preserve safe defaults', () => {
  assert.deepEqual(parseDesktopReleaseArgs([]), {
    action: 'package', platform: 'current', sign: 'auto', releaseMode: 'local', dir: null, tag: null, inputs: [],
    allowDirty: false, dryRun: false, replace: false, skipTests: false
  });
  const parsed = parseDesktopReleaseArgs(['combine', '--dir', 'out', '--input=a.json', '--input', 'b.json', '--replace']);
  assert.equal(parsed.action, 'combine');
  assert.equal(parsed.dir, 'out');
  assert.deepEqual(parsed.inputs, ['a.json', 'b.json']);
  assert.equal(parsed.replace, true);
  assert.throws(() => parseDesktopReleaseArgs(['package', '--platform', 'linux']), /current, mac, or win/);
  assert.throws(() => parseDesktopReleaseArgs(['package', '--release-mode', 'official']), /require --sign required/);
  assert.throws(() => parseDesktopReleaseArgs(['unknown']), /Unknown desktop release action/);
});

test('desktop platform and artifact names are deterministic', () => {
  assert.equal(normalizeDesktopPlatform('current', 'darwin'), 'mac');
  assert.equal(normalizeDesktopPlatform('current', 'win32'), 'win');
  assert.throws(() => normalizeDesktopPlatform('current', 'linux'), /platform-specific CI runner/);
  assert.deepEqual(desktopArtifactNames({ version: '0.8.0', platform: 'mac', signed: false }), [
    'singularity-flow-desktop-0.8.0-macos-universal-unsigned.dmg',
    'singularity-flow-desktop-0.8.0-macos-universal-unsigned.zip'
  ]);
  assert.deepEqual(desktopArtifactNames({ version: '0.8.0', platform: 'win', releaseMode: 'official', signed: true }), [
    'singularity-flow-desktop-0.8.0-windows-x64-setup.exe'
  ]);
  assert.equal(builderArtifactTemplate({ version: '0.8.0', platform: 'mac', releaseMode: 'official', signed: true }), 'singularity-flow-desktop-0.8.0-macos-universal.${ext}');
  assert.throws(() => desktopArtifactNames({ version: '0.8.0', platform: 'mac', releaseMode: 'official', signed: false }), /must be signed/);
});

test('signing modes distinguish local fallback from required official credentials', () => {
  const empty = signingPlan('mac', 'auto', {});
  assert.equal(empty.enabled, false);
  assert.ok(empty.missing.includes('APPLE_API_KEY_ID'));
  assert.throws(() => signingPlan('mac', 'required', {}), /macOS signing\/notarization.*missing/);
  const mac = signingPlan('mac', 'required', {
    MAC_CSC_LINK: 'certificate', MAC_CSC_KEY_PASSWORD: 'password', APPLE_API_KEY_B64: 'key', APPLE_API_KEY_ID: 'id', APPLE_API_ISSUER: 'issuer'
  });
  assert.equal(mac.signed, true);
  assert.equal(mac.notarized, true);
  const windows = signingPlan('win', 'required', { WIN_CSC_LINK: 'certificate', WIN_CSC_KEY_PASSWORD: 'password' });
  assert.equal(windows.signed, true);
  assert.equal(windows.notarized, false);
});

test('desktop versions match across packages, lock, plugin, and marketplace', async () => {
  const information = await desktopVersionInfo(root);
  assert.equal(information.version, '0.9.0');
  assert.equal(information.electronVersion, '43.1.1');
  assert.doesNotThrow(() => assertReleaseTag('0.8.0', 'v0.8.0'));
  assert.throws(() => assertReleaseTag('0.8.0', 'v0.8.1'), /does not match/);
});

test('release metadata verifies exact bytes and rejects tampering', async () => {
  const fixture = await releaseFixture();
  const verified = await verifyDesktopReleaseDirectory(fixture.directory, { requireOfficial: true });
  assert.equal(verified.artifacts.length, 2);
  assert.ok(verified.artifacts.every((artifact) => artifact.signed && artifact.notarized));
  await writeFile(path.join(fixture.directory, fixture.names[0]), 'tampered');
  await assert.rejects(() => verifyDesktopReleaseDirectory(fixture.directory, { requireOfficial: true }), /size mismatch|SHA-256 mismatch/);
});

test('combined release manifest preserves verified Mac and Windows artifacts', async () => {
  const mac = await releaseFixture({ platform: 'mac' });
  const windows = await releaseFixture({ platform: 'win' });
  const output = await temporaryDirectory('sflow-desktop-combined-');
  const combined = await combineDesktopReleaseFragments({
    directory: output,
    inputs: [path.join(mac.directory, 'release-manifest.json'), path.join(windows.directory, 'release-manifest.json')]
  });
  assert.equal(combined.artifacts.length, 3);
  assert.deepEqual([...new Set(combined.artifacts.map((artifact) => artifact.platform))].sort(), ['mac', 'win']);
  assert.equal((await verifyDesktopReleaseDirectory(output, { requireOfficial: true })).artifacts.length, 3);
});

test('Artifactory dry-run is network-free and normal upload refuses replacement', async () => {
  const fixture = await releaseFixture({ platform: 'win' });
  const env = {
    SINGULARITY_FLOW_ARTIFACTORY_BASE_URL: 'https://artifacts.example.test/artifactory/',
    SINGULARITY_FLOW_ARTIFACTORY_REPOSITORY: 'desktop-releases',
    SINGULARITY_FLOW_ARTIFACTORY_TOKEN: 'secret'
  };
  const dryRun = await publishDesktopReleaseToArtifactory(fixture.directory, {
    env,
    dryRun: true,
    fetchImpl: async () => { throw new Error('dry-run contacted the network'); }
  });
  assert.equal(dryRun.uploads.length, 3);
  assert.ok(dryRun.uploads.every((item) => item.url.startsWith('https://artifacts.example.test/artifactory/desktop-releases/singularity-flow-desktop/0.8.0/')));

  const calls = [];
  const uploaded = await publishDesktopReleaseToArtifactory(fixture.directory, {
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return options.method === 'HEAD' ? { ok: false, status: 404 } : { ok: true, status: 201 };
    }
  });
  assert.equal(uploaded.uploads.length, 3);
  assert.equal(calls.filter((call) => call.options.method === 'HEAD').length, 3);
  assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 3);
  assert.ok(calls.find((call) => call.options.method === 'PUT').options.headers['X-Checksum-Sha256']);

  await assert.rejects(() => publishDesktopReleaseToArtifactory(fixture.directory, {
    env,
    fetchImpl: async () => ({ ok: true, status: 200 })
  }), /already contains/);

  const local = await releaseFixture({ platform: 'win', releaseMode: 'local', signed: false });
  await assert.rejects(() => publishDesktopReleaseToArtifactory(local.directory, { env, dryRun: true }), /Only official/);
});

test('desktop builder configuration defines universal DMG and assisted NSIS installer', async () => {
  const desktop = JSON.parse(await readFile(path.join(root, 'apps/desktop/package.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const workflow = await readFile(path.join(root, '.github/workflows/desktop-release.yml'), 'utf8');
  assert.equal(desktop.build.appId, 'dev.singularityflow.desktop');
  assert.equal(desktop.build.win.icon, 'build/icon.ico');
  assert.deepEqual(desktop.build.mac.target.flatMap((target) => target.arch), ['universal', 'universal']);
  assert.equal(desktop.build.nsis.oneClick, false);
  assert.equal(desktop.build.nsis.perMachine, false);
  assert.equal(desktop.build.nsis.allowToChangeInstallationDirectory, true);
  assert.ok(desktop.build.dmg.contents.some((item) => item.path === '/Applications'));
  assert.ok(desktop.build.extraResources.some((item) => item.to === 'cli/DISTRIBUTION.md'));
  assert.match(packageJson.scripts['desktop:package:mac'], /desktop-release\.mjs package --platform mac/);
  assert.match(packageJson.scripts['desktop:package:win'], /desktop-release\.mjs package --platform win/);
  assert.match(workflow, /runs-on: macos-14/);
  assert.match(workflow, /runs-on: windows-2022/);
  assert.match(workflow, /gh release create .*--draft --verify-tag/);
  assert.match(workflow, /SINGULARITY_FLOW_ARTIFACTORY_TOKEN/);
});
