import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateQuickFixWaiver } from '../src/quick-fix-policy.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  return run('git', args, { cwd: root });
}

async function fixture(file = 'src/message.txt') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-dx-policy-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'DX Tester']);
  git(root, ['config', 'user.email', 'dx@example.com']);
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'baseline']);
  git(root, ['switch', '-c', 'DX-1']);
  const absolute = path.join(root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, 'changed\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'change']);
  return root;
}

test('two-phase-completion policy waives only bounded low-risk changes', async () => {
  const root = await fixture();
  const workflow = {
    workItem: { baseBranch: 'main', source: { risk: 'low', repositoryCount: 1 } },
    resolution: { capability: { policy: {} } }
  };
  const phase = {
    approvalPolicy: { mode: 'policy', policy: 'quick-fix-low-risk-v1', maximumChangedPaths: 5 },
    checks: []
  };
  const eligible = evaluateQuickFixWaiver(root, { governance: {} }, workflow, phase);
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.changedPaths, ['src/message.txt']);
  assert.match(eligible.changedPathsHash, /^[0-9a-f]{64}$/);

  workflow.workItem.source.risk = 'unknown';
  const unknown = evaluateQuickFixWaiver(root, { governance: {} }, workflow, phase);
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.predicates.declaredLowRisk, false);
});

test('quick-fix policy preserves human review for protected and semantic changes', async () => {
  const root = await fixture('security/policy.yml');
  const workflow = {
    workItem: {
      baseBranch: 'main',
      source: { risk: 'low', repositoryCount: 1, securityBoundaryChange: true }
    },
    resolution: { capability: { policy: { protectedPaths: ['security'] } } }
  };
  const result = evaluateQuickFixWaiver(root, { governance: {} }, workflow, {
    approvalPolicy: { mode: 'policy', maximumChangedPaths: 5 },
    checks: []
  });
  assert.equal(result.eligible, false);
  assert.equal(result.predicates.noProtectedPaths, false);
  assert.equal(result.predicates.noProhibitedClassification, false);
});
