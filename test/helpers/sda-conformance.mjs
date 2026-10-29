/**
 * The shared-state conformance suite (SDA §7, SDA-AC-017): one set of checks every event-log
 * adapter must pass, registered once per adapter.
 *
 * `createFixture()` returns `{ adapter, sourceRevision, concurrentAppend(event), forgeDigest(id),
 * otherNamespace(), cleanup() }`. `concurrentAppend` makes another writer's event land between the
 * adapter's next observation and its write; `forgeDigest` rewrites one stored entry's payload
 * digest as a forger could; `otherNamespace` is the same kind of adapter on another namespace.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedStateOutcome } from '../../src/sda/shared-state-contract.mjs';

const refusedAs = (outcome) => (error) => {
  assert.equal(sharedStateOutcome(error), outcome, `${error.code}: ${error.message}`);
  return true;
};

export function sharedStateConformance(label, createFixture, { skip = false } = {}) {
  const run = (name, body) => test(`${label}: ${name}`, { skip }, async (t) => {
    const fixture = await createFixture();
    t.after(() => fixture.cleanup());
    const event = (workId, payload = { work: workId }) => ({
      eventType: 'phase-approved', subject: { workId, phase: 'design', generation: 1 },
      sourceRevision: fixture.sourceRevision, actor: { email: 'conformance@example.test' }, payload
    });
    await body(fixture, event);
  });
  const all = async (adapter) => {
    const entries = [];
    let continuation = null;
    do {
      const page = await adapter.page({ limit: 2, continuation });
      entries.push(...page.entries);
      continuation = page.continuation;
    } while (continuation);
    return entries;
  };

  run('a write never lands on a revision that moved: it lands once, after the concurrent write', async ({ adapter, concurrentAppend }, event) => {
    await concurrentAppend(event('SDA-B'));
    assert.equal((await adapter.append(event('SDA-A'))).status, 'accepted');
    assert.deepEqual((await all(adapter)).map((entry) => entry.subject.workId), ['SDA-A', 'SDA-B']);
    const verified = await adapter.verify();
    assert.deepEqual(verified.errors, []);
    assert.equal(verified.valid, true);
  });

  run('a repeated operation returns its first outcome, and its key with other bytes is refused', async ({ adapter }, event) => {
    const first = await adapter.append(event('SDA-I', { bundle: 1 }));
    const again = await adapter.append(event('SDA-I', { bundle: 1 }));
    assert.deepEqual([again.status, again.id, again.sequence], ['duplicate', first.id, first.sequence]);
    await assert.rejects(adapter.append(event('SDA-I', { bundle: 2 })), refusedAs('OPERATION_ID_REUSE'));
    assert.equal((await all(adapter)).length, 1);
  });

  run('a listing reads one snapshot to its end, whatever lands meanwhile', async ({ adapter, otherNamespace }, event) => {
    for (const id of ['SDA-P1', 'SDA-P2', 'SDA-P3', 'SDA-P4', 'SDA-P5']) await adapter.append(event(id));
    const first = await adapter.page({ limit: 2 });
    await adapter.append(event('SDA-P6'));
    const second = await adapter.page({ limit: 2, continuation: first.continuation });
    const third = await adapter.page({ limit: 2, continuation: second.continuation });
    assert.equal(second.snapshot, first.snapshot);
    assert.deepEqual([...first.entries, ...second.entries, ...third.entries].map((entry) => entry.subject.workId),
      ['SDA-P5', 'SDA-P4', 'SDA-P3', 'SDA-P2', 'SDA-P1']);
    assert.deepEqual([third.complete, third.continuation], [true, null]);
    assert.equal((await adapter.page({ limit: 1 })).entries[0].subject.workId, 'SDA-P6');
    await assert.rejects(adapter.page({ limit: 2, continuation: 'not-a-continuation' }), refusedAs('continuation-invalid'));
    await assert.rejects((await otherNamespace()).page({ limit: 2, continuation: first.continuation }), refusedAs('continuation-invalid'));
  });

  run('a forged digest is corrupt data, never an empty or valid answer', async ({ adapter, forgeDigest }, event) => {
    const written = await adapter.append(event('SDA-F'));
    await forgeDigest(written.id);
    const verified = await adapter.verify();
    assert.equal(verified.valid, false);
    assert.match(verified.errors.join('\n'), /payload digest/u);
    await assert.rejects(adapter.page({ limit: 10 }), refusedAs('corrupt'));
  });

  run('pages are bounded by the limit the adapter declares', async ({ adapter }, event) => {
    const { maxPage } = adapter.descriptor.limits;
    assert.ok(Number.isInteger(maxPage) && maxPage > 0);
    for (const limit of [0, maxPage + 1, 1.5]) await assert.rejects(adapter.page({ limit }), refusedAs('limit-invalid'));
    for (const id of ['SDA-L1', 'SDA-L2', 'SDA-L3']) await adapter.append(event(id));
    const page = await adapter.page({ limit: 2 });
    assert.equal(page.entries.length, 2);
    assert.equal(page.complete, false);
  });

  run('a cancelled operation changes nothing and says it was cancelled', async ({ adapter }, event) => {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(adapter.append(event('SDA-C'), { signal: cancelled.signal }), refusedAs('cancelled'));
    await assert.rejects(adapter.page({ limit: 1 }, { signal: cancelled.signal }), refusedAs('cancelled'));
    assert.equal((await adapter.page({ limit: 10 })).entries.length, 0);
  });
}
