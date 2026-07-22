import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
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
  assert.doesNotMatch(run(process.execPath, [bin, 'wm', 'context', 'design', '--concat', '--no-persona'], root), /Act as a developer/);
  assert.doesNotMatch(await readFile(path.join(root, '.singularity/personas/developer.md'), 'utf8'), /architect persona/i);
});

test('wm inject renders matched persona context and records the generation audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-inject-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Injection Tester'], root);
  run('git', ['config', 'user.email', 'inject@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# Injection test\n');
  run('git', ['add', '.singularity', 'README.md'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();
  run('git', ['switch', '-c', 'WM-1'], root);

  const definitionPath = path.join(root, '.singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.injection.rules = [{ when: { persona: 'developer', phase: 'design', workType: 'feature' }, include: ['views/development.md'] }];
  await writeFile(definitionPath, YAML.stringify(definition));
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ persona: 'developer', workId: 'WM-1' }));
  await mkdir(path.join(root, '.singularity/world-model/views'), { recursive: true });
  await writeFile(path.join(root, '.singularity/world-model/views/development.md'), 'INJECTED DEVELOPMENT VIEW\n');
  await writeFile(path.join(root, '.singularity/world-model/manifest.json'), JSON.stringify({ repository_commit: commit, views: { development: { path: 'views/development.md' } }, domains: [] }));
  const workDir = path.join(root, '.singularity/work-items/WM-1');
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WM-1', workType: 'feature' }, currentPhase: 'design',
    phases: { design: { id: 'design', generation: 0 } }
  }));
  await writeFile(path.join(workDir, 'source.json'), JSON.stringify({ type: 'manual', labels: [] }));

  const preview = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design', '--dry-run'], root);
  assert.match(preview, /rules matched: 1/);
  assert.match(preview, /views\/development\.md/);
  const prompt = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design'], root);
  assert.match(prompt, /Act as a developer/);
  assert.match(prompt, /INJECTED DEVELOPMENT VIEW/);
  const audit = JSON.parse(await readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'));
  assert.equal(audit.persona, 'developer');
  assert.equal(audit.modelCommit, commit);
  assert.equal(audit.files[0].path, '.singularity/world-model/views/development.md');
  assert.match(audit.files[0].sha256, /^[0-9a-f]{64}$/);
});
