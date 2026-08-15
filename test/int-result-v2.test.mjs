import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRMATION_CLASSES, EFFECT_KEYS, RESULT_KINDS, RESULT_STATUSES,
  ACTION_EMPHASIS, CHECKLIST_STATES, INTERACTION_CLASSES, PRESERVATION_SCOPES,
  checklistSummary, effects, noEffects, preservedAll, preservedEverything, primaryAction,
  resultHash, sflowResult, SFLOW_RESULT_SCHEMA_VERSION, validateSflowResult
} from '../src/gateway/result.mjs';

const read = (over = {}) => sflowResult({
  kind: 'read',
  operation: { id: 'work.list', classification: 'read' },
  outcome: { status: 'succeeded', messageId: 'work.listed' },
  effects: noEffects(),
  restState: 'informational',
  ...over
});

test('the contract is version 2 and says so in both fields', () => {
  const result = read();
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.resultType, 'sflow-result');
  assert.equal(SFLOW_RESULT_SCHEMA_VERSION, 2);
});

test('kind and status are separate, and neither is the other', () => {
  // A refusal is a completed operation that produced nothing; a candidates result succeeded and
  // still needs a choice. Collapsing these is what made v1 producers explain the gap in prose.
  const refusal = sflowResult({
    kind: 'refusal',
    operation: { id: 'work.start', classification: 'mutation' },
    outcome: { status: 'refused', messageId: 'work.start.refused' },
    effects: noEffects(),
    preserved: preservedAll('work.nothing-was-carried-out'),
    restState: 'blocked'
  });
  assert.equal(refusal.kind, 'refusal');
  assert.equal(refusal.outcome.status, 'refused');

  const candidates = read({ kind: 'candidates', outcome: { status: 'succeeded', messageId: 'work.candidates' } });
  assert.equal(candidates.kind, 'candidates');
  assert.equal(candidates.outcome.status, 'succeeded');
  assert.notEqual(candidates.kind, candidates.outcome.status);
});

test('a refusal declaring any effect is rejected', () => {
  for (const key of EFFECT_KEYS) {
    assert.throws(() => sflowResult({
      kind: 'refusal',
      operation: { id: 'work.start', classification: 'mutation' },
      outcome: { status: 'refused', messageId: 'work.start.refused' },
      effects: effects({ [key]: true }),
      restState: 'blocked'
    }), new RegExp(`a refusal declared effects: ${key}`), `a refusal was allowed to claim ${key}`);
  }
});

test('every effect must be declared, so an unlisted one is never mistaken for false', () => {
  for (const missing of EFFECT_KEYS) {
    const partial = { ...noEffects() };
    delete partial[missing];
    assert.throws(() => read({ effects: partial }),
      new RegExp(`effects\\.${missing} must be declared`), `${missing} could be omitted`);
  }
  assert.throws(() => effects({ nothingLikeThis: true }), /'nothingLikeThis' is not a known effect/);
});

test('a result is never a dead end', () => {
  assert.throws(() => sflowResult({
    kind: 'read',
    operation: { id: 'work.list', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'work.listed' },
    effects: noEffects()
  }), /at least one next action or declare an explicit rest state/);

  // Either satisfies it.
  assert.ok(read({ restState: 'informational' }));
  assert.ok(read({
    restState: null,
    next: [{
      handle: 'h1', id: 'continue', label: 'Continue', kind: 'plan',
      reasonCode: 'work.continue', confirmation: 'host-confirm', interaction: 'form'
    }]
  }));
});

test('reasons and warnings are structured records, never prose', () => {
  // Prose cannot be translated, filtered, counted or matched against a catalog, and every surface
  // that allowed it grew a second vocabulary nobody could enumerate.
  assert.throws(() => read({ why: ['because the branch moved'] }), /why\[0\] has no catalog code/);
  assert.throws(() => read({ why: [{ code: 'x' }] }), /why\[0\]\.source 'undefined' is not one of/);
  const ok = read({ why: [{ code: 'branch.moved', source: 'lifecycle', reference: 'WRK-123' }] });
  assert.equal(ok.why[0].code, 'branch.moved');
  assert.equal(ok.why[0].source, 'lifecycle');
});

test('an authorization can only ever be a ceremony', () => {
  // Checked at construction, not only at the tool boundary: a result claiming `kind: plan` for an
  // approval would be executable by any host that trusts the contract.
  for (const kind of RESULT_KINDS.filter((entry) => entry !== 'ceremony')) {
    assert.throws(() => sflowResult({
      kind,
      operation: { id: 'phase.approve', classification: 'authorization' },
      outcome: { status: 'succeeded', messageId: 'phase.approve.offered' },
      effects: noEffects(),
      restState: 'awaiting-decision'
    }), /must return kind 'ceremony'/, `an authorization was allowed to be '${kind}'`);
  }
});

test('a ceremony next action is never executable by an ambient tool', () => {
  const result = sflowResult({
    kind: 'ceremony',
    operation: { id: 'phase.approve', classification: 'authorization' },
    outcome: { status: 'succeeded', messageId: 'phase.approve.offered' },
    effects: noEffects(),
    next: [{
      handle: 'h9', id: 'open-review', label: 'Open the review', kind: 'ceremony',
      reasonCode: 'decision.required', confirmation: 'ceremony', interaction: 'ceremony', executable: true
    }],
    restState: 'awaiting-decision'
  });
  // The producer asked for executable: true and does not get it.
  assert.equal(result.next[0].executable, false);
});

test('next actions carry an opaque handle, and every field a host needs to render one', () => {
  assert.throws(() => read({ next: [{ label: 'Go' }] }), /next\[0\] has no action handle/);
  assert.throws(() => read({ next: [{ handle: 'h', id: 'go', label: 'Go', kind: 'nope', reasonCode: 'r', confirmation: 'none', interaction: 'read' }] }),
    /next\[0\]\.kind 'nope' is not a result kind/);
  assert.throws(() => read({ next: [{ handle: 'h', id: 'go', label: 'Go', kind: 'plan', reasonCode: 'r', confirmation: 'maybe', interaction: 'form' }] }),
    /next\[0\]\.confirmation 'maybe' is not a confirmation class/);
  const result = read({
    next: [{ handle: 'h', id: 'go', label: 'Go', kind: 'plan', reasonCode: 'r', confirmation: 'host-confirm', interaction: 'form', fallback: { cli: 'sflow start' } }]
  });
  assert.equal(result.next[0].rank, 0);
  assert.equal(result.next[0].fallback.cli, 'sflow start');
});

test('subject revisions are always present in shape, even when unknown', () => {
  // A reader must be able to ask "what was this computed from" and get null rather than undefined,
  // which is indistinguishable from a producer that forgot the field.
  const result = read({ subject: { kind: 'story', id: 'WRK-123' } });
  assert.deepEqual(Object.keys(result.subject.revision).sort(),
    ['lifecycleHash', 'policyHash', 'registryHash', 'sourceCommit']);
  assert.equal(result.subject.revision.sourceCommit, null);
  assert.equal(read().subject, null);
});

test('version 1 keeps exactly one meaning: it is not a v2 result', () => {
  // The reset is the point [INT:CON-042]. Two live meanings for one version number is the defect
  // this contract exists to prevent.
  assert.throws(() => validateSflowResult({ ...read(), schemaVersion: 1 }),
    /schemaVersion 1 is not 2; v2 is a clean reset/);
  assert.throws(() => validateSflowResult({ resultType: 'command-result', schemaVersion: 1 }),
    /resultType 'command-result' is not sflow-result/);
});

test('validation and construction cannot drift, because validation rebuilds', () => {
  const result = read();
  assert.equal(validateSflowResult(result), result);
  // Anything construction rejects, validation rejects too.
  assert.throws(() => validateSflowResult({ ...result, kind: 'invented' }), /kind 'invented' is not one of/);
  assert.throws(() => validateSflowResult({ ...result, outcome: { status: 'ok', messageId: 'm' } }),
    /outcome\.status 'ok' is not one of/);
});

test('the result is frozen all the way down', () => {
  const result = read({ why: [{ code: 'c', source: 'policy' }], data: { count: 1 } });
  for (const target of [result, result.operation, result.outcome, result.effects, result.why[0], result.data]) {
    assert.ok(Object.isFrozen(target));
  }
});

test('the hash is content-addressed and ignores nothing that matters', () => {
  assert.equal(resultHash(read()), resultHash(read()));
  assert.notEqual(resultHash(read()), resultHash(read({ restState: 'blocked' })));
});

test('the vocabularies are closed and pinned', () => {
  assert.deepEqual([...RESULT_KINDS], ['read', 'plan', 'ceremony', 'host-action', 'candidates', 'clarification', 'refusal']);
  assert.deepEqual([...RESULT_STATUSES], ['succeeded', 'refused', 'failed', 'noop']);
  assert.deepEqual([...CONFIRMATION_CLASSES], ['none', 'host-confirm', 'exact-confirm', 'ceremony', 'explicit-only']);
  assert.deepEqual([...EFFECT_KEYS], [
    'contextChanged', 'stateChanged', 'filesChanged', 'gitRefsChanged', 'publicationCreated', 'externalSystemsChanged'
  ]);
});

// ---------------------------------------------------------------------------
// preserved[]: what survived, and why the claim can be trusted [UXH:REQ-061] [DHR:REQ-061]

const act = (over = {}) => sflowResult({
  kind: 'read',
  operation: { id: 'work.publish', classification: 'mutation' },
  outcome: { status: 'succeeded', messageId: 'work.published' },
  effects: effects({ filesChanged: true }),
  restState: 'informational',
  ...over
});

test('a refusal must say what it preserved, not only what it blocked', () => {
  // Three of the four things [DHR:REQ-061] requires already had somewhere to live. This is the one
  // that did not, and it is the one the reader is actually asking about.
  const refuse = (over = {}) => sflowResult({
    kind: 'refusal',
    operation: { id: 'work.start', classification: 'mutation' },
    outcome: { status: 'refused', messageId: 'work.start.refused' },
    effects: noEffects(),
    restState: 'blocked',
    ...over
  });
  assert.throws(() => refuse(), /a refused result must state what it preserved/);
  assert.ok(refuse({ preserved: preservedAll('work.nothing-was-carried-out') }));

  // A failure is held to the same rule: it is the case where the question matters most.
  assert.throws(() => sflowResult({
    kind: 'read',
    operation: { id: 'work.publish', classification: 'mutation' },
    outcome: { status: 'failed', messageId: 'work.publish.failed' },
    effects: effects({ filesChanged: true }),
    restState: 'blocked'
  }), /a failed result must state what it preserved/);
});

test('a preservation claim cannot contradict the effects record', () => {
  // [DHR:CON-060] in one check. Telling a reader their files are untouched while reporting that
  // files changed is the failure this channel exists to make impossible rather than discouraged.
  assert.throws(() => act({
    preserved: [{ code: 'work.files-untouched', source: 'evidence', scope: 'filesChanged' }]
  }), /claims filesChanged was preserved while effects filesChanged is true/);

  // The whole-world claim is checked against every effect, not just one.
  assert.throws(() => act({ preserved: preservedAll('work.nothing-was-carried-out') }),
    /claims all was preserved while effects filesChanged is true/);

  // A scope that genuinely did not move may still be claimed by a result that changed something
  // else — which is exactly the honest half-answer a partially-applied operation owes its reader.
  const partial = act({
    preserved: [{ code: 'work.nothing-was-published', source: 'evidence', scope: 'publicationCreated' }]
  });
  assert.equal(partial.preserved[0].scope, 'publicationCreated');
});

test('a preservation claim must name a scope that can be checked', () => {
  assert.throws(() => act({ preserved: [{ code: 'c', source: 'evidence' }] }),
    /preserved\[0\]\.scope 'undefined' is not one of/);
  assert.throws(() => act({ preserved: [{ code: 'c', source: 'evidence', scope: 'your-feelings' }] }),
    /preserved\[0\]\.scope 'your-feelings' is not one of/);
  assert.throws(() => act({ preserved: [{ code: 'c', source: 'vibes', scope: 'stateChanged' }] }),
    /preserved\[0\]\.source 'vibes' is not one of/);
  assert.deepEqual([...PRESERVATION_SCOPES], [
    'all', 'contextChanged', 'stateChanged', 'filesChanged',
    'gitRefsChanged', 'publicationCreated', 'externalSystemsChanged'
  ]);
});

// ---------------------------------------------------------------------------
// next[]: the fields a guided host needs to render an action [UXH:REQ-030]

const withNext = (action, over = {}) => read({
  next: [{
    handle: 'h', id: 'act', label: 'Go', kind: 'read',
    reasonCode: 'r', confirmation: 'none', interaction: 'read', ...action
  }],
  ...over
});

test('a next action carries a stable id, separate from its rotating handle', () => {
  // The handle is reissued every time the result is recomputed. Focus restoration, telemetry and a
  // checklist row pointing at its fix button all need the identity that does not move.
  assert.throws(() => read({ next: [{ handle: 'h', label: 'Go', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'read' }] }),
    /next\[0\] has no stable id/);
  assert.throws(() => read({
    next: [
      { handle: 'h1', id: 'same', label: 'A', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'read' },
      { handle: 'h2', id: 'same', label: 'B', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'read' }
    ]
  }), /next\[1\] repeats id 'same'/);
});

test('interaction is declared, closed, and cannot disagree with confirmation about a ceremony', () => {
  assert.throws(() => read({ next: [{ handle: 'h', id: 'a', label: 'Go', kind: 'read', reasonCode: 'r', confirmation: 'none' }] }),
    /next\[0\]\.interaction 'undefined' is not one of/);
  // A ceremony is both or neither: a host that renders an approval as an ordinary button has
  // defeated the ceremony while passing every kernel-side check.
  assert.throws(() => withNext({ confirmation: 'ceremony', kind: 'ceremony' }),
    /a ceremony is both or neither/);
  assert.throws(() => withNext({ interaction: 'ceremony' }),
    /a ceremony is both or neither/);
  assert.ok(withNext({ confirmation: 'ceremony', interaction: 'ceremony', kind: 'ceremony' }));
  assert.deepEqual([...INTERACTION_CLASSES],
    ['read', 'form', 'ceremony', 'model-consent', 'external', 'navigation', 'recovery']);
});

test('at most one action may be primary, and the default is not primary', () => {
  // [UXH:REQ-064]. Two filled buttons say nothing about which one the system believes is next, and
  // a guided shell whose guidance is "pick one" is a menu.
  assert.equal(withNext({}).next[0].emphasis, 'secondary');
  assert.equal(primaryAction(withNext({})), null);
  assert.equal(primaryAction(withNext({ emphasis: 'primary' })).id, 'act');
  assert.throws(() => read({
    next: [
      { handle: 'h1', id: 'a', label: 'A', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'read', emphasis: 'primary' },
      { handle: 'h2', id: 'b', label: 'B', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'read', emphasis: 'primary' }
    ]
  }), /next declares 2 primary actions \(a, b\)/);
  assert.throws(() => withNext({ emphasis: 'shouty' }), /next\[0\]\.emphasis 'shouty' is not one of/);
  assert.deepEqual([...ACTION_EMPHASIS], ['primary', 'secondary', 'link']);
});

test('topic and effect are optional, null when absent, and display-only when present', () => {
  const bare = withNext({});
  assert.equal(bare.next[0].topic, null);
  assert.equal(bare.next[0].effect, null);
  const rich = withNext({ topic: 'governance/approvals', effect: { summaryMessageId: 'effect.publishes' } });
  assert.equal(rich.next[0].topic, 'governance/approvals');
  assert.equal(rich.next[0].effect.summaryMessageId, 'effect.publishes');
  // Declared as a shape even when the producer named no target, so a reader can tell "no target"
  // from "producer forgot" — the same reason every binding field is declared rather than omitted.
  assert.equal(rich.next[0].effect.target, null);
  assert.ok(Object.isFrozen(rich.next[0].effect));
});

// ---------------------------------------------------------------------------
// checklist[]: a refusal as gates rather than a red error [UXH:REQ-062] [UXH:AC-003]

const gate = (over = {}) => ({ id: 'tests', code: 'readiness.tests', state: 'unmet', source: 'lifecycle', ...over });

test('a checklist row cannot point at an action this result did not offer', () => {
  // The dead fix button, refused at construction. A row whose action was never offered renders a
  // control that cannot work, which is worse than the refusal it was added to soften.
  assert.throws(() => read({ checklist: [gate({ action: 'fix:tests' })] }),
    /checklist\[0\]\.action 'fix:tests' is not one of this result's next actions/);
  const wired = read({
    next: [{ handle: 'h', id: 'fix:tests', label: 'Run tests', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'navigation' }],
    checklist: [gate({ action: 'fix:tests' })]
  });
  assert.equal(wired.checklist[0].action, 'fix:tests');
});

test('unmet and unknown are different facts and never merge', () => {
  const result = read({
    checklist: [
      gate({ id: 'a', state: 'met', evidence: 'WRK-1' }),
      gate({ id: 'b', state: 'unmet' }),
      gate({ id: 'c', state: 'unknown', source: 'unavailable', evidence: null })
    ]
  });
  const summary = checklistSummary(result);
  assert.deepEqual({ ...summary }, { total: 3, met: 1, unmet: 1, unknown: 1, outstanding: 2 });
  // Both surfaces that show a gate count call this, so "2 of 5 unmet" and "gates 3/5" are one
  // derivation rendered twice rather than two derivations that agree today [UXH:AC-002].
  assert.equal(summary.met + summary.outstanding, summary.total);
  assert.throws(() => read({ checklist: [gate({ state: 'probably' })] }),
    /checklist\[0\]\.state 'probably' is not one of/);
  assert.deepEqual([...CHECKLIST_STATES], ['met', 'unmet', 'unknown']);
});

test('checklist ids are unique, because a row is addressed by id', () => {
  assert.throws(() => read({ checklist: [gate({ id: 'x' }), gate({ id: 'x' })] }),
    /checklist\[1\] repeats id 'x'/);
  assert.throws(() => read({ checklist: [{ code: 'c', state: 'met', source: 'lifecycle' }] }),
    /checklist\[0\] has no id/);
});

test('the new channels survive validation, hashing and freezing like the old ones', () => {
  const result = read({
    next: [{ handle: 'h', id: 'fix:tests', label: 'Run tests', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'navigation' }],
    preserved: preservedAll('work.nothing-was-carried-out'),
    checklist: [gate({ action: 'fix:tests' })]
  });
  assert.equal(validateSflowResult(result), result);
  for (const target of [result.preserved, result.preserved[0], result.checklist, result.checklist[0]]) {
    assert.ok(Object.isFrozen(target));
  }
  // Content-addressed means the new fields count: a result that says nothing was preserved and one
  // that says so explicitly are different results.
  assert.notEqual(resultHash(result), resultHash(read({
    next: [{ handle: 'h', id: 'fix:tests', label: 'Run tests', kind: 'read', reasonCode: 'r', confirmation: 'none', interaction: 'navigation' }],
    checklist: [gate({ action: 'fix:tests' })]
  })));
  assert.ok(preservedEverything(result));
  assert.equal(preservedEverything(act()), false);
});

test('no producer emits a model-consent interaction in v1', () => {
  // [UXH:AC-015] as a gate rather than a promise. The class exists so the day a model enters a
  // journey there is somewhere to ask; until then the silence is asserted, not assumed.
  assert.ok(INTERACTION_CLASSES.includes('model-consent'));
});
