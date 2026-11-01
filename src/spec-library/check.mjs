/**
 * The quality report of a specification draft (SPEC-SPA v1.3 §5). No model is called.
 *
 * - D, deterministic: the existing analyzer, unchanged, run in `enforce` (every finding it reports
 *   blocks; its advisories are shown), plus the library's own rules: its sections, at least one
 *   clause, literal anchors in the specification's own namespace, no template placeholders, every
 *   decided or deferred gap stated, cited code still current, every code fact cited.
 * - A, assisted: checklist findings Copilot proposed and a person settles. Without a Copilot run it
 *   is "not run", which is allowed and recorded.
 * - H, human: open gaps, and the person's decision on each starter checklist article.
 * A reviewed publication needs every D rule passed, no A finding pending, and nothing open in H.
 */
import { normalizeMarkdownHeading } from '../markdown-structure.mjs';
import { analyzeSpecification } from '../specification-quality.mjs';
import { foldChecklist, foldGaps } from './draft-model.mjs';
import { verifyResearch } from './research.mjs';

/** Sections the library adds to the analyzer's own (Actors, User scenarios, Requirements). */
export const LIBRARY_SECTIONS = Object.freeze(['Outcome', 'Scope', 'Acceptance', 'Decisions and open questions']);
const DECISIONS_SECTION = 'decisions and open questions';
const ANCHOR = /\[([A-Z0-9][A-Z0-9._-]*):(REQ|BEH|IFC|AC|CON)-\d{3}\]/gu;
const ESCAPED_ANCHOR = /\\\[[A-Z0-9][A-Z0-9._-]*:(?:REQ|BEH|IFC|AC|CON)-\d{3}\\?\]/u;
const PLACEHOLDER = /\bTODO\b/u;
// The decision the template once gave as its example. A draft started from it still carries the
// sentence: it read as a real decision and, naming GAP-001, counted as stating that gap.
const TEMPLATE_EXAMPLE = /for example "GAP-001: exactly INR 5000\.00 gets no discount\."/u;

const RULES = Object.freeze([
  ['analyzer', 'Specification analyzer (enforce)'],
  ['sections', 'Library sections present'],
  ['clauses', 'At least one clause'],
  ['anchors', 'Literal clause anchors in the specification\'s namespace'],
  ['placeholders', 'No template placeholders left'],
  ['decisions-stated', 'Every decided or deferred gap is stated'],
  ['research-current', 'Cited code still matches'],
  ['citations', 'Every code fact is cited']
]);

function headings(markdown) {
  const found = [];
  let fenced = false;
  for (const line of String(markdown).split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    const match = !fenced && /^#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) found.push(normalizeMarkdownHeading(match[1]));
  }
  return found;
}

/** The text of one `##`-or-deeper section, up to the next heading of its level or above. */
function sectionText(markdown, title) {
  const lines = String(markdown).split(/\r?\n/u);
  let level = 0;
  const kept = [];
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) {
      if (level && match[1].length <= level) break;
      if (!level && normalizeMarkdownHeading(match[2]) === title) { level = match[1].length; continue; }
    }
    if (level) kept.push(line);
  }
  return level ? kept.join('\n') : null;
}

function lineNumbers(markdown, pattern) {
  return String(markdown).split(/\r?\n/u).flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
}

/** The whole quality report for one draft head. `ref` is the commit code research is verified at. */
export function checkDraft(root, specId, draft, { ref = 'HEAD', commit = null, sequence = null, assisted = { status: 'not-run', pending: [], settled: [] } } = {}) {
  const findings = Object.fromEntries(RULES.map(([id]) => [id, []]));
  let analysis = null;
  try {
    analysis = analyzeSpecification(draft.spec, { namespace: specId, policy: { mode: 'enforce' } });
    for (const finding of analysis.findings) findings.analyzer.push({ code: `analyzer.${finding.kind}`, message: finding.message });
  } catch (error) {
    findings.analyzer.push({ code: 'analyzer.refused', message: error.message });
  }

  const present = new Set(headings(draft.spec));
  for (const section of LIBRARY_SECTIONS) {
    if (!present.has(normalizeMarkdownHeading(section))) findings.sections.push({ code: 'spec.section-missing', message: `the specification has no '${section}' section`, section });
  }
  if (analysis && !analysis.clauseCount) findings.clauses.push({ code: 'spec.no-clauses', message: 'the specification has no clause with a literal anchor such as [' + specId + ':REQ-001]' });
  const escaped = lineNumbers(draft.spec, ESCAPED_ANCHOR);
  if (escaped.length) findings.anchors.push({ code: 'spec.anchor-escaped', message: `clause anchors are written escaped (\\[…]) on line${escaped.length === 1 ? '' : 's'} ${escaped.join(', ')}; write them literally`, lines: escaped });
  const foreign = [...new Set([...String(draft.spec).matchAll(ANCHOR)].map((match) => match[1]).filter((namespace) => namespace !== specId))];
  if (foreign.length) findings.anchors.push({ code: 'spec.anchor-namespace', message: `clause anchors use ${foreign.join(', ')}; a specification's clauses use its own ID, ${specId}`, namespaces: foreign });
  const placeholders = lineNumbers(draft.spec, PLACEHOLDER);
  if (placeholders.length) findings.placeholders.push({ code: 'spec.placeholder', message: `template placeholders (TODO) remain on line${placeholders.length === 1 ? '' : 's'} ${placeholders.join(', ')}`, lines: placeholders });
  const examples = lineNumbers(draft.spec, TEMPLATE_EXAMPLE);
  if (examples.length) findings.placeholders.push({ code: 'spec.template-example', message: `the template's example decision ("GAP-001: exactly INR 5000.00 gets no discount") remains on line${examples.length === 1 ? '' : 's'} ${examples.join(', ')}; replace it with this specification's own decisions`, lines: examples });

  const gaps = foldGaps(draft.gaps);
  const decisionsText = (sectionText(draft.spec, DECISIONS_SECTION) ?? '').replace(new RegExp(TEMPLATE_EXAMPLE.source, 'gu'), '');
  for (const gap of gaps.filter((entry) => entry.status !== 'open')) {
    if (!new RegExp(`\\b${gap.id}\\b`, 'u').test(decisionsText)) {
      findings['decisions-stated'].push({ code: 'spec.decision-unstated', message: `${gap.id} is ${gap.status} but its outcome is not stated under 'Decisions and open questions'`, gap: gap.id });
    }
  }

  const verification = verifyResearch(root, draft.research, { ref });
  for (const entry of verification) {
    if (entry.status === 'stale') findings['research-current'].push({ code: 'spec.research-stale', message: `${entry.id} is stale: ${entry.reason}; refresh research or remove it`, item: entry.id });
    if (entry.status === 'uncited') findings.citations.push({ code: 'spec.citation-unverified', message: `${entry.id} is a code fact with no verifiable citation`, item: entry.id });
  }

  const rules = RULES.map(([id, label]) => ({ id, label, passed: findings[id].length === 0, findings: findings[id] }));
  const articles = foldChecklist(draft.checklist);
  const human = {
    gaps: {
      open: gaps.filter((gap) => gap.status === 'open').map((gap) => gap.id),
      decided: gaps.filter((gap) => gap.status === 'decided').map((gap) => gap.id),
      deferred: gaps.filter((gap) => gap.status === 'deferred').map((gap) => gap.id)
    },
    articles: articles.map(({ article, decision }) => ({ article, decision: decision?.decision ?? null, reason: decision?.reason ?? null })),
    undecided: articles.filter((entry) => !entry.decision).map((entry) => entry.article)
  };
  const blocking = [
    ...rules.flatMap((rule) => rule.findings.map((finding) => ({ part: 'D', rule: rule.id, ...finding }))),
    ...(assisted.pending ?? []).map((finding) => ({ part: 'A', code: 'spec.assisted-pending', message: `assisted finding ${finding.id} is not settled`, finding: finding.id })),
    ...human.gaps.open.map((gap) => ({ part: 'H', code: 'spec.gap-open', message: `${gap} is open`, gap })),
    ...human.undecided.map((article) => ({ part: 'H', code: 'spec.article-undecided', message: `checklist article '${article}' has no decision`, article }))
  ];
  return {
    specId,
    draftSequence: sequence,
    verifiedAt: commit,
    analyzer: analysis ? {
      mode: analysis.mode, clauseCount: analysis.clauseCount, clauseIds: analysis.clauseIds,
      advisories: (analysis.advisories ?? []).map((entry) => entry.message), disclaimer: analysis.disclaimer
    } : null,
    deterministic: { passed: rules.filter((rule) => rule.passed).length, total: rules.length, rules },
    assisted: { status: assisted.status, pending: assisted.pending ?? [], settled: assisted.settled ?? [] },
    human,
    research: verification,
    counts: {
      d: { passed: rules.filter((rule) => rule.passed).length, total: rules.length },
      a: { status: assisted.status, pending: (assisted.pending ?? []).length },
      h: { open: human.gaps.open.length + human.undecided.length, deferred: human.gaps.deferred.length }
    },
    blocking,
    reviewReady: blocking.length === 0
  };
}
