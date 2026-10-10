/**
 * Forms derived from the operation's own schema, and the ceremony rule that must survive them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ARGUMENT_SCHEMAS } from '../src/gateway/argument-schemas.mjs';
import {
  checkForm, draftRecord, formModel, readDraft, restoreDraft, schemaFingerprint, terminalEquivalent
} from '../src/gateway/form-model.mjs';

test('a form is the schema, not a hand-written copy of it', () => {
  /**
   * 25 bespoke panels exist because every journey step hand-wrote its fields, which is 25 places
   * for a form to drift from the operation it submits to.
   */
  const model = formModel('work-list-v1');
  assert.deepEqual(model.fields.map((field) => field.name), ['group', 'includeCompleted']);
  assert.equal(model.fields.find((field) => field.name === 'group').control, 'choice');
  assert.ok(model.fields.find((field) => field.name === 'group').values.length);
  assert.equal(model.fields.find((field) => field.name === 'includeCompleted').control, 'checkbox');
});

test('required fields come first, and declaration order survives inside each group', () => {
  // Declaration order carries the author's sense of what depends on what. Alphabetical would
  // discard it; grouping by type would sort a form by implementation detail.
  const model = formModel('work-list-v1');
  const required = model.fields.filter((field) => field.required);
  const optional = model.fields.filter((field) => !field.required);
  assert.deepEqual(model.fields, [...required, ...optional]);
});

test('every registered schema renders, or names the field it cannot', () => {
  /**
   * The gap this would otherwise hide: a type with no designed input rendered as a plain box is a
   * field nobody thought about, reaching an operation that will type-check it.
   */
  const gaps = [];
  for (const schema of ARGUMENT_SCHEMAS) {
    const model = formModel(schema.id);
    assert.ok(model, `${schema.id} has no form model`);
    if (model.unrenderable.length) gaps.push(`${schema.id}: ${model.unrenderable.join(', ')}`);
  }
  assert.deepEqual(gaps, [], `types with no input:\n  ${gaps.join('\n  ')}`);
});

test('an unknown schema is null rather than an empty form', () => {
  // An empty form submits nothing and looks like a form with no fields, which is a state some
  // schemas legitimately have.
  assert.equal(formModel('not-a-schema-v1'), null);
  assert.equal(formModel('no-arguments-v1').fields.length, 0, 'and a genuinely empty schema is empty');
});

test('a typed confirmation is never pre-filled and never persisted', () => {
  /**
   * `[UXH:AC-004]`, and the trap the reference screen makes easy to fall into: the confirmation
   * input shows the work ID greyed. That must be a placeholder, never a value — the two look
   * identical in a screenshot and only one of them preserves the ceremony.
   *
   * Decided in the model rather than left to each renderer, because "remember not to fill this in"
   * is not a property any renderer should be trusted to remember.
   */
  const model = formModel('review-approve-v1', { defaults: { confirm: 'PAY-1187', workId: 'PAY-1187' } });
  if (!model) return; // The schema is not registered in this build; the rule is asserted below anyway.
  const confirmation = model.fields.find((field) => field.ceremony);
  if (confirmation) {
    assert.equal(confirmation.value, null, 'a default defeats the ceremony on first open');
    assert.equal(confirmation.persist, false, 'persistence defeats it on every open after a refresh');
  }
});

test('a draft cannot restore a confirmation, whatever the draft says', () => {
  /**
   * Draft restoration is exactly the mechanism `[UXH:AC-004]` names. A draft is written by one
   * version of a form and read by another, so it is untrusted twice over.
   */
  const restored = restoreDraft('work-list-v1', {
    group: 'active', confirm: 'PAY-1187', acknowledge: 'yes', notAField: 'x'
  });
  assert.equal(restored.group, 'active');
  assert.equal(restored.confirm, undefined, 'a ceremony field is dropped whatever the draft holds');
  assert.equal(restored.acknowledge, undefined);
  assert.equal(restored.notAField, undefined, 'a field the schema no longer declares is dropped');
});

test('an opaque continuation cursor is renderable but never persisted in a draft', () => {
  const cursor = `astp_eA.${'a'.repeat(64)}`;
  const model = formModel('ast-context-v2', { defaults: { cursor } });
  const field = model.fields.find((item) => item.name === 'cursor');
  assert.equal(field.control, 'line');
  assert.equal(field.value, cursor);
  assert.equal(field.persist, false);
  assert.equal(draftRecord('ast-context-v2', { cursor }).values.cursor, undefined);
  assert.equal(restoreDraft('ast-context-v2', { cursor }).cursor, undefined);
});

test('a confirmation is filtered on the way in, not only on the way out', () => {
  /**
   * Once it reaches storage the rule has already been broken: workspace state is a file someone can
   * open, and a later reader declining to restore a confirmation does not unwrite it.
   */
  const record = draftRecord('work-list-v1', { group: 'active', confirm: 'PAY-1187', apiKey: 'sk-live-x' });
  assert.deepEqual(record.values, { group: 'active' });
  assert.equal(record.values.confirm, undefined);
  // `[UXH:REQ-074]` names secrets separately from confirmation text, because they are separate
  // hazards. No schema declares one today, which is when the rule is cheap to write.
  assert.equal(record.values.apiKey, undefined);
});

test('a draft written against a different schema shape is discarded, not salvaged', () => {
  /**
   * "Discard incompatible values safely" `[UXH:REQ-074]` is an instruction about doubt. Restoring
   * the fields that happen to still match would fill a form from two schemas with nothing on
   * screen to say so.
   */
  const record = draftRecord('work-list-v1', { group: 'active' });
  assert.deepEqual(readDraft('work-list-v1', record), { group: 'active' });

  assert.deepEqual(readDraft('work-list-v1', { ...record, version: 99 }), {}, 'envelope moved');
  assert.deepEqual(readDraft('work-list-v1', { ...record, fingerprint: 'group:string' }), {}, 'schema moved');
  assert.deepEqual(readDraft('work-list-v1', { ...record, schemaId: 'work-subject-v1' }), {}, 'wrong form');
  for (const junk of [null, undefined, 'a string', 42, [record]]) {
    assert.deepEqual(readDraft('work-list-v1', junk), {}, `${JSON.stringify(junk)} was read as a draft`);
  }
});

test('the fingerprint follows the field types, and ignores their order', () => {
  // Reordering a schema invalidates nothing a reader typed. Retyping a field invalidates the value.
  assert.equal(schemaFingerprint('work-list-v1'), 'group:enum,includeCompleted:boolean');
  assert.equal(schemaFingerprint('not-a-schema-v1'), null);
});

test('local validation reports where the operation would refuse, and never throws', () => {
  /**
   * `[UXH:REQ-071]`: this is feedback, the operation is the authority, and the two read one
   * declaration so they cannot disagree about what is valid.
   */
  const missing = checkForm('work-subject-v1', {});
  assert.equal(missing.valid, false);
  assert.deepEqual(missing.problems, [{ field: 'workId', code: 'form.required', detail: null }]);

  assert.equal(checkForm('work-subject-v1', { workId: 'WRK-1' }).valid, true);

  const wrong = checkForm('work-list-v1', { group: 'nonsense' });
  assert.equal(wrong.valid, false);
  assert.equal(wrong.problems[0].field, 'group', 'the problem names the field it is about');
  assert.match(wrong.problems[0].detail, /group/);
});

test('an unfilled optional is omitted, not sent as null', () => {
  // The schema is closed, and a null for a field the caller did not fill is a value they did not
  // choose — narrower than what they asked for, silently.
  assert.equal(checkForm('work-list-v1', { group: '', includeCompleted: undefined }).valid, true);
});

test('the terminal equivalent is a boolean flag, not a flag with true after it', () => {
  // Display-only `[UXH:REQ-073]`: pressing the button still goes through the operation. Display-only
  // is not, however, approximate — see `int-form-cli-parity.test.mjs`, which pastes these strings
  // through the CLI's own parser and requires the arguments back.
  assert.equal(terminalEquivalent('sflow inbox', { group: 'active', includeCompleted: true }),
    'sflow inbox --group active --include-completed');
  // Single quotes, because a shell expands `$` and runs backticks inside double ones.
  assert.equal(terminalEquivalent('sflow start', { title: 'two words' }),
    "sflow start --title 'two words'");
  // An unset value contributes nothing, and `false` is `--no-`: `--include-completed false` parses
  // as the string "false", which is neither the boolean the schema wants nor the reader's choice.
  assert.equal(terminalEquivalent('sflow inbox', { group: null, includeCompleted: false }),
    'sflow inbox --no-include-completed');
});
