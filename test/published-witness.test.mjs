import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { witnessContextBinding } from '../src/verification/witness-records.mjs';

const FILE = 'singularity/work-items/QF-1/evidence/value-screen.png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG7sAAAAASUVORK5CYII=', 'base64');

test('a native witness records a published screenshot before submission and never repeats the decision', async t => {
  const repo = await repository(t, { implementCommands: false });
  await startQuickFix(repo, { retainedScreenshot: FILE });
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:REQ-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  await mkdir(path.dirname(path.join(repo.root, FILE)), { recursive: true });
  await writeFile(path.join(repo.root, FILE), PNG);
  repo.sflow('prepare', 'implement');
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published));
  const workflowFile = path.join(repo.root, 'singularity/work-items/QF-1/workflow.json');
  const before = JSON.parse(await readFile(workflowFile));
  assert.equal(before.phases.implement.generationCommit, null, 'the submission marker is not filled by publication');
  assert.equal(before.phases.implement.status, 'in_progress');
  const args = ['decision', 'witness', '--work-id', 'QF-1', '--criterion', 'QF-1:AC-001', '--slot', 'screen', '--file', FILE,
    '--reason', 'The fixture reviewer inspected the exact retained image for this generation.',
    '--expected-context-sha256', witnessContextBinding(before), '--expected-file-sha256', `sha256:${createHash('sha256').update(PNG).digest('hex')}`,
    '--confirm', 'states-the-outcome', '--confirm', 'matches-the-criterion', '--confirm', 'current-for-this-change'];
  const decision = repo.sflowJson(...args);
  assert.equal(decision.status, 0, JSON.stringify(decision));
  const after = JSON.parse(await readFile(workflowFile));
  assert.equal(after.witnessRecords.length, 1);
  assert.equal(after.witnessRecords[0].outcome, 'met');
  assert.equal(after.witnessRecords[0].file, FILE);
  assert.equal(after.phases.implement.status, 'in_progress', 'a witness is neither submission nor approval');
  assert.equal(after.phases.implement.generation, 1);
  assert.equal(after.phases.implement.generationCommit, null, 'the read binding must not rewrite the lifecycle marker');
  assert.deepEqual(await readFile(path.join(repo.root, FILE)), PNG);
  const head = repo.must('git', ['rev-parse', 'HEAD']);
  const repeated = repo.sflowJson(...args);
  assert.notEqual(repeated.status, 0);
  assert.equal(repo.must('git', ['rev-parse', 'HEAD']), head);
  assert.equal(JSON.parse(await readFile(workflowFile)).witnessRecords.length, 1);
});
