#!/usr/bin/env node
/**
 * Minimal distribution trust bootstrap.
 *
 * This file intentionally imports only Node built-ins. It verifies the artifact-builder signature
 * and snapshots the exact release metadata, operator assets, public key, npm tarball, and VSIX
 * before any package code is executed. The verified npm snapshot then supplies the richer
 * sf-install/sf-uninstall runner; that runner never reopens mutable trust or release inputs.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  createHash, createPublicKey, verify as verifyBytes
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod, lstat, mkdir, mkdtemp, open, realpath, rm
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const SHA256_SUM = /^([a-f0-9]{64})  ([^\0\r\n]+)$/u;
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
const CMD_ENV_EXPANSION = /[%!]/u;

function fail(message) {
  throw new Error(`Singularity Flow distribution bootstrap refused: ${message}`);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

async function stableBytes(file, label, maximum = MAX_JSON_BYTES, { singleLink = false } = {}) {
  const absolute = path.resolve(file);
  const before = await lstat(absolute).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum) {
    fail(`${label} is not a bounded ordinary file: ${absolute}`);
  }
  let handle;
  try { handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { fail(`${label} could not be opened without following a link: ${absolute}`); }
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(absolute).catch(() => null);
    if (!opened.isFile() || bytes.length !== opened.size || !after?.isFile() || after.isSymbolicLink()
        || (singleLink && opened.nlink && opened.nlink !== 1)
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      fail(`${label} changed while it was read: ${absolute}`);
    }
    return { absolute, bytes };
  } finally { await handle.close(); }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function windowsEnvironmentValue(environment, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const key = Object.keys(environment).find((entry) => wanted.has(entry.toLowerCase()));
  return key == null ? null : environment[key];
}

function windowsSystemTool(environment, name) {
  const root = String(windowsEnvironmentValue(environment, ['SystemRoot', 'WINDIR']) ?? '').trim();
  if (!/^[a-z]:[\\/]/iu.test(root)) fail(`Windows cannot resolve trusted ${name} without SystemRoot.`);
  return path.win32.join(root, 'System32', name);
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META, '^$1');
}

function escapeCmdArgument(value) {
  const input = String(value);
  if (/[\0\r\n]/u.test(input) || CMD_ENV_EXPANSION.test(input)) {
    fail('Windows npm arguments cannot contain controls, percent signs, or exclamation marks.');
  }
  let escaped = input.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, '$1$1');
  escaped = `"${escaped}"`.replace(CMD_META, '^$1');
  return escaped.replace(CMD_META, '^$1');
}

function resolveWindowsNpm(environment) {
  const where = windowsSystemTool(environment, 'where.exe');
  const result = spawnSync(where, ['$PATH:npm.cmd'], {
    cwd: path.win32.dirname(where), env: environment, encoding: 'utf8', windowsHide: true,
    timeout: 5_000, shell: false
  });
  if (result.error || result.status !== 0) fail('Windows could not resolve npm.cmd from PATH.');
  const candidates = String(result.stdout ?? '').split(/\r?\n/u).map((entry) => entry.trim())
    .filter((entry) => /^[a-z]:[\\/]/iu.test(entry)
      && path.win32.basename(entry).toLowerCase() === 'npm.cmd');
  const selected = candidates[0];
  if (!selected || CMD_ENV_EXPANSION.test(selected)) fail('Windows resolved an unsafe npm.cmd path.');
  const info = lstat(selected).catch(() => null);
  return Promise.resolve(info).then((value) => {
    if (!value?.isFile() || value.isSymbolicLink()) fail('Windows npm.cmd is not an ordinary file.');
    return selected;
  });
}

async function npmLaunch(arguments_, environment) {
  if (process.platform !== 'win32') {
    return { command: 'npm', arguments: arguments_, options: { shell: false } };
  }
  const target = await resolveWindowsNpm(environment);
  const comSpec = windowsSystemTool(environment, 'cmd.exe');
  const configured = String(windowsEnvironmentValue(environment, ['ComSpec']) ?? '').trim();
  if (configured && path.win32.normalize(configured).toLowerCase()
      !== path.win32.normalize(comSpec).toLowerCase()) {
    fail('Windows ComSpec must identify SystemRoot\\System32\\cmd.exe.');
  }
  const commandLine = [escapeCmdCommand(target), ...arguments_.map(escapeCmdArgument)].join(' ');
  return {
    command: comSpec,
    arguments: ['/d', '/s', '/v:off', '/c', `"${commandLine}"`],
    options: { shell: false, windowsVerbatimArguments: true, windowsHide: true }
  };
}

function positiveTimeout(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function terminateProcessTree(child, environment, { force = false } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const taskkill = windowsSystemTool(environment, 'taskkill.exe');
    spawnSync(taskkill, ['/pid', String(child.pid), '/t', '/f'], {
      cwd: path.win32.dirname(taskkill), env: environment, encoding: 'utf8', windowsHide: true,
      timeout: 10_000, shell: false
    });
    return;
  }
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* already exited */ }
}

async function runNpm(launch, { cwd, environment, timeoutMs }) {
  const child = spawn(launch.command, launch.arguments, {
    cwd, env: environment, stdio: 'inherit', detached: process.platform !== 'win32',
    ...launch.options
  });
  let timedOut = false;
  let forceTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, environment);
    if (process.platform !== 'win32') {
      forceTimer = setTimeout(() => terminateProcessTree(child, environment, { force: true }), 5_000);
      forceTimer.unref();
    }
  }, timeoutMs);
  timeout.unref();
  const relay = () => terminateProcessTree(child, environment);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, relay);
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (timedOut) fail(`npm runner exceeded its ${timeoutMs}ms operation deadline.`);
    if (outcome.signal) fail(`npm runner ended on signal ${outcome.signal}.`);
    return outcome.code ?? 1;
  } finally {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, relay);
  }
}

async function stableJson(file, label) {
  const input = await stableBytes(file, label);
  try {
    const value = JSON.parse(input.bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object.`);
    return { ...input, value };
  } catch (error) {
    if (String(error?.message ?? '').startsWith('Singularity Flow distribution bootstrap refused:')) throw error;
    fail(`${label} is not valid JSON.`);
  }
}

function boundedNames(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail(`${label} must be a non-empty bounded array.`);
  }
  const result = value.map((entry) => {
    if (typeof entry !== 'string' || !SAFE_NAME.test(entry) || path.basename(entry) !== entry) {
      fail(`${label} contains an unsafe filename.`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) fail(`${label} contains a duplicate filename.`);
  return result;
}

function checksumBindings(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('SHA256SUMS is not valid UTF-8.'); }
  const result = new Map();
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(SHA256_SUM);
    if (!match || !SAFE_NAME.test(match[2]) || path.basename(match[2]) !== match[2]
        || result.has(match[2])) {
      fail('SHA256SUMS contains an invalid or duplicate record.');
    }
    result.set(match[2], match[1]);
  }
  if (!result.size) fail('SHA256SUMS is empty.');
  return result;
}

async function writeSnapshotBytes(destination, bytes, mode = 0o600) {
  const handle = await open(
    destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  await chmod(destination, mode);
}

async function snapshotChecksummedFile(source, destination, expectedSha256, label) {
  const input = await stableBytes(source, label, MAX_ARTIFACT_BYTES);
  if (sha256(input.bytes) !== `sha256:${expectedSha256}`) {
    fail(`${label} does not match SHA256SUMS.`);
  }
  await writeSnapshotBytes(destination, input.bytes);
}

function signedArtifacts(receipt, trustedKeyBytes) {
  const signature = receipt?.signature;
  if (signature?.algorithm !== 'ed25519') fail('artifact receipt has no Ed25519 signature.');
  let trusted;
  try { trusted = createPublicKey(trustedKeyBytes); }
  catch { fail('trusted artifact-builder public key is invalid.'); }
  if (trusted.asymmetricKeyType !== 'ed25519') fail('trusted artifact-builder key must be Ed25519.');
  const trustedDer = trusted.export({ type: 'spki', format: 'der' });
  let embedded;
  try { embedded = Buffer.from(String(signature.publicKeySpki ?? ''), 'base64'); }
  catch { fail('artifact receipt embedded key is invalid.'); }
  if (!embedded.equals(trustedDer) || signature.publicKeySha256 !== sha256(trustedDer)) {
    fail('artifact receipt signer is not the explicitly trusted builder key.');
  }
  const unsigned = structuredClone(receipt);
  delete unsigned.signature;
  const payload = canonicalJson(unsigned);
  if (signature.payloadSha256 !== sha256(payload)
      || !verifyBytes(null, Buffer.from(payload), trusted, Buffer.from(String(signature.value ?? ''), 'base64'))) {
    fail('artifact receipt signature or payload digest is invalid.');
  }
  if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== 2) {
    fail('artifact receipt must bind exactly the npm tarball and VSIX.');
  }
  const byKind = new Map();
  for (const artifact of receipt.artifacts) {
    if (!['cli-and-copilot-plugin', 'vscode-extension'].includes(artifact?.kind)
        || byKind.has(artifact.kind) || !SAFE_NAME.test(String(artifact.name ?? ''))
        || !SHA256.test(String(artifact.sha256 ?? ''))
        || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1
        || artifact.sizeBytes > MAX_ARTIFACT_BYTES) {
      fail('artifact receipt contains an invalid artifact binding.');
    }
    byKind.set(artifact.kind, artifact);
  }
  if (!byKind.has('cli-and-copilot-plugin') || !byKind.has('vscode-extension')) {
    fail('artifact receipt does not contain the required product pair.');
  }
  return { payloadSha256: signature.payloadSha256, byKind };
}

async function copyVerified(source, destination, expected) {
  const absolute = path.resolve(source);
  const before = await lstat(absolute).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink() || before.size !== expected.sizeBytes
      || path.basename(absolute) !== expected.name) {
    fail(`${expected.kind} is not the signed ordinary artifact file.`);
  }
  let input;
  try { input = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { fail(`${expected.kind} could not be opened without following a link.`); }
  const output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const opened = await input.stat();
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, opened.size));
    let total = 0;
    while (total < opened.size) {
      const { bytesRead } = await input.read(
        buffer, 0, Math.min(buffer.length, opened.size - total), total
      );
      if (bytesRead < 1) fail(`${expected.kind} ended while it was copied.`);
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, total + written);
        if (result.bytesWritten < 1) fail(`${expected.kind} snapshot write stopped early.`);
        written += result.bytesWritten;
      }
      total += bytesRead;
    }
    await output.sync();
    const after = await lstat(absolute).catch(() => null);
    if (opened.size !== expected.sizeBytes || total !== expected.sizeBytes
        || `sha256:${hash.digest('hex')}` !== expected.sha256
        || !after?.isFile() || after.isSymbolicLink()
        || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))
        || (after.ino && opened.ino && (after.ino !== opened.ino || after.dev !== opened.dev))) {
      fail(`${expected.kind} changed or does not match the signed artifact receipt.`);
    }
  } finally {
    await output.close();
    await input.close();
  }
}

function takeValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith('--')) fail(`${option} requires a value.`);
  return value;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const action = arguments_.shift();
  if (!['install', 'uninstall'].includes(action)) {
    fail('first argument must be install or uninstall.');
  }
  const forwarded = [];
  let keyFile = process.env.SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY || null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--artifact-key') { keyFile = takeValue(arguments_, index, argument); index += 1; }
    else if (argument.startsWith('--artifact-key=')) keyFile = argument.slice('--artifact-key='.length);
    else forwarded.push(argument);
  }
  if (!keyFile) {
    fail('provide --artifact-key <trusted-builder-public.pem> or SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY.');
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 20) fail(`Node.js 20 or newer is required; found ${process.versions.node}.`);
  const releaseDirectory = path.dirname(fileURLToPath(import.meta.url));
  const [receiptInput, releaseInput, sumsInput, keyInput] = await Promise.all([
    stableJson(path.join(releaseDirectory, 'ARTIFACT-RECEIPT.json'), 'ARTIFACT-RECEIPT.json'),
    stableJson(path.join(releaseDirectory, 'RELEASE.json'), 'RELEASE.json'),
    stableBytes(path.join(releaseDirectory, 'SHA256SUMS'), 'SHA256SUMS', 1024 * 1024),
    stableBytes(keyFile, 'trusted artifact-builder public key', 1024 * 1024, { singleLink: true })
  ]);
  const [canonicalRelease, canonicalKey] = await Promise.all([
    realpath(releaseDirectory), realpath(keyInput.absolute)
  ]);
  if (inside(canonicalRelease, canonicalKey)) {
    fail('trusted artifact-builder public key must remain outside the release directory.');
  }
  const authority = signedArtifacts(receiptInput.value, keyInput.bytes);
  if (releaseInput.value.artifactReceiptSha256 !== authority.payloadSha256) {
    fail('RELEASE.json does not bind the signed artifact receipt payload.');
  }
  const signedNames = [...authority.byKind.values()].map((entry) => entry.name).sort();
  if (JSON.stringify([...(releaseInput.value.artefacts ?? [])].sort()) !== JSON.stringify(signedNames)) {
    fail('RELEASE.json product artifacts do not match the signed receipt.');
  }
  const operatorScripts = boundedNames(
    releaseInput.value.operatorScripts, 'RELEASE.json operatorScripts'
  );
  const operatorDocumentation = boundedNames(
    releaseInput.value.operatorDocumentation, 'RELEASE.json operatorDocumentation'
  );
  const checksums = checksumBindings(sumsInput.bytes);
  const expectedFiles = [...signedNames, ...operatorScripts, ...operatorDocumentation];
  if (new Set(expectedFiles).size !== expectedFiles.length) {
    fail('RELEASE.json assigns the same filename to more than one release role.');
  }
  for (const name of expectedFiles) {
    if (!checksums.has(name)) fail(`SHA256SUMS does not bind '${name}'.`);
  }
  const snapshot = await mkdtemp(path.join(os.tmpdir(), 'sflow-distribution-bootstrap-'));
  await chmod(snapshot, 0o700);
  try {
    const snapshotRelease = path.join(snapshot, 'release');
    const snapshotTrust = path.join(snapshot, 'trust');
    await Promise.all([
      mkdir(snapshotRelease, { mode: 0o700 }),
      mkdir(snapshotTrust, { mode: 0o700 })
    ]);
    const snapshotKey = path.join(snapshotTrust, 'artifact-builder-public.pem');
    await Promise.all([
      writeSnapshotBytes(
        path.join(snapshotRelease, 'ARTIFACT-RECEIPT.json'), receiptInput.bytes
      ),
      writeSnapshotBytes(path.join(snapshotRelease, 'RELEASE.json'), releaseInput.bytes),
      writeSnapshotBytes(path.join(snapshotRelease, 'SHA256SUMS'), sumsInput.bytes),
      writeSnapshotBytes(snapshotKey, keyInput.bytes, 0o400)
    ]);
    for (const binding of authority.byKind.values()) {
      await copyVerified(
        path.join(releaseDirectory, binding.name), path.join(snapshotRelease, binding.name), binding
      );
    }
    for (const name of [...operatorScripts, ...operatorDocumentation]) {
      await snapshotChecksummedFile(
        path.join(releaseDirectory, name), path.join(snapshotRelease, name),
        checksums.get(name), `Distribution file ${name}`
      );
    }
    const npmBinding = authority.byKind.get('cli-and-copilot-plugin');
    const runner = action === 'install' ? 'sf-install' : 'sf-uninstall';
    const runnerArguments = [
      'exec', '--yes', '--offline', '--package', path.join(snapshotRelease, npmBinding.name), '--', runner,
      ...(action === 'install' ? [
        '--release-dir', snapshotRelease, '--artifact-key', snapshotKey
      ] : []),
      ...forwarded
    ];
    const childEnvironment = {
      ...process.env,
      NPM_CONFIG_CACHE: path.join(snapshot, 'npm-cache'),
      SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY: action === 'install' ? snapshotKey : canonicalKey,
      SINGULARITY_FLOW_DISTRIBUTION_RELEASE_DIR: action === 'install'
        ? snapshotRelease : canonicalRelease,
      // These paths are provenance for repeat-preview/recovery UX only. The installer must never
      // read release authority or artifact bytes from them after this bootstrap boundary.
      SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_ARTIFACT_KEY: canonicalKey,
      SINGULARITY_FLOW_DISTRIBUTION_ORIGIN_RELEASE_DIR: canonicalRelease,
      SINGULARITY_FLOW_DISTRIBUTION_BOOTSTRAPPED: '1'
    };
    await mkdir(childEnvironment.NPM_CONFIG_CACHE, { mode: 0o700 });
    const launch = await npmLaunch(runnerArguments, childEnvironment);
    const status = await runNpm(launch, {
      cwd: snapshot,
      environment: childEnvironment,
      timeoutMs: positiveTimeout(
        process.env.SINGULARITY_FLOW_DISTRIBUTION_RUNNER_TIMEOUT_MS, 1_800_000
      )
    });
    if (status !== 0) process.exitCode = status;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
