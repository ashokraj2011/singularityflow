import test from 'node:test';
import assert from 'node:assert/strict';
import { LedgerSink, StoryStateStore, InitiativeStateStore } from '../src/state-stores.mjs';

test('state planes expose separate narrow stores and a disabled no-op ledger sink', async () => {
  const story = new StoryStateStore('/tmp/story', { workItemRoot: 'singularity/work-items' });
  const initiative = new InitiativeStateStore('/tmp/initiative', { initiativeRoot: 'singularity/initiatives' });
  assert.equal(typeof story.load, 'function');
  assert.equal(typeof story.resolve, 'function');
  assert.equal(typeof story.saveDraft, 'function');
  assert.equal(typeof story.transact, 'function');
  assert.equal(story.save, undefined);
  assert.equal(typeof initiative.load, 'function');
  assert.equal(typeof initiative.saveDraft, 'function');
  assert.equal(typeof initiative.transact, 'function');
  assert.equal(initiative.save, undefined);
  assert.equal(typeof initiative.publish, 'function');
  const sink = new LedgerSink('/tmp/ledger', { enabled: false });
  assert.deepEqual(await sink.append({}, '0'.repeat(40)), { enabled: false, skipped: true });
  assert.deepEqual(await sink.verify(), { enabled: false, valid: true, skipped: true });
});
