#!/usr/bin/env node
/** Install the just-packed npm artifact into an isolated prefix and execute that installed CLI. */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformProcess } from '../src/platform-process.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, { cwd, env }) {
  const launch = resolvePlatformProcess(command, args, { environment: env });
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...launch.spawnOptions
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown failure')
      .trim().slice(-8_192);
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

async function regularFile(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Installed ${label} is missing or unsafe: ${file}`);
}

async function installedCommandShim(installRoot) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const command = path.join(installRoot, 'node_modules', '.bin', `singularity-flow${suffix}`);
  const info = await lstat(command).catch(() => null);
  if (!info || (!info.isFile() && !info.isSymbolicLink())) {
    throw new Error(`Installed npm command shim is missing or unsafe: ${command}`);
  }
  const resolved = await realpath(command).catch(() => null);
  const managedRoot = await realpath(installRoot);
  if (!resolved || (resolved !== managedRoot && !resolved.startsWith(`${managedRoot}${path.sep}`))) {
    throw new Error('Installed npm command shim resolves outside the isolated prefix.');
  }
  return command;
}

export async function runPackagedCliSmoke({ root = sourceRoot, tempRoot = os.tmpdir() } = {}) {
  const sandbox = await mkdtemp(path.join(tempRoot, 'sflow-packaged-cli-smoke-'));
  const artifacts = path.join(sandbox, 'artifacts');
  const installRoot = path.join(sandbox, 'consumer');
  const cache = path.join(sandbox, 'npm-cache');
  const npm = 'npm';
  const environment = { ...process.env, NPM_CONFIG_CACHE: cache };
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(installRoot, { recursive: true });
    await writeFile(path.join(installRoot, 'package.json'), '{"name":"sflow-release-smoke","private":true}\n');
    const packed = JSON.parse(run(npm, ['pack', '--json', '--pack-destination', artifacts], {
      cwd: root, env: environment
    }));
    const filename = packed?.[0]?.filename;
    if (typeof filename !== 'string' || path.basename(filename) !== filename) {
      throw new Error('npm pack did not return one safe artifact filename.');
    }
    const tarball = path.join(artifacts, filename);
    await regularFile(tarball, 'npm tarball');
    run(npm, [
      'install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund',
      '--package-lock=false', '--omit=dev', tarball
    ], { cwd: installRoot, env: environment });

    const installedRoot = path.join(installRoot, 'node_modules', 'singularity-flow');
    const installedManifestFile = path.join(installedRoot, 'package.json');
    const installedCli = path.join(installedRoot, 'bin', 'singularity-flow.mjs');
    await regularFile(installedManifestFile, 'package manifest');
    await regularFile(installedCli, 'CLI entry point');
    const [sourceManifest, installedManifest] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
      readFile(installedManifestFile, 'utf8').then(JSON.parse)
    ]);
    if (installedManifest.name !== 'singularity-flow' || installedManifest.version !== sourceManifest.version) {
      throw new Error(`Installed package identity is ${installedManifest.name}@${installedManifest.version}, expected singularity-flow@${sourceManifest.version}.`);
    }
    // Exercise the command surface npm actually exposes to users, including its `.cmd` wrapper on
    // Windows. Loading the JS entry directly would miss precisely the packaging/argv defect this
    // release smoke is intended to catch.
    const installedCommand = await installedCommandShim(installRoot);
    const version = run(installedCommand, ['--version'], {
      cwd: installRoot,
      env: {
        ...environment,
        HOME: path.join(sandbox, 'home'),
        USERPROFILE: path.join(sandbox, 'home')
      }
    }).trim();
    if (version !== sourceManifest.version) {
      throw new Error(`Installed CLI reports '${version || 'no version'}', expected '${sourceManifest.version}'.`);
    }
    return { package: `${installedManifest.name}@${installedManifest.version}`, version };
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPackagedCliSmoke().then((result) => {
    console.log(`Packaged CLI smoke passed: ${result.package}`);
  }).catch((error) => {
    console.error(`Packaged CLI smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
