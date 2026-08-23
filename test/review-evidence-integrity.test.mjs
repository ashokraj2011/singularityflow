import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { readStoryReviewPacket } from '../src/story-lineage.mjs';
import { run } from '../src/util.mjs';

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('review reads delivery and test evidence from the immutable submission commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-evidence-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Review Test']);
  git(root, ['config', 'user.email', 'review@example.invalid']);
  const evidenceRoot = 'singularity/work-items/REV-1/context/code-delivery';
  const codePath = `${evidenceRoot}/implementation-gen1.json`;
  const testPath = `${evidenceRoot}/tests/implementation-gen1-unit.json`;
  const codeReceipt = { schemaVersion: currentSchemaVersion('code-delivery'), kind: 'code-delivery', status: 'ready' };
  const testReceipt = { schemaVersion: currentSchemaVersion('test-execution'), kind: 'test-execution', status: 'passed' };
  const digest = (record) => createHash('sha256').update(canonicalJson(record)).digest('hex');
  const base = {
    schemaVersion: currentSchemaVersion('story-submission-packet'),
    workId: 'REV-1', phase: 'implementation', generation: 1,
    submissionEvidence: {
      codeDelivery: { path: codePath, sha256: digest(codeReceipt), status: 'ready' },
      testExecutions: [{ commandId: 'unit', path: testPath, sha256: digest(testReceipt), status: 'passed' }]
    }
  };
  const packetSha256 = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  const packetPath = `singularity/work-items/REV-1/submissions/implementation/${packetSha256}.json`;
  for (const [relative, record] of [[codePath, codeReceipt], [testPath, testReceipt], [packetPath, { ...base, packetSha256 }]]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), `${JSON.stringify(record, null, 2)}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'submission evidence']);
  const evidenceCommit = git(root, ['rev-parse', 'HEAD']);
  await writeFile(path.join(root, codePath), `${JSON.stringify({ ...codeReceipt, status: 'failed' }, null, 2)}\n`);
  await writeFile(path.join(root, testPath), `${JSON.stringify({ ...testReceipt, status: 'failed' }, null, 2)}\n`);
  await writeFile(path.join(root, packetPath), `${JSON.stringify({
    ...base,
    submissionEvidence: {
      ...base.submissionEvidence,
      codeDelivery: { ...base.submissionEvidence.codeDelivery, sha256: digest({ ...codeReceipt, status: 'failed' }) }
    },
    packetSha256
  }, null, 2)}\n`);
  const workflow = { workItem: { id: 'REV-1' }, lineage: { submissions: [{ packetSha256, path: packetPath }] } };
  const packet = await readStoryReviewPacket(root, {}, workflow, packetSha256);
  assert.equal(packet.evidenceCommit, evidenceCommit);
  assert.equal(packet.submissionEvidence.testExecutions[0].status, 'passed');
});
