import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { composeContextBrief } from '../src/context-broker.mjs';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { gatewayOperation } from '../src/gateway/operations.mjs';
import { contextBrief } from '../src/gateway/planners/context-brief.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Context Driver'], { cwd: root });
  run('git', ['config', 'user.email', 'context@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Context fixture\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'initialize'], { cwd: root });
  run('git', ['switch', '-c', 'GJY-CONTEXT-1'], { cwd: root });
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'quick-fix');
  const agent = resolved.phases[0].defaultAgent ?? 'developer';
  await setAgentSession(root, config, {
    name: 'Context Driver', email: 'context@example.invalid', login: null
  }, agent, 'GJY-CONTEXT-1', { phaseId: resolved.phases[0].id, source: 'test' });
  await createWorkflow(root, config, {
    id: 'GJY-CONTEXT-1',
    title: 'Bound the Copilot context',
    source: {
      type: 'manual', key: 'GJY-CONTEXT-1', title: 'Bound the Copilot context',
      description: 'Return a small phase brief and expandable slices.', acceptanceCriteria: []
    },
    baseBranch: 'main', workType: 'quick-fix', agent, resolved
  });
  return root;
}

test('the context broker returns a bounded record projection without persisting source content', async (t) => {
  const root = await fixture(t);
  const result = await composeContextBrief(root, {
    workId: 'GJY-CONTEXT-1', slice: 'brief', maxOutputBytes: 4096
  });
  assert.equal(result.kind, 'context-brief');
  assert.equal(result.work.id, 'GJY-CONTEXT-1');
  assert.equal(result.guidanceOnly, true);
  assert.equal(result.accounting.maximumOutputBytes, 4096);
  assert.ok(result.accounting.includedContentBytes <= 4096);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096, 'the complete response honors the model-facing budget');
  assert.deepEqual(result.expansion, ['world-model', 'ast', 'evidence']);
  assert.ok(!JSON.stringify(result).includes(root), 'machine paths do not enter model-facing context');
});

test('each deeper slice is exposed as typed navigation for the kernel to seal', async (t) => {
  const root = await fixture(t);
  const operation = gatewayOperation('context.brief');
  const result = await contextBrief({
    root,
    operation,
    arguments: { workId: 'GJY-CONTEXT-1', slice: 'brief', maxOutputBytes: 4096 }
  });
  assert.deepEqual(result.next.map((entry) => entry.id), [
    'context:GJY-CONTEXT-1:world-model',
    'context:GJY-CONTEXT-1:ast',
    'context:GJY-CONTEXT-1:evidence'
  ]);
  assert.ok(result.next.every((entry) => entry.executable === false));
  assert.equal(result.effects.gitRefsChanged, false);
});
