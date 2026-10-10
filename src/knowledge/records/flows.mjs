/**
 * Flow records: what happens, step by step, when someone uses a feature.
 *
 *   "POST /api/v1/rule-engine/evaluate → RuleEngineController.evaluate → RuleEngineService.evaluate →
 *    evalGroup → evalCondition (and 5 helpers: textOrNull, resolvePath, dataContainsPath, …); refuses
 *    6 ways (HTTP 400); 38 rules on the way; returns EvaluateResponse"
 *
 * Built from repository knowledge: each entry point's journey (everything it reaches a few calls
 * down), the rules and refusals on it with their statuses, the effects it has (database, messages,
 * files, outbound calls) and the response its handler declares. Ranked by a Story's words.
 */
import { createHash } from 'node:crypto';

import { statusNumber, subjectWords } from './anchors.mjs';

function recordId(key) {
  return `F-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

/** `A.b → A.c → B.d` shown as `A.b → c → B.d`: a step in the same class as the one before drops the class. */
export function stepsText(steps) {
  const shown = [];
  let owner = null;
  for (const step of steps) {
    const parts = String(step).split('.');
    const name = parts.pop();
    const cls = parts.join('.');
    shown.push(cls && cls === owner ? name : step);
    owner = cls || owner;
  }
  return shown.join(' → ');
}

/**
 * A journey's steps are everything its entry reaches, breadth first; they are not one path. The
 * path shown is the call chain from the handler to the step with the most rules (the deepest on a
 * tie); the other steps are helpers along the way.
 */
export function mainChain(steps, calls, weight = () => 0) {
  if (steps.length < 2) return { chain: steps, helpers: [] };
  const inJourney = new Set(steps);
  const callees = new Map();
  for (const [from, to] of calls ?? []) {
    if (from === to || !inJourney.has(from) || !inJourney.has(to)) continue;
    if (!callees.has(from)) callees.set(from, []);
    callees.get(from).push(to);
  }
  const parent = new Map([[steps[0], null]]);
  const depth = new Map([[steps[0], 0]]);
  const queue = [steps[0]];
  while (queue.length) {
    const current = queue.shift();
    for (const next of callees.get(current) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, current);
      depth.set(next, depth.get(current) + 1);
      queue.push(next);
    }
  }
  const target = [...parent.keys()].sort((a, b) => weight(b) - weight(a) || depth.get(b) - depth.get(a) || steps.indexOf(a) - steps.indexOf(b))[0];
  const chain = [];
  for (let at = target; at != null; at = parent.get(at)) chain.unshift(at);
  return { chain, helpers: steps.filter((step) => !chain.includes(step)) };
}

function helpersText(helpers) {
  if (!helpers.length) return '';
  const names = helpers.slice(0, 3).map((step) => String(step).split('.').pop());
  return ` (and ${helpers.length} ${helpers.length === 1 ? 'helper' : 'helpers'}: ${names.join(', ')}${helpers.length > 3 ? ', …' : ''})`;
}

// Every endpoint responds and almost everything logs; neither says what a flow does.
const QUIET_EFFECT = /^(?:responds with|writes logs$)/u;

export function buildFlowRecords(knowledge, { focus = null } = {}) {
  const items = knowledge?.items ?? [];
  const entries = new Map(items.filter((item) => item.kind === 'entry-point').map((item) => [item.statement?.label, item]));
  const rulesBySymbol = new Map();
  for (const item of items.filter((entry) => entry.kind === 'rule' && entry.subject?.symbol)) {
    if (!rulesBySymbol.has(item.subject.symbol)) rulesBySymbol.set(item.subject.symbol, []);
    rulesBySymbol.get(item.subject.symbol).push(item);
  }
  const errorsBySymbol = new Map();
  for (const item of items.filter((entry) => entry.kind === 'error-path' && entry.subject?.symbol)) {
    if (!errorsBySymbol.has(item.subject.symbol)) errorsBySymbol.set(item.subject.symbol, []);
    errorsBySymbol.get(item.subject.symbol).push(item.statement);
  }
  const records = [];
  for (const journey of items.filter((item) => item.kind === 'journey')) {
    const statement = journey.statement ?? {};
    const steps = (statement.steps ?? []).filter(Boolean);
    if (!steps.length) continue;
    const entry = entries.get(statement.trigger) ?? null;
    // A handler named in the trigger is left out of the steps; its rules and refusals count too.
    const reached = [...new Set([entry?.subject?.symbol, ...steps].filter(Boolean))];
    const rules = reached.flatMap((symbol) => rulesBySymbol.get(symbol) ?? []);
    const refusals = rules.filter((rule) => rule.statement?.then?.kind === 'refuses');
    const statuses = [...new Set(reached.flatMap((symbol) => errorsBySymbol.get(symbol) ?? []).map((error) => statusNumber(error.status)).filter(Boolean))].sort();
    const effects = (statement.effects ?? []).filter((effect) => effect && !QUIET_EFFECT.test(effect));
    const { chain, helpers } = mainChain(steps, knowledge?.graph?.calls, (symbol) => (rulesBySymbol.get(symbol) ?? []).length);
    const response = entry?.statement?.response ?? null;
    const parts = [
      `${statement.trigger} → ${stepsText(chain)}${helpersText(helpers)}`,
      refusals.length ? `refuses ${refusals.length} ${refusals.length === 1 ? 'way' : 'ways'}${statuses.length ? ` (HTTP ${statuses.join(', ')})` : ''}` : null,
      rules.length ? `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} on the way` : null,
      effects.length ? effects.slice(0, 3).join(', ') : null,
      response ? `returns ${response}` : null
    ].filter(Boolean);
    const citation = entry?.citations?.[0] ?? journey.citations?.[0] ?? null;
    records.push({
      id: recordId(journey.id), kind: 'flow', text: parts.join('; '),
      parts: { trigger: statement.trigger, steps, chain, rules: rules.length, refusals: refusals.length, statuses, effects, response },
      sources: { code: citation ? [{ path: citation.path, line: citation.lines?.[0] ?? null }] : journey.subject?.path ? [{ path: journey.subject.path, line: null }] : [] }
    });
  }
  const focusWords = subjectWords(focus);
  const relevance = (record) => [...subjectWords(`${record.parts.trigger} ${record.parts.steps.join(' ')}`)].filter((word) => focusWords.has(word)).length;
  return records
    .map((record) => ({ ...record, relevance: relevance(record) }))
    .sort((a, b) => b.relevance - a.relevance || b.parts.rules - a.parts.rules || a.text.localeCompare(b.text, 'en'));
}

export function renderFlowRecords(records, { maximum = 12 } = {}) {
  if (!records.length) return '';
  const source = (record) => record.sources.code[0] ? ` (${record.sources.code[0].path}${record.sources.code[0].line ? `:${record.sources.code[0].line}` : ''})` : '';
  return [
    '## Flows',
    '',
    ...records.slice(0, maximum).map((record) => `- ${record.text}${source(record)}`),
    records.length > maximum ? `- …and ${records.length - maximum} more` : null
  ].filter((line) => line != null).join('\n');
}
