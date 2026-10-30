#!/usr/bin/env node
/** Source-install build hygiene; exact staged-artifact recovery never enters this helper. */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GENERATED_PRIVACY_DIRECTORIES, documentationPrivacyProblems, generatedPrivacyFiles,
  isDocumentationPath, readConfiguredPrivacyTerms, sourcePrivacyProblems
} from './documentation-privacy.mjs';

const directoryIdentity = metadata => `${metadata.dev}:${metadata.ino}`;
async function inspectDirectory(absolute) {
  const metadata = await lstat(absolute, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('a path component is linked or is not a directory');
  if (metadata.ino === 0n) throw new Error(`Cannot establish filesystem identity for build cleanup: ${absolute}`);
  return { absolute, identity: directoryIdentity(metadata) };
}
async function verifyDirectories(directories) {
  for (const directory of directories) {
    if ((await inspectDirectory(directory.absolute)).identity !== directory.identity) {
      throw new Error(`Build-output directory identity changed: ${directory.absolute}`);
    }
  }
}
async function captureDirectory({ name, expectedParent, expectedOutput, staged, expectedStaging }) {
  if (!['bundle', 'dist'].includes(name) || typeof expectedParent !== 'string' || typeof expectedOutput !== 'string'
      || typeof expectedStaging !== 'string' || typeof staged !== 'string' || !path.isAbsolute(staged)
      || !/^[01]$/u.test(path.basename(staged))
      || !/^bundle\.building-cleanup-[a-z0-9]+$/iu.test(path.basename(path.dirname(staged)))) {
    throw new Error('Invalid private build-output capture request');
  }
  for (let attempt = 0; ; attempt++) {
    // The OS pins this process's cwd to an actual directory. Relative source access cannot follow
    // a replacement symlink at its former absolute path; if cwd selected a replacement on launch,
    // its identity fails here before anything moves. This works on Windows without /proc or admin.
    await verifyDirectories([{ absolute: '.', identity: expectedParent }, { absolute: name, identity: expectedOutput },
      { absolute: path.dirname(staged), identity: expectedStaging }]);
    try { return await rename(name, staged); }
    catch (error) {
      if (attempt >= 8 || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await delay(150 * (attempt + 1));
    }
  }
}
async function stageDirectory(directory, stagingIdentity, injectFault) {
  await verifyDirectories(directory.chain);
  await injectFault('before-output-capture', directory);
  const request = { name: path.basename(directory.absolute), expectedParent: directory.chain.at(-2).identity,
    expectedOutput: directory.chain.at(-1).identity, staged: directory.staged, expectedStaging: stagingIdentity };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'capture-directory'], {
      cwd: path.dirname(directory.absolute), stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true
    });
    let detail = '', timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 30_000);
    child.stderr.on('data', bytes => { detail = (detail + bytes.toString('utf8')).slice(0, 16_384); });
    child.stdin.on('error', () => {}); // Early admission refusal can close stdin before its writer.
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(timedOut ? 'Build-output capture exceeded its 30-second deadline'
        : detail.trim() || `Build-output capture failed (${code})`));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Discard only ignored, regenerable outputs, never tracked source, links or recovery material. */
export async function cleanInstallBuildOutputs(root, { faultInjector = null } = {}) {
  // Tests change the filesystem at an exact boundary through this; the installer never passes one.
  const injectFault = async (boundary, directory) => {
    if (typeof faultInjector === 'function') await faultInjector(boundary, directory.relative);
  };
  const tracked = spawnSync('git', ['ls-files', '--cached', '-z', '--', ...GENERATED_PRIVACY_DIRECTORIES], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  if (tracked.status !== 0) throw new Error('Cannot verify build-output ownership; previous outputs were preserved.');
  if (tracked.stdout) throw new Error('Build-output directories contain tracked files; previous outputs were preserved.');
  const directories = [];
  const anchor = await inspectDirectory(path.resolve(root));
  // Capture parent and output identities before moving anything. Deletion will use private,
  // identity-checked staging paths, never these live paths whose parents another process can swap.
  for (const relative of GENERATED_PRIVACY_DIRECTORIES) {
    let current = path.resolve(root);
    const chain = [anchor];
    let present = true;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      const directory = await inspectDirectory(current).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw new Error(`Cannot clean ${relative}: ${error.message}; previous outputs were preserved.`);
      });
      if (!directory) { present = false; break; }
      chain.push(directory);
    }
    if (present) directories.push({ relative, absolute: current, chain });
  }
  if (!directories.length) return [];
  // This existing ignored build-staging namespace is excluded from source copies and packages.
  // Keeping it beside the outputs also permits atomic moves with a Git directory on another drive.
  const quarantine = await mkdtemp(path.join(path.resolve(root), 'bundle.building-cleanup-'));
  const quarantineIdentity = await inspectDirectory(quarantine);
  const staged = directories.map((directory, index) => ({ ...directory, staged: path.join(quarantine, String(index)) }));
  await writeFile(path.join(quarantine, 'retained.json'), JSON.stringify(staged.map(directory => ({
    original: directory.absolute, retained: directory.staged, identity: directory.chain.at(-1).identity
  })), null, 2), { flag: 'wx', mode: 0o600 });
  try {
    // Move every output before deleting any. A changed source can at worst be retained for
    // inspection: its identity must agree after the atomic move before deletion is admitted.
    for (const directory of staged) {
      await verifyDirectories([quarantineIdentity]);
      await stageDirectory(directory, quarantineIdentity.identity, injectFault);
      const captured = await inspectDirectory(directory.staged);
      if (captured.identity !== directory.chain.at(-1).identity) throw new Error('Build output changed while being staged');
      await injectFault('after-output-staged', directory);
    }
    for (const directory of staged) {
      await verifyDirectories([quarantineIdentity, { absolute: directory.staged, identity: directory.chain.at(-1).identity }]);
      // Antivirus and indexing can briefly hold generated files on Windows. Retry deletion only
      // inside this invocation's private staging directory, never through the live output paths.
      await rm(directory.staged, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
      await injectFault('after-output-deleted', directory);
    }
    await rm(path.join(quarantine, 'retained.json'));
    await rm(quarantine, { recursive: true });
  } catch (error) {
    throw new Error(`${error.message}. Build cleanup stopped; inspect retained output and its recovery record at ${quarantine}.`);
  }
  // Do not let the subsequent build follow an ancestor replaced while deletion was in progress.
  for (const directory of directories) {
    await verifyDirectories(directory.chain.slice(0, -1));
    const recreated = await lstat(directory.absolute).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (recreated) throw new Error(`Build-output path was recreated during cleanup: ${directory.absolute}`);
  }
  return directories.map(directory => directory.relative);
}

/** The output check stays mandatory even when the installer skips its long test suite. */
export async function verifyInstallBuildOutputs(root, { personalTerms = readConfiguredPrivacyTerms(root) } = {}) {
  const files = await generatedPrivacyFiles(root);
  const problems = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    const bytes = await readFile(file);
    const text = bytes.includes(0) ? '' : bytes.toString('utf8');
    problems.push(...(isDocumentationPath(relative)
      ? documentationPrivacyProblems(relative, text, personalTerms)
      : sourcePrivacyProblems(relative, text, personalTerms)));
  }
  if (problems.length) throw new Error(`Rebuilt output privacy check failed (${problems.length} issues):\n- ${problems.join('\n- ')}`);
  return { files: files.length };
}

// macOS exposes the same temporary directory through /var and /private/var. Comparing lexical
// URLs would silently skip the entry point for an installer invoked through the shorter alias.
const entryFile = process.argv[1] && await realpath(process.argv[1]).catch(() => null);
if (entryFile && entryFile === await realpath(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const [action, ...extra] = process.argv.slice(2);
    if (extra.length || !['clean', 'verify', 'capture-directory'].includes(action)) throw new Error('Usage: node scripts/install-build-outputs.mjs <clean|verify>');
    if (action === 'capture-directory') {
      const request = readFileSync(0, 'utf8');
      if (Buffer.byteLength(request) > 16_384) throw new Error('Private capture request is too large');
      await captureDirectory(JSON.parse(request));
    } else if (action === 'clean') {
      const removed = await cleanInstallBuildOutputs(root);
      console.log(removed.length ? `Removed previous build outputs: ${removed.join(', ')}.` : 'Build outputs are clean.');
    } else {
      const result = await verifyInstallBuildOutputs(root);
      console.log(`Rebuilt output privacy check passed (${result.files} files).`);
    }
  } catch (error) {
    console.error(`Install build-output check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
