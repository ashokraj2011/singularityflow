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
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  for (const name of ['architect', 'developer', 'qa', 'product-owner', 'product-designer', 'mobile-architect']) {
    await writeFile(path.join(root, `.github/agents/${name}.agent.md`), `# ${name}\n`);
  }
  git(root, ['add', '.github/agents']);
  git(root, ['commit', '-m', 'project approved agent configuration']);
  const workflow = {
    workItem: {
      baseBranch: 'main', baseCommit: git(root, ['rev-parse', 'main']).stdout.trim(),
      source: { risk: 'low', repositoryCount: 1 }
    },
    resolution: { capability: { policy: {} } }
  };
  const phase = {
    approvalPolicy: { mode: 'policy', policy: 'quick-fix-low-risk-v1', maximumChangedPaths: 5 },
    qualityCommands: ['git diff --check'],
    checks: [{ id: 'git diff --check', command: 'git diff --check', status: 'passed', sourceCommit: git(root, ['rev-parse', 'HEAD']).stdout.trim() }],
    workIntervalReconciliation: {
      reconciliationSha256: 'a'.repeat(64),
      summary: { unplanned: 0 },
      decision: { status: 'aligned' }
    }
  };
  const eligible = evaluateQuickFixWaiver(root, { governance: {} }, workflow, phase);
  assert.equal(eligible.eligible, true);
  assert.deepEqual(eligible.changedPaths, ['src/message.txt']);
  assert.match(eligible.changedPathsHash, /^[0-9a-f]{64}$/);
  assert.equal(eligible.predicates.checksConfigured, true);
  assert.equal(eligible.predicates.noUndisposedUnplannedPaths, true);

  workflow.workItem.source.risk = 'unknown';
  const unknown = evaluateQuickFixWaiver(root, { governance: {} }, workflow, phase);
  assert.equal(unknown.eligible, false);
  assert.equal(unknown.predicates.declaredLowRisk, false);
});

test('quick-fix waiver requires every configured check at the submitted commit and aligned reconciliation', async () => {
  const root = await fixture();
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const workflow = {
    workItem: { baseBranch: 'main', source: { risk: 'low', repositoryCount: 1 } },
    resolution: { capability: { policy: {} } }
  };
  const base = {
    approvalPolicy: { mode: 'policy', maximumChangedPaths: 5 },
    qualityCommands: ['required-check'],
    workIntervalReconciliation: {
      reconciliationSha256: 'b'.repeat(64), summary: { unplanned: 0 }, decision: { status: 'aligned' }
    }
  };
  const noChecks = evaluateQuickFixWaiver(root, { governance: {} }, workflow, { ...base, checks: [] });
  assert.equal(noChecks.eligible, false);
  assert.equal(noChecks.predicates.checksPassing, false);

  const unrelated = evaluateQuickFixWaiver(root, { governance: {} }, workflow, {
    ...base, checks: [{ id: 'other-check', status: 'passed', sourceCommit }]
  });
  assert.equal(unrelated.eligible, false);

  const stale = evaluateQuickFixWaiver(root, { governance: {} }, workflow, {
    ...base, checks: [{ id: 'required-check', status: 'passed', sourceCommit: '0'.repeat(40) }]
  });
  assert.equal(stale.eligible, false);

  const unplanned = evaluateQuickFixWaiver(root, { governance: {} }, workflow, {
    ...base,
    checks: [{ id: 'required-check', status: 'passed', sourceCommit }],
    workIntervalReconciliation: {
      reconciliationSha256: 'c'.repeat(64), summary: { unplanned: 1 }, decision: { status: 'review' }
    }
  });
  assert.equal(unplanned.eligible, false);
  assert.equal(unplanned.predicates.noUndisposedUnplannedPaths, false);
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
    qualityCommands: ['git diff --check'],
    checks: [{ id: 'git diff --check', command: 'git diff --check', status: 'passed', sourceCommit: git(root, ['rev-parse', 'HEAD']).stdout.trim() }],
    workIntervalReconciliation: {
      reconciliationSha256: 'd'.repeat(64), summary: { unplanned: 0 }, decision: { status: 'aligned' }
    }
  });
  assert.equal(result.eligible, false);
  assert.equal(result.predicates.noProtectedPaths, false);
  assert.equal(result.predicates.noProhibitedClassification, false);
});
