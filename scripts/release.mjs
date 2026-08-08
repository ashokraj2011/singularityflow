#!/usr/bin/env node
/**
 * Build the two artefacts a release consists of, and nothing else.
 *
 * Singularity Flow ships as two files, not three: the npm tarball carries the CLI *and* the Copilot
 * plugin (`plugin/` is in `package.json` `files`), and the `.vsix` carries the extension with a full
 * CLI staged inside it. Both install identically on Windows, macOS and Linux — `install.sh` is a
 * build-from-source bootstrap for people working on the product, not the way anybody else gets it.
 *
 * This stays a local script on purpose. `scripts/check.mjs` fails the build if `.github/workflows/`
 * appears, so releases are cut from a machine, deliberately, by a person who can see the output.
 *
 * What it does not do is upload. The destination is an internal registry that differs per
 * organisation, and guessing at it in a tracked file would be worse than leaving the last step to
 * whoever knows the answer. It leaves `dist/` with both artefacts and their checksums, ready to go.
 *
 *   node scripts/release.mjs [--dry-run] [--skip-tests]
 *
 * `--dry-run` builds everything and writes nothing to `dist/`, so the whole pipeline can be
 * rehearsed. `--skip-tests` exists for a rebuild minutes after a green run; it prints a warning,
 * because a release nobody tested is the thing this script is for preventing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'apps', 'vscode');
const dist = path.join(root, 'dist');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const skipTests = argv.includes('--skip-tests');

function step(message) { console.log(`\n• ${message}`); }

function must(command, args, { cwd = root, json = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: json ? ['inherit', 'pipe', 'inherit'] : 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}.`);
  }
  return result.stdout ?? '';
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function main() {
  // A release has to be reproducible from a commit, and a dirty tree means the artefact contains
  // something no one can point at.
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (dirty) {
    throw new Error(`The working tree is not clean, so this release would not be reproducible:\n${dirty}`);
  }

  // `npm run check` already asserts one version across the root package, the plugin manifest, the
  // extension, both package-lock entries and the marketplace manifest — so there is no separate
  // parity check to run here, and a mismatch fails before anything is built.
  step('Checking governance and the version across every manifest');
  must('npm', ['run', 'check']);

  if (skipTests) console.warn('  Warning: --skip-tests was passed. This release has not been tested.');
  else {
    step('Running the test suite');
    must('npm', ['test']);
    step('Proving model-independent operation and lifecycle paths');
    must('npm', ['run', 'test:no-model']);
    step('Proving manual authorship and import paths');
    must('npm', ['run', 'test:manual-authorship']);
  }

  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const { version } = manifest;
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

  step(`Packing the CLI and Copilot plugin (${version})`);
  const packed = JSON.parse(must('npm', ['pack', '--json'], { json: true }));
  const tarball = path.join(root, packed[0].filename);

  step('Building the VS Code extension');
  // Through the staging script, never `vsce` directly: `vsce package` on its own produces a .vsix
  // with no engine inside it, which installs cleanly and then fails to do anything.
  must('node', [path.join(root, 'scripts', 'vscode-dev.mjs'), '--package']);
  const vsix = path.join(extension, `${JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8')).name}-${version}.vsix`);
  if (!existsSync(vsix)) throw new Error(`The extension package was not produced at ${vsix}.`);

  if (dryRun) {
    step('Dry run: nothing written to dist/');
    console.log(`  ${path.relative(root, tarball)}`);
    console.log(`  ${path.relative(root, vsix)}`);
    await rm(tarball, { force: true });
    return;
  }

  step('Collecting dist/');
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  for (const artefact of [tarball, vsix]) {
    await copyFile(artefact, path.join(dist, path.basename(artefact)));
  }
  await rm(tarball, { force: true });

  const names = (await readdir(dist)).sort();
  const sums = [];
  for (const name of names) sums.push(`${await sha256(path.join(dist, name))}  ${name}`);
  await writeFile(path.join(dist, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  await writeFile(path.join(dist, 'RELEASE.json'), `${JSON.stringify({
    version, commit, node: process.version, builtOn: process.platform, artefacts: names
  }, null, 2)}\n`);

  console.log([
    '',
    `Release ${version} built from ${commit.slice(0, 12)}:`,
    ...names.map((name) => `  dist/${name}`),
    '',
    'Upload both artefacts to the internal registry, then install them with:',
    `  npm install --global <registry>/${path.basename(tarball)}`,
    '  singularity-flow plugin install',
    `  code --install-extension <path>/${path.basename(vsix)}`,
    '',
    'Those commands are the same on Windows, macOS and Linux.',
    ''
  ].join('\n'));
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  process.exitCode = 1;
});
