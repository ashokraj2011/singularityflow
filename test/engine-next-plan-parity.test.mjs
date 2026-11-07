import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvedSpecificationStory, CLI } from './helpers/submitted-planning-story.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { createSflow } from '../src/api.mjs';
import { nextStepsSnapshot } from '../src/nextsteps.mjs';
import { run } from '../src/util.mjs';

const previous = { ...process.env }; let machine;
before(async () => { machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-next-plan-machine-')); process.env = isolatedTestEnvironment(machine); });
after(async () => { process.env = previous; await rm(machine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const capture = fileURLToPath(new URL('./helpers/capture-engine-operation.mjs', import.meta.url));

test('the real CLI projects its captured registered next-step plan and preserves accepted Story bytes', async t => {
  const f = await approvedSpecificationStory(t, 'ENGINE-NEXT-PLAN');
  const workflow = path.join(f.item, 'workflow.json'), before = await readFile(workflow), head = f.git('rev-parse', 'HEAD');
  const native = await createSflow({ root: f.root }).run('story.next', { workId: 'ENGINE-NEXT-PLAN' });
  assert.equal(native.operation, 'story.next'); assert.equal(native.manifest.phaseId, 'planning');
  assert.equal(native.effects.committed, false);
  const captured = path.join(path.dirname(f.root), 'next.capture.json'), contextFile = path.join(path.dirname(f.root), 'next.context.json');
  const child = run(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--import', capture,
    CLI, '--no-model', 'nextsteps', 'ENGINE-NEXT-PLAN', '--json'], { cwd: f.root, allowFailure: true,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_TEST_ENGINE_CAPTURE: captured,
      SINGULARITY_FLOW_TEST_NEXT_CONTEXT: contextFile } });
  assert.equal(child.status, 0, child.stderr + '\n' + child.stdout);
  const actual = JSON.parse(child.stdout), receipt = JSON.parse(await readFile(captured, 'utf8'));
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  assert.equal(receipt.operation, 'story.next'); assert.equal(receipt.result.subject.id, 'ENGINE-NEXT-PLAN');
  const projected = nextStepsSnapshot({ ...context.options, nextPlan: receipt.result.manifest.actions, nextPresentation: context.planningPresentation });
  for (const field of ['state', 'workId', 'branch', 'currentPhase', 'modelMode', 'actions']) assert.deepEqual(actual[field], projected[field], field);
  assert.deepEqual(await readFile(workflow), before); assert.equal(f.git('rev-parse', 'HEAD'), head);
  const outdir = await mkdtemp(fileURLToPath(new URL('../.bundle-test-engine-next-plan-', import.meta.url)));
  t.after(() => rm(outdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const { buildCliBundle } = await import('../scripts/build-cli-bundle.mjs'); await buildCliBundle({ outdir });
  const bundled = run(process.execPath, [CLI, '--no-model', 'nextsteps', 'ENGINE-NEXT-PLAN', '--json'], { cwd: f.root, allowFailure: true,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'auto', SINGULARITY_FLOW_BUNDLE_DIR: outdir } });
  assert.equal(bundled.status, 0, bundled.stderr);
  const bundleResult = JSON.parse(bundled.stdout);
  assert.deepEqual(bundleResult.actions, actual.actions); assert.equal(bundleResult.currentPhase, actual.currentPhase);
  assert.deepEqual(await readFile(workflow), before); assert.equal(f.git('rev-parse', 'HEAD'), head);
});
