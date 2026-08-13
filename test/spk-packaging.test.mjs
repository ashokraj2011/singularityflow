/**
 * Packaging. `[SPK:AC-009]`
 *
 * The clause asks for a fast-path command and constitution validation to run **from the exact
 * installed layout**, not from the working tree. The distinction has already cost this project once:
 * `apps/vscode/.gitignore` carried an unanchored `cli/` rule that also matched `src/cli/`, so the
 * extension built fine from a clone and failed from anything that honoured ignore rules while
 * copying. Everything looked correct until it was installed.
 *
 * So this packs the CLI with `npm pack`, unpacks it somewhere else, and runs the real binary there.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

/**
 * Pack the CLI and unpack it, so what runs below is what an install would place on disk.
 *
 * Dependencies are linked rather than installed. The property under test is whether the *package*
 * contains every file its own code imports — the defect class this exists for is a source file that
 * an ignore rule stripped, not a missing third-party module, and `npm install` here would add a
 * minute to every run to re-prove something npm already guarantees.
 */
async function installedCli() {
  const staging = await mkdtemp(path.join(os.tmpdir(), 'sflow-pack-'));
  // npm writes the tarball name to stdout and its file listing to stderr.
  const packed = run('npm', ['pack', '--pack-destination', staging], packageRoot);
  const tarball = packed.stdout.trim().split('\n').at(-1);
  run('tar', ['-xzf', path.join(staging, tarball)], staging);
  const root = path.join(staging, 'package');
  await symlink(path.join(packageRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  return { root, staging };
}

test('a fast-path verb and constitution validation run from the installed CLI layout', async () => {
  const { root: installed } = await installedCli();
  const cli = path.join(installed, 'bin', 'singularity-flow.mjs');

  // Everything the two commands touch has to be *in the package*. A file that exists only in the
  // working tree is the failure this test is for.
  for (const required of [
    'bin/singularity-flow.mjs', 'src/fast-path.mjs', 'src/commands/fast-path.mjs', 'src/constitution.mjs',
    'src/convergence.mjs', 'src/specification-quality.mjs', 'src/analysis-limits.mjs',
    'templates/workflow.yml', 'examples/constitution/constitution.md', 'src/docs-manifest.json'
  ]) {
    await readFile(path.join(installed, required), 'utf8');
  }

  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-installed-'));
  run('git', ['init', '-b', 'main'], repository);
  run('git', ['config', 'user.name', 'Packaging Tester'], repository);
  run('git', ['config', 'user.email', 'packaging@example.invalid'], repository);
  await writeFile(path.join(repository, 'README.md'), '# Fixture\n');
  run('git', ['add', '.'], repository);
  run('git', ['commit', '-m', 'initial'], repository);
  run(process.execPath, [cli, 'init', '--work-id', 'PACK-1', '--base', 'main'], repository);

  // A fast-path verb, from the installed binary, on a real repository `[SPK:AC-009]`.
  const verb = run(process.execPath, [cli, 'specify', '--json'], repository, { allowFailure: true });
  assert.notEqual(verb.status, null, 'the installed CLI did not run at all');
  assert.doesNotMatch(`${verb.stdout}${verb.stderr}`, /Cannot find module|ERR_MODULE_NOT_FOUND/,
    'the installed package is missing a module the fast path needs');

  // Constitution validation, from the installed binary, against the shipped example.
  const example = path.join(installed, 'examples', 'constitution', 'constitution.md');
  const check = run(process.execPath, [cli, 'constitution', 'check', '--path', path.relative(repository, example)], repository, { allowFailure: true });
  const output = `${check.stdout}${check.stderr}`;
  assert.doesNotMatch(output, /Cannot find module|ERR_MODULE_NOT_FOUND/, 'the installed package cannot validate a constitution');
  // The shipped example is still marked as an example, so validating it is expected to refuse — and
  // refusing for that reason is the proof the code ran rather than failed to load.
  assert.match(output, /example: true|No constitution at/, `unexpected constitution output: ${output}`);
});

test('the VS Code extension packs the source it imports', async () => {
  /**
   * The office-laptop defect, pinned. `apps/vscode/src/cli/` is hand-written source that
   * `extension.ts` imports; an unanchored `cli/` ignore rule matched it as well as the staged engine
   * directory, so it survived `git clone` (git ignores ignore-rules for tracked files) and vanished
   * from every artifact built by anything that honoured them.
   */
  const ignore = await readFile(path.join(packageRoot, 'apps/vscode/.gitignore'), 'utf8');
  for (const line of ignore.split('\n').map((entry) => entry.trim())) {
    if (!line || line.startsWith('#') || line.startsWith('/') || line.startsWith('!')) continue;
    assert.ok(
      !line.replace(/\/$/, '').includes('cli'),
      `apps/vscode/.gitignore has an unanchored '${line}' rule, which also matches src/cli/ and strips real source from the package`
    );
  }

  const sources = await readdir(path.join(packageRoot, 'apps/vscode/src/cli'));
  assert.ok(sources.length > 0, 'the extension has no cli/ source directory');

  const packed = run('npm', ['pack', '--dry-run'], path.join(packageRoot, 'apps/vscode'));
  // npm prints the file listing on stderr, which is how the original measurement of this bug read
  // zero before *and* after the fix and nearly concluded the fix had not worked.
  const listed = `${packed.stdout}${packed.stderr}`;
  for (const name of sources.filter((entry) => entry.endsWith('.ts'))) {
    assert.match(listed, new RegExp(`src/cli/${name.replace('.', '\\.')}`), `the extension package omits src/cli/${name}`);
  }
});
