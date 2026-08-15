import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRMATION_CLASSES, EFFECT_KEYS, RESULT_KINDS, RESULT_STATUSES,
  effects, noEffects, resultHash, sflowResult, SFLOW_RESULT_SCHEMA_VERSION, validateSflowResult
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
    next: [{ handle: 'h1', label: 'Continue', kind: 'plan', reasonCode: 'work.continue', confirmation: 'host-confirm' }]
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
      handle: 'h9', label: 'Open the review', kind: 'ceremony',
      reasonCode: 'decision.required', confirmation: 'ceremony', executable: true
    }],
    restState: 'awaiting-decision'
  });
  // The producer asked for executable: true and does not get it.
  assert.equal(result.next[0].executable, false);
});

test('next actions carry an opaque handle, and every field a host needs to render one', () => {
  assert.throws(() => read({ next: [{ label: 'Go' }] }), /next\[0\] has no action handle/);
  assert.throws(() => read({ next: [{ handle: 'h', label: 'Go', kind: 'nope', reasonCode: 'r', confirmation: 'none' }] }),
    /next\[0\]\.kind 'nope' is not a result kind/);
  assert.throws(() => read({ next: [{ handle: 'h', label: 'Go', kind: 'plan', reasonCode: 'r', confirmation: 'maybe' }] }),
    /next\[0\]\.confirmation 'maybe' is not a confirmation class/);
  const result = read({
    next: [{ handle: 'h', label: 'Go', kind: 'plan', reasonCode: 'r', confirmation: 'host-confirm', fallback: { cli: 'sflow start' } }]
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
