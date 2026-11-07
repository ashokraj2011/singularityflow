import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createGitCompatibilityAdapter } from '../src/sda/git-compatibility-adapter.mjs';
import { lifecycleAuthorityConformance } from './helpers/sda-lifecycle-conformance.mjs';
import { sharedStateConformance } from './helpers/sda-conformance.mjs';
import { gitLifecycleFixture } from './helpers/sda-git-lifecycle-fixture.mjs';
import { gitLedgerFixture } from './helpers/sda-git-ledger-fixture.mjs';
import { syncPendingLifecyclePublication } from '../src/publication-pending.mjs';
import { readPublicationJournal } from '../src/publication-journal.mjs';
import { run } from '../src/util.mjs';

const scope = Object.freeze({ projectId: 'conformance-project' });

async function lifecycleFixture() {
  const fixture = await gitLifecycleFixture();
  try {
    const adapter = createGitCompatibilityAdapter({ root: fixture.work, scope });
    const authority = await adapter.open(scope, { namespace: 'state', role: 'lifecycle' });
    assert.deepEqual(authority.descriptor, fixture.authority.descriptor, 'the native v1 contract stays identical');
    return { ...fixture, authority };
  } catch (error) { await fixture.cleanup(); throw error; }
}

async function proofFixture() {
  const fixture = await gitLedgerFixture();
  try {
    const config = { ...fixture.ledgerConfig };
    const bridge = createGitCompatibilityAdapter({ root: fixture.work, scope,
      proof: { config, options: fixture.ledgerOptions } });
    config.branch = 'must-not-redirect';
    const adapter = await bridge.open(scope, { namespace: 'state', role: 'proof' });
    assert.deepEqual(adapter.descriptor, fixture.adapter.descriptor, 'proof keeps its own v1 contract');
    return { ...fixture, adapter, async otherNamespace() {
      const other = createGitCompatibilityAdapter({ root: fixture.work, scope,
        proof: { config: { ...fixture.ledgerConfig, branch: 'state-other' }, options: fixture.ledgerOptions } });
      return other.open(scope, { namespace: 'state', role: 'proof' });
    } };
  } catch (error) { await fixture.cleanup(); throw error; }
}

lifecycleAuthorityConformance('Git compatibility lifecycle port', lifecycleFixture);
sharedStateConformance('Git compatibility proof port', proofFixture);

test('compatibility publication retains native state bytes and the same retained-commit recovery route', async t => {
  const fixture = await lifecycleFixture();
  t.after(() => fixture.cleanup());
  const { work, authority, transition, subject, target } = fixture;
  const created = await authority.publish(transition({ expectedRemoteSha: null, content: 'created' }));
  const bytes = await readFile(path.join(work, 'governed.json'), 'utf8');
  assert.equal(run('git', ['--git-dir', fixture.remote, 'show', `${subject.branch}:governed.json`]).stdout, bytes);
  assert.equal(await readPublicationJournal(work, subject), null);
  const controller = new AbortController();
  let retained;
  await assert.rejects(authority.publish(transition({ expectedRemoteSha: created.sha, content: 'retained',
    cancelAt: { stage: 'before-publishing', controller } }), { signal: controller.signal }), error => {
    retained = error;
    return error.code === 'PUBLICATION_CANCELLED_BEFORE_PUSH'
      && error.details.nextAction === `singularity-flow sync ${subject.id}`;
  });
  const pending = await authority.pending(subject);
  assert.equal(pending.commit, retained.publicationCommit);
  assert.equal(pending.pushOutcome, 'not-attempted');
  const synced = await syncPendingLifecyclePublication(work, { kind: subject.kind, id: subject.id });
  assert.equal(synced.pushed, retained.publicationCommit);
  assert.equal((await authority.observe(target)).revision, retained.publicationCommit);
  assert.equal(await authority.pending(subject), null);
});
