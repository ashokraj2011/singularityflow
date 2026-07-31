import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/util.mjs';
import { resolveWorkItem } from '../src/state.mjs';

test('work-item resolution decouples the Work ID from canonical and child branch names', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-work-resolver-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Resolver Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'resolver@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# resolver\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-m', 'root'], { cwd: root });
  const directory = path.join(root, 'singularity/work-items/PAY-1234');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: {
      id: 'PAY-1234',
      title: 'Decoupled branch',
      workType: 'feature',
      branch: 'PAY-1234-invoice-export'
    },
    lineage: {
      canonicalBranch: 'PAY-1234-invoice-export',
      childBranches: [{ name: 'feature/export-ui' }]
    },
    resolution: {},
    phaseOrder: [],
    phases: {}
  }, null, 2)}\n`);
  const config = {
    workItemRoot: 'singularity/work-items',
    ledger: { enabled: false }
  };
  assert.equal((await resolveWorkItem(root, config, 'PAY-1234')).branch, 'PAY-1234-invoice-export');
  assert.equal((await resolveWorkItem(root, config, 'PAY-1234-invoice-export')).workId, 'PAY-1234');
  assert.equal((await resolveWorkItem(root, config, 'feature/export-ui')).workId, 'PAY-1234');
});
