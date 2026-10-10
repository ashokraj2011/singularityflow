/**
 * Risk records: where a change is risky, and why, in words.
 *
 *   "RuleEngineService.java: changed 4 times in 12 months, complexity 102, imported by 2 files;
 *    mostly changed by one person"
 *   "RuleEngineService.evalCondition: the most complex function (complexity 40), reached by
 *    1 entry point, 10 rules"
 *
 * Built from repository knowledge: file hotspots carry the history (how often a file changed,
 * needed a fix, changes with others, who changes it); function risk carries what is true of one
 * function (complexity, entry points and callers reaching it, rules, test reach). History is a
 * file fact, so a function repeats it only when its file has no record of its own. Tests that
 * contradict the code, and functions with rules no test reaches, are risks too. Records in a
 * Story's changed files rank first (the functions its changed lines fall in before the rest of
 * those files, when `changedSymbols` names them), then those matching its words.
 */
import { createHash } from 'node:crypto';

import { subjectWords } from './anchors.mjs';

function recordId(key) {
  return `K-risk-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function historyReasons(statement) {
  return [
    statement.changes >= 2 ? `changed ${statement.changes} times in 12 months` : null,
    statement.fixes >= 1 ? plural(statement.fixes, 'fix commit') : null
  ].filter(Boolean);
}

function ownershipText(statement) {
  if (statement.authors >= 4) return `${statement.authors} people change it`;
  return statement.changes >= 3 && statement.topAuthorShare >= 0.75 ? 'mostly changed by one person' : null;
}

export function buildRiskRecords(knowledge, { focus = null, changedPaths = [], changedSymbols = null } = {}) {
  const items = knowledge?.items ?? [];
  const changedFiles = new Set(changedPaths);
  // 2: the change falls in it; 1: it is in a changed file. Without changed lines, a changed file's functions count as changed.
  const touched = new Set(changedSymbols ?? []);
  const changeOf = (item) => {
    if (!changedFiles.has(item.subject?.path)) return 0;
    if (!item.subject?.symbol || !changedSymbols) return 2;
    return touched.has(item.subject.symbol) ? 2 : 1;
  };
  const records = [];
  const filesWithRecords = new Set();
  for (const item of items.filter((entry) => entry.kind === 'hotspot')) {
    const statement = item.statement ?? {};
    const reasons = [
      ...historyReasons(statement),
      statement.complexity >= 20 ? `complexity ${statement.complexity}` : null,
      statement.importedBy >= 2 ? `imported by ${statement.importedBy} files` : null,
      statement.coChanges >= 1 ? `changes together with ${plural(statement.coChanges, 'other file')}` : null
    ].filter(Boolean);
    if (reasons.length < 2) continue;
    const ownership = ownershipText(statement);
    filesWithRecords.add(item.subject?.path);
    records.push({
      id: recordId(item.id), kind: 'risk', scope: 'file',
      text: `${item.subject?.path}: ${reasons.join(', ')}${ownership ? `; ${ownership}` : ''}`,
      parts: { path: item.subject?.path, ...statement },
      sources: { code: [{ path: item.subject?.path, line: null }] },
      score: statement.score ?? 0, change: changeOf(item)
    });
  }
  const journeys = items.filter((item) => item.kind === 'journey');
  const entryCount = items.filter((item) => item.kind === 'entry-point' && item.statement?.kind === 'http').length;
  const reach = (symbol) => journeys.filter((journey) => (journey.statement?.steps ?? []).includes(symbol)).length;
  const risks = items.filter((item) => item.kind === 'risk');
  const mostComplex = Math.max(0, ...risks.map((item) => item.statement?.complexity ?? 0));
  for (const item of risks) {
    const statement = item.statement ?? {};
    const reached = reach(item.subject?.symbol);
    const reasons = [
      statement.complexity >= 10 ? (statement.complexity === mostComplex && risks.length > 1 ? `the most complex function (complexity ${statement.complexity})` : `complexity ${statement.complexity}`) : null,
      reached ? (entryCount > 1 && reached >= entryCount ? 'reached by every endpoint' : `reached by ${plural(reached, 'entry point')}`) : null,
      statement.callers >= 2 ? `called from ${statement.callers} places` : null,
      statement.rules >= 3 ? plural(statement.rules, 'rule') : null,
      statement.tested === false && statement.rules >= 1 ? 'no test reaches it' : null,
      ...(filesWithRecords.has(item.subject?.path) ? [] : historyReasons(statement))
    ].filter(Boolean);
    if (!reasons.length) continue;
    const citation = item.citations?.[0];
    records.push({
      id: recordId(item.id), kind: 'risk', scope: 'function',
      text: `${item.subject?.symbol}: ${reasons.join(', ')}`,
      parts: { symbol: item.subject?.symbol, path: item.subject?.path, reached, ...statement },
      sources: { code: citation ? [{ path: citation.path, line: citation.lines?.[0] ?? null }] : [{ path: item.subject?.path, line: null }] },
      score: statement.score ?? 0, change: changeOf(item)
    });
  }
  // A test that says one thing while the code does another, and rules no test reaches.
  for (const item of items.filter((entry) => entry.kind === 'drift')) {
    records.push({
      id: recordId(item.id), kind: 'risk', scope: 'drift',
      text: `${item.subject?.symbol}: test and code disagree: ${item.statement?.detail ?? ''}`,
      parts: { symbol: item.subject?.symbol, path: item.subject?.path, ...item.statement },
      sources: { code: [{ path: item.subject?.path, line: null }] },
      score: 1000, change: changeOf(item)
    });
  }
  const named = new Set(records.map((record) => record.parts.symbol).filter(Boolean));
  for (const item of items.filter((entry) => entry.kind === 'untested-rule' && !named.has(entry.subject?.symbol))) {
    records.push({
      id: recordId(item.id), kind: 'risk', scope: 'function',
      text: `${item.subject?.symbol}: ${plural(item.statement?.rules ?? 0, 'rule')}, no test reaches it`,
      parts: { symbol: item.subject?.symbol, path: item.subject?.path, rules: item.statement?.rules ?? 0, tested: false },
      sources: { code: [{ path: item.subject?.path, line: null }] },
      score: 10 * (item.statement?.rules ?? 1), change: changeOf(item)
    });
  }
  const focusWords = subjectWords(focus);
  const relevance = (record) => [...subjectWords(record.parts.symbol ?? record.parts.path ?? '')].filter((word) => focusWords.has(word)).length;
  return records
    .map((record) => ({ ...record, relevance: relevance(record) }))
    .sort((a, b) => b.change - a.change || b.relevance - a.relevance || b.score - a.score || a.text.localeCompare(b.text, 'en'));
}

export function renderRiskRecords(records, { maximum = 10, changedLabel = '(changed) ' } = {}) {
  if (!records.length) return '';
  const source = (record) => record.scope === 'function' && record.sources.code[0]?.line ? ` (${record.sources.code[0].path}:${record.sources.code[0].line})` : '';
  return [
    '## Risky places',
    '',
    ...records.slice(0, maximum).map((record) => `- ${record.change === 2 ? changedLabel : ''}${record.text}${source(record)}`),
    records.length > maximum ? `- …and ${records.length - maximum} more` : null
  ].filter((line) => line != null).join('\n');
}
