import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'start-desktop.sh');

test('desktop start script is executable, shell-safe, and supports non-mutating inspection', async () => {
  await access(script, constants.X_OK);
  const syntax = spawnSync('bash', ['-n', script], { cwd: root, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);

  const help = spawnSync(script, ['--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--stop-only/);

  const dryRun = spawnSync(script, ['--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: nothing was stopped or started/);
  assert.doesNotMatch(dryRun.stdout, /Starting Singularity Flow from/);
});

test('desktop start script targets product process trees without broad process killers', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /npm run desktop:dev/);
  assert.match(source, /singularity-flow-desktop/);
  assert.match(source, /Singularity Flow\.app/);
  assert.match(source, /does not stop Copilot, Event Horizon/);
  assert.doesNotMatch(source, /\bkillall\b|\bpkill\b/);

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['desktop:start'], './scripts/start-desktop.sh');
});
