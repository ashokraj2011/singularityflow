/**
 * Rule records: one record per business rule, whether the docs state it, the code enforces it, a
 * test reaches it, or several of these. Built without a model from repository knowledge (code
 * rules, their error statuses and test reach), README/docs statements and approved Story
 * requirements, linked by anchors (see anchors.mjs).
 *
 * A link needs a strong anchor (the same message or named constant) or several weaker ones (the
 * same bound, the same status, the same nouns). Each record has a status:
 *   agreed            the docs state it and the code enforces it
 *   documented-only   the docs state it; no code rule was linked
 *   enforced-only     the code enforces it; no docs statement was linked
 *   conflict          docs and code describe the same rule differently (bound, status)
 * and `tested` says whether a test reaches the enforcing code. Conflicts are warnings for a person,
 * never refusals: the World Model is guidance, not authority.
 */
import { createHash } from 'node:crypto';

import { constraintText } from '../validation.mjs';
import { normalizeMessage, statusNumber, subjectWords, textAnchors } from './anchors.mjs';

const RULE_KINDS = new Set(['refusal', 'threshold', 'calculation', 'cap', 'comparison', 'match', 'message']);
const KIND_WEIGHT = Object.freeze({ refusal: 6, threshold: 5, calculation: 5, cap: 4, message: 4, comparison: 3, match: 3, guard: 1 });
const STATUS_ORDER = Object.freeze({ conflict: 0, 'documented-only': 1, 'enforced-only': 2, agreed: 3 });
const INVERSE = Object.freeze({ '>': '<=', '>=': '<', '<': '>=', '<=': '>' });
const FLIP = Object.freeze({ '>': '<', '>=': '<=', '<': '>', '<=': '>=' });
// A docs sentence is a rule only when it carries a value, a status, a quoted message or rule wording.
const RULE_WORDING = /\b(?:must|shall|only|never|always|required|requires|cannot|can't|not allowed|not accepted|not permitted|refuses?|rejects?|at least|at most|maximum|minimum|limit(?:ed)?)\b/iu;

function recordId(key) {
  return `R-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function family(op) {
  return op?.startsWith('>') ? 'lower' : op?.startsWith('<') ? 'upper' : null;
}

function constantValue(name, constants) {
  const value = constants.find((entry) => entry.name === name)?.value;
  const number = Number(String(value ?? '').replace(/[^\d.-]/gu, ''));
  return value != null && Number.isFinite(number) ? number : null;
}

/**
 * The bound a code rule states. A refusal states what is allowed (refused when `size > 20` means at
 * most 20); any other rule states when it applies.
 */
export function codeRuleBound(statement) {
  return codeRuleBounds(statement)[0] ?? null;
}

/** Every bound a rule's conditions state; a rejecting outcome (a refusal, "action = reject") states what is allowed. */
export function codeRuleBounds(statement) {
  const refusal = statement?.then?.kind === 'refuses' || /\b(?:reject|deny|denied|block|decline|refuse)\w*/iu.test(String(statement?.then?.text ?? ''));
  const constants = statement?.values?.constants ?? [];
  const bounds = [];
  for (const condition of statement?.when ?? []) {
    let op = null;
    let value = null;
    if (/\.isEmpty\(\)|\.length\s*===?\s*0\b|\bsize\(\)\s*==\s*0\b|\blen\([^)]*\)\s*==\s*0\b|^\s*!\s*\w+(?:\.\w+)*\s*$|\bis None\b/u.test(condition)) {
      op = '<'; value = 1;
    } else {
      const compare = /compareTo\(\s*([A-Za-z_][\w.]*)\s*\)\s*([<>]=?)\s*0/u.exec(condition);
      const right = /([<>]=?)\s*(-?\d+(?:\.\d+)?|[A-Z][A-Z0-9_]{2,})\b/u.exec(condition);
      const left = /(-?\d+(?:\.\d+)?|\b[A-Z][A-Z0-9_]{2,})\s*([<>]=?)(?!=)/u.exec(condition);
      if (compare) { op = compare[2]; value = /^[A-Z]/u.test(compare[1].split('.').pop()) ? constantValue(compare[1].split('.').pop(), constants) : null; }
      else if (right) { op = right[1]; value = /^[A-Z]/u.test(right[2]) ? constantValue(right[2], constants) : Number(right[2]); }
      else if (left) { op = FLIP[left[2]]; value = /^[A-Z]/u.test(left[1]) ? constantValue(left[1], constants) : Number(left[1]); }
    }
    if (op && value != null && Number.isFinite(value)) bounds.push({ op: refusal ? INVERSE[op] : op, value });
  }
  return bounds;
}

function ruleLine(item, status) {
  const statement = item.statement ?? {};
  const when = (statement.when ?? []).filter(Boolean);
  const then = statement.then ?? null;
  const verb = { refuses: 'refuses', returns: 'returns', shows: 'shows', computes: 'computes', does: 'does', checks: 'checks', stops: 'stops', decides: 'decides' }[then?.kind] ?? then?.kind ?? '';
  const condition = when.length ? `when ${when.map((part) => `\`${part}\``).join(' and ')}` : '';
  const outcome = then ? `${verb} ${then.kind === 'refuses' || then.kind === 'shows' ? `"${then.text}"` : `\`${then.text}\``}` : '';
  return `${item.subject?.symbol ?? 'The code'}: ${[condition, outcome].filter(Boolean).join(' → ')}${status ? ` (HTTP ${status})` : ''}`;
}

const CONSTRAINT_OP = Object.freeze({ min: (entry) => (entry.inclusive === false ? '>' : '>='), max: (entry) => (entry.inclusive === false ? '<' : '<='), 'length-min': () => '>=', 'length-max': () => '<=' });

/** A validated field read like a code rule: its names, bounds, message and whether it is required. */
function validationAnchors(item) {
  const statement = item.statement ?? {};
  const required = (statement.constraints ?? []).some((entry) => entry.kind === 'required');
  const names = [statement.field, statement.type].filter(Boolean).map((name) => name.toLowerCase());
  return {
    message: statement.message ? normalizeMessage(statement.message) : null, status: statusNumber(statement.status),
    identifiers: new Set(names), quoted: new Set(), nullChecked: new Set(required ? [String(statement.field).toLowerCase()] : []),
    values: new Set(), constants: new Set(),
    bounds: (statement.constraints ?? []).filter((entry) => CONSTRAINT_OP[entry.kind] && Number.isFinite(entry.value))
      .map((entry) => ({ op: CONSTRAINT_OP[entry.kind](entry), value: entry.value })),
    words: subjectWords(`${statement.type} ${statement.field} ${statement.message ?? ''}`)
  };
}

function codeAnchors(item, statusByMessage, limitValues) {
  const statement = item.statement ?? {};
  const then = statement.then ?? null;
  const message = then && ['refuses', 'shows'].includes(then.kind) && then.text ? normalizeMessage(then.text) : null;
  const status = then?.text ? statusNumber(statusByMessage.get(then.text)) : null;
  const method = String(item.subject?.symbol ?? '').split('.').pop();
  // Names the rule is written in terms of: identifiers in the condition (camelCase parts too) and
  // quoted names in the message, so `op` in the docs meets `opStr == null` and "missing 'op'".
  const identifiers = new Set();
  for (const token of (statement.when ?? []).join(' ').match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? []) {
    identifiers.add(token.toLowerCase());
    for (const part of token.replace(/([a-z])([A-Z])/gu, '$1 $2').split(/[\s_]+/u)) if (part.length > 1) identifiers.add(part.toLowerCase());
  }
  const quoted = new Set();
  for (const match of String(then?.text ?? '').matchAll(/['`]([A-Za-z_][\w.]*)['`]/gu)) { identifiers.add(match[1].toLowerCase()); quoted.add(match[1].toLowerCase()); }
  // Names the rule checks for null or absence: the docs say "`rule` is null", the code `rule == null`.
  const nullChecked = new Set();
  for (const condition of statement.when ?? []) {
    for (const match of condition.matchAll(/([A-Za-z_]\w*)\s*==\s*null|([A-Za-z_]\w*)\.isNull\(\)|([A-Za-z_]\w*)\s+is\s+None|!\s*([A-Za-z_]\w*)\b(?!\s*\.)/gu)) {
      nullChecked.add((match[1] ?? match[2] ?? match[3] ?? match[4]).toLowerCase());
    }
  }
  for (const word of ['null', 'none', 'true', 'false', 'this', 'new', 'return', 'size', 'length', 'get', 'is', 'has', 'equals']) identifiers.delete(word);
  return {
    message, status, identifiers, quoted, nullChecked,
    // Named constants in the condition and in the outcome ("subtract(total.multiply(VIP_DISCOUNT_RATE))"), with their values.
    values: new Set([
      ...(statement.values?.constants ?? []).map((entry) => entry.value),
      ...(String(then?.text ?? '').match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu) ?? []).map((name) => limitValues.get(name))
    ].map((value) => Number(String(value ?? '').replace(/[^\d.-]/gu, ''))).filter((value) => Number.isFinite(value) && value !== 0)),
    constants: new Set([...(statement.values?.constants ?? []).map((entry) => entry.name), ...(String(then?.text ?? '').match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/gu) ?? [])]),
    bounds: codeRuleBounds(statement),
    words: subjectWords([...(statement.when ?? []), method, then?.text ?? ''].join(' '))
  };
}

/** How strongly a docs statement and a code rule describe the same rule, and whether they disagree. */
/**
 * How strongly a docs statement and a code rule describe the same rule, and whether they disagree.
 * A name or word that many code rules share says little: `weight` gives each one its specificity.
 */
function compare(doc, code, weight) {
  let score = 0;
  let strong = false;
  if (code.message && (doc.messages.has(code.message) || (code.message.length >= 12 && doc.normalized.includes(code.message)))) { score += 10; strong = true; }
  if ([...code.values].some((value) => doc.numbers.has(value))) score += 3;
  if ([...code.constants].some((name) => doc.constants.has(name) || doc.identifiers.has(name.toLowerCase()))) { score += 6; strong = true; }
  const named = [...doc.identifiers].filter((name) => code.identifiers.has(name));
  score += Math.min(6, named.reduce((sum, name) => sum + weight.identifier(name), 0));
  // A specific name the code's own message quotes is as good as the message itself.
  if (named.some((name) => code.quoted.has(name) && weight.quoted(name) >= 2)) { score += 3; strong = true; }
  if (/\b(?:null|missing|present|empty|blank|required|absent|not set)\b/iu.test(doc.text)
      && [...code.nullChecked].some((name) => doc.identifiers.has(name) || doc.words.has(name))) score += 3;
  const sharedWords = [...doc.words].filter((word) => code.words.has(word));
  const shared = sharedWords.length;
  const sharedWeight = sharedWords.reduce((sum, word) => sum + weight.word(word), 0);
  score += Math.min(3, sharedWeight);
  if (code.status && doc.statuses.has(code.status)) score += 1;
  let disagreement = null;
  // Bounds pair by value first; an unpaired docs bound disagrees only with the one unpaired code bound
  // of its direction, so "at least 3 years and over 100" against `years >= 3` and `total > 100` agrees.
  const paired = new Set();
  const unpaired = [];
  for (const bound of doc.bounds) {
    const match = code.bounds.findIndex((candidate, index) => !paired.has(index) && family(candidate.op) === family(bound.op) && candidate.value === bound.value);
    if (match >= 0) { paired.add(match); score += 3; } else unpaired.push(bound);
  }
  for (const bound of unpaired) {
    const left = code.bounds.filter((candidate, index) => !paired.has(index) && family(candidate.op) === family(bound.op));
    if (left.length === 1 && (shared >= 2 || strong || named.length || sharedWeight >= 1)) disagreement = { docs: bound, code: left[0] };
  }
  const statuses = [...doc.statuses].filter((code) => code >= 400);
  if ((strong || score >= 4) && code.status && statuses.length && !statuses.includes(code.status)) disagreement = { docsStatus: statuses, codeStatus: code.status };
  return { score, strong, shared, disagreement };
}

function boundText(bound) {
  return `${{ '>=': 'at least', '<=': 'at most', '>': 'more than', '<': 'less than' }[bound.op]} ${bound.value}`;
}

function conflictText(disagreement) {
  if (disagreement.docsStatus) return `the docs say HTTP ${disagreement.docsStatus.join(' or ')}; the code returns HTTP ${disagreement.codeStatus}`;
  return `the docs say ${boundText(disagreement.docs)}; the code allows ${boundText(disagreement.code)}`;
}

/**
 * Build the rule records. `documentation` is `readDocumentation()`'s result (or null); approved
 * requirements are read from the knowledge items. Records are ranked by `focus` (a Story's words),
 * then status (conflict, documented only, enforced only, agreed), then how much the rule decides.
 */
export function buildRuleRecords(knowledge, documentation = null, { focus = null } = {}) {
  const items = knowledge?.items ?? [];
  const statusByMessage = new Map(items.filter((item) => item.kind === 'error-path' && item.statement?.message && item.statement?.status)
    .map((item) => [item.statement.message, String(item.statement.status)]));
  const docs = [
    ...(documentation?.statements ?? []).map((statement) => ({
      key: `${statement.path}:${statement.line}:${statement.text}`, text: statement.text, docText: statement.text,
      source: { path: statement.path, line: statement.line, heading: statement.heading || null }
    })),
    ...items.filter((item) => item.kind === 'requirement').map((item) => ({
      key: item.id, text: `${item.statement.clause}: ${item.statement.text}`,
      source: { path: item.citations?.[0]?.path ?? null, line: item.citations?.[0]?.lines?.[0] ?? null, heading: item.statement.clause }
    }))
  ].map((doc) => ({ ...doc, anchors: { ...textAnchors(doc.text), text: doc.text } }));
  const limitValues = new Map(items.filter((item) => item.kind === 'limit' && item.statement?.name).map((item) => [item.statement.name, item.statement.value]));
  // The same condition and outcome read twice (a calculation and its step) is one rule.
  const seenRules = new Set();
  const codeRules = items.filter((item) => item.kind === 'rule' && (RULE_KINDS.has(item.statement?.kind) || item.statement?.then?.kind === 'refuses'))
    .filter((item) => {
      const key = [item.subject?.symbol, ...(item.statement?.when ?? []), item.statement?.then?.text].join('\u0000');
      if (seenRules.has(key)) return false;
      seenRules.add(key);
      return true;
    })
    .map((item) => ({ item, anchors: codeAnchors(item, statusByMessage, limitValues) }))
    .concat(items.filter((item) => item.kind === 'validation').map((item) => ({ item, anchors: validationAnchors(item) })));

  // Specificity: a name or word in one code rule is a strong hint, one in many is not.
  const frequency = (pick) => {
    const counts = new Map();
    for (const code of codeRules) for (const key of pick(code.anchors)) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const identifierCounts = frequency((anchors) => anchors.identifiers);
  const wordCounts = frequency((anchors) => anchors.words);
  const quotedCounts = frequency((anchors) => anchors.quoted);
  const weight = {
    identifier: (name) => { const n = identifierCounts.get(name) ?? 0; return n <= 1 ? 3 : n <= 3 ? 2 : n <= 6 ? 1 : 0; },
    word: (word) => { const n = wordCounts.get(word) ?? 0; return n <= 2 ? 1 : n <= 6 ? 0.5 : 0; },
    quoted: (name) => { const n = quotedCounts.get(name) ?? 0; return n <= 2 ? 3 : n <= 4 ? 1 : 0; }
  };
  // Each docs statement links to the code rules that describe it best.
  const linksByRule = new Map();
  const linkedDocs = new Set();
  for (const doc of docs) {
    const scored = codeRules.map((code) => ({ code, ...compare(doc.anchors, code.anchors, weight) }))
      .filter((entry) => entry.strong || entry.score >= 4 || entry.disagreement)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) continue;
    for (const entry of scored.filter((candidate) => candidate.score >= best.score - 1).slice(0, 2)) {
      if (!linksByRule.has(entry.code.item.id)) linksByRule.set(entry.code.item.id, []);
      linksByRule.get(entry.code.item.id).push({ doc, disagreement: entry.disagreement, score: entry.score });
      linkedDocs.add(doc.key);
    }
  }

  const records = [];
  for (const { item, anchors } of codeRules) {
    const links = linksByRule.get(item.id) ?? [];
    const conflicts = links.filter((link) => link.disagreement);
    const documented = links.length > 0;
    if (item.statement?.kind === 'guard' && !documented) continue;
    if (item.kind === 'validation') {
      const statement = item.statement;
      const enforced = statement.validated !== false;
      const citation = item.citations?.[0];
      records.push({
        id: recordId(item.id), kind: 'rule', origin: 'validation',
        text: `${statement.type}.${statement.field}: ${constraintText(statement.constraints)}${statement.message ? ` ("${statement.message}")` : ''}${anchors.status ? ` (HTTP ${anchors.status} when invalid)` : ''}`,
        status: conflicts.length ? 'conflict' : documented ? 'agreed' : 'enforced-only',
        documented, enforced, tested: null, declaredOnly: !enforced, framework: statement.framework,
        conflict: conflicts.length ? conflictText(conflicts[0].disagreement) : null,
        parts: { field: statement.field, type: statement.type, constraints: statement.constraints, bound: anchors.bounds[0] ?? null, message: anchors.message },
        sources: { code: citation ? [{ path: citation.path, line: citation.lines?.[0] ?? null, symbol: item.subject?.symbol ?? null }] : [], docs: links.map((link) => link.doc.source), tests: [] },
        weight: 4,
        words: new Set([...anchors.words, ...links.flatMap((link) => [...link.doc.anchors.words])])
      });
      continue;
    }
    const tests = (item.relations ?? []).filter((relation) => relation.type === 'tested-by' || relation.type === 'tested-through').map((relation) => relation.label).filter(Boolean);
    const citation = item.citations?.[0];
    records.push({
      id: recordId(item.id), kind: 'rule',
      text: ruleLine(item, anchors.status),
      status: conflicts.length ? 'conflict' : documented ? 'agreed' : 'enforced-only',
      // A rule file is data: whether a test exercises it is not known from the file.
      documented, enforced: true, tested: item.statement?.source === 'rule-file' ? null : tests.length > 0, origin: item.statement?.source === 'rule-file' ? 'rule-file' : 'code',
      conflict: conflicts.length ? conflictText(conflicts[0].disagreement) : null,
      parts: { condition: item.statement?.when ?? [], outcome: item.statement?.then ?? null, message: anchors.message, status: anchors.status, bound: anchors.bound },
      sources: {
        code: citation ? [{ path: citation.path, line: citation.lines?.[0] ?? null, symbol: item.subject?.symbol ?? null }] : [],
        docs: links.map((link) => link.doc.source),
        tests
      },
      weight: KIND_WEIGHT[item.statement?.kind] ?? 2,
      words: new Set([...anchors.words, ...links.flatMap((link) => [...link.doc.anchors.words])])
    });
  }
  const ruleLike = (doc) => !/[{[]\s*["`]/u.test(doc.text)
    && (doc.anchors.bounds.length || doc.anchors.statuses.size || doc.anchors.messages.size || RULE_WORDING.test(doc.text));
  for (const doc of docs.filter((entry) => !linkedDocs.has(entry.key) && ruleLike(entry) && !/:\s*$/u.test(entry.text))) {
    records.push({
      id: recordId(doc.key), kind: 'rule', origin: 'docs', text: doc.text,
      status: 'documented-only', documented: true, enforced: false, tested: false, conflict: null,
      parts: { bound: doc.anchors.bounds[0] ?? null, statuses: [...doc.anchors.statuses] },
      sources: { code: [], docs: [doc.source], tests: [] },
      weight: 3, words: doc.anchors.words
    });
  }
  // A status the docs promise that no code refusal returns: one repository-wide conflict.
  const codeStatuses = new Set(codeRules.map((code) => code.anchors.status).filter(Boolean));
  for (const record of records.filter((entry) => entry.origin === 'docs')) {
    const promised = (record.parts.statuses ?? []).filter((code) => code >= 400);
    if (codeStatuses.size && promised.length && !promised.some((code) => codeStatuses.has(code))) {
      record.status = 'conflict';
      record.conflict = `the docs promise HTTP ${promised.join(' or ')}; the code's refusals return HTTP ${[...codeStatuses].sort().join(', ')}`;
    }
  }
  const focusWords = subjectWords(focus);
  const relevance = (record) => [...record.words].filter((word) => focusWords.has(word)).length;
  return records
    .map((record) => ({ ...record, relevance: relevance(record) }))
    .sort((a, b) => b.relevance - a.relevance || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.weight - a.weight || a.text.localeCompare(b.text, 'en'))
    .map(({ words, ...record }) => record);
}

/** "Documented, enforced, tested." and its variants, for a reader. */
export function ruleStatusWords(record) {
  if (record.status === 'conflict') return `Conflict: ${record.conflict}.`;
  if (record.status === 'documented-only') return 'Documented; no code enforcing it was found.';
  if (record.declaredOnly) return `${record.documented ? 'Documented' : 'Not documented'}; declared on ${record.parts.type}, but no endpoint validates it (@Valid is missing).`;
  const parts = [record.documented ? 'Documented' : 'Not documented', record.origin === 'validation' ? `enforced by ${record.framework}` : 'enforced',
    ...(record.tested == null ? [] : [record.tested ? 'tested' : 'no test reaches it'])];
  return `${parts.join(', ')}.`;
}

function subject(record) {
  if (record.parts?.message) return `"${record.parts.outcome?.text ?? record.parts.message}"`;
  const text = record.text.replace(/[.\s]+$/u, '');
  return text.length > 90 ? `"${text.slice(0, 89)}…"` : `"${text}"`;
}

/** Questions for the product owner, from conflicts, documented-only and untested rules. */
export function ruleQuestions(records, { limit = 4 } = {}) {
  const questions = [];
  for (const record of records) {
    if (questions.length >= limit) break;
    const source = [...record.sources.code, ...record.sources.docs];
    if (record.status === 'conflict') questions.push({ text: `Docs and code disagree on ${subject(record)}: ${record.conflict}. Which is right?`, source });
    else if (record.declaredOnly) questions.push({ text: `${record.parts.type}.${record.parts.field} is declared ${constraintText(record.parts.constraints)}, but no endpoint validates ${record.parts.type}. Should it be validated (@Valid)?`, source });
    else if (record.status === 'documented-only' && record.parts.bound) questions.push({ text: `The docs say ${subject(record)}, but no code enforcing it was found. Is it still required?`, source });
    else if (record.status === 'enforced-only' && !record.tested && record.parts.outcome?.kind === 'refuses') questions.push({ text: `The code refuses ${subject(record)}, but the docs do not state it and no test reaches it. Is it still required?`, source });
  }
  return questions;
}

/** The records as a Markdown section for people (`wm knowledge show rules`). */
export function renderRuleRecords(records, { limit = 40 } = {}) {
  if (!records.length) return '';
  const label = (source) => (source.heading ? `${source.path} › ${String(source.heading).split(' › ').pop()}` : `${source.path}${source.line ? `:${source.line}` : ''}`);
  const counts = Object.entries(records.reduce((all, record) => ({ ...all, [record.status]: (all[record.status] ?? 0) + 1 }), {}))
    .map(([status, count]) => `${count} ${status}`).join(', ');
  const lines = [`## Rules: docs, code and tests (${counts})`, ''];
  for (const record of records.slice(0, limit)) {
    const sources = [...record.sources.code, ...record.sources.docs].filter((source) => source?.path).map(label);
    lines.push(`- ${record.text.replace(/[.\s]+$/u, '')}. ${ruleStatusWords(record)}${sources.length ? ` (${sources.slice(0, 3).join('; ')})` : ''}`);
  }
  if (records.length > limit) lines.push(`- … ${records.length - limit} more`);
  return lines.join('\n');
}
