/**
 * Rules kept as data: JSON and YAML rule objects in rule folders (`rules/`, `policies/`, `decisions/`,
 * …) or files named `*rules.json|yml`. A rule object has a condition and an outcome
 * (`when`/`if`/`condition` with `then`/`action`/`outcome`/`decision`/…); its conditions are read as
 * `field op value` lines, whether written as `{ field, op, value }`, as nested `all`/`any` groups or
 * as `{ age: { gte: 18 } }`. Values are recorded so docs can be compared with them; a value under a
 * secret-like key, or one the secret scanner flags, is withheld.
 */
import path from 'node:path';

import YAML from 'yaml';

import { scanText } from '../secrets.mjs';

export const RULE_FILE = /(?:^|\/)(?:rules?|rulesets?|business-rules|polic(?:y|ies)|decisions?|decision-tables?)\/(?:[^/]+\/)*[^/]+\.(?:json|ya?ml)$|(?:^|\/)[\w.-]*rules?\.(?:json|ya?ml)$/iu;
const NOT_RULES = /(?:^|\/)(?:package(?:-lock)?\.json|tsconfig[\w.-]*\.json|\.eslintrc[\w.-]*|eslint[\w.-]*\.json|openapi\.(?:json|ya?ml)|docker-compose[\w.-]*\.ya?ml)$/iu;
const CONDITION_KEYS = ['when', 'if', 'condition', 'conditions', 'criteria', 'match', 'predicate', 'given'];
const OUTCOME_KEYS = ['then', 'action', 'actions', 'outcome', 'result', 'decision', 'effect', 'do', 'output', 'event'];
const SECRET_KEY = /(?:pass(?:word)?|secret|token|api[-_.]?key|credential|private[-_.]?key)/iu;
const OPERATORS = Object.freeze({
  eq: '==', equal: '==', equals: '==', '==': '==', '=': '==', is: '==',
  ne: '!=', neq: '!=', notequal: '!=', notequals: '!=', '!=': '!=',
  gt: '>', greaterthan: '>', '>': '>', gte: '>=', ge: '>=', greaterthaninclusive: '>=', '>=': '>=', min: '>=',
  lt: '<', lessthan: '<', '<': '<', lte: '<=', le: '<=', lessthaninclusive: '<=', '<=': '<=', max: '<=',
  in: 'in', notin: 'not in', contains: 'contains', doesnotcontain: 'does not contain', matches: 'matches', regex: 'matches', between: 'between'
});

export function isRuleFile(relative) {
  return RULE_FILE.test(relative) && !NOT_RULES.test(relative);
}

function operatorOf(value) {
  return OPERATORS[String(value ?? '').toLowerCase().replace(/[\s_-]+/gu, '')] ?? null;
}

function safe(key, value) {
  if (value == null || typeof value === 'object') return value;
  if (SECRET_KEY.test(String(key ?? '')) || scanText(`${key ?? 'value'}: ${value}`).length) return '(withheld)';
  return value;
}

function literal(value) {
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'string') return value === '(withheld)' ? value : JSON.stringify(value);
  return String(value);
}

/** Condition lines from any of the common shapes. */
function conditions(node, depth = 0) {
  if (node == null || depth > 6) return [];
  if (Array.isArray(node)) return node.flatMap((entry) => conditions(entry, depth + 1));
  if (typeof node !== 'object') return [String(node)];
  const field = node.field ?? node.fact ?? node.path ?? node.attribute ?? node.property ?? node.key;
  const op = operatorOf(node.op ?? node.operator ?? node.comparator ?? node.is);
  if (field != null && (op || 'value' in node)) return [`${field} ${op ?? '=='} ${literal(safe(field, node.value ?? node.values))}`];
  const lines = [];
  for (const [key, value] of Object.entries(node)) {
    if (['all', 'any', 'and', 'or', 'none', 'not'].includes(key.toLowerCase())) {
      const inner = conditions(value, depth + 1);
      if (['any', 'or'].includes(key.toLowerCase()) && inner.length > 1) lines.push(`any of (${inner.join('; ')})`);
      else if (['none', 'not'].includes(key.toLowerCase())) lines.push(`not (${inner.join('; ')})`);
      else lines.push(...inner);
      continue;
    }
    // `{ age: { gte: 18 } }` or `{ status: "PLACED" }`
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [operator, operand] of Object.entries(value)) {
        const symbol = operatorOf(operator);
        if (symbol) lines.push(`${key} ${symbol} ${literal(safe(key, operand))}`);
      }
    } else if (!OUTCOME_KEYS.includes(key.toLowerCase())) {
      lines.push(`${key} == ${literal(safe(key, value))}`);
    }
  }
  return lines.filter(Boolean);
}

function outcomeText(node) {
  if (node == null) return '';
  if (typeof node !== 'object') return String(safe('outcome', node));
  if (Array.isArray(node)) return node.map(outcomeText).filter(Boolean).join('; ');
  return Object.entries(node).map(([key, value]) => `${key} = ${typeof value === 'object' ? JSON.stringify(value) : literal(safe(key, value))}`).join(', ');
}

function lineOf(lines, needles) {
  for (const needle of needles.filter((value) => value != null && String(value).length > 1)) {
    const index = lines.findIndex((line) => line.includes(String(needle)));
    if (index >= 0) return index + 1;
  }
  return 1;
}

/** Every rule object in one rule file, with its conditions, outcome, values and line. */
export function ruleFileRules(file) {
  if (!isRuleFile(file.path)) return [];
  const text = file.lines.join('\n');
  let documents;
  try {
    documents = /\.json$/iu.test(file.path) ? [JSON.parse(text)] : YAML.parseAllDocuments(text).map((document) => document.toJS());
  } catch {
    return [];
  }
  const rules = [];
  const visit = (node, trail, depth) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { node.forEach((entry, index) => visit(entry, [...trail, index], depth + 1)); return; }
    const keys = Object.keys(node);
    const conditionKey = keys.find((key) => CONDITION_KEYS.includes(key.toLowerCase()));
    const outcomeKey = keys.find((key) => OUTCOME_KEYS.includes(key.toLowerCase()));
    if (conditionKey && outcomeKey) {
      const name = node.name ?? node.id ?? node.rule ?? node.title ?? node.key ?? trail.filter((part) => typeof part === 'string').at(-1) ?? `${path.posix.basename(file.path)} #${rules.length + 1}`;
      const when = conditions(node[conditionKey]);
      const then = outcomeText(node[outcomeKey]);
      const numbers = when.flatMap((line) => line.match(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/gu) ?? []);
      const strings = when.flatMap((line) => [...line.matchAll(/"([^"]{1,80})"/gu)].map((match) => match[1]));
      rules.push({ name: String(name), when, then, values: { numbers, strings, constants: [] }, line: lineOf(file.lines, [node.name, node.id, node.rule, node.title, conditionKey]) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === conditionKey || key === outcomeKey) continue;
      visit(value, [...trail, key], depth + 1);
    }
  };
  documents.forEach((document) => visit(document, [], 0));
  return rules;
}
