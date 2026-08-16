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

/**
 * Fields a draft may never hold, for a different reason than ceremony.
 *
 * `[UXH:REQ-074]` says "never store secrets *or* confirmation text", and the two are separate
 * hazards: a persisted ceremony defeats a safety design, a persisted secret leaks. No registered
 * schema declares one of these today, which is exactly when the rule is cheap to write and exactly
 * why it would otherwise be written after the first schema that does.
 */
const SENSITIVE_FIELDS = Object.freeze(['token', 'secret', 'password', 'passphrase', 'apiKey', 'credential']);

const isCeremony = (name) => CEREMONY_FIELDS.includes(name);
const isSensitive = (name) => SENSITIVE_FIELDS.some((sensitive) => name.toLowerCase().includes(sensitive.toLowerCase()));

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
      /**
       * What the field is called on screen, as opposed to on the wire.
       *
       * The first rendered form showed `baseRef`, `targetRef` and `includeWorktree` — the argument
       * names, in front of a reader who is not writing a call. Derived rather than listed, so a new
       * schema field gets a readable label without anyone remembering to add one, and `spec.label`
       * wins when a name genuinely does not humanise (an acronym, a term of art).
       */
      label: spec.label ?? name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/^./, (letter) => letter.toUpperCase())
        .toLowerCase()
        .replace(/^./, (letter) => letter.toUpperCase()),
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
      persist: !ceremony && !isSensitive(name),
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
 * A field's flag, and a flag's field. `[UXH:AC-011]`
 *
 * One pair, because they are one fact. The schemas are camelCase and closed, `parseArgs` yields
 * whatever the flag spelled, and nothing in between translated — so the "terminal equivalent" a
 * form displayed was, if typed, an argument bag naming fields no schema declares. Not a difference
 * a reader could see, and precisely the one `[UXH:AC-011]` exists to rule out.
 */
export const flagFor = (field) => `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
export const fieldFor = (flag) => flag.replace(/^--?(no-)?/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/**
 * Quote a value the way a shell reads it back. `[UXH:REQ-073]` `[UXH:AC-011]`
 *
 * `JSON.stringify` was the obvious choice and the wrong one: inside double quotes a shell still
 * expands `$HOME` and still runs a backtick, so a displayed `--summary "$HOME/notes"` is a command
 * that submits something other than what the form would have. Single quotes suspend all of it, and
 * the `'\''` dance is how a literal quote gets through them.
 */
function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._/@:=,+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * Give a form's strings the types the schema declares. `[UXH:AC-011]`
 *
 * An HTML control has one output type and the schema has nine. `<input type="number">` hands back
 * `"12"`, and `integer` requires `Number.isInteger` — so a form that submitted what the DOM gave it
 * would be refused where the identical CLI invocation succeeds. That is the parity break, and it is
 * the form's to fix: the operation must not learn to accept `"12"`, because then every caller may
 * send it.
 *
 * **Only the unambiguous conversions.** `"abc"` for an integer stays `"abc"` rather than becoming
 * `NaN`, so the authority refuses it by name instead of the form quietly inventing a value nobody
 * typed. Coercion narrows the *representation*; it must never decide the *meaning*.
 */
export function coerceForm(schemaId, values) {
  const schema = schemaFor(schemaId);
  if (!schema) return { ...(values ?? {}) };
  const coerced = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    const type = schema.fields?.[name]?.type;
    if (type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
      coerced[name] = Number(value.trim());
    } else if (type === 'boolean' && (value === 'true' || value === 'false')) {
      coerced[name] = value === 'true';
    } else {
      coerced[name] = value;
    }
  }
  return coerced;
}

/**
 * The other direction: parsed CLI options to operation arguments. `[UXH:AC-011]`
 *
 * Deliberately the same `coerceForm` the button goes through rather than a second conversion, so
 * the two paths cannot drift into disagreeing about what `--line-start 12` means. `parseArgs` gives
 * booleans for bare and `--no-` flags and strings for everything else, which is exactly the shape a
 * form produces — the two callers differ only in how they spell the names.
 */
export function argumentsFromFlags(schemaId, options) {
  const named = {};
  for (const [flag, value] of Object.entries(options ?? {})) {
    // A repeated flag arrives as an array. No schema declares a list, so it is left as-is for the
    // authority to refuse rather than silently reduced to its last occurrence.
    named[fieldFor(flag)] = value;
  }
  return coerceForm(schemaId, named);
}

/**
 * Check a filled form the way the operation will, and report rather than throw.
 *
 * `validateArguments` is the authority and it throws — right for an operation boundary, wrong for a
 * keystroke. This runs the same declaration and turns the refusal into something a form can render
 * beside the offending field, so local feedback and real validation cannot disagree about what is
 * valid: there is one implementation of that, and this is not it.
 */
export function checkForm(schemaId, rawValues) {
  const schema = schemaFor(schemaId);
  if (!schema) return { valid: false, problems: [{ field: null, code: 'form.unknown-schema', detail: schemaId }] };

  // Checked in the types the operation will see, not the types the DOM produced. Validating the
  // strings would report a problem the operation does not have, or miss one it does.
  const values = coerceForm(schemaId, rawValues);

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
 * What a draft is written as, so a stale one can be recognised rather than half-applied.
 * `[UXH:REQ-074]`
 *
 * The version has two parts and they fail differently. `DRAFT_VERSION` moves when the *envelope*
 * changes, which no amount of schema reading would detect; the fingerprint moves when the schema's
 * own fields change, which no envelope version would detect because the envelope did not change.
 *
 * The fingerprint covers names *and* types: a draft holding `lineStart: "top"` for a field that was
 * a string yesterday and is an integer today is not a value the form should offer back. Field order
 * is sorted out of it, because reordering a schema does not invalidate anything a reader typed.
 */
export const DRAFT_VERSION = 1;

export function schemaFingerprint(schemaId) {
  const schema = schemaFor(schemaId);
  if (!schema) return null;
  return Object.entries(schema.fields ?? {})
    .map(([name, spec]) => `${name}:${spec.type}`)
    .sort()
    .join(',');
}

/**
 * The record to persist, already stripped of everything a draft may not hold.
 *
 * Filtered on write as well as on read. Once a confirmation reaches storage the rule has already
 * been broken — a later reader declining to restore it does not unwrite it, and the storage is a
 * plain workspace state file someone can open.
 */
export function draftRecord(schemaId, values) {
  const model = formModel(schemaId);
  if (!model) return null;
  const kept = {};
  for (const field of model.fields) {
    if (!field.persist) continue;
    const value = values?.[field.name];
    if (value !== undefined && value !== null && value !== '') kept[field.name] = value;
  }
  return { version: DRAFT_VERSION, schemaId, fingerprint: schemaFingerprint(schemaId), values: kept };
}

/**
 * Read a persisted record, and discard rather than salvage. `[UXH:REQ-074]`
 *
 * "Discard incompatible values safely" is a instruction about *doubt*: a record whose envelope or
 * schema has moved is not partially trustworthy, and restoring the fields that happen to still
 * match would hand back a form filled from two different schemas with nothing on screen to say so.
 */
export function readDraft(schemaId, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  if (record.version !== DRAFT_VERSION) return {};
  if (record.schemaId !== schemaId) return {};
  if (record.fingerprint !== schemaFingerprint(schemaId)) return {};
  return restoreDraft(schemaId, record.values);
}

/**
 * The command a reader could type instead. `[UXH:REQ-073]`
 *
 * Display-only, and the comment matters more than the code: pressing the button still goes through
 * the registered operation and typed arguments. A form that offered this as the way to act would be
 * the second dispatch path the shell exists to remove.
 *
 * Display-only does not mean approximate. `[UXH:AC-011]` requires the two to produce identical
 * arguments, and this is shown to a reader as the thing they could have typed instead — so it is
 * round-tripped against the real `parseArgs` in the parity suite rather than merely inspected.
 */
export function terminalEquivalent(command, values) {
  const parts = [command];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    const flag = flagFor(name);
    // A boolean is a flag, not a flag with a word after it. `--x false` parses as the *string*
    // "false", which is neither false nor what the reader chose; `--no-x` is how the parser spells
    // it, so that is what the equivalent says.
    if (value === true) parts.push(flag);
    else if (value === false) parts.push(`--no-${flag.slice(2)}`);
    else parts.push(`${flag} ${shellQuote(value)}`);
  }
  return parts.join(' ');
}
