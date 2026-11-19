import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { ownTerminalStep, primarySkillForCommand } from '../src/command-skills.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The CLI in a home, machine state and updater folder of its own, with only Node's own folder on PATH:
 * no `singularity-flow`, `npm`, `code` or `copilot` of this machine can be found, so nothing installed
 * here can be reached. Every run is --help or --check-only.
 */
async function sandbox(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-update-command-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = isolatedTestEnvironment(path.join(base, 'machine'), process.env);
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  for (const name of Object.keys(env)) if (/^npm_config_/iu.test(name)) delete env[name];
  Object.assign(env, {
    PATH: path.dirname(process.execPath),
    SINGULARITY_FLOW_PACKAGE_UPDATER_HOME: path.join(base, 'updater'),
    SINGULARITY_FLOW_BUNDLE: 'off'
  });
  const cwd = path.join(base, 'not-a-repository');
  await mkdir(cwd);
  const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), ...args],
    { cwd, env, encoding: 'utf8', timeout: 60_000, input: '' });
  return { base, cli };
}

test('update --help prints its page without reading a repository', async (t) => {
  const { cli } = await sandbox(t);
  const result = cli('update', '--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /singularity-flow update — Update SFlow from the SharePoint link/);
  assert.match(result.stdout, /singularity-flow update \[--source LINK \| --local-folder FOLDER\] \[--check-only\]/);
  assert.match(result.stdout, /--local-folder FOLDER/);
});

test('update --check-only on a folder with no packages fails in plain words and changes nothing', async (t) => {
  const { base, cli } = await sandbox(t);
  const empty = path.join(base, 'downloads');
  await mkdir(empty);
  const result = cli('update', '--check-only', '--local-folder', empty);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /No \.tgz file was found in /);
  assert.match(result.stderr + result.stdout, /singularity-flow update --source 'LINK'/, 'a source problem names the next step');
  assert.deepEqual(await readdir(empty), [], 'the chosen folder is only read');
  // Nothing was saved: a source that gave no matching pair is never remembered.
  assert.deepEqual((await readdir(path.join(base, 'updater'))).filter((name) => name === 'source.json'), []);
});

test('update is a machine-level mutation that only the person runs', () => {
  assert.equal(resolveOperation({ requestedCommand: 'update', positionals: ['update'], options: {} }).classification, 'mutation');
  assert.equal(ownTerminalStep('singularity-flow update --check-only'), 'product-update');
  assert.equal(primarySkillForCommand('update'), 'sf-about', 'Copilot can show the installed builds, never run the update');
});
