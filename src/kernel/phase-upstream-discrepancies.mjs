/**
 * Upstream discrepancies an author recorded in its own phase artifact. `[phase-self-repair A1]`
 *
 * The authoring contract tells an author what to do with an approved earlier artifact that is
 * wrong, incomplete or contradicts another input: keep it unchanged, continue on the most
 * conservative reading, and list the problem under `## Upstream discrepancies`. Those items are
 * decisions for the earlier phase's owner (return, amendment or accepted risk), so a reviewer must
 * see them without reading every artifact in full. This module only reads; nothing here blocks.
 *
 * An item belongs to the step it names as its subject: its leading label (`**Verification
 * generation 1; …:**`, `planning:`), its table's producer column, or an explicit `Owner:` field.
 * A step named anywhere else in the text (a quoted section title such as "Acceptance and
 * specification results") never decides it, and an item naming no step, or two, has no owner.
 * The text is kept whole; only display layers shorten it.
 */

const HEADING = /^##\s+Upstream discrepancies\s*$/iu;
const MAXIMUM_ITEMS = 50;
// The reader once cut items here; the cut text identifies an item it already filed.
const LEGACY_TEXT = 300;
const NONE = /^(none|n\/a|-)\.?$/iu;
// A label names its step in a few words ("Verification generation 1"); a longer subject is a sentence.
const LABEL_WORDS = 6;
const QUOTES = { '“': '”', '"': '"', '«': '»', '‘': '’', '`': '`' };
const QUOTED = /“([^”]*)”|"([^"]*)"|«([^»]*)»|‘([^’]*)’/gu;
const FIELD = /(\*\*|__)?\b(assumptions?(?: used)?|impact|proposed owner action|proposed action|owner action|proposed|owning (?:step|phase)|owner(?: step| phase)?|producer(?: step| phase)?|section|clause)(\*\*|__)?\s*:(\*\*|__)?/giu;
// Steps listed side by side ("Specification and planning", "planning / release") are each named.
const LIST_JOINT = /^\s*(?:,|&|\+|\/|and\b|or\b)\s*(?:the\s+)?/u;
const FIELD_START = /(?:^|[.;|—–)\]]|\n[ \t]*(?:[-*+]|\d+[.)])?)[ \t]*$/u;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function cleanCell(value) {
  return String(value ?? '').replace(/`/gu, '').trim();
}

const isSeparatorRow = (line) => /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/u.test(line ?? '');

/** The record field a `Name:` label or a table column holds; null for one it does not read. */
function fieldKind(name) {
  const key = String(name ?? '').replace(/[`*_]/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (/^assumptions?(?: used)?$/u.test(key)) return 'assumption';
  if (key === 'impact') return 'impact';
  if (/^(?:proposed(?: owner)? action|owner action|proposed)$/u.test(key)) return 'proposed';
  if (/^(?:owning (?:step|phase)|owner(?: step| phase)?|producer(?: step| phase)?|step|phase)$/u.test(key)) return 'owner';
  if (/^(?:(?:exact )?(?:clause|section)(?: or (?:clause|section))?|about)$/u.test(key)) return 'section';
  return key === 'problem' ? 'problem' : null;
}

/** Each step with the lower-case names an item may call it by: its id and its label. */
function stepNames(steps) {
  return (steps ?? []).map((step) => (typeof step === 'string' ? { id: step } : step)).filter((step) => step?.id)
    .map(({ id, label }) => ({ id, names: [...new Set([id, id.replace(/[-_]+/gu, ' '), label].filter(Boolean)
      .map((name) => String(name).toLowerCase().replace(/\s+/gu, ' ').trim()).filter(Boolean))] }));
}

const mention = (name) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, 'gu');

/** A label's subject: quoted titles removed, cut where its qualifiers start. */
function subjectOf(value) {
  return String(value ?? '').replace(/\*\*|__|`/gu, '').replace(QUOTED, ' ').split(/[;:([|—–]| - /u)[0]
    .toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** The step whose name (the longest that fits) opens `text`. */
function leadingStep(text, names) {
  let found = null;
  for (const step of names) {
    for (const name of step.names) {
      if (mention(name).exec(text)?.index === 0 && name.length > (found?.length ?? 0)) found = { id: step.id, length: name.length };
    }
  }
  return found;
}

/**
 * The step a subject opens with, and any step listed beside it; null when none opens it. Words
 * after it are qualifiers ("Verification release candidate 1" is Verification's), never owners.
 */
function subjectSteps(subject, names) {
  for (const text of new Set([subject, subject.replace(/^(?:(?:the|step|phase)\s+)+/u, '')])) {
    let step = leadingStep(text, names);
    if (!step) continue;
    const ids = [step.id];
    let rest = text.slice(step.length);
    for (let joint = LIST_JOINT.exec(rest); joint; joint = LIST_JOINT.exec(rest)) {
      step = leadingStep(rest.slice(joint[0].length), names);
      if (!step) break;
      ids.push(step.id);
      rest = rest.slice(joint[0].length + step.length);
    }
    return [...new Set(ids)];
  }
  return null;
}

/** The item's leading label: its opening bold run, or the text before a colon that opens it. */
function leadingLabel(entry) {
  const bold = /^(\*\*|__)(.+?)\1/u.exec(entry);
  if (bold) return bold[2].replace(/:\s*$/u, '');
  let quote = null;
  for (let index = 0; index < Math.min(entry.length, 160); index += 1) {
    const char = entry[index];
    if (quote) quote = char === quote ? null : quote;
    else if (QUOTES[char]) quote = QUOTES[char];
    // A colon inside a word (`W:AC-001`) does not end a label.
    else if (char === ':' && /\s/u.test(entry[index + 1] ?? ' ')) return entry.slice(0, index);
    else if (char === '\n' || (/[.?!]/u.test(char) && /\s/u.test(entry[index + 1] ?? ' '))) return null;
  }
  return null;
}

/** `Assumption:`, `Impact:`, `Proposed owner action:`, `Owner:` and `Section:` values in the item. */
function inlineFields(entry) {
  const marks = [];
  for (const match of entry.matchAll(FIELD)) {
    // A field is labelled: in bold, or opening the item, a line or a sentence; never mid-sentence.
    if (!(match[1] || match[3] || match[4]) && !FIELD_START.test(entry.slice(0, match.index))) continue;
    marks.push({ kind: fieldKind(match[2]), start: match.index, value: match.index + match[0].length });
  }
  const fields = {};
  marks.forEach((mark, index) => {
    const value = entry.slice(mark.value, marks[index + 1]?.start ?? entry.length).replace(/^[\s*_]+|[\s*_;|—–-]+$/gu, '');
    if (value) (fields[mark.kind] ??= []).push(value);
  });
  return fields;
}

/** The owner the item's claims agree on, or why it has none. */
function ownership(claims, names, earlier) {
  const named = new Set();
  let unknown = null;
  for (const { via, value } of claims) {
    const subject = subjectOf(value);
    const found = via === 'label' && subject.split(',')[0].trim().split(' ').length > LABEL_WORDS ? null : subjectSteps(subject, names);
    if (found) found.forEach((id) => named.add(id));
    // A label need not name a step ("Note:"); an owner field or column that names none is a claim.
    else if (via !== 'label' && !NONE.test(String(value).trim())) unknown ??= String(value).trim();
  }
  const ids = [...named];
  if (ids.length > 1) return { status: 'conflicting', named: ids };
  if (unknown) return { status: 'unknown-step', named: ids, value: unknown };
  if (!ids.length) return { status: 'unnamed', named: [] };
  return { status: earlier.has(ids[0]) ? 'named' : 'not-earlier', named: ids };
}

function parsedItem(text, { first = text, cells = null, columns = null }, names, earlier) {
  const fields = inlineFields(text);
  const claims = [];
  const label = cells ? null : leadingLabel(text);
  if (label) claims.push({ via: 'label', value: label });
  if (cells) {
    const ownerColumn = columns?.indexOf('owner') ?? -1;
    if (ownerColumn >= 0) claims.push({ via: 'column', value: cells[ownerColumn] ?? '' });
    else claims.push({ via: 'label', value: cells.find(Boolean) ?? '' });
    columns?.forEach((kind, index) => {
      if (kind && !['owner', 'problem'].includes(kind) && cells[index]) (fields[kind] ??= []).unshift(cells[index]);
    });
  }
  for (const value of fields.owner ?? []) claims.push({ via: 'field', value });
  const owner = ownership(claims, names, earlier);
  const titles = label ? [...label.matchAll(QUOTED)].map((match) => match.slice(1).find((part) => part != null).trim()).filter(Boolean) : [];
  return {
    phase: owner.status === 'named' ? owner.named[0] : null, text, owner,
    assumption: fields.assumption?.[0] ?? null, impact: fields.impact?.[0] ?? null, proposed: fields.proposed?.[0] ?? null,
    sections: [...titles, ...(fields.section ?? [])],
    legacyText: first.length > LEGACY_TEXT ? `${first.slice(0, LEGACY_TEXT - 1)}…` : first
  };
}

/**
 * The items under `## Upstream discrepancies`, whole, each with the step that owns it.
 *
 * `steps` are the Story's steps (ids, or `{ id, label }`); `earlier` the ids an item may be about
 * (all of `steps` when omitted). `phase` is null unless the item names exactly one earlier step;
 * `owner.status` says why: named, unnamed, conflicting, not-earlier or unknown-step.
 */
export function upstreamDiscrepanciesFromMarkdown(markdown, steps = [], { earlier = null } = {}) {
  const names = stepNames(steps);
  const eligible = new Set(earlier ?? names.map((step) => step.id));
  const lines = String(markdown ?? '').split(/\r?\n/u);
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start < 0) return [];
  const items = [];
  let open = null;
  let blank = false;
  let columns = null;
  const close = () => {
    if (open) items.push(parsedItem(open.lines.join('\n'), open, names, eligible));
    open = null;
  };
  for (let index = start + 1; index < lines.length && items.length < MAXIMUM_ITEMS; index += 1) {
    const line = lines[index];
    if (/^#{1,2}\s/u.test(line)) break;
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/u.exec(line);
    const row = /^\s*\|(.*)\|\s*$/u.exec(line);
    const wasBlank = blank;
    blank = false;
    if (row) {
      close();
      const cells = row[1].split('|').map(cleanCell);
      // Separator and header rows describe the table rather than an item.
      if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell) || cell === '')) continue;
      if (isSeparatorRow(lines[index + 1]) || cells.some((cell) => /^(producer|producer phase|phase|problem)$/iu.test(cell))) {
        columns = cells.map(fieldKind);
        continue;
      }
      const entry = cells.filter(Boolean).join(' — ');
      if (entry && !NONE.test(entry.trim())) items.push(parsedItem(entry, { cells, columns }, names, eligible));
      continue;
    }
    columns = null;
    if (bullet && (!open || bullet[1].length <= open.indent)) {
      close();
      if (!NONE.test(bullet[2].trim())) open = { indent: bullet[1].length, lines: [bullet[2]], first: bullet[2] };
      continue;
    }
    // A nested bullet, an indented line or a line straight after the item continues it.
    if (open && !/^\s*#/u.test(line) && (bullet || !wasBlank || /^\s{2,}\S/u.test(line))) open.lines.push(line.trim());
    else close();
  }
  close();
  return items.slice(0, MAXIMUM_ITEMS);
}

/** The Story's steps in order, with the labels an item may name them by. */
export function discrepancySteps(workflow) {
  return (workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {}))
    .map((id) => ({ id, label: workflow?.phases?.[id]?.label ?? null }));
}

/** Discrepancies across a phase review's readable documents, with the document each came from. */
export function phaseUpstreamDiscrepancies(documents = [], workflow = null, phaseId = null) {
  const steps = discrepancySteps(workflow);
  const order = steps.map((step) => step.id);
  // Only earlier phases can be upstream; the current phase naming itself is not a producer.
  const position = phaseId ? order.indexOf(phaseId) : -1;
  const earlier = position >= 0 ? order.slice(0, position) : order.filter((id) => id !== phaseId);
  const found = [];
  for (const document of documents) {
    if (document?.content == null || document.binary || document.error) continue;
    for (const { legacyText, ...item } of upstreamDiscrepanciesFromMarkdown(document.content, steps, { earlier })) {
      found.push({ ...item, path: document.path ?? null });
      if (found.length >= MAXIMUM_ITEMS) return found;
    }
  }
  return found;
}
