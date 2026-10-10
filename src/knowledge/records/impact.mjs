/**
 * Impact records: what this Story's change touches, from the Story's own changed (or planned)
 * files, not from the last commit.
 *
 *   "RuleEngineService.compare (changed): called by evalCondition; on POST /api/v1/rule-engine/evaluate;
 *    6 rules; tested by RuleEngineServiceTest.java; often changes with Operator.java"
 *   "InterestRequest.java (planned): declares InterestRequest, taken by POST /interest/calculate;
 *    imported by 2 files"
 *
 * A changed file whose changed lines are known is read function by function: the functions those
 * lines fall in, with their callers, the entry points whose flow reaches them, the rules they hold,
 * the tests that reach them and the files that usually change with theirs. A planned file, or one
 * whose lines are not known, is read as a whole. A changed file that declares a type an endpoint
 * takes or returns is a contract change. Nothing here needs a model.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

function recordId(key) {
  return `K-impact-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function names(list, maximum = 3) {
  const shown = list.slice(0, maximum).join(', ');
  return list.length > maximum ? `${shown} and ${list.length - maximum} more` : shown;
}

/**
 * Changed line ranges per file from a diff preview read with no context lines
 * (`buildComprehensionDiffPreview(…, { contextLines: 0 })`). A pure deletion touches the line it
 * was removed after.
 */
export function changedRangesFromPreview(preview) {
  const ranges = new Map();
  if (preview?.status !== 'available') return ranges;
  for (const file of preview.files ?? []) {
    const target = file.pathAfter ?? null;
    if (!target) continue;
    const list = (file.hunks ?? []).map((hunk) => (hunk.afterLines > 0
      ? [hunk.afterStart, hunk.afterStart + hunk.afterLines - 1]
      : [Math.max(1, hunk.afterStart), Math.max(1, hunk.afterStart)]));
    ranges.set(target, list);
  }
  return ranges;
}

/**
 * What the working state (committed, staged, unstaged and new files) changes since `base`: the
 * changed paths (or `paths`, when the caller already knows them) and their changed line ranges.
 * Lines are read only for the paths `keep` accepts (the code files knowledge knows), so Story
 * records and other bulk changes cannot push the patch past its size limit. The ranges are null
 * when they cannot be read (no base, a merge in progress, a patch too large); the impact is then
 * read file by file.
 */
export async function readChange(root, base, { paths = null, keep = () => true } = {}) {
  if (!base) return { changedPaths: paths ?? [], changedRanges: null };
  try {
    const { buildRepositoryChangeSet } = await import('../../repository-change-set.mjs');
    const { buildComprehensionDiffPreview } = await import('../../comprehension/diff-preview.mjs');
    const changeSet = await buildRepositoryChangeSet(root, { baseCommit: base });
    const changedPaths = paths ?? changeSet.entries.map((entry) => entry.newPath).filter(Boolean).sort();
    const read = changedPaths.filter(keep);
    if (!read.length) return { changedPaths, changedRanges: null };
    return { changedPaths, changedRanges: changedRangesFromPreview(buildComprehensionDiffPreview(root, changeSet, { contextLines: 0, paths: read })) };
  } catch {
    return { changedPaths: paths ?? [], changedRanges: null };
  }
}

function overlaps(fn, ranges) {
  return ranges.some(([start, end]) => fn.start != null && fn.end != null && start <= fn.end && end >= fn.start);
}

/** The files repository knowledge read: the only ones whose changed lines can name a function. */
export function knowledgePaths(knowledge) {
  return new Set([...(knowledge?.graph?.functions ?? []).map((fn) => fn.file), ...(knowledge?.items ?? []).map((item) => item.subject?.path).filter(Boolean)]);
}

export function buildImpactRecords(knowledge, { changedPaths = [], changedRanges = null, plannedPaths = [] } = {}) {
  const items = knowledge?.items ?? [];
  const functions = knowledge?.graph?.functions ?? [];
  const calls = knowledge?.graph?.calls ?? [];
  const imports = knowledge?.graph?.imports ?? [];
  const known = knowledgePaths(knowledge);
  const changed = [...new Set(changedPaths)].filter((file) => known.has(file));
  const planned = [...new Set(plannedPaths)].filter((file) => known.has(file) && !changed.includes(file));
  const story = new Set([...changed, ...planned]);
  if (!story.size) return [];

  const callersOf = new Map();
  for (const [from, to] of calls) {
    if (from === to) continue;
    if (!callersOf.has(to)) callersOf.set(to, new Set());
    callersOf.get(to).add(from);
  }
  const importedBy = new Map();
  for (const [from, to] of imports) {
    if (!importedBy.has(to)) importedBy.set(to, new Set());
    importedBy.get(to).add(from);
  }
  const journeys = items.filter((item) => item.kind === 'journey');
  const entries = new Map(items.filter((item) => item.kind === 'entry-point').map((item) => [item.statement?.label, item]));
  const flowsThrough = (symbol) => journeys.filter((journey) => (journey.statement?.steps ?? []).includes(symbol)
    || entries.get(journey.statement?.trigger)?.subject?.symbol === symbol).map((journey) => journey.statement.trigger);
  const rulesOf = new Map();
  for (const item of items.filter((entry) => entry.kind === 'rule' && entry.subject?.symbol)) rulesOf.set(item.subject.symbol, (rulesOf.get(item.subject.symbol) ?? 0) + 1);
  const testsOf = new Map();
  for (const item of items.filter((entry) => entry.kind === 'test-case')) {
    for (const symbol of item.statement?.exercises ?? []) {
      if (!testsOf.has(symbol)) testsOf.set(symbol, new Set());
      testsOf.get(symbol).add(item.subject?.path);
    }
  }
  const testedThrough = new Map(items.filter((item) => item.kind === 'impact' && item.statement?.testedThrough).map((item) => [item.subject.symbol, item.statement.testedThrough]));
  const partners = new Map();
  for (const item of items.filter((entry) => entry.kind === 'co-change')) {
    const [left, right] = item.statement?.files ?? [];
    for (const [from, to] of [[left, right], [right, left]]) {
      if (!from || !to) continue;
      if (!partners.has(from)) partners.set(from, []);
      partners.get(from).push(to);
    }
  }
  // Types an endpoint takes or returns, by name: a change to the file declaring one changes that endpoint's contract.
  const endpointsByType = new Map();
  for (const item of entries.values()) {
    for (const type of [item.statement?.request?.type, item.statement?.response]) {
      const name = String(type ?? '').replace(/^list of /u, '');
      if (!name) continue;
      if (!endpointsByType.has(name)) endpointsByType.set(name, new Set());
      endpointsByType.get(name).add(`${item.statement.label}`.split(' → ')[0]);
    }
  }
  const declared = new Map();
  for (const item of items.filter((entry) => entry.kind === 'entity' || entry.kind === 'interface')) {
    const name = item.subject?.name ?? item.statement?.name;
    if (!item.subject?.path || !name) continue;
    if (!declared.has(item.subject.path)) declared.set(item.subject.path, new Set());
    declared.get(item.subject.path).add(name);
  }
  const basename = (file) => path.posix.basename(file);
  const shortName = (symbol) => String(symbol).split('.').pop();
  const contractText = (file) => [...(declared.get(file) ?? [])].filter((name) => endpointsByType.has(name))
    .map((name) => `declares ${name}, used by ${names([...endpointsByType.get(name)], 2)}`);
  const partnerText = (file) => {
    const outside = [...new Set(partners.get(file) ?? [])].filter((partner) => !story.has(partner));
    return outside.length ? `often changes with ${names(outside.map(basename), 2)}` : null;
  };

  const records = [];
  const functionRecord = (fn, state) => {
    const qn = fn.qualifiedName;
    const callers = [...(callersOf.get(qn) ?? [])].sort();
    // A caller in the same class is named by its method; one elsewhere keeps its class (OrderController.cancel, not cancel).
    const owner = qn.split('.').slice(0, -1).join('.');
    const callerName = (caller) => (caller.split('.').slice(0, -1).join('.') === owner ? shortName(caller) : caller);
    const flows = [...new Set(flowsThrough(qn))];
    const rules = rulesOf.get(qn) ?? 0;
    const tests = [...(testsOf.get(qn) ?? [])];
    const via = tests.length ? null : testedThrough.get(qn);
    const parts = [
      callers.length ? `called by ${names(callers.map(callerName))}` : null,
      flows.length ? `on ${names(flows, 2)}` : null,
      rules ? plural(rules, 'rule') : null,
      tests.length ? `tested by ${names(tests.map(basename), 2)}` : via ? `tested through ${via}` : 'no test reaches it',
      partnerText(fn.file)
    ].filter(Boolean);
    records.push({
      id: recordId(`${state}:${fn.file}:${qn}`), kind: 'impact', scope: 'function', state,
      text: `${qn} (${state}): ${parts.join('; ')}`,
      parts: { symbol: qn, path: fn.file, callers, flows, rules, tests, testedThrough: via ?? null },
      sources: { code: [{ path: fn.file, line: fn.start ?? null }] },
      weight: flows.length * 4 + callers.length * 2 + rules + (tests.length || via ? 0 : 2)
    });
  };
  const fileRecord = (file, state) => {
    const inFile = functions.filter((fn) => fn.file === file);
    const flows = [...new Set(inFile.flatMap((fn) => flowsThrough(fn.qualifiedName)))];
    const rules = inFile.reduce((total, fn) => total + (rulesOf.get(fn.qualifiedName) ?? 0), 0);
    const tests = [...new Set(inFile.flatMap((fn) => [...(testsOf.get(fn.qualifiedName) ?? [])]))];
    const importers = [...(importedBy.get(file) ?? [])].filter((importer) => !story.has(importer));
    const parts = [
      ...contractText(file),
      flows.length ? `on ${names(flows, 2)}` : null,
      importers.length ? `imported by ${plural(importers.length, 'file')}` : null,
      rules ? plural(rules, 'rule') : null,
      tests.length ? `tested by ${names(tests.map(basename), 2)}` : rules ? 'no test reaches it' : null,
      partnerText(file)
    ].filter(Boolean);
    if (!parts.length) return;
    records.push({
      id: recordId(`${state}:${file}`), kind: 'impact', scope: 'file', state,
      text: `${file} (${state}): ${parts.join('; ')}`,
      parts: { path: file, functions: inFile.length, flows, rules, tests, importedBy: importers },
      sources: { code: [{ path: file, line: null }] },
      weight: flows.length * 4 + importers.length + rules + (contractText(file).length ? 6 : 0)
    });
  };

  for (const file of changed) {
    const ranges = changedRanges?.get?.(file) ?? null;
    const touched = ranges ? functions.filter((fn) => fn.file === file && overlaps(fn, ranges)) : [];
    // A contract change is a file fact: say it once, then each function the change falls in.
    if (contractText(file).length || !touched.length) fileRecord(file, 'changed');
    for (const fn of touched) functionRecord(fn, 'changed');
  }
  for (const file of planned) fileRecord(file, 'planned');
  return records.sort((a, b) => Number(a.state === 'planned') - Number(b.state === 'planned') || b.weight - a.weight || a.text.localeCompare(b.text, 'en'));
}

/** The functions a change's lines fall in, from its impact records. */
export function impactSymbols(records) {
  return records.filter((record) => record.scope === 'function' && record.state === 'changed').map((record) => record.parts.symbol);
}

export function renderImpactRecords(records, { maximum = 12, title = 'What this change touches' } = {}) {
  if (!records.length) return '';
  return [
    `## ${title}`,
    '',
    ...records.slice(0, maximum).map((record) => `- ${record.text}${record.scope === 'function' && record.sources.code[0]?.line ? ` (${record.sources.code[0].path}:${record.sources.code[0].line})` : ''}`),
    records.length > maximum ? `- …and ${records.length - maximum} more` : null
  ].filter((line) => line != null).join('\n');
}
