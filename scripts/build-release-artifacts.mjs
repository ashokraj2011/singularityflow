#!/usr/bin/env node
/**
 * Build the release artifact pair once from exact Git subjects and sign its immutable receipt.
 *
 * The npm archive is never allowed to inspect checkout bytes. Its input tree is materialized from
 * HEAD blobs and Git modes, then packed by the repository's exact locked npm toolchain. The VSIX
 * builder has its own exact-blob staging and package-input checks; both artifacts are emitted by
 * this single operation and every later platform/release command consumes those same bytes.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stampBuildInfo } from '../src/build-info-stamp.mjs';
import { canonicalJson } from '../src/records.mjs';
import {
  RELEASE_ARTIFACT_RECEIPT_VERSION, signReleaseArtifactReceipt
} from '../src/release-artifact-receipt.mjs';
import { assertReleaseCheckoutClean } from '../src/verification-receipt.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { readSecurePrivateKey } from '../src/secure-private-key.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_INFO_PATH = 'src/build-info.mjs';
const SAFE_MODE = new Map([['100644', 0o644], ['100755', 0o755]]);

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function digestFile(file) {
  return digestBytes(await readFile(file));
}

function git(repository, args, { encoding = 'utf8', input = undefined } = {}) {
  const result = spawnSync('git', args, {
    cwd: repository, encoding, input, maxBuffer: 256 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`Git ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout;
}

function exactGitRoot(repository) {
  let resolved;
  try {
    resolved = realpathSync(repository);
  } catch {
    return false;
  }
  const top = String(git(repository, ['rev-parse', '--show-toplevel'])).trim();
  try {
    return realpathSync(top) === resolved;
  } catch {
    return false;
  }
}

function assertPortablePath(relative, foldedPrefixes) {
  if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error(`Git contains an unsafe release path: ${relative || '<empty>'}.`);
  }
  const components = relative.split('/');
  if (components.some((part) => !part || part === '.' || part === '..'
      || part !== part.normalize('NFC')
      || part.length > 255 || Buffer.byteLength(part, 'utf8') > 255
      || /[<>:"|?*\u0000-\u001f\u007f]/.test(part) || /[ .]$/.test(part)
      || part.toLocaleLowerCase('en-US') === '.git'
      || /^git~[0-9](?:\.|$)/iu.test(part)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) {
    throw new Error(`Git contains a non-portable release path: ${relative}.`);
  }
  for (let length = 1; length <= components.length; length += 1) {
    const canonical = components.slice(0, length).join('/');
    const folded = canonical.toLocaleLowerCase('en-US');
    const prior = foldedPrefixes.get(folded);
    if (prior && prior !== canonical) {
      throw new Error(`Git release paths collide on a case-insensitive filesystem: ${prior} and ${canonical}.`);
    }
    foldedPrefixes.set(folded, canonical);
  }
}

function parseTree(bytes) {
  const entries = [];
  const foldedPrefixes = new Map();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end === -1) throw new Error('Git returned a tree without a NUL terminator.');
    let record;
    try {
      record = decoder.decode(bytes.subarray(offset, end));
    } catch {
      throw new Error('Git release paths must be valid UTF-8.');
    }
    offset = end + 1;
    if (!record) throw new Error('Git returned an empty tree entry.');
    const match = record.match(/^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error('Git returned a malformed tree entry.');
    const [, mode, type, objectId, relative] = match;
    assertPortablePath(relative, foldedPrefixes);
    if (type !== 'blob' || !SAFE_MODE.has(mode)) {
      const reason = mode === '120000' ? 'symbolic link' : `${type} mode ${mode}`;
      throw new Error(`Release source refuses ${reason}: ${relative}.`);
    }
    entries.push({ mode, objectId, relative });
  }
  return entries.sort((left, right) => (
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0
  ));
}

function readBatchObjects(repository, entries) {
  const unique = [...new Set(entries.map((entry) => entry.objectId))];
  const output = git(repository, ['cat-file', '--batch'], {
    encoding: null,
    input: Buffer.from(`${unique.join('\n')}\n`)
  });
  const objects = new Map();
  let offset = 0;
  for (const requested of unique) {
    const end = output.indexOf(0x0a, offset);
    if (end === -1) throw new Error('Git object batch omitted a header terminator.');
    const header = output.subarray(offset, end).toString('utf8');
    const match = header.match(/^([0-9a-f]+) blob (\d+)$/);
    if (!match || match[1] !== requested) throw new Error(`Git object batch returned an invalid object for ${requested}.`);
    const size = Number(match[2]);
    const start = end + 1;
    const finish = start + size;
    if (!Number.isSafeInteger(size) || finish >= output.length || output[finish] !== 0x0a) {
      throw new Error(`Git object ${requested} has a malformed batch payload.`);
    }
    objects.set(requested, output.subarray(start, finish));
    offset = finish + 1;
  }
  if (offset !== output.length) throw new Error('Git object batch returned unexpected trailing bytes.');
  return objects;
}

/** Materialize only exact HEAD blobs and Git executable modes into a new private tree. */
export async function materializeExactHead(repository, destination, { revision = 'HEAD' } = {}) {
  if (!exactGitRoot(repository)) throw new Error('Release artifact materialization requires the exact Git repository root.');
  const targetMetadata = await lstat(destination).catch(() => null);
  if (targetMetadata != null) throw new Error(`Release materialization destination already exists: ${destination}.`);
  const commit = String(git(repository, ['rev-parse', '--verify', revision])).trim();
  const tree = String(git(repository, ['rev-parse', '--verify', `${commit}^{tree}`])).trim();
  const epoch = String(git(repository, ['show', '-s', '--format=%ct', commit])).trim();
  const entries = parseTree(git(repository, ['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: null }));
  const objects = readBatchObjects(repository, entries);
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const entry of entries) {
    const file = path.join(destination, ...entry.relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
    await writeFile(file, objects.get(entry.objectId), { flag: 'wx', mode: SAFE_MODE.get(entry.mode) });
    await chmod(file, SAFE_MODE.get(entry.mode));
  }
  const buildInfo = path.join(destination, BUILD_INFO_PATH);
  const source = await readFile(buildInfo, 'utf8');
  await writeFile(buildInfo, stampBuildInfo(source, {
    commit,
    sourceSha256: null,
    // A branch is mutable and checkout-specific; the release subject is the immutable commit.
    branch: null,
    dirty: false,
    builtAt: new Date(Number(epoch) * 1_000).toISOString()
  }), { mode: SAFE_MODE.get(entries.find((entry) => entry.relative === BUILD_INFO_PATH)?.mode ?? '100644') });
  return Object.freeze({ commit, tree, epoch, entries: entries.map((entry) => ({ ...entry })) });
}

/** Populate a --no-checkout Git worktree from the already verified exact-blob materialization. */
export async function populateExactWorktree(materialized, worktree, entries) {
  const worktreeMetadata = await lstat(worktree).catch(() => null);
  if (!worktreeMetadata?.isDirectory() || worktreeMetadata.isSymbolicLink()) {
    throw new Error('Exact VSIX worktree must be an ordinary directory.');
  }
  const initialNames = (await readdir(worktree)).sort();
  const gitMarker = await lstat(path.join(worktree, '.git')).catch(() => null);
  if (canonicalJson(initialNames) !== canonicalJson(['.git'])
      || !gitMarker?.isFile() || gitMarker.isSymbolicLink()) {
    throw new Error('No-checkout VSIX worktree contains unexpected files or unsafe Git metadata.');
  }
  // `git worktree add --no-checkout` deliberately leaves this worktree's index empty. Populate the
  // index directly from its detached HEAD before copying verified blobs. `read-tree` changes only
  // Git's index; it cannot invoke checkout/smudge filters or replace any materialized file bytes.
  const index = spawnSync('git', ['read-tree', 'HEAD'], {
    cwd: worktree, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (index.error || index.status !== 0) {
    const detail = String(index.stderr || index.error?.message || '').trim();
    throw new Error(`Could not bind the exact VSIX worktree index to HEAD${detail ? `: ${detail}` : '.'}`);
  }
  for (const entry of entries) {
    if (!SAFE_MODE.has(entry.mode)) throw new Error(`Exact worktree refuses mode ${entry.mode}: ${entry.relative}.`);
    const source = path.join(materialized, ...entry.relative.split('/'));
    const target = path.join(worktree, ...entry.relative.split('/'));
    const sourceMetadata = await lstat(source).catch(() => null);
    if (!sourceMetadata?.isFile() || sourceMetadata.isSymbolicLink()) {
      throw new Error(`Exact materialized source changed type: ${entry.relative}.`);
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await chmod(target, SAFE_MODE.get(entry.mode));
    const targetMetadata = await lstat(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()
        || targetMetadata.size !== sourceMetadata.size
        || await digestFile(target) !== await digestFile(source)) {
      throw new Error(`Exact VSIX worktree bytes differ from the Git-blob materialization: ${entry.relative}.`);
    }
  }
}

function must(command, args, { cwd, environment = process.env, capture = false } = {}) {
  const launch = resolvePlatformProcess(command, args, { environment });
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd, env: environment, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...launch.spawnOptions
  });
  if (result.error || result.status !== 0) {
    const detail = capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ` with status ${result.status}`}.`);
  }
  return result.stdout ?? '';
}

async function lockedNpm(materializedSource, temporary) {
  // Never trust an ignored node_modules from the checkout. Bootstrap the exact lock into this
  // invocation's private tree; npm verifies every downloaded closure object against lock integrity.
  const sourceToolchain = path.join(materializedSource, 'toolchains', 'npm-pack');
  const privateToolchain = path.join(temporary, 'npm-toolchain');
  await mkdir(privateToolchain, { mode: 0o700 });
  await Promise.all(['package.json', 'package-lock.json'].map((name) => (
    copyFile(path.join(sourceToolchain, name), path.join(privateToolchain, name))
  )));
  must('npm', [
    'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline',
    '--replace-registry-host=always'
  ], {
    cwd: privateToolchain
  });
  const entry = path.join(privateToolchain, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const manifest = JSON.parse(await readFile(path.join(privateToolchain, 'package.json'), 'utf8'));
  const expected = manifest.dependencies.npm;
  const installedManifest = path.join(privateToolchain, 'node_modules', 'npm', 'package.json');
  const installed = JSON.parse(await readFile(installedManifest, 'utf8')).version;
  if (installed !== expected || !existsSync(entry)) {
    throw new Error(`Locked npm packer ${expected} was not materialized exactly.`);
  }
  return {
    entry,
    version: expected,
    lockSha256: await digestFile(path.join(sourceToolchain, 'package-lock.json'))
  };
}

function parseOptions(argv) {
  const result = { signingKey: null, identity: null, outputDirectory: null };
  const names = new Map([
    ['--signing-key', 'signingKey'], ['--identity', 'identity'], ['--out-dir', 'outputDirectory']
  ]);
  const remaining = [...argv];
  while (remaining.length) {
    const option = remaining.shift();
    const field = names.get(option);
    if (!field) throw new Error(`Unknown release artifact builder option '${option}'.`);
    const value = remaining.shift();
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    if (result[field]) throw new Error(`${option} was provided more than once.`);
    result[field] = value;
  }
  return result;
}

async function ordinaryPrivateFile(file, label) {
  const resolved = path.resolve(file);
  const metadata = await lstat(resolved).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must be an ordinary file: ${resolved}.`);
  return resolved;
}

export async function buildReleaseArtifacts({
  repository = root,
  signingKey,
  identity,
  outputDirectory = null,
  now = Date.now
}) {
  if (!signingKey || !identity) {
    throw new Error('Artifact build requires --signing-key <ed25519-private.pem> and --identity <builder>.');
  }
  const key = await readSecurePrivateKey(signingKey, {
    repository, label: 'Artifact signing key'
  });
  const baseline = assertReleaseCheckoutClean(repository, { label: 'Release artifact build' });
  if (!exactGitRoot(repository)) throw new Error('Release artifact build requires the exact Git repository root.');
  const gitPath = String(git(repository, [
    'rev-parse', '--path-format=absolute', '--git-path', `singularity-flow/release-artifacts/${baseline.commit}`
  ])).trim();
  const finalOutput = path.resolve(outputDirectory ?? gitPath);
  if (await lstat(finalOutput).catch(() => null)) {
    throw new Error(`Release artifact output already exists; preserve or select it explicitly: ${finalOutput}.`);
  }
  await mkdir(path.dirname(finalOutput), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-release-artifacts-'));
  // The candidate and final directory share a parent, so the final rename remains atomic even when
  // the operating-system temp directory is on another filesystem or Windows drive.
  const candidate = await mkdtemp(path.join(path.dirname(finalOutput), '.release-artifact-candidate-'));
  let vscodeWorktreeAdded = false;
  const vscodeWorktree = path.join(temporary, 'vscode-source');
  try {
    const materialized = path.join(temporary, 'source');
    const source = await materializeExactHead(repository, materialized, { revision: baseline.commit });
    if (source.tree !== baseline.tree) throw new Error('Materialized source tree does not match the verified release tree.');
    const packer = await lockedNpm(materialized, temporary);
    // --no-checkout is essential: checkout smudge filters live outside the commit and can otherwise
    // transform bytes while Git still reports a clean worktree. Populate only the already verified
    // blob materialization before any package tool can touch it, while retaining the Git metadata
    // required by the VSIX boundary.
    git(repository, [
      'worktree', 'add', '--detach', '--no-checkout', vscodeWorktree, baseline.commit
    ]);
    vscodeWorktreeAdded = true;
    await populateExactWorktree(materialized, vscodeWorktree, source.entries);
    const environment = {
      ...process.env,
      SOURCE_DATE_EPOCH: source.epoch,
      TZ: 'Etc/UTC', LANG: 'C', LC_ALL: 'C', CI: '1'
    };
    const packageManifest = JSON.parse(await readFile(path.join(materialized, 'package.json'), 'utf8'));
    const productionDependencies = Object.keys(packageManifest.dependencies ?? {}).sort();
    const declaredBundles = [...(packageManifest.bundleDependencies ?? [])].sort();
    if (canonicalJson(productionDependencies) !== canonicalJson(declaredBundles)) {
      throw new Error('Every production dependency must be declared in bundleDependencies for an offline exact artifact.');
    }
    // Resolve the complete production closure once from the signed root lock. npm pack then embeds
    // that closure, so verification cells never consult a mutable registry to execute the tarball.
    must(process.execPath, [
      packer.entry, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--prefer-offline', '--replace-registry-host=always'
    ], { cwd: materialized, environment });
    const packOutput = must(process.execPath, [
      packer.entry, 'pack', '--ignore-scripts', '--json', '--pack-destination', candidate
    ], { cwd: materialized, environment, capture: true });
    let pack;
    try { [pack] = JSON.parse(packOutput); } catch (error) {
      throw new Error(`Locked npm packer returned invalid JSON: ${error.message}`);
    }
    const packageFile = path.join(candidate, path.basename(String(pack?.filename ?? '')));
    if (!pack?.filename || !existsSync(packageFile)) throw new Error('Locked npm packer did not produce the expected archive.');
    const packedBundles = new Set(pack.bundled ?? []);
    for (const dependency of productionDependencies) {
      if (!packedBundles.has(dependency)) {
        throw new Error(`Locked npm artifact omitted bundled production dependency ${dependency}.`);
      }
    }
    const packageEntries = (pack.files ?? []).map(({ path: entryPath, size, mode }) => ({
      path: entryPath, size, mode
    })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

    // Build the VSIX in the detached exact worktree. Its packaging boundary requires a real Git
    // root so it can verify every staged blob and dependency; the deterministic build-info stamp is
    // the sole tracked mutation and is validated byte-for-byte before staging.
    must(process.execPath, [
      packer.entry, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline',
      '--replace-registry-host=always'
    ], { cwd: vscodeWorktree, environment });
    const worktreeBuildInfo = path.join(vscodeWorktree, BUILD_INFO_PATH);
    const stampedBuildInfo = await readFile(worktreeBuildInfo, 'utf8');
    const packagingEnvironment = {
      ...environment,
      SINGULARITY_FLOW_PACKAGING_COMMIT: baseline.commit,
      SINGULARITY_FLOW_PACKAGING_TREE: baseline.tree,
      SINGULARITY_FLOW_STAMPED_BUILD_INFO_SHA256: digestBytes(Buffer.from(stampedBuildInfo)),
      SINGULARITY_FLOW_PACKAGING_NPM_CLI: packer.entry
    };
    must(process.execPath, [path.join(vscodeWorktree, 'scripts', 'vscode-dev.mjs'), '--package'], {
      cwd: vscodeWorktree, environment: packagingEnvironment
    });
    const extensionManifest = JSON.parse(await readFile(path.join(vscodeWorktree, 'apps', 'vscode', 'package.json'), 'utf8'));
    const sourceVsix = path.join(
      vscodeWorktree, 'apps', 'vscode', `${extensionManifest.name}-${extensionManifest.version}.vsix`
    );
    await ordinaryPrivateFile(sourceVsix, 'Built VSIX');
    const vsixFile = path.join(candidate, path.basename(sourceVsix));
    await copyFile(sourceVsix, vsixFile);
    assertReleaseCheckoutClean(repository, {
      expectedCommit: baseline.commit, expectedTree: baseline.tree, label: 'Release artifact post-build check'
    });

    const receipt = signReleaseArtifactReceipt({
      schemaVersion: RELEASE_ARTIFACT_RECEIPT_VERSION,
      kind: 'singularity-flow-release-artifact-receipt',
      generatedAt: new Date(Number(now())).toISOString(),
      sourceCommit: baseline.commit,
      sourceTree: baseline.tree,
      packageEntryManifestSha256: digestBytes(Buffer.from(canonicalJson(packageEntries))),
      packagingProfile: {
        nodeVersion: process.versions.node,
        npmVersion: packer.version,
        zlibVersion: process.versions.zlib,
        sourceDateEpoch: source.epoch,
        productionDependencyLockSha256: await digestFile(path.join(materialized, 'package-lock.json')),
        npmToolchainLockSha256: packer.lockSha256,
        vsceToolchainLockSha256: await digestFile(
          path.join(materialized, 'toolchains', 'vsce', 'package-lock.json')
        )
      },
      artifacts: await Promise.all([
        ['cli-and-copilot-plugin', packageFile],
        ['vscode-extension', vsixFile]
      ].map(async ([kind, file]) => {
        const metadata = await lstat(file);
        return { kind, name: path.basename(file), sizeBytes: metadata.size, sha256: await digestFile(file) };
      }))
    }, key.bytes, identity);
    const candidateReceipt = path.join(candidate, 'RELEASE-ARTIFACT-RECEIPT.json');
    await writeFile(candidateReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(candidate, finalOutput);
    return Object.freeze({
      outputDirectory: finalOutput,
      packagePath: path.join(finalOutput, path.basename(packageFile)),
      vsixPath: path.join(finalOutput, path.basename(vsixFile)),
      receiptPath: path.join(finalOutput, 'RELEASE-ARTIFACT-RECEIPT.json'),
      receipt
    });
  } finally {
    if (vscodeWorktreeAdded) {
      try { git(repository, ['worktree', 'remove', '--force', vscodeWorktree]); } catch {}
    }
    await rm(candidate, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  buildReleaseArtifacts({ repository: root, ...options }).then((result) => {
    console.log(`Release artifacts built once from ${result.receipt.sourceCommit}:`);
    console.log(`  ${result.packagePath}`);
    console.log(`  ${result.vsixPath}`);
    console.log(`  ${result.receiptPath}`);
  }).catch((error) => {
    console.error(`Release artifact build failed: ${error.message}`);
    process.exitCode = 1;
  });
}
