import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const VSIX_SOURCE_MANIFEST_ENV = 'SINGULARITY_FLOW_VSIX_SOURCE_MANIFEST';
export const VSIX_SOURCE_MANIFEST_SHA256_ENV = 'SINGULARITY_FLOW_VSIX_SOURCE_MANIFEST_SHA256';
export const VSIX_CLI_PAYLOAD = Object.freeze([
  'bin', 'src', 'docs', 'templates', 'plugin', 'schemas',
  'scripts/install-staged-artifacts.mjs',
  'package.json', 'HELP.md', 'LICENSE'
]);

/**
 * Runtime files whose presence cannot be inferred from the broad payload roots alone.
 *
 * Git-backed developer packaging deliberately admits only indexed files. That boundary prevents an
 * ignored archive or an ambient credential file from leaking into a VSIX, but it also means a newly
 * introduced module can be imported by tracked code while still being absent from the staged CLI.
 * Keep the cross-surface command-guidance entry points explicit here so staging fails at the copy
 * boundary, with the missing path, instead of producing a VSIX that crashes on first command use.
 */
export const VSIX_REQUIRED_CLI_RUNTIME = Object.freeze([
  'src/gal-async-read.mjs',
  'src/workflow-transfer.mjs',
  'src/safe-command-guidance.mjs',
  'src/phase-preparation-guidance.mjs',
  'src/world-model/history/story-grounding-activation.mjs',
  'schemas/story-world-model-history-pin.schema.json',
  'plugin/skills/sflow-sgos/SKILL.md'
]);

const FORMAT_VERSION = 1;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_SHA256 = /^[a-f0-9]{64}$/u;
const GENERATED_EXTENSION_ROOTS = new Set(['cli', 'dist', 'node_modules']);
const PACKAGE_CONTROL_PAYLOAD = Object.freeze([
  'scripts/reproducible-build.mjs',
  'scripts/vsce-reproducible-preload.cjs',
  'scripts/vscode-dev.mjs',
  'toolchains/vsce/package.json',
  'toolchains/vsce/package-lock.json'
]);

export function vsixSourceManifestRequested(environment = process.env) {
  const hasPath = Object.hasOwn(environment, VSIX_SOURCE_MANIFEST_ENV);
  const hasDigest = Object.hasOwn(environment, VSIX_SOURCE_MANIFEST_SHA256_ENV);
  if (hasPath !== hasDigest) {
    throw new Error('Incomplete VSIX source manifest authority. Run the clean reinstall preview again.');
  }
  return hasPath;
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function codePointOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function canonical(value) {
  return realpath(value).catch(() => path.resolve(value));
}

function safeRelative(value) {
  return typeof value === 'string'
    && value.length > 0
    && value === value.replaceAll('\\', '/')
    && !path.posix.isAbsolute(value)
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    && !/\.vsix$/iu.test(value);
}

async function collectRecords(sourceRoot, current, records, { extension = false } = {}) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => codePointOrder(left.name, right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(sourceRoot, absolute).split(path.sep).join('/');
    const extensionRelative = extension
      ? path.relative(path.join(sourceRoot, 'apps', 'vscode'), absolute).split(path.sep).join('/')
      : null;
    if (extension && extensionRelative.split('/').length === 1
        && GENERATED_EXTENSION_ROOTS.has(extensionRelative)) continue;
    if (/\.vsix$/iu.test(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`VSIX source snapshot cannot contain a symbolic link: ${relative}.`);
    }
    if (entry.isDirectory()) {
      await collectRecords(sourceRoot, absolute, records, { extension });
    } else if (entry.isFile()) {
      const bytes = await readFile(absolute);
      records.push({ path: relative, sha256: digest(bytes) });
    } else {
      throw new Error(`VSIX source snapshot contains an unsupported filesystem entry: ${relative}.`);
    }
  }
  return records;
}

async function sourceRecords(sourceRoot) {
  const records = [];
  for (const relative of [...VSIX_CLI_PAYLOAD, ...PACKAGE_CONTROL_PAYLOAD]) {
    const absolute = path.join(sourceRoot, ...relative.split('/'));
    const metadata = await lstat(absolute).catch(() => null);
    if (metadata == null) continue;
    if (metadata.isSymbolicLink()) {
      throw new Error(`VSIX source snapshot cannot contain a symbolic link: ${relative}.`);
    }
    if (metadata.isDirectory()) await collectRecords(sourceRoot, absolute, records);
    else if (metadata.isFile()) {
      records.push({ path: relative, sha256: digest(await readFile(absolute)) });
    } else throw new Error(`VSIX source snapshot contains an unsupported filesystem entry: ${relative}.`);
  }
  const extensionRoot = path.join(sourceRoot, 'apps', 'vscode');
  const extensionMetadata = await lstat(extensionRoot).catch(() => null);
  if (!extensionMetadata?.isDirectory() || extensionMetadata.isSymbolicLink()) {
    throw new Error('VSIX source snapshot requires an ordinary apps/vscode directory.');
  }
  await collectRecords(sourceRoot, extensionRoot, records, { extension: true });
  const unique = new Map();
  for (const record of records) unique.set(record.path, record);
  return [...unique.values()].sort((left, right) => codePointOrder(left.path, right.path));
}

/**
 * Capture the immutable, non-generated extension inputs of a validated Git-less reinstall copy.
 *
 * This is a private transport record between the reinstall builder and the VSIX packager. It is
 * deliberately stored outside the copied source root and is never shipped in either artifact.
 */
export async function writeVsixSourceManifest({ rootDir, targetFile, sourceSha256 }) {
  if (!SOURCE_SHA256.test(String(sourceSha256 ?? ''))) {
    throw new Error('VSIX source manifest requires the validated reinstall source SHA-256.');
  }
  const sourceRoot = await canonical(rootDir);
  const records = await sourceRecords(sourceRoot);
  const manifest = {
    formatVersion: FORMAT_VERSION,
    sourceRoot,
    sourceSha256,
    records
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(targetFile, bytes, { mode: 0o600 });
  return { path: targetFile, sha256: digest(bytes), manifest };
}

function validateRecord(record, previous) {
  if (!record || typeof record !== 'object' || !safeRelative(record.path)
      || !SHA256.test(String(record.sha256 ?? ''))) {
    throw new Error('VSIX source manifest contains an invalid source record.');
  }
  if (previous != null && codePointOrder(previous, record.path) >= 0) {
    throw new Error('VSIX source manifest paths must be unique and code-point sorted.');
  }
}

/** Load and re-admit the private reinstall source snapshot carried through npm. */
export async function readVerifiedVsixSourceManifest({ rootDir, environment = process.env }) {
  if (!vsixSourceManifestRequested(environment)) return null;
  const manifestFile = String(environment[VSIX_SOURCE_MANIFEST_ENV] ?? '');
  const expectedDigest = String(environment[VSIX_SOURCE_MANIFEST_SHA256_ENV] ?? '');
  if (!path.isAbsolute(manifestFile) || !SHA256.test(expectedDigest)) {
    throw new Error('VSIX source manifest authority is malformed. Run the clean reinstall preview again.');
  }
  const [sourceRoot, manifestPath] = await Promise.all([
    canonical(rootDir), canonical(manifestFile)
  ]);
  const relativeManifest = path.relative(sourceRoot, manifestPath);
  if (relativeManifest === '' || (!relativeManifest.startsWith(`..${path.sep}`) && relativeManifest !== '..')) {
    throw new Error('VSIX source manifest must remain outside the copied source root.');
  }
  const metadata = await lstat(manifestPath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error('VSIX source manifest must be an ordinary file.');
  }
  const bytes = await readFile(manifestPath);
  if (digest(bytes) !== expectedDigest) {
    throw new Error('VSIX source manifest bytes changed after the reinstall source was validated.');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('VSIX source manifest is not valid JSON.'); }
  if (manifest?.formatVersion !== FORMAT_VERSION
      || await canonical(manifest.sourceRoot ?? '') !== sourceRoot
      || !SOURCE_SHA256.test(String(manifest.sourceSha256 ?? ''))
      || !Array.isArray(manifest.records)) {
    throw new Error('VSIX source manifest does not describe this validated source root.');
  }
  let previous = null;
  for (const record of manifest.records) {
    validateRecord(record, previous);
    previous = record.path;
  }
  const current = await sourceRecords(sourceRoot);
  if (current.length !== manifest.records.length) {
    throw new Error('VSIX source inputs changed after the reinstall source was validated.');
  }
  for (let index = 0; index < current.length; index += 1) {
    if (current[index].path !== manifest.records[index].path
        || current[index].sha256 !== manifest.records[index].sha256) {
      throw new Error(`VSIX source input changed after validation: ${current[index].path}.`);
    }
  }
  return Object.freeze({
    sourceRoot,
    sourceSha256: manifest.sourceSha256,
    records: new Map(manifest.records.map((record) => [record.path, record.sha256]))
  });
}
