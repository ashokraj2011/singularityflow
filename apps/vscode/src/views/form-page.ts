/**
 * One renderer for every schema-driven form. `[UXH:REQ-070]`–`[UXH:REQ-076]`
 *
 * The model decided what the fields are; this decides only how they are asked for. Keeping the two
 * apart is what lets the interesting rules be tested without a webview — and the interesting rule
 * here is a rendering one, so it is worth stating where it lives.
 *
 * ## The confirmation field
 *
 * `[UXH:AC-004]` requires a typed confirmation to be empty after open, back/forward, refresh,
 * reload and draft restoration. The model refuses to give one a value; this refuses to write one
 * into the markup. Both are needed, because the failure is a `value="PAY-1187"` that looks exactly
 * like a `placeholder="PAY-1187"` in a screenshot and quietly turns a deliberate act into a click.
 *
 * `autocomplete="off"` and `data-no-draft` are the other half: a browser that remembers the field
 * across a reload defeats the ceremony just as thoroughly as a default would, and the draft layer
 * needs a marker it can see without knowing which schema it is restoring.
 */
import { escape } from './webview.ts';

/** The shape `formModel()` returns. Declared here so the page can be typed against the model. */
export type FormField = {
  readonly name: string;
  /** What the field is called on screen. The `name` is what goes on the wire. */
  readonly label: string;
  readonly type: string;
  readonly control: string | null;
  readonly required: boolean;
  readonly values: readonly string[] | null;
  readonly ceremony: boolean;
  readonly value: string | number | boolean | null;
  readonly persist: boolean;
  readonly renderable: boolean;
};

export type FormView = {
  readonly schemaId: string;
  readonly fields: readonly FormField[];
  readonly unrenderable: readonly string[];
};

export const FORM_STYLE = `
.sf-form { display: flex; flex-direction: column; gap: 14px; }
.sf-field { display: flex; flex-direction: column; gap: 4px; }
.sf-field label { font-weight: 600; }
.sf-field .sf-hint { color: var(--vscode-descriptionForeground); font-size: .92em; }
.sf-field input, .sf-field textarea, .sf-field select { font: inherit; padding: 5px 8px; border-radius: 3px;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); }
.sf-field textarea { min-height: 6em; resize: vertical; }
.sf-field-checkbox { flex-direction: row; align-items: center; gap: 8px; }
.sf-field-checkbox label { font-weight: 400; }
.sf-required { color: var(--vscode-editorWarning-foreground); margin-left: 3px; }
.sf-ceremony { border-left: 3px solid var(--vscode-editorWarning-foreground); padding-left: 10px; }
.sf-form-problem { color: var(--vscode-editorError-foreground); font-size: .92em; }
.sf-form-gap { color: var(--vscode-descriptionForeground); font-style: italic; }
.sf-terminal { color: var(--vscode-descriptionForeground); }
.sf-terminal pre { margin: 6px 0 0; padding: 8px; overflow-x: auto; user-select: text;
  background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
`;

const id = (schemaId: string, name: string) => `sf-${schemaId}-${name}`;

/**
 * A field's input.
 *
 * The ceremony branch is separate and first, so the rule cannot be lost in a shared code path that
 * someone later adds a `value` to.
 */
function control(schemaId: string, field: FormField, problem: string | null): string {
  const fieldId = id(schemaId, field.name);
  const label = `<label for="${escape(fieldId)}">${escape(field.label ?? field.name)}${
    field.required ? '<span class="sf-required" aria-hidden="true">*</span>' : ''}</label>`;
  const note = problem ? `<p class="sf-form-problem">${escape(problem)}</p>` : '';
  const common = `id="${escape(fieldId)}" name="${escape(field.name)}"${field.required ? ' required' : ''}`;

  if (field.ceremony) {
    /**
     * Placeholder, never value `[UXH:AC-004]`.
     *
     * `data-no-draft` is what the draft layer reads; `autocomplete="off"` is what stops the browser
     * doing the same thing the draft layer is forbidden from doing.
     */
    return `<div class="sf-field sf-ceremony">${label}
      <input type="text" ${common} autocomplete="off" spellcheck="false" data-no-draft
        placeholder="${escape(String(field.value ?? ''))}">
      <p class="sf-hint">Type this exactly. It is never filled in for you and never remembered.</p>
      ${note}</div>`;
  }

  const value = field.value === null || field.value === undefined ? '' : String(field.value);

  switch (field.control) {
    case 'checkbox':
      return `<div class="sf-field sf-field-checkbox">
        <input type="checkbox" ${common}${field.value === true ? ' checked' : ''}>${label}${note}</div>`;
    case 'number':
      return `<div class="sf-field">${label}
        <input type="number" ${common} value="${escape(value)}">${note}</div>`;
    case 'multiline':
      return `<div class="sf-field">${label}
        <textarea ${common}>${escape(value)}</textarea>${note}</div>`;
    case 'choice':
      return `<div class="sf-field">${label}
        <select ${common}>${!field.required ? '<option value=""></option>' : ''}${
        (field.values ?? []).map((option) => `<option value="${escape(option)}"${
          option === value ? ' selected' : ''}>${escape(option)}</option>`).join('')}</select>${note}</div>`;
    case 'workspace-path':
    case 'machine-path':
      /**
       * Two pickers, and the hint says which. `[UXH:REQ-070]` `[UXH:REQ-065]`
       *
       * A field that may point outside the repository says so, because the difference between the
       * two is invisible in a text box and only one of them can leave the project.
       */
      return `<div class="sf-field">${label}
        <input type="text" ${common} value="${escape(value)}" data-picker="${escape(field.control)}">
        <p class="sf-hint">${field.control === 'workspace-path'
        ? 'A path inside this repository.'
        : 'A location on this machine. This is the one field that may point outside the repository.'}</p>
        ${note}</div>`;
    default:
      return `<div class="sf-field">${label}
        <input type="text" ${common} value="${escape(value)}"${field.persist ? '' : ' autocomplete="off" data-no-draft'}>${note}</div>`;
  }
}

/**
 * Render a form, and say plainly when it cannot render all of it.
 *
 * A schema with an unmapped type produces a *partial* form, which would otherwise submit fewer
 * arguments than the caller intended and be refused by the operation with no clue why. The gap is
 * named where the missing field would have been.
 */
export function formHtml(view: FormView, {
  problems = {}, terminal = null
}: { problems?: Record<string, string>; terminal?: string | null } = {}): string {
  const fields = view.fields.filter((field) => field.renderable)
    .map((field) => control(view.schemaId, field, problems[field.name] ?? null)).join('');

  const gap = view.unrenderable.length
    ? `<p class="sf-form-gap">${escape(
      `This build has no input for: ${view.unrenderable.join(', ')}. Use the terminal equivalent below.`)}</p>`
    : '';

  /**
   * The terminal equivalent, collapsed. `[UXH:REQ-073]`
   *
   * Display-only, and doubly useful when the form is partial: it is the complete way to do what a
   * partial form cannot.
   */
  const equivalent = terminal
    ? `<details class="sf-terminal"><summary>Terminal equivalent</summary><pre data-terminal>${
      escape(terminal)}</pre></details>`
    : '';

  return `<form class="sf-form" data-schema="${escape(view.schemaId)}">${fields}${gap}${equivalent}</form>`;
}
