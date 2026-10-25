#!/usr/bin/env node
/** Source-install build hygiene; exact staged-artifact recovery never enters this helper. */
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_PRIVACY_DIRECTORIES, documentationPrivacyProblems, generatedPrivacyFiles,
  isDocumentationPath, readConfiguredPrivacyTerms, sourcePrivacyProblems
} from './documentation-privacy.mjs';

/** Discard only ignored, regenerable outputs, never tracked source, links or recovery material. */
export async function cleanInstallBuildOutputs(root) {
  const tracked = spawnSync('git', ['ls-files', '--cached', '-z', '--', ...GENERATED_PRIVACY_DIRECTORIES], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  if (tracked.status !== 0) throw new Error('Cannot verify build-output ownership; previous outputs were preserved.');
  if (tracked.stdout) throw new Error('Build-output directories contain tracked files; previous outputs were preserved.');
  const directories = [];
  // Preflight every component before removing anything. A linked apps/ or vscode/ must not let
  // cleanup reach another checkout, even when the dist/ leaf itself is an ordinary directory.
  for (const relative of GENERATED_PRIVACY_DIRECTORIES) {
    let current = path.resolve(root);
    let present = true;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      const metadata = await lstat(current).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!metadata) { present = false; break; }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Cannot clean ${relative}: a path component is linked or is not a directory; previous outputs were preserved.`);
      }
    }
    if (present) directories.push({ relative, absolute: current });
  }
  for (const directory of directories) {
    // Antivirus and indexing can briefly hold generated files on Windows. Retry only deletion
    // of these admitted build roots; do not broaden cleanup when a lock cannot be released.
    await rm(directory.absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
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
    if (extra.length || !['clean', 'verify'].includes(action)) throw new Error('Usage: node scripts/install-build-outputs.mjs <clean|verify>');
    if (action === 'clean') {
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
