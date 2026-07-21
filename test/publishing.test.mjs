import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { fail = false, actor = 'Publisher' } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor, SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env }); if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); return result;
}
function flow(root, args, options) { return run(process.execPath, [bin, ...args], root, options); }

test('failed required push blocks transitions until sync publishes the retained commit', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-push-')); const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base); run('git', ['init', '-b', 'main', root], base); run('git', ['config', 'user.name', 'Publisher'], root); run('git', ['config', 'user.email', 'publisher@example.com'], root); run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# publish\n'); flow(root, ['init']); run('git', ['add', '.'], root); run('git', ['commit', '-m', 'init'], root); run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'PUSH-1']); const artifact = path.join(root, '.sdlc/work-items/PUSH-1/artifacts/intake/intake.md'); await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete publication recovery evidence for the required remote branch.'));
  run('git', ['remote', 'set-url', 'origin', path.join(base, 'missing.git')], root); const failed = flow(root, ['phase', 'publish', 'intake'], { fail: true }); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /push failed/);
  assert.match(await readFile(path.join(root, '.sdlc/work-items/PUSH-1/publication-pending.json'), 'utf8'), /PUSH-1/);
  const blocked = flow(root, ['submit'], { fail: true }); assert.match(blocked.stderr, /Publication is pending/);
  run('git', ['remote', 'set-url', 'origin', remote], root); flow(root, ['sync']); const local = run('git', ['rev-parse', 'HEAD'], root).stdout.trim(); const published = run('git', ['ls-remote', 'origin', 'refs/heads/PUSH-1'], root).stdout.split(/\s+/)[0]; assert.equal(published, local);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '');
});
