import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyCodeDeliveryReceipt } from '../src/delivery-evidence.mjs';
import { bindingsDigest } from '../src/implementation-bindings.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-replay-reads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Receipt Replay Tester');
  git(root, 'config', 'user.email', 'replay@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'test'));
  const sourceRequired = [];
  const sourceBindings = [];
  const explanations = [];
  const witnesses = [];
  const files = [];
  for (let fileIndex = 0; fileIndex < 4; fileIndex += 1) {
    const sourcePath = `src/part-${fileIndex}.js`;
    const testSource = `test/part-${fileIndex}.test.js`;
    const source = [];
    const tests = [];
    for (let clause = 1; clause <= 3; clause += 1) {
      const clauseId = `REPLAY:AC-${String(fileIndex * 3 + clause).padStart(3, '0')}`;
      const explanation = `returns the approved conversion result for case ${clause}`;
      source.push(`// @clause:${clauseId} ${explanation}`);
      const line = source.length;
      sourceRequired.push({ clauseId, expectedPaths: [sourcePath] });
      sourceBindings.push({ clauseId, sourcePath, line, tag: 'clause' });
      explanations.push({ clauseId, regions: [], explanation: { text: explanation, path: sourcePath, line } });
      tests.push(`// @ac:${clauseId}`, `test('case ${clause}', () => { expect(${clause}).toBe(${clause}); });`);
    }
    source.push('export const convert = value => value.toString(16);', '');
    await writeFile(path.join(root, sourcePath), source.join('\n'));
    await writeFile(path.join(root, testSource), tests.join('\n'));
    files.push(sourcePath, testSource);
    for (const entry of scanJavaScriptDeclarations(tests.join('\n'), { sourcePath: testSource, framework: 'vitest' }).declarations) {
      witnesses.push({ ...entry, testSource, clauseId: entry.clauseIds[0], profile: 'vitest-static-v2', identity: { framework: 'vitest' } });
    }
  }
  await symlink('src/part-0.js', path.join(root, 'link'));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'recorded source and test bindings');
  const receipt = {
    schemaVersion: 2, kind: 'code-delivery', status: 'ready', phase: 'implementation', generation: 1,
    tree: { generationCommit: git(root, 'rev-parse', 'HEAD'), generationTree: git(root, 'rev-parse', 'HEAD^{tree}') },
    changeSet: { sourcePaths: sourceRequired.map(item => item.expectedPaths[0]), deletedSourcePaths: [] },
    traceability: { sourceRequired, sourceBindings, witnesses },
    implementationBindings: { bindings: explanations, bindingsSha256: bindingsDigest(explanations) },
    model: { assurance: 'unavailable' }, testExecutions: []
  };
  return { root, receipt, files };
}

const verify = (root, receipt) => verifyCodeDeliveryReceipt(root, receipt,
  { sourceBindingPolicy: 'enforce', requireAffectedModuleCoverage: false });
const missingExecutionErrors = ['committed repository change set is absent', 'no passing test-execution receipt is bound'];

test('batched repeated-clause replay checks exact committed bindings, never grants a missing test verdict', async t => {
  const { root, receipt, files } = await fixture(t);
  assert.deepEqual((await verify(root, receipt)).errors, missingExecutionErrors);
  // A warm parser or prefetched commit is not a verdict: changing a receipt still gets checked.
  receipt.traceability.witnesses[0].declarationSha256 = '0'.repeat(64);
  assert.match((await verify(root, receipt)).errors.join('\n'), /acceptance witness.*does not match/u);
  // Current disk bytes cannot change the retained publication's evidence.
  for (const file of files) await writeFile(path.join(root, file), 'export const unrelated = true;\n');
  receipt.traceability.witnesses[0].declarationSha256 = scanJavaScriptDeclarations(
    "// @ac:REPLAY:AC-001\ntest('case 1', () => { expect(1).toBe(1); });",
    { sourcePath: 'test/part-0.test.js', framework: 'vitest' }).declarations[0].declarationSha256;
  assert.deepEqual((await verify(root, receipt)).errors, missingExecutionErrors);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'different publication bytes');
  receipt.tree.generationCommit = git(root, 'rev-parse', 'HEAD');
  receipt.tree.generationTree = git(root, 'rev-parse', 'HEAD^{tree}');
  const changed = await verify(root, receipt);
  assert.equal(changed.errors.filter(message => /does not replay from the generation commit/u.test(message)).length, 12);
  assert.equal(changed.errors.filter(message => /acceptance witness.*does not match/u.test(message)).length, 12);
  assert.equal(changed.errors.filter(message => /explanation.*not on its tag line/u.test(message)).length, 12);
});

test('prefetched symlink content cannot satisfy a retained regular-file evidence obligation', async t => {
  const { root, receipt } = await fixture(t);
  const item = { path: 'link', state: 'present', sha256: sha256('src/part-0.js') };
  receipt.fulfillment = { obligations: [
    { clauseId: 'REPLAY:REQ-001', fulfillment: 'existing', paths: [item] },
    { clauseId: 'REPLAY:REQ-002', fulfillment: 'evidence', paths: [item] }
  ] };
  const result = await verify(root, receipt);
  assert.deepEqual(result.errors, [
    missingExecutionErrors[0],
    'evidence evidence of REPLAY:REQ-002 is not at link in the generation',
    missingExecutionErrors[1]
  ]);
});

test('malformed binding collections keep their validation errors instead of failing in prefetch', async t => {
  const { root, receipt } = await fixture(t);
  receipt.implementationBindings.bindings = {};
  receipt.traceability.sourceBindings = {};
  const result = await verify(root, receipt);
  assert.ok(result.errors.includes('implementation bindings do not match their digest'));
  assert.ok(result.errors.includes('planned source-clause bindings are absent from the code-delivery receipt'));
});

test('prefetch cannot enlarge the explanation reader byte limit to the source-binding limit', async t => {
  const { root, receipt } = await fixture(t);
  const source = [1, 2, 3].map(clause =>
    `// @clause:REPLAY:AC-00${clause} returns the approved conversion result for case ${clause}`).join('\n');
  await writeFile(path.join(root, 'src/part-0.js'), source + '\n' + ' '.repeat(1024 * 1024));
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'larger exact source file');
  receipt.tree.generationCommit = git(root, 'rev-parse', 'HEAD');
  receipt.tree.generationTree = git(root, 'rev-parse', 'HEAD^{tree}');
  const result = await verify(root, receipt);
  assert.equal(result.errors.filter(message => /explanation.*not on its tag line/u.test(message)).length, 3);
  assert.equal(result.errors.filter(message => /source-clause.*does not replay/u.test(message)).length, 0,
    'the larger source-binding reader retains its own limit');
});
