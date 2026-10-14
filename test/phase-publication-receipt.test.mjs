import test from 'node:test';
import assert from 'node:assert/strict';
import { phasePublicationSummary, phasePublicationProgressLabel } from '../apps/vscode/src/phase-publication.ts';

const expected = { workId: 'STORY-1', phaseId: 'intake' };
const receipt = { schemaVersion: 1, resultType: 'sflow-phase-publication', status: 'published',
  workId: 'STORY-1', phase: 'intake', generation: 1, commit: 'a'.repeat(40), pushed: true,
  effects: { committed: true, pushed: true } };

test('only an exact completed receipt acknowledges publication, without rendering documents', () => {
  assert.match(phasePublicationSummary(receipt, expected), /Published intake generation 1.*aaaaaaaa and pushed/);
  for (const changed of [null, {}, { ...receipt, workId: 'OTHER' }, { ...receipt, phase: 'code' },
    { ...receipt, commit: 'short' }, { ...receipt, generation: 0 }, { ...receipt, pushed: false },
    { ...receipt, effects: { committed: false, pushed: true } }]) {
    assert.throws(() => phasePublicationSummary(changed, expected), /Inspect Story status before retrying/);
  }
});

test('an authenticated idempotent receipt does not claim a new commit or a fresh push', () => {
  const retained = { ...receipt, status: 'retained', pushed: false,
    remoteSynchronization: 'not-checked', effects: { committed: false, pushed: false } };
  assert.match(phasePublicationSummary(retained, expected), /already published.*no new commit.*not rechecked/);
  assert.throws(() => phasePublicationSummary({ ...retained, pushed: true }, expected));
});

test('publication progress is a closed vocabulary', () => {
  assert.equal(phasePublicationProgressLabel('publication.push'), 'Publishing the exact commit');
  assert.equal(phasePublicationProgressLabel('user-provided-message'), null);
  assert.equal(phasePublicationProgressLabel('toString'), null);
});
