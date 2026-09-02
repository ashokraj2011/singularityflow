#!/usr/bin/env node
/**
 * Validate and retain the exact artifacts used by install.sh activation recovery.
 *
 * This module intentionally uses only Node built-ins: recovery must work before npm dependencies
 * are installed. It reads package identity directly from the npm tarball and VSIX rather than
 * trusting filenames or mutable checkout manifests.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, constants, link, lstat, mkdir, open, realpath, rename, rm, utimes, writeFile
} from 'node:fs/promises';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const FORMAT = 'singularity-flow-install-activation/v5';
const LEASE_FORMAT = 'singularity-flow-install-activation-lease/v1';
const LEASE_INITIALIZATION_GRACE_MS = 30_000;
const JOURNAL_MUTATION_LOCK_ATTEMPTS = 400;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_ID = /^install-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /[\0\r\n]/u;
const helperFile = fileURLToPath(import.meta.url);
const RETAINED_ARTIFACT_NAMES = Object.freeze({
  tarball: 'singularity-flow.tgz',
  vsix: 'singularity-flow.vsix'
});
// `manifest` is the transaction commit receipt, but it is still a mutable machine surface. Keeping
// it in the same state machine closes the signal window between replacing current.json and marking
// activation complete: recovery sees `applying` and restores the exact prior file.
const SURFACES = Object.freeze(['vscode', 'copilot', 'telemetry', 'cli', 'manifest']);
const SURFACE_STATES = new Set(['pending', 'applying', 'applied', 'restoring', 'restored', 'skipped']);

function fail(message) { throw new Error(`Staged install recovery refused: ${message}`); }

function text(value, label, { nullable = false, max = 16_384 } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string' || !value || value.length > max || CONTROL.test(value)) {
    fail(`${label} is missing or invalid.`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer.`);
  return parsed;
}

function operationId(value) {
  const normalized = text(value, 'activation operation ID', { max: 64 });
  if (!OPERATION_ID.test(normalized)) fail('activation operation ID is invalid.');
  return normalized;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has unexpected or missing fields.`);
}

async function regularBytes(file, label, { maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  const absolute = path.resolve(text(file, `${label} path`));
  const before = await lstat(absolute).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) fail(`${label} is not a regular, non-symlink file: ${absolute}`);
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    fail(`${label} could not be opened without following a symlink: ${absolute}`);
  }
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(absolute)]);
    if (!opened.isFile() || !after.isFile() || after.isSymbolicLink()
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      fail(`${label} changed identity while it was opened: ${absolute}`);
    }
    if (opened.size < 1 || opened.size > maxBytes) {
      fail(`${label} size is outside the supported boundary: ${opened.size} bytes.`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size) fail(`${label} changed size while it was read: ${absolute}`);
    return { path: absolute, bytes };
  } finally {
    await handle.close();
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonManifest(bytes, label) {
  if (bytes.length < 2 || bytes.length > MAX_MANIFEST_BYTES) fail(`${label} has an invalid size.`);
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} is not a JSON object.`);
    return parsed;
  } catch (error) {
    if (String(error?.message ?? '').startsWith('Staged install recovery refused:')) throw error;
    fail(`${label} is not valid JSON.`);
  }
}

function tarEntry(archive, wanted) {
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nul = (slice) => {
      const end = slice.indexOf(0);
      return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
    };
    const name = nul(header.subarray(0, 100));
    const prefix = nul(header.subarray(345, 500));
    const entry = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    if (!/^[0-7]+$/u.test(sizeText)) fail('npm tarball contains an unsupported entry size.');
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) fail('npm tarball contains an invalid entry size.');
    const start = offset + 512;
    const end = start + size;
    if (end > archive.length) fail('npm tarball is truncated.');
    if (entry === wanted) return archive.subarray(start, end);
    offset = start + Math.ceil(size / 512) * 512;
  }
  fail(`npm tarball does not contain ${wanted}.`);
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('VSIX has no valid ZIP central-directory terminator.');
}

function zipEntry(bytes, wanted) {
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entries === 0xffff
      || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralSize > bytes.length) {
    fail('VSIX uses an unsupported multi-disk or ZIP64 layout.');
  }
  let offset = centralOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      fail('VSIX central directory is malformed.');
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff) || end > bytes.length) {
      fail('VSIX central-directory entry is invalid or ZIP64.');
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
        fail(`VSIX local entry for ${wanted} is malformed.`);
      }
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressedEnd = start + compressedSize;
      if (compressedEnd > bytes.length || uncompressedSize > MAX_MANIFEST_BYTES) {
        fail(`VSIX entry ${wanted} is truncated or too large.`);
      }
      const compressed = bytes.subarray(start, compressedEnd);
      let output;
      if (method === 0) output = compressed;
      else if (method === 8) {
        try { output = inflateRawSync(compressed, { maxOutputLength: MAX_MANIFEST_BYTES }); }
        catch { fail(`VSIX entry ${wanted} could not be inflated safely.`); }
      } else fail(`VSIX entry ${wanted} uses unsupported compression method ${method}.`);
      if (output.length !== uncompressedSize) fail(`VSIX entry ${wanted} size does not match its directory record.`);
      return output;
    }
    offset = end;
  }
  fail(`VSIX does not contain ${wanted}.`);
}

function inspectNpmTarballInput(input) {
  let archive;
  try { archive = gunzipSync(input.bytes, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch { fail('npm tarball is not a bounded gzip archive.'); }
  const manifest = jsonManifest(tarEntry(archive, 'package/package.json'), 'npm tarball package.json');
  if (manifest.name !== 'singularity-flow') fail(`npm tarball package name is '${manifest.name ?? 'missing'}'.`);
  const version = text(manifest.version, 'npm tarball version', { max: 128 });
  return Object.freeze({ path: input.path, sha256: sha256(input.bytes), package: manifest.name, version });
}

function inspectVsixInput(input) {
  const manifest = jsonManifest(zipEntry(input.bytes, 'extension/package.json'), 'VSIX extension/package.json');
  const publisher = text(manifest.publisher, 'VSIX publisher', { max: 256 });
  const name = text(manifest.name, 'VSIX name', { max: 256 });
  const version = text(manifest.version, 'VSIX version', { max: 128 });
  const extensionId = `${publisher}.${name}`;
  if (extensionId !== 'singularityflow.singularity-flow-vscode') {
    fail(`VSIX extension identity is '${extensionId}'.`);
  }
  return Object.freeze({ path: input.path, sha256: sha256(input.bytes), extensionId, version });
}

export async function inspectNpmTarball(file) {
  return inspectNpmTarballInput(await regularBytes(file, 'npm tarball'));
}

export async function inspectVsix(file) {
  return inspectVsixInput(await regularBytes(file, 'VSIX'));
}

async function managedDirectory(directory, label, { create = false } = {}) {
  const absolute = path.resolve(directory);
  let info = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info && create) {
    try { await mkdir(absolute, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    info = await lstat(absolute).catch(() => null);
  }
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} is not a regular, non-symlink directory: ${absolute}`);
  }
  return absolute;
}

async function retainedArtifactDirectory(journal, digest, { create = false } = {}) {
  const journalParent = await managedDirectory(path.dirname(path.resolve(journal)), 'installation journal directory');
  const versions = await managedDirectory(path.join(journalParent, 'versions'), 'retained artifact directory', { create });
  const algorithm = await managedDirectory(path.join(versions, 'sha256'), 'retained SHA-256 directory', { create });
  const digestDirectory = await managedDirectory(
    path.join(algorithm, digest.replace(/^sha256:/u, '')),
    'retained digest directory',
    { create }
  );
  if (create) {
    await Promise.all([chmod(versions, 0o700), chmod(algorithm, 0o700), chmod(digestDirectory, 0o700)]);
  }
  return digestDirectory;
}

function expectedRetainedArtifactPath(journal, kind, digest) {
  return path.join(
    path.dirname(path.resolve(journal)), 'versions', 'sha256', digest.replace(/^sha256:/u, ''),
    RETAINED_ARTIFACT_NAMES[kind]
  );
}

async function inspectArtifactInput(file, kind) {
  const label = kind === 'tarball' ? 'npm tarball' : 'VSIX';
  const input = await regularBytes(file, label);
  return {
    input,
    record: kind === 'tarball' ? inspectNpmTarballInput(input) : inspectVsixInput(input)
  };
}

async function retainArtifact(file, kind, journal) {
  const { input, record: sourceRecord } = await inspectArtifactInput(file, kind);
  const directory = await retainedArtifactDirectory(journal, sourceRecord.sha256, { create: true });
  const target = path.join(directory, RETAINED_ARTIFACT_NAMES[kind]);
  const temporary = path.join(directory, `.${RETAINED_ARTIFACT_NAMES[kind]}.${process.pid}.${randomUUID()}.tmp`);
  const inspect = kind === 'tarball' ? inspectNpmTarball : inspectVsix;
  let existing = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      fail(`retained ${kind} target is not a regular, non-symlink file: ${target}`);
    }
  } else {
    await writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
    try {
      const staged = await inspect(temporary);
      if (staged.sha256 !== sourceRecord.sha256 || staged.version !== sourceRecord.version) {
        fail(`retained ${kind} copy does not match the validated source bytes.`);
      }
      try { await link(temporary, target); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    } finally {
      await rm(temporary, { force: true });
    }
    existing = await lstat(target).catch(() => null);
    if (!existing?.isFile() || existing.isSymbolicLink()) {
      fail(`retained ${kind} target was not created as a regular file: ${target}`);
    }
  }
  const retained = await inspect(target);
  const comparableSource = { ...sourceRecord, path: target };
  if (JSON.stringify(retained) !== JSON.stringify(comparableSource)) {
    fail(`retained ${kind} bytes or package identity conflict with the content-addressed path.`);
  }
  await chmod(target, 0o600);
  return retained;
}

async function transactionDirectory(journal, id, { create = false } = {}) {
  const journalParent = await managedDirectory(path.dirname(path.resolve(journal)), 'installation journal directory');
  const transactions = path.join(journalParent, 'transactions');
  if (create) await mkdir(transactions, { recursive: true, mode: 0o700 });
  await managedDirectory(transactions, 'installation transaction directory');
  const operation = path.join(transactions, operationId(id));
  if (create) {
    try { await mkdir(operation, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  await managedDirectory(operation, 'installation operation directory');
  await Promise.all([chmod(transactions, 0o700), chmod(operation, 0o700)]);
  return operation;
}

async function retainPreviousFile({ journal, id, target, name }) {
  const absoluteTarget = path.resolve(text(target, `${name} target`));
  const info = await lstat(absoluteTarget).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { target: absoluteTarget, existed: false, snapshot: null, sha256: null, mode: null };
  const input = await regularBytes(absoluteTarget, name, { maxBytes: 16 * 1024 * 1024 });
  const directory = await transactionDirectory(journal, id, { create: true });
  const snapshot = path.join(directory, `previous-${name.replace(/[^a-z0-9]+/giu, '-')}`);
  await writeFile(snapshot, input.bytes, { flag: 'wx', mode: 0o600 });
  const retained = await regularBytes(snapshot, `${name} snapshot`, { maxBytes: 16 * 1024 * 1024 });
  const digest = sha256(input.bytes);
  if (sha256(retained.bytes) !== digest) fail(`${name} snapshot does not match its preimage.`);
  return { target: absoluteTarget, existed: true, snapshot, sha256: digest, mode: info.mode & 0o777 };
}

async function validatePreviousFileBinding(binding, journal, id, name) {
  exactKeys(binding, ['target', 'existed', 'snapshot', 'sha256', 'mode'], `${name} previous binding`);
  const target = path.resolve(text(binding.target, `${name} target`));
  const existed = bool(binding.existed, `${name} existed`);
  if (!existed) {
    if (binding.snapshot !== null || binding.sha256 !== null || binding.mode !== null) {
      fail(`${name} absent binding contains snapshot material.`);
    }
    return { target, existed, snapshot: null, sha256: null, mode: null };
  }
  const directory = await transactionDirectory(journal, id);
  const snapshot = path.resolve(text(binding.snapshot, `${name} snapshot`));
  if (path.dirname(snapshot) !== directory) fail(`${name} snapshot is outside the operation directory.`);
  const digest = text(binding.sha256, `${name} snapshot digest`, { max: 80 });
  if (!DIGEST.test(digest)) fail(`${name} snapshot digest is invalid.`);
  const mode = Number(binding.mode);
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) fail(`${name} prior mode is invalid.`);
  const input = await regularBytes(snapshot, `${name} snapshot`, { maxBytes: 16 * 1024 * 1024 });
  if (sha256(input.bytes) !== digest) fail(`${name} snapshot changed after admission.`);
  return { target, existed, snapshot, sha256: digest, mode };
}

async function optionalJson(file, label) {
  const absolute = path.resolve(file);
  const info = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  const input = await regularBytes(absolute, label, { maxBytes: MAX_JOURNAL_BYTES });
  return jsonManifest(input.bytes, label);
}

async function previousArtifactFromManifest({ manifest, journal, kind, observedVersion, required }) {
  if (!required) return null;
  if (!manifest) fail(`an installed ${kind} surface has no managed current.json rollback receipt.`);
  const raw = manifest.schemaVersion === 2 ? manifest.artifacts?.[kind] : manifest[kind];
  const artifactPath = typeof raw === 'string' ? raw : raw?.path;
  if (!artifactPath) fail(`an installed ${kind} surface has no exact retained rollback artifact.`);
  const inspected = kind === 'tarball' ? await inspectNpmTarball(artifactPath) : await inspectVsix(artifactPath);
  if (inspected.path !== expectedRetainedArtifactPath(journal, kind, inspected.sha256)) {
    fail(`previous ${kind} rollback artifact is outside the managed content-addressed store.`);
  }
  if (observedVersion && inspected.version !== observedVersion) {
    fail(`installed ${kind} version ${observedVersion} does not match retained rollback version ${inspected.version}.`);
  }
  if (raw?.sha256 && raw.sha256 !== inspected.sha256) fail(`previous ${kind} rollback digest changed.`);
  return inspected;
}

async function capturePreviousState({
  journal, id, currentManifest, cliVersion, vscodeVersion, copilotPresent,
  telemetryEnvFile, telemetryProfile
}) {
  const manifestBinding = await retainPreviousFile({
    journal, id, target: currentManifest, name: 'current-manifest'
  });
  const manifest = manifestBinding.existed
    ? await optionalJson(manifestBinding.snapshot, 'current installation manifest snapshot')
    : null;
  const cliPresent = cliVersion != null;
  const vscodePresent = vscodeVersion != null;
  const pluginPresent = bool(copilotPresent, 'previous Copilot presence');
  const cli = await previousArtifactFromManifest({
    manifest, journal, kind: 'tarball', observedVersion: cliVersion, required: cliPresent || pluginPresent
  });
  const vscode = await previousArtifactFromManifest({
    manifest, journal, kind: 'vsix', observedVersion: vscodeVersion, required: vscodePresent
  });
  const telemetry = telemetryEnvFile || telemetryProfile ? {
    envFile: telemetryEnvFile
      ? await retainPreviousFile({ journal, id, target: telemetryEnvFile, name: 'telemetry-env' }) : null,
    profile: telemetryProfile
      ? await retainPreviousFile({ journal, id, target: telemetryProfile, name: 'telemetry-profile' }) : null
  } : null;
  return {
    cliPresent, vscodePresent, copilotPresent: pluginPresent, cli, vscode, telemetry,
    manifest: manifestBinding
  };
}

export async function verifyStagedCli({ prefix, version }) {
  const root = path.resolve(text(prefix, 'staged CLI prefix'));
  const expectedVersion = text(version, 'staged CLI version', { max: 128 });
  const packageDirectory = path.join(root, 'node_modules', 'singularity-flow');
  for (const directory of [root, path.join(root, 'node_modules'), packageDirectory, path.join(packageDirectory, 'bin')]) {
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      fail(`staged CLI path is not a regular, non-symlink directory: ${directory}`);
    }
  }
  const manifestInput = await regularBytes(path.join(packageDirectory, 'package.json'), 'staged CLI package.json');
  const manifest = jsonManifest(manifestInput.bytes, 'staged CLI package.json');
  if (manifest.name !== 'singularity-flow' || manifest.version !== expectedVersion) {
    fail('staged CLI package identity does not match the journal-bound product version.');
  }
  const executable = path.join(packageDirectory, 'bin', 'singularity-flow.mjs');
  await regularBytes(executable, 'staged CLI executable');
  return Object.freeze({ prefix: root, executable, version: expectedVersion });
}

function validateMode(mode) {
  exactKeys(mode, [
    'cliOnly', 'vscodeOnly', 'skipVscode', 'skipCopilot', 'telemetry', 'workspaceRefresh'
  ], 'activation mode');
  const value = Object.fromEntries(Object.entries(mode).map(([key, entry]) => [key, bool(entry, `activation mode.${key}`)]));
  if (value.vscodeOnly && (value.cliOnly || value.skipVscode || value.skipCopilot || value.telemetry)) {
    fail('VS Code-only activation mode conflicts with another product surface.');
  }
  if (value.cliOnly && (value.skipVscode || value.skipCopilot || value.telemetry)) {
    fail('CLI-only activation mode conflicts with another product surface.');
  }
  return value;
}

function validateRegistry(value) {
  let registry;
  try { registry = new URL(text(value, 'registry')); } catch { fail('registry is not a valid URL.'); }
  if (!['http:', 'https:'].includes(registry.protocol) || registry.username || registry.password
      || registry.search || registry.hash) fail('registry is not a credential-free HTTP(S) URL.');
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  return registry.toString();
}

function validateArtifactRecord(value, kind, required) {
  if (value == null) {
    if (required) fail(`${kind} binding is required by the recorded activation mode.`);
    return null;
  }
  const keys = kind === 'tarball'
    ? ['path', 'sha256', 'package', 'version']
    : ['path', 'sha256', 'extensionId', 'version'];
  exactKeys(value, keys, `${kind} binding`);
  const digest = text(value.sha256, `${kind} digest`, { max: 80 });
  if (!DIGEST.test(digest)) fail(`${kind} digest is invalid.`);
  return {
    ...value,
    path: path.resolve(text(value.path, `${kind} path`)),
    sha256: digest,
    version: text(value.version, `${kind} version`, { max: 128 })
  };
}

function validateJournalShape(value, journal = null) {
  exactKeys(value, [
    'schemaVersion', 'format', 'operation', 'operationId', 'revision', 'status', 'surface', 'checkout', 'version',
    'registry', 'mode', 'artifacts', 'previous', 'completedSurfaces', 'skippedSurfaces',
    'surfaceStates', 'rollbackFailures', 'recoveryCommand', 'installer', 'validator', 'failureStep', 'updatedAt'
  ], 'activation journal');
  if (value.schemaVersion !== 5 || value.format !== FORMAT || value.operation !== 'normal-install-activation') {
    fail('activation journal format is unsupported; run a normal install to stage a new recovery set.');
  }
  if (!['staged', 'activating', 'rolling-back', 'rolled-back', 'rollback-failed', 'complete'].includes(value.status)) {
    fail('activation journal status is invalid.');
  }
  const mode = validateMode(value.mode);
  exactKeys(value.artifacts, ['tarball', 'vsix'], 'activation artifacts');
  const requireTarball = !mode.vscodeOnly;
  const requireVsix = !mode.cliOnly && !mode.skipVscode;
  const tarball = validateArtifactRecord(value.artifacts.tarball, 'tarball', requireTarball);
  const vsix = validateArtifactRecord(value.artifacts.vsix, 'vsix', requireVsix);
  if (!requireTarball && tarball) fail('activation journal contains an unrequested tarball.');
  if (!requireVsix && vsix) fail('activation journal contains an unrequested VSIX.');
  exactKeys(value.previous, [
    'cliPresent', 'vscodePresent', 'copilotPresent', 'cli', 'vscode', 'telemetry', 'manifest'
  ], 'previous identities');
  const cliPresent = bool(value.previous.cliPresent, 'previous.cliPresent');
  const vscodePresent = bool(value.previous.vscodePresent, 'previous.vscodePresent');
  const copilotPresent = bool(value.previous.copilotPresent, 'previous.copilotPresent');
  const previousCli = validateArtifactRecord(value.previous.cli, 'tarball', cliPresent || copilotPresent);
  const previousVsix = validateArtifactRecord(value.previous.vscode, 'vsix', vscodePresent);
  exactKeys(value.previous.manifest, ['target', 'existed', 'snapshot', 'sha256', 'mode'], 'previous manifest');
  path.resolve(text(value.previous.manifest.target, 'previous manifest target'));
  const manifestExisted = bool(value.previous.manifest.existed, 'previous manifest existed');
  if (manifestExisted) {
    path.resolve(text(value.previous.manifest.snapshot, 'previous manifest snapshot'));
    if (!DIGEST.test(text(value.previous.manifest.sha256, 'previous manifest digest', { max: 80 }))) {
      fail('previous manifest digest is invalid.');
    }
    const mode = Number(value.previous.manifest.mode);
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) fail('previous manifest mode is invalid.');
  } else if (value.previous.manifest.snapshot !== null || value.previous.manifest.sha256 !== null
      || value.previous.manifest.mode !== null) {
    fail('previous absent manifest binding contains snapshot material.');
  }
  if (!cliPresent && !copilotPresent && previousCli) fail('previous CLI binding is present for absent CLI and Copilot surfaces.');
  if (!vscodePresent && previousVsix) fail('previous VSIX binding is present for an absent VS Code surface.');
  let previousTelemetry = null;
  if (value.previous.telemetry !== null) {
    exactKeys(value.previous.telemetry, ['envFile', 'profile'], 'previous telemetry');
    for (const [key, binding] of Object.entries(value.previous.telemetry)) {
      if (binding === null) continue;
      exactKeys(binding, ['target', 'existed', 'snapshot', 'sha256', 'mode'], `previous telemetry.${key}`);
      path.resolve(text(binding.target, `previous telemetry.${key}.target`));
      const existed = bool(binding.existed, `previous telemetry.${key}.existed`);
      if (existed) {
        path.resolve(text(binding.snapshot, `previous telemetry.${key}.snapshot`));
        if (!DIGEST.test(text(binding.sha256, `previous telemetry.${key}.sha256`, { max: 80 }))) {
          fail(`previous telemetry.${key}.sha256 is invalid.`);
        }
        const mode = Number(binding.mode);
        if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
          fail(`previous telemetry.${key}.mode is invalid.`);
        }
      } else if (binding.snapshot !== null || binding.sha256 !== null || binding.mode !== null) {
        fail(`previous telemetry.${key} absent binding contains snapshot material.`);
      }
    }
    previousTelemetry = value.previous.telemetry;
  }
  exactKeys(value.surfaceStates, SURFACES, 'activation surface states');
  for (const [surface, state] of Object.entries(value.surfaceStates)) {
    if (!SURFACE_STATES.has(state)) fail(`activation surface ${surface} has invalid state '${state}'.`);
  }
  if (!Array.isArray(value.rollbackFailures) || value.rollbackFailures.length > SURFACES.length) {
    fail('activation rollback failures are invalid.');
  }
  value.rollbackFailures.forEach((entry) => text(entry, 'activation rollback failure', { max: 256 }));
  for (const [label, entries] of [['completedSurfaces', value.completedSurfaces], ['skippedSurfaces', value.skippedSurfaces]]) {
    if (!Array.isArray(entries) || entries.length > 16) fail(`${label} is invalid.`);
    entries.forEach((entry) => text(entry, label, { max: 256 }));
  }
  for (const key of ['installer', 'validator']) {
    exactKeys(value[key], ['path', 'sha256'], key);
    value[key].path = path.resolve(text(value[key].path, `${key} path`));
    if (!DIGEST.test(text(value[key].sha256, `${key} digest`, { max: 80 }))) fail(`${key} digest is invalid.`);
  }
  const normalized = {
    ...value,
    operationId: operationId(value.operationId),
    revision: positiveInteger(value.revision, 'activation journal revision'),
    checkout: path.resolve(text(value.checkout, 'checkout')),
    version: text(value.version, 'version', { max: 128 }),
    registry: validateRegistry(value.registry),
    surface: text(value.surface, 'surface', { max: 256 }),
    recoveryCommand: text(value.recoveryCommand, 'recovery command'),
    failureStep: text(value.failureStep, 'failure step', { nullable: true, max: 256 }),
    updatedAt: text(value.updatedAt, 'updatedAt', { max: 64 }),
    mode,
    artifacts: { tarball, vsix },
    previous: {
      cliPresent, vscodePresent, copilotPresent, cli: previousCli, vscode: previousVsix,
      telemetry: previousTelemetry, manifest: value.previous.manifest
    }
  };
  if (journal) {
    for (const [kind, artifact] of Object.entries(normalized.artifacts)) {
      if (artifact && artifact.path !== expectedRetainedArtifactPath(journal, kind, artifact.sha256)) {
        fail(`${kind} path is outside its journal-owned content-addressed retention directory.`);
      }
    }
    for (const [kind, artifact] of [['tarball', normalized.previous.cli], ['vsix', normalized.previous.vscode]]) {
      if (artifact && artifact.path !== expectedRetainedArtifactPath(journal, kind, artifact.sha256)) {
        fail(`previous ${kind} path is outside its journal-owned content-addressed retention directory.`);
      }
    }
  }
  return normalized;
}

async function digestRegular(file, label) {
  const input = await regularBytes(file, label);
  return { path: input.path, sha256: sha256(input.bytes) };
}

async function atomicWrite(file, value) {
  const target = path.resolve(file);
  await managedDirectory(path.dirname(target), 'installation journal directory');
  const existing = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    fail(`installation journal target is not a regular, non-symlink file: ${target}`);
  }
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, target); } finally { await rm(temporary, { force: true }); }
}

function journalMutationLockPath(journal) {
  return `${path.resolve(text(journal, 'activation journal path'))}.mutation-lock`;
}

async function withJournalMutationLock(journal, mutate) {
  const directory = journalMutationLockPath(journal);
  const ownerFile = path.join(directory, 'owner.json');
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < JOURNAL_MUTATION_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeFile(ownerFile, `${JSON.stringify({ pid: process.pid, token })}\n`, {
          flag: 'wx', mode: 0o600
        });
        await chmod(directory, 0o700);
        acquired = true;
        break;
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = await lstat(directory).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(`activation journal mutation lock is not a regular, non-symlink directory: ${directory}`);
    }
    if (Date.now() - info.mtimeMs >= LEASE_INITIALIZATION_GRACE_MS) {
      const input = await regularBytes(ownerFile, 'activation journal mutation owner', {
        maxBytes: 64 * 1024
      }).catch(() => null);
      let owner = null;
      try { owner = input ? JSON.parse(input.bytes.toString('utf8')) : null; } catch { owner = null; }
      if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !processIsAlive(owner.pid)) {
        const stale = `${directory}.stale-${process.pid}-${randomUUID()}`;
        try { await rename(directory, stale); }
        catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
        await rm(stale, { recursive: true, force: true });
        continue;
      }
    }
    await delay(Math.min(25, 2 + Math.floor(attempt / 20)));
  }
  if (!acquired) fail('activation journal mutation lock remained busy after bounded retries.');
  try {
    return await mutate();
  } finally {
    const input = await regularBytes(ownerFile, 'activation journal mutation owner', {
      maxBytes: 64 * 1024
    }).catch(() => null);
    let owner = null;
    try { owner = input ? JSON.parse(input.bytes.toString('utf8')) : null; } catch { owner = null; }
    if (owner?.pid !== process.pid || owner?.token !== token) {
      fail('activation journal mutation lock ownership changed during the write.');
    }
    const released = `${directory}.released-${process.pid}-${randomUUID()}`;
    await rename(directory, released);
    await rm(released, { recursive: true, force: true });
  }
}

async function readJournal(journal) {
  const input = await regularBytes(journal, 'activation journal', { maxBytes: MAX_JOURNAL_BYTES });
  let parsed;
  try { parsed = JSON.parse(input.bytes.toString('utf8')); }
  catch { fail('activation journal is not valid JSON.'); }
  return validateJournalShape(parsed, journal);
}

function activationLeasePath(journal) {
  return `${path.resolve(text(journal, 'activation journal path'))}.lock`;
}

function activationLeaseOwnerPath(journal) {
  return path.join(activationLeasePath(journal), 'owner.json');
}

function validateLeaseOwner(value) {
  exactKeys(value, [
    'schemaVersion', 'format', 'operationId', 'ownerPid', 'checkout', 'acquiredAt'
  ], 'activation lease owner');
  if (value.schemaVersion !== 1 || value.format !== LEASE_FORMAT) {
    fail('activation lease format is unsupported.');
  }
  return {
    schemaVersion: 1,
    format: LEASE_FORMAT,
    operationId: operationId(value.operationId),
    ownerPid: positiveInteger(value.ownerPid, 'activation lease owner PID'),
    checkout: path.resolve(text(value.checkout, 'activation lease checkout')),
    acquiredAt: text(value.acquiredAt, 'activation lease acquisition time', { max: 64 })
  };
}

async function readActivationLease(journal) {
  const directory = activationLeasePath(journal);
  const info = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`activation lease is not a regular, non-symlink directory: ${directory}`);
  }
  const input = await regularBytes(activationLeaseOwnerPath(journal), 'activation lease owner', {
    maxBytes: 64 * 1024
  });
  let parsed;
  try { parsed = JSON.parse(input.bytes.toString('utf8')); }
  catch { fail('activation lease owner is not valid JSON.'); }
  return { ...validateLeaseOwner(parsed), directory, mtimeMs: info.mtimeMs };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function removeOwnedActivationLease(journal, expectedOperationId, expectedOwnerPid) {
  const current = await readActivationLease(journal);
  if (!current) return false;
  if (current.operationId !== expectedOperationId || current.ownerPid !== expectedOwnerPid) {
    fail('activation lease ownership changed; refusing to release another installer operation.');
  }
  const released = `${current.directory}.released-${process.pid}-${randomUUID()}`;
  try { await rename(current.directory, released); }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  await rm(released, { recursive: true, force: true });
  return true;
}

/** Acquire the one machine-local activation lease before creating or resuming a journal. */
export async function acquireActivationLease({
  journal, checkout, mode = 'create', ownerPid = process.pid,
  now = new Date().toISOString(), nowMs = Date.now()
}) {
  const journalFile = path.resolve(text(journal, 'activation journal path'));
  const checkoutPath = path.resolve(text(checkout, 'checkout'));
  const pid = positiveInteger(ownerPid, 'activation lease owner PID');
  if (!['create', 'resume'].includes(mode)) fail('activation lease mode must be create or resume.');
  await managedDirectory(path.dirname(journalFile), 'installation journal directory');

  const journalInfo = await lstat(journalFile).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  let existing = null;
  if (journalInfo) {
    if (mode === 'resume') {
      existing = await readJournal(journalFile);
    } else {
      try {
        existing = await readJournal(journalFile);
      } catch (error) {
        const legacy = await optionalJson(journalFile, 'legacy activation journal');
        if (legacy?.status !== 'complete') throw error;
        // A completed legacy journal has no recovery obligation. Prior active surfaces are still
        // admitted independently from exact current.json artifacts before the new journal writes.
        existing = { status: 'complete', operationId: 'legacy-complete' };
      }
    }
  }
  if (mode === 'create' && existing && !['complete', 'rolled-back'].includes(existing.status)) {
    fail(`activation journal '${existing.operationId}' is ${existing.status}; run its exact --from-staged-artifacts recovery before starting another install.`);
  }
  const initial = mode === 'resume' ? existing : null;
  if (initial?.status === 'complete') fail('activation journal is already complete; no staged recovery is pending.');
  if (initial && initial.checkout !== checkoutPath) fail('activation journal belongs to a different checkout.');
  const id = initial?.operationId ?? `install-${randomUUID()}`;
  const directory = activationLeasePath(journalFile);
  const owner = {
    schemaVersion: 1,
    format: LEASE_FORMAT,
    operationId: id,
    ownerPid: pid,
    checkout: checkoutPath,
    acquiredAt: text(now, 'activation lease acquisition time', { max: 64 })
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await mkdir(directory, { mode: 0o700 });
      try {
        await writeFile(activationLeaseOwnerPath(journalFile), `${JSON.stringify(owner, null, 2)}\n`, {
          flag: 'wx', mode: 0o600
        });
        await chmod(directory, 0o700);
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      if (mode === 'resume') {
        const current = await readJournal(journalFile);
        if (current.operationId !== id || current.checkout !== checkoutPath || current.status === 'complete') {
          await removeOwnedActivationLease(journalFile, id, pid);
          fail('activation journal changed while recovery acquired its lease. Retry from the current journal.');
        }
      }
      return Object.freeze({ operationId: id, ownerPid: pid, checkout: checkoutPath, lease: directory });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const info = await lstat(directory).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(`activation lease is not a regular, non-symlink directory: ${directory}`);
    }
    let current = null;
    try { current = await readActivationLease(journalFile); }
    catch (error) {
      if (Number.isFinite(info.mtimeMs) && nowMs - info.mtimeMs < LEASE_INITIALIZATION_GRACE_MS) {
        fail('another installer is initializing the activation lease. Retry after it finishes.');
      }
      current = null;
    }
    if (current?.operationId === id && current.ownerPid === pid && current.checkout === checkoutPath) {
      await utimes(directory, new Date(), new Date());
      return Object.freeze({ operationId: id, ownerPid: pid, checkout: checkoutPath, lease: directory });
    }
    if (current) {
      if (processIsAlive(current.ownerPid)) {
        fail(`another installer operation '${current.operationId}' is active under PID ${current.ownerPid}.`);
      }
      if (Number.isFinite(current.mtimeMs) && nowMs - current.mtimeMs < LEASE_INITIALIZATION_GRACE_MS) {
        fail(`installer operation '${current.operationId}' stopped recently; retry stale-lease recovery after 30 seconds.`);
      }
    }
    const stale = `${directory}.stale-${process.pid}-${randomUUID()}`;
    try { await rename(directory, stale); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    await rm(stale, { recursive: true, force: true });
  }
  fail('activation lease could not be acquired after bounded contention retries.');
}

export async function releaseActivationLease({ journal, operationId: id, ownerPid = process.pid }) {
  return removeOwnedActivationLease(
    journal, operationId(id), positiveInteger(ownerPid, 'activation lease owner PID')
  );
}

export async function heartbeatActivationLease({ journal, operationId: id, ownerPid = process.pid }) {
  const current = await assertActivationLease(journal, id, ownerPid);
  if (!processIsAlive(current.ownerPid)) {
    fail('activation lease owner is no longer alive; the heartbeat will stop for stale recovery.');
  }
  const now = new Date();
  await utimes(current.directory, now, now);
  return Object.freeze({ operationId: current.operationId, ownerPid: current.ownerPid });
}

async function assertActivationLease(journal, id, ownerPid) {
  const expectedId = operationId(id);
  const expectedPid = positiveInteger(ownerPid, 'activation lease owner PID');
  const current = await readActivationLease(journal);
  if (!current || current.operationId !== expectedId || current.ownerPid !== expectedPid) {
    fail('the activation journal mutation is not owned by the current installer lease.');
  }
  return current;
}

export async function createActivationJournal({
  journal, checkout, registry, version, mode, tarball = null, vsix = null,
  previousObserved = { cliVersion: null, vscodeVersion: null, copilotPresent: false },
  currentManifest, telemetryEnvFile = null, telemetryProfile = null, recoveryCommand,
  installer, validator = helperFile, operationId: id, ownerPid = process.pid,
  now = new Date().toISOString()
}) {
  await assertActivationLease(journal, id, ownerPid);
  const normalizedMode = validateMode(mode);
  const expectedVersion = text(version, 'version', { max: 128 });
  await managedDirectory(path.dirname(path.resolve(journal)), 'installation journal directory');
  const inspectedArtifacts = {
    tarball: tarball ? await inspectNpmTarball(tarball) : null,
    vsix: vsix ? await inspectVsix(vsix) : null
  };
  if (!normalizedMode.vscodeOnly && !inspectedArtifacts.tarball) fail('recorded activation mode requires an npm tarball.');
  if ((!normalizedMode.cliOnly && !normalizedMode.skipVscode) !== Boolean(inspectedArtifacts.vsix)) {
    fail('recorded activation mode and VSIX presence do not match.');
  }
  for (const [kind, artifact] of Object.entries(inspectedArtifacts)) {
    if (artifact && artifact.version !== expectedVersion) {
      fail(`${kind} version ${artifact.version} does not match product version ${expectedVersion}.`);
    }
  }
  const artifacts = {
    tarball: tarball ? await retainArtifact(tarball, 'tarball', journal) : null,
    vsix: vsix ? await retainArtifact(vsix, 'vsix', journal) : null
  };
  const [installerBinding, validatorBinding] = await Promise.all([
    digestRegular(installer, 'installer'), digestRegular(validator, 'staged-artifact validator')
  ]);
  const previous = await capturePreviousState({
    journal, id, currentManifest: currentManifest ?? path.join(path.dirname(path.resolve(journal)), 'current.json'),
    cliVersion: previousObserved.cliVersion,
    vscodeVersion: previousObserved.vscodeVersion,
    copilotPresent: previousObserved.copilotPresent,
    telemetryEnvFile,
    telemetryProfile
  });
  const surfaceStates = {
    vscode: normalizedMode.cliOnly || normalizedMode.skipVscode ? 'skipped' : 'pending',
    copilot: normalizedMode.cliOnly || normalizedMode.vscodeOnly || normalizedMode.skipCopilot ? 'skipped' : 'pending',
    telemetry: normalizedMode.cliOnly || normalizedMode.vscodeOnly || normalizedMode.skipCopilot || !normalizedMode.telemetry
      ? 'skipped' : 'pending',
    cli: normalizedMode.vscodeOnly ? 'skipped' : 'pending',
    manifest: 'pending'
  };
  const record = {
    schemaVersion: 5, // schema-transient: machine-local installation recovery journal
    format: FORMAT,
    operation: 'normal-install-activation',
    operationId: operationId(id),
    revision: 1,
    status: 'staged',
    surface: 'staged',
    checkout: path.resolve(text(checkout, 'checkout')),
    version: expectedVersion,
    registry: validateRegistry(registry),
    mode: normalizedMode,
    artifacts,
    previous,
    completedSurfaces: [],
    skippedSurfaces: [],
    surfaceStates,
    rollbackFailures: [],
    recoveryCommand: text(recoveryCommand, 'recovery command'),
    installer: installerBinding,
    validator: validatorBinding,
    failureStep: null,
    updatedAt: now
  };
  validateJournalShape(structuredClone(record), journal);
  await withJournalMutationLock(journal, async () => atomicWrite(journal, record));
  return record;
}

export async function updateActivationJournal(journal, {
  status, surface, completed = null, skipped = null, failureStep = null,
  operationId: id, ownerPid = process.pid, expectedRevision,
  transitionSurface = null, transitionState = null, rollbackFailure = null,
  now = new Date().toISOString()
}) {
  await assertActivationLease(journal, id, ownerPid);
  const expectedId = operationId(id);
  const expected = positiveInteger(expectedRevision, 'expected activation journal revision');
  return withJournalMutationLock(journal, async () => {
    const record = await readJournal(journal);
    if (record.operationId !== expectedId) {
      fail('activation journal operation changed; refusing a cross-operation update.');
    }
    if (record.revision !== expected) {
      fail(`activation journal revision changed; expected ${expected}, found ${record.revision}.`);
    }
    const allowedStatuses = {
      staged: new Set(['staged', 'activating', 'rolling-back']),
      activating: new Set(['activating', 'rolling-back', 'complete']),
      'rolling-back': new Set(['rolling-back', 'rolled-back', 'rollback-failed']),
      'rollback-failed': new Set(['rollback-failed', 'rolling-back']),
      'rolled-back': new Set(['rolled-back', 'staged']),
      complete: new Set(['complete'])
    };
    if (!allowedStatuses[record.status]?.has(status)) {
      fail(`activation journal status transition ${record.status} -> ${status} is invalid.`);
    }
    if ((transitionSurface == null) !== (transitionState == null)) {
      fail('surface transition requires both surface and state.');
    }
    if (transitionSurface != null) {
      if (!SURFACES.includes(transitionSurface) || !SURFACE_STATES.has(transitionState)) {
        fail('surface transition is invalid.');
      }
      const from = record.surfaceStates[transitionSurface];
      const allowed = {
        pending: new Set(['pending', 'applying', 'skipped']),
        applying: new Set(['applying', 'applied', 'restoring']),
        applied: new Set(['applied', 'restoring']),
        restoring: new Set(['restoring', 'restored']),
        restored: new Set(['restored', 'pending']),
        skipped: new Set(['skipped'])
      };
      if (!allowed[from].has(transitionState)) {
        fail(`activation surface ${transitionSurface} transition ${from} -> ${transitionState} is invalid.`);
      }
      record.surfaceStates[transitionSurface] = transitionState;
    }
    record.status = status;
    record.surface = text(surface, 'updated surface', { max: 256 });
    record.failureStep = failureStep == null ? null : text(failureStep, 'failure step', { max: 256 });
    if (completed) record.completedSurfaces = [...new Set([...record.completedSurfaces, text(completed, 'completed surface', { max: 256 })])];
    if (skipped) record.skippedSurfaces = [...new Set([...record.skippedSurfaces, text(skipped, 'skipped surface', { max: 256 })])];
    if (rollbackFailure) {
      record.rollbackFailures = [...new Set([
        ...record.rollbackFailures, text(rollbackFailure, 'rollback failure', { max: 256 })
      ])];
    }
    if (status === 'complete' && Object.values(record.surfaceStates).some((state) => !['applied', 'skipped'].includes(state))) {
      fail('activation cannot complete until every requested surface is applied or skipped.');
    }
    if (status === 'rolled-back' && Object.values(record.surfaceStates).some((state) => ['applying', 'applied', 'restoring'].includes(state))) {
      fail('activation cannot be marked rolled back while a touched surface remains unrestored.');
    }
    if (status === 'rollback-failed' && record.rollbackFailures.length === 0) {
      fail('rollback-failed requires at least one exact failed surface.');
    }
    record.revision += 1;
    record.updatedAt = now;
    await atomicWrite(journal, record);
    return record;
  });
}

export async function resetActivationJournalForRetry(journal, {
  operationId: id, ownerPid = process.pid, expectedRevision, now = new Date().toISOString()
}) {
  await assertActivationLease(journal, id, ownerPid);
  const expectedId = operationId(id);
  const expected = positiveInteger(expectedRevision, 'expected activation journal revision');
  return withJournalMutationLock(journal, async () => {
    const record = await readJournal(journal);
    if (record.operationId !== expectedId || record.revision !== expected) {
      fail('activation retry reset lost its operation or revision compare-and-swap.');
    }
    if (record.status !== 'rolled-back') fail('activation retry requires a verified rolled-back journal.');
    for (const surface of SURFACES) {
      if (record.surfaceStates[surface] === 'restored') record.surfaceStates[surface] = 'pending';
    }
    record.status = 'staged';
    record.surface = 'retry-staged';
    record.completedSurfaces = [];
    record.skippedSurfaces = [];
    record.rollbackFailures = [];
    record.failureStep = null;
    record.revision += 1;
    record.updatedAt = now;
    await atomicWrite(journal, record);
    return record;
  });
}

export async function loadActivationRecovery({
  journal, checkout, installer, validator = helperFile, operationId: id, ownerPid = process.pid
}) {
  await assertActivationLease(journal, id, ownerPid);
  const record = await readJournal(journal);
  if (record.operationId !== operationId(id)) {
    fail('activation journal operation changed; refusing cross-operation recovery.');
  }
  if (record.status === 'complete') fail('activation journal is already complete; no staged recovery is pending.');
  if (record.checkout !== path.resolve(checkout)) fail('activation journal belongs to a different checkout.');
  const [currentInstaller, currentValidator] = await Promise.all([
    digestRegular(installer, 'installer'), digestRegular(validator, 'staged-artifact validator')
  ]);
  if (JSON.stringify(currentInstaller) !== JSON.stringify(record.installer)
      || JSON.stringify(currentValidator) !== JSON.stringify(record.validator)) {
    fail('installer or validator bytes changed after artifacts were staged. Run a normal reviewed install again.');
  }
  const observed = {
    tarball: record.artifacts.tarball
      ? await retainedArtifactDirectory(journal, record.artifacts.tarball.sha256)
        .then(() => inspectNpmTarball(record.artifacts.tarball.path))
      : null,
    vsix: record.artifacts.vsix
      ? await retainedArtifactDirectory(journal, record.artifacts.vsix.sha256)
        .then(() => inspectVsix(record.artifacts.vsix.path))
      : null
  };
  for (const kind of ['tarball', 'vsix']) {
    if (JSON.stringify(observed[kind]) !== JSON.stringify(record.artifacts[kind])) {
      fail(`${kind} bytes or package identity changed after staging.`);
    }
  }
  for (const [kind, artifact] of [['tarball', record.previous.cli], ['vsix', record.previous.vscode]]) {
    if (!artifact) continue;
    const inspected = kind === 'tarball' ? await inspectNpmTarball(artifact.path) : await inspectVsix(artifact.path);
    if (JSON.stringify(inspected) !== JSON.stringify(artifact)) {
      fail(`previous ${kind} rollback artifact changed after admission.`);
    }
  }
  if (record.previous.telemetry) {
    record.previous.telemetry = {
      envFile: record.previous.telemetry.envFile ? await validatePreviousFileBinding(
        record.previous.telemetry.envFile, journal, record.operationId, 'telemetry-env'
      ) : null,
      profile: record.previous.telemetry.profile ? await validatePreviousFileBinding(
        record.previous.telemetry.profile, journal, record.operationId, 'telemetry-profile'
      ) : null
    };
  }
  record.previous.manifest = await validatePreviousFileBinding(
    record.previous.manifest, journal, record.operationId, 'current-manifest'
  );
  return record;
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null) fail('helper options must be --name value pairs.');
    if (Object.hasOwn(result, key)) fail(`duplicate helper option ${key}.`);
    result[key] = value;
  }
  return result;
}

const switchValue = (value, label) => {
  if (!['on', 'off'].includes(value)) fail(`${label} must be on or off.`);
  return value === 'on';
};
const optional = (value) => value === '-' ? null : value;

async function commandLine() {
  const [command, ...rest] = process.argv.slice(2);
  const args = options(rest);
  if (command === 'lease-acquire') {
    const lease = await acquireActivationLease({
      journal: args['--journal'], checkout: args['--checkout'], mode: args['--mode'],
      ownerPid: args['--owner-pid']
    });
    process.stdout.write(`${lease.operationId}\n${lease.ownerPid}\n`);
    return;
  }
  if (command === 'lease-release') {
    await releaseActivationLease({
      journal: args['--journal'], operationId: args['--operation-id'], ownerPid: args['--owner-pid']
    });
    return;
  }
  if (command === 'lease-heartbeat') {
    await heartbeatActivationLease({
      journal: args['--journal'], operationId: args['--operation-id'], ownerPid: args['--owner-pid']
    });
    return;
  }
  if (command === 'lease-heartbeat-loop') {
    for (;;) {
      await delay(5_000);
      await heartbeatActivationLease({
        journal: args['--journal'], operationId: args['--operation-id'], ownerPid: args['--owner-pid']
      });
    }
  }
  if (command === 'create') {
    const record = await createActivationJournal({
      journal: args['--journal'], checkout: args['--checkout'], registry: args['--registry'],
      version: args['--version'], tarball: optional(args['--tarball']), vsix: optional(args['--vsix']),
      installer: args['--installer'], recoveryCommand: args['--recovery-command'],
      operationId: args['--operation-id'], ownerPid: args['--owner-pid'],
      currentManifest: args['--current-manifest'],
      previousObserved: {
        cliVersion: optional(args['--previous-cli']),
        vscodeVersion: optional(args['--previous-vscode']),
        copilotPresent: switchValue(args['--previous-copilot'], '--previous-copilot')
      },
      telemetryEnvFile: optional(args['--telemetry-env-file']),
      telemetryProfile: optional(args['--telemetry-profile']),
      mode: {
        cliOnly: switchValue(args['--cli-only'], '--cli-only'),
        vscodeOnly: switchValue(args['--vscode-only'], '--vscode-only'),
        skipVscode: switchValue(args['--skip-vscode'], '--skip-vscode'),
        skipCopilot: switchValue(args['--skip-copilot'], '--skip-copilot'),
        telemetry: switchValue(args['--telemetry'], '--telemetry'),
        workspaceRefresh: switchValue(args['--workspace-refresh'], '--workspace-refresh')
      }
    });
    process.stdout.write(`${[
      record.artifacts.tarball?.path ?? '-', record.artifacts.vsix?.path ?? '-',
      record.artifacts.tarball?.sha256 ?? '-', record.artifacts.vsix?.sha256 ?? '-',
      record.operationId, record.revision
    ].join('\n')}\n`);
    return;
  }
  if (command === 'update') {
    const record = await updateActivationJournal(args['--journal'], {
      status: args['--status'], surface: args['--surface'],
      completed: optional(args['--completed']), skipped: optional(args['--skipped']),
      failureStep: optional(args['--failure-step']), operationId: args['--operation-id'],
      ownerPid: args['--owner-pid'], expectedRevision: args['--expected-revision'],
      transitionSurface: optional(args['--transition-surface']),
      transitionState: optional(args['--transition-state']),
      rollbackFailure: optional(args['--rollback-failure'])
    });
    process.stdout.write(`${record.revision}\n`);
    return;
  }
  if (command === 'reset') {
    const record = await resetActivationJournalForRetry(args['--journal'], {
      operationId: args['--operation-id'], ownerPid: args['--owner-pid'],
      expectedRevision: args['--expected-revision']
    });
    process.stdout.write(`${record.revision}\n`);
    return;
  }
  if (command === 'resume') {
    const record = await loadActivationRecovery({
      journal: args['--journal'], checkout: args['--checkout'], installer: args['--installer'],
      operationId: args['--operation-id'], ownerPid: args['--owner-pid']
    });
    const fileLines = (binding) => binding
      ? [
        binding.target, binding.existed ? 'on' : 'off', binding.snapshot ?? '-', binding.sha256 ?? '-',
        binding.mode == null ? '-' : binding.mode.toString(8)
      ]
      : ['-', 'off', '-', '-', '-'];
    const lines = [
      record.registry, record.version,
      record.artifacts.tarball?.path ?? '-', record.artifacts.vsix?.path ?? '-',
      record.mode.cliOnly ? 'on' : 'off', record.mode.vscodeOnly ? 'on' : 'off',
      record.mode.skipVscode ? 'on' : 'off', record.mode.skipCopilot ? 'on' : 'off',
      record.mode.telemetry ? 'on' : 'off', record.mode.workspaceRefresh ? 'on' : 'off', record.recoveryCommand,
      record.artifacts.tarball?.sha256 ?? '-', record.operationId, record.revision,
      record.status,
      record.previous.cliPresent ? 'on' : 'off', record.previous.cli?.path ?? '-', record.previous.cli?.sha256 ?? '-',
      record.previous.cli?.version ?? '-',
      record.previous.vscodePresent ? 'on' : 'off', record.previous.vscode?.path ?? '-', record.previous.vscode?.sha256 ?? '-',
      record.previous.vscode?.version ?? '-',
      record.previous.copilotPresent ? 'on' : 'off',
      ...fileLines(record.previous.telemetry?.envFile),
      ...fileLines(record.previous.telemetry?.profile),
      ...fileLines(record.previous.manifest),
      ...SURFACES.map((surface) => record.surfaceStates[surface]),
      record.artifacts.vsix?.sha256 ?? '-'
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }
  if (command === 'verify-cli') {
    const verified = await verifyStagedCli({ prefix: args['--prefix'], version: args['--version'] });
    process.stdout.write(`${verified.executable}\n`);
    return;
  }
  fail('expected lease-acquire, lease-heartbeat, lease-heartbeat-loop, lease-release, create, update, reset, resume, or verify-cli.');
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
const helperRealPath = await realpath(helperFile).catch(() => helperFile);
if (invokedPath === helperRealPath) {
  commandLine().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
