/**
 * What this change does: one plain-English page per Story [CSP, docs/SPEC-CSP-CHANGE-STORY-PAGE-v1.md]. Owner, 2026-11-27:
 * "we had these requirements and acceptance criteria; to satisfy it we created/edited these parts of the code; this is the
 * simple explanation of code; and to test that, these were created", "the why part also", and "after the implementation
 * done it should be available".
 *
 * SFlow writes every fact from its own records, with no model [CSP:REQ-001]: the requirement and its criteria, each
 * delivered file against the Story's base and the functions it added, changed or removed (change-story-functions.mjs), the
 * criteria their tags serve, the tests and SFlow's own run of them, and the files changed outside the plan (WCB's record).
 * Copilot writes the English in the code step itself, in `change-explanation.json` beside the step's document
 * [CSP:REQ-002]; SFlow shows a text only once XPL2's checks pass it and everything it names is in the change [CSP:REQ-003].
 * The reasons come from the approved plan's and design's decisions first [CSP:REQ-004].
 *
 * One builder, one renderer: the Story's `CHANGE-STORY.md`, the approval's line, the Work page, the pull request and
 * `explain --subject change --page` all read what `renderChangeStory` writes. Information only: nothing here refuses,
 * holds or asks [CSP:REQ-011].
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { applicationPathContext, isApplicationChangePath, isEditorConfigurationPath } from './application-paths.mjs';
import { CHANGE_STORY_FILE, CHANGE_STORY_MARKER, CHANGE_EXPLANATION_FILE } from './change-story-read.mjs';
import { storyLocation } from './story-paths.mjs';

export { CHANGE_STORY_FILE, CHANGE_EXPLANATION_FILE };

/** The page's section for what a person decided in SFlow's place; the pull request shows its own (pull-request.mjs). */
export const PERSON_DECISIONS_SECTION = '## Decided by a person, not checked by SFlow';
export const CHANGE_STORY_LIMITS = Object.freeze({ files: 200, fileBytes: 512 * 1024, explanationBytes: 256 * 1024, how: 1500, entry: 600,
  reasons: 12, decisions: 8, reasonCharacters: 400, criteria: 60 });

const TEST_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'testing']);
/** A path whose folder or name says it holds tests (the same rule as the code explanation's). */
function testPathByName(relative) {
  const parts = String(relative).toLowerCase().split('/');
  const name = parts.at(-1) ?? '';
  return parts.slice(0, -1).some((segment) => TEST_SEGMENTS.has(segment))
    || /\.(?:test|spec)\.[a-z0-9]+$/u.test(name) || /_test\.(?:go|py|rb)$/u.test(name) || /^test_.*\.py$/u.test(name) || /Tests?\.(?:java|kt|cs)$/u.test(name);
}

const plain = (value, limit = 600) => String(value ?? '').replace(/<!--[\s\S]*?-->/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit);
const code = (value) => `\`${String(value).replace(/`/gu, '')}\``;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0] ?? '');

/** The code steps with a published version, in workflow order. */
async function codeSteps(workflow) {
  const { phaseRequiresCodeDelivery } = await import('./code-delivery-policy.mjs');
  return (workflow?.phaseOrder ?? []).map((id) => workflow.phases?.[id])
    .filter((phase) => phase && phaseRequiresCodeDelivery(phase) && Number(phase.generation ?? 0) > 0 && phase.deliveryEvidence);
}

async function json(file, limit) {
  try {
    const text = await readFile(file, 'utf8');
    return Buffer.byteLength(text, 'utf8') > limit ? null : JSON.parse(text);
  } catch { return null; }
}

/** What the Story asked for: its request in a sentence or two, and its clauses, the criteria apart. */
async function asked(root, config, workflow) {
  const location = storyLocation(root, [workflow, config], workflow.workItem.id);
  const source = await json(location.file('source.json'), 256 * 1024);
  const request = plain(source?.description ?? source?.problem ?? source?.summary ?? '', 2000);
  const sentences = request.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/gu) ?? [];
  let clauses = [];
  try {
    const { readStoryClauseSources } = await import('./comprehension/xpl2/clause-sources.mjs');
    const read = await readStoryClauseSources(root, workflow);
    const seen = new Set();
    for (const artifact of read.artifacts ?? []) {
      for (const clause of artifact.clauses ?? []) {
        if (seen.has(clause.id)) continue;
        seen.add(clause.id);
        clauses.push({ id: clause.id, type: clause.type, text: plain(String(clause.body ?? '').replace(/\|/gu, ' ').replace(/^\s*\[[^\]]+\]\s*/u, ''), 400) });
      }
    }
  } catch { clauses = []; }
  clauses = clauses.slice(0, CHANGE_STORY_LIMITS.criteria);
  return {
    request: sentences.slice(0, 2).map((sentence) => sentence.trim()).join(' ') || plain(workflow.workItem.title, 300),
    requirements: clauses.filter((clause) => clause.type !== 'AC'),
    criteria: clauses.filter((clause) => clause.type === 'AC')
  };
}

/**
 * The entries of a code step's delivered change sets: this version's (from the workflow, else its record file) and each
 * earlier version's record, so a file only an earlier version changed stays on the page; one changed back reads as unchanged.
 */
async function changeEntries(location, phase) {
  const evidence = phase.deliveryEvidence ?? {};
  const inline = Array.isArray(evidence.changeSet?.entries) ? evidence.changeSet.entries : null;
  const current = /^(.*-gen)(\d+)(-changes\.json)$/u.exec(String(evidence.changeSetPath ?? ''));
  const entries = [...(inline ?? [])];
  for (let generation = current ? Number(current[2]) : 0; generation >= 1; generation -= 1) {
    if (inline && generation === Number(current[2])) continue;
    // A record: a state-ref Story's is in its state checkout, named relative to it [SSB M3].
    const recorded = await json(location.fromRecord(`${current[1]}${generation}${current[3]}`), 16 * 1024 * 1024);
    if (Array.isArray(recorded?.entries)) entries.push(...recorded.entries);
  }
  return entries;
}

/**
 * The files the code steps delivered, against the Story's base: each `{ path, from, change, before, after, test }`.
 * `revision` is a commit to read the delivered bytes at, or null for the checkout (inside the publication's own commit).
 */
async function deliveredFiles(root, config, workflow, steps, revision) {
  const { worktreeBytesAtRevision } = await import('./git.mjs');
  const context = applicationPathContext(config, workflow);
  const base = workflow.workItem?.baseCommit ?? null;
  const testPaths = new Set(steps.flatMap((step) => step.deliveryEvidence?.testPaths ?? []));
  const moved = new Map();
  const paths = new Set();
  for (const step of steps) {
    for (const entry of await changeEntries(storyLocation(root, [workflow, config], workflow.workItem.id), step)) {
      for (const candidate of [entry?.oldPath, entry?.newPath]) {
        if (typeof candidate === 'string' && !isEditorConfigurationPath(candidate) && isApplicationChangePath(candidate, context)) paths.add(candidate);
      }
      if (entry?.status === 'renamed' && entry.oldPath && entry.newPath) moved.set(entry.newPath, entry.oldPath);
    }
  }
  const read = async (relative, at) => {
    if (at === 'worktree') {
      try { const bytes = await readFile(path.join(root, relative)); return bytes.length > CHANGE_STORY_LIMITS.fileBytes ? '' : bytes.toString('utf8'); }
      catch { return null; }
    }
    if (!at) return null;
    const bytes = worktreeBytesAtRevision(root, at, relative, { maximumBytes: CHANGE_STORY_LIMITS.fileBytes });
    return bytes ? bytes.toString('utf8') : null;
  };
  const files = [];
  const renamedFrom = new Set(moved.values());
  for (const relative of [...paths].sort().slice(0, CHANGE_STORY_LIMITS.files)) {
    const from = moved.get(relative) ?? null;
    const [before, after] = await Promise.all([read(from ?? relative, base), read(relative, revision ?? 'worktree')]);
    // A file moved away reads under its new name; one the change left as it was is not part of it.
    if (renamedFrom.has(relative) && after == null) continue;
    if (before == null && after == null) continue;
    if (before != null && after != null && before === after && !from) continue;
    files.push({ path: relative, from, change: before == null ? 'new' : after == null ? 'removed' : 'edited', before, after,
      test: testPaths.has(relative) || testPathByName(relative) });
  }
  return files;
}

/** The criteria and clauses one file's tags name, and for a test file the criterion of each test by where its tag is. */
async function tagsOf(relative, text) {
  if (text == null) return [];
  try {
    const { scanSourceClauseTags } = await import('./source-clause-tags.mjs');
    return scanSourceClauseTags(text, { sourcePath: relative });
  } catch { return []; }
}

/** A tag covers the test whose body holds it, else the first test that starts within three lines after it. */
function testCriteria(cases, tags) {
  const by = new Map(cases.map((entry) => [entry, new Set()]));
  for (const tag of tags) {
    const inside = cases.find((entry) => tag.line >= entry.start && tag.line <= entry.end);
    const after = inside ?? cases.find((entry) => entry.start > tag.line && entry.start - tag.line <= 3);
    if (after) by.get(after).add(tag.clauseId);
  }
  return by;
}

const SOURCE_WORDS = Object.freeze({ plan: 'plan', design: 'design' });

/** Which document word a step's decisions read as, "plan" or "design", or null when it is neither. */
function decisionSource(workflow, phase) {
  const resolved = (workflow.resolution?.phases ?? []).find((entry) => entry?.id === phase.id);
  if (SOURCE_WORDS[resolved?.intent]) return SOURCE_WORDS[resolved.intent];
  const kind = String(phase.requiredArtifact?.kind ?? '');
  if (/design/iu.test(kind)) return 'design';
  if (/plan|implementation-spec|fix-spec/iu.test(kind)) return 'plan';
  const named = `${phase.id} ${phase.label ?? ''}`;
  if (/design/iu.test(named)) return 'design';
  if (/plan|spec/iu.test(named)) return 'plan';
  return null;
}

/**
 * The decisions an approved document records under a heading with "decision" in it: its bullets, numbered items and table
 * rows (without a table's header), each one line, guidance comments and placeholders left out. Pure.
 */
export function documentDecisions(text) {
  const decisions = [];
  let level = 0;
  const lines = String(text ?? '').replace(/<!--[\s\S]*?-->/gu, '').split(/\r?\n/u);
  const separator = (line) => /^\s*\|?[\s|:-]+\|?\s*$/u.test(line ?? '') && /-/u.test(line ?? '');
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      if (/decision/iu.test(heading[2])) level = heading[1].length;
      else if (level && heading[1].length <= level) level = 0;
      return;
    }
    if (!level) return;
    const row = /^\s*\|(.*)\|\s*$/u.exec(line);
    if (row) {
      // A table's header is the row above its separator; the separator is no decision either.
      if (separator(line) || separator(lines[index + 1])) return;
      const cells = row[1].split('|').map((cell) => plain(cell, 200)).filter(Boolean);
      if (cells.length) decisions.push(cells.join('; '));
      return;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (item) decisions.push(plain(item[1], CHANGE_STORY_LIMITS.reasonCharacters));
    else if (/^\s{2,}\S/u.test(line) && decisions.length) decisions[decisions.length - 1] = plain(`${decisions.at(-1)} ${line}`, CHANGE_STORY_LIMITS.reasonCharacters);
  });
  return decisions.filter((entry) => entry && !/^(?:TODO|TBD|none|n\/a|not applicable)\b/iu.test(entry)).map((entry) => ({ text: entry }));
}

/** The reasons from approved plan and design documents before the first code step, each tagged with its source. */
async function documentReasons(root, config, workflow, firstCode) {
  const order = workflow.phaseOrder ?? [];
  const before = order.slice(0, Math.max(0, order.indexOf(firstCode.id))).map((id) => workflow.phases?.[id])
    .filter((phase) => phase?.status === 'approved' && phase.requiredArtifact?.path);
  const location = storyLocation(root, [workflow, config], workflow.workItem.id);
  const reasons = [];
  for (const phase of before) {
    const word = decisionSource(workflow, phase);
    if (!word) continue;
    let text;
    try { text = await readFile(location.document(phase.requiredArtifact.path).absolute, 'utf8'); } catch { continue; }
    documentDecisions(text).slice(0, CHANGE_STORY_LIMITS.decisions)
      .forEach((entry, index) => reasons.push({ text: entry.text, source: word, label: `(${word}, decision ${index + 1})` }));
  }
  return reasons;
}

/** Where a code step's explanation file is: beside its document. */
export function changeExplanationPath(root, config, workflow, phase) {
  const document = phase?.requiredArtifact?.path;
  if (!document) return null;
  return storyLocation(root, [workflow, config], workflow.workItem.id).document(path.posix.join(path.posix.dirname(document), CHANGE_EXPLANATION_FILE));
}

const FIELDS = Object.freeze(['does', 'needs', 'gives', 'changed']);

/**
 * Copilot's English, from each code step's `change-explanation.json`, checked [CSP:REQ-003]: a text XPL2 would withhold is
 * withheld; a function entry is kept only for a function this change added, changed or removed in that file; a reason that
 * names a file or function only when the change holds it. A later code step's entry replaces an earlier one's. Missing,
 * unreadable or malformed files give nothing; they never refuse.
 */
async function explanations(root, config, workflow, steps, files) {
  const { xpl2TextWithheld } = await import('./comprehension/xpl2/narration.mjs');
  const ok = (text, maximumCharacters) => typeof text === 'string' && text.trim() && !xpl2TextWithheld(text, { maximumCharacters }).length;
  const changed = new Map(files.map((file) => [file.path, file]));
  const functionIn = (file, name) => (file?.functions ?? []).find((entry) => [entry.key, entry.display, entry.name].includes(name)) ?? null;
  const result = { how: null, functions: new Map(), reasons: [], withheld: 0 };
  for (const step of steps) {
    const file = changeExplanationPath(root, config, workflow, step);
    const read = file ? await json(file.absolute, CHANGE_STORY_LIMITS.explanationBytes) : null;
    if (!read || typeof read !== 'object' || Array.isArray(read)) continue;
    if (read.how != null) {
      if (ok(read.how, CHANGE_STORY_LIMITS.how)) result.how = plain(read.how, CHANGE_STORY_LIMITS.how);
      else result.withheld += 1;
    }
    for (const [relative, entries] of Object.entries(read.functions && typeof read.functions === 'object' ? read.functions : {})) {
      for (const [name, entry] of Object.entries(entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {})) {
        const target = functionIn(changed.get(relative), name);
        const texts = entry && typeof entry === 'object' ? FIELDS.filter((field) => entry[field] != null).map((field) => entry[field]) : [];
        if (!target || !texts.length) { result.withheld += 1; continue; }
        if (!texts.every((text) => ok(text, CHANGE_STORY_LIMITS.entry))) { result.withheld += 1; continue; }
        result.functions.set(`${relative}\0${target.key}`, Object.fromEntries(FIELDS.filter((field) => entry[field] != null).map((field) => [field, plain(entry[field], CHANGE_STORY_LIMITS.entry)])));
      }
    }
    for (const reason of Array.isArray(read.reasons) ? read.reasons : []) {
      const text = typeof reason === 'string' ? reason : reason?.text;
      const file = typeof reason === 'object' && reason ? reason.file ?? null : null;
      const named = typeof reason === 'object' && reason ? reason.function ?? null : null;
      if (!ok(text, CHANGE_STORY_LIMITS.reasonCharacters) || (file && !changed.has(file)) || (named && !functionIn(changed.get(file), named))) { result.withheld += 1; continue; }
      result.reasons.push({ text: plain(text, CHANGE_STORY_LIMITS.reasonCharacters), source: 'copilot', label: '(Copilot\'s reason)' });
    }
  }
  result.reasons = result.reasons.slice(0, CHANGE_STORY_LIMITS.reasons);
  return result;
}

async function receipt(root, workflow, relative) {
  try {
    const { readRecord } = await import('./schema-migrations.mjs');
    return readRecord('test-execution', await readFile(storyLocation(root, [workflow], workflow.workItem.id).fromRecord(relative))).record;
  } catch { return null; }
}

/**
 * SFlow's own latest run of the tests on the delivered code: the last step, from the last code step on, that ran them (the
 * code step's runs at publication or submission, a later step's at its own). `{ ran: false, next }` until one did.
 */
async function testRun(root, workflow, steps) {
  const order = workflow.phaseOrder ?? [];
  const last = steps.at(-1);
  const after = order.slice(order.indexOf(last.id)).map((id) => workflow.phases?.[id]).filter(Boolean);
  for (const phase of [...after].reverse()) {
    const runs = phase === last || steps.includes(phase)
      ? (phase.deliveryEvidence?.testExecutions?.length ? phase.deliveryEvidence.testExecutions : phase.deliveryEvidence?.preflightAttempts ?? [])
      : Number(phase.stepTestRuns?.generation) === Number(phase.generation) ? phase.stepTestRuns?.testExecutions ?? phase.stepTestRuns?.preflightAttempts ?? [] : [];
    const counted = runs.filter((run) => run && run.kind !== 'phase-validation-observation');
    if (!counted.length) continue;
    const totals = { passed: 0, failed: 0, skipped: 0, statuses: [] };
    for (const run of counted) {
      const read = run.receiptPath ? await receipt(root, workflow, run.receiptPath) : null;
      const tests = run.counts ?? read?.tests ?? null;
      totals.passed += Number(tests?.passed ?? 0);
      totals.failed += Number(tests?.failed ?? 0);
      totals.skipped += Number(tests?.skipped ?? 0);
      totals.statuses.push(run.status ?? read?.status ?? 'unavailable');
    }
    return { ran: true, step: phase.label ?? phase.id, generation: Number(phase.generation ?? 0), ...totals,
      passing: totals.statuses.every((status) => status === 'passed') };
  }
  const next = after.find((phase) => phase !== last && phase.status !== 'approved');
  return { ran: false, next: next ? next.label ?? next.id : null };
}

/** WCB's record of files changed outside the plan, on a code step: `{ file, writer, reason }`; null when there is none. */
async function outsidePlan(workflow, steps) {
  try {
    // WCB's one reader of its record: the out-of-plan settlements and the supporting changes that say who made them.
    const { outsidePlanSettled } = await import('./plan-amendments.mjs');
    const ids = new Set(steps.map((step) => step.id));
    const entries = outsidePlanSettled(workflow).filter((entry) => typeof entry.file === 'string' && (!entry.phase || ids.has(entry.phase)));
    if (!entries.length) return null;
    const seen = new Map();
    for (const entry of entries) seen.set(entry.file, { file: entry.file, writer: entry.writer,
      reason: entry.writer === 'copilot' ? plain(entry.reason ?? '', CHANGE_STORY_LIMITS.reasonCharacters) || null : null,
      ...(entry.supporting ? { supporting: entry.supporting } : {}) });
    return [...seen.values()].sort((left, right) => left.file.localeCompare(right.file));
  } catch { return null; }
}

/** What a person decided where SFlow's own check could not, each said as what it is (finding-overrides.mjs) [owner, 2026-11-28]. */
async function personDecisions(workflow) {
  if (!workflow?.findingOverrides?.length) return [];
  try {
    return (await import('./finding-overrides.mjs')).personOverrideLines(workflow)
      .map((entry) => ({ step: workflow.phases?.[entry.phase]?.label ?? entry.phase, generation: entry.generation, words: plain(entry.words, CHANGE_STORY_LIMITS.entry) }));
  } catch { return []; }
}

/**
 * The page's facts for a Story, or null when no code step has a published version yet [CSP:REQ-006]. `revision` is the
 * commit whose bytes the code steps delivered; null reads the checkout (inside the publication's own commit, before it).
 */
export async function buildChangeStory(root, config, workflow, { revision = null } = {}) {
  if (!workflow?.workItem?.id) return null;
  const steps = await codeSteps(workflow);
  if (!steps.length) return null;
  const { functionChanges, testCaseChanges } = await import('./change-story-functions.mjs');
  const files = await deliveredFiles(root, config, workflow, steps, revision);
  for (const file of files) {
    const tags = await tagsOf(file.path, file.after ?? file.before);
    if (file.test) {
      const cases = await testCaseChanges(file.path, file.before, file.after);
      const covered = testCriteria(cases, tags);
      file.cases = cases.map((entry) => ({ name: entry.name, change: entry.change, criteria: [...covered.get(entry)].sort() }));
      file.criteria = [...new Set(tags.map((tag) => tag.clauseId))].sort();
    } else {
      const changes = await functionChanges(file.path, file.before, file.after);
      file.read = changes.read;
      file.functions = changes.functions;
      file.criteria = [...new Set(tags.filter((tag) => tag.tag === 'clause').map((tag) => tag.clauseId))].sort();
    }
    delete file.before;
    delete file.after;
  }
  const words = await explanations(root, config, workflow, steps, files);
  for (const file of files.filter((entry) => !entry.test)) {
    for (const entry of file.functions ?? []) {
      const said = words.functions.get(`${file.path}\0${entry.key}`);
      if (said) entry.english = said;
    }
  }
  return {
    workId: workflow.workItem.id,
    title: plain(workflow.workItem.title, 200),
    asked: await asked(root, config, workflow),
    how: words.how,
    reasons: [...await documentReasons(root, config, workflow, steps[0]), ...words.reasons],
    files,
    tests: await testRun(root, workflow, steps),
    outsidePlan: await outsidePlan(workflow, steps),
    personDecisions: await personDecisions(workflow),
    withheld: words.withheld,
    codeSteps: steps.map((step) => ({ id: step.id, label: step.label ?? step.id, generation: Number(step.generation ?? 0) }))
  };
}

const CHANGE_WORDS = Object.freeze({ new: 'New', edited: 'Edited', removed: 'Removed' });

/** One function's line, in plain words, from Copilot's checked English or "not described yet". */
function functionLine(entry, helpers) {
  const said = entry.english;
  const parts = said ? [said.does, said.needs ? `It needs ${said.needs.replace(/^it needs\s+/iu, '')}` : null,
    said.gives ? `It gives back ${said.gives.replace(/^it gives back\s+/iu, '')}` : null,
    entry.change === 'edited' && said.changed ? `What changed: ${said.changed.replace(/^what changed:\s*/iu, '')}` : null]
    .filter(Boolean).map((text) => (/[.!?]$/u.test(text) ? text : `${text}.`)) : ['not described yet.'];
  const folded = helpers.map((helper) => `Also adds a small helper, ${code(helper.display)}, used only here.`);
  return `- **${CHANGE_WORDS[entry.change]}** ${code(entry.display)}: ${[...parts, ...folded].join(' ')}`;
}

const serves = (criteria) => (criteria.length ? ` (serves ${criteria.map(code).join(', ')})` : '');

/** The one-line summary the approval, the Work page and the read show. Plain words, under 120 characters. */
export function changeStorySummary(model) {
  const product = model.files.filter((file) => !file.test);
  const functions = product.flatMap((file) => file.functions ?? []).filter((entry) => !entry.helperOf).length;
  const tests = model.files.filter((file) => file.test).flatMap((file) => file.cases ?? []).filter((entry) => entry.change !== 'removed').length;
  const run = model.tests.ran ? `SFlow's run: ${model.tests.passed} passed${model.tests.failed ? `, ${model.tests.failed} failed` : ''}` : 'tests not run yet';
  return `${plural(product.length, 'file')} and ${plural(functions, 'function')} changed, ${plural(tests, 'test')}; ${run}.`;
}

/** The page, in Markdown [CSP §1]. Pure. */
export function renderChangeStory(model) {
  const summary = changeStorySummary(model);
  const out = [`<!-- ${CHANGE_STORY_MARKER} ${JSON.stringify({ summary, steps: model.codeSteps.map((step) => `${step.id}@${step.generation}`) })} -->`,
    `# What this change does: ${model.workId}, "${model.title}"`, '',
    '> Written by SFlow from its records, with the code step\'s own plain-English notes where they passed its checks. SFlow writes it again when the code or its tests change.', ''];
  out.push('## 1. What we had to do', '', model.asked.request || 'The Story records no request beyond its title.', '');
  if (model.asked.requirements.length) out.push('Requirements:', '', ...model.asked.requirements.map((clause) => `- ${code(clause.id)} ${clause.text}`), '');
  out.push('Acceptance criteria:', '', ...(model.asked.criteria.length ? model.asked.criteria.map((clause) => `- ${code(clause.id)} ${clause.text}`)
    : ['- None are recorded as criteria in the approved documents.']), '');
  out.push('## 2. How it works', '', model.how ?? 'Not described yet: the code step wrote no explanation SFlow could show.', '');
  out.push('## 3. Why we did it this way', '', ...(model.reasons.length ? model.reasons.map((reason) => `- ${reason.text.replace(/[.\s]+$/u, '')}. ${reason.label}`)
    : ['- No reason is recorded: the approved plan and design list no decisions, and the code step gave none.']), '');
  out.push('## 4. What we changed', '');
  const product = model.files.filter((file) => !file.test);
  // New and edited files first, then removed ones; the section ends with everything removed in one line.
  for (const file of [...product.filter((entry) => entry.change !== 'removed'), ...product.filter((entry) => entry.change === 'removed')]) {
    out.push(`**${CHANGE_WORDS[file.change]}** ${code(file.path)}${file.from ? ` (moved from ${code(file.from)})` : ''}${serves(file.criteria)}`, '');
    const functions = file.functions ?? [];
    const shown = functions.filter((entry) => !entry.helperOf);
    if (shown.length) out.push(...shown.map((entry) => functionLine(entry, functions.filter((helper) => helper.helperOf === entry.key))), '');
    else out.push(file.read === false ? '- SFlow does not list functions for this kind of file; see the file itself.' : '- No function was added, changed or removed; other lines changed.', '');
  }
  if (!product.length) out.push('No product file changed.', '');
  const removed = [...product.filter((file) => file.change === 'removed').map((file) => code(file.path)),
    ...product.filter((file) => file.change !== 'removed').flatMap((file) => (file.functions ?? []).filter((entry) => entry.change === 'removed')
      .map((entry) => `${code(entry.display)} from ${code(file.path)}`))];
  out.push(`Removed: ${removed.length ? `${list(removed)}.` : 'nothing.'}`, '');
  out.push('## 5. How it was tested', '');
  const tests = model.files.filter((file) => file.test);
  for (const file of tests) {
    out.push(`**${CHANGE_WORDS[file.change]}** ${code(file.path)}${file.criteria.length ? ` (covers ${file.criteria.map(code).join(', ')})` : ''}`, '');
    const cases = file.cases ?? [];
    out.push(...(cases.length ? cases.map((entry) => `- ${CHANGE_WORDS[entry.change]} test "${entry.name.replace(/"/gu, '\'')}"${entry.criteria.length ? `, covers ${entry.criteria.map(code).join(', ')}` : ''}`)
      : ['- SFlow found no test case it can name in this file.']), '');
  }
  if (!tests.length) out.push('No test file was added or changed.', '');
  out.push(model.tests.ran
    ? `SFlow ran them on the delivered code (${model.tests.step} version ${model.tests.generation}): ${model.tests.passed} passed${model.tests.failed ? `, ${model.tests.failed} failed` : ''}${model.tests.skipped ? `, ${model.tests.skipped} skipped` : ''}.`
    : `Tests not run yet: SFlow runs them${model.tests.next ? ` when ${model.tests.next} is published` : ' at the next step that runs tests'}, and this page says what it found.`, '');
  if (model.outsidePlan?.length) {
    out.push('## 6. Outside the plan', '', ...model.outsidePlan.map((entry) => `- ${code(entry.file)}: ${entry.supporting
      ? `${entry.writer === 'copilot' ? `by Copilot${entry.reason ? `: ${entry.reason}` : ''}` : 'by you'}, as a supporting change`
      : entry.writer === 'copilot' ? `by Copilot: ${entry.reason ?? 'no reason written'}` : 'by you'}`), '');
  }
  if (model.personDecisions?.length) {
    out.push(PERSON_DECISIONS_SECTION, '', ...model.personDecisions.map((entry) => `- ${entry.step} version ${entry.generation}: ${entry.words}`), '');
  }
  if (model.withheld) out.push(`_SFlow did not show ${plural(model.withheld, 'note')} from the code step: ${model.withheld === 1 ? 'it' : 'each'} had a link, markup, code or a secret's shape, or named something this change does not hold._`, '');
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * Write the Story's page from the records, inside a lifecycle commit [CSP:REQ-005]: `{ path, summary, written }`, or null when
 * no code step has a published version. The bytes are the same for the same records, so an unchanged page is not rewritten.
 */
export async function writeChangeStoryPage(root, config, workflow, { revision = null } = {}) {
  const model = await buildChangeStory(root, config, workflow, { revision });
  if (!model) return null;
  const text = renderChangeStory(model);
  const location = storyLocation(root, [workflow, config], workflow.workItem.id);
  const file = location.file(CHANGE_STORY_FILE);
  const before = await readFile(file, 'utf8').catch(() => null);
  if (before !== text) {
    const { writeText } = await import('./util.mjs');
    await writeText(file, text);
  }
  return { path: path.relative(root, file).split(path.sep).join('/'), summary: changeStorySummary(model), written: before !== text };
}
