import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Usability Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }) }, ...extra });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function flow(root, ...args) { return run(process.execPath, [bin, ...args], root); }

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-usability-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Usability Tester'], root); run('git', ['config', 'user.email', 'usability@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Usability\n'); flow(root, 'init');
  const definitionPath = path.join(root, 'singularity/workflow.yml'); const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off'; definition.worldModel.grounding = 'off'; await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', '.'], root); run('git', ['commit', '-m', 'initialize'], root); return root;
}

test('cockpit, doctor, workflow simulation, and review provide read-only orientation', async () => {
  const root = await repository(); flow(root, 'start', 'EASY-1', '--title', 'Reduce workflow friction');
  const cockpit = flow(root).stdout;
  assert.match(cockpit, /Singularity Flow cockpit — EASY-1/); assert.match(cockpit, /Current: Intake/); assert.match(cockpit, /Next actions:/);
  const doctor = JSON.parse(flow(root, 'doctor', '--offline', '--json').stdout);
  assert.equal(doctor.healthy, true); assert.ok(doctor.checks.some((item) => item.id === 'configuration' && item.status === 'pass'));
  const catalog = JSON.parse(flow(root, 'workflow', 'list', '--json').stdout); assert.ok(catalog.some((item) => item.id === 'figma-mobile'));
  const simulation = JSON.parse(flow(root, 'workflow', 'simulate', 'feature', '--json').stdout); assert.equal(simulation[0].phases[0].id, 'intake'); assert.equal(simulation[0].phases.at(-1).id, 'conformance');
  const review = flow(root, 'review', 'intake').stdout; assert.match(review, /# Review bundle — EASY-1 \/ Intake/); assert.match(review, /### Artifact content/); assert.match(review, /Supporting evidence/);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
});

test('assignments are durable and guided run stops at the authoring boundary', async () => {
  const root = await repository(); flow(root, 'start', 'EASY-2', '--title', 'Coordinate authors');
  const assigned = flow(root, 'assign', 'intake', 'mobile-team').stdout; assert.match(assigned, /Assigned intake to mobile-team/);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/EASY-2/workflow.json'), 'utf8'));
  assert.equal(workflow.collaboration.assignments.intake.assignee, 'mobile-team');
  assert.match(run('git', ['log', '-1', '--format=%s'], root).stdout, /\[EASY-2\]\[phase:intake\]\[assign\]/);
  const guided = flow(root, 'run', '--task', 'Capture user outcome').stdout; assert.match(guided, /stopped at the authoring boundary/i); assert.doesNotMatch(guided, /approved/i);
  const watch = flow(root, 'watch', '--once').stdout; assert.match(watch, /Assignment: mobile-team/);
});

test('safe recovery remains plan-first and Copilot hook emits read-only phase context', async () => {
  const root = await repository(); flow(root, 'start', 'EASY-3', '--title', 'Recover safely');
  const recovery = flow(root, 'recover').stdout; assert.match(recovery, /Recovery plan — EASY-3/); assert.match(recovery, /No recoverable publication/);
  const hook = run(process.execPath, [bin, 'hook', 'session-start'], root, { input: '{"cwd":"ignored"}\n' });
  const payload = JSON.parse(hook.stdout); assert.match(payload.additionalContext, /EASY-3/); assert.match(payload.additionalContext, /Never approve automatically/);
});
