/**
 * Form and CLI produce the same arguments, or one of them is lying. `[UXH:AC-011]`
 *
 * The requirement is that "generated form submissions and equivalent CLI invocations produce
 * identical registered-operation arguments, validation, effects, result envelopes, and records".
 * Arguments and validation are checked here, at the boundary where they are decided; effects,
 * envelopes and records follow from them because both paths reach the same `validateArguments` and
 * the same planner — there is exactly one call site, `resolve.mjs:349`, and a test that re-ran a
 * planner twice would be asserting that one function is deterministic rather than that two callers
 * agree.
 *
 * The round trip is the point. Rather than restating the name mapping and checking it against
 * itself, this renders the terminal equivalent a reader is shown, parses it with the CLI's own
 * `parseArgs`, and requires what comes back to equal what the button submits. Two bugs were sitting
 * in that gap: a form's `"12"` for an `integer` field, and a `--include-completed` flag that parsed
 * back as a field name no closed schema declares.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/util.mjs';
import { ARGUMENT_SCHEMAS, validateArguments } from '../src/gateway/argument-schemas.mjs';
import {
  argumentsFromFlags, checkForm, coerceForm, fieldFor, flagFor, formModel, terminalEquivalent
} from '../src/gateway/form-model.mjs';

/**
 * A plausible value per declared type, as the *DOM* would hand it over.
 *
 * Strings for everything except a checkbox, because that is what a form element produces. Using
 * already-typed values here would test the schema against itself and pass while the real form
 * failed — which is how the gap survived to be found by this suite.
 */
const DOM_VALUE = Object.freeze({
  boolean: true,
  integer: '12',
  string: 'a label',
  text: 'some prose the user wrote',
  identifier: 'WRK-1187',
  ref: 'main',
  'opaque-cursor': `astp_eA.${'a'.repeat(64)}`,
  'relative-path': 'src/index.mjs',
  'filesystem-path': '/tmp/workspace'
});

function domValues(schema) {
  const values = {};
  for (const [name, spec] of Object.entries(schema.fields ?? {})) {
    if (name === 'confirm') continue; // A ceremony is typed, never generated.
    values[name] = spec.type === 'enum' ? spec.values[0] : DOM_VALUE[spec.type];
  }
  return values;
}

test('a form submits the types the operation declares, not the types the DOM produced', () => {
  /**
   * `<input type="number">` hands back `"12"`; `integer` requires `Number.isInteger`. The operation
   * must not learn to accept `"12"` — then every caller may send it — so the form converts.
   */
  const coerced = coerceForm('intent-trace-v1',
    { repositoryId: 'repo', path: 'src/a.mjs', lineStart: '12', lineEnd: '40' });
  assert.equal(coerced.lineStart, 12);
  assert.equal(coerced.lineEnd, 40);
  assert.doesNotThrow(() => validateArguments('intent-trace-v1', coerced));
});

test('coercion narrows the representation and never decides the meaning', () => {
  // `"abc"` staying `"abc"` is the whole rule: the authority then refuses it by name, instead of
  // the form inventing a NaN nobody typed and the reader being told a different thing is wrong.
  const coerced = coerceForm('intent-trace-v1', { lineStart: 'abc', lineEnd: ' 7 ' });
  assert.equal(coerced.lineStart, 'abc');
  assert.equal(coerced.lineEnd, 7, 'a padded integer is still unambiguously that integer');
  assert.throws(() => validateArguments('intent-trace-v1',
    { repositoryId: 'r', path: 'p', lineStart: 'abc' }), /lineStart/);
});

test('local validation and the operation agree on every registered schema', () => {
  /**
   * `[UXH:REQ-071]`: the form validates for feedback, the operation validates for real, and the two
   * disagreeing is the failure mode — a reader either learns of a problem the operation does not
   * have, or commits to a submission the form said was fine.
   */
  for (const schema of ARGUMENT_SCHEMAS) {
    const values = domValues(schema);
    const local = checkForm(schema.id, values);
    let authoritative = true;
    try {
      validateArguments(schema.id, coerceForm(schema.id, values));
    } catch {
      authoritative = false;
    }
    assert.equal(local.valid, authoritative,
      `${schema.id}: form says ${local.valid}, operation says ${authoritative}`
      + (local.problems.length ? ` (${JSON.stringify(local.problems)})` : ''));
  }
});

test('the terminal equivalent parses back to the arguments the button submits', () => {
  /**
   * The round trip, on every schema. This is what makes "equivalent" a claim rather than a label:
   * the string a reader is invited to type is fed to the CLI's own parser, and what comes out must
   * be the bag the form would have sent.
   */
  for (const schema of ARGUMENT_SCHEMAS) {
    const submitted = coerceForm(schema.id, domValues(schema));
    if (!Object.keys(submitted).length) continue;

    const rendered = terminalEquivalent('sflow do', submitted);
    const { options } = parseArgs(argv(rendered).slice(2));
    const reparsed = argumentsFromFlags(schema.id, options);

    assert.deepEqual(reparsed, submitted, `${schema.id}: "${rendered}" does not round-trip`);
  }
});

test('a displayed command cannot be made to submit something else by a shell', () => {
  /**
   * `[UXH:REQ-073]` says display-only; it does not say approximate. A reader copies this. Inside
   * double quotes a shell still expands `$HOME` and still runs a backtick — so the equivalent for
   * a summary containing either would have submitted something the form never would.
   */
  const rendered = terminalEquivalent('sflow start', { summary: '$HOME and `id` and \'quoted\'' });
  assert.ok(!rendered.includes('"'), 'double quotes leave expansion live');
  assert.deepEqual(argv(rendered).slice(2), ['--summary', '$HOME and `id` and \'quoted\'']);
});

test('a false boolean survives the round trip, which --flag false does not', () => {
  /**
   * `--include-completed false` parses as the *string* `"false"`, which is neither the boolean the
   * schema requires nor the choice the reader made. `--no-` is how this parser spells false, so
   * that is what the equivalent shows.
   */
  const rendered = terminalEquivalent('sflow inbox', { group: 'active', includeCompleted: false });
  assert.equal(rendered, 'sflow inbox --group active --no-include-completed');
  const { options } = parseArgs(rendered.split(' ').slice(1));
  assert.deepEqual(argumentsFromFlags('work-list-v1', options), { group: 'active', includeCompleted: false });
});

test('a flag name and a field name are one fact, in both directions', () => {
  for (const schema of ARGUMENT_SCHEMAS) {
    for (const name of Object.keys(schema.fields ?? {})) {
      assert.equal(fieldFor(flagFor(name)), name, `${schema.id}.${name} does not survive the mapping`);
    }
  }
  // And the negated spelling reaches the same field, or a `--no-` flag would name nothing.
  assert.equal(fieldFor('--no-include-completed'), 'includeCompleted');
});

test('an unknown flag reaches the authority as an unknown field, rather than being dropped', () => {
  /**
   * The schemas are closed on purpose — "a dropped field is a silent change of meaning", per
   * `argument-schemas.mjs`. A CLI path that quietly discarded a flag the reader typed would break
   * that guarantee for one caller only, which is worse than breaking it for all of them.
   */
  const { options } = parseArgs(['--group', 'active', '--not-a-field', 'x']);
  const args = argumentsFromFlags('work-list-v1', options);
  assert.equal(args.notAField, 'x');
  assert.throws(() => validateArguments('work-list-v1', args), /notAField|unknown/i);
});

test('every schema a form can render is a schema the form can submit', () => {
  // The pair that matters: a renderable field the CLI cannot express, or an expressible field the
  // form cannot render, is a surface where one path can do something the other cannot.
  const gaps = [];
  for (const schema of ARGUMENT_SCHEMAS) {
    const model = formModel(schema.id);
    for (const field of model.fields) {
      if (!field.renderable) gaps.push(`${schema.id}.${field.name}: no control`);
      else if (fieldFor(flagFor(field.name)) !== field.name) gaps.push(`${schema.id}.${field.name}: no flag`);
    }
  }
  assert.deepEqual(gaps, [], `surfaces that can do different things:\n  ${gaps.join('\n  ')}`);
});

/**
 * What a shell would hand to `argv`, from the string a reader would paste.
 *
 * Enough of POSIX word splitting for the quoting `terminalEquivalent` emits: single quotes suspend
 * everything, `'\''` is a literal quote, and unquoted runs split on whitespace. Written here rather
 * than imported because the point of this suite is to stand outside both paths — a shared helper
 * would let one bug hide in both halves of the round trip.
 */
function argv(command) {
  const tokens = [];
  let token = null;
  let quoted = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quoted) {
      if (char === "'") quoted = false;
      else token += char;
    } else if (char === "'") {
      quoted = true;
      token ??= '';
    } else if (/\s/.test(char)) {
      if (token !== null) tokens.push(token);
      token = null;
    } else if (char === '\\' && command[index + 1] === "'") {
      token = (token ?? '') + "'";
      index += 1;
    } else {
      token = (token ?? '') + char;
    }
  }
  if (token !== null) tokens.push(token);
  return tokens;
}
