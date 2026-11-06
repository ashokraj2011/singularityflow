/**
 * A form that is wrong is asked again with what is wrong on it, what the person typed still in it, and
 * a limit. On a real Story a date and a reason were refused in a notification beside the form, each re-ask
 * started over, and after six forms the person typed filler: the record holds accept-risk with the reason
 * "sdsaadasdsadasdasad ada". A rule that loops until someone types junk makes the record worse.
 */
export const MAX_REFUSED_ROUNDS = 3;
// The JSON Schema form of what `checked` reads, so a host that validates says so in the field itself.
export const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

/** A text field that states its own rule: a host may not show `minLength`, and the title always reads. */
export function textField(words, { minimum = 1, maximum = 1000 } = {}) {
  return { type: 'string', title: `${words} (${minimum} to ${maximum} characters)`.slice(0, 200), minLength: minimum, maxLength: maximum };
}

/** The form again: the last problem first, and every answer already given as that field's default. */
export function formWithProblem(form, { problem = null, entered = null } = {}) {
  const keep = (name, field) => {
    const value = entered?.[name];
    return typeof value === 'string' && value && (!field.enum || field.enum.includes(value)) ? { ...field, default: value } : field;
  };
  const properties = Object.fromEntries(Object.entries(form.requestedSchema.properties).map(([name, field]) => [name, keep(name, field)]));
  return { ...form, message: problem ? `${problem}\n\n${form.message}` : form.message, requestedSchema: { ...form.requestedSchema, properties } };
}

/**
 * Ask until `read(content)` has no `problem`. Returns what it read, or `{ cancelled: true }` when the person
 * closes the form, or `{ refused: problem }` once the rounds are spent: nothing more is asked.
 */
export async function askUntilRight(ask, form, read) {
  let problem = null;
  let entered = null;
  for (let round = 1; ; round += 1) {
    const reply = await ask(formWithProblem(form, { problem, entered }));
    if (reply?.action !== 'accept') return { cancelled: true };
    const result = read(reply.content ?? {});
    if (!result.problem) return result;
    if (round >= MAX_REFUSED_ROUNDS) return { refused: result.problem };
    ({ problem } = result);
    entered = reply.content ?? {};
  }
}

/** What a person is told when the rounds are spent: exactly what was wrong, and that nothing was written. */
export const refusedWords = (problem) => `Nothing was recorded. After ${MAX_REFUSED_ROUNDS} tries the form still could not take this: ${problem} Run it again when you have what it needs.`;
