#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  builderArtifactTemplate,
  combineDesktopReleaseFragments,
  createDesktopReleaseManifest,
  desktopArtifactNames,
  desktopReleaseDirectory,
  desktopVersionInfo,
  normalizeDesktopPlatform,
  parseDesktopReleaseArgs,
  publishDesktopReleaseToArtifactory,
  requiredDesktopBundlePaths,
  signingPlan,
  verifyDesktopReleaseDirectory,
  writeDesktopReleaseMetadata,
  assertReleaseTag
} from '../src/desktop-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopRoot = path.join(root, 'apps', 'desktop');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, { cwd = root, env = process.env, quiet = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error) throw new Error(`Unable to run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = quiet ? `\n${result.stdout || ''}${result.stderr || ''}`.trimEnd() : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.${detail}`);
  }
  return quiet ? result.stdout.trim() : '';
}

function git(args) {
  return run('git', args, { quiet: true });
}

async function preflight(options, platform = null) {
  const versionInfo = await desktopVersionInfo(root);
  assertReleaseTag(versionInfo.version, options.tag);
  const missing = requiredDesktopBundlePaths(root).filter((item) => !item.exists).map((item) => item.relative);
  if (missing.length) throw new Error(`Desktop bundle source is incomplete: ${missing.join(', ')}.`);
  const commit = git(['rev-parse', 'HEAD']);
  if (options.tag) {
    const tagCommit = git(['rev-list', '-n', '1', options.tag]);
    if (tagCommit !== commit) throw new Error(`Release tag ${options.tag} points to ${tagCommit.slice(0, 12)}, not current commit ${commit.slice(0, 12)}.`);
  }
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status && !options.allowDirty) throw new Error(`Desktop packaging requires a clean worktree. Commit the changes or pass --allow-dirty for a local test package.\n${status}`);
  if (options.releaseMode === 'official' && options.allowDirty) throw new Error('Official desktop packages cannot use --allow-dirty.');
  if (platform && ((platform === 'mac' && process.platform !== 'darwin') || (platform === 'win' && process.platform !== 'win32'))) {
    throw new Error(`${platform === 'mac' ? 'macOS' : 'Windows'} installers must be built on a ${platform === 'mac' ? 'macOS' : 'Windows'} host.`);
  }
  return { ...versionInfo, commit };
}

async function configureSigningEnvironment(platform, plan) {
  const env = { ...process.env };
  let temporaryDirectory = null;
  if (!plan.enabled) {
    env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    delete env.CSC_LINK;
    delete env.CSC_KEY_PASSWORD;
    delete env.MAC_CSC_LINK;
    delete env.MAC_CSC_KEY_PASSWORD;
    delete env.WIN_CSC_LINK;
    delete env.WIN_CSC_KEY_PASSWORD;
    delete env.APPLE_API_KEY;
    delete env.APPLE_API_KEY_B64;
    delete env.APPLE_API_KEY_ID;
    delete env.APPLE_API_ISSUER;
    return { env, cleanup: async () => {} };
  }
  if (platform === 'mac') {
    env.CSC_LINK = plan.environment.certificate;
    env.CSC_KEY_PASSWORD = plan.environment.password;
    if (process.env.APPLE_API_KEY_B64) {
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-apple-key-'));
      const keyFile = path.join(temporaryDirectory, 'AuthKey.p8');
      await writeFile(keyFile, Buffer.from(process.env.APPLE_API_KEY_B64, 'base64'), { mode: 0o600 });
      env.APPLE_API_KEY = keyFile;
    } else env.APPLE_API_KEY = process.env.APPLE_API_KEY;
  } else {
    env.WIN_CSC_LINK = plan.environment.certificate;
    env.WIN_CSC_KEY_PASSWORD = plan.environment.password;
  }
  return {
    env,
    cleanup: async () => { if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }); }
  };
}

async function assertBundleResources(platform, directory) {
  const resources = platform === 'mac'
    ? path.join(directory, 'mac-universal', 'Singularity Flow.app', 'Contents', 'Resources')
    : path.join(directory, 'win-unpacked', 'resources');
  const required = ['cli/bin/singularity-flow.mjs', 'cli/src/cli.mjs', 'cli/templates/workflow.yml', 'cli/plugin/plugin.json', 'cli/HELP.md', 'cli/node_modules/yaml/package.json', 'cli/package.json'];
  const missing = [];
  for (const item of required) {
    try { await access(path.join(resources, item)); } catch { missing.push(item); }
  }
  if (missing.length) throw new Error(`Packaged desktop CLI resources are missing: ${missing.join(', ')}.`);
}

function powershellSignature(file) {
  const script = '$signature = Get-AuthenticodeSignature -LiteralPath $args[0]; if ($signature.Status -ne "Valid") { Write-Error ("Invalid Authenticode status: " + $signature.Status); exit 1 }';
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, file]);
}

async function verifyPlatformPackage({ platform, directory, plan, version = null, requireUnpacked = true }) {
  const releaseVersion = version ?? (await desktopVersionInfo(root)).version;
  const names = desktopArtifactNames({ version: releaseVersion, platform, releaseMode: plan.releaseMode, signed: plan.signed });
  for (const name of names) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (!info?.isFile() || !info.size) throw new Error(`Expected desktop artifact was not produced: ${name}.`);
  }
  if (platform === 'mac') {
    const application = path.join(directory, 'mac-universal', 'Singularity Flow.app');
    const executable = path.join(application, 'Contents', 'MacOS', 'Singularity Flow');
    run('hdiutil', ['verify', path.join(directory, names.find((name) => name.endsWith('.dmg')))]);
    if (existsSync(executable)) {
      const architectures = run('lipo', ['-archs', executable], { quiet: true }).split(/\s+/).sort();
      if (!architectures.includes('arm64') || !architectures.includes('x86_64')) throw new Error(`macOS application is not universal: ${architectures.join(', ') || 'no architectures found'}.`);
    } else if (requireUnpacked) throw new Error(`Packaged macOS application is missing: ${application}.`);
    if (plan.signed) {
      if (!existsSync(application)) throw new Error('The signed macOS application bundle is unavailable for verification.');
      run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', application]);
      run('spctl', ['--assess', '--type', 'execute', '--verbose=2', application]);
      run('xcrun', ['stapler', 'validate', application]);
    }
  } else if (plan.signed) {
    powershellSignature(path.join(directory, names[0]));
  }
  if (requireUnpacked) await assertBundleResources(platform, directory);
  return names;
}

async function packageDesktop(options) {
  const platform = normalizeDesktopPlatform(options.platform);
  const information = await preflight(options, platform);
  const signing = signingPlan(platform, options.sign);
  const releaseMode = options.releaseMode;
  const directory = path.resolve(options.dir || desktopReleaseDirectory(root, information.version, releaseMode));
  const allowedRoot = path.resolve(root, 'apps', 'desktop', 'release');
  const relative = path.relative(allowedRoot, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Desktop output must stay under ${allowedRoot}.`);
  if (existsSync(directory)) {
    const entries = await readdir(directory);
    if (entries.length && !options.replace) throw new Error(`Desktop output directory is not empty: ${directory}. Use --replace to rebuild this exact version directory.`);
    if (entries.length) await rm(directory, { recursive: true });
  }
  await mkdir(directory, { recursive: true });
  if (options.sign === 'auto' && !signing.enabled) console.warn(`Signing credentials are incomplete; creating a visibly unsigned local ${platform === 'mac' ? 'DMG' : 'installer'}.`);
  if (!options.skipTests) {
    run(npm, ['test']);
    run(npm, ['run', 'check']);
  }
  run(npm, ['run', 'desktop:build']);
  const configured = await configureSigningEnvironment(platform, signing);
  const plan = { ...signing, releaseMode };
  const artifactName = builderArtifactTemplate({ version: information.version, platform, releaseMode, signed: signing.signed });
  const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  const args = [
    platform === 'mac' ? '--mac' : '--win',
    platform === 'mac' ? '--universal' : '--x64',
    '--publish', 'never',
    `--config.directories.output=${directory}`,
    `--config.artifactName=${artifactName}`,
    `--config.forceCodeSigning=${options.sign === 'required' ? 'true' : 'false'}`
  ];
  if (platform === 'mac') {
    args.push(`--config.mac.notarize=${signing.enabled ? 'true' : 'false'}`);
    args.push(`--config.mac.hardenedRuntime=${signing.enabled ? 'true' : 'false'}`);
  }
  try {
    run(builder, args, { cwd: desktopRoot, env: configured.env });
  } finally {
    await configured.cleanup();
  }
  await verifyPlatformPackage({ platform, directory, plan, version: information.version });
  const manifest = await createDesktopReleaseManifest({
    directory,
    version: information.version,
    commit: information.commit,
    electronVersion: information.electronVersion,
    platform,
    releaseMode,
    signed: signing.signed,
    notarized: signing.notarized,
    verified: true
  });
  await writeDesktopReleaseMetadata(directory, manifest);
  await verifyDesktopReleaseDirectory(directory, { requireOfficial: releaseMode === 'official' });
  console.log(`Desktop ${platform === 'mac' ? 'macOS' : 'Windows'} package ready: ${directory}`);
  for (const artifact of manifest.artifacts) console.log(`- ${artifact.name} (${artifact.bytes} bytes, sha256 ${artifact.sha256})`);
}

async function verifyAction(options) {
  if (!options.dir) throw new Error('verify requires --dir <release-directory>.');
  const directory = path.resolve(options.dir);
  const manifest = await verifyDesktopReleaseDirectory(directory, { requireOfficial: options.releaseMode === 'official' });
  for (const platform of [...new Set(manifest.artifacts.map((item) => item.platform))]) {
    const signed = manifest.artifacts.filter((item) => item.platform === platform).every((item) => item.signed);
    const notarized = platform === 'mac' && manifest.artifacts.filter((item) => item.platform === platform).every((item) => item.notarized);
    const nativeHost = (platform === 'mac' && process.platform === 'darwin') || (platform === 'win' && process.platform === 'win32');
    if (nativeHost) await verifyPlatformPackage({ platform, directory, plan: { releaseMode: manifest.releaseMode, signed, notarized }, version: manifest.version, requireUnpacked: false });
    else console.warn(`Verified hashes for ${platform} artifacts; native signature verification requires a ${platform === 'mac' ? 'macOS' : 'Windows'} host.`);
  }
  console.log(`Verified ${manifest.artifacts.length} desktop artifact(s) for ${manifest.version}.`);
}

async function main() {
  const options = parseDesktopReleaseArgs(process.argv.slice(2));
  if (options.action === 'package') return packageDesktop(options);
  if (options.action === 'preflight') {
    const platform = normalizeDesktopPlatform(options.platform);
    const information = await preflight(options, platform);
    signingPlan(platform, options.sign);
    console.log(`Desktop release preflight passed for ${information.version} (${platform}, ${options.sign}).`);
    return;
  }
  if (options.action === 'verify') return verifyAction(options);
  if (options.action === 'combine') {
    if (!options.dir) throw new Error('combine requires --dir <release-directory>.');
    const manifest = await combineDesktopReleaseFragments({ directory: path.resolve(options.dir), inputs: options.inputs });
    console.log(`Combined ${manifest.artifacts.length} desktop artifacts in ${path.resolve(options.dir)}.`);
    return;
  }
  if (options.action === 'publish-artifactory') {
    if (!options.dir) throw new Error('publish-artifactory requires --dir <official-release-directory>.');
    const result = await publishDesktopReleaseToArtifactory(path.resolve(options.dir), { dryRun: options.dryRun, replace: options.replace });
    console.log(`${options.dryRun ? 'Would publish' : 'Published'} ${result.uploads.length} files for ${result.version} to Artifactory repository ${result.repository}.`);
    for (const upload of result.uploads) console.log(`- ${upload.name}: ${upload.url}`);
  }
}

main().catch((error) => {
  console.error(`Desktop release failed: ${error.message}`);
  process.exitCode = 1;
});
