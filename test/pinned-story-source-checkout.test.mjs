import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pinnedStorySource, pinnedStorySourceSnapshot } from '../src/story-epic-sources.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const source = { type: 'manual', description: 'Preserve exact Story intent', labels: ['checkout'] };
const text = `${JSON.stringify(source, null, 2)}\n`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pinned-source-checkout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relative = 'singularity/work-items/CHECKOUT-1/source.json';
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return { root, relative, file, config: {}, workflow: {
    workItem: { id: 'CHECKOUT-1' }, resolution: { sourceSha256: digest(text) }
  } };
}

test('a native Git text checkout preserves the immutable Story source binding', async t => {
  const item = await fixture(t);
  const git = args => execFileSync('git', args, { cwd: item.root, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'core.autocrlf', 'true']);
  git(['add', '--', item.relative]);
  git(['-c', 'user.name=Checkout Test', '-c', 'user.email=checkout@example.test', 'commit', '-qm', 'pinned source']);
  await rm(item.file);
  git(['checkout-index', '--force', '--', item.relative]);
  const current = await readFile(item.file, 'utf8');
  assert.notEqual(digest(current), item.workflow.resolution.sourceSha256);
  assert.equal(current, text.replaceAll('\n', '\r\n'));
  assert.deepEqual(await pinnedStorySource(item.root, item.config, item.workflow), source);
  const snapshot = await pinnedStorySourceSnapshot(item.root, item.config, item.workflow);
  assert.deepEqual(snapshot.record, { path: item.relative, sha256: digest(text), bytes: Buffer.byteLength(text) });
  assert.deepEqual(snapshot.checkout, { sha256: digest(current), bytes: Buffer.byteLength(current) });
  assert.equal(snapshot.bytes.toString('utf8'), text);
  assert.equal(item.workflow.resolution.sourceSha256, digest(text), 'immutable raw hash must not be rewritten');
});

test('a missing Story source remains unavailable rather than synthesizing replacement intent', async t => {
  const item = await fixture(t);
  await rm(item.file);
  assert.equal(await pinnedStorySourceSnapshot(item.root, item.config, item.workflow), null);
});

test('checkout compatibility never accepts a source content, whitespace, BOM or mixed-ending edit', async t => {
  const item = await fixture(t);
  for (const value of [text.replace('exact', 'changed'), text.replace('  "type"', ' "type"'),
    `\uFEFF${text}`, text.replace('\n', '\r\n'), text.replaceAll('\n', '\r'), text.trimEnd()]) {
    await writeFile(item.file, value);
    await assert.rejects(() => pinnedStorySource(item.root, item.config, item.workflow), {
      code: 'WORK_SOURCE_HASH_MISMATCH'
    });
  }
});

test('the lifecycle integrity gate accepts only the unchanged checkout form of its pinned Story source', async t => {
  const { initializeDefinition, resolveWorkType } = await import('../src/config.mjs');
  const { createWorkflow, loadConfig } = await import('../src/state.mjs');
  const { runGovernanceGate } = await import('../src/governance.mjs');
  const { default: YAML } = await import('yaml');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-pinned-source-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Checkout Test']);
  git(['config', 'user.email', 'checkout@example.test']);
  await initializeDefinition(root);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionFile, YAML.stringify(definition));
  git(['add', '.']); git(['commit', '-qm', 'fixture configuration']);
  const id = 'CHECKOUT-GATE-1';
  git(['switch', '-qc', id]);
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, {
    id, title: 'Exact Story binding', source, baseBranch: 'main', workType: 'spec-driven-standard',
    agent: 'product-owner', resolved: resolveWorkType(config, 'spec-driven-standard')
  });
  assert.ok(workflow.resolution.configSha256, 'exercise the legacy configuration integrity gate');
  git(['add', '.']); git(['commit', '-qm', 'accepted fixture Story']);
  const relative = `singularity/work-items/${id}/source.json`;
  const file = path.join(root, relative);
  const original = await readFile(file, 'utf8');
  git(['config', 'core.autocrlf', 'true']);
  await rm(file); git(['checkout-index', '--force', '--', relative]);
  assert.equal(await readFile(file, 'utf8'), original.replaceAll('\n', '\r\n'));
  const valid = await runGovernanceGate(root, config, workflow);
  assert.equal(valid.findings.some(item => item.code === 'gate.source.snapshot-drift'), false);
  await writeFile(file, original.replace('exact Story intent', 'modified Story intent'));
  const changed = await runGovernanceGate(root, config, workflow);
  assert.ok(changed.findings.some(item => item.code === 'gate.source.snapshot-drift'));
});
