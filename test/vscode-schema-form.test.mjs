/**
 * Forms built from the registered argument schemas. `[UXH:REQ-070]`–`[UXH:AC-011]` `[UXH:AC-004]`
 *
 * Fixtures come from `ARGUMENT_SCHEMAS` itself rather than hand-written shapes: the whole point of
 * this model is that the form and the kernel read one declaration, and a test against a fixture of
 * my own would be a third opinion about the same contract.
 *
 * The AC-004 tests are the ones that matter. A pre-filled confirmation looks identical to an empty
 * one in a screenshot, so the property has to be asserted rather than reviewed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARGUMENT_SCHEMAS } from '../src/gateway/argument-schemas.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const { confirmationMatches, formValues, schemaForm } = await import(view('schema-form-model.ts'));

const schemaFor = (id) => ARGUMENT_SCHEMAS.find((entry) => entry.id === id);

test('every registered schema produces a renderable form', () => {
  /**
   * The parity property, at its cheapest. A schema this model cannot turn into a form is an
   * operation the generic renderer would silently be unable to offer — which is how a "generic"
   * renderer ends up with bespoke panels beside it again.
   */
  for (const schema of ARGUMENT_SCHEMAS) {
    const form = schemaForm(schema);
    assert.equal(form.schemaId, schema.id);
    assert.equal(form.fields.length, Object.keys(schema.fields).length, `${schema.id} lost a field`);
    for (const field of form.fields) {
      assert.ok(field.control, `${schema.id}.${field.name} has no control`);
      if (field.control === 'select') {
        assert.ok(field.options.length, `${schema.id}.${field.name} is a select with no options`);
      }
    }
  }
});

test('a field takes its control and its requiredness from the schema, not from a panel', () => {
  const form = schemaForm(schemaFor('work-start-intake-v1'));
  const byName = Object.fromEntries(form.fields.map((field) => [field.name, field]));

  assert.equal(byName.source.control, 'select');
  assert.deepEqual([...byName.source.options], [
    'jira', 'github-issue', 'manual', 'initiative', 'story', 'bug-report', 'idea',
    'repository-observation', 'finding'
  ], 'the enum values are the schema’s own, in its order');
  assert.equal(byName.summary.control, 'multiline', 'a `text` field is where someone writes a paragraph');
  assert.equal(byName.workspaceId.control, 'text');
  assert.equal(byName.workspaceId.required, false);

  const subject = schemaForm(schemaFor('work-subject-v1'));
  assert.equal(subject.fields[0].required, true, 'a required field says so');
});

test('a schema with no arguments is a confirm, not a form', () => {
  const form = schemaForm(schemaFor('no-arguments-v1'));
  assert.equal(form.empty, true);
  assert.deepEqual([...form.fields], []);
});

test('the two path types share a control and never share a hint', () => {
  /**
   * `relative-path` is refused if it is absolute; `filesystem-path` is refused if it traverses.
   * A reader deserves to know which rule they are under before they type, not after.
   */
  const materialize = schemaForm(schemaFor('workspace-materialize-v1'));
  const target = materialize.fields.find((field) => field.name === 'targetPath');
  assert.equal(target.control, 'path');
  assert.match(target.hint, /this machine/);
  assert.doesNotMatch(target.hint, /repository/);
});

test('a confirmation field starts empty, is required, and is never restored', () => {
  /**
   * `[UXH:AC-004]`, the trap that is invisible in review: the greyed example must be a placeholder
   * and never a value, because a pre-filled confirmation is confirmed by pressing rather than by
   * typing — and looks identical in a screenshot either way.
   */
  const form = schemaForm(schemaFor('work-subject-v1'), {
    confirmationField: 'workId', confirmationExample: 'PAY-1187'
  });
  const field = form.fields[0];

  assert.equal(field.control, 'confirmation');
  assert.equal(field.required, true, 'a ceremony is never optional');
  assert.equal(field.placeholder, 'PAY-1187', 'the example is the placeholder');
  assert.equal(field.restorable, false,
    'draft restore would mean the second open is confirmed by the first open’s keystrokes');
  assert.ok(!('value' in field), 'the model carries no value for a confirmation to be pre-filled from');
});

test('a confirmation matches exactly, and every softening is refused', () => {
  assert.equal(confirmationMatches('PAY-1187', 'PAY-1187'), true);
  assert.equal(confirmationMatches('PAY-1187', ' PAY-1187 '), false, 'not trimmed');
  assert.equal(confirmationMatches('PAY-1187', 'pay-1187'), false, 'not case-folded');
  assert.equal(confirmationMatches('PAY-1187', 'PAY-118'), false, 'not a prefix');
  assert.equal(confirmationMatches('PAY-1187', ''), false);
  assert.equal(confirmationMatches(null, ''), false, 'nothing to confirm is not a passed confirmation');
  assert.equal(confirmationMatches('', ''), false);
});

test('values are read only for fields the schema declares', () => {
  const form = schemaForm(schemaFor('work-list-v1'));
  const values = formValues(form, {
    type: 'submit', group: 'active', includeCompleted: true,
    // Not in the schema. A page naming it is naming a field the operation does not have.
    workId: 'PAY-1187', includeSecrets: true
  });

  assert.deepEqual(values, { group: 'active', includeCompleted: true });
  assert.equal('workId' in values, false, 'the page does not get to decide what is sent');
});

test('a checkbox is true only when it is true', () => {
  const form = schemaForm(schemaFor('work-list-v1'));
  assert.deepEqual(formValues(form, { includeCompleted: 'yes' }), {}, 'a truthy string is not true');
  assert.deepEqual(formValues(form, { includeCompleted: false }), {});
  assert.deepEqual(formValues(form, { includeCompleted: true }), { includeCompleted: true });
});
