/**
 * The return briefing on the home card. `[DHR:REQ-024]` `[UXH:REQ-020]`
 *
 * Fixtures come from `homeOverviewResult` rather than being written by hand, for the reason the
 * result-card tests give: a hand-built envelope drifts from its producer, and then the delta passes
 * while the screen is wrong. That is the exact failure this feature is being rebuilt after — the
 * producer moved to `sflow-result` v2 and the consumer went on reading `developer-home`.
 *
 * The assertions that matter most are the ones separating *nothing changed* from *we could not
 * compare*. Both render an empty change list, both are honest, and only one of them tells the
 * reader they can stop looking.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codeOnly } from './source-text.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';
import { workReadinessResult } from '../src/gateway/planners/work-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const { ACKNOWLEDGE_ACTION_ID, acknowledgementKey, homeAcknowledgementFor, homeDelta } =
  await import(view('home-acknowledgement.ts'));
const { buildResultCard } = await import(view('result-card-model.ts'));
const { resultCardHtml } = await import(view('result-card-page.ts'));

const WORKSPACE = { id: 'local--calc', name: 'calc-app' };

/** A home as the planner emits one, with the revision a handle-bound read now carries. */
function home({
  sourceCommit = 'a'.repeat(40),
  localChanges = { dirty: false, files: 0, worktreeHash: null, paths: [] },
  active = null,
  workspace = WORKSPACE
} = {}) {
  return homeOverviewResult({
    workspace,
    records: { groups: { active: active ? [active] : [] } },
    subject: {
      kind: 'repository', id: 'calc',
      revision: { sourceCommit, worktreeAlgorithm: 'sflow-worktree-v2' }
    },
    localChanges
  });
}

const story = (overrides = {}) => ({ id: 'WRK-1978', title: 'Rounding', phase: 'implement', rail: [], ...overrides });

/** What the host would store for a given home, so a test never hand-writes a snapshot. */
const ackFor = (result, at = '2026-08-15T09:00:00.000Z') =>
  homeAcknowledgementFor(result, () => new Date(at));

test('a home with no acknowledgement is reported as current state, not as an empty delta', () => {
  const delta = homeDelta(home(), null);

  assert.equal(delta.state, 'not-checked');
  assert.equal(delta.heading, 'Current state');
  assert.equal(delta.at, null);
  /**
   * The heading is the whole point of the state. "Since you last checked" above an empty list is
   * read as *nothing moved*, and the reader has never checked — so there is no *since*.
   */
  assert.doesNotMatch(delta.heading, /since/i);
  assert.match(delta.summary, /nothing to compare against/i);
  assert.equal(delta.action.id, ACKNOWLEDGE_ACTION_ID);
  assert.equal(delta.action.label, 'Mark as checked');
});

test('an unchanged world since the acknowledgement says so out loud', () => {
  const result = home();
  const delta = homeDelta(result, ackFor(result));

  assert.equal(delta.state, 'compared');
  assert.equal(delta.heading, 'Since you last checked');
  assert.deepEqual(delta.changes, []);
  assert.equal(delta.obstacle, null);
  assert.match(delta.summary, /Nothing has changed here since then/);
  // The second press is an update, not a first mark — the label says which.
  assert.equal(delta.action.label, 'Update acknowledgement');
});

test('a moved HEAD, a moved Story and a dirtied worktree are each named', () => {
  const before = home({ active: story() });
  const acknowledgement = ackFor(before);

  const after = home({
    sourceCommit: 'b'.repeat(40),
    active: story({ phase: 'verify' }),
    localChanges: { dirty: true, files: 3, worktreeHash: 'c'.repeat(64), paths: ['src/a.mjs'] }
  });
  const delta = homeDelta(after, acknowledgement);

  assert.equal(delta.state, 'compared');
  const summary = delta.summary;
  assert.match(summary, /repository moved from aaaaaaaaaaaa to bbbbbbbbbbbb/);
  assert.match(summary, /WRK-1978 moved from implement to verify/);
  assert.match(summary, /worktree now has uncommitted changes/);
  assert.equal(delta.changes.length, 3);
});

test('a different active Story is named as such rather than as a phase move', () => {
  const before = home({ active: story() });
  const after = home({ active: story({ id: 'WRK-2001' }) });
  const delta = homeDelta(after, ackFor(before));

  assert.match(delta.summary, /active Story is now WRK-2001/);
  assert.doesNotMatch(delta.summary, /moved from implement/);
});

test('uncommitted changes that are not the ones you left are reported from the hash', () => {
  const dirty = (hash) => home({
    active: story(),
    localChanges: { dirty: true, files: 2, worktreeHash: hash, paths: ['src/a.mjs'] }
  });
  const delta = homeDelta(dirty('e'.repeat(64)), ackFor(dirty('d'.repeat(64))));

  /**
   * `dirty` is true on both sides, so a delta reading only that flag reports nothing — and the
   * developer who came back to a shared machine is told their work is as they left it.
   */
  assert.match(delta.summary, /not the ones you left/);
});

test('an unreadable repository is "could not compare", and reads nothing like "nothing changed"', () => {
  const before = home();
  /** `localChanges: null` is what `localChangesFor` returns when Git could not answer at all. */
  const unreadable = home({ sourceCommit: null, localChanges: null });
  const delta = homeDelta(unreadable, ackFor(before));

  assert.equal(delta.state, 'incomparable');
  assert.equal(delta.heading, 'Could not compare');
  assert.deepEqual(delta.changes, []);
  assert.match(delta.summary, /unknown — not nothing/);
  assert.doesNotMatch(delta.summary, /nothing has changed/i);
  assert.ok(delta.obstacle, 'an incomparable delta names what stopped it');

  /**
   * The two states that both carry an empty change list must not produce the same sentence. This is
   * the assertion the whole distinction exists for: if it ever passes by accident, the card is
   * telling someone their branch is untouched on the strength of a read that failed.
   */
  const unchanged = homeDelta(before, ackFor(before));
  assert.notEqual(delta.summary, unchanged.summary);
  assert.notEqual(delta.heading, unchanged.heading);
});

test('an acknowledgement from another workspace is not diffed against this one', () => {
  const elsewhere = home({ workspace: { id: 'local--other', name: 'other' }, sourceCommit: 'f'.repeat(40) });
  const delta = homeDelta(home(), ackFor(elsewhere));

  assert.equal(delta.state, 'incomparable');
  assert.match(delta.summary, /different workspace/);
  /** Nothing is claimed to have moved, because the two were never the same subject. */
  assert.deepEqual(delta.changes, []);
});

test('a partly readable world still reports what it found, and says what it could not', () => {
  const before = home({ active: story() });
  const after = home({ active: story({ phase: 'verify' }), localChanges: null });
  const delta = homeDelta(after, ackFor(before));

  assert.equal(delta.state, 'compared', 'a readable half is still a comparison');
  assert.match(delta.summary, /WRK-1978 moved from implement to verify/);
  assert.match(delta.summary, /worktree could not be compared/);
  assert.ok(delta.obstacle, 'the gap is named rather than left to the empty space');
});

test('nothing worth storing means no button to store it', () => {
  const unreadable = home({ sourceCommit: null, localChanges: null });

  assert.equal(homeAcknowledgementFor(unreadable), null);
  /**
   * Pressing it would move the reader from "not checked" to "could not compare" — strictly worse,
   * and caused by the control that offered to help.
   */
  assert.equal(homeDelta(unreadable, null).action, null);
});

test('the stored snapshot carries what the next comparison reads, and nothing else', () => {
  const acknowledgement = ackFor(home({ active: story() }));

  assert.deepEqual(Object.keys(acknowledgement).sort(), [
    'activeWorkId', 'activeWorkPhase', 'at', 'dirty', 'sourceCommit', 'version',
    'worktreeAlgorithm', 'worktreeHash', 'workspaceId'
  ].sort());
  assert.equal(acknowledgement.version, 2);
  assert.equal(acknowledgement.worktreeAlgorithm, 'sflow-worktree-v2');
  assert.equal(acknowledgement.workspaceId, WORKSPACE.id);
  assert.equal(acknowledgement.activeWorkId, 'WRK-1978');
  /** A read that found a clean tree, which is not the same as a tree nobody read. */
  assert.equal(acknowledgement.dirty, false);
});

test('a legacy fingerprint acknowledgement is stale rather than silently comparable', () => {
  const result = home();
  const legacy = {
    ...ackFor(result), version: 1, worktreeAlgorithm: undefined
  };
  const delta = homeDelta(result, legacy);
  assert.equal(delta.state, 'incomparable');
  assert.match(delta.summary, /older fingerprint algorithm/i);
});

test('the key is per workspace and per actor', () => {
  assert.notEqual(
    acknowledgementKey('local--calc', 'ada@example.com'),
    acknowledgementKey('local--calc', 'grace@example.com')
  );
  assert.notEqual(
    acknowledgementKey('local--calc', 'ada@example.com'),
    acknowledgementKey('local--other', 'ada@example.com')
  );
  // A missing half is named rather than collapsing two unknowns into one shared bucket silently.
  assert.match(acknowledgementKey(null, null), /unknown\.unknown$/);
});

test('only a home carries a delta, and only when the host offered a store', () => {
  const result = home();

  assert.equal(buildResultCard(result).since, null, 'a caller with no store gets no briefing');
  assert.ok(buildResultCard(result, { acknowledgement: null }).since, 'a caller with a store does');

  /**
   * Gated on the operation, so one shared store cannot make a readiness card start claiming to know
   * what changed since the reader last looked at it.
   */
  const readiness = workReadinessResult({
    id: 'PAY-1187', kind: 'story', phase: 'implement', generation: 3, group: 'active',
    blockers: [], nextAction: null, lastMaterialEvent: null
  });
  assert.equal(buildResultCard(readiness, { acknowledgement: null }).since, null);
});

test('the card renders the briefing and its button, and puts no snapshot in the markup', () => {
  const result = home({ active: story() });
  const html = resultCardHtml(buildResultCard(result, { acknowledgement: ackFor(result) }));

  assert.match(html, /Since you last checked/);
  assert.match(html, /Nothing has changed here since then/);
  assert.match(html, new RegExp(`data-action-id="${ACKNOWLEDGE_ACTION_ID}"`));
  assert.match(html, />Update acknowledgement</);
  /**
   * The webview is a separate document and the delta is host memory. The button carries an id and
   * nothing else — a rendered snapshot would put the reader's history in a page any script in it
   * can read.
   */
  assert.doesNotMatch(html, /worktreeHash/);
  assert.doesNotMatch(html, /2026-08-15T09:00:00/);
});

test('the not-checked card offers to start a comparison rather than claiming one', () => {
  const html = resultCardHtml(buildResultCard(home(), { acknowledgement: null }));

  assert.match(html, /Current state/);
  assert.match(html, />Mark as checked</);
  assert.doesNotMatch(html, /Since you last checked/);
  assert.doesNotMatch(html, /Nothing has changed/);
});

test('the panel accepts the acknowledge press only when the card offered it', () => {
  const panel = codeOnly(readFileSync(
    new URL('../apps/vscode/src/views/result-panel.ts', import.meta.url), 'utf8'));

  /**
   * The acknowledge button is the host's own and has no `next[]` entry to be looked up in, so the
   * "was this offered?" check has to name it explicitly. Without this line a forged `actionId` in a
   * webview message reaches the dispatcher — the one guarantee the lookup was written for.
   */
  assert.match(panel, /since\?\.action\?\.id === actionId/,
    'result-panel must check the acknowledge id against the rendered card');
});

test('the acknowledgement time is shown both ways round', () => {
  const result = home();
  const at = '2026-08-16T06:00:00.000Z';
  const html = resultCardHtml(buildResultCard(result, { acknowledgement: ackFor(result, at) }),
    { now: Date.parse('2026-08-16T09:00:00.000Z') });

  /** Relative to orient, absolute to check — three weeks and three days must not read alike. */
  assert.match(html, /3 hours ago/);
  assert.match(html, new RegExp(String(new Date(at).getFullYear())));
});
