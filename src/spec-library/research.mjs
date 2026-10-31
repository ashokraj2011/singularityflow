/**
 * Research: the facts a specification relies on, each with its basis (SPEC-SPA v1.3 §4.2).
 *
 * Code facts come from the repository knowledge model (src/knowledge/): rules, limits, validations,
 * messages, test cases, untested rules, test/code disagreements, entry points and journeys, each
 * citing one span by path, lines and `spanSha256` at a named commit. A cited span that no longer
 * hashes the same at HEAD is stale; a stale fact stays visible and blocks a reviewed publication
 * until it is refreshed or removed. A person's statement is kept as a `person` fact, named.
 *
 * A gap's impact (§4.3) is computed here too, with no model: the knowledge model's impact records for
 * the code its evidence cites: the functions there, their callers, the flows reaching them, the rules
 * they hold and the tests that reach them.
 */
import { committedFileBytes } from '../git.mjs';
import { spanSha256 } from '../knowledge/items.mjs';
import { SingularityFlowError } from '../util.mjs';
import { formatResearchId, nextNumber, RESEARCH_ID } from './ids.mjs';

export const RESEARCH_KINDS = Object.freeze([
  'rule', 'limit', 'validation', 'message', 'test-case', 'untested-rule', 'drift', 'entry-point', 'journey'
]);
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const who = (actor) => (actor ? { name: actor.name ?? null, email: actor.email ?? null } : null);

export function normalizeArea(value) {
  const area = String(value ?? '').replaceAll('\\', '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
  if (area.startsWith('/') || area.split('/').includes('..')) fail(`--path ${value} must be a path inside the repository.`, 'SPEC_RESEARCH_PATH_INVALID', { path: value });
  return area === '.' ? '' : area;
}

const under = (file, area) => !area || file === area || String(file ?? '').startsWith(`${area}/`);

function compact(value, limit = 160) {
  const textValue = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return textValue.length > limit ? `${textValue.slice(0, limit - 1)}…` : textValue;
}

/** One plain line for a knowledge item. */
export function knowledgeSummary(item) {
  const subject = item.subject ?? {};
  const statement = item.statement ?? {};
  if (item.kind === 'rule') {
    const when = (statement.when ?? []).join(' and ');
    return `${subject.symbol ?? subject.path}: ${when ? `when ${when}, ` : ''}${statement.then?.kind ?? 'does'} ${compact(statement.then?.text ?? '')}`;
  }
  if (item.kind === 'limit') return `${statement.name ?? subject.name} = ${statement.value ?? '?'}${(statement.usedIn ?? []).length ? ` (used in ${[...new Set(statement.usedIn.map((use) => use.symbol).filter(Boolean))].join(', ')})` : ''}`;
  if (item.kind === 'test-case') return `Test "${statement.title ?? '?'}" exercises ${(statement.exercises ?? []).join(', ') || 'nothing it names'}`;
  return `${item.kind} ${subject.symbol ?? subject.path ?? ''}: ${compact(statement)}`;
}

function matches(item, { areas, symbols }) {
  if (!RESEARCH_KINDS.includes(item.kind) || !(item.citations ?? []).length) return false;
  if (symbols.size && (symbols.has(item.subject?.symbol) || (item.statement?.exercises ?? []).some((symbol) => symbols.has(symbol)))) return true;
  return areas.length > 0 && item.citations.some((cited) => areas.some((area) => under(cited.path, area)));
}

function codeItem(id, item, commit, actor, at) {
  const [cited] = item.citations;
  return { id, basis: 'code', kind: item.kind, knowledgeId: item.id, summary: knowledgeSummary(item),
    subject: { path: item.subject?.path ?? cited.path, symbol: item.subject?.symbol ?? null },
    citation: { path: cited.path, lines: [...cited.lines], spanSha256: cited.spanSha256, commit },
    addedBy: who(actor), at };
}

/**
 * Add the knowledge items under `areas` or naming `symbols`, and bring every code fact the draft
 * already has up to the knowledge built at `commit`. Returns the counts it changed.
 */
export function mergeResearch(draft, knowledge, commit, { areas = [], symbols = [] }, { actor, at }) {
  const wanted = { areas: areas.map(normalizeArea), symbols: new Set(symbols) };
  const byKnowledge = new Map((knowledge?.items ?? []).map((item) => [item.id, item]));
  let refreshed = 0;
  for (const existing of draft.research.filter((entry) => entry.basis === 'code')) {
    const current = byKnowledge.get(existing.knowledgeId);
    const cited = current?.citations?.[0];
    if (!cited) continue;
    const moved = cited.path !== existing.citation.path || cited.lines[0] !== existing.citation.lines[0]
      || cited.lines[1] !== existing.citation.lines[1] || cited.spanSha256 !== existing.citation.spanSha256;
    if (moved || existing.citation.commit !== commit) {
      Object.assign(existing, codeItem(existing.id, current, commit, actor, at), { addedBy: existing.addedBy, refreshedAt: at });
      if (moved) refreshed += 1;
    }
  }
  const present = new Set(draft.research.map((entry) => entry.knowledgeId).filter(Boolean));
  // The tests that exercise the researched code belong to it, wherever they live.
  const researched = new Set((knowledge?.items ?? []).filter((item) => matches(item, wanted) && item.kind !== 'test-case')
    .map((item) => item.subject?.symbol).filter(Boolean));
  const exercising = (item) => item.kind === 'test-case' && (item.citations ?? []).length
    && (item.statement?.exercises ?? []).some((symbol) => researched.has(symbol));
  let added = 0;
  for (const item of knowledge?.items ?? []) {
    if (present.has(item.id) || !(matches(item, wanted) || exercising(item))) continue;
    const id = formatResearchId(nextNumber(draft.research.map((entry) => entry.id), 'R-'));
    draft.research.push(codeItem(id, item, commit, actor, at));
    present.add(item.id);
    added += 1;
  }
  return { added, refreshed };
}

export function addPersonFact(draft, { note, source }, { actor, at }) {
  if (!String(note ?? '').trim() || !String(source ?? '').trim()) fail('A person\'s fact needs --fact TEXT and --source NAME (who stated it).', 'SPEC_RESEARCH_NOTE_INCOMPLETE');
  const id = formatResearchId(nextNumber(draft.research.map((entry) => entry.id), 'R-'));
  draft.research.push({ id, basis: 'person', kind: 'note', summary: String(note).trim(), source: String(source).trim(), addedBy: who(actor), at });
  return id;
}

export function removeResearch(draft, ids) {
  for (const id of ids) {
    if (!RESEARCH_ID.test(id) || !draft.research.some((entry) => entry.id === id)) fail(`${id} is not a research item of this draft.`, 'SPEC_RESEARCH_UNKNOWN', { item: id });
    const citing = draft.gaps.filter((event) => event.event === 'opened' && (event.evidence ?? []).includes(id)).map((event) => event.gap);
    if (citing.length) fail(`${id} is the evidence of ${citing.join(', ')}; it stays while a gap cites it.`, 'SPEC_RESEARCH_CITED', { item: id, gaps: citing });
  }
  draft.research = draft.research.filter((entry) => !ids.includes(entry.id));
  return draft;
}

function fileLinesAt(root, ref, file, cache) {
  const key = `${ref}\0${file}`;
  if (!cache.has(key)) {
    const bytes = committedFileBytes(root, ref, file);
    cache.set(key, bytes ? bytes.toString('utf8').split(/\r?\n/u) : null);
  }
  return cache.get(key);
}

/** Each research item's standing at `ref`: current, stale (its span changed or vanished), or uncited. */
export function verifyResearch(root, items, { ref = 'HEAD' } = {}) {
  const cache = new Map();
  return items.map((item) => {
    if (item.basis !== 'code') return { id: item.id, status: 'not-code' };
    const cited = item.citation;
    if (!cited?.path || !Array.isArray(cited.lines) || !cited.spanSha256) return { id: item.id, status: 'uncited' };
    const lines = fileLinesAt(root, ref, cited.path, cache);
    if (!lines) return { id: item.id, status: 'stale', reason: `${cited.path} is not in ${ref}` };
    if (cited.lines[1] > lines.length || spanSha256(lines, cited.lines[0], cited.lines[1]) !== cited.spanSha256) {
      return { id: item.id, status: 'stale', reason: `${cited.path}:${cited.lines[0]}-${cited.lines[1]} changed` };
    }
    return { id: item.id, status: 'current' };
  });
}

/** What the code a gap's evidence cites touches, and so what each option that changes code touches. */
export async function gapImpact(knowledge, draft, gap) {
  const { buildImpactRecords } = await import('../knowledge/records/impact.mjs');
  const evidence = draft.research.filter((item) => item.basis === 'code' && gap.evidence.includes(item.id));
  const ranges = new Map();
  for (const item of evidence) {
    const list = ranges.get(item.citation.path) ?? [];
    list.push([item.citation.lines[0], item.citation.lines[1]]);
    ranges.set(item.citation.path, list);
  }
  const records = ranges.size
    ? buildImpactRecords(knowledge, { changedPaths: [...ranges.keys()], changedRanges: ranges }).map((record) => ({ text: record.text, scope: record.scope, parts: record.parts }))
    : [];
  return {
    evidence: evidence.map((item) => item.id),
    records,
    options: gap.options.map((option) => ({ id: option.id, changesCode: option.changesCode, records: option.changesCode ? records : [] }))
  };
}
