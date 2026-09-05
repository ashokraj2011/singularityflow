#!/usr/bin/env node
/** Install the just-packed npm artifact into an isolated prefix and execute that installed CLI. */
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
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
    const requiredSurfaces = [
      'src/comprehension/contracts.mjs',
      'src/commands/comprehension.mjs',
      'src/wel-junit5.mjs',
      'src/wel/WelJunitCatalog.java',
      'docs/CMP-ROADMAP.md',
      'docs/WEL-PENDING-WORK.md',
      'docs/adr/0014-cmp-observe-authority-boundary.md'
    ];
    for (const relative of requiredSurfaces) {
      await regularFile(path.join(installedRoot, relative), relative);
    }
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
    const privateHome = path.join(sandbox, 'home');
    await mkdir(privateHome, { recursive: true });
    const isolatedEnvironment = {
      ...environment,
      HOME: privateHome,
      USERPROFILE: privateHome,
      NODE_PATH: path.join(sandbox, 'no-node-path'),
      SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(privateHome, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(privateHome, 'active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(privateHome, 'leads.json')
    };
    delete isolatedEnvironment.NODE_OPTIONS;
    delete isolatedEnvironment.INIT_CWD;
    const version = run(installedCommand, ['--version'], {
      cwd: installRoot,
      env: isolatedEnvironment
    }).trim();
    if (version !== sourceManifest.version) {
      throw new Error(`Installed CLI reports '${version || 'no version'}', expected '${sourceManifest.version}'.`);
    }

    // Import the two feature surfaces from the installed package itself. This catches an omitted
    // transitive module and proves the WEL helper selection remains model-free without requiring a
    // JDK on the release host.
    const contractsUrl = pathToFileURL(path.join(installedRoot, 'src', 'comprehension', 'contracts.mjs')).href;
    const welUrl = pathToFileURL(path.join(installedRoot, 'src', 'wel-junit5.mjs')).href;
    const moduleProbe = JSON.parse(run(process.execPath, [
      '--input-type=module', '--eval', [
        `const cmp = await import(${JSON.stringify(contractsUrl)});`,
        `const wel = await import(${JSON.stringify(welUrl)});`,
        "const scope = wel.classifyJunit5SurefireCommandScope({ argv: ['mvn', 'test'] });",
        'console.log(JSON.stringify({',
        "  assurance: cmp.CMP_ASSURANCE_CLASSES.includes('unavailable'),",
        "  availability: cmp.CMP_AVAILABILITY_STATUSES.includes('degraded'),",
        "  refusal: cmp.CMP_REFUSAL_CODES.includes('CMP_STORY_CONTEXT_REQUIRED'),",
        "  diagnostic: cmp.CMP_DIAGNOSTIC_CODES.includes('CMP_BINDING_INVALID'),",
        "  wel: scope.status === 'complete' && scope.gaps.length === 0",
        '}));'
      ].join('\n')
    ], { cwd: installedRoot, env: isolatedEnvironment }).trim());
    requireCondition(Object.values(moduleProbe).every(Boolean),
      'the installed CMP/WEL contract probe was incomplete.');

    // Run a real CMP observation against a repository outside both the source checkout and the
    // installed package. Its before/after status proves the packaged command remains read-only.
    const repository = path.join(sandbox, 'repository');
    await mkdir(path.join(repository, 'singularity'), { recursive: true });
    run('git', ['init', '-q', '-b', 'main'], { cwd: repository, env: isolatedEnvironment });
    run('git', ['config', 'user.name', 'Packaged CMP Tester'], { cwd: repository, env: isolatedEnvironment });
    run('git', ['config', 'user.email', 'packaged-cmp@example.invalid'], {
      cwd: repository, env: isolatedEnvironment
    });
    await writeFile(path.join(repository, 'singularity', 'workflow.yml'), '{}\n');
    await writeFile(path.join(repository, 'service.txt'), 'before\n');
    run('git', ['add', '-A'], { cwd: repository, env: isolatedEnvironment });
    run('git', ['commit', '-qm', 'baseline'], { cwd: repository, env: isolatedEnvironment });
    await writeFile(path.join(repository, 'service.txt'), 'after\n');
    await writeFile(path.join(repository, 'new.txt'), 'new\n');
    const before = run('git', ['status', '--porcelain=v1'], {
      cwd: repository, env: isolatedEnvironment
    });
    const projection = JSON.parse(run(installedCommand, [
      '--no-model', 'comprehension', 'regions', '--base', 'HEAD', '--json'
    ], { cwd: repository, env: isolatedEnvironment }));
    requireCondition(projection?.operation?.id === 'comprehension.regions'
      && projection?.data?.mode === 'observe-only'
      && projection?.data?.manifest?.structuralAssurance === 'unavailable'
      && projection?.data?.manifest?.counts?.regions === 2,
    'the installed CMP command did not return the bounded observe-only projection.');
    requireCondition(run('git', ['status', '--porcelain=v1'], {
      cwd: repository, env: isolatedEnvironment
    }) === before, 'the installed CMP read changed the isolated repository.');

    return {
      package: `${installedManifest.name}@${installedManifest.version}`,
      version,
      cmpObserveOnly: true,
      welParserPackaged: true
    };
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
