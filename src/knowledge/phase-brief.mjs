/**
 * The repository brief a phase prompt receives.
 *
 * It is built without a model from what already exists: repository knowledge (rules with their
 * messages and statuses, endpoints, data shapes, flows, impact, history) and README and docs
 * statements. Items are ranked by the Story's own words and changed files, ordered for the phase's
 * reader, and cut to a small per-phase budget. Every bullet names its source as a file and line;
 * what could not be determined is one closing "Not known" line.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { meaningText, ruleStatusWords } from './records/rules.mjs';

export const PHASE_BRIEF_RENDERER = Object.freeze({ id: 'repository-brief', version: 1 });

/**
 * Per-phase reader, budget and section order. A step is profiled by what it declares first (its
 * output kind, then a code task), then by its ID (first match wins), then by its other declared task
 * (TASK_PROFILES). The budgets are defaults: `worldModel.knowledge.maxBytes` replaces them for every phase.
 */
export const PHASE_BRIEF_PROFILES = Object.freeze([
  Object.freeze({ id: 'reproduction', reader: 'developer', pattern: '(reproduc|fix-spec)', budget: 3072, order: Object.freeze(['rules', 'impact', 'risks', 'contracts']) }),
  Object.freeze({ id: 'implementation-spec', reader: 'developer', pattern: '(implementation-spec|fix-design|component-mapping|mobile-spec)', budget: 4096, order: Object.freeze(['impact', 'rules', 'contracts', 'flows', 'risks']) }),
  Object.freeze({ id: 'conformance', reader: 'tester', pattern: '(conform)', budget: 2048, order: Object.freeze(['contracts', 'rules', 'impact']) }),
  Object.freeze({ id: 'release', reader: 'product', pattern: '(release|deploy)', budget: 2048, order: Object.freeze(['contracts', 'rules']) }),
  Object.freeze({ id: 'verification', reader: 'tester', pattern: '(test|verif|qa|accept)', budget: 3072, order: Object.freeze(['rules', 'risks', 'flows', 'impact']) }),
  Object.freeze({ id: 'intake', reader: 'product', pattern: '(intake|requirement|specif|discover|product|business|story)', budget: 2048, order: Object.freeze(['overview', 'rules', 'questions', 'contracts']) }),
  Object.freeze({ id: 'design', reader: 'architect', pattern: '(design|architect|plan)', budget: 3072, order: Object.freeze(['contracts', 'flows', 'rules', 'risks', 'overview']) }),
  Object.freeze({ id: 'implementation', reader: 'developer', pattern: '.*', budget: 3072, order: Object.freeze(['impact', 'rules', 'contracts', 'risks']) })
]);

const SECTION_TITLES = Object.freeze({
  overview: 'What exists', rules: 'Rules that apply', contracts: 'Contracts', flows: 'Flows',
  impact: 'What a change touches', risks: 'Risks', questions: 'Questions for the product owner'
});
const EXPLANATIONS_TITLE = 'In plain words (inferred: model-written, checked against the cited code)';
const BULLET_CHARACTERS = 320;

/**
 * The catch-all is a developer's brief for a code step. A step with no known output kind whose name
 * matches none of the profiles above (a user-defined workflow's own steps, typically) is profiled by
 * the document task it declares instead, so an analysis or summary step is not handed "What a change
 * touches" first.
 */
const TASK_PROFILES = Object.freeze({ clarify: 'intake', analyze: 'verification', reason: 'design', summarize: 'release' });

/**
 * A declared output kind (or a code task) names the reader, whatever the step is called: a code step
 * named `implement-story` matched "story" and was handed the product owner's brief. A name match for
 * the same reader still refines it (`fix-spec` keeps its reproduction brief). Document tasks stay
 * below a matching name: `analyze` is declared by intake, check and convergence steps alike.
 */
const KIND_PROFILES = Object.freeze({
  intake: 'intake', 'poc-intake': 'intake', 'design-intake': 'intake', requirements: 'intake',
  design: 'design', 'design-inventory': 'design', 'delivery-plan': 'design',
  reproduction: 'reproduction', 'implementation-spec': 'implementation-spec', 'fix-design': 'implementation-spec',
  'component-mapping': 'implementation-spec', 'implementation-summary': 'implementation',
  'test-evidence': 'verification', 'visual-test-evidence': 'verification', 'convergence-report': 'verification',
  'conformance-report': 'conformance', 'publication-review': 'release'
});

export function phaseBriefProfile(phase, { maxBytes = null, task = null, kind = null } = {}) {
  const id = String(phase ?? '').toLowerCase();
  const declaredId = Object.hasOwn(KIND_PROFILES, kind ?? '') ? KIND_PROFILES[kind] : task === 'code' ? 'implementation' : null;
  const declared = PHASE_BRIEF_PROFILES.find((entry) => entry.id === declaredId) ?? null;
  const named = PHASE_BRIEF_PROFILES.find((entry) => new RegExp(entry.pattern, 'u').test(id));
  let profile = declared && (named.pattern === '.*' || named.reader !== declared.reader) ? declared : named;
  if (profile.pattern === '.*' && !declared && Object.hasOwn(TASK_PROFILES, task ?? '')) {
    profile = PHASE_BRIEF_PROFILES.find((entry) => entry.id === TASK_PROFILES[task]);
  }
  return { ...profile, budget: Number.isInteger(maxBytes) ? maxBytes : profile.budget };
}

function words(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[a-z][a-z0-9]{2,}/gu) ?? []);
}

/** `(OrderService.java:22)`, or the full path when two cited files share a name. */
function sourceLabeler(sources) {
  const byName = new Map();
  for (const source of sources.flat()) {
    if (!source?.path) continue;
    const name = path.posix.basename(source.path);
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(source.path);
  }
  const one = (source) => {
    if (!source?.path) return '';
    const name = path.posix.basename(source.path);
    const shown = byName.get(name)?.size > 1 ? source.path : name;
    if (source.heading) return `${shown} › ${String(source.heading).split(' › ').pop()}`;
    return source.line ? `${shown}:${source.line}` : shown;
  };
  // A bullet may cite its code and its docs: "(OrderService.java:23; README.md › Business rules)".
  return (source) => (Array.isArray(source) ? [...new Set(source.map(one).filter(Boolean))].slice(0, 2).join('; ') : one(source));
}

function clip(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return value.length > BULLET_CHARACTERS ? `${value.slice(0, BULLET_CHARACTERS - 1)}…` : value;
}

/**
 * Bare fact types collapse into one counted entry, and an entry another one already begins with
 * (`calls are matched by name`) is dropped, so the closing line stays one short sentence.
 */
function collapseNotKnown(entries) {
  const types = [];
  const other = [];
  for (const entry of entries) {
    if (/^[a-z][a-z0-9-]*$/u.test(entry)) { if (!types.includes(entry)) types.push(entry); }
    else if (!other.some((known) => known.startsWith(entry) || entry.startsWith(known))) other.push(entry);
    else if (entry.length > (other.find((known) => entry.startsWith(known)) ?? entry).length) other[other.findIndex((known) => entry.startsWith(known))] = entry;
  }
  const named = types.length > 3 ? `${types.slice(0, 3).join(', ')} and ${types.length - 3} more` : types.join(', ');
  return [...(types.length ? [`no registered producer for ${named}`] : []), ...other];
}

/** A stable ID for a template line, so a receipt and a model phrasing can name it. */
function templateId(section, text) {
  return `T-${createHash('sha256').update(`${section}\u0000${text}`).digest('hex').slice(0, 12)}`;
}

/**
 * A model's sentence in place of the lines it covers: at the first one's place, citing all of their
 * sources. A rule keeps its status, which the brief adds; a sentence naming a line that is not in
 * this section any more is skipped.
 */
function applyPhrasing(sections, sentences) {
  let phrased = 0;
  for (const [id, entries] of sections) {
    const at = new Map(entries.map((entry, index) => [entry.id, index]));
    const replaced = new Map();
    for (const sentence of sentences.filter((entry) => entry.section === id)) {
      const indexes = sentence.cites.map((cite) => at.get(cite));
      if (!indexes.length || indexes.some((index) => index == null || replaced.has(index))) continue;
      const covered = indexes.map((index) => entries[index]);
      const status = covered[0].status;
      const text = status ? `${sentence.text.replace(/[.\s]+$/u, '')}. ${status}` : sentence.text;
      replaced.set(indexes[0], {
        ...covered[0], text: clip(text), ids: sentence.cites, phrased: true,
        source: covered.flatMap((entry) => [entry.source].flat()).filter(Boolean)
      });
      for (const index of indexes.slice(1)) replaced.set(index, null);
      phrased += 1;
    }
    sections.set(id, entries.flatMap((entry, index) => (replaced.has(index) ? (replaced.get(index) ? [replaced.get(index)] : []) : [entry])));
  }
  return phrased;
}

/**
 * Render the brief. `template` is `templateBrief(briefEvidence(…))` (null when knowledge is off or
 * unavailable); `explanations` are accepted plain-language sentences; `phrasing` is a model's
 * checked sentences over the lines a template render selected (see brief-polish.mjs). The text never
 * exceeds `profile.budget` bytes except for its header and closing lines. `records` are the IDs of
 * the lines it includes, for the prompt receipt; `selection` is those lines, for a model to phrase.
 */
export function renderPhaseBrief({
  repository = 'repository', commit = null, profile, focus = null, template = null,
  explanations = [], notKnown = [], phase = null, rules = null, questions = null, contracts = null,
  flows = null, impact = null, risks = null, phrasing = null
}) {
  const focusWords = words(focus);
  const sections = new Map(Object.keys(SECTION_TITLES).map((id) => [id, []]));
  const shown = new Set();
  // `facts` is what a model phrasing this line may draw on; `status` is a rule's, which stays the brief's own words.
  const push = (section, text, source, { id = null, facts = null, status = null } = {}) => {
    const value = clip(text);
    const key = value.toLowerCase();
    if (!value || shown.has(key)) return;
    shown.add(key);
    sections.get(section)?.push({ section, text: value, source, id: id ?? templateId(section, value), facts: facts ?? value, status });
  };
  // Rule records (docs, code and tests linked, each with its status) replace the template's rules and questions.
  if (rules) {
    for (const record of rules) {
      const status = ruleStatusWords(record);
      const said = (record.quotes ?? []).map((quote) => `the docs say: ${quote}`);
      // A person's confirmed meaning replaces the code's wording while its lines are the ones confirmed.
      const confirmed = record.meaning?.current ? `${meaningText(record.meaning)}. Meaning confirmed by a person.` : null;
      push('rules', `${confirmed ?? `${record.text.replace(/[.\s]+$/u, '')}.`} ${status}`, [...record.sources.code, ...record.sources.docs], {
        id: record.id, status, facts: [confirmed ? record.text : null, ...said, record.conflict ? `conflict: ${record.conflict}` : null].filter(Boolean).join(' | ') || null
      });
    }
  }
  for (const question of questions ?? []) push('questions', question.text, question.source, { id: question.record ? `Q-${question.record.slice(2)}` : null });
  // Contract records (endpoints with their request, response and statuses; seams; storage; calls) replace the template's contracts.
  for (const record of contracts ?? []) {
    const tested = record.category === 'endpoint' && record.tested != null ? (record.tested ? '; tested' : '; no test reaches it') : '';
    push('contracts', `${record.text}${tested}`, record.sources.code, { id: record.id });
  }
  // Flow, impact and risk records replace the template's when there are any. With no changed or
  // planned file, the template's impact (what depends on the functions the Story names) stays.
  for (const record of flows ?? []) push('flows', record.text, record.sources.code, { id: record.id });
  // A file-level record begins with its path, so it needs no citation after it.
  for (const record of impact ?? []) push('impact', record.text, record.scope === 'file' ? null : record.sources.code, { id: record.id });
  for (const record of risks ?? []) push('risks', `${record.change === 2 ? '(changed by this Story) ' : ''}${record.text}`, record.scope === 'file' ? null : record.sources.code, { id: record.id });
  const replaced = { rules, questions, contracts, flows: flows?.length ? flows : null, impact: impact?.length ? impact : null, risks: risks?.length ? risks : null };
  for (const id of Object.keys(SECTION_TITLES)) {
    if (replaced[id]) continue;
    for (const statement of template?.views?.[id] ?? []) {
      const source = statement.sources?.[0] ?? null;
      const heading = source?.label?.includes(' › ') ? source.label.split(' › ').slice(1).join(' › ') : null;
      push(id, statement.text, source ? { path: source.path, line: source.line ?? null, heading } : null);
    }
  }
  const phrased = phrasing?.sentences?.length ? applyPhrasing(sections, phrasing.sentences) : 0;
  const order = profile.reader === 'product' ? profile.order : profile.order.filter((id) => id !== 'questions');
  const label = sourceLabeler([...sections.values()].flat().map((entry) => entry.source));
  const header = `# Repository brief: ${repository}${commit ? ` at ${String(commit).slice(0, 12)}` : ''} (for ${profile.id}${focusWords.size ? ', focused on this Story' : ''}${phrased ? '; phrased by a model' : ''})`;
  const unknown = collapseNotKnown(notKnown);
  const footer = [
    ...(unknown.length ? [`Not known: ${unknown.join('; ')}.`] : []),
    phrased
      ? `Read from the committed source; ${phrased} ${phrased === 1 ? 'line was' : 'lines were'} phrased by ${phrasing.model ?? 'a model'}, each checked against the records it cites. Open the cited lines before relying on a detail.`
      : 'Read without a model from the committed source. Open the cited lines before relying on a detail.'
  ];
  const body = [];
  const pointer = (count) => `- … ${count} more: singularity-flow wm brief${phase ? ` --phase ${phase}` : ''}`;
  // The whole brief fits the budget: header, closing lines and the "more" pointer are set aside first.
  let remaining = profile.budget - Buffer.byteLength(`${header}\n\n${footer.join('\n')}\n${pointer(99)}\n\n`);
  let omitted = 0;
  const kept = [];
  // Sections share what is left: the first may take more than an even share, so one long list
  // cannot crowd out every section after it.
  const addSection = (title, entries, sectionsLeft, first) => {
    if (!entries.length) return;
    const share = Math.min(remaining, Math.floor((remaining / Math.max(1, sectionsLeft)) * (first ? 1.6 : 1)));
    const lines = [];
    let size = Buffer.byteLength(`## ${title}\n\n`);
    for (const entry of entries) {
      const source = label(entry.source);
      const line = `- ${entry.text}${source ? ` (${source})` : ''}`;
      const bytes = Buffer.byteLength(`${line}\n`);
      if (size + bytes > share) { omitted += 1; continue; }
      lines.push(line);
      kept.push({ ...entry, label: source });
      size += bytes;
    }
    if (!lines.length) return;
    body.push(`## ${title}`, ...lines, '');
    remaining -= size;
  };
  const explained = explanations.slice(0, 2).map((entry) => ({
    text: entry.text, source: entry.citations?.[0] ? { path: entry.citations[0].path, line: entry.citations[0].lines?.[0] ?? null } : null
  }));
  const filled = order.filter((id) => (sections.get(id) ?? []).length);
  addSection(EXPLANATIONS_TITLE, explained, filled.length + 1, false);
  filled.forEach((id, index) => addSection(SECTION_TITLES[id], sections.get(id), filled.length - index, index === 0));
  if (omitted) body.push(pointer(omitted), '');
  const lines = kept.filter((entry) => entry.id);
  return {
    text: [header, '', ...body, ...footer].join('\n').trimEnd(), omitted, included: kept.length, phrased,
    records: lines.flatMap((entry) => entry.ids ?? [entry.id]),
    // Explanations are model-written already, and a phrased line is phrased; neither is offered again.
    selection: lines.filter((entry) => !entry.phrased).map(({ id, section, text, facts, status, label: cited }) => ({ id, section, text, facts, status, label: cited }))
  };
}
