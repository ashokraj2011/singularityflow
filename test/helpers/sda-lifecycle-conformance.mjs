/**
 * The lifecycle authority conformance suite (SDA M4): one set of checks every lifecycle authority
 * adapter must pass, registered once per adapter.
 *
 * `createFixture()` returns `{ authority, subject, target, transition({ expectedRemoteSha, content }),
 * moveAuthority(), loseNextResponse(), cleanup() }`. `target` is the `{ branch, remote }` the
 * subject's authority is observed at; `transition` builds one lifecycle change for this adapter;
 * `moveAuthority` makes another writer advance the subject's branch; `loseNextResponse` lets the next
 * transition reach the authority and loses its response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleAuthorityOutcome } from '../../src/sda/lifecycle-authority-contract.mjs';

const refusedAs = (outcome) => (error) => {
  assert.equal(lifecycleAuthorityOutcome(error), outcome, `${error.code ?? 'no code'}: ${error.message}`);
  return true;
};

export function lifecycleAuthorityConformance(label, createFixture, { skip = false } = {}) {
  const run = (name, body) => test(`${label}: ${name}`, { skip }, async (t) => {
    const fixture = await createFixture();
    t.after(() => fixture.cleanup());
    await body(fixture);
  });

  run('an observation reads the exact revision: absent before the first transition, the transition\'s after it',
    async ({ authority, target, transition }) => {
      const before = await authority.observe(target);
      assert.deepEqual([before.state, before.revision], ['absent', null]);
      const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
      const after = await authority.observe(target);
      assert.deepEqual([after.state, after.revision], ['present', created.sha]);
      const next = await authority.publish(transition({ expectedRemoteSha: after.revision, content: 'advanced' }));
      assert.equal((await authority.observe(target)).revision, next.sha);
      assert.equal(await authority.pending(transitionSubject(transition)), null);
    });

  run('a transition bound to a revision the authority no longer holds never lands', async ({ authority, target, transition, moveAuthority }) => {
    const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
    const moved = await moveAuthority();
    assert.notEqual(moved, created.sha);
    await assert.rejects(authority.publish(transition({ expectedRemoteSha: created.sha, content: 'stale' })), refusedAs('REVISION_CONFLICT'));
    assert.equal((await authority.observe(target)).revision, moved, 'the other writer\'s revision stands');
  });

  run('a transition whose response is lost is unknown, retained, and holds the next one until recovery',
    async ({ authority, target, transition, loseNextResponse }) => {
      const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
      await loseNextResponse();
      let lost;
      await assert.rejects(authority.publish(transition({ expectedRemoteSha: created.sha, content: 'lost' })),
        (error) => { lost = error; return refusedAs('OUTCOME_UNKNOWN')(error); });
      const observed = await authority.observe(target);
      assert.equal(observed.revision, lost.publicationCommit, 'the authority accepted it');
      const retained = await authority.pending(transitionSubject(transition));
      assert.deepEqual([retained?.commit, retained?.pushOutcome], [lost.publicationCommit, 'transport-indeterminate']);
      await assert.rejects(authority.publish(transition({ expectedRemoteSha: observed.revision, content: 'after' })),
        refusedAs('pending-recovery'));
      assert.equal((await authority.observe(target)).revision, observed.revision);
    });

  run('a transition naming no expected revision is refused before any change (SDA-AC-025)', async ({ authority, target, transition }) => {
    const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
    await assert.rejects(authority.publish(transition({ expectedRemoteSha: undefined, content: 'unbound' })),
      (error) => error.code === 'PUSH_EXPECTED_REVISION_REQUIRED');
    assert.equal((await authority.observe(target)).revision, created.sha);
    assert.equal(await authority.pending(transitionSubject(transition)), null);
  });

  run('a cancelled operation changes nothing and says it was cancelled', async ({ authority, target, transition }) => {
    const cancelled = new AbortController();
    cancelled.abort();
    const { signal } = cancelled;
    await assert.rejects(authority.observe(target, { signal }), refusedAs('cancelled'));
    await assert.rejects(authority.publish(transition({ expectedRemoteSha: null, content: 'cancelled' }), { signal }), refusedAs('cancelled'));
    await assert.rejects(authority.pending(transitionSubject(transition), { signal }), refusedAs('cancelled'));
    assert.equal((await authority.observe(target)).state, 'absent');
  });
}

function transitionSubject(transition) {
  return transition({ expectedRemoteSha: null, content: 'subject' }).subject;
}
