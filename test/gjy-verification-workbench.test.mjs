import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { evaluateReadinessEvidence } from '../src/gateway/readiness-evidence.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';

test('the verification workbench evaluates every deterministic authority instead of omitting it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-readiness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Readiness Driver'], { cwd: root });
  run('git', ['config', 'user.email', 'readiness@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Verification workbench fixture\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'initialize'], { cwd: root });
  run('git', ['switch', '-q', '-c', 'GJY-READY-1'], { cwd: root });
  const config = await loadConfig(root);
  config.git.publish = 'off';
  const resolved = resolveWorkType(config, 'quick-fix');
  const agent = resolved.phases[0].defaultAgent;
  await setAgentSession(root, config, {
    name: 'Readiness Driver', email: 'readiness@example.invalid', login: null
  }, agent, 'GJY-READY-1', { phaseId: resolved.phases[0].id, source: 'test' });
  await createWorkflow(root, config, {
    id: 'GJY-READY-1', title: 'Evaluate all verification authorities',
    source: { type: 'manual', title: 'Evaluate all verification authorities' },
    baseBranch: 'main', baseCommit: run('git', ['rev-parse', 'main'], { cwd: root }).stdout.trim(),
    workType: 'quick-fix', agent, resolved
  });

  const rows = await evaluateReadinessEvidence(root, { kind: 'story', id: 'GJY-READY-1' });
  assert.deepEqual(rows.map((row) => row.id), [
    'published-artifacts', 'tests', 'stale-approvals', 'clarifications',
    'unclaimed-changes', 'reconciliation', 'ast', 'visual', 'external-build'
  ]);
  assert.equal(rows.find((row) => row.id === 'published-artifacts').state, 'unmet');
  for (const id of ['stale-approvals', 'reconciliation', 'visual', 'external-build']) {
    assert.equal(rows.find((row) => row.id === id).state, 'met', id);
  }
  assert.ok(rows.every((row) => ['met', 'unmet', 'unknown'].includes(row.state)));
});
