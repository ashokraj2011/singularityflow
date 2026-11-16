/**
 * `configuration cleanup-history` and VS Code's "Clean configuration history" are removed [owner, 2026-11-16]: an
 * upgrade deletes the old history refs itself. The command is refused by name, saying what replaced it, so a script
 * learns it instead of failing on an unknown subcommand; no surface offers it any more.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HELP } from '../src/help-text.mjs';
import { run } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFile(path.join(root, relative), 'utf8');

test('configuration cleanup-history is refused by name and names the upgrade that replaced it', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-cleanup-history-removed-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main', repository]);
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), '--no-model',
    'configuration', 'cleanup-history', '--json'], {
    cwd: repository, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  assert.notEqual(result.status, 0, result.stdout);
  const said = `${result.stdout}\n${result.stderr}`;
  assert.match(said, /CONFIGURATION_CLEANUP_HISTORY_REMOVED|configuration cleanup-history was removed/u, said);
  assert.match(said, /workspace refresh-configuration/u);
});

test('no surface offers configuration history cleanup any more', async () => {
  const manifest = JSON.parse(await read('apps/vscode/package.json'));
  assert.equal(manifest.contributes.commands.some((command) => /cleanupConfigurationHistory/u.test(command.command)), false);
  assert.doesNotMatch(JSON.stringify(manifest.contributes.menus ?? {}), /cleanupConfigurationHistory/u);
  assert.doesNotMatch(await read('apps/vscode/src/views/configuration-center-page.ts'), /cleanup-history|Clean configuration history/u);
  assert.doesNotMatch(await read('apps/vscode/src/extension.ts'), /cleanupConfigurationHistory|ConfigurationCleanupAction/u);
  assert.doesNotMatch(HELP, /configuration cleanup-history/u);
  assert.doesNotMatch(await read('plugin/skills/sflow-configuration/SKILL.md'), /cleanup-history/u);
  assert.doesNotMatch(await read('docs/OPERATION-MODEL-POLICY.md'), /cleanup-history/u);
});
