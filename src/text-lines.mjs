/**
 * Line numbers for byte offsets into one text, computed once for the text rather than once per
 * offset.
 *
 * Six modules had grown the same three-line helper:
 *
 *     function line(text, index) { return text.slice(0, index).split('\n').length; }
 *
 * which copies the file up to the offset and splits it, for every offset asked. Called once per
 * regex match, the cost is symbols × file bytes — quadratic in the size of the file, on the
 * repository-facts and AST extraction paths that run over every source file in a world-model build.
 * `MAX_SCAN_BYTES` caps a file at 512 KB, so a single dense one can do a couple of hundred megabytes
 * of copying to answer questions about itself.
 *
 * Building the line starts is one pass; each lookup is then a binary search. The exported shape is a
 * factory rather than a `line(text, offset)` function on purpose: the saving is entirely in hoisting
 * the scan out of the loop, and a signature that takes the text every time invites putting it back.
 */

/**
 * A 1-indexed line lookup for `text` — what an editor and a citation both mean by "line".
 *
 * Offsets outside the text are clamped rather than rejected: every caller is reporting the position
 * of something it already found in this string, so an out-of-range offset is a bug in the caller and
 * a thrown error here would turn a wrong citation into a failed build.
 */
export function lineNumbers(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

// ---------------------------------------------------------------------------------------------------
// Values an agent copies by hand, and the exact repair when it gets one wrong.
// They live here, not in records.mjs, so the eager graph every command loads (root dispatch reads
// records.mjs) does not carry them; only refusals of agent-authored input read them.
//
// An agent repairs a packet within a budget of two attempts. "Invalid input", a raw regex or "stale"
// for a two-character slip sent it guessing until the budget ran out (Story anu-bin, 2026-11-11), so
// every refusal of agent-authored input names the field, says the rule in words, and gives the exact
// value when SFlow knows it.
// ---------------------------------------------------------------------------------------------------

/** Levenshtein distance, stopping once it exceeds `limit`. */
export function editDistanceWithin(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
    }
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

const HASH_LIKE = /^(?:sha256:)?[0-9a-f]{64}$/iu;
const trimCopy = (value) => String(value).trim().replace(/^["'`<]+|["'`>]+$/gu, '').trim();

/**
 * Whether `given` is `expected` copied by hand with a slip: 'exact', 'slip' or 'different'. A slip is
 * the same value in another case or with or without `sha256:`, cut short to a prefix of at least 12
 * characters, elided in the middle ("abc…xyz"), the same number written as text, or a few characters
 * off a long value (at most one in eight). A changed input changes nearly all of a SHA-256 and shares no
 * 12-character prefix with it, so a slip never hides a real change. Short values (d1, S2) are never
 * slips of each other.
 */
export function copySlip(given, expected) {
  if (given === expected) return 'exact';
  if (given == null || expected == null || typeof given === 'object' || typeof expected === 'object') return 'different';
  if (String(given) === String(expected)) return 'slip';
  let left = trimCopy(given);
  let right = trimCopy(expected);
  if (!left || !right) return 'different';
  if (HASH_LIKE.test(right)) {
    right = right.toLowerCase().replace(/^sha256:/u, '');
    left = left.toLowerCase().replace(/^sha256:/u, '');
  }
  if (left === right) return 'slip';
  if (right.length >= 12 && left.toLowerCase() === right.toLowerCase()) return 'slip';
  const parts = left.split(/…|\.{3}/u);
  if (parts.length === 2 && parts[0].length + parts[1].length >= 12 && parts[0].length + parts[1].length < right.length
      && right.startsWith(parts[0]) && right.endsWith(parts[1])) return 'slip';
  if (parts.length === 1 && left.length >= 12 && left.length < right.length && right.startsWith(left)) return 'slip';
  if (right.length >= 12) {
    const limit = Math.max(2, Math.floor(right.length / 8));
    if (editDistanceWithin(left, right, limit) <= limit) return 'slip';
  }
  return 'different';
}

const lastSegment = (value) => String(value).split(/[:/\\]/u).filter(Boolean).at(-1)?.toLowerCase() ?? '';
const squashed = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/gu, '');

/**
 * The one known value a given value was meant to be, or the known values to choose from: `{ value }`
 * when exactly one candidate matches at the first tier that matches any (same ignoring case; same
 * letters and digits; a copying slip; the same last segment, as `code:App.jsx` for `code:src:App.jsx`;
 * a unique prefix of at least three characters), else `{ allowed, more }` (at most 12 listed). With
 * `single`, the only value left is the one meant.
 */
export function nearestKnown(given, known, { single = false } = {}) {
  const list = [...new Set((known ?? []).filter((entry) => typeof entry === 'string' && entry))];
  const choices = { allowed: list.slice(0, 12), more: Math.max(0, list.length - 12) };
  if (typeof given !== 'string' || !given.trim() || !list.length) return single && list.length === 1 ? { value: list[0] } : choices;
  if (list.includes(given)) return { value: given, exact: true };
  // The one value still owed (an acknowledgement list with one left): that is the one meant.
  if (single && list.length === 1) return { value: list[0] };
  const text = given.trim();
  const tiers = [
    (entry) => entry.toLowerCase() === text.toLowerCase(),
    (entry) => squashed(entry) === squashed(text) && squashed(text).length > 0,
    (entry) => copySlip(text, entry) === 'slip',
    (entry) => lastSegment(text).length >= 3 && lastSegment(entry) === lastSegment(text),
    (entry) => text.length >= 3 && entry.toLowerCase().startsWith(text.toLowerCase())
  ];
  for (const tier of tiers) {
    const matches = list.filter(tier);
    if (matches.length === 1) return { value: matches[0] };
    if (matches.length > 1) return { allowed: matches.slice(0, 12), more: Math.max(0, matches.length - 12) };
  }
  return choices;
}

/** "use X exactly" or "use one of: …", for a nearestKnown result. */
export function knownChoiceWords(near) {
  if (near?.value) return `use ${near.value} exactly`;
  if (near?.allowed?.length) return `use one of: ${near.allowed.join(', ')}${near.more ? `, … (${near.more} more)` : ''}`;
  return 'none is known here';
}

/** A JSON field selector (`rows[1].tests[0].sourceId`) of a value's path parts. */
export function fieldPath(parts) {
  return parts.reduce((value, part) => (typeof part === 'number' ? `${value}[${part}]` : `${value}${value ? '.' : ''}${String(part)}`), '') || '$';
}

/** The value at a field selector such as `rows[1].tests[0].sourceId`, or undefined. */
export function valueAtField(value, field) {
  if (field === '$') return value;
  return String(field).split(/\.|(?=\[)/u).filter(Boolean).reduce((current, part) => {
    const index = /^\[(\d+)\]$/u.exec(part);
    return current == null ? undefined : index ? current[Number(index[1])] : current[part];
  }, value);
}

/** Formats an agent writes, in words: a refusal never shows a raw regular expression. (A plain literal, so bundles that never read it drop it.) */
const FORMAT_WORDS = {
  '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$': 'an ID: a letter or digit, then letters, digits, ".", "_", ":" or "-" (no "/" or spaces), at most 128 characters',
  '^S\\d+$': 'a scenario ID such as S1',
  '^sha256:[a-f0-9]{64}$': '"sha256:" and 64 lower-case hexadecimal characters',
  '^[a-f0-9]{64}$': '64 lower-case hexadecimal characters',
  '^[a-f0-9]{40,64}$': 'a full Git commit ID (40 to 64 lower-case hexadecimal characters)',
  '^UPI-\\d{3,}$': 'an upstream issue ID such as UPI-001',
  '^APL-[a-f0-9]{24}$': 'an appeal ID: APL- and 24 hexadecimal characters',
  '^PQR-[a-f0-9]{24}$': 'a risk decision ID: PQR- and 24 hexadecimal characters',
  '^PRC-\\d{3,}$': 'a plan correction ID such as PRC-001',
  '^AMD-\\d{3,}$': 'an intent amendment ID such as AMD-001',
  '^(?:PRC-\\d{3,}|CR-\\d{3,}|FAM-\\d{3,})$': 'PRC-NNN, CR-NNN or FAM-NNN',
  '^[A-Z0-9][A-Z0-9._-]{0,63}:[A-Z]{2,4}-\\d{3}$': 'a clause ID: the Story\'s namespace, a colon, a kind and three digits, such as STORY-1:REQ-001',
  '^[a-z][a-z-]{0,31}$': 'lower-case words joined by "-", such as test-only'
};

/** The object keys a zod schema allows at a field path, read through arrays, optionals and unions. */
function allowedKeysAt(schema, parts, input) {
  let node = schema;
  let value = input;
  const unwrap = (current, at) => {
    for (let guard = 0; guard < 16; guard += 1) {
      const def = current?._zod?.def;
      if (!def) return current;
      if (['optional', 'nullable', 'default', 'readonly', 'catch', 'nonoptional', 'prefault'].includes(def.type)) { current = def.innerType; continue; }
      if (def.type === 'pipe') { current = def.in; continue; }
      if (def.type === 'union') {
        const chosen = def.discriminator && at && typeof at === 'object'
          ? def.options.find((option) => option._zod?.def?.shape?.[def.discriminator]?._zod?.def?.values?.includes(at[def.discriminator])) : null;
        if (chosen) { current = chosen; continue; }
        return { union: def.options.map((option) => unwrap(option, at)) };
      }
      return current;
    }
    return current;
  };
  for (const part of parts) {
    node = unwrap(node, value);
    if (node?.union) return null;
    const def = node?._zod?.def;
    if (def?.type === 'array' && typeof part === 'number') node = def.element;
    else if (def?.type === 'object' && typeof part === 'string') node = def.shape[part];
    else return null;
    value = value?.[part];
  }
  node = unwrap(node, value);
  const objects = node?.union ? node.union : [node];
  const keys = objects.flatMap((entry) => (entry?._zod?.def?.type === 'object' ? Object.keys(entry._zod.def.shape) : []));
  return keys.length ? [...new Set(keys)] : null;
}

/** The type of a value, in words. */
const kindOf = (value) => (value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'a list' : typeof value === 'object' ? 'an object' : `a ${typeof value}`);
const shown = (value) => (typeof value === 'string' ? `'${value.slice(0, 200)}'` : JSON.stringify(value)?.slice(0, 200) ?? String(value));

/**
 * Every zod issue of agent-authored input as `{ field, message, proposedEdit?, allowed? }` [agent input
 * repairs]: each names its field and what was given; a format is said in words, never as a regex; an
 * unknown key lists the allowed keys and the nearest; a choice lists its values; and a field with a
 * known set (`known: [{ field: /\.sourceId$/u, values: [...], what: 'a source ID from sources[].id' }]`)
 * gets the exact value it was meant to be as `proposedEdit`, or the values to choose from as `allowed`.
 */
export function agentInputIssues(issues, input, { schema = null, known = [] } = {}) {
  const findings = [];
  const add = (entry) => findings.push(entry);
  for (const issue of issues ?? []) {
    const field = fieldPath(issue.path ?? []);
    const given = valueAtField(input, field);
    const set = typeof given === 'string' ? known.find((entry) => entry.field.test(field)) : null;
    if (set && !set.values.includes(given)) {
      const near = nearestKnown(given, set.values);
      add({ field, message: `${field} is ${shown(given)}, which is not ${set.what}; ${knownChoiceWords(near)}.`,
        ...(near.value ? { proposedEdit: { field, value: near.value } } : near.allowed?.length ? { allowed: near.allowed } : {}) });
      continue;
    }
    if (issue.code === 'unrecognized_keys') {
      const allowed = (schema ? allowedKeysAt(schema, issue.path ?? [], input) : null) ?? [];
      for (const key of issue.keys ?? []) {
        const near = nearestKnown(key, allowed);
        const alias = { explanation: 'message', description: 'message', clauseIds: 'clauseId', tests: 'plannedTests', comment: 'note', notes: 'note' }[key];
        const suggestion = near.value ?? (alias && allowed.includes(alias) ? alias : null);
        add({ field: field === '$' ? key : `${field}.${key}`, message: `${field === '$' ? 'The packet' : field} has no field ${key}${suggestion ? `; did you mean ${suggestion}?` : ''}${allowed.length ? ` Its fields: ${allowed.join(', ')}.` : '.'}`,
          ...(allowed.length ? { allowed } : {}) });
      }
      continue;
    }
    if (issue.code === 'invalid_value' || (issue.code === 'invalid_union' && issue.note === 'No matching discriminator')) {
      const values = issue.values ?? issue.options ?? [];
      const near = typeof given === 'string' ? nearestKnown(given, values.filter((entry) => typeof entry === 'string')) : {};
      const single = values.length === 1 && ['string', 'number', 'boolean'].includes(typeof values[0]) ? values[0] : near.value;
      add({ field, message: `${field} is ${given === undefined ? 'missing' : shown(given)}; ${values.length === 1 ? `it must be ${shown(values[0])}` : `use one of: ${values.map(shown).join(', ')}`}.`,
        ...(single !== undefined && single !== null ? { proposedEdit: { field, value: single } } : {}),
        ...(values.length > 1 ? { allowed: values.filter((entry) => ['string', 'number', 'boolean'].includes(typeof entry)).slice(0, 12) } : {}) });
      continue;
    }
    if (issue.code === 'invalid_format') {
      const source = String(issue.pattern ?? '').replace(/^\/|\/[a-z]*$/gu, '');
      const words = FORMAT_WORDS[source] ?? (issue.format && issue.format !== 'regex' ? `a valid ${issue.format}` : 'the documented format (see the packet\'s schema description)');
      add({ field, message: `${field} is ${shown(given)}; it must be ${words}.` });
      continue;
    }
    if (issue.code === 'invalid_type') {
      const proposed = issue.expected === 'number' && typeof given === 'string' && given.trim() && Number.isFinite(Number(given)) ? Number(given) : undefined;
      add({ field, message: `${field} is ${kindOf(given)}; it must be ${['a', 'e', 'i', 'o', 'u'].includes(String(issue.expected)[0]) ? 'an' : 'a'} ${issue.expected}.`,
        ...(proposed !== undefined ? { proposedEdit: { field, value: proposed } } : {}) });
      continue;
    }
    if (issue.code === 'too_small' || issue.code === 'too_big') {
      const unit = issue.origin === 'string' ? 'characters' : issue.origin === 'array' ? 'entries' : '';
      const length = typeof given === 'string' ? `${given.trim().length} characters` : Array.isArray(given) ? `${given.length} entries` : shown(given);
      add({ field, message: `${field} has ${length}; it needs ${issue.code === 'too_small' ? 'at least' : 'at most'} ${issue.minimum ?? issue.maximum}${unit ? ` ${unit}` : ''}${issue.origin === 'string' && issue.code === 'too_small' ? ' (leading and trailing spaces do not count)' : ''}.` });
      continue;
    }
    if (issue.code === 'invalid_union') {
      // The branch with the fewest problems is the one the author meant; report its problems.
      const branch = [...(issue.errors ?? [])].sort((left, right) => left.length - right.length)[0];
      if (branch?.length) {
        findings.push(...agentInputIssues(branch.map((entry) => ({ ...entry, path: [...(issue.path ?? []), ...(entry.path ?? [])] })), input, { schema, known }));
        continue;
      }
    }
    // A refine names its own rule; anything else still names its field and what was given.
    add({ field, message: issue.message && issue.message !== 'Invalid input' ? `${field} is ${shown(given)}: it ${issue.message}.` : `${field} is ${shown(given)}, which this field does not accept.` });
  }
  return findings;
}

/**
 * Refuse a copied confirmation that is not the current one [copied values]. A copying slip (see copySlip)
 * is refused as `<CODE>_MISTYPED`: nothing changed, use the exact value. Anything else keeps the caller's
 * own stale wording and code, and always carries the current value. A person's confirmation stays
 * theirs: this only says what was wrong; it never accepts a near miss.
 */
export function assertConfirmation(given, expected, { fail, code, message, label = '--confirm', details = {} }) {
  if (given === expected) return;
  const mistyped = `${String(code).replace(/_(?:STALE|CHANGED|MISMATCH|REQUIRED|INVALID)$/u, '')}_MISTYPED`;
  const confirmation = { given: typeof given === 'string' ? given.slice(0, 200) : null, expected };
  if (typeof given === 'string' && given && copySlip(given, expected) === 'slip') {
    fail(`${label} ${given.slice(0, 80)} is a copying slip of the current value; nothing changed. Use ${label} ${expected} exactly.`, mistyped,
      { ...details, confirmation: { ...confirmation, slip: true } });
  }
  fail(`${message} The current value is ${expected}.`, code, { ...details, confirmation: { ...confirmation, slip: false } });
}
