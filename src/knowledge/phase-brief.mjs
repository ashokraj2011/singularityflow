/**
 * The repository brief a phase prompt receives.
 *
 * It is built without a model from what already exists: repository knowledge (rules with their
 * messages and statuses, endpoints, data shapes, flows, impact, history) and README and docs
 * statements. Items are ranked by the Story's own words and changed files, ordered for the phase's
 * reader, and cut to a small per-phase budget. Every bullet names its source as a file and line;
 * what could not be determined is one closing "Not known" line.
 */
import path from 'node:path';

import { ruleStatusWords } from './records/rules.mjs';

export const PHASE_BRIEF_RENDERER = Object.freeze({ id: 'repository-brief', version: 1 });

/**
 * Per-phase reader, budget and section order, matched on the phase ID, first match wins. The
 * budgets are defaults: `worldModel.knowledge.maxBytes` replaces them for every phase.
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

export function phaseBriefProfile(phase, { maxBytes = null } = {}) {
  const id = String(phase ?? '').toLowerCase();
  const profile = PHASE_BRIEF_PROFILES.find((entry) => new RegExp(entry.pattern, 'u').test(id));
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

/**
 * Render the brief. `template` is `templateBrief(briefEvidence(…))` (null when knowledge is off or
 * unavailable); `explanations` are accepted plain-language
 * sentences. The text never exceeds `profile.budget` bytes except for its header and closing lines.
 */
export function renderPhaseBrief({
  repository = 'repository', commit = null, profile, focus = null, template = null,
  explanations = [], notKnown = [], phase = null, rules = null, questions = null, contracts = null,
  flows = null, impact = null, risks = null
}) {
  const focusWords = words(focus);
  const sections = new Map(Object.keys(SECTION_TITLES).map((id) => [id, []]));
  const shown = new Set();
  const push = (section, text, source) => {
    const value = clip(text);
    const key = value.toLowerCase();
    if (!value || shown.has(key)) return;
    shown.add(key);
    sections.get(section)?.push({ text: value, source });
  };
  // Rule records (docs, code and tests linked, each with its status) replace the template's rules and questions.
  if (rules) {
    for (const record of rules) {
      push('rules', `${record.text.replace(/[.\s]+$/u, '')}. ${ruleStatusWords(record)}`, [...record.sources.code, ...record.sources.docs]);
    }
  }
  for (const question of questions ?? []) push('questions', question.text, question.source);
  // Contract records (endpoints with their request, response and statuses; seams; storage; calls) replace the template's contracts.
  for (const record of contracts ?? []) {
    const tested = record.category === 'endpoint' && record.tested != null ? (record.tested ? '; tested' : '; no test reaches it') : '';
    push('contracts', `${record.text}${tested}`, record.sources.code);
  }
  // Flow, impact and risk records replace the template's when there are any. With no changed or
  // planned file, the template's impact (what depends on the functions the Story names) stays.
  for (const record of flows ?? []) push('flows', record.text, record.sources.code);
  // A file-level record begins with its path, so it needs no citation after it.
  for (const record of impact ?? []) push('impact', record.text, record.scope === 'file' ? null : record.sources.code);
  for (const record of risks ?? []) push('risks', `${record.change === 2 ? '(changed by this Story) ' : ''}${record.text}`, record.scope === 'file' ? null : record.sources.code);
  const replaced = { rules, questions, contracts, flows: flows?.length ? flows : null, impact: impact?.length ? impact : null, risks: risks?.length ? risks : null };
  for (const id of Object.keys(SECTION_TITLES)) {
    if (replaced[id]) continue;
    for (const statement of template?.views?.[id] ?? []) {
      const source = statement.sources?.[0] ?? null;
      const heading = source?.label?.includes(' › ') ? source.label.split(' › ').slice(1).join(' › ') : null;
      push(id, statement.text, source ? { path: source.path, line: source.line ?? null, heading } : null);
    }
  }
  const order = profile.reader === 'product' ? profile.order : profile.order.filter((id) => id !== 'questions');
  const label = sourceLabeler([...sections.values()].flat().map((entry) => entry.source));
  const header = `# Repository brief: ${repository}${commit ? ` at ${String(commit).slice(0, 12)}` : ''} (for ${profile.id}${focusWords.size ? ', focused on this Story' : ''})`;
  const unknown = collapseNotKnown(notKnown);
  const footer = [
    ...(unknown.length ? [`Not known: ${unknown.join('; ')}.`] : []),
    'Read without a model from the committed source. Open the cited lines before relying on a detail.'
  ];
  const body = [];
  const pointer = (count) => `- … ${count} more: singularity-flow wm brief${phase ? ` --phase ${phase}` : ''}`;
  // The whole brief fits the budget: header, closing lines and the "more" pointer are set aside first.
  let remaining = profile.budget - Buffer.byteLength(`${header}\n\n${footer.join('\n')}\n${pointer(99)}\n\n`);
  let omitted = 0;
  let included = 0;
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
      included += 1;
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
  return { text: [header, '', ...body, ...footer].join('\n').trimEnd(), omitted, included };
}
