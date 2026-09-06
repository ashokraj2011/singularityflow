import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { gatewayRegistry, unimplementedPlanners } from '../src/gateway/operations.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { intentTracePlanner } from '../src/gateway/planners/intent-trace.mjs';
import { SFLOW_TOOLS, SFLOW_TOOL_NAMES } from '../src/gateway/tools.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-comprehension-gateway-'));
  t.after(() => spawnSync('rm', ['-rf', root]));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'CMP Gateway Tester']);
  git(root, ['config', 'user.email', 'cmp-gateway@example.test']);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'pay.js'), 'export const pay = 1;\n');
  await writeFile(path.join(root, 'src', 'other.js'), 'export const other = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'baseline']);
  await writeFile(path.join(root, 'src', 'pay.js'), 'export const pay = 2;\n');
  return root;
}

test('the existing intent.trace gateway operation returns bounded CMP facts without adding a tool', async (t) => {
  const root = await repository(t);
  const before = git(root, ['status', '--porcelain=v1']);
  const result = await intentTracePlanner({
    root,
    arguments: { repositoryId: 'checkout', path: 'src/pay.js', lineStart: 1, lineEnd: 1 },
    context: { repositoryId: 'checkout' },
    subject: { kind: 'repository', id: 'checkout' }
  });
  assert.equal(result.operation.id, 'intent.trace');
  assert.equal(result.kind, 'read');
  assert.equal(result.outcome.status, 'succeeded');
  assert.equal(result.data.regions.length, 1);
  assert.equal(result.data.regions[0].pathAfter, 'src/pay.js');
  assert.equal(result.data.cause.status, 'unavailable');
  assert.equal(result.data.requestedLines.assurance, 'unavailable-at-resource-granularity');
  assert.equal(result.data.bounds.modelInvoked, false);
  assert.equal(result.data.bounds.astRequired, false);
  assert.equal(result.data.bounds.authoritative, false);
  assert.equal(result.data.bounds.lifecycleGate, false);
  assert.equal(result.warnings[0].code, 'intent.trace.cause-unavailable');
  assert.doesNotMatch(JSON.stringify(result), /export const pay/);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);

  assert.equal(SFLOW_TOOLS.length, 5);
  assert.deepEqual(SFLOW_TOOL_NAMES, [
    'sflow_resolve', 'sflow_read', 'sflow_next', 'sflow_run', 'sflow_explain'
  ]);
  assert.equal(typeof gatewayPlanners().get('intent-trace'), 'function');
  assert.ok(!unimplementedPlanners(gatewayPlanners()).includes('intent-trace'));
  assert.equal(
    gatewayRegistry().operations.find((operation) => operation.id === 'intent.trace').modelPolicy,
    'never'
  );
});

test('intent.trace reports absence and wrong-repository selection without inventing a cause', async (t) => {
  const root = await repository(t);
  const absent = await intentTracePlanner({
    root,
    arguments: { repositoryId: 'checkout', path: 'src/other.js' },
    context: { repositoryId: 'checkout' }
  });
  assert.equal(absent.data.regions.length, 0);
  assert.equal(absent.warnings[0].code, 'intent.trace.path-not-changed');
  assert.equal(absent.data.cause.status, 'unavailable');

  const wrong = await intentTracePlanner({
    root,
    arguments: { repositoryId: 'other', path: 'src/pay.js' },
    context: { repositoryId: 'checkout' }
  });
  assert.equal(wrong.kind, 'refusal');
  assert.equal(wrong.why[0].code, 'intent.trace.wrong-repository');
  await assert.rejects(
    () => intentTracePlanner({
      root,
      arguments: { repositoryId: 'checkout', path: 'src/pay.js', lineStart: 9, lineEnd: 2 },
      context: { repositoryId: 'checkout' }
    }),
    (error) => error.code === 'INVALID_OPERATION_ARGUMENT'
  );
});
