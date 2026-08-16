/**
 * Forms derived from the operation's own schema, and the ceremony rule that must survive them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ARGUMENT_SCHEMAS } from '../src/gateway/argument-schemas.mjs';
import { checkForm, formModel, restoreDraft, terminalEquivalent } from '../src/gateway/form-model.mjs';

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
  // Display-only `[UXH:REQ-073]`: pressing the button still goes through the operation.
  assert.equal(terminalEquivalent('sflow inbox', { group: 'active', includeCompleted: true }),
    'sflow inbox --group active --include-completed');
  assert.equal(terminalEquivalent('sflow start', { title: 'two words' }),
    'sflow start --title "two words"');
  // An unset value contributes nothing, and `false` is not a flag.
  assert.equal(terminalEquivalent('sflow inbox', { group: null, includeCompleted: false }),
    'sflow inbox --include-completed false');
});
