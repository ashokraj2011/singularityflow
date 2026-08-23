import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  beginCodeGeneration,
  consumeGenerationIntent,
  generationStartPublicationBinding,
  verifyOpenGenerationIntent
} from '../src/generation-boundary.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-voc-generation-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'VOC Test']);
  git(root, ['config', 'user.email', 'voc@example.invalid']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'export const answer = 42;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  const baseline = git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const phase = {
    id: 'implementation',
    generation: 0,
    generationPolicy: { task: 'code' },
    sourceBoundary: 'unrestricted'
  };
  const workflow = {
    workItem: { id: 'VOC-START' },
    workIntervals: { current: { phaseId: phase.id, status: 'open', sourceBaseCommit: baseline } },
    resolution: { codeDelivery: { generationBoundary: { dirtyStart: 'block' } } }
  };
  return { root, baseline, tree, phase, workflow };
}

test('generation begin creates an idempotent local receipt without a lifecycle event', async () => {
  const context = await fixture();
  const config = { workItemRoot: 'singularity/work-items' };
  const first = await beginCodeGeneration(context.root, config, context.workflow, context.phase, { persist: true });
  const second = await beginCodeGeneration(context.root, config, context.workflow, context.phase, { persist: true });
  assert.equal(second.id, first.id);
  assert.equal(await verifyOpenGenerationIntent(context.root, context.workflow, context.phase), first);

  const receipt = JSON.parse(await readFile(path.join(context.root, first.path), 'utf8'));
  assert.equal(receipt.kind, 'generation-start');
  assert.equal(receipt.status, 'open');
  assert.equal(receipt.baseline.commit, context.baseline);
  assert.equal(receipt.baseline.tree, context.tree);
  assert.equal(Object.hasOwn(receipt, 'lifecycleEvent'), false);
});

test('publication binds the exact immutable generation-start receipt and consumption does not rewrite it', async () => {
  const context = await fixture();
  const config = { workItemRoot: 'singularity/work-items' };
  const intent = await beginCodeGeneration(context.root, config, context.workflow, context.phase, { persist: true });
  const absolute = path.join(context.root, intent.path);
  const before = await readFile(absolute);
  const binding = await generationStartPublicationBinding(context.root, context.workflow, context.phase);
  assert.deepEqual(binding, {
    generationIntentId: intent.id,
    generationStartPath: intent.path,
    generationStartSha256: intent.receiptSha256,
    baselineCommit: context.baseline,
    baselineTree: context.tree,
    initialChangeSetDigest: intent.baseline.initialChangeSetDigest,
    previousGenerationCommit: null
  });

  await consumeGenerationIntent(context.root, context.phase, {
    generation: 1,
    publishedAt: new Date(0).toISOString(),
    changeSetDigest: 'sha256:change',
    resultDigest: 'sha256:result'
  });
  assert.equal(context.phase.generationIntent.status, 'consumed');
  assert.equal(context.phase.generationIntent.publication.generationStartSha256, intent.receiptSha256);
  assert.deepEqual(await readFile(absolute), before, 'the generation-start receipt was rewritten after publication');
});

