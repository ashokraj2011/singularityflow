/**
 * A registered argument schema, turned into a form a panel can render. `[UXH:REQ-070]`–`[UXH:AC-011]`
 *
 * The shell has twenty-five bespoke forms — `intake-form.ts` is 513 lines, `workspace-form.ts` 445 —
 * each hand-writing the same field markup against its own idea of what the operation accepts. The
 * kernel already holds that answer: `src/gateway/argument-schemas.mjs` declares every operation's
 * arguments, their types, and which are required, and it is what the kernel validates against. A
 * form built from anything else is a second opinion about the same contract, and the two drift in
 * the direction that lets a panel offer a field the operation will reject.
 *
 * Pure, and separated from the HTML for the reason every `*-model` / `*-page` pair here is: the
 * decisions are testable without a webview, and the page is left with nothing to decide.
 *
 * ## What this deliberately does not do
 *
 * It does not validate. `argument-schemas.mjs` validates, at the kernel boundary, and a second
 * implementation on this side would be a copy to keep level with the first — the drift this exists
 * to remove. What a field knows here is enough to *render* it: its control, whether it is required,
 * and what a legal value looks like. The answer to "is this value acceptable" comes from resolving
 * it, which is where a refusal can be rendered as a card.
 */
import type { InboundMessage } from './messages.ts';

/** The control a field is drawn as. Derived from the schema's type, never chosen per panel. */
export type FieldControl = 'text' | 'multiline' | 'select' | 'checkbox' | 'path' | 'confirmation';

export type FormField = {
  readonly name: string;
  readonly control: FieldControl;
  readonly required: boolean;
  /** Present only for `select`; the schema's own enum values, in the order it declares them. */
  readonly options: readonly string[];
  /**
   * The greyed example, and never a value. `[UXH:AC-004]`
   *
   * Rendered into the `placeholder` attribute. A pre-filled `value` looks identical in a screenshot
   * and silently defeats a ceremony, because the reader confirms by pressing rather than by typing.
   * A `confirmation` field therefore carries the example it wants typed back and starts empty.
   */
  readonly placeholder: string | null;
  /** `confirmation` fields are never restored from a draft — see `restorable`. */
  readonly restorable: boolean;
  readonly hint: string | null;
};

export type SchemaForm = {
  readonly schemaId: string;
  readonly fields: readonly FormField[];
  /** True when the schema declares nothing; a form with no fields is a confirm, not a form. */
  readonly empty: boolean;
};

/**
 * One control per schema type, decided here and only here.
 *
 * `text` is multiline because the schema's `text` type is what carries a summary or description; a
 * single-line box for it is the difference between someone writing a sentence and someone writing a
 * paragraph. `relative-path` and `filesystem-path` share a control but not a hint — one is refused
 * if it is absolute, the other is refused if it traverses, and a reader deserves to be told which
 * before they type rather than after.
 */
const CONTROLS: Readonly<Record<string, FieldControl>> = Object.freeze({
  string: 'text',
  identifier: 'text',
  text: 'multiline',
  enum: 'select',
  boolean: 'checkbox',
  'opaque-cursor': 'text',
  'context-handle': 'text',
  'relative-path': 'path',
  'filesystem-path': 'path'
});

const HINTS: Readonly<Record<string, string>> = Object.freeze({
  identifier: 'Letters, digits, dots and dashes.',
  'opaque-cursor': 'A sealed continuation emitted by a prior bounded read.',
  'context-handle': 'A sealed context expansion emitted by a prior Evidence Packet.',
  'relative-path': 'Relative to the repository. Not an absolute path, and no “..” segments.',
  'filesystem-path': 'A location on this machine. No “..” segments.'
});

/**
 * Build the form for one schema.
 *
 * `confirmation` is not a schema type and never will be: a typed confirmation is a property of the
 * *operation* — an authorization asks for it, a read does not — so the caller names which field
 * carries it. That keeps `argument-schemas.mjs` describing arguments rather than ceremony.
 */
export function schemaForm(schema: { id: string; fields: Record<string, { type: string; required?: boolean; values?: readonly string[] }> },
  { confirmationField = null, confirmationExample = null }: {
    confirmationField?: string | null; confirmationExample?: string | null;
  } = {}): SchemaForm {
  const fields = Object.entries(schema.fields ?? {}).map(([name, spec]) => {
    const isConfirmation = name === confirmationField;
    const control: FieldControl = isConfirmation ? 'confirmation' : CONTROLS[spec.type] ?? 'text';
    return Object.freeze({
      name,
      control,
      required: Boolean(spec.required) || isConfirmation,
      options: control === 'select' ? Object.freeze([...(spec.values ?? [])]) : Object.freeze([]),
      /**
       * A select has no placeholder — its options are the example — and a checkbox has no text to
       * place. Everything else shows what a legal value looks like without ever holding one.
       */
      placeholder: isConfirmation
        ? confirmationExample
        : control === 'select' || control === 'checkbox' ? null : exampleFor(spec.type),
      /**
       * A confirmation is never restored. `[UXH:AC-004]`
       *
       * Draft restore exists so a form survives a reload without retyping — which is exactly the
       * property a ceremony must not have. Restoring the typed confirmation would mean the second
       * open is confirmed by the first open's keystrokes.
       */
      restorable: !isConfirmation && !['opaque-cursor', 'context-handle'].includes(spec.type),
      hint: isConfirmation ? null : HINTS[spec.type] ?? null
    });
  });
  return Object.freeze({ schemaId: schema.id, fields: Object.freeze(fields), empty: fields.length === 0 });
}

function exampleFor(type: string): string | null {
  if (type === 'identifier') return 'PAY-1187';
  if (type === 'relative-path') return 'singularity/work-items/PAY-1187/intake.md';
  if (type === 'filesystem-path') return '~/code/payments';
  if (type === 'opaque-cursor') return 'astp_…';
  if (type === 'context-handle') return 'ctx_…';
  return null;
}

/**
 * Read a form's values out of a webview message, keyed by field name.
 *
 * Returns only fields the schema declares: a page naming something else is naming a field the
 * operation does not have, and passing it through would let the page decide what gets sent. The
 * kernel would refuse it, which is the right outcome arriving for the wrong reason — the refusal
 * should be about the *value*, not about a field this form never offered.
 */
export function formValues(form: SchemaForm, message: InboundMessage): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const field of form.fields) {
    const raw = (message as Record<string, unknown>)[field.name];
    if (field.control === 'checkbox') {
      if (raw === true) values[field.name] = true;
      continue;
    }
    if (typeof raw === 'string' && raw) values[field.name] = raw;
  }
  return values;
}

/**
 * Whether a typed confirmation matches, exactly. `[UXH:AC-004]` `[INT:CON-113]`
 *
 * Exact, untrimmed, case-sensitive. Every softening of this — trimming, folding case, accepting a
 * prefix — makes the ceremony easier to pass without making it easier to *mean*, which is the only
 * thing it is for.
 */
export function confirmationMatches(expected: string | null, supplied: unknown): boolean {
  return typeof expected === 'string' && expected.length > 0 && supplied === expected;
}
