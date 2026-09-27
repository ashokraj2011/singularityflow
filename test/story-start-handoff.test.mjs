import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  storyStartHandoffFromResult, storyStartHandoffMatches,
  STORY_START_HANDOFF_MAX_AGE_MS, STORY_START_HANDOFF_KEY
} from '../apps/vscode/src/story-start-handoff.ts';

const repository = path.resolve('fixture/story-checkout');
const now = Date.parse('2026-09-27T12:00:00Z');
const result = {
  shape: 'story', id: 'new-story', repositoryPath: repository,
  publication: { pushed: true, branch: 'new-story', commit: 'a'.repeat(40) },
  configuration: { commit: 'b'.repeat(40) }
};
function confirmed() {
  return {
    repository: { root: repository }, selectedWorkId: 'new-story',
    revision: { branch: 'new-story', head: 'a'.repeat(40) },
    workflow: {
      workItem: { id: 'new-story', branch: 'new-story' },
      resolution: { configurationSource: { commit: 'b'.repeat(40) } }
    }
  };
}

test('a published start produces bounded scheduling metadata, not a governed snapshot', () => {
  const hint = storyStartHandoffFromResult(result, now);
  assert.ok(hint);
  assert.equal(storyStartHandoffMatches(hint, repository, confirmed(), now + 10), true);
  assert.doesNotMatch(JSON.stringify(hint), /ready|approved|token|remote|snapshot|content/);
  assert.equal(STORY_START_HANDOFF_KEY, 'singularityFlow.storyStartHandoff.v1');
});

test('no hint for unpushed, legacy, incomplete, or non-Story results', () => {
  for (const invalid of [
    { ...result, shape: 'epic' }, { ...result, repositoryPath: 'relative' },
    { ...result, configuration: null }, { ...result, id: '' }, { ...result, id: 1 },
    { ...result, publication: { ...result.publication, branch: 1 } },
    { ...result, publication: { ...result.publication, pushed: false } },
    { ...result, publication: { ...result.publication, commit: 'not-an-oid' } }
  ]) assert.equal(storyStartHandoffFromResult(invalid, now), null);
  assert.equal(storyStartHandoffFromResult(result, 8.64e15 + 1), null);
  assert.equal(storyStartHandoffFromResult({ ...result, repositoryPath: path.resolve('x'.repeat(8193)) }, now), null);
});

test('age, checkout, HEAD, branch, selected Story, and exact configuration pin all fence the hint', () => {
  const hint = storyStartHandoffFromResult(result, now);
  assert.equal(storyStartHandoffMatches(hint, repository, confirmed(), now - 1), false);
  assert.equal(storyStartHandoffMatches(hint, repository, confirmed(), now + STORY_START_HANDOFF_MAX_AGE_MS + 1), false);
  assert.equal(storyStartHandoffMatches(hint, `${repository}-other`, confirmed(), now), false);
  for (const change of [
    (s) => { s.repository.root += '-other'; },
    (s) => { s.revision.head = 'c'.repeat(40); },
    (s) => { s.revision.branch = 'other-story'; },
    (s) => { s.workflow.workItem.id = 'other-story'; },
    (s) => { s.workflow.workItem.branch = 'other-story'; },
    (s) => { s.selectedWorkId = 'other-story'; },
    (s) => { s.workflow.resolution.configurationSource.commit = 'c'.repeat(40); },
    (s) => { delete s.workflow.resolution; }
  ]) {
    const snapshot = confirmed(); change(snapshot);
    assert.equal(storyStartHandoffMatches(hint, repository, snapshot, now), false);
  }
});

test('malformed persisted metadata fails closed to ordinary activation', () => {
  const hint = storyStartHandoffFromResult(result, now);
  for (const invalid of [null, [], {}, { ...hint, schemaVersion: 9 },
    { ...hint, createdAt: 'invalid' }, { ...hint, publicationCommit: 'a'.repeat(41) },
    { ...hint, repositoryPath: 'relative' }, { ...hint, branch: 1 }]) {
    assert.equal(storyStartHandoffMatches(invalid, repository, confirmed(), now), false);
  }
});

test('SHA-256 publication and authority object identities remain exact', () => {
  const sha256 = { ...result,
    publication: { ...result.publication, commit: 'a'.repeat(64) },
    configuration: { commit: 'b'.repeat(64) } };
  const hint = storyStartHandoffFromResult(sha256, now);
  const snapshot = confirmed(); snapshot.revision.head = 'a'.repeat(64);
  snapshot.workflow.resolution.configurationSource.commit = 'b'.repeat(64);
  assert.equal(storyStartHandoffMatches(hint, repository, snapshot, now), true);
});
