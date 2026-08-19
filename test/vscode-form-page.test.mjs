/**
 * The form renderer, and the one rule that has to survive it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARGUMENT_SCHEMAS } from '../src/gateway/argument-schemas.mjs';
import { formModel, terminalEquivalent } from '../src/gateway/form-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { FORM_STYLE, formHtml } = await import(path.join(root, 'apps', 'vscode', 'src', 'views', 'form-page.ts'));

test('a confirmation renders as a placeholder and never as a value', () => {
  /**
   * `[UXH:AC-004]`, checked in the markup because that is where it fails. A `value="PAY-1187"` and
   * a `placeholder="PAY-1187"` are indistinguishable in a screenshot, and one of them turns a
   * deliberate act into a click.
   */
  const view = {
    schemaId: 'test-v1',
    unrenderable: [],
    fields: [{
      name: 'confirm', type: 'string', control: 'line', required: true, values: null,
      ceremony: true, value: 'PAY-1187', persist: false, renderable: true
    }]
  };
  const html = formHtml(view);
  assert.match(html, /placeholder="PAY-1187"/);
  assert.ok(!/value="PAY-1187"/.test(html), 'a pre-filled confirmation is not a confirmation');
  // The browser must not do what the draft layer is forbidden from doing.
  assert.match(html, /autocomplete="off"/);
  assert.match(html, /data-no-draft/);
});

test('an ordinary field keeps its value, so the rule is about ceremony and not about caution', () => {
  const view = {
    schemaId: 'test-v1',
    unrenderable: [],
    fields: [{
      name: 'title', type: 'string', control: 'line', required: false, values: null,
      ceremony: false, value: 'Existing title', persist: true, renderable: true
    }]
  };
  assert.match(formHtml(view), /value="Existing title"/);
});

test('an opaque cursor uses a line control without browser or draft persistence', () => {
  const view = formModel('ast-context-v2', { defaults: { cursor: `astp_eA.${'a'.repeat(64)}` } });
  const html = formHtml(view);
  assert.match(html, /name="cursor"/);
  assert.match(html, /name="cursor"[^>]*autocomplete="off"[^>]*data-no-draft/);
});

test('the two path controls say which one may leave the repository', () => {
  /**
   * `[UXH:REQ-070]` and `[UXH:REQ-065]`. The difference is invisible in a text box, and only one of
   * them can point outside the project.
   */
  const field = (control) => ({
    schemaId: 'test-v1', unrenderable: [],
    fields: [{ name: 'p', type: 'x', control, required: true, values: null, ceremony: false, value: null, persist: true, renderable: true }]
  });
  assert.match(formHtml(field('workspace-path')), /A path inside this repository/);
  assert.match(formHtml(field('machine-path')), /may point outside the repository/);
});

test('a partial form says so rather than submitting fewer arguments', () => {
  // Otherwise the operation refuses it and the reader has no clue why.
  const html = formHtml({ schemaId: 'test-v1', unrenderable: ['targetPath'], fields: [] },
    { terminal: 'sflow workspace materialize --target-path ...' });
  assert.match(html, /no input for: targetPath/);
  assert.match(html, /Terminal equivalent/);
});

test('a real schema renders every field it declares', () => {
  const view = formModel('work-list-v1');
  const html = formHtml(view, { terminal: terminalEquivalent('sflow inbox', {}) });
  for (const field of view.fields) {
    assert.match(html, new RegExp(`name="${field.name}"`), `${field.name} is missing from the markup`);
  }
  // A choice renders its enumeration rather than a free-text box.
  assert.match(html, /<select /);
});

test('every registered schema renders without an unmapped control', () => {
  /**
   * The end-to-end version of the model's completeness check: a type with no case here falls to the
   * default text box, which is the "field nobody thought about" the model test exists to prevent.
   */
  const defaulted = [];
  for (const schema of ARGUMENT_SCHEMAS) {
    const view = formModel(schema.id);
    if (!view.fields.length) continue;
    for (const field of view.fields) {
      if (!['checkbox', 'number', 'multiline', 'choice', 'line', 'workspace-path', 'machine-path'].includes(field.control)) {
        defaulted.push(`${schema.id}.${field.name}: ${field.control}`);
      }
    }
  }
  assert.deepEqual(defaulted, [], `controls with no designed input:\n  ${defaulted.join('\n  ')}`);
});

test('a required field is marked for sighted and assistive readers alike', () => {
  const view = formModel('work-subject-v1');
  const html = formHtml(view);
  // The asterisk is decoration; `required` is the fact.
  assert.match(html, /required/);
  assert.match(html, /class="sf-required" aria-hidden="true"/);
});

test('the stylesheet leaves the input colours to the theme', () => {
  // A form that hardcodes its own input background is unreadable in half the themes people use.
  assert.match(FORM_STYLE, /var\(--vscode-input-background\)/);
  assert.ok(!/#[0-9a-fA-F]{3,6}/.test(FORM_STYLE), 'no literal colours');
});
