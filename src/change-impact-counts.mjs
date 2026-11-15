/**
 * Change impact counts [SPEC-CIC v1.1 stage 7; CIC:REQ-017]: per Story, what its requirement changes did, as counts.
 *
 * For each approved intent amendment and for the Story: revisions by class (editorial, refinement, material, or
 * unclassed where change impact is off), cone size (the clauses whose evidence the change made stale, and the later
 * steps with published work it reached), widened share (of those steps, the ones reached only because what they
 * depended on is not fully recorded), evidence items kept, "still holds" questions and their answers, steps reset and
 * the generations they published again since, and publications refused because their draft predates the amendment.
 * Then the Story's churn: clause changes, clauses changed more than once, and clauses that went back to an earlier
 * statement.
 *
 * Each count is derived from records the Story already keeps wherever it can be: the amendment's own summary (its stale
 * clauses, affected and kept steps, preserved evidence, class and "still holds" rows), the scope revision it recorded
 * (each later step's generation then), the steps' generation publications and pins, and the answers. Three facts no
 * earlier record holds are recorded from stage 7 on, additive only (D3, REQ-019): the steps reached only because their
 * record was incomplete and the evidence an editorial change carried (the approval's `impactCounts`, under a switch),
 * and each refused publication (`refusedPublications`: amendment, step and generation). Each count says whether it was
 * recorded or derived; a Story pinned before stage 7 says which it did not record. Content is never read into a count:
 * counts, and amendment IDs, only.
 *
 * Pure and model-free: a function of the Story's records. Loaded only by the Story report (`singularity-flow report`
 * and the report read), which renders the section here.
 */
import { scopeStepOf } from './phase-roles.mjs';
import { clauseChurn } from './report.mjs';

export const CHANGE_IMPACT_COUNTS = 'change-impact-counts/v1';

const APPROVED = new Set(['approved', 'revalidated']);
const CLASSES = Object.freeze(['editorial', 'refinement', 'material']);
const list = (value) => (Array.isArray(value) ? value : []);
const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const time = (value) => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : null; };
const percent = (part, whole) => (whole > 0 && part != null ? Math.round((100 * part) / whole) : null);

/** The scope revision an approved amendment recorded, by its digest. */
function revisionOf(workflow, summary) {
  const wanted = summary?.scopeRevision;
  if (!wanted) return null;
  const revisions = list(workflow?.scopeRevisions);
  return revisions.find((revision) => wanted.revisionSha256 && revision?.revisionSha256 === wanted.revisionSha256)
    ?? revisions.find((revision) => revision?.origin?.id === summary.id && Number(revision?.revision) === Number(wanted.revision)) ?? null;
}

/** The steps after the scope when the amendment was approved: the ones its revision lists, else those after the scope step. */
function laterSteps(workflow, revision) {
  const listed = revision?.dependentGenerations;
  if (listed && typeof listed === 'object') return Object.keys(listed);
  const order = list(workflow?.phaseOrder);
  let scope = null;
  try { scope = scopeStepOf(workflow)?.id ?? null; } catch { scope = null; }
  const index = order.indexOf(scope);
  return index < 0 ? [] : order.slice(index + 1);
}

/**
 * A step's generation when the amendment was approved: what its scope revision recorded, else the latest it had
 * published by the decision's time, else none.
 */
function generationAt(workflow, phaseId, summary, revision) {
  const listed = revision?.dependentGenerations?.[phaseId];
  if (listed !== undefined) return count(listed);
  const decided = time(summary?.decidedAt);
  const published = list(workflow?.phases?.[phaseId]?.generationPublications)
    .filter((entry) => decided != null && time(entry?.publishedAt) != null && time(entry.publishedAt) <= decided)
    .map((entry) => count(entry.generation));
  return published.length ? Math.max(...published) : 0;
}

/** Whether approving it reset nothing: approved as editorial, or it only brought the scope in line with a conformance report. */
function resetsNothing(summary) {
  if (summary?.carried === 'editorial') return true;
  if (summary?.acknowledgementRequired === false && !summary.acknowledgedAt) return true;
  const rows = list(summary?.revalidate);
  return rows.length > 0 && rows.every((row) => !row?.reason);
}

/**
 * The steps it reset that had started: each it did not keep that had published a generation by then, or whose
 * unpublished work its pin set aside (SPEC-CIC switch 2): as the approval recorded them (`impactCounts.setAside`), else
 * as the step's pin still says. A step that had not started reads the amended scope anyway.
 */
function resetSteps(workflow, summary, revision, record) {
  if (resetsNothing(summary)) return [];
  const kept = new Set(list(summary.retainedPhases));
  const setAside = (id) => {
    if (Array.isArray(record?.setAside)) return record.setAside.includes(id);
    const pin = workflow?.phases?.[id]?.scopePin;
    return pin?.amendment === summary.id && Boolean(pin.setAside);
  };
  return laterSteps(workflow, revision).filter((id) => !kept.has(id)).map((id) => ({ id, generation: generationAt(workflow, id, summary, revision) }))
    .filter(({ id, generation }) => generation > 0 || setAside(id));
}

/** The approval's own stage 7 record, when it has one. */
const impactRecord = (summary) => (summary?.impactCounts && typeof summary.impactCounts === 'object' ? summary.impactCounts : null);

/** The generations a step published after `from`, up to `to` (inclusive), from its generation publications. */
function publishedBetween(phase, from, to) {
  const generations = [...new Set(list(phase?.generationPublications).map((entry) => count(entry.generation)))];
  const known = generations.length ? generations : Array.from({ length: Math.max(0, count(phase?.generation)) }, (_, index) => index + 1);
  return known.filter((generation) => generation > from && generation <= to).length;
}

/** "Still holds" rows the amendment asked, and their answers: still holds, redo, still open, or no longer asked. */
function stillHoldsOf(workflow, summary) {
  const counts = { asked: 0, answered: 0, stillHolds: 0, redo: 0, open: 0, lapsed: 0 };
  const answers = list(workflow?.amendmentRevalidations);
  for (const row of list(summary?.revalidate)) {
    counts.asked += 1;
    const answer = answers.findLast((entry) => entry?.amendment === summary.id && entry.phase === row?.phase);
    if (answer?.outcome === 'unchanged' || answer?.outcome === 'return') {
      counts.answered += 1;
      counts[answer.outcome === 'unchanged' ? 'stillHolds' : 'redo'] += 1;
      continue;
    }
    const step = workflow?.phases?.[row?.phase];
    const owed = ['approved', 'awaiting_approval'].includes(step?.status) && Number(step?.generation) === Number(row?.generation);
    counts[owed ? 'open' : 'lapsed'] += 1;
  }
  return counts;
}

/** The weakest of several sources: any not recorded makes a total partial, any derived makes it derived. */
function combined(sources) {
  if (!sources.length) return 'derived';
  if (sources.every((source) => source === 'not-recorded')) return 'not-recorded';
  if (sources.some((source) => source === 'not-recorded' || source === 'partial')) return 'partial';
  return sources.some((source) => source === 'derived') ? 'derived' : 'recorded';
}

/** The total of the values known: none at all is 0, and only unknown ones is unknown. */
const sum = (values) => (values.length && values.every((value) => value == null) ? null : values.reduce((total, value) => total + (value ?? 0), 0));

/**
 * The counts [CIC:REQ-017], from the Story's records alone. Never throws on a Story's shape: a field it lacks counts as
 * absent, and a count no record holds is named as not recorded.
 */
export function changeImpactCounts(workflow) {
  const spec = workflow?.resolution?.spec ?? {};
  const switches = { changeImpact: spec.changeImpact === 'on' ? 'on' : 'off', observedDependencies: spec.observedDependencies === 'on' ? 'on' : 'off',
    preAmendmentDrafts: spec.preAmendmentDrafts === 'refuse' ? 'refuse' : 'legacy' };
  const summaries = list(workflow?.intentAmendments).filter((entry) => entry && typeof entry === 'object');
  const approved = summaries.filter((entry) => APPROVED.has(entry.status));
  const refusals = list(workflow?.refusedPublications);
  const resets = approved.map((summary) => resetSteps(workflow, summary, revisionOf(workflow, summary), impactRecord(summary)));
  const perAmendment = approved.map((summary, index) => {
    const revision = revisionOf(workflow, summary);
    const record = impactRecord(summary);
    const reached = list(summary.affectedPhases).filter((id) => generationAt(workflow, id, summary, revision) > 0).length;
    const widened = switches.observedDependencies === 'off' ? { steps: 0, source: 'derived' }
      : Array.isArray(record?.widened) ? { steps: record.widened.length, source: 'recorded' } : { steps: null, source: 'not-recorded' };
    const evidence = summary.carried === 'editorial'
      ? (Number.isInteger(record?.carriedEvidence) ? { value: record.carriedEvidence, source: 'recorded' } : { value: null, source: 'not-recorded' })
      : { value: list(summary.preservedEvidence).length, source: 'recorded' };
    const refused = refusals.filter((entry) => entry?.amendment === summary.id).length;
    const refusedCount = switches.preAmendmentDrafts === 'legacy' ? { value: 0, source: 'derived' }
      : record || refused ? { value: refused, source: 'recorded' } : { value: null, source: 'not-recorded' };
    // Each step it reset, until a later amendment reset that step again: what it published since is this one's rework.
    const redone = resets[index].reduce((total, step) => {
      const next = resets.slice(index + 1).map((later) => later.find((entry) => entry.id === step.id)).find(Boolean);
      return total + publishedBetween(workflow.phases?.[step.id], step.generation, next ? next.generation : Infinity);
    }, 0);
    const klass = CLASSES.includes(summary.class) ? summary.class : null;
    const sources = { class: klass ? 'recorded' : 'derived', cone: 'derived', widened: widened.source, evidenceKept: evidence.source, stillHolds: 'recorded',
      stepsReset: 'derived', generationsRedone: 'derived', publicationsRefused: refusedCount.source };
    return { amendment: String(summary.id ?? ''), class: klass,
      cone: { clauses: list(summary.staleClauses).length, steps: reached },
      widened: { steps: widened.steps, percent: percent(widened.steps, reached) },
      evidenceKept: evidence.value, stillHolds: stillHoldsOf(workflow, summary),
      stepsReset: resets[index].length, generationsRedone: redone, publicationsRefused: refusedCount.value, sources };
  });
  const field = (name) => perAmendment.map((entry) => entry.sources[name]);
  const stillHolds = Object.fromEntries(['asked', 'answered', 'stillHolds', 'redo', 'open', 'lapsed']
    .map((name) => [name, perAmendment.reduce((total, entry) => total + entry.stillHolds[name], 0)]));
  const coneSteps = perAmendment.reduce((total, entry) => total + entry.cone.steps, 0);
  const widenedKnown = perAmendment.filter((entry) => entry.widened.steps != null);
  const widenedSteps = sum(perAmendment.map((entry) => entry.widened.steps));
  const widenedOf = widenedKnown.reduce((total, entry) => total + entry.cone.steps, 0);
  const { changed, reversed } = clauseChurn({ intentAmendments: approved.map((entry) => ({ status: entry.status, changedClauses: list(entry.changedClauses) })),
    scopeRevisions: list(workflow?.scopeRevisions).filter((revision) => revision && typeof revision === 'object').map((revision) => ({ clauses: list(revision.clauses).filter((clause) => clause && typeof clause === 'object') })) });
  const revisionsByClass = Object.fromEntries([...CLASSES, 'unclassed'].map((name) => [name, perAmendment.filter((entry) => (entry.class ?? 'unclassed') === name).length]));
  return {
    schema: CHANGE_IMPACT_COUNTS,
    switches,
    amendments: { proposed: summaries.length, approved: approved.length,
      rejected: summaries.filter((entry) => entry.status === 'rejected').length, pending: summaries.filter((entry) => entry.status === 'proposed').length },
    revisionsByClass,
    perAmendment,
    totals: {
      cone: { clauses: perAmendment.reduce((total, entry) => total + entry.cone.clauses, 0), steps: coneSteps },
      // Of the steps reached by the amendments whose widening is known.
      widened: { steps: widenedSteps, of: widenedOf, percent: percent(widenedSteps, widenedOf) },
      evidenceKept: sum(perAmendment.map((entry) => entry.evidenceKept)),
      stillHolds,
      stepsReset: perAmendment.reduce((total, entry) => total + entry.stepsReset, 0),
      generationsRedone: perAmendment.reduce((total, entry) => total + entry.generationsRedone, 0),
      // Every refusal recorded, whichever amendment it names.
      publicationsRefused: perAmendment.length && perAmendment.every((entry) => entry.publicationsRefused == null) && !refusals.length ? null : refusals.length
    },
    churn: { clauseChanges: [...changed.values()].reduce((total, times) => total + times, 0),
      clausesChangedAgain: [...changed.values()].filter((times) => times >= 2).length,
      reversals: [...reversed.values()].reduce((total, times) => total + times, 0) },
    sources: { revisionsByClass: combined(field('class')), cone: 'derived', widened: combined(field('widened')), evidenceKept: combined(field('evidenceKept')),
      stillHolds: 'recorded', stepsReset: 'derived', generationsRedone: 'derived', publicationsRefused: combined(field('publicationsRefused')), churn: 'derived' },
    notRecorded: perAmendment.map((entry) => ({ amendment: entry.amendment,
      counts: Object.entries(entry.sources).filter(([, source]) => source === 'not-recorded').map(([name]) => name) })).filter((entry) => entry.counts.length)
  };
}

const CLASS_WORDS = Object.freeze({ editorial: 'editorial change', refinement: 'refinement', material: 'material change' });
const SOURCE_WORDS = Object.freeze({ recorded: 'recorded', derived: 'derived', partial: 'partly recorded', 'not-recorded': 'not recorded' });
const COUNT_WORDS = Object.freeze({ widened: 'widened share', evidenceKept: 'evidence kept', publicationsRefused: 'publications refused' });
const plural = (number, one, many = `${one}s`) => `${number} ${number === 1 ? one : many}`;
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The section's words, as one structure both renderers share: an opening line, one line per count, the table, a key. */
function sectionModel(counts, requirementChanges) {
  const { switches, amendments, revisionsByClass, totals, churn, sources, perAmendment, notRecorded } = counts;
  const tag = (source) => ` (${SOURCE_WORDS[source] ?? source})`;
  const opening = `What this Story's requirement changes did, as counts from its own records: no clause text, file contents or paths are kept in them. ${
    switches.changeImpact === 'on' ? 'Change impact is on: every change has a size, and what each step depended on is recorded.'
      : switches.observedDependencies === 'on' ? 'Observed dependencies are on: what each step depended on is recorded; changes have no size.'
        : 'Change impact is off: changes have no size, and what each step depended on is not recorded.'} ${
    switches.preAmendmentDrafts === 'refuse' ? 'A draft written before an amendment is refused at publication.' : 'Drafts written before an amendment are not checked at publication.'}`;
  const classes = [...CLASSES.filter((name) => revisionsByClass[name]).map((name) => plural(revisionsByClass[name], CLASS_WORDS[name])),
    ...(revisionsByClass.unclassed ? [`${revisionsByClass.unclassed} without a size`] : [])];
  const others = [amendments.rejected ? `${amendments.rejected} rejected` : '', amendments.pending ? `${amendments.pending} waiting for a decision` : ''].filter(Boolean);
  const lines = [`Requirement changes: ${plural(amendments.approved, 'intent amendment')} approved${classes.length ? `: ${listed(classes)}` : ''}${others.length ? `; ${listed(others)}` : ''}.${tag(sources.revisionsByClass)}`];
  lines.push(`Cone size: ${plural(totals.cone.clauses, 'clause')} (changed, or depending on a changed one) and ${plural(totals.cone.steps, 'later step')} with published work.${tag(sources.cone)}`);
  lines.push(`Widened share: ${switches.observedDependencies === 'off' ? 'none: with observed dependencies off, no step is widened'
    : totals.widened.steps == null ? 'not recorded'
      : !totals.widened.of ? 'none: no step with published work was reached'
        : `${totals.widened.steps} of ${plural(totals.widened.of, 'step')} reached (${totals.widened.percent}%) ${totals.widened.steps === 1 ? 'was' : 'were'} there only because what ${totals.widened.steps === 1 ? 'it' : 'they'} depended on is not fully recorded`}.${tag(sources.widened)}`);
  lines.push(`Evidence kept: ${totals.evidenceKept == null ? 'not recorded' : `${plural(totals.evidenceKept, 'evidence item')}, preserved as unaffected or carried as editorial`}.${tag(sources.evidenceKept)}`);
  const asked = totals.stillHolds;
  lines.push(`"Still holds": ${asked.asked ? `${plural(asked.asked, 'question')} asked: ${asked.stillHolds} still ${asked.stillHolds === 1 ? 'holds' : 'hold'}, ${asked.redo} to redo, ${asked.open} open${asked.lapsed ? `, ${asked.lapsed} no longer asked` : ''}` : 'no step was asked'}.${tag(sources.stillHolds)}`);
  lines.push(`Rework: ${plural(totals.stepsReset, 'step')} reset after ${totals.stepsReset === 1 ? 'it' : 'they'} had started, and ${plural(totals.generationsRedone, 'generation')} published again since.${tag(combined([sources.stepsReset, sources.generationsRedone]))}`);
  lines.push(`Publications refused: ${totals.publicationsRefused == null ? 'not recorded' : totals.publicationsRefused
    ? `${plural(totals.publicationsRefused, 'publication')} of a draft written before an amendment` : 'none'}.${tag(sources.publicationsRefused)}`);
  lines.push(`Churn: ${plural(churn.clauseChanges, 'clause change')}; ${churn.clausesChangedAgain ? `${plural(churn.clausesChangedAgain, 'clause')} changed more than once` : 'no clause changed more than once'}; ${
    churn.reversals ? `${plural(churn.reversals, 'time')} a clause went back to an earlier statement` : 'no clause went back to an earlier statement'}.${tag(sources.churn)}`);
  // Under switch 3 the clauses themselves, by ID, as "Requirement changes" named them [CIC:REQ-016].
  for (const entry of requirementChanges?.churn ?? []) lines.push(`\`${entry.clause}\` changed ${entry.times} times.`);
  for (const entry of requirementChanges?.reversed ?? []) lines.push(`\`${entry.clause}\` went back to an earlier statement ${entry.times === 1 ? 'once' : `${entry.times} times`}.`);
  if (notRecorded.length) {
    lines.push(`Not recorded: ${listed(notRecorded.map((entry) => `${entry.amendment} (${entry.counts.map((name) => COUNT_WORDS[name] ?? name).join(', ')})`))}, `
      + `approved before SFlow kept ${notRecorded.length === 1 && notRecorded[0].counts.length === 1 ? 'that count' : 'these counts'}.`);
  }
  const cell = (value, words = String(value)) => (value == null ? 'not recorded' : words);
  const table = perAmendment.length ? {
    head: ['Amendment', 'Size', 'Cone: clauses, steps', 'Widened', 'Evidence kept', '"Still holds": asked, answered', 'Steps reset', 'Generations redone', 'Publications refused'],
    rows: perAmendment.map((entry) => [entry.amendment, entry.class ?? 'no size', `${entry.cone.clauses}, ${entry.cone.steps}`,
      cell(entry.widened.steps, entry.widened.percent == null ? String(entry.widened.steps) : `${entry.widened.steps} (${entry.widened.percent}%)`),
      cell(entry.evidenceKept), `${entry.stillHolds.asked}, ${entry.stillHolds.answered}`, String(entry.stepsReset), String(entry.generationsRedone), cell(entry.publicationsRefused)])
  } : null;
  const key = 'Recorded: written when it happened. Derived: worked out from the Story\'s other records. Not recorded: the Story\'s records are from before SFlow kept that count.';
  return { opening, lines, table, key };
}

const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = (value) => escapeHtml(value).replace(/`([^`]+)`/gu, '<code>$1</code>');

/**
 * The Story report's "Change impact" section, Markdown (`md`) or HTML (`html`), from the counts exactly as `--json`
 * carries them, with switch 3's clause lines (report.mjs requirementChanges). Empty when the Story changed no
 * requirement and refused no publication.
 */
export function changeImpactSection(counts, { format = 'md', requirementChanges = null } = {}) {
  if (!counts) return '';
  if (counts.unavailable) {
    return format === 'html' ? `<h2>Change impact</h2>\n<p class="note">${escapeHtml(counts.unavailable)}</p>` : `## Change impact\n\n${counts.unavailable}\n`;
  }
  if (!counts.amendments?.proposed && !counts.totals?.publicationsRefused) return '';
  const { opening, lines, table, key } = sectionModel(counts, requirementChanges);
  if (format === 'html') {
    return [`<h2>Change impact</h2>`, `<p class="note">${escapeHtml(opening)}</p>`, `<ul>${lines.map((line) => `<li>${inline(line)}</li>`).join('')}</ul>`,
      ...(table ? [`<table><thead><tr>${table.head.map((name) => `<th>${escapeHtml(name)}</th>`).join('')}</tr></thead><tbody>${
        table.rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table>`] : []),
      `<p class="note">${escapeHtml(key)}</p>`].join('\n');
  }
  return [`## Change impact`, '', opening, '', ...lines.map((line) => `- ${line}`), '',
    ...(table ? [`| ${table.head.join(' | ')} |`, `|${table.head.map(() => '---').join('|')}|`, ...table.rows.map((row) => `| ${row.join(' | ')} |`), ''] : []),
    `_${key}_`, ''].join('\n');
}
