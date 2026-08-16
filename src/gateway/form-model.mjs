/**
 * A form, derived from the operation's own argument schema. `[UXH:REQ-070]`–`[UXH:REQ-076]`
 *
 * The registered schema is the source of truth and this reads it — 25 bespoke panels exist because
 * every journey step hand-wrote its fields, which is 25 places for a form to drift from the
 * operation it submits to. A field the schema does not declare cannot be rendered here, and a field
 * it declares cannot be forgotten.
 *
 * ## Local validation is a courtesy, never an authority
 *
 * `[UXH:REQ-071]`: this validates for immediate feedback and the operation validates for real. The
 * two are deliberately different code paths reading one declaration — if the form were the
 * authority, a client that skipped it would skip the check, and if the form silently accepted what
 * the operation rejects the reader learns their mistake after committing to it.
 *
 * ## Typed confirmations
 *
 * `[UXH:AC-004]` requires a ceremony field to be empty after open, back/forward, refresh, reload
 * *and* draft restoration. That is a property of the field, so it is decided here rather than left
 * to each renderer to remember: a confirmation field carries `persist: false` and `value: null`,
 * and `restoreDraft` refuses to fill it. A pre-filled confirmation looks identical to a placeholder
 * in a screenshot and defeats the ceremony entirely.
 */
import { ARGUMENT_SCHEMAS, validateArguments } from './argument-schemas.mjs';

/**
 * How each declared type is asked for.
 *
 * A mapping rather than a guess: `text` and `string` differ only in length in the schema, and only
 * a renderer knows that one wants a textarea. Anything unmapped is refused rather than rendered as
 * a plain box, because a field nobody designed an input for is a field nobody thought about.
 */
const CONTROLS = Object.freeze({
  boolean: 'checkbox',
  integer: 'number',
  string: 'line',
  text: 'multiline',
  enum: 'choice',
  identifier: 'line',
  ref: 'line',
  /**
   * Two path types, two different pickers `[UXH:REQ-070]`.
   *
   * `relative-path` is inside the repository and gets the workspace-relative picker the spec asks
   * for; `filesystem-path` is a location on this machine — where a workspace is about to be
   * materialised — and is the only field here that may point outside it. Giving them one control
   * would either confine a materialise target to the repository or offer the whole disk for a file
   * that must live under it, and the second is the direction that matters.
   */
  'relative-path': 'workspace-path',
  'filesystem-path': 'machine-path'
});

/**
 * Fields whose *name* makes them a ceremony, regardless of type.
 *
 * Named here rather than flagged in the schema because the schema is the operation's contract and
 * this is a presentation rule — but it is a presentation rule with a safety consequence, so it is
 * one list rather than a convention each panel follows.
 */
const CEREMONY_FIELDS = Object.freeze(['confirm', 'confirmation', 'acknowledge', 'acknowledgement']);

const isCeremony = (name) => CEREMONY_FIELDS.includes(name);

function schemaFor(schemaId) {
  const found = ARGUMENT_SCHEMAS.find((entry) => entry.id === schemaId);
  if (!found) return null;
  return found;
}

/**
 * Build the field list a renderer walks.
 *
 * Required fields first, then optional, each group in declaration order. Declaration order carries
 * the author's sense of what depends on what; sorting alphabetically would discard it, and sorting
 * by type would group a form by implementation detail.
 */
export function formModel(schemaId, { defaults = {} } = {}) {
  const schema = schemaFor(schemaId);
  if (!schema) return null;

  const entries = Object.entries(schema.fields ?? {});
  const fields = entries.map(([name, spec]) => {
    const control = CONTROLS[spec.type] ?? null;
    const ceremony = isCeremony(name);
    return Object.freeze({
      name,
      type: spec.type,
      control,
      required: spec.required === true,
      /** The enumeration a choice is drawn from, and null when the type is not a choice. */
      values: spec.type === 'enum' ? Object.freeze([...(spec.values ?? [])]) : null,
      ceremony,
      /**
       * A ceremony field is never pre-filled and never remembered `[UXH:AC-004]` `[UXH:REQ-072]`.
       *
       * Both halves matter and they fail differently: a default defeats the ceremony on first open,
       * and persistence defeats it on every open after a refresh.
       */
      value: ceremony ? null : (defaults[name] ?? null),
      persist: !ceremony,
      /** A field whose type has no designed input is reported, not rendered as a plain box. */
      renderable: Boolean(control)
    });
  });

  return Object.freeze({
    schemaId,
    fields: Object.freeze([
      ...fields.filter((field) => field.required),
      ...fields.filter((field) => !field.required)
    ]),
    /** Types this build has no input for. Empty is the expected state; non-empty is a gap to close. */
    unrenderable: Object.freeze(fields.filter((field) => !field.renderable).map((field) => field.name))
  });
}

/**
 * Check a filled form the way the operation will, and report rather than throw.
 *
 * `validateArguments` is the authority and it throws — right for an operation boundary, wrong for a
 * keystroke. This runs the same declaration and turns the refusal into something a form can render
 * beside the offending field, so local feedback and real validation cannot disagree about what is
 * valid: there is one implementation of that, and this is not it.
 */
export function checkForm(schemaId, values) {
  const schema = schemaFor(schemaId);
  if (!schema) return { valid: false, problems: [{ field: null, code: 'form.unknown-schema', detail: schemaId }] };

  const problems = [];
  for (const [name, spec] of Object.entries(schema.fields ?? {})) {
    const value = values?.[name];
    const absent = value === undefined || value === null || value === '';
    if (spec.required && absent) problems.push({ field: name, code: 'form.required', detail: null });
  }
  if (problems.length) return { valid: false, problems };

  try {
    // Absent optionals are omitted rather than sent as null: the schema is closed, and a null for a
    // field the caller did not fill is a value they did not choose.
    const supplied = Object.fromEntries(Object.entries(values ?? {})
      .filter(([, value]) => value !== undefined && value !== null && value !== ''));
    validateArguments(schemaId, supplied);
    return { valid: true, problems: [] };
  } catch (error) {
    return {
      valid: false,
      problems: [{
        field: error?.details?.field ?? null,
        code: 'form.invalid',
        detail: error?.message ?? null
      }]
    };
  }
}

/**
 * Restore a saved draft, minus anything a draft may not hold. `[UXH:REQ-074]` `[UXH:AC-004]`
 *
 * The filter is the whole function. A draft is written by one version of a form and read by
 * another, so it is treated as untrusted input twice over: fields the schema no longer declares are
 * dropped, and ceremony fields are dropped whatever the draft says — the draft is exactly the
 * mechanism `[UXH:AC-004]` names when it requires a typed confirmation to be empty after
 * restoration.
 */
export function restoreDraft(schemaId, draft) {
  const model = formModel(schemaId);
  if (!model || !draft || typeof draft !== 'object') return {};
  const restored = {};
  for (const field of model.fields) {
    if (!field.persist) continue;
    const value = draft[field.name];
    if (value !== undefined && value !== null && value !== '') restored[field.name] = value;
  }
  return restored;
}

/**
 * The command a reader could type instead. `[UXH:REQ-073]`
 *
 * Display-only, and the comment matters more than the code: pressing the button still goes through
 * the registered operation and typed arguments. A form that offered this as the way to act would be
 * the second dispatch path the shell exists to remove.
 */
export function terminalEquivalent(command, values) {
  const parts = [command];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    const flag = `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    // A boolean is a flag, not a flag with `true` after it.
    parts.push(value === true ? flag : `${flag} ${/\s/.test(String(value)) ? JSON.stringify(String(value)) : value}`);
  }
  return parts.join(' ');
}
