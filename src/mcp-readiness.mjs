import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { gitCommonDir, identity } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import {
  MCP_SCAFFOLD_VERSIONS, MCP_WORKSPACE_PATH, PLAYWRIGHT_MCP_HOST_ARGUMENTS
} from './mcp-host.mjs';
import {
  authorizedMcpOrigins, MCP_SMOKE_MAX_AGE_MS, normalizeMcpTargetOrigin, safeMcpTargetUrl
} from './mcp-target.mjs';
import { recordObservedMcpBrowserCapture } from './mcp-evidence.mjs';
import {
  exists, nowIso, signalProcessTree, SingularityFlowError
} from './util.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { resolvePlatformProcess } from './platform-process.mjs';
import {
  readPrivateSidecar, safePrivateSidecarDirectory, writeMutablePrivateSidecar
} from './private-sidecar.mjs';
import {
  currentPlaywrightAuthBinding, playwrightAuthProfileStatus, resolvePlaywrightAuthRuntime,
  secureWindowsAuthAcl
} from './mcp-auth-profile.mjs';

const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_SMOKE_TOOLS = Object.freeze(['browser_navigate', 'browser_snapshot', 'browser_close']);
const PLAYWRIGHT_PACKAGE = '@playwright/mcp';
const PACKAGE_INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const MCP_WARM_INSTALL_TIMEOUT_MS = 180_000;
const MCP_WARM_START_TIMEOUT_MS = 30_000;
const MCP_WARM_OUTPUT_MAX_BYTES = 1024 * 1024;
const MCP_WARM_LINE_MAX_BYTES = 256 * 1024;
const MCP_SMOKE_OUTPUT_MAX_BYTES = 1024 * 1024;
const MCP_SMOKE_LINE_MAX_BYTES = 256 * 1024;
const MCP_RECEIPT_MAX_BYTES = 256 * 1024;
const MCP_PACKAGE_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const MCP_PACKAGE_LOCK_MAX_BYTES = 16 * 1024 * 1024;
const MCP_PACKAGE_EXECUTABLE_MAX_BYTES = 32 * 1024 * 1024;
const MCP_PACKAGE_CLOSURE_MAX_FILES = 50_000;
const MCP_PACKAGE_CLOSURE_MAX_BYTES = 512 * 1024 * 1024;
const MCP_PACKAGE_CLOSURE_FILE_MAX_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function sources(root, home = os.homedir()) {
  return [
    { surface: 'vscode-workspace', file: path.join(root, MCP_WORKSPACE_PATH) },
    { surface: 'copilot-workspace', file: path.join(root, '.mcp.json') },
    { surface: 'copilot-user', file: path.join(home, '.copilot/mcp-config.json') }
  ];
}

function receiptPath(root, serverId) {
  if (!SAFE_ID.test(serverId)) throw new SingularityFlowError(`Invalid MCP server ID '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  return path.join(mcpMachineRoot(root), 'readiness', `${serverId}.json`);
}

function smokeReceiptPath(root, serverId) {
  if (!SAFE_ID.test(serverId)) throw new SingularityFlowError(`Invalid MCP server ID '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  return path.join(mcpMachineRoot(root), 'smoke', `${serverId}.json`);
}

function mcpMachineRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'mcp');
}

function warmReceiptPath(root, serverId) {
  if (!SAFE_ID.test(serverId)) throw new SingularityFlowError(`Invalid MCP server ID '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  return path.join(mcpMachineRoot(root), 'cache', `${serverId}.json`);
}

function playwrightPackageDirectory(root) {
  return path.join(
    mcpMachineRoot(root), 'packages', 'playwright', MCP_SCAFFOLD_VERSIONS.playwright
  );
}

function filesystemIdentity(info, canonicalPath) {
  return Object.freeze({
    canonicalPath,
    device: String(info.dev),
    inode: String(info.ino),
    size: info.size,
    modifiedAtMs: info.mtimeMs,
    changedAtMs: info.ctimeMs
  });
}

function sameFilesystemIdentity(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

async function securePlaywrightPackageAncestors(root, {
  platform = process.platform,
  windowsAcl = secureWindowsAuthAcl,
  apply = false
} = {}) {
  if (platform !== 'win32') return;
  const machine = mcpMachineRoot(root);
  const packages = path.join(machine, 'packages');
  const playwright = path.join(packages, 'playwright');
  for (const directory of [machine, packages, playwright]) {
    await safePrivateSidecarDirectory(root, directory, { create: apply });
    await windowsAcl(directory, { directory: true, apply, recursive: false });
  }
}

async function securePlaywrightPackageTree(root, directory, {
  platform = process.platform,
  windowsAcl = secureWindowsAuthAcl,
  apply = false
} = {}) {
  if (platform !== 'win32') return;
  await securePlaywrightPackageAncestors(root, { platform, windowsAcl, apply });
  await safePrivateSidecarDirectory(root, directory);
  // One bounded PowerShell traversal applies/verifies every existing entry and refuses reparse
  // points. A per-file process would make a normal Playwright closure prohibitively expensive.
  await windowsAcl(directory, { directory: true, apply, recursive: true });
}

function localMcpPath(root, absolute) {
  const base = path.resolve(mcpMachineRoot(root));
  const target = path.resolve(absolute);
  const relative = path.relative(base, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative)) {
    throw new SingularityFlowError('MCP machine-local path escapes its Git-local cache.', {
      code: 'MCP_WARM_PACKAGE_INVALID'
    });
  }
  return relative.split(path.sep).join('/');
}

async function writePrivateJson(root, file, value) {
  await writeMutablePrivateSidecar(root, file, canonicalJson(value), {
    maximumBytes: MCP_RECEIPT_MAX_BYTES
  });
}

async function readPrivateRecord(root, file, family) {
  const bytes = await readPrivateSidecar(root, file, {
    maximumBytes: MCP_RECEIPT_MAX_BYTES,
    optional: true
  });
  return bytes == null ? null : readRecord(family, bytes).record;
}

function resolveLocalMcpPath(root, relative) {
  const value = String(relative ?? '').replaceAll('\\', '/');
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//.test(value)
      || value.split('/').includes('..')) return null;
  const base = path.resolve(mcpMachineRoot(root));
  const absolute = path.resolve(base, ...value.split('/'));
  return absolute.startsWith(`${base}${path.sep}`) ? absolute : null;
}

function structurallyValidHostEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.type === 'http' || entry.url != null) {
    try {
      const url = new URL(entry.url);
      return ['https:', 'http:'].includes(url.protocol);
    } catch { return false; }
  }
  return typeof entry.command === 'string' && entry.command.length > 0
    && (entry.args == null || (Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string')));
}

function exactPlaywrightPin(entry) {
  if (entry?.command !== 'npx' && !managedPlaywrightHostEntry(entry)) return false;
  const spec = (entry.args ?? []).find((arg) => String(arg).startsWith('@playwright/mcp@'));
  return spec === `@playwright/mcp@${MCP_SCAFFOLD_VERSIONS.playwright}`;
}

function managedPlaywrightHostEntry(entry) {
  return entry?.command === 'singularity-flow'
    && entry?.args?.[0] === 'mcp'
    && entry?.args?.[1] === 'serve'
    && entry?.args?.[2] === 'playwright'
    && entry?.args?.[3] === '--package';
}

function deterministicPlaywrightProfile(entry) {
  const spec = `@playwright/mcp@${MCP_SCAFFOLD_VERSIONS.playwright}`;
  const expected = managedPlaywrightHostEntry(entry)
    ? ['mcp', 'serve', 'playwright', '--package', spec, ...PLAYWRIGHT_MCP_HOST_ARGUMENTS]
    : ['-y', spec, ...PLAYWRIGHT_MCP_HOST_ARGUMENTS];
  return exactPlaywrightPin(entry) && canonicalJson(entry?.args ?? []) === canonicalJson(expected);
}

export async function inspectMcpHostEntries(root, { home = os.homedir() } = {}) {
  const rows = [];
  for (const source of sources(root, home)) {
    if (!(await exists(source.file))) continue;
    let document;
    try { document = JSON.parse(await readFile(source.file, 'utf8')); }
    catch (error) {
      rows.push({ surface: source.surface, error: `Invalid JSON: ${error.message}` });
      continue;
    }
    const servers = document?.servers ?? document?.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      rows.push({ surface: source.surface, error: 'Expected a servers or mcpServers object.' });
      continue;
    }
    for (const [name, entry] of Object.entries(servers)) {
      rows.push({
        surface: source.surface,
        name,
        entrySha256: recordSha256(entry),
        structurallyValid: structurallyValidHostEntry(entry),
        exactPackagePin: exactPlaywrightPin(entry)
      });
    }
  }
  return rows;
}

async function hostEntryMap(root, options = {}) {
  const map = new Map();
  for (const source of sources(root, options.home ?? os.homedir())) {
    if (!(await exists(source.file))) continue;
    let document; try { document = JSON.parse(await readFile(source.file, 'utf8')); } catch { continue; }
    for (const [name, entry] of Object.entries(document?.servers ?? document?.mcpServers ?? {})) if (!map.has(name)) map.set(name, entry);
  }
  return map;
}

export async function defaultNetworkProbe(entry, {
  timeoutMs = 10_000,
  platform = process.platform,
  environment = process.env,
  execFileCommand = execFileAsync,
  platformLookupCommand = spawnSync
} = {}) {
  if (entry?.type === 'http' || entry?.url) {
    let url = safeMcpTargetUrl(entry.url, { label: 'MCP network probe URL' }), redirects = 0;
    while (redirects <= 5) {
      const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/event-stream;q=0.9, */*;q=0.1' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get('location'); if (!location) break; url = safeMcpTargetUrl(new URL(location, url), { label: 'MCP network redirect URL' }); redirects += 1; continue; }
      return { status: [200, 204, 400, 401, 403, 405, 406].includes(response.status) ? 'reachable' : 'failed', protocol: url.protocol, httpStatus: response.status, redirects };
    }
    return { status: 'failed', reason: 'redirect-limit' };
  }
  if (entry?.command === 'npx' || managedPlaywrightHostEntry(entry)) {
    const spec = (entry.args ?? []).find((arg) => /^@?[A-Za-z0-9_.@/-]+@[0-9]/.test(String(arg)));
    if (!spec) return { status: 'not-probed', reason: 'no-exact-package-pin' };
    const at = spec.lastIndexOf('@'), packageName = spec.slice(0, at), version = spec.slice(at + 1);
    const launch = resolvePlatformProcess(
      'npm', ['view', `${packageName}@${version}`, 'version', '--json'],
      { platform, environment, spawnSyncCommand: platformLookupCommand }
    );
    const { stdout } = await execFileCommand(launch.executable, launch.arguments, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...environment, NPM_CONFIG_LOGLEVEL: 'silent' },
      ...launch.spawnOptions
    });
    const resolved = JSON.parse(stdout.trim());
    return { status: resolved === version ? 'reachable' : 'failed', package: packageName, requestedVersion: version, resolvedVersion: resolved };
  }
  return { status: 'not-probed', reason: 'unsupported-transport' };
}

/** Probe registry or endpoint reachability without creating any local receipt. */
export async function probeMcpHost(root, definition, serverId, {
  network = false, probe = defaultNetworkProbe, platform = process.platform,
  environment = process.env, execFileCommand = execFileAsync,
  platformLookupCommand = spawnSync
} = {}) {
  if (!network) {
    throw new SingularityFlowError('MCP probe performs network access. Re-run with --network.', {
      code: 'MCP_NETWORK_CONSENT_REQUIRED'
    });
  }
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  if (!structurallyValidHostEntry(entry)) {
    throw new SingularityFlowError(`Host entry '${server.hostReference}' is structurally invalid.`, { code: 'MCP_HOST_CONFIG_INVALID' });
  }
  const result = await probe(entry, {
    server, platform, environment, execFileCommand, platformLookupCommand
  });
  if (result?.status !== 'reachable') {
    throw new SingularityFlowError(
      `MCP network probe failed for '${serverId}' (${result?.reason ?? result?.status ?? 'unknown'}).`,
      { code: 'MCP_NETWORK_PROBE_FAILED', details: { serverId, status: result?.status ?? 'failed', reason: result?.reason ?? null } }
    );
  }
  return {
    serverId, hostReference: server.hostReference, checkedAt: nowIso(),
    network: result
  };
}

function exactPlaywrightSpec(entry) {
  const expected = `${PLAYWRIGHT_PACKAGE}@${MCP_SCAFFOLD_VERSIONS.playwright}`;
  return (entry?.args ?? []).find((argument) => argument === expected) ?? null;
}

function playwrightHostArguments(entry) {
  const spec = exactPlaywrightSpec(entry);
  if (!spec) {
    throw new SingularityFlowError(
      `Playwright warm-up requires the exact reviewed package ${PLAYWRIGHT_PACKAGE}@${MCP_SCAFFOLD_VERSIONS.playwright}.`,
      { code: 'MCP_FLOATING_PACKAGE_FORBIDDEN' }
    );
  }
  const index = entry.args.indexOf(spec);
  return entry.args.slice(index + 1);
}

async function playwrightRuntimeArguments(root, entry) {
  const arguments_ = [...playwrightHostArguments(entry)];
  const outputIndex = arguments_.indexOf('--output-dir');
  if (outputIndex < 0
      || arguments_[outputIndex + 1] !== '.git/singularity-flow/mcp/playwright-output') {
    throw new SingularityFlowError(
      'Playwright host entry has no reviewed Git-local output-directory placeholder.',
      { code: 'MCP_HOST_CONFIG_INVALID' }
    );
  }
  const outputDirectory = path.join(mcpMachineRoot(root), 'playwright-output');
  await safePrivateSidecarDirectory(root, outputDirectory, { create: true });
  arguments_[outputIndex + 1] = outputDirectory;
  return arguments_;
}

function packageBin(manifest) {
  const declared = manifest?.bin;
  if (typeof declared === 'string') return declared;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return null;
  const entries = Object.entries(declared).filter(([, value]) => typeof value === 'string');
  return (entries.find(([name]) => name === 'playwright-mcp') ?? entries.sort(([left], [right]) => left.localeCompare(right))[0])?.[1] ?? null;
}

async function playwrightPackageClosure(root, directory) {
  const entries = [];
  let totalBytes = 0;
  const visit = async (current, relative = '') => {
    await safePrivateSidecarDirectory(root, current);
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      // npm creates convenience links here. SFlow starts the package's inspected real entry point
      // directly, so this executable alias directory is neither trusted nor used at runtime.
      if (childRelative === 'node_modules/.bin') continue;
      const absolute = path.join(current, child.name);
      if (child.isSymbolicLink()) {
        throw new SingularityFlowError('The acquired Playwright MCP dependency closure contains an unexpected symbolic link.', {
          code: 'MCP_WARM_PACKAGE_INVALID'
        });
      }
      if (child.isDirectory()) {
        await visit(absolute, childRelative);
        continue;
      }
      if (!child.isFile()) {
        throw new SingularityFlowError('The acquired Playwright MCP dependency closure contains an unsupported filesystem entry.', {
          code: 'MCP_WARM_PACKAGE_INVALID'
        });
      }
      if (entries.length >= MCP_PACKAGE_CLOSURE_MAX_FILES) {
        throw new SingularityFlowError('The acquired Playwright MCP dependency closure exceeds its file-count ceiling.', {
          code: 'MCP_WARM_PACKAGE_INVALID'
        });
      }
      const bytes = await readPrivateSidecar(root, absolute, {
        maximumBytes: MCP_PACKAGE_CLOSURE_FILE_MAX_BYTES
      });
      totalBytes += bytes.length;
      if (totalBytes > MCP_PACKAGE_CLOSURE_MAX_BYTES) {
        throw new SingularityFlowError('The acquired Playwright MCP dependency closure exceeds its byte ceiling.', {
          code: 'MCP_WARM_PACKAGE_INVALID'
        });
      }
      entries.push({
        path: childRelative.split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    }
  };
  await visit(directory);
  return {
    sha256: `sha256:${createHash('sha256').update(canonicalJson(entries)).digest('hex')}`,
    fileCount: entries.length,
    totalBytes
  };
}

async function inspectPlaywrightPackage(root, directory, {
  platform = process.platform,
  windowsAcl = secureWindowsAuthAcl,
  applyWindowsAcl = false
} = {}) {
  const packageDirectory = path.join(directory, 'node_modules', '@playwright', 'mcp');
  let manifest;
  let lock;
  try {
    await safePrivateSidecarDirectory(root, directory);
    await securePlaywrightPackageTree(root, directory, {
      platform, windowsAcl, apply: applyWindowsAcl
    });
    await safePrivateSidecarDirectory(root, packageDirectory);
    const manifestBytes = await readPrivateSidecar(root, path.join(packageDirectory, 'package.json'), {
      maximumBytes: MCP_PACKAGE_MANIFEST_MAX_BYTES
    });
    const lockBytes = await readPrivateSidecar(root, path.join(directory, 'package-lock.json'), {
      maximumBytes: MCP_PACKAGE_LOCK_MAX_BYTES
    });
    manifest = JSON.parse(manifestBytes.toString('utf8'));
    lock = JSON.parse(lockBytes.toString('utf8'));
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') throw error;
    throw new SingularityFlowError('The acquired Playwright MCP package is incomplete or has invalid metadata.', {
      code: 'MCP_WARM_PACKAGE_INVALID', cause: error
    });
  }
  const expectedVersion = MCP_SCAFFOLD_VERSIONS.playwright;
  const locked = lock?.packages?.['node_modules/@playwright/mcp'];
  if (manifest.name !== PLAYWRIGHT_PACKAGE || manifest.version !== expectedVersion
      || locked?.version !== expectedVersion || !PACKAGE_INTEGRITY.test(locked?.integrity ?? '')) {
    throw new SingularityFlowError('The acquired Playwright MCP package does not match its exact version and registry integrity lock.', {
      code: 'MCP_WARM_PACKAGE_INVALID'
    });
  }
  const bin = packageBin(manifest);
  const normalizedBin = typeof bin === 'string' ? path.posix.normalize(bin.replaceAll('\\', '/')) : null;
  if (!normalizedBin || normalizedBin === '..' || normalizedBin.startsWith('../') || normalizedBin.startsWith('/')) {
    throw new SingularityFlowError('The acquired Playwright MCP package has no safe executable entry point.', {
      code: 'MCP_WARM_PACKAGE_INVALID'
    });
  }
  const executable = path.resolve(packageDirectory, ...normalizedBin.split('/'));
  const canonicalPackage = await realpath(packageDirectory).catch(() => null);
  const canonicalExecutable = await realpath(executable).catch(() => null);
  const packageStat = await lstat(packageDirectory).catch(() => null);
  const executableStat = await lstat(executable).catch(() => null);
  if (!canonicalPackage || !canonicalExecutable || !packageStat?.isDirectory()
      || packageStat.isSymbolicLink() || !executableStat?.isFile()
      || executableStat.isSymbolicLink()
      || !canonicalExecutable.startsWith(`${canonicalPackage}${path.sep}`)) {
    throw new SingularityFlowError('The acquired Playwright MCP executable escapes or is missing from its exact package.', {
      code: 'MCP_WARM_PACKAGE_INVALID'
    });
  }
  const executableBytes = await readPrivateSidecar(root, executable, {
    maximumBytes: MCP_PACKAGE_EXECUTABLE_MAX_BYTES
  });
  const closure = await playwrightPackageClosure(root, directory);
  const canonicalPackageAfter = await realpath(packageDirectory).catch(() => null);
  const canonicalExecutableAfter = await realpath(executable).catch(() => null);
  const packageStatAfter = await lstat(packageDirectory).catch(() => null);
  const executableStatAfter = await lstat(executable).catch(() => null);
  const packageIdentity = packageStat
    ? filesystemIdentity(packageStat, canonicalPackage)
    : null;
  const launchIdentity = executableStat
    ? filesystemIdentity(executableStat, canonicalExecutable)
    : null;
  if (!packageStatAfter?.isDirectory() || packageStatAfter.isSymbolicLink()
      || !executableStatAfter?.isFile() || executableStatAfter.isSymbolicLink()
      || !sameFilesystemIdentity(
        packageIdentity,
        filesystemIdentity(packageStatAfter, canonicalPackageAfter)
      )
      || !sameFilesystemIdentity(
        launchIdentity,
        filesystemIdentity(executableStatAfter, canonicalExecutableAfter)
      )) {
    throw new SingularityFlowError(
      'The acquired Playwright MCP package changed identity while it was being inspected.',
      { code: 'MCP_WARM_PACKAGE_CHANGED' }
    );
  }
  return {
    package: {
      name: PLAYWRIGHT_PACKAGE,
      version: expectedVersion,
      integrity: locked.integrity,
      directory: localMcpPath(root, directory),
      closure
    },
    resolvedExecutable: {
      // Store the lexical Git-local path. On macOS, realpath changes /var to /private/var; using
      // that canonical alias as a relative receipt path falsely escapes the Git directory.
      path: localMcpPath(root, executable),
      sha256: createHash('sha256').update(executableBytes).digest('hex')
    },
    absoluteExecutable: canonicalExecutable,
    packageIdentity,
    launchIdentity
  };
}

function samePlaywrightInspection(expected, observed) {
  return expected?.package?.name === observed?.package?.name
    && expected?.package?.version === observed?.package?.version
    && expected?.package?.integrity === observed?.package?.integrity
    && canonicalJson(expected?.package?.closure) === canonicalJson(observed?.package?.closure)
    && expected?.resolvedExecutable?.path === observed?.resolvedExecutable?.path
    && expected?.resolvedExecutable?.sha256 === observed?.resolvedExecutable?.sha256
    && sameFilesystemIdentity(expected?.packageIdentity, observed?.packageIdentity)
    && sameFilesystemIdentity(expected?.launchIdentity, observed?.launchIdentity);
}

async function revalidatePlaywrightInspection(root, expected, {
  platform = process.platform,
  windowsAcl = secureWindowsAuthAcl
} = {}) {
  const packageDirectory = resolveLocalMcpPath(root, expected?.package?.directory);
  if (!packageDirectory) {
    throw new SingularityFlowError('The Playwright package proof contains an invalid machine-local location.', {
      code: 'MCP_WARM_PACKAGE_CHANGED'
    });
  }
  const observed = await inspectPlaywrightPackage(root, packageDirectory, { platform, windowsAcl });
  if (!samePlaywrightInspection(expected, observed)) {
    throw new SingularityFlowError(
      'The acquired Playwright MCP package, dependency closure, or launch identity changed before process start.',
      { code: 'MCP_WARM_PACKAGE_CHANGED' }
    );
  }
  return { status: expected.status, ...observed };
}

/** Acquire the exact reviewed Playwright package into repository Git-local machine state. */
export async function acquirePlaywrightPackage(root, entry, {
  platform = process.platform,
  environment = process.env,
  execFileCommand = execFileAsync,
  timeoutMs = MCP_WARM_INSTALL_TIMEOUT_MS,
  platformLookupCommand = spawnSync,
  windowsAcl = secureWindowsAuthAcl
} = {}) {
  const spec = exactPlaywrightSpec(entry);
  if (!spec || !deterministicPlaywrightProfile(entry)) {
    throw new SingularityFlowError('Playwright warm-up requires the exact deterministic host entry produced by mcp scaffold.', {
      code: 'MCP_HOST_CONFIG_INVALID'
    });
  }
  const parent = path.join(mcpMachineRoot(root), 'packages', 'playwright');
  const target = playwrightPackageDirectory(root);
  await safePrivateSidecarDirectory(root, parent, { create: true });
  await securePlaywrightPackageAncestors(root, { platform, windowsAcl, apply: true });
  if (await exists(target)) {
    await safePrivateSidecarDirectory(root, target);
    try {
      return {
        status: 'reused',
        ...(await inspectPlaywrightPackage(root, target, { platform, windowsAcl }))
      };
    }
    catch (error) {
      if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') throw error;
      // A partial acquisition has no receipt authority and is replaced below.
    }
  }

  const staging = await mkdtemp(path.join(parent, '.acquire-'));
  let backup = null;
  try {
    await safePrivateSidecarDirectory(root, staging);
    await securePlaywrightPackageTree(root, staging, {
      platform, windowsAcl, apply: true
    });
    await writePrivateJson(root, path.join(staging, 'package.json'), {
      name: 'singularity-flow-playwright-mcp-cache',
      version: '0.0.0',
      private: true,
      dependencies: { [PLAYWRIGHT_PACKAGE]: MCP_SCAFFOLD_VERSIONS.playwright }
    });
    const logicalArguments = [
      'install', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund',
      '--no-update-notifier', '--package-lock=true', '--save-exact', '--omit=dev', spec
    ];
    const launch = resolvePlatformProcess('npm', logicalArguments, {
      platform, environment, spawnSyncCommand: platformLookupCommand
    });
    try {
      await execFileCommand(launch.executable, launch.arguments, {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...environment,
          NPM_CONFIG_AUDIT: 'false',
          NPM_CONFIG_FUND: 'false',
          NPM_CONFIG_UPDATE_NOTIFIER: 'false'
        },
        ...launch.spawnOptions
      });
    } catch (error) {
      throw new SingularityFlowError(
        'Exact Playwright MCP package acquisition failed. Check mcp doctor --network and the approved npm registry, proxy, and CA configuration.',
        { code: 'MCP_WARM_ACQUISITION_FAILED', cause: error }
      );
    }
    await inspectPlaywrightPackage(root, staging, {
      platform, windowsAcl, applyWindowsAcl: true
    });
    await safePrivateSidecarDirectory(root, parent);
    if (await exists(target)) {
      await safePrivateSidecarDirectory(root, target);
      backup = `${target}.previous-${process.pid}-${Date.now()}`;
      await rename(target, backup);
    }
    await rename(staging, target);
    await safePrivateSidecarDirectory(root, target);
    const acquired = await inspectPlaywrightPackage(root, target, {
      platform, windowsAcl, applyWindowsAcl: true
    });
    if (backup) await rm(backup, { recursive: true, force: true });
    return { status: 'acquired', ...acquired };
  } catch (error) {
    if (backup && !(await exists(target)) && await exists(backup)) {
      await rename(backup, target).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Start the acquired package directly and complete a bounded MCP handshake with npm offline. */
export function verifyPlaywrightOfflineStart(resolvedExecutable, hostArguments, {
  runtimeExecutable = process.execPath,
  platform = process.platform,
  environment = process.env,
  spawnCommand = spawn,
  treeSpawnCommand = spawn,
  killProcess = process.kill,
  terminateTree = signalProcessTree,
  cwd = process.cwd(),
  timeoutMs = MCP_WARM_START_TIMEOUT_MS,
  terminationGraceMs = 1_000,
  outputMaxBytes = MCP_WARM_OUTPUT_MAX_BYTES,
  lineMaxBytes = MCP_WARM_LINE_MAX_BYTES
} = {}) {
  return new Promise((resolve, reject) => {
    const launch = resolvePlatformProcess(
      runtimeExecutable, [resolvedExecutable, ...hostArguments], { platform, environment }
    );
    const child = spawnCommand(launch.executable, launch.arguments, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...environment,
        NPM_CONFIG_OFFLINE: 'true',
        npm_config_offline: 'true',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
      },
      windowsHide: true,
      detached: platform !== 'win32',
      ...launch.spawnOptions
    });
    const pending = new Map();
    let nextId = 1;
    let stderr = '';
    let settled = false;
    let finishing = false;
    let processClosed = false;
    const closeWaiters = new Set();
    const waitForClose = (milliseconds) => {
      if (processClosed) return Promise.resolve(true);
      return new Promise((resolveClose) => {
        const complete = (value) => {
          clearTimeout(closeTimer);
          closeWaiters.delete(complete);
          resolveClose(value);
        };
        const closeTimer = setTimeout(() => complete(false), milliseconds);
        closeWaiters.add(complete);
      });
    };
    const finish = async (error, result = null) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      for (const waiter of pending.values()) waiter.reject(error ?? new Error('MCP warm transport closed.'));
      pending.clear();
      const grace = Math.max(10, Math.min(5_000, Number(terminationGraceMs) || 1_000));
      await terminateTree(child, 'SIGTERM', {
        platform, spawnCommand: treeSpawnCommand, killProcess, timeoutMs: Math.ceil(grace / 2)
      }).catch(() => false);
      let closed = await waitForClose(Math.ceil(grace / 2));
      if (!closed) {
        await terminateTree(child, 'SIGKILL', {
          platform, spawnCommand: treeSpawnCommand, killProcess, timeoutMs: Math.ceil(grace / 2)
        }).catch(() => false);
        closed = await waitForClose(Math.ceil(grace / 2));
      }
      settled = true;
      finishing = false;
      if (!closed && !error) {
        error = new SingularityFlowError(
          'The acquired Playwright MCP package completed its handshake, but process-tree quiescence could not be verified.',
          { code: 'MCP_WARM_OFFLINE_START_FAILED' }
        );
      }
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new SingularityFlowError(
      'The acquired Playwright MCP package did not complete its offline start handshake in time.',
      { code: 'MCP_WARM_OFFLINE_START_FAILED' }
    )), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.on('error', (error) => { void finish(new SingularityFlowError(
      `The acquired Playwright MCP package could not start locally: ${error.message}`,
      { code: 'MCP_WARM_OFFLINE_START_FAILED', cause: error }
    )); });
    child.on('exit', (code) => {
      if (!settled && !finishing) void finish(new SingularityFlowError(
        `The acquired Playwright MCP package exited before its offline handshake completed (${code}): ${stderr.trim()}`,
        { code: 'MCP_WARM_OFFLINE_START_FAILED' }
      ));
    });
    child.on('close', () => {
      processClosed = true;
      for (const waiter of [...closeWaiters]) waiter(true);
    });
    const boundedOutput = Math.max(1, Number(outputMaxBytes) || MCP_WARM_OUTPUT_MAX_BYTES);
    const boundedLine = Math.max(1, Math.min(
      boundedOutput, Number(lineMaxBytes) || MCP_WARM_LINE_MAX_BYTES
    ));
    const decoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stdoutLine = '';
    const acceptLine = (line) => {
      if (settled || finishing || !line.trim()) return;
      if (Buffer.byteLength(line, 'utf8') > boundedLine) {
        void finish(new SingularityFlowError(
          `The acquired Playwright MCP package emitted a line larger than the ${boundedLine}-byte verification ceiling.`,
          { code: 'MCP_WARM_OFFLINE_START_FAILED' }
        ));
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch (error) {
        void finish(new SingularityFlowError(
          'The acquired Playwright MCP package emitted malformed JSON during offline verification.',
          { code: 'MCP_WARM_OFFLINE_START_FAILED', cause: error }
        ));
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new SingularityFlowError(
        `Playwright MCP ${waiter.method} failed during offline start: ${message.error.message ?? 'unknown error'}`,
        { code: 'MCP_WARM_OFFLINE_START_FAILED' }
      ));
      else waiter.resolve(message.result);
    };
    child.stdout.on('data', (chunk) => {
      if (settled || finishing) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > boundedOutput) {
        void finish(new SingularityFlowError(
          `The acquired Playwright MCP package exceeded the ${boundedOutput}-byte verification output ceiling.`,
          { code: 'MCP_WARM_OFFLINE_START_FAILED' }
        ));
        return;
      }
      stdoutLine += decoder.write(bytes);
      let newline;
      while (!finishing && (newline = stdoutLine.indexOf('\n')) >= 0) {
        const line = stdoutLine.slice(0, newline).replace(/\r$/, '');
        stdoutLine = stdoutLine.slice(newline + 1);
        acceptLine(line);
      }
      if (!finishing && Buffer.byteLength(stdoutLine, 'utf8') > boundedLine) {
        void finish(new SingularityFlowError(
          `The acquired Playwright MCP package emitted a line larger than the ${boundedLine}-byte verification ceiling.`,
          { code: 'MCP_WARM_OFFLINE_START_FAILED' }
        ));
      }
    });
    child.stdout.on('error', (error) => { void finish(new SingularityFlowError(
      `The acquired Playwright MCP package output failed during offline verification: ${error.message}`,
      { code: 'MCP_WARM_OFFLINE_START_FAILED', cause: error }
    )); });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
      send({ jsonrpc: '2.0', id, method, params });
    });
    (async () => {
      const initialized = await request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'singularity-flow-warm', version: '1' }
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      const catalog = await request('tools/list');
      const tools = [...new Set((catalog?.tools ?? []).map((tool) => tool?.name)
        .filter((name) => typeof name === 'string'))].sort();
      const missing = REQUIRED_SMOKE_TOOLS.filter((tool) => !tools.includes(tool));
      if (missing.length) throw new SingularityFlowError(
        `The acquired Playwright MCP package is missing required tool(s): ${missing.join(', ')}.`,
        { code: 'MCP_WARM_OFFLINE_START_FAILED' }
      );
      void finish(null, {
        status: 'passed',
        transport: 'stdio',
        packageResolution: 'local-install',
        npmOffline: true,
        protocolVersion: initialized?.protocolVersion ?? null,
        tools: REQUIRED_SMOKE_TOOLS
      });
    })().catch((error) => { void finish(error?.code ? error : new SingularityFlowError(
      `The acquired Playwright MCP package failed its offline start handshake: ${error.message}`,
      { code: 'MCP_WARM_OFFLINE_START_FAILED', cause: error }
    )); });
  });
}

function playwrightWarmReceipt({
  server, entry, acquired, offline, runtime, runtimeExecutable, runtimeVersion,
  platform, architecture
}) {
  return {
    schemaVersion: currentSchemaVersion('mcp-host-receipt'),
    receiptKind: 'package-warm',
    serverId: server.id,
    hostReference: server.hostReference,
    checkedAt: nowIso(),
    hostEntrySha256: recordSha256(entry),
    policySha256: policyHash(server),
    authProfile: runtime.authProfile,
    acquisition: { status: acquired.status },
    package: acquired.package,
    runtime: {
      executable: runtimeExecutable,
      nodeVersion: runtimeVersion,
      platform,
      architecture
    },
    resolvedExecutable: acquired.resolvedExecutable,
    offlineStart: offline
  };
}

async function writePlaywrightWarmReceipt(root, inputs) {
  const receipt = playwrightWarmReceipt(inputs);
  const file = warmReceiptPath(root, inputs.server.id);
  await writePrivateJson(root, file, receipt);
  return { ...receipt, path: file };
}

export async function warmMcpHost(root, definition, serverId, {
  network = false,
  probe = defaultNetworkProbe,
  acquire = acquirePlaywrightPackage,
  offlineStart = verifyPlaywrightOfflineStart,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  runtimeExecutable = process.execPath,
  runtimeVersion = process.version,
  execFileCommand = execFileAsync,
  platformLookupCommand = spawnSync,
  spawnCommand = spawn,
  windowsAcl,
  revalidatePackage = revalidatePlaywrightInspection,
  beforeLaunchValidation
} = {}) {
  if (!network) throw new SingularityFlowError('MCP warm-up performs network access. Re-run with --network.', { code: 'MCP_NETWORK_CONSENT_REQUIRED' });
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`);
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`);
  if (serverId === 'playwright') {
    const runtime = await resolvePlaywrightAuthRuntime(root, entry, { platform, windowsAcl });
    const acquisition = await acquire(root, entry, {
      platform, environment, execFileCommand, platformLookupCommand, windowsAcl
    });
    const hostArguments = await playwrightRuntimeArguments(root, runtime.entry);
    await beforeLaunchValidation?.({
      packageDirectory: resolveLocalMcpPath(root, acquisition.package?.directory)
    });
    // Acquisition may have completed much earlier than the launch. Rebind the exact closure and
    // filesystem identity at the last asynchronous boundary before handing the path to Node.
    const acquired = await revalidatePackage(root, acquisition, { platform, windowsAcl });
    const offline = await offlineStart(
      acquired.absoluteExecutable,
      hostArguments,
      {
        runtimeExecutable, platform, environment, spawnCommand, cwd: root
      }
    );
    if (offline?.status !== 'passed') {
      throw new SingularityFlowError('The acquired Playwright MCP package did not pass offline start verification.', {
        code: 'MCP_WARM_OFFLINE_START_FAILED'
      });
    }
    return writePlaywrightWarmReceipt(root, {
      server, entry, acquired, offline, runtime, runtimeExecutable, runtimeVersion,
      platform, architecture
    });
  }
  const networkResult = await probe(entry, { server });
  const receipt = { schemaVersion: currentSchemaVersion('mcp-host-receipt'), receiptKind: 'network-warm', serverId, hostReference: server.hostReference, checkedAt: nowIso(), network: networkResult, hostEntrySha256: recordSha256(entry), policySha256: policyHash(server) };
  const file = warmReceiptPath(root, serverId);
  await writePrivateJson(root, file, receipt);
  return { ...receipt, path: file };
}

/** Re-prove an already acquired Playwright package without registry or endpoint access. */
export async function verifyMcpHostOffline(root, definition, serverId, {
  offlineStart = verifyPlaywrightOfflineStart,
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  runtimeExecutable = process.execPath,
  runtimeVersion = process.version,
  spawnCommand = spawn,
  windowsAcl,
  revalidatePackage = revalidatePlaywrightInspection,
  beforeLaunchValidation
} = {}) {
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  if (serverId !== 'playwright') {
    throw new SingularityFlowError(
      `MCP offline verification is not available for '${serverId}'.`,
      { code: 'MCP_OFFLINE_VERIFY_UNSUPPORTED' }
    );
  }
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  if (!deterministicPlaywrightProfile(entry)) {
    throw new SingularityFlowError('Playwright offline verification requires the exact deterministic host entry produced by mcp scaffold.', {
      code: 'MCP_HOST_CONFIG_INVALID'
    });
  }
  let acquired;
  try {
    acquired = {
      status: 'reused',
      ...(await inspectPlaywrightPackage(root, playwrightPackageDirectory(root), {
        platform, windowsAcl
      }))
    };
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_PATH_UNSAFE') throw error;
    throw new SingularityFlowError(
      `The exact Playwright MCP package is not available in Git-local machine state. Run singularity-flow mcp warm ${serverId} --network first.`,
      { code: 'MCP_WARM_REQUIRED', cause: error }
    );
  }
  const runtime = await resolvePlaywrightAuthRuntime(root, entry, { platform, windowsAcl });
  const hostArguments = await playwrightRuntimeArguments(root, runtime.entry);
  await beforeLaunchValidation?.({
    packageDirectory: resolveLocalMcpPath(root, acquired.package?.directory)
  });
  acquired = await revalidatePackage(root, acquired, { platform, windowsAcl });
  const offline = await offlineStart(
    acquired.absoluteExecutable,
    hostArguments,
    { runtimeExecutable, platform, environment, spawnCommand, cwd: root }
  );
  if (offline?.status !== 'passed') {
    throw new SingularityFlowError('The acquired Playwright MCP package did not pass offline start verification.', {
      code: 'MCP_WARM_OFFLINE_START_FAILED'
    });
  }
  return writePlaywrightWarmReceipt(root, {
    server, entry, acquired, offline, runtime, runtimeExecutable, runtimeVersion,
    platform, architecture
  });
}

async function readReceipt(root, serverId) {
  try { return await readPrivateRecord(root, receiptPath(root, serverId), 'mcp-host-receipt'); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { error: error.message }; }
}

async function readWarmReceipt(root, serverId) {
  try { return await readPrivateRecord(root, warmReceiptPath(root, serverId), 'mcp-host-receipt'); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { error: error.message }; }
}

function staleWarm(reason, receipt = null) {
  return {
    status: 'stale',
    reason,
    checkedAt: receipt?.checkedAt ?? null,
    packageVersion: receipt?.package?.version ?? null
  };
}

function inspectionMatchesWarmReceipt(installed, receipt) {
  return installed.package.integrity === receipt.package.integrity
    && canonicalJson(installed.package.closure) === canonicalJson(receipt.package.closure)
    && installed.resolvedExecutable.path === receipt.resolvedExecutable?.path
    && installed.resolvedExecutable.sha256 === receipt.resolvedExecutable?.sha256;
}

async function playwrightWarmReadiness(root, server, entry, {
  platform = process.platform,
  architecture = process.arch,
  runtimeExecutable = process.execPath,
  runtimeVersion = process.version,
  windowsAcl
} = {}) {
  let authProfile;
  try { authProfile = await currentPlaywrightAuthBinding(root, { platform, windowsAcl }); }
  catch (error) { return staleWarm(`The managed authentication profile is invalid: ${error.code ?? 'MCP_AUTH_PROFILE_INVALID'}.`); }
  const receipt = await readWarmReceipt(root, server.id);
  if (!receipt) return { status: 'not-warmed', reason: 'The exact package has not been acquired and verified on this machine.' };
  if (receipt.error) return staleWarm(`The package warm receipt is unreadable: ${receipt.error}`);
  if (receipt.receiptKind !== 'package-warm') {
    return staleWarm('The previous warm receipt only checked registry availability; rerun mcp warm to acquire and verify the package.', receipt);
  }
  if (receipt.serverId !== server.id || receipt.hostReference !== server.hostReference
      || receipt.hostEntrySha256 !== recordSha256(entry)
      || receipt.policySha256 !== policyHash(server)
      || canonicalJson(receipt.authProfile ?? null) !== canonicalJson(authProfile)) {
    return staleWarm('The package warm receipt no longer matches the governed host entry, policy, or authentication profile.', receipt);
  }
  const checkedAt = Date.parse(receipt.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > Date.now() + 60_000) {
    return staleWarm('The package warm receipt has an invalid timestamp.', receipt);
  }
  if (receipt.package?.name !== PLAYWRIGHT_PACKAGE
      || receipt.package?.version !== MCP_SCAFFOLD_VERSIONS.playwright
      || !PACKAGE_INTEGRITY.test(receipt.package?.integrity ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(receipt.package?.closure?.sha256 ?? '')
      || !Number.isSafeInteger(receipt.package?.closure?.fileCount)
      || receipt.package.closure.fileCount < 1
      || !Number.isSafeInteger(receipt.package?.closure?.totalBytes)
      || receipt.package.closure.totalBytes < 1) {
    return staleWarm('The package warm receipt does not bind the exact reviewed package and integrity.', receipt);
  }
  if (receipt.runtime?.platform !== platform || receipt.runtime?.architecture !== architecture
      || receipt.runtime?.nodeVersion !== runtimeVersion
      || receipt.runtime?.executable !== runtimeExecutable) {
    return staleWarm('The Node runtime changed after the package offline-start verification.', receipt);
  }
  if (receipt.offlineStart?.status !== 'passed' || receipt.offlineStart?.npmOffline !== true
      || receipt.offlineStart?.packageResolution !== 'local-install'
      || REQUIRED_SMOKE_TOOLS.some((tool) => !receipt.offlineStart?.tools?.includes(tool))) {
    return staleWarm('The receipt has no complete offline MCP start verification.', receipt);
  }
  const packageDirectory = resolveLocalMcpPath(root, receipt.package.directory);
  if (!packageDirectory) return staleWarm('The package warm receipt contains an invalid machine-local package path.', receipt);
  try {
    const installed = await inspectPlaywrightPackage(root, packageDirectory, {
      platform, windowsAcl
    });
    if (!inspectionMatchesWarmReceipt(installed, receipt)) {
      return staleWarm('The acquired package or its executable changed after offline verification.', receipt);
    }
  } catch {
    return staleWarm('The acquired package is missing, incomplete, or no longer matches its lock.', receipt);
  }
  return {
    status: 'valid',
    reason: 'The exact package is installed locally and passed an offline MCP start handshake.',
    checkedAt: receipt.checkedAt,
    packageVersion: receipt.package.version,
    integrity: receipt.package.integrity,
    resolvedExecutable: receipt.resolvedExecutable.path,
    offlineStart: {
      status: receipt.offlineStart.status,
      protocolVersion: receipt.offlineStart.protocolVersion ?? null
    }
  };
}

async function managedPlaywrightSmokeRuntime(root, server, entry, options = {}) {
  const warm = await playwrightWarmReadiness(root, server, entry, options);
  if (warm.status !== 'valid') {
    throw new SingularityFlowError(
      `Playwright live smoke requires a valid exact-package warm proof (${warm.status}: ${warm.reason}). Run singularity-flow mcp verify-offline playwright if the package is already present, or singularity-flow mcp warm playwright --network.`,
      { code: 'MCP_WARM_REQUIRED' }
    );
  }
  const receipt = await readWarmReceipt(root, server.id);
  const packageDirectory = resolveLocalMcpPath(root, receipt?.package?.directory);
  if (!packageDirectory) {
    throw new SingularityFlowError('The Playwright warm proof contains an invalid package location.', {
      code: 'MCP_WARM_REQUIRED'
    });
  }
  const platform = options.platform ?? process.platform;
  const windowsAcl = options.windowsAcl ?? secureWindowsAuthAcl;
  const installed = await inspectPlaywrightPackage(root, packageDirectory, {
    platform, windowsAcl
  });
  if (!inspectionMatchesWarmReceipt(installed, receipt)) {
    throw new SingularityFlowError(
      'The acquired Playwright MCP package changed after its warm proof was checked.',
      { code: 'MCP_WARM_PACKAGE_CHANGED' }
    );
  }
  const runtime = await resolvePlaywrightAuthRuntime(root, entry, {
    platform, windowsAcl
  });
  const hostArguments = await playwrightRuntimeArguments(root, runtime.entry);
  const revalidateBeforeSpawn = async () => {
    await options.beforeLaunchValidation?.({ packageDirectory });
    const observed = await revalidatePlaywrightInspection(root, installed, {
      platform, windowsAcl
    });
    if (!inspectionMatchesWarmReceipt(observed, receipt)) {
      throw new SingularityFlowError(
        'The acquired Playwright MCP package changed after its warm proof was checked.',
        { code: 'MCP_WARM_PACKAGE_CHANGED' }
      );
    }
    return {
      kind: 'managed-playwright',
      runtimeExecutable: options.runtimeExecutable ?? process.execPath,
      resolvedExecutable: observed.absoluteExecutable,
      hostArguments,
      package: observed.package,
      resolvedExecutableSha256: observed.resolvedExecutable.sha256
    };
  };
  return {
    launch: {
      kind: 'managed-playwright',
      runtimeExecutable: options.runtimeExecutable ?? process.execPath,
      resolvedExecutable: installed.absoluteExecutable,
      hostArguments,
      package: installed.package,
      resolvedExecutableSha256: installed.resolvedExecutable.sha256,
      revalidateBeforeSpawn
    },
    authProfile: runtime.authProfile
  };
}

/** Transparently host the exact warmed Playwright package for VS Code or Copilot stdio. */
export async function serveMcpHost(root, definition, serverId, {
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
  runtimeExecutable = process.execPath,
  runtimeVersion = process.version,
  spawnCommand = spawn,
  terminateTree = signalProcessTree,
  processControl = process,
  windowsAcl,
  beforeLaunchValidation
} = {}) {
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  if (serverId !== 'playwright') {
    throw new SingularityFlowError(`No managed stdio launcher is available for '${serverId}'.`, {
      code: 'MCP_SERVE_UNSUPPORTED'
    });
  }
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  if (!managedPlaywrightHostEntry(entry)) {
    throw new SingularityFlowError(
      `Playwright host entry is not managed by SFlow. Run singularity-flow mcp scaffold playwright --replace-server and review the change.`,
      { code: 'MCP_HOST_CONFIG_INVALID' }
    );
  }
  const runtime = await managedPlaywrightSmokeRuntime(root, server, entry, {
    platform, architecture, runtimeExecutable, runtimeVersion, windowsAcl,
    beforeLaunchValidation
  });
  const launchRuntime = await runtime.launch.revalidateBeforeSpawn();
  const launch = resolvePlatformProcess(
    launchRuntime.runtimeExecutable,
    [launchRuntime.resolvedExecutable, ...launchRuntime.hostArguments],
    { platform, environment }
  );
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCommand(launch.executable, launch.arguments, {
        cwd: root,
        stdio: ['inherit', 'inherit', 'inherit'],
        env: {
          ...environment,
          NPM_CONFIG_OFFLINE: 'true',
          npm_config_offline: 'true',
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
        },
        windowsHide: true,
        detached: platform !== 'win32',
        ...launch.spawnOptions
      });
    } catch (error) {
      reject(new SingularityFlowError('The acquired Playwright MCP package could not be started.', {
        code: 'MCP_SERVE_FAILED', cause: error
      }));
      return;
    }
    let stopSignal = null;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) processControl.removeListener?.(signal, handler);
    };
    for (const signal of signals) {
      const handler = () => {
        if (stopSignal) return;
        stopSignal = signal;
        void terminateTree(child, signal === 'SIGINT' ? 'SIGTERM' : signal, {
          platform, timeoutMs: 1_000
        }).catch(() => false);
      };
      handlers.set(signal, handler);
      processControl.once?.(signal, handler);
    }
    child.once('error', (error) => {
      cleanup();
      reject(new SingularityFlowError('The acquired Playwright MCP package failed to start.', {
        code: 'MCP_SERVE_FAILED', cause: error
      }));
    });
    child.once('close', (code, signal) => {
      cleanup();
      if (stopSignal) resolve({ status: 'stopped', serverId, signal: stopSignal });
      else if (code === 0) resolve({ status: 'closed', serverId });
      else reject(new SingularityFlowError(
        `The acquired Playwright MCP package exited unexpectedly (${signal ?? code ?? 'unknown'}).`,
        { code: 'MCP_SERVE_FAILED' }
      ));
    });
  });
}

function matchingHostRows(rows, server) {
  return rows.filter((row) => row.name === server.hostReference);
}

function policyHash(server) { return recordSha256(server); }

function finalUrlFromSnapshotResult(snapshotResult) {
  const text = (snapshotResult?.content ?? [])
    .filter((entry) => entry?.type === 'text')
    .map((entry) => entry.text)
    .join('\n');
  const reported = text.match(/Page URL:\s*(\S+)/i)?.[1] ?? null;
  if (!reported) {
    throw new SingularityFlowError('The exact MCP snapshot result does not report its final URL.', {
      code: 'MCP_EVIDENCE_OBSERVATION_REQUIRED'
    });
  }
  return safeMcpTargetUrl(reported, { label: 'MCP snapshot observed final URL' });
}

export function rpcSmoke(runtime, options = {}) {
  const {
    url,
    cwd,
    timeoutMs = 45_000,
    platform = process.platform,
    environment = process.env,
    spawnCommand = spawn,
    treeSpawnCommand = spawn,
    killProcess = process.kill,
    terminateTree = signalProcessTree,
    terminationGraceMs = 1_000,
    outputMaxBytes = MCP_SMOKE_OUTPUT_MAX_BYTES,
    lineMaxBytes = MCP_SMOKE_LINE_MAX_BYTES,
    launchRevalidated = false
  } = options;
  const absoluteExecutable = platform === 'win32'
    ? path.win32.isAbsolute(runtime?.resolvedExecutable ?? '')
    : path.posix.isAbsolute(runtime?.resolvedExecutable ?? '');
  if (runtime?.kind !== 'managed-playwright'
      || typeof runtime.runtimeExecutable !== 'string' || !runtime.runtimeExecutable
      || typeof runtime.resolvedExecutable !== 'string' || !absoluteExecutable
      || !Array.isArray(runtime.hostArguments)
      || runtime.hostArguments.some((argument) => typeof argument !== 'string')
      || runtime.package?.name !== PLAYWRIGHT_PACKAGE
      || runtime.package?.version !== MCP_SCAFFOLD_VERSIONS.playwright
      || !PACKAGE_INTEGRITY.test(runtime.package?.integrity ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(runtime.package?.closure?.sha256 ?? '')
      || !Number.isSafeInteger(runtime.package?.closure?.fileCount)
      || !Number.isSafeInteger(runtime.package?.closure?.totalBytes)
      || !/^[a-f0-9]{64}$/.test(runtime.resolvedExecutableSha256 ?? '')) {
    throw new SingularityFlowError(
      'The live Playwright smoke test requires the exact acquired package and a valid machine-local warm proof.',
      { code: 'MCP_SMOKE_UNSUPPORTED_HOST' }
    );
  }
  if (!launchRevalidated && typeof runtime.revalidateBeforeSpawn === 'function') {
    return Promise.resolve()
      .then(() => runtime.revalidateBeforeSpawn())
      .then((observed) => rpcSmoke(observed, { ...options, launchRevalidated: true }));
  }
  return new Promise((resolve, reject) => {
    const launch = resolvePlatformProcess(
      runtime.runtimeExecutable,
      [runtime.resolvedExecutable, ...runtime.hostArguments],
      { platform, environment }
    );
    const child = spawnCommand(launch.executable, launch.arguments, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...environment,
        NPM_CONFIG_OFFLINE: 'true',
        npm_config_offline: 'true',
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
      },
      windowsHide: true,
      detached: platform !== 'win32',
      ...launch.spawnOptions
    });
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    let finishing = false;
    let processClosed = false;
    const closeWaiters = new Set();
    const waitForClose = (milliseconds) => {
      if (processClosed) return Promise.resolve(true);
      return new Promise((resolveClose) => {
        const complete = (value) => {
          clearTimeout(closeTimer);
          closeWaiters.delete(complete);
          resolveClose(value);
        };
        const closeTimer = setTimeout(() => complete(false), milliseconds);
        closeWaiters.add(complete);
      });
    };
    const finish = async (error, value = null) => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      for (const waiter of pending.values()) waiter.reject(error ?? new Error('MCP smoke transport closed.'));
      pending.clear();
      const grace = Math.max(10, Math.min(5_000, Number(terminationGraceMs) || 1_000));
      await terminateTree(child, 'SIGTERM', {
        platform, spawnCommand: treeSpawnCommand, killProcess, timeoutMs: Math.ceil(grace / 2)
      }).catch(() => false);
      let closed = await waitForClose(Math.ceil(grace / 2));
      if (!closed) {
        await terminateTree(child, 'SIGKILL', {
          platform, spawnCommand: treeSpawnCommand, killProcess, timeoutMs: Math.ceil(grace / 2)
        }).catch(() => false);
        closed = await waitForClose(Math.ceil(grace / 2));
      }
      settled = true;
      finishing = false;
      if (!closed && !error) {
        error = new SingularityFlowError(
          'Playwright MCP smoke completed, but process-tree quiescence could not be verified.',
          { code: 'MCP_SMOKE_FAILED' }
        );
      }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { void finish(new SingularityFlowError(
      'Playwright MCP smoke test timed out.', { code: 'MCP_SMOKE_FAILED' }
    )); }, timeoutMs);
    let stderrBytes = 0;
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > 4096) void finish(new SingularityFlowError(
        'Playwright MCP smoke exceeded its diagnostic output ceiling.',
        { code: 'MCP_SMOKE_FAILED' }
      ));
    });
    child.on('error', (error) => { void finish(new SingularityFlowError(
      `Could not start the acquired Playwright MCP package: ${error.message}`,
      { code: 'MCP_SMOKE_FAILED', cause: error }
    )); });
    child.on('exit', (code) => {
      if (!settled && !finishing) void finish(new SingularityFlowError(
        `Playwright MCP exited before its smoke test completed (${code}).`,
        { code: 'MCP_SMOKE_FAILED' }
      ));
    });
    child.on('close', () => {
      processClosed = true;
      for (const waiter of [...closeWaiters]) waiter(true);
    });
    const boundedOutput = Math.max(1, Number(outputMaxBytes) || MCP_SMOKE_OUTPUT_MAX_BYTES);
    const boundedLine = Math.max(1, Math.min(
      boundedOutput, Number(lineMaxBytes) || MCP_SMOKE_LINE_MAX_BYTES
    ));
    const decoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stdoutLine = '';
    const acceptLine = (line) => {
      if (settled || finishing || !line.trim()) return;
      if (Buffer.byteLength(line, 'utf8') > boundedLine) {
        void finish(new SingularityFlowError(
          `Playwright MCP emitted a line larger than the ${boundedLine}-byte smoke ceiling.`,
          { code: 'MCP_SMOKE_FAILED' }
        ));
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch (error) {
        void finish(new SingularityFlowError(
          'Playwright MCP emitted malformed JSON during smoke.',
          { code: 'MCP_SMOKE_FAILED', cause: error }
        ));
        return;
      }
      if (message.id == null || !pending.has(message.id)) return;
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter.reject(new SingularityFlowError(`MCP ${waiter.method} failed: ${message.error.message ?? 'unknown error'}`, { code: 'MCP_SMOKE_FAILED' }));
      else waiter.resolve(message.result);
    };
    child.stdout.on('data', (chunk) => {
      if (settled || finishing) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > boundedOutput) {
        void finish(new SingularityFlowError(
          `Playwright MCP exceeded the ${boundedOutput}-byte smoke output ceiling.`,
          { code: 'MCP_SMOKE_FAILED' }
        ));
        return;
      }
      stdoutLine += decoder.write(bytes);
      let newline;
      while (!finishing && (newline = stdoutLine.indexOf('\n')) >= 0) {
        const line = stdoutLine.slice(0, newline).replace(/\r$/, '');
        stdoutLine = stdoutLine.slice(newline + 1);
        acceptLine(line);
      }
      if (!finishing && Buffer.byteLength(stdoutLine, 'utf8') > boundedLine) {
        void finish(new SingularityFlowError(
          `Playwright MCP emitted a line larger than the ${boundedLine}-byte smoke ceiling.`,
          { code: 'MCP_SMOKE_FAILED' }
        ));
      }
    });
    child.stdout.on('error', (error) => { void finish(new SingularityFlowError(
      `Playwright MCP output failed during smoke: ${error.message}`,
      { code: 'MCP_SMOKE_FAILED', cause: error }
    )); });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++; pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
      send({ jsonrpc: '2.0', id, method, params });
    });
    (async () => {
      const initialized = await request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'singularity-flow-smoke', version: '1' }
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      const catalog = await request('tools/list');
      const names = new Set((catalog?.tools ?? []).map((tool) => tool.name));
      for (const tool of REQUIRED_SMOKE_TOOLS) {
        if (!names.has(tool)) throw new SingularityFlowError(`Playwright MCP smoke test requires tool '${tool}'.`, { code: 'MCP_SMOKE_FAILED' });
      }
      let snapshotResult = null;
      for (const [name, args] of [['browser_navigate', { url: url.toString() }], ['browser_snapshot', {}]]) {
        const result = await request('tools/call', { name, arguments: args });
        if (result?.isError) throw new SingularityFlowError(`Playwright MCP ${name} returned an error.`, { code: 'MCP_SMOKE_FAILED' });
        if (name === 'browser_snapshot') snapshotResult = result;
      }
      const snapshotText = (snapshotResult?.content ?? []).filter((entry) => entry?.type === 'text').map((entry) => entry.text).join('\n');
      const reportedUrl = snapshotText.match(/Page URL:\s*(\S+)/i)?.[1] ?? null;
      if (!reportedUrl) {
        throw new SingularityFlowError('Playwright MCP smoke could not verify the browser final URL.', { code: 'MCP_SMOKE_ORIGIN_UNKNOWN' });
      }
      const finalUrl = safeMcpTargetUrl(reportedUrl, { label: 'Playwright MCP final URL' });
      const finalOrigin = finalUrl.origin;
      if (finalOrigin !== url.origin) {
        throw new SingularityFlowError(`Playwright MCP smoke redirected outside the authorized origin (${url.origin}).`, { code: 'MCP_SMOKE_ORIGIN_DRIFT' });
      }
      await request('tools/call', { name: 'browser_close', arguments: {} }).catch(() => null);
      void finish(null, {
        status: 'passed', tools: [...REQUIRED_SMOKE_TOOLS],
        finalUrl: finalUrl.toString(), finalOrigin,
        protocolVersion: initialized?.protocolVersion ?? null,
        snapshotResult
      });
    })().catch((error) => { void finish(error?.code ? error : new SingularityFlowError(`Playwright MCP smoke test failed: ${error.message}`, { code: 'MCP_SMOKE_FAILED', cause: error })); });
  });
}

export async function smokeMcpHost(root, definition, serverId, {
  targetUrl, probe = rpcSmoke, evidence = null,
  platform = process.platform, architecture = process.arch,
  environment = process.env, runtimeExecutable = process.execPath,
  runtimeVersion = process.version, spawnCommand = spawn, windowsAcl,
  beforeLaunchValidation
} = {}) {
  const server = evidence?.workflow?.resolution?.mcpServers?.[serverId]
    ?? definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  if (!targetUrl) throw new SingularityFlowError('MCP smoke requires --url with an authorized HTTPS or loopback target.', { code: 'MCP_SMOKE_URL_REQUIRED' });
  const url = safeMcpTargetUrl(targetUrl, { label: 'MCP smoke URL' });
  if (evidence?.workflow) {
    const authorizedOrigins = authorizedMcpOrigins(evidence.workflow, serverId);
    if (authorizedOrigins.length && !authorizedOrigins.includes(url.origin)) {
      throw new SingularityFlowError(
        `MCP smoke target origin '${url.origin}' is outside this Story's authorization.`,
        { code: 'MCP_EVIDENCE_TARGET_UNAUTHORIZED' }
      );
    }
  }
  const entry = (await hostEntryMap(root)).get(server.hostReference);
  if (!entry) throw new SingularityFlowError(`Host entry '${server.hostReference}' is absent.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  let runtime;
  let probeInput;
  if (serverId === 'playwright' && probe === rpcSmoke) {
    runtime = await managedPlaywrightSmokeRuntime(root, server, entry, {
      platform, architecture, runtimeExecutable, runtimeVersion, windowsAcl,
      beforeLaunchValidation
    });
    probeInput = runtime.launch;
  } else {
    runtime = serverId === 'playwright'
      ? await resolvePlaywrightAuthRuntime(root, entry, { platform, windowsAcl })
      : { entry, authProfile: null };
    probeInput = runtime.entry;
  }
  const result = await probe(probeInput, {
    url, server, cwd: root, platform, environment, spawnCommand
  });
  if (result?.status !== 'passed') throw new SingularityFlowError(`MCP smoke test failed for '${serverId}'.`, { code: 'MCP_SMOKE_FAILED' });
  const observedFinalUrl = evidence?.workflow
    ? finalUrlFromSnapshotResult(result.snapshotResult)
    : safeMcpTargetUrl(result.finalUrl, { label: 'MCP smoke observed final URL' });
  const finalOrigin = normalizeMcpTargetOrigin(result.finalOrigin, {
    required: true,
    label: 'MCP smoke final origin'
  });
  if (observedFinalUrl.origin !== finalOrigin || finalOrigin !== url.origin) {
    throw new SingularityFlowError(`MCP smoke ended outside the authorized origin (${url.origin}).`, { code: 'MCP_SMOKE_ORIGIN_DRIFT' });
  }
  const tools = new Set(result.tools ?? []);
  if (REQUIRED_SMOKE_TOOLS.some((tool) => !tools.has(tool))) {
    throw new SingularityFlowError('MCP smoke did not exercise the complete required browser tool set.', { code: 'MCP_SMOKE_INCOMPLETE' });
  }
  const { snapshotResult, ...receiptResult } = result;
  const receipt = {
    schemaVersion: currentSchemaVersion('mcp-observation-receipt'),
    serverId,
    hostReference: server.hostReference,
    checkedAt: nowIso(),
    authorizedOrigin: url.origin,
    requestedUrlSha256: recordSha256(url.toString()),
    hostEntrySha256: recordSha256(entry),
    policySha256: policyHash(server),
    authProfile: runtime.authProfile,
    result: {
      ...receiptResult,
      finalUrl: undefined,
      finalUrlSha256: recordSha256(observedFinalUrl.toString())
    }
  };
  const file = smokeReceiptPath(root, serverId);
  await writePrivateJson(root, file, receipt);
  let evidenceRecord = null;
  if (evidence?.workflow) {
    if (!snapshotResult) {
      throw new SingularityFlowError('The MCP host did not return an exact snapshot result for evidence capture.', {
        code: 'MCP_EVIDENCE_OBSERVATION_REQUIRED'
      });
    }
    evidenceRecord = await recordObservedMcpBrowserCapture(root, evidence.workflow, {
      server: serverId,
      phase: evidence.phase,
      agent: evidence.agent,
      actor: evidence.actor,
      targetUrl: url.toString(),
      observedFinalUrl: observedFinalUrl.toString(),
      snapshotResult,
      smokeReceipt: receipt,
      itemDirectory: evidence.itemDirectory ?? null
    });
  }
  return { ...receipt, path: file, evidence: evidenceRecord };
}

async function readSmokeReceipt(root, serverId) {
  try { return await readPrivateRecord(root, smokeReceiptPath(root, serverId), 'mcp-observation-receipt'); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { error: error.message }; }
}

function validSmokeReceipt(receipt, { serverId, configured, expectedOrigins, now = Date.now() }) {
  if (!receipt || receipt.error || receipt.serverId !== serverId
    || receipt.hostReference !== configured.hostReference || receipt.result?.status !== 'passed'
    || !Array.isArray(receipt.result?.tools)
    || !/^[a-f0-9]{64}$/.test(receipt.requestedUrlSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(receipt.result?.finalUrlSha256 ?? '')
    || REQUIRED_SMOKE_TOOLS.some((tool) => !receipt.result.tools.includes(tool))) {
    return { valid: false, reason: 'receipt structure or server identity is invalid' };
  }
  let origin;
  try { origin = safeMcpTargetUrl(receipt.authorizedOrigin, { label: 'MCP smoke receipt origin' }).origin; }
  catch { return { valid: false, reason: 'receipt origin is invalid' }; }
  let finalOrigin;
  try { finalOrigin = safeMcpTargetUrl(receipt.result.finalOrigin, { label: 'MCP smoke receipt final origin' }).origin; }
  catch { return { valid: false, reason: 'receipt final origin is invalid' }; }
  if (finalOrigin !== origin) return { valid: false, reason: 'receipt final origin differs from its authorized origin' };
  if (expectedOrigins.length && !expectedOrigins.includes(origin)) {
    return { valid: false, reason: `receipt origin '${origin}' is not authorized for this Story` };
  }
  const checkedAt = Date.parse(receipt.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt > now + 60_000 || now - checkedAt > MCP_SMOKE_MAX_AGE_MS) {
    return { valid: false, reason: 'receipt is older than 24 hours or has an invalid timestamp' };
  }
  return { valid: true, origin };
}

export async function assertMcpPhaseReadiness(root, workflow, phase) {
  const policy = phase?.mcp ?? { requiredServers: [], requireSmoke: false };
  if (!policy.requiredServers?.length) return { servers: [] };
  const definition = { mcpServers: workflow.resolution?.mcpServers ?? {} };
  const report = await mcpDoctor(root, definition);
  const errors = [];
  const servers = [];
  for (const serverId of policy.requiredServers) {
    const configured = definition.mcpServers[serverId];
    const status = report.servers.find((entry) => entry.id === serverId);
    if (!configured || !status) errors.push(`Required MCP server '${serverId}' is not pinned in this Story.`);
    else if (status.readiness !== 'ready') errors.push(`MCP server '${serverId}' is ${status.readiness}: ${status.reasons.join(' ')}`);
    if (configured && serverId === 'playwright' && status?.warm?.status !== 'valid') {
      errors.push(
        `MCP server '${serverId}' has no valid exact-package warm proof (${status?.warm?.status ?? 'unavailable'}${status?.warm?.reason ? `: ${status.warm.reason}` : ''}). Run singularity-flow mcp verify-offline ${serverId} if its package is already acquired, or singularity-flow mcp warm ${serverId} --network.`
      );
    }
    let smoke = null;
    if (configured && policy.requireSmoke) {
      const expectedOrigins = authorizedMcpOrigins(workflow, serverId);
      if (!expectedOrigins.length) errors.push(`MCP server '${serverId}' has no Story-pinned authorized origin.`);
      smoke = await readSmokeReceipt(root, serverId);
      if (!smoke || smoke.error) errors.push(`MCP server '${serverId}' has no successful live smoke receipt. Run singularity-flow mcp smoke ${serverId} --url <AUTHORIZED_URL>.`);
      else {
        const validity = validSmokeReceipt(smoke, { serverId, configured, expectedOrigins });
        if (!validity.valid || smoke.hostEntrySha256 !== status?.host?.entrySha256
            || smoke.policySha256 !== status?.policy?.sha256
            || canonicalJson(smoke.authProfile ?? null) !== canonicalJson(status?.auth?.binding ?? null)) {
          errors.push(`MCP server '${serverId}' live smoke receipt is stale or unsuccessful${validity.reason ? `: ${validity.reason}` : ''}.`);
        }
      }
    }
    servers.push({ ...status, smoke });
  }
  if (errors.length) throw new SingularityFlowError(`Phase '${phase.id}' MCP readiness is blocked:\n- ${errors.join('\n- ')}`, { code: 'MCP_PHASE_NOT_READY', details: { phase: phase.id, errors } });
  return { servers };
}

export async function attestMcpHost(root, definition, serverId, {
  confirmation, platform = process.platform, windowsAcl
} = {}) {
  if (confirmation !== serverId) {
    throw new SingularityFlowError(`Re-run with --confirm ${serverId} after starting, trusting, and authenticating the server in the host.`, {
      code: 'MCP_ATTESTATION_CONFIRMATION_REQUIRED'
    });
  }
  const server = definition.mcpServers?.[serverId];
  if (!server) throw new SingularityFlowError(`Unknown governed MCP server '${serverId}'.`, { code: 'MCP_SERVER_UNKNOWN' });
  const rows = matchingHostRows(await inspectMcpHostEntries(root), server);
  if (!rows.length) throw new SingularityFlowError(`Host entry '${server.hostReference}' is not configured.`, { code: 'MCP_HOST_CONFIG_MISSING' });
  if (rows.some((row) => row.error || !row.structurallyValid)) throw new SingularityFlowError(`Host entry '${server.hostReference}' is invalid.`, { code: 'MCP_HOST_CONFIG_INVALID' });
  const hashes = new Set(rows.map((row) => row.entrySha256));
  if (hashes.size !== 1) throw new SingularityFlowError(`Host entry '${server.hostReference}' differs across host configuration sources.`, { code: 'MCP_HOST_ENTRY_CONFLICT' });
  const actor = identity(root);
  const authProfile = serverId === 'playwright'
    ? await currentPlaywrightAuthBinding(root, { platform, windowsAcl })
    : null;
  const receipt = {
    schemaVersion: currentSchemaVersion('mcp-host-receipt'),
    receiptKind: 'host-attestation',
    serverId,
    hostReference: server.hostReference,
    hostSource: rows[0].surface,
    hostEntrySha256: rows[0].entrySha256,
    policySha256: policyHash(server),
    authProfile,
    confirmedAt: nowIso(),
    confirmedBy: { name: actor.name ?? null, email: actor.email ?? null },
    confirmation: 'The server was started, trusted, and authenticated in the host.'
  };
  const file = receiptPath(root, serverId);
  await writePrivateJson(root, file, receipt);
  return { ...receipt, path: file };
}

export async function mcpDoctor(root, definition, options = {}) {
  const hostRows = await inspectMcpHostEntries(root, options);
  const entries = await hostEntryMap(root, options);
  const globalErrors = hostRows.filter((row) => row.error).map((row) => `${row.surface}: ${row.error}`);
  const servers = [];
  for (const server of Object.values(definition.mcpServers ?? {})) {
    const reasons = [];
    let readiness = 'ready';
    const auth = server.id === 'playwright'
      ? await playwrightAuthProfileStatus(root, {
        platform: options.platform ?? process.platform, windowsAcl: options.windowsAcl
      })
      : { status: 'not-applicable', serverId: server.id, profileId: null, storageStateSha256: null };
    const rows = matchingHostRows(hostRows, server);
    if (globalErrors.length) {
      readiness = 'misconfigured';
      reasons.push(...globalErrors);
    } else if (!rows.length) {
      readiness = 'needs-host-setup';
      reasons.push(`Host entry '${server.hostReference}' is absent.`);
    } else if (rows.some((row) => !row.structurallyValid)) {
      readiness = 'misconfigured';
      reasons.push(`Host entry '${server.hostReference}' is structurally invalid.`);
    } else if (new Set(rows.map((row) => row.entrySha256)).size > 1) {
      readiness = 'misconfigured';
      reasons.push(`Host entry '${server.hostReference}' conflicts across host sources.`);
    } else if (server.id === 'playwright' && rows.some((row) => !row.exactPackagePin)) {
      readiness = 'misconfigured';
      reasons.push(`Playwright scaffold must use @playwright/mcp@${MCP_SCAFFOLD_VERSIONS.playwright}.`);
    } else if (server.id === 'playwright' && !deterministicPlaywrightProfile(entries.get(server.hostReference))) {
      readiness = 'misconfigured';
      reasons.push('Playwright host entry must use the deterministic isolated/headless output, viewport, and timeout profile produced by mcp scaffold.');
    } else if (auth.status === 'invalid') {
      readiness = 'misconfigured';
      reasons.push(`Managed Playwright authentication profile is invalid (${auth.reason}).`);
    } else if (server.id === 'playwright' && auth.status === 'configured'
        && !managedPlaywrightHostEntry(entries.get(server.hostReference))) {
      readiness = 'misconfigured';
      reasons.push('Managed Playwright authentication requires the SFlow host wrapper. Run singularity-flow mcp scaffold playwright --replace-server and review the change.');
    } else {
      const receipt = await readReceipt(root, server.id);
      if (!receipt || receipt.error || receipt.receiptKind !== 'host-attestation') {
        readiness = 'needs-host-setup';
        reasons.push('Host readiness has not been attested on this machine.');
      } else if (receipt.hostEntrySha256 !== rows[0].entrySha256
          || receipt.policySha256 !== policyHash(server)
          || canonicalJson(receipt.authProfile ?? null) !== canonicalJson(
            auth.status === 'configured'
              ? { profileId: auth.profileId, storageStateSha256: auth.storageStateSha256 }
              : null
          )) {
        readiness = 'needs-host-setup';
        reasons.push('Host readiness attestation is stale because host, policy, or authentication profile configuration changed.');
      }
    }
    const warm = server.id === 'playwright' && entries.get(server.hostReference)
      ? await playwrightWarmReadiness(root, server, entries.get(server.hostReference), options)
      : { status: 'not-applicable', reason: null };
    if (server.id === 'playwright' && entries.get(server.hostReference)
        && warm.status !== 'valid' && readiness !== 'misconfigured') {
      readiness = 'needs-host-setup';
      reasons.push(
        `Exact Playwright package warm proof is ${warm.status}: ${warm.reason} `
        + 'Run singularity-flow mcp verify-offline playwright if the package is already present, '
        + 'or singularity-flow mcp warm playwright --network.'
      );
    }
    let network = { status: 'not-checked' };
    if (options.network && rows.length && rows.every((row) => row.structurallyValid)) {
      try {
        network = await (options.probe ?? defaultNetworkProbe)(entries.get(server.hostReference), {
          server,
          platform: options.platform ?? process.platform,
          environment: options.environment ?? process.env,
          execFileCommand: options.execFileCommand ?? execFileAsync
        });
      }
      catch (error) { network = { status: 'failed', reason: error.code ?? error.name ?? 'network-error', message: error.message }; }
      if (network.status === 'failed') { readiness = 'misconfigured'; reasons.push(`Network probe failed: ${network.message ?? network.reason ?? 'unreachable'}.`); }
    }
    servers.push({
      id: server.id,
      hostReference: server.hostReference,
      readiness,
      reasons,
      host: { sources: rows.map((row) => row.surface), entrySha256: rows[0]?.entrySha256 ?? null },
      policy: { sha256: policyHash(server), required: server.required },
      auth: {
        status: auth.status,
        binding: auth.status === 'configured'
          ? { profileId: auth.profileId, storageStateSha256: auth.storageStateSha256 }
          : null,
        reason: auth.reason ?? null
      },
      warm,
      network
    });
  }
  const rank = { ready: 0, 'needs-host-setup': 1, misconfigured: 2 };
  const overallReadiness = servers.reduce((current, server) =>
    rank[server.readiness] > rank[current] ? server.readiness : current, 'ready');
  return { schemaVersion: 1, generatedAt: nowIso(), networkChecked: Boolean(options.network), overallReadiness, servers };
}
