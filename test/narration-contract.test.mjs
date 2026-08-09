/**
 * Conformance for the narration contract.
 *
 * These are the clauses that have to be mechanical rather than aspirational, because every one of
 * them is a way for narration to start lying: reassurance that outlives the truth it described,
 * prose smuggled into a data field, a refusal that stops someone with no way forward.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  action, because, commandResult, effects, failed, noEffects, noop, preservedEverything, refused, succeeded
} from '../src/narration/command-result.mjs';
import { MESSAGES, REASONS, preservingMessageIds } from '../src/narration/messages.mjs';
import { renderCommandResult } from '../src/narration/render-terminal.mjs';
import { renderCommandResultJson } from '../src/narration/render-json.mjs';
import { attachContinuation, remediationActions } from '../src/narration/continuation.mjs';

const OPERATION = { id: 'submit', classification: 'mutation' };
const SUBJECT = { kind: 'story', id: 'PAY-1187' };

function base(overrides = {}) {
  return commandResult({
    operation: OPERATION,
    subject: SUBJECT,
    outcome: refused('submit.refused', { phase: 'requirements' }),
    effects: noEffects(),
    why: [because('sequence.gate-failed', 'gate', { slots: { failed: 2, total: 8 } })],
    next: [action({ id: 'x', label: 'Do the thing', command: 'singularity-flow validate' })],
    ...overrides
  });
}

test('NCL-002 the command result is not a reference envelope', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/command-result.schema.json', import.meta.url), 'utf8'));
  const reference = JSON.parse(await readFile(new URL('../schemas/reference-envelope.schema.json', import.meta.url), 'utf8'));
  assert.notEqual(schema.$id, reference.$id, 'the two contracts are distinct documents');
  // Evidence transport belongs to the reference envelope; explanation and continuation do not.
  for (const field of ['why', 'next', 'effects', 'outcome']) {
    assert.ok(!reference.properties?.[field], `reference envelope must not grow a ${field} field`);
  }
  for (const field of ['preview', 'handle', 'resolvedRevision']) {
    assert.ok(!schema.properties?.[field], `command result must not absorb the reference envelope's ${field}`);
  }
});

test('NCL-003 every refusal declares machine-readable effects', () => {
  const result = base();
  assert.deepEqual(Object.keys(result.effects).sort(),
    ['externalSystemsChanged', 'filesChanged', 'publicationCreated', 'stateChanged']);
  assert.ok(preservedEverything(result));
});

test('NCL-004 a refusal that changed something is rejected outright', () => {
  assert.throws(
    () => base({ effects: effects({ filesChanged: true }) }),
    /is a refusal but declares effects: filesChanged/
  );
});

test('NCL-004 reassurance is derived from effects, never authored beside them', () => {
  const preserved = renderCommandResult(base());
  assert.match(preserved, /No governed state, files, publications or external systems were changed\./);

  // The same catalog message on a result that did change something must not reassure. `preserves`
  // marks a message as permitted to reassure; the effects decide whether it actually does.
  const changed = commandResult({
    operation: OPERATION,
    subject: SUBJECT,
    outcome: noop('submit.noop', { phase: 'requirements' }),
    effects: effects({ filesChanged: true }),
    next: [action({ id: 'x', label: 'Continue', command: 'singularity-flow status' })]
  });
  assert.doesNotMatch(renderCommandResult(changed), /were changed\./);
});

test('NCL-004 every message permitted to reassure is only used where nothing changed', () => {
  // The catalog cannot promise preservation for a message a mutating outcome would use.
  for (const id of preservingMessageIds()) {
    assert.ok(MESSAGES[id].headline, `${id} needs a headline`);
    assert.doesNotMatch(id, /^(approve|reject|resume)\.succeeded$/,
      `${id} reports a change and must not be marked as preserving`);
  }
});

test('NCL-005 WHY carries cataloged reason codes, never handler prose', () => {
  assert.throws(
    () => base({ why: [{ code: 'sequence.gate-failed', source: 'gate', detail: 'two gates failed' }] }),
    /carries reason codes, not prose/
  );
  assert.throws(() => base({ why: [because('Not A Code', 'gate')] }), /must be a dotted lower-case reason code/);
  assert.throws(() => base({ why: [because('a.b', 'invented-source')] }), /why\[\]\.source/);
  for (const entry of base().why) assert.ok(REASONS[entry.code], `${entry.code} must be in the catalog`);
});

test('NCL-005 a WHY reference stays resolvable beside its friendly wording', () => {
  const withRef = base({
    why: [because('phase.selected-by-pinned-rail', 'pin', { ref: 'workflow@4af71c2', slots: { phase: 'requirements', position: 1 } })]
  });
  const rendered = renderCommandResult(withRef);
  assert.match(rendered, /requirements is phase 1 of the rail this Story pinned when it started/);
  assert.match(rendered, /↳ pin:workflow@4af71c2/, 'the immutable reference survives the friendly line');
});

test('NCL-006 a result with neither continuation nor rest state is refused', () => {
  assert.throws(
    () => base({ next: [], restState: null }),
    /offers no next action and declares no rest state/
  );
});

test('NCL-006 a refusal is given remediation, not a rest state', () => {
  const blocked = {
    ...base({ next: [], restState: 'informational' }),
    why: [because('publication.pending', 'sequence'), because('ledger.behind', 'evidence', { slots: { pending: 1 } })]
  };
  const remediation = remediationActions(blocked);
  assert.deepEqual(remediation.map((entry) => entry.id), ['sync-publication', 'reconcile-ledger']);
  for (const entry of remediation) assert.equal(entry.kind, 'remediation');
});

test('NCL-008 continuation is derived from post-command state', () => {
  const attached = attachContinuation({ ...base({ next: [], restState: 'informational' }), restState: null, next: [] });
  assert.ok(attached.next.length || attached.restState, 'a continuation is always attached');
});

test('NCL-009 and NCL-010 terminal formatting never reaches JSON', () => {
  const result = base({
    why: [because('sequence.gate-failed', 'gate', { ref: 'gate@abc1234', slots: { failed: 2, total: 8 } })]
  });
  const json = JSON.parse(renderCommandResultJson(result));
  const serialized = JSON.stringify(json);
  assert.doesNotMatch(serialized, /↳/, 'no terminal arrows in JSON');
  assert.doesNotMatch(serialized, /\bNOW {2,}/, 'no column padding in JSON');
  // Codes and slots travel; the client renders its own words.
  assert.equal(json.why[0].code, 'sequence.gate-failed');
  assert.deepEqual(json.why[0].slots, { failed: 2, total: 8 });
  assert.equal(json.rendered.preservedEverything, true);
});

test('NCL-020 narration computes no lifecycle truth', async () => {
  // The plane explains and projects. It must not write, move refs, or decide governed questions.
  for (const file of ['command-result.mjs', 'messages.mjs', 'render-terminal.mjs', 'render-json.mjs', 'continuation.mjs']) {
    const source = await readFile(new URL(`../src/narration/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /writeJson|writeFile|writeAtomic|saveWorkflow|saveInitiative/, `${file} must not persist`);
    assert.doesNotMatch(source, /commitAndPublish|commitIsolated|pushBranch|update-ref/, `${file} must not publish`);
  }
});

test('the catalog covers every message and reason the constructors admit', () => {
  const result = base();
  assert.ok(MESSAGES[result.outcome.messageId], 'outcome message is cataloged');
  assert.equal(typeof MESSAGES[result.outcome.messageId].headline, 'function');
  for (const code of Object.keys(REASONS)) {
    assert.equal(typeof REASONS[code].render, 'function', `${code} renders`);
    assert.match(code, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, `${code} is a dotted lower-case code`);
  }
});

test('succeeded, failed and noop outcomes all round-trip', () => {
  for (const outcome of [
    succeeded('submit.succeeded', { phase: 'requirements' }),
    failed('submit.refused', { phase: 'requirements' }),
    noop('submit.noop', { phase: 'requirements' })
  ]) {
    const result = commandResult({
      operation: OPERATION,
      subject: SUBJECT,
      outcome,
      effects: outcome.status === 'succeeded' ? effects({ stateChanged: true, publicationCreated: true }) : noEffects(),
      restState: 'complete'
    });
    assert.equal(result.outcome.status, outcome.status);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.resultType, 'command-result');
  }
});
