/**
 * What an approval shows a person (owner, 2026-11-21: "Too many approvals of almost similar documents is an issue", then
 * "Yes and tell reviewer what to check"). On arshy a person read six approvals, about 12,600 words, of which the
 * convergence report was 18% new, the verification evidence 37%, the release conformance 34% and the implementation
 * summary 53%; the planning approval also listed three agent briefs that restate the plan.
 *
 * Two things, read from what SFlow already knows, never from a model:
 *
 * - **What needs your eyes**: about three to eight items that need the person's judgment, each pointing at its file and
 *   line, section or requirement row: what changed since they last approved, the reviewer's findings and disputes, the
 *   runtime check's findings and its "Try it", changes outside the plan and what SFlow settled for them, requirements
 *   whose tests are weak or missing, and open risks and decisions. Everything else is one line, "checked by SFlow: …".
 *   The source reviewer keeps its own checklist by kind of software (step intents §12.4); its results feed this list.
 * - **Only what is new**: a section already approved (in an earlier version of the step, or in an earlier step the person
 *   approved) is one line, "already approved in Planning v1"; version N shows what changed since the version this
 *   person last approved; agent briefs are one line, "generated from the plan"; a document SFlow wrote from its own
 *   records is one line, checked by SFlow.
 *
 * Presentation only: the approval binds every document exactly as before, and each one opens in full.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { authoredArtifactText } from './artifact-review-read.mjs';
import { normalizeMarkdownHeading, parseMarkdownStructure } from './markdown-structure.mjs';

export const FOCUS_ITEM_LIMIT = 8;
const SECTION_TEXT_LIMIT = 6000;
const DIFF_LINE_LIMIT = 120;
const MEANINGFUL_WORDS = 4;

/**
 * How much less there is to read, in the words every surface shows: "120 of 525 words to read", or null when the list
 * and what is new come to as many words as the documents themselves (a short first version), so no count says more than all.
 */
export function focusWordsLine(words) {
  const full = Number(words?.full) || 0;
  const shown = Number(words?.shown) || 0;
  return full > 0 && shown < full ? `${shown} of ${full} words to read` : null;
}

/** The words in `text`, as a person counts them. */
export function wordCount(text) {
  return (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’._:/@-]*/gu) ?? []).length;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const quoted = (titles) => titles.map((title) => `"${title}"`).join(', ');

/** A document's lines a person reads: without SFlow's managed blocks and every comment, line numbers kept. */
function readableLines(text) {
  const visible = parseMarkdownStructure(authoredArtifactText(String(text ?? ''), { preserveLines: true })).visibleText;
  return visible.split(/\r?\n/u).map((line, index) => ({ n: index + 1, text: line.replace(/\s+$/u, '') }));
}

/**
 * A Markdown document's sections, by its second-level headings (or its first level below the title): each with its title,
 * its first line and its readable lines. Text before the first section is the preamble, titled "".
 */
export function documentSections(text) {
  const lines = readableLines(text);
  const headings = lines.map((line) => ({ ...line, match: line.text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/u) }))
    .filter((line) => line.match).map((line) => ({ n: line.n, level: line.match[1].length, title: line.match[2].trim() }));
  const levels = headings.map((heading) => heading.level).filter((level) => level >= 2);
  const level = levels.length ? Math.min(...levels) : 1;
  const sections = [{ title: '', line: 1, lines: [] }];
  for (const line of lines) {
    const heading = headings.find((entry) => entry.n === line.n);
    if (heading && heading.level <= level) {
      if (heading.level === level) sections.push({ title: heading.title, line: line.n, lines: [] });
      // The document's own title says nothing a person reads as content.
      else if (sections.length > 1) sections[sections.length - 1].lines.push(line);
      continue;
    }
    sections[sections.length - 1].lines.push(line);
  }
  return sections.map((section) => ({ ...section, key: normalizeMarkdownHeading(section.title) }))
    .filter((section) => section.title || section.lines.some((line) => line.text.trim()));
}

/** One line as compared across documents: its words only, lower case; null when too short to say anything alone. */
export function comparableLine(text) {
  const words = String(text ?? '').replace(/^[\s>#*+-]+|\|/gu, ' ').replace(/[`*_~]/gu, '').replace(/^\s*\d+[.)]\s+/u, '')
    .toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’._:/@-]*/gu) ?? [];
  return words.length >= MEANINGFUL_WORDS ? words.join(' ') : null;
}

const sectionBody = (section) => section.lines.map((line) => line.text).join('\n').trim();
const sameBody = (left, right) => sectionBody(left).replace(/\s+/gu, ' ') === sectionBody(right).replace(/\s+/gu, ' ');
// A person reads no hash (owner, 2026-11-11): a digest or commit a section quotes shows as "…"; the full document keeps it.
const HASH = /\b(?:sha256:)?[0-9a-f]{16,64}\b/gu;
const readable = (text) => String(text ?? '').replace(HASH, '…');
const bounded = (text) => { const value = readable(text); return value.length > SECTION_TEXT_LIMIT ? `${value.slice(0, SECTION_TEXT_LIMIT - 1)}…` : value; };

/** The changed lines between two sections, by their longest common run of lines; blank lines are not compared. */
export function lineDiff(before, after) {
  const left = before.filter((line) => line.text.trim()), right = after.filter((line) => line.text.trim());
  if (left.length * right.length > 250_000) {
    return [...left.map((line) => ({ op: '-', text: line.text, line: line.n })), ...right.map((line) => ({ op: '+', text: line.text, line: line.n }))];
  }
  const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) {
    table[i][j] = left[i].text.trim() === right[j].text.trim() ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const diff = [];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i].text.trim() === right[j].text.trim()) { i += 1; j += 1; }
    else if (i < left.length && (j >= right.length || table[i + 1][j] >= table[i][j + 1])) { diff.push({ op: '-', text: left[i].text, line: left[i].n }); i += 1; }
    else { diff.push({ op: '+', text: right[j].text, line: right[j].n }); j += 1; }
  }
  return diff;
}

/** `text` with each run of lines already approved elsewhere as one line saying where; a table is folded only whole. */
function withApprovedRunsFolded(section, approved) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const labels = [...new Set(run.map((line) => approved.get(comparableLine(line.text))).filter(Boolean))];
    out.push(`… ${plural(run.length, 'line')} already approved in ${labels.join(', ')}`);
    run = [];
  };
  const lines = section.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\|/u.test(line.text)) {
      let end = index;
      while (end < lines.length && /^\s*\|/u.test(lines[end].text)) end += 1;
      const table = lines.slice(index, end);
      const rows = table.slice(2).filter((row) => comparableLine(row.text));
      if (rows.length && rows.every((row) => approved.has(comparableLine(row.text)))) run.push(...rows);
      else { flush(); out.push(...table.map((row) => row.text)); }
      index = end - 1;
      continue;
    }
    const key = comparableLine(line.text);
    if (key && approved.has(key)) run.push(line);
    else if (!line.text.trim() && run.length) continue;
    else { flush(); out.push(line.text); }
  }
  flush();
  return out.join('\n').trim();
}

/** How much of a section was approved already elsewhere: its meaningful lines, those approved, and where. */
function restatement(section, approved) {
  const meaningful = section.lines.map((line) => comparableLine(line.text)).filter(Boolean);
  const found = meaningful.filter((key) => approved.has(key));
  const labels = new Map();
  for (const key of found) labels.set(approved.get(key), (labels.get(approved.get(key)) ?? 0) + 1);
  const source = [...labels.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  return { meaningful: meaningful.length, restated: found.length, source };
}

/**
 * Each section of one document as a person is shown it: `unchanged` or `restated` (folded to one line), `changed` (its
 * diff), `new` (its text, with runs approved elsewhere folded) or `removed`. `previous` is the document's text in the
 * version the person last approved; `approved` maps each line approved in an earlier step to that step's label.
 */
export function focusSections(text, { previous = null, previousLabel = null, approved = new Map() } = {}) {
  const sections = documentSections(text);
  const before = previous == null ? null : documentSections(previous);
  const used = new Set();
  const result = sections.map((section) => {
    const title = section.title || 'Introduction';
    const words = wordCount(`${section.title}\n${sectionBody(section)}`);
    const old = before?.find((entry, index) => !used.has(index) && entry.key === section.key && used.add(index));
    if (old && sameBody(old, section)) return { title, line: section.line, state: 'unchanged', words, folded: `already approved in ${previousLabel}`,
      text: bounded(sectionBody(section)) };
    if (old) {
      const diff = lineDiff(old.lines, section.lines);
      return { title, line: section.line, state: 'changed', words, added: diff.filter((entry) => entry.op === '+').length,
        removed: diff.filter((entry) => entry.op === '-').length, diff: diff.slice(0, DIFF_LINE_LIMIT).map((entry) => ({ ...entry, text: readable(entry.text) })), ...(diff.length > DIFF_LINE_LIMIT ? { diffTruncated: diff.length } : {}),
        text: bounded(sectionBody(section)) };
    }
    const seen = restatement(section, approved);
    if (seen.meaningful && seen.restated === seen.meaningful) return { title, line: section.line, state: 'restated', words, folded: `already approved in ${seen.source}`,
      text: bounded(sectionBody(section)) };
    const shown = seen.restated ? withApprovedRunsFolded(section, approved) : sectionBody(section);
    return { title, line: section.line, state: 'new', words, ...(seen.restated ? { restatedLines: seen.restated, restatedIn: seen.source } : {}), text: bounded(shown) };
  });
  for (const [index, old] of (before ?? []).entries()) {
    if (!used.has(index) && (old.title || sectionBody(old))) result.push({ title: old.title || 'Introduction', line: null, state: 'removed', words: wordCount(old.title), previousLine: old.line });
  }
  return result;
}

/** The words a person reads of one document's sections as `focusSections` shows them. */
export function shownWords(sections) {
  // Folded sections read as one line per place they were approved: "Already approved in Planning v1: Approach, Test strategy".
  return foldedLines(sections).reduce((total, line) => total + wordCount(line), 0) + sections.reduce((total, section) => total + (section.state === 'changed'
    ? wordCount(section.title) + section.diff.reduce((sum, entry) => sum + wordCount(entry.text), 0)
    : section.state === 'new' ? wordCount(`${section.title}\n${section.text}`)
      : section.state === 'removed' ? wordCount(`${section.title} removed`) : 0), 0);
}

/** One line for each place a document's folded sections were approved, naming them. */
export function foldedLines(sections) {
  const groups = new Map();
  for (const section of sections.filter((entry) => ['unchanged', 'restated'].includes(entry.state))) {
    groups.set(section.folded, [...(groups.get(section.folded) ?? []), section.title]);
  }
  return [...groups.entries()].map(([folded, titles]) => `${folded[0].toUpperCase()}${folded.slice(1)}: ${titles.join(', ')}`);
}

/** The person approval that already covered `step` at its current version ("Planning v1"), or null. */
function coveredByEarlierApproval(workflow, step) {
  for (const phase of Object.values(workflow.phases ?? {})) {
    for (const approval of phase.approvals ?? []) {
      if (approval?.decision === 'approved' && (approval.covers ?? []).some((entry) => entry.phase === step.id && Number(entry.generation) === Number(step.generation))) {
        return versionLabel(phase, approval.generation);
      }
    }
  }
  return null;
}

const stepLabel = (phase) => phase?.label ?? phase?.id ?? 'step';
const versionLabel = (phase, version) => `${stepLabel(phase)} v${version}`;

/** The approval of an earlier version of `phase` this person gave (or, when they gave none, the latest anyone gave); null when none. */
export function earlierApproval(phase, actor, sameApprover) {
  const approvals = (phase?.approvals ?? []).filter((entry) => entry?.decision === 'approved' && Number(entry.generation) < Number(phase.generation)
    && typeof entry.evidenceCommit === 'string');
  const mine = actor ? approvals.filter((entry) => sameApprover(entry.actor ?? {}, actor)) : [];
  const chosen = (mine.length ? mine : approvals).sort((left, right) => Number(left.generation) - Number(right.generation)).at(-1);
  return chosen ? { approval: chosen, yours: mine.includes(chosen) } : null;
}

/** The steps before `phaseId` whose documents count as approved: a person approved them, or a later person approval covered them. */
function approvedEarlierSteps(workflow, phaseId, covered) {
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const coveredNow = new Set(covered.map((entry) => entry.id));
  return order.slice(0, Math.max(0, order.indexOf(phaseId))).map((id) => workflow.phases?.[id])
    .filter((phase) => phase && phase.status === 'approved' && !coveredNow.has(phase.id));
}

async function readText(root, relative) {
  try { return await readFile(path.join(root, relative), 'utf8'); } catch { return null; }
}

/** Each meaningful line of the documents of the steps approved before this one, mapped to the first step that has it. */
async function approvedLines(root, workflow, steps) {
  const approved = new Map();
  for (const step of steps) {
    const label = versionLabel(step, step.generation);
    for (const artifact of (step.artifacts ?? []).filter((entry) => /\.(?:md|markdown|txt)$/iu.test(String(entry?.path ?? '')))) {
      const text = await readText(root, artifact.path);
      for (const line of readableLines(text)) {
        const key = comparableLine(line.text);
        if (key && !approved.has(key)) approved.set(key, label);
      }
    }
  }
  return approved;
}

const BRIEF_ID = /^agent-brief-/u;
const isBrief = (document) => document?.kind === 'agent-brief' || BRIEF_ID.test(String(document?.id ?? ''));
const isSource = (document) => Boolean(document?.display) || ['code', 'test'].includes(document?.kind);

/** The changed source files of a code step since the person's earlier approval (or the Story's base): path and line counts. */
async function changedSourceFiles(root, workflow, documents, since) {
  const paths = documents.filter(isSource).map((document) => document.path).filter(Boolean);
  if (!paths.length) return new Map();
  const base = since ?? workflow.workItem?.baseCommit ?? null;
  if (!base) return new Map();
  try {
    const { typedChangedPaths } = await import('./git-access.mjs');
    return new Map(typedChangedPaths(root, base, null, { paths, max: 200 }).entries.map((entry) => [entry.path, entry]));
  } catch { return new Map(); }
}


/** One document as the approval shows it, with its sections, its one line and its words before and after. */
async function focusDocument(root, workflow, phase, document, context) {
  const version = Number(document.generation ?? phase.generation);
  const base = { id: document.id, label: document.label ?? document.id, path: document.path, step: phase.id, version };
  const content = typeof document.content === 'string' ? document.content : null;
  const fullWords = content != null ? wordCount(readableLines(content).map((line) => line.text).join('\n')) : 0;
  if (isBrief(document)) {
    const plan = context.planSteps.has(phase.id);
    const line = `${document.label ?? 'Agent brief'}: generated from ${plan ? 'the plan' : versionLabel(phase, version)}`;
    return { ...base, kind: 'brief', line, words: { full: fullWords, shown: wordCount(line) } };
  }
  if (isSource(document)) {
    const change = context.sourceChanges.get(document.path);
    const counts = change && change.added != null ? ` (+${change.added} −${change.removed}${context.sinceLabel ? ` since ${context.sinceLabel}` : ''})` : '';
    const line = `${document.path}: ${change ? (change.status === 'A' ? 'added' : change.status === 'D' ? 'deleted' : 'changed') : context.sinceLabel ? `unchanged since ${context.sinceLabel}` : 'delivered'}${counts}`;
    return { ...base, kind: 'source', line, changed: Boolean(change), ...(change ? { added: change.added, removed: change.removed } : {}), words: { full: 0, shown: 0 } };
  }
  if (content == null) {
    const line = `${base.label}: open it to read it${document.binary ? ' (not text)' : ''}`;
    return { ...base, kind: 'other', line, words: { full: 0, shown: wordCount(line) } };
  }
  if (await (await import('./record-documents.mjs')).writtenBySflow(content)) {
    const line = `${versionLabel(phase, version)}${base.label === stepLabel(phase) ? '' : `, ${base.label}`}: written by SFlow from its records; checked by SFlow, kept for audit`;
    return { ...base, kind: 'record', line, words: { full: fullWords, shown: wordCount(line) } };
  }
  const previous = context.previousTexts.get(document.path) ?? null;
  const sections = focusSections(content, { previous, previousLabel: context.sinceLabel, approved: context.approved });
  const changed = sections.filter((section) => ['changed', 'new', 'removed'].includes(section.state));
  const folded = sections.filter((section) => ['unchanged', 'restated'].includes(section.state));
  const name = base.label === stepLabel(phase) ? versionLabel(phase, version) : `${versionLabel(phase, version)}, ${base.label}`;
  const line = previous != null
    ? `${name}: ${changed.length ? `${plural(changed.length, 'section')} changed since ${context.sinceLabel} (${quoted(changed.map((section) => section.title))})` : `nothing changed since ${context.sinceLabel}`}${folded.length ? `; ${plural(folded.length, 'section')} already approved` : ''}`
    : `${name}: ${changed.length ? `${plural(changed.length, 'section')} to read` : 'nothing new'}${folded.length ? `; ${plural(folded.length, 'section')} already approved in ${[...new Set(folded.map((section) => section.folded.replace(/^already approved in /u, '')))].join(', ')}` : ''}`;
  const foldedText = foldedLines(sections);
  return { ...base, kind: 'document', line, ...(previous != null ? { since: context.sinceLabel } : {}), ...(foldedText.length ? { folded: foldedText } : {}), sections,
    words: { full: fullWords, shown: wordCount(line) + shownWords(sections) } };
}

/** A path as the person's editor opens it: repository-relative, with its line. */
const at = (file, line = null, extra = {}) => ({ ...(file ? { path: file } : {}), ...(line ? { line } : {}), ...extra });

/** Where a requirement is written: its document and line, from the Story's clause index; or only its ID. */
function requirementAt(clauses, clauseId) {
  const clause = clauses.get(clauseId);
  return at(clause?.path ?? null, clause?.line ?? null, { requirement: clauseId });
}

async function clauseLocations(root, config, workflow) {
  const located = new Map();
  try {
    const [{ loadActiveSpecRecords }, { workDir, workDirRelative }] = await Promise.all([import('./specifications.mjs'), import('./story-paths.mjs')]);
    const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
    for (const index of records?.indexes ?? []) for (const clause of index.clauses ?? []) {
      const file = clause.source?.path ?? clause.source?.file ?? null;
      located.set(clause.id, { path: file ? (file.includes('/work-items/') || file.startsWith(workDirRelative(config, workflow.workItem.id)) ? file
        : `${workDirRelative(config, workflow.workItem.id)}/${file}`) : null, line: Number.isInteger(clause.source?.line) ? clause.source.line : null });
    }
    return { located, records };
  } catch { return { located, records: null }; }
}

/** The code step whose delivery this approval judges the tests of: this step's own, or the latest one before it. */
function deliveryStep(workflow, phase) {
  if (phase.deliveryEvidence?.acceptanceCriteria) return phase;
  const order = workflow.phaseOrder ?? [];
  return order.slice(0, Math.max(0, order.indexOf(phase.id))).reverse().map((id) => workflow.phases?.[id])
    .find((step) => step?.deliveryEvidence?.acceptanceCriteria) ?? null;
}

/** The reviewer's findings a person should judge, and the review's own pointers, from its retained report; [] when none. */
async function reviewerItems(root, config, workflow, phase, review) {
  const items = [];
  for (const entry of review?.reviewDisputes ?? []) items.push({ kind: 'dispute', words: `Disputed review finding ${entry.finding}: ${entry.message} ${entry.by} disputed it: ${entry.reason} Return the step if you agree with the reviewer.`, at: at(null, null, { finding: entry.finding }) });
  let status = null;
  try {
    if ((await import('./source-review-policy.mjs')).sourceReviewRequired(workflow, phase.id)) {
      status = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phase.id);
    }
  } catch { status = null; }
  const sources = new Map((status?.binding?.sources ?? []).map((source) => [source.id, source.path]));
  const disputed = new Set((review?.reviewDisputes ?? []).map((entry) => entry.finding));
  for (const finding of status?.report?.findings ?? []) {
    if (disputed.has(finding.id) || finding.severity === 'blocking') continue;
    const file = sources.get(finding.sourceId) ?? null;
    items.push({ kind: 'finding', words: `Reviewer's ${finding.check === 'use' ? 'advice on use' : 'note'} ${finding.id}: ${String(finding.message).trim()}`,
      at: at(file, Number.isInteger(finding.line) ? finding.line : null, { finding: finding.id }) });
  }
  for (const entry of status?.report?.unplannedPaths ?? []) {
    const file = entry.path ?? sources.get(entry.sourceId) ?? null;
    if (!file) continue;
    items.push({ kind: 'outside-plan', words: `Outside the plan: ${file}${entry.assessment ? `, which the reviewer read as ${entry.assessment}` : ''}${entry.note ? ` (${String(entry.note).trim()})` : ''}.`, at: at(file) });
  }
  return { items, reviewReady: status?.status === 'ready' };
}

/** The runtime check's findings that break use, and its "Try it": optional, never a hold (step intents §12.3, §12.5). */
async function runtimeItems(root, workflow, phase) {
  try {
    const runtime = await import('./runtime-check.mjs');
    const capture = await runtime.readRuntimeCheck(root, workflow, phase.id);
    if (!capture) return [];
    const items = runtime.runtimeFindings(capture).filter((finding) => finding.class === 'breaks-use').map((finding) => ({ kind: 'runtime',
      words: `The runtime check found ${finding.id}, which breaks use: ${finding.title}.`, at: at(finding.where?.file ?? null, finding.where?.line ?? null, { finding: finding.id }) }));
    const view = await runtime.runtimeTryItView(root, workflow, phase.id);
    if (view?.line) items.push({ kind: 'try-it', words: view.line, at: at(null) });
    return items;
  } catch { return []; }
}

/** Requirements whose tests are weak, missing or only partly prove them, each at its requirement row. */
async function testItems(workflow, phase, review, clauses) {
  const step = deliveryStep(workflow, phase);
  if (!step) return { items: [], proven: 0, total: 0 };
  let entries = step === phase ? review?.testEvidence?.acceptance?.proof ?? null : null;
  if (!entries) try { entries = (await import('./verification/criterion-proof.mjs')).criterionProof(step.deliveryEvidence); } catch { entries = []; }
  const unmet = new Map((review?.testEvidence?.acceptance?.criteria ?? []).filter((entry) => entry.status !== 'met').map((entry) => [entry.clauseId, entry]));
  const items = [];
  let proven = 0;
  for (const entry of entries) {
    const weak = !entry.tests || entry.silent > 0 || (entry.tests && entry.unread === entry.tests) || unmet.has(entry.clauseId);
    if (!weak) { proven += 1; continue; }
    const why = !entry.tests ? 'no test proves it' : entry.silent ? entry.words.replace(`${entry.clauseId}: `, '')
      : unmet.has(entry.clauseId) ? `its test did not verify it here (${unmet.get(entry.clauseId).status})` : 'its tests\' assertions were not read';
    items.push({ kind: 'weak-test', words: `${entry.clauseId}: ${why}${step.id !== phase.id ? ` (${stepLabel(step)}'s tests)` : ''}.`, at: requirementAt(clauses, entry.clauseId) });
  }
  return { items, proven, total: entries.length };
}

/** Decisions still open and the risks a person accepts by approving: owed sign-offs, upstream issues, accepted risks, a risk section. */
function riskItems(workflow, phase, review, documents) {
  const items = [];
  for (const witness of review?.owedDecisions?.witnesses ?? []) items.push({ kind: 'decision',
    words: `${witness.clauseId} needs a person's sign-off after inspecting ${(witness.files ?? []).join(', ') || 'its evidence'}.`, at: at(witness.files?.[0] ?? null, null, { requirement: witness.clauseId }) });
  for (const issue of review?.upstreamIssues ?? []) items.push({ kind: 'decision', words: `Open upstream issue ${issue.id} for ${issue.phase}: ${issue.problem}`, at: at(null, null, { issue: issue.id }) });
  for (const risk of review?.testEvidence?.acceptedRisks ?? []) items.push({ kind: 'risk', words: `Accepted risk: ${risk.words}`, at: at(null) });
  for (const document of documents.filter((entry) => entry.kind === 'document')) {
    // A changed version names each changed section already; a new document names its risk section here.
    for (const section of document.since ? [] : document.sections.filter((entry) => /\brisks?\b|rollback/iu.test(entry.title) && entry.state === 'new')) {
      items.push({ kind: 'risk', words: `Judge the risks: "${section.title}" in ${document.label} is new to you.`, at: at(document.path, section.line, { section: section.title }) });
    }
  }
  return items;
}

/** What SFlow settled for the person on this step, each with its undo. */
async function settledItems(workflow, phase) {
  try {
    const { settledDecisions, settlementMatters } = await import('./settled-decisions.mjs');
    return settledDecisions(workflow).filter((entry) => !entry.undone && settlementMatters(workflow, entry) && (!entry.phase || entry.phase === phase.id))
      .map((entry) => ({ kind: 'settled', words: `Settled for you: ${entry.subject}: ${entry.answer} Undo it with singularity-flow decisions undo ${workflow.workItem.id} --settled ${entry.id} if you disagree.`,
        at: at(entry.evidence?.[0]?.where && !/\s/u.test(entry.evidence[0].where) ? entry.evidence[0].where : null, null, { settled: entry.id }) }));
  } catch { return []; }
}

/** One item per document section that changed or is new to the person, at its line. */
function changeItems(documents) {
  const items = [];
  for (const document of documents.filter((entry) => entry.kind === 'document')) {
    const changed = document.sections.filter((section) => section.state === 'changed' || section.state === 'removed');
    const fresh = document.sections.filter((section) => section.state === 'new');
    if (document.since) {
      for (const section of changed) items.push({ kind: 'changed', words: section.state === 'removed' ? `"${section.title}" was removed from ${document.label} since ${document.since}.`
        : `"${section.title}" in ${document.label} changed since ${document.since}: ${plural(section.added, 'line')} added, ${section.removed} removed.`,
      at: at(document.path, section.line, { section: section.title }) });
      for (const section of fresh) items.push({ kind: 'changed', words: `"${section.title}" in ${document.label} is new since ${document.since}.`, at: at(document.path, section.line, { section: section.title }) });
    } else if (fresh.length) {
      items.push({ kind: 'new', words: `${document.label} v${document.version} is new to you: read ${quoted(fresh.slice(0, 4).map((section) => section.title))}${fresh.length > 4 ? ` and ${fresh.length - 4} more` : ''}.`,
        at: at(document.path, fresh[0].line, { section: fresh[0].title }) });
    }
  }
  for (const document of documents.filter((entry) => entry.kind === 'source' && entry.changed).slice(0, 3)) {
    items.push({ kind: 'changed', words: `${document.line}.`, at: at(document.path) });
  }
  const more = documents.filter((entry) => entry.kind === 'source' && entry.changed).length - 3;
  if (more > 0) items.push({ kind: 'changed', words: `${plural(more, 'more changed file')}: see the list of documents.`, at: at(null) });
  return items;
}

// The order a person reads them in: what could make them say no first.
const ORDER = ['dispute', 'runtime', 'finding', 'weak-test', 'outside-plan', 'settled', 'changed', 'new', 'risk', 'decision', 'try-it'];

/**
 * Everything an approval of `phase` shows a person, from its review (`phaseReview`): `eyes` (the checklist and its
 * "checked by SFlow" line), `documents` (each one's line and sections) and `words` (before and after). Null unless the
 * step awaits approval. A read: it never refuses, and a part it cannot read is left out.
 */
export async function approvalFocus(root, config, workflow, phase, review, { actor = null } = {}) {
  if (!phase || phase.status !== 'awaiting_approval' || !review) return null;
  const [{ sameApprover }, { automaticApprovalsBefore, planStepIds }] = await Promise.all([import('./approval-authority.mjs'), import('./phase-roles.mjs')]);
  let person = actor;
  if (!person) try { person = (await import('./git.mjs')).actionActor(root); } catch { person = null; }
  const earlier = earlierApproval(phase, person, sameApprover);
  const sinceLabel = earlier ? versionLabel(phase, earlier.approval.generation) : null;
  const previousTexts = new Map();
  if (earlier) {
    const { exactFileAtObject } = await import('./git.mjs');
    for (const entry of earlier.approval.artifactSha256 ?? []) {
      try {
        const bytes = exactFileAtObject(root, earlier.approval.evidenceCommit, entry.path);
        if (bytes) previousTexts.set(entry.path, bytes.toString('utf8'));
      } catch { /* that version cannot be read here: the document shows whole */ }
    }
  }
  const covered = automaticApprovalsBefore(workflow, phase.id);
  const earlierSteps = approvedEarlierSteps(workflow, phase.id, covered);
  // This step's documents fold what the steps it covers say too: the person reads that once, in those steps' own documents.
  const [approvedBefore, approved] = await Promise.all([approvedLines(root, workflow, earlierSteps), approvedLines(root, workflow, [...earlierSteps, ...covered])]);
  let planSteps = new Set();
  try { planSteps = planStepIds(workflow.resolution ?? {}, workflow.resolution?.phases ?? []); } catch { planSteps = new Set(); }
  const ownDocuments = review.documents ?? [];
  const sourceChanges = await changedSourceFiles(root, workflow, ownDocuments, earlier?.approval.evidenceCommit ?? null);
  const context = { approved, previousTexts, sinceLabel, planSteps, sourceChanges };
  const documents = [];
  for (const document of ownDocuments) documents.push(await focusDocument(root, workflow, phase, document, context));
  // The steps SFlow approved since the last person approval are read here too, against what was approved before them.
  for (const step of covered) {
    const already = coveredByEarlierApproval(workflow, step);
    for (const artifact of (step.artifacts ?? []).filter((entry) => typeof entry?.path === 'string')) {
      const content = /\.(?:md|markdown|txt)$/iu.test(artifact.path) ? await readText(root, artifact.path) : null;
      if (already) {
        const line = `${versionLabel(step, step.generation)}: already approved with ${already}`;
        documents.push({ id: artifact.path, label: step.label ?? step.id, path: artifact.path, step: step.id, version: Number(step.generation), kind: 'folded', covered: true, line,
          words: { full: content == null ? 0 : wordCount(readableLines(content).map((entry) => entry.text).join('\n')), shown: wordCount(line) } });
        continue;
      }
      const shown = await focusDocument(root, workflow, step, { id: artifact.path, label: step.label ?? step.id, path: artifact.path, generation: step.generation, content },
        { ...context, approved: approvedBefore, previousTexts: new Map(), sinceLabel: null, sourceChanges: new Map() });
      documents.push({ ...shown, covered: true });
    }
  }
  const { located: clauses } = await clauseLocations(root, config, workflow);
  const reviewer = await reviewerItems(root, config, workflow, phase, review);
  const tests = await testItems(workflow, phase, review, clauses);
  const all = [...reviewer.items, ...await runtimeItems(root, workflow, phase), ...tests.items, ...await settledItems(workflow, phase),
    ...changeItems(documents), ...riskItems(workflow, phase, review, documents)]
    .map((item, index) => ({ ...item, rank: ORDER.indexOf(item.kind), index })).sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ rank: _rank, index: _index, ...item }, index) => ({ id: `E${index + 1}`, ...item }));
  const folded = documents.flatMap((document) => (document.sections ?? []).filter((section) => ['unchanged', 'restated'].includes(section.state)));
  const briefs = documents.filter((document) => document.kind === 'brief');
  const records = documents.filter((document) => document.kind === 'record');
  const ownRuns = review.stepTestRuns ?? [];
  const reused = review.reusedTestRuns ?? [];
  const delivered = review.testEvidence?.executions ? review.testEvidence : null;
  const checked = [
    'the required sections, placeholders and clause rows of each document',
    tests.total ? `${tests.proven} of ${plural(tests.total, 'acceptance criterion', 'acceptance criteria')} with a passing test that asserts` : null,
    ownRuns.length ? `${ownRuns.filter((run) => run.status === 'passed').length} of ${plural(ownRuns.length, 'test run')} passed` : null,
    reused.length ? `${plural(reused.length, 'passing test run')} reused on unchanged code` : null,
    delivered && !ownRuns.length && !reused.length ? `${plural(delivered.executions, 'test run')} recorded for this version` : null,
    reviewer.reviewReady ? 'the independent review\'s citations and bindings' : null,
    !all.some((item) => item.kind === 'outside-plan') && deliveryStep(workflow, phase) ? 'every changed file is in the plan or supports it' : null,
    folded.length ? `${plural(folded.length, 'section')} already approved` : null,
    briefs.length ? `${plural(briefs.length, 'agent brief')} generated from ${planSteps.has(phase.id) ? 'the plan' : 'this document'}` : null,
    records.length ? `${records.map((document) => document.label).join(', ')}, written from SFlow's records` : null
  ].filter(Boolean);
  const items = all.slice(0, FOCUS_ITEM_LIMIT);
  const more = all.slice(FOCUS_ITEM_LIMIT);
  const eyes = { title: 'What needs your eyes', items, ...(more.length ? { more } : {}),
    ...(items.length ? {} : { none: 'Nothing here needs your judgment beyond the documents themselves.' }),
    checked: `checked by SFlow: ${checked.join('; ')}.` };
  const full = documents.reduce((total, document) => total + document.words.full, 0);
  const shown = wordCount([eyes.title, ...all.map((item) => item.words), eyes.checked].join('\n'))
    + documents.reduce((total, document) => total + document.words.shown, 0);
  return { schemaVersion: 1, step: phase.id, version: Number(phase.generation), ...(sinceLabel ? { since: { label: sinceLabel, yours: earlier.yours } } : {}),
    eyes, documents, words: { full, shown, line: focusWordsLine({ full, shown }) }, binding: 'Presentation only: approving binds every document in full, as before; each one opens in full.' };
}

/** The approval focus for an agent: each item and line, without section text or diffs (a chat never pastes them). */
export function approvalFocusForAgent(focus) {
  if (!focus) return focus;
  return { ...focus, documents: focus.documents.map(({ sections, ...document }) => sections
    ? { ...document, sections: sections.map(({ text: _text, diff: _diff, ...section }) => section) } : document) };
}

const pointer = (item) => {
  const where = item.at ?? {};
  const place = where.path ? `${where.path}${where.line ? `:${where.line}` : ''}` : null;
  return [place, where.section ? `section "${where.section}"` : null, where.requirement && !place ? `requirement ${where.requirement}` : null].filter(Boolean).join(', ');
};

/** The focus as one Markdown page a person opens beside the chat: the checklist, then only what is new, with every document linked. */
export function approvalFocusMarkdown(focus, { link = (file) => file } = {}) {
  if (!focus) return '';
  const out = [`# ${focus.eyes.title}`, ''];
  for (const item of [...focus.eyes.items, ...(focus.eyes.more ?? [])]) {
    const where = item.at?.path ? ` ([${item.at.path}${item.at.line ? `:${item.at.line}` : ''}](${link(item.at.path, item.at.line)}))` : pointer(item) ? ` (${pointer(item)})` : '';
    out.push(`${item.id.slice(1)}. ${item.words}${where}`);
  }
  if (focus.eyes.none) out.push(focus.eyes.none);
  out.push('', `_${focus.eyes.checked}_`, '', `## What is new`, '', `${focusWordsLine(focus.words) ? `${focusWordsLine(focus.words)}. ` : ''}${focus.binding}`, '');
  for (const document of focus.documents) {
    out.push(`### [${document.label}${document.version ? ` v${document.version}` : ''}](${link(document.path)})`, '', document.line, '');
    for (const line of document.folded ?? []) out.push(`- ${line}`);
    for (const section of document.sections ?? []) {
      if (['unchanged', 'restated'].includes(section.state)) continue;
      if (section.state === 'removed') out.push(`- **${section.title}**: removed`);
      else if (section.state === 'changed') {
        out.push(`- **${section.title}**: changed`, '', '```diff', ...section.diff.map((entry) => `${entry.op} ${entry.text}`), '```', '');
      } else out.push(`- **${section.title}**: new`, '', ...section.text.split('\n').map((line) => `  ${line}`), '');
    }
    out.push('');
  }
  return `${out.join('\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`;
}

/**
 * Write the focus as the Markdown page a Copilot chat links (it never pastes section text or diffs): `.sflow/out/`, SFlow's
 * own disposable output beside the checkout, never committed. Returns its checkout-relative and absolute paths; null
 * when it cannot be written here, which only leaves the chat with each document's line and link.
 */
export async function writeApprovalFocusPage(root, workId, focus) {
  if (!focus) return null;
  try {
    const [{ AGENT_OUTPUT_FOLDER, agentOutputDirectory, excludeAgentOutput }, { gitCommonDir }, { writeFile }] = await Promise.all([
      import('./agent-output-folder.mjs'), import('./git-execution.mjs'), import('node:fs/promises')]);
    await excludeAgentOutput(gitCommonDir(root));
    const directory = await agentOutputDirectory(root);
    const name = `approval-${String(workId).replace(/[^A-Za-z0-9._-]+/gu, '-')}-${String(focus.step).replace(/[^A-Za-z0-9._-]+/gu, '-')}-v${focus.version}.md`;
    const relative = `${AGENT_OUTPUT_FOLDER}/${name}`;
    const link = (file, line = null) => `${path.posix.relative(AGENT_OUTPUT_FOLDER, String(file).split(path.sep).join('/'))}${line ? `#L${line}` : ''}`;
    await writeFile(path.join(directory, name), approvalFocusMarkdown(focus, { link }), { mode: 0o600 });
    try { await (await import('./copilot-mutation-guard.mjs')).issueMutationReadPaths(root, [path.join(directory, name)]); } catch { /* the link still opens */ }
    return { path: relative, absolutePath: path.join(directory, name) };
  } catch { return null; }
}
