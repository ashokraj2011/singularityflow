import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActiveClauseCapsule } from '../src/active-clause-capsule.mjs';
import { stakeholderPromptContext } from '../src/stakeholder-prompt-context.mjs';

const request = { id: 'CR-1', status: 'open', sourcePhase: 'verification', sourceGeneration: 2,
  targetPhase: 'coding', requestedBy: { name: 'Ana', email: 'ana@example.invalid', login: 'ana' },
  requestedAt: '2026-10-09T00:00:00Z', clauseIds: ['ST-1:AC-001'],
  comment: 'Preserve café and 未知.\nSecond line, "quoted". ' + 'Exact business instruction. '.repeat(100) };
function fixture(requests = [request]) {
  return buildActiveClauseCapsule({ indexes: [] }, {
    workItem: { id: 'ST-1' }, phaseOrder: ['coding'], changeRequests: requests
  }, { id: 'coding' }).capsule;
}
const capsuleJson = text => JSON.parse(text.match(/```json\n([\s\S]*?)\n```/u)[1]);
const requestsJson = text => text.match(/```json\n([\s\S]*?)\n```/u)[1].split('\n').map(JSON.parse);

test('bound requests retain exact comments/provenance once without mutating the verified capsule', () => {
  const capsule = fixture(); const before = JSON.stringify(capsule);
  const projected = stakeholderPromptContext(capsule, [request]);
  const reference = capsuleJson(projected.capsuleText).clarifications[0];
  const body = requestsJson(projected.text)[0];
  assert.equal(reference.detail, undefined);
  assert.equal(reference.bodyIn, 'stakeholder-change-requests');
  assert.equal(reference.requestSha256, body.requestSha256);
  for (const [key, value] of Object.entries(request)) assert.deepEqual(body[key], value);
  assert.equal(JSON.stringify(capsule), before);
  assert.ok(projected.projection.capsuleBytesSaved > 2000);
});

test('equal comments on two identities remain two requests', () => {
  const requests = [request, { ...request, id: 'CR-2', sourceGeneration: 3 }];
  const projected = stakeholderPromptContext(fixture(requests), requests);
  const bodies = requestsJson(projected.text);
  assert.deepEqual(bodies.map(body => body.id), ['CR-1', 'CR-2']);
  assert.notEqual(bodies[0].requestSha256, bodies[1].requestSha256);
  assert.deepEqual(projected.projection.referencedRequestIds, ['CR-1', 'CR-2']);
});

test('missing, ambiguous, stale or corrupt links never suppress the capsule body', () => {
  for (const requests of [[], [{ ...request, comment: 'changed' }], [{ ...request, clauseIds: [] }],
    [{ ...request, targetPhase: 'other' }], [request, request]]) {
    const projected = stakeholderPromptContext(fixture(), requests);
    assert.equal(capsuleJson(projected.capsuleText).clarifications[0].detail, request.comment);
    assert.deepEqual(projected.projection.referencedRequestIds, []);
  }
  const corrupted = { ...fixture(), capsuleSha256: 'sha256:' + '0'.repeat(64) };
  assert.equal(capsuleJson(stakeholderPromptContext(corrupted, [request]).capsuleText).clarifications[0].detail, request.comment);
});

test('comment, requester and source-generation changes update request identity', () => {
  const original = requestsJson(stakeholderPromptContext(fixture(), [request]).text)[0].requestSha256;
  for (const changed of [{ ...request, comment: request.comment + '!' },
    { ...request, requestedBy: { name: 'Someone else' } }, { ...request, sourceGeneration: 8 }]) {
    assert.notEqual(requestsJson(stakeholderPromptContext(fixture([changed]), [changed]).text)[0].requestSha256, original);
  }
});
