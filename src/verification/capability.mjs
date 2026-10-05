/**
 * The repository's test capability, disclosed before any code is written [E2G-019, §12 #18, D2].
 *
 * Every build module the checkout declares is listed with the test command that would run it (an
 * approved configured command, or the one publication would infer from its manifest), the adapter
 * profile that reads its report, how finely it identifies a test, the strongest assurance it can
 * reach, and whether its launcher is installed. Modules with no supported runner, with two build
 * systems, or whose launcher is missing are named with the reason, so a Story learns at intake what
 * publication would otherwise discover last. Nothing is executed here: launchers are looked up on
 * PATH or as files, never run, and tool versions come only from the confirmed readiness probe.
 */
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { inferModuleTestCommand } from '../code-delivery-tests.mjs';
import { normalizeExternalCommand } from '../external-command-policy.mjs';
import { posix } from '../util.mjs';
import { profileCeiling, profileForCommand, profileIsExact } from './profiles.mjs';
import { isDotnetManifest, selectDotnetManifest } from '../dotnet-manifests.mjs';
import { repositoryManifestExists } from '../repository-manifest.mjs';
import { isXcodeManifest } from '../swift-manifests.mjs';

const MANIFESTS = Object.freeze({
  'pom.xml': 'maven',
  'settings.gradle': 'gradle', 'settings.gradle.kts': 'gradle', 'build.gradle': 'gradle', 'build.gradle.kts': 'gradle',
  'package.json': 'node',
  'pyproject.toml': 'python', 'pytest.ini': 'python', 'tox.ini': 'python',
  'go.mod': 'go', 'Cargo.toml': 'rust', 'Package.swift': 'swift'
});
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'coverage', 'venv', '__pycache__', 'bin', 'obj', 'singularity'
]);
const MAX_DEPTH = 6;
const MAX_DIRECTORIES = 4000;

async function scanModules(root) {
  const found = [];
  let visited = 0;
  let truncated = false;
  const walk = async (relative, depth) => {
    if (depth > MAX_DEPTH) return;
    if (++visited > MAX_DIRECTORIES) { truncated = true; return; }
    let entries;
    try { entries = await readdir(path.join(root, relative || '.'), { withFileTypes: true }); } catch { return; }
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.endsWith('.xcodeproj') ? `${entry.name}/project.pbxproj`
        : entry.name.endsWith('.xcworkspace') ? `${entry.name}/contents.xcworkspacedata` : null;
      if (name && isXcodeManifest(name) && await repositoryManifestExists(root, posix(path.join(relative, name)))) {
        manifests.push({ name, system: 'xcode' });
      }
    }
    for (const entry of entries) {
      if (!(MANIFESTS[entry.name] || isDotnetManifest(entry.name))) continue;
      if (await repositoryManifestExists(root, posix(path.join(relative, entry.name)))) {
        manifests.push({ name: entry.name, system: MANIFESTS[entry.name] ?? 'dotnet' });
      }
    }
    if (manifests.length) {
      let manifest = manifests[0].name;
      let ambiguity = null;
      try {
        if (manifests.every((entry) => entry.system === 'dotnet')) manifest = selectDotnetManifest(manifests.map((entry) => entry.name));
      } catch (error) { ambiguity = { code: error.code, reason: error.message }; }
      found.push({ root: relative || '.', systems: [...new Set(manifests.map((entry) => entry.system))].sort(), manifest, ambiguity });
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRECTORIES.has(entry.name)
          && !entry.name.endsWith('.xcodeproj') && !entry.name.endsWith('.xcworkspace')) {
        await walk(posix(path.join(relative, entry.name)), depth + 1);
      }
    }
  };
  await walk('', 0);
  return { modules: found.sort((left, right) => left.root.localeCompare(right.root)), truncated };
}

/** Whether a launcher is installed: a file for a path, an executable on PATH for a bare name. */
export async function launcherPresent(launcher, { cwd, env = process.env, platform = process.platform } = {}) {
  const name = String(launcher ?? '');
  if (!name) return false;
  const executable = async (candidate) => {
    try {
      const info = await lstat(candidate);
      if (!info.isFile() && !info.isSymbolicLink()) return false;
      if (platform !== 'win32') await access(candidate, fsConstants.X_OK);
      return true;
    } catch { return false; }
  };
  if (name.includes('/') || name.includes('\\')) return executable(path.resolve(cwd, name));
  const extensions = platform === 'win32' ? String(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const directory of String(env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (await executable(path.join(directory, `${name}${extension}`))) return true;
    }
  }
  return false;
}

/** The configured test command whose affected roots contain a module, as publication decides it. */
function configuredCover(commands, moduleRoot) {
  return commands.find((command) => (command.affectedRoots ?? []).some((candidate) => {
    const affected = posix(candidate ?? '').replace(/^\.\//u, '').replace(/\/$/u, '') || '.';
    return affected === '.' || moduleRoot === affected || moduleRoot.startsWith(`${affected}/`);
  })) ?? null;
}

/**
 * The capability profile of a checkout. `configuredCommands` are the approved structured test
 * commands of the Story's code steps; they win over inference for the modules they cover.
 */
export async function repositoryTestCapability(root, { configuredCommands = [], env = process.env, platform = process.platform } = {}) {
  const configured = configuredCommands.flatMap((command, index) => {
    try { return [normalizeExternalCommand(command, index)]; } catch { return []; }
  }).filter((command) => command.kind === 'test');
  const scan = await scanModules(root);
  const modules = [];
  for (const module of scan.modules) {
    const base = { root: module.root, systems: module.systems, manifest: module.manifest };
    if (module.systems.length > 1) {
      modules.push({ ...base, status: 'unsupported', code: 'TEST_MODULE_AMBIGUOUS', reason: `it declares ${module.systems.join(' and ')} builds in one directory`,
        commandId: null, source: null, profile: null, granularity: null, ceiling: 'none', launcher: null });
      continue;
    }
    let command = configuredCover(configured, module.root);
    const source = command ? 'configured' : 'inferred';
    let failure = null;
    if (!command && module.ambiguity) failure = module.ambiguity;
    else if (!command) {
      try {
        command = await inferModuleTestCommand(root, { root: module.root, system: module.systems[0], manifest: module.manifest }, { platform });
      } catch (error) { failure = error; }
    }
    if (!command) {
      modules.push({ ...base, status: 'unsupported', code: failure?.code ?? 'TEST_RUNNER_UNSUPPORTED',
        reason: failure?.message ?? failure?.reason ?? 'no supported test runner or test script was found for it',
        commandId: null, source: null, profile: null, granularity: null, ceiling: 'none', launcher: null });
      continue;
    }
    const profile = profileForCommand(command);
    const launcher = String(command.argv?.[0] ?? '');
    const present = await launcherPresent(launcher, { cwd: path.join(root, command.workingDirectory ?? module.root), env, platform });
    modules.push({
      ...base, status: present ? 'supported' : 'launcher-missing',
      code: present ? null : 'TEST_LAUNCHER_MISSING', reason: present ? null : `its test launcher '${launcher}' is not installed here`,
      commandId: command.id, source, profile, resultAdapter: command.result?.adapter ?? null,
      granularity: profileIsExact(profile) ? 'test-case' : 'module', ceiling: profileCeiling(profile), launcher
    });
  }
  return { modules, truncated: scan.truncated };
}

/** The module that owns a repository path: the deepest module root containing it. */
export function capabilityModuleFor(capability, candidate) {
  const relative = posix(candidate).replace(/^\.\//u, '');
  return [...(capability?.modules ?? [])]
    .filter((entry) => entry.root === '.' || relative === entry.root || relative.startsWith(`${entry.root}/`))
    .sort((left, right) => right.root.length - left.root.length)[0] ?? null;
}

/** One line per module, for intake disclosure and `story test-policy show`. */
export function capabilityLines(capability) {
  if (capability?.status === 'not-checked') return [capability.guidance];
  return (capability?.modules ?? []).map((entry) => {
    const where = `${entry.root} (${entry.systems.join('/')})`;
    if (entry.status === 'supported') {
      return `${where}: ${entry.commandId} reads ${entry.granularity === 'test-case' ? 'each test case' : 'only test counts'}; criteria tested here can reach ${entry.ceiling}.`;
    }
    return `${where}: ${entry.status === 'launcher-missing' ? 'cannot run here' : 'unsupported'} — ${String(entry.reason).replace(/\.\s*$/u, '')}.`;
  });
}
