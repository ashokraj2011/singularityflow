import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeDefinition } from '../src/config.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('world-model context combines required phase views, persona views, and persona prompt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'World Model Tester'], root);
  run('git', ['config', 'user.email', 'world@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# World model test\n');
  run('git', ['add', '.singularity', 'README.md'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();

  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ persona: 'developer', workId: 'WM-1' }));
  await mkdir(path.join(root, '.singularity/world-model/core'), { recursive: true });
  await mkdir(path.join(root, '.singularity/world-model/views'), { recursive: true });
  await writeFile(path.join(root, '.singularity/world-model/core/summary.md'), 'SHARED CORE\n');
  for (const view of ['architecture', 'security', 'development', 'testing']) {
    await writeFile(path.join(root, `.singularity/world-model/views/${view}.md`), `${view.toUpperCase()} VIEW\n`);
  }
  await writeFile(path.join(root, '.singularity/world-model/manifest.json'), JSON.stringify({
    repository_commit: commit,
    views: Object.fromEntries(['architecture', 'security', 'development', 'testing'].map((view) => [view, { path: `views/${view}.md` }])),
    domains: [], evidence: { path: 'evidence.md' }
  }));
  await writeFile(path.join(root, '.singularity/world-model/evidence.md'), 'EVIDENCE LEDGER\n');

  const output = run(process.execPath, [bin, 'wm', 'context', 'design', '--concat'], root);
  assert.match(output, /ARCHITECTURE VIEW/);
  assert.match(output, /SECURITY VIEW/);
  assert.match(output, /DEVELOPMENT VIEW/);
  assert.match(output, /TESTING VIEW/);
  assert.match(output, /Act as a developer/);
  assert.match(run(process.execPath, [bin, 'wm', 'context', 'verification', '--concat'], root), /EVIDENCE LEDGER/);
  assert.doesNotMatch(await readFile(path.join(root, '.singularity/personas/developer.md'), 'utf8'), /architect persona/i);
});
