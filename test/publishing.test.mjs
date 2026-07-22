import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { fail = false, actor = 'Publisher' } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor, SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env }); if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); return result;
}
function flow(root, args, options) { return run(process.execPath, [bin, ...args], root, options); }

test('failed required push blocks transitions until sync publishes the retained commit', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-push-')); const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base); run('git', ['init', '-b', 'main', root], base); run('git', ['config', 'user.name', 'Publisher'], root); run('git', ['config', 'user.email', 'publisher@example.com'], root); run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# publish\n'); flow(root, ['init']); const configPath = path.join(root, '.singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.worldModel.grounding = 'off'; await writeFile(configPath, YAML.stringify(config)); run('git', ['add', '.'], root); run('git', ['commit', '-m', 'init'], root); run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'PUSH-1']); const artifact = path.join(root, '.singularity/work-items/PUSH-1/artifacts/intake/intake.md'); await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete publication recovery evidence for the required remote branch.'));
  run('git', ['remote', 'set-url', 'origin', path.join(base, 'missing.git')], root); const failed = flow(root, ['phase', 'publish', 'intake'], { fail: true }); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /push failed/);
  assert.match(await readFile(path.join(root, '.singularity/work-items/PUSH-1/publication-pending.json'), 'utf8'), /PUSH-1/);
  const blocked = flow(root, ['submit'], { fail: true }); assert.equal(blocked.status, 2); assert.match(blocked.stderr, /Out of sequence/); assert.match(blocked.stderr, /Publication is pending/); assert.match(blocked.stderr, /singularity-flow sync/);
  run('git', ['remote', 'set-url', 'origin', remote], root); flow(root, ['sync']); const local = run('git', ['rev-parse', 'HEAD'], root).stdout.trim(); const published = run('git', ['ls-remote', 'origin', 'refs/heads/PUSH-1'], root).stdout.split(/\s+/)[0]; assert.equal(published, local);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '');
});

test('every approval creates and pushes its own atomic decision commit', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-approval-push-'));
  const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Publisher'], root);
  run('git', ['config', 'user.email', 'publisher@example.com'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# approval publication\n');
  flow(root, ['init']);
  const configPath = path.join(root, '.singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8')); config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root); run('git', ['commit', '-m', 'init'], root); run('git', ['push', '-u', 'origin', 'main'], root);

  flow(root, ['start', 'APPROVAL-1']);
  const artifact = path.join(root, '.singularity/work-items/APPROVAL-1/artifacts/intake/intake.md');
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete independently reviewable approval publication evidence and scope.'));
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit']);
  const approval = flow(root, ['next', '--yes'], { actor: 'Independent Reviewer' });
  assert.match(approval.stdout, /Next step: review and decide submitted phase 'intake'/);
  assert.match(approval.stdout, /Approval decision committed [0-9a-f]{8} and pushed to origin\/APPROVAL-1/);

  const local = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const published = run('git', ['ls-remote', 'origin', 'refs/heads/APPROVAL-1'], root).stdout.split(/\s+/)[0];
  assert.equal(published, local);
  const subject = run('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'refs/heads/APPROVAL-1'], base).stdout.trim();
  assert.equal(subject, '[APPROVAL-1][phase:intake][approve] product-owner');
});
