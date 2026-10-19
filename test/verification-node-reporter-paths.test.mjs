import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import reporter from '../src/verification/node-test-reporter.mjs';
import { nodeTestObservation } from '../src/verification/node-test-observation.mjs';

test('Node test identities canonicalize directory aliases but refuse outside or missing files', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-node-reporter-paths-'));
  t.after(() => rm(base, { force: true, recursive: true }));
  const root = path.join(base, 'actual');
  const alias = path.join(base, 'alias');
  await mkdir(root);
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(root, 'case.test.mjs'), '// fixture\n');
  await writeFile(path.join(base, 'outside.test.mjs'), '// outside\n');
  const prior = { root: process.env.SINGULARITY_FLOW_NODE_TEST_ROOT, tap: process.env.SINGULARITY_FLOW_NODE_TEST_TAP };
  process.env.SINGULARITY_FLOW_NODE_TEST_ROOT = root;
  process.env.SINGULARITY_FLOW_NODE_TEST_TAP = '0';
  t.after(() => {
    for (const [key, value] of [['SINGULARITY_FLOW_NODE_TEST_ROOT', prior.root], ['SINGULARITY_FLOW_NODE_TEST_TAP', prior.tap]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const counts = { discovered: 1, passed: 1, failed: 0, skipped: 0 };
  async function observation(file) {
    async function* events() {
      yield { type: 'test:start', data: { file, nesting: 0, name: 'one' } };
      yield { type: 'test:pass', data: { file, line: 1, nesting: 0, name: 'one', details: { type: 'test' } } };
    }
    let text = '';
    for await (const chunk of reporter(events())) text += chunk;
    return text;
  }
  const observed = nodeTestObservation(await observation(path.join(alias, 'case.test.mjs')), counts);
  assert.equal(observed.occurrences[0].file, 'case.test.mjs');
  for (const file of [path.join(base, 'outside.test.mjs'), path.join(alias, 'missing.test.mjs')]) {
    const text = await observation(file);
    assert.throws(() => nodeTestObservation(text, counts), { name: 'SyntaxError', message: 'Node test identities are incomplete.' });
  }
});
