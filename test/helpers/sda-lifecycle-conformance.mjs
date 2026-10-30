/**
 * The lifecycle authority conformance suite (SDA M4): one set of checks every lifecycle authority
 * adapter must pass, registered once per adapter.
 *
 * `createFixture()` returns `{ authority, subject, target, transition({ expectedRemoteSha, content,
 * cancelAt }), moveAuthority(), loseNextResponse(), cleanup() }`. `target` is the `{ branch, remote }`
 * the subject's authority is observed at; `transition` builds one lifecycle change for this adapter,
 * and with `cancelAt: { stage, controller }` it aborts `controller` when the change reaches `stage`
 * ('before-commit', 'before-publishing' or 'during-push'); `moveAuthority` makes another writer advance the
 * subject's branch; `loseNextResponse` lets the next transition reach the authority and loses its
 * response.
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

  // Cancellation propagates into a running transition up to its push, and no further (SDA §7.3).
  run('a transition cancelled before its commit is rolled back: nothing is kept and the next one lands',
    async ({ authority, target, transition }) => {
      const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
      const controller = new AbortController();
      await assert.rejects(authority.publish(transition({
        expectedRemoteSha: created.sha, content: 'cancelled', cancelAt: { stage: 'before-commit', controller }
      }), { signal: controller.signal }), refusedAs('cancelled'));
      assert.equal(controller.signal.aborted, true, 'the transition had started when it was cancelled');
      assert.equal((await authority.observe(target)).revision, created.sha);
      assert.equal(await authority.pending(transitionSubject(transition)), null);
      const next = await authority.publish(transition({ expectedRemoteSha: created.sha, content: 'after' }));
      assert.equal((await authority.observe(target)).revision, next.sha);
    });

  run('a transition cancelled after its commit and before its push is retained locally for recovery',
    async ({ authority, target, transition }) => {
      const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
      const controller = new AbortController();
      let cancelled;
      await assert.rejects(authority.publish(transition({
        expectedRemoteSha: created.sha, content: 'cancelled', cancelAt: { stage: 'before-publishing', controller }
      }), { signal: controller.signal }), (error) => { cancelled = error; return refusedAs('retained-locally')(error); });
      assert.match(cancelled.publicationCommit ?? '', /^[0-9a-f]{40}$/u);
      assert.equal((await authority.observe(target)).revision, created.sha, 'the push never started');
      const retained = await authority.pending(transitionSubject(transition));
      assert.deepEqual([retained?.commit, retained?.pushOutcome], [cancelled.publicationCommit, 'not-attempted']);
      await assert.rejects(authority.publish(transition({ expectedRemoteSha: created.sha, content: 'after' })),
        refusedAs('pending-recovery'));
      assert.equal((await authority.observe(target)).revision, created.sha);
    });

  run('a push in flight runs to its end: a cancellation during it never abandons the transition',
    async ({ authority, target, transition }) => {
      const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
      const controller = new AbortController();
      const advanced = await authority.publish(transition({
        expectedRemoteSha: created.sha, content: 'pushing', cancelAt: { stage: 'during-push', controller }
      }), { signal: controller.signal });
      assert.equal(controller.signal.aborted, true, 'it was cancelled while its push was in flight');
      assert.equal(advanced.pushed, true);
      assert.equal((await authority.observe(target)).revision, advanced.sha);
      assert.equal(await authority.pending(transitionSubject(transition)), null);
    });
}

function transitionSubject(transition) {
  return transition({ expectedRemoteSha: null, content: 'subject' }).subject;
}
