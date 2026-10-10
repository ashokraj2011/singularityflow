/**
 * Contract records: what the system exposes and depends on, one plain line each.
 *
 *   endpoint     "POST /interest/calculate takes InterestRequest {principal, rate, period: BigDecimal}
 *                 and returns InterestResult; refuses with 400 (4 checks); tested"
 *   seam         "PaymentGateway is implemented by StripeGateway, PaypalGateway"
 *   repository   "OrderRepository stores Order (id Long); finders findByCustomerId"
 *   client       "Calls POST https://payments.example.com/charge via declared client"
 *   shape        "OrderStatus: PLACED, PAID, SHIPPED, CANCELLED"
 *   configuration "orders.max-items = 20"
 *
 * Built without a model from repository knowledge: endpoint signatures, data shapes with their
 * validation constraints, the error statuses reachable from each handler, test reach, interfaces
 * and repositories. Ranked by a Story's words, then by kind.
 */
import { createHash } from 'node:crypto';

import { constraintText } from '../validation.mjs';
import { statusNumber, subjectWords } from './anchors.mjs';

const CATEGORY_ORDER = Object.freeze({ endpoint: 0, seam: 1, repository: 2, client: 3, shape: 4, configuration: 5 });
const SECRET_KEY = /(?:pass(?:word)?|secret|token|api[-_.]?key|credential|private[-_.]?key)/iu;

function recordId(key) {
  return `C-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function source(item) {
  const citation = item.citations?.[0];
  return citation ? { path: citation.path, line: citation.lines?.[0] ?? null } : item.subject?.path ? { path: item.subject.path, line: null } : null;
}

/** `{principal, rate, period: BigDecimal; lines: List<String> (required, at most 20 long)}`. */
export function shapeText(entity, constraints = new Map(), { maximumFields = 8 } = {}) {
  const fields = (entity?.statement?.fields ?? []).slice(0, maximumFields);
  if (!fields.length) return '';
  const parts = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    parts.push(`${group.map((field) => field.name).join(', ')}${group[0].type ? `: ${group[0].type}` : ''}`);
    group = [];
  };
  for (const field of fields) {
    const rules = constraints.get(field.name);
    if (rules?.length) {
      flush();
      parts.push(`${field.name}${field.type ? `: ${field.type}` : ''} (${constraintText(rules)})`);
      continue;
    }
    if (group.length && group[0].type !== field.type) flush();
    group.push(field);
  }
  flush();
  const more = (entity.statement.fields?.length ?? 0) - fields.length;
  return `{${parts.join('; ')}${more > 0 ? `; … ${more} more` : ''}}`;
}

export function buildContractRecords(knowledge, { focus = null, configurationLimit = 6 } = {}) {
  const items = knowledge?.items ?? [];
  const entities = new Map(items.filter((item) => item.kind === 'entity' && item.statement?.name).map((item) => [item.statement.name, item]));
  const constraintsByType = new Map();
  for (const item of items.filter((entry) => entry.kind === 'validation')) {
    if (!constraintsByType.has(item.statement.type)) constraintsByType.set(item.statement.type, new Map());
    constraintsByType.get(item.statement.type).set(item.statement.field, item.statement.constraints);
  }
  const errorsBySymbol = new Map();
  for (const item of items.filter((entry) => entry.kind === 'error-path' && entry.subject?.symbol)) {
    if (!errorsBySymbol.has(item.subject.symbol)) errorsBySymbol.set(item.subject.symbol, []);
    errorsBySymbol.get(item.subject.symbol).push(item.statement);
  }
  const journeys = items.filter((item) => item.kind === 'journey');
  const tests = items.filter((item) => item.kind === 'test-case');
  const typeShape = (type) => {
    const name = String(type ?? '').replace(/^list of /u, '');
    const entity = entities.get(name);
    return entity ? `${type} ${shapeText(entity, constraintsByType.get(name))}` : type;
  };

  const records = [];
  const usedTypes = new Set();
  for (const item of items.filter((entry) => entry.kind === 'entry-point')) {
    const statement = item.statement ?? {};
    const handler = item.subject?.symbol ?? null;
    if (statement.kind !== 'http') {
      if (['message', 'timer', 'program'].includes(statement.kind)) {
        records.push({ id: recordId(item.id), kind: 'contract', category: 'endpoint', text: statement.label, parts: { kind: statement.kind, handler }, sources: { code: [source(item)].filter(Boolean) }, tested: null });
      }
      continue;
    }
    const steps = new Set([handler, ...(journeys.find((journey) => journey.statement?.trigger === statement.label)?.statement?.steps ?? [])].filter(Boolean));
    const refusals = [...steps].flatMap((symbol) => errorsBySymbol.get(symbol) ?? []);
    const statuses = [...new Set(refusals.map((entry) => statusNumber(entry.status)).filter(Boolean))].sort();
    const request = statement.request?.type ?? null;
    const response = statement.response ?? null;
    for (const type of [request, response]) if (type) usedTypes.add(String(type).replace(/^list of /u, ''));
    const params = (statement.params ?? []).map((param) => `${param.in} ${param.name}`);
    const takes = [request ? typeShape(request) : null, params.length ? `${params.join(', ')}` : null].filter(Boolean).join(' with ');
    // Tested when a test reaches the handler or a function on its flow (a service test of the same rule).
    const testedBy = tests.filter((test) => (test.statement?.exercises ?? []).some((symbol) => steps.has(symbol))).map((test) => test.statement.title);
    // The request shows its fields (the input contract); the response is named, its fields are under data shapes.
    const returns = !response ? 'no body' : response === request ? 'it' : response;
    const text = `${statement.label}${takes ? ` takes ${takes}` : ''} and returns ${returns}${statuses.length ? `; refuses with ${statuses.join(', ')} (${refusals.length} ${refusals.length === 1 ? 'check' : 'checks'})` : ''}`;
    records.push({
      id: recordId(item.id), kind: 'contract', category: 'endpoint', text,
      parts: { method: statement.label.split(' ')[0], path: statement.label.split(' ').slice(1).join(' '), handler, request, response, params: statement.params ?? [], statuses },
      sources: { code: [source(item)].filter(Boolean) }, tested: testedBy.length > 0, tests: testedBy
    });
  }
  for (const item of items.filter((entry) => entry.kind === 'interface')) {
    const statement = item.statement ?? {};
    if (statement.kind === 'repository') {
      records.push({
        id: recordId(item.id), kind: 'contract', category: 'repository',
        text: `${statement.name} stores ${statement.entity} (id ${statement.id})${statement.methods?.length ? `; finders ${statement.methods.join(', ')}` : ''}`,
        parts: { name: statement.name, entity: statement.entity, id: statement.id, methods: statement.methods ?? [] }, sources: { code: [source(item)].filter(Boolean) }
      });
      usedTypes.add(statement.entity);
    } else {
      const implementations = statement.implementations ?? [];
      records.push({
        id: recordId(item.id), kind: 'contract', category: 'seam',
        text: `${statement.name} (${statement.kind}) is implemented by ${implementations.map((entry) => entry.name).join(', ')}`,
        parts: { name: statement.name, implementations },
        sources: { code: [source(item), ...implementations.slice(0, 2).map((entry) => ({ path: entry.path, line: entry.line }))].filter(Boolean) }
      });
    }
  }
  for (const item of items.filter((entry) => entry.kind === 'external-dependency')) {
    const statement = item.statement ?? {};
    if (!/[/.:]/u.test(String(statement.target ?? ''))) continue;
    records.push({
      id: recordId(item.id), kind: 'contract', category: 'client',
      text: `Calls ${[statement.method, statement.target].filter(Boolean).join(' ')}${statement.via ? ` via ${statement.via}` : ''}`,
      parts: { method: statement.method ?? null, target: statement.target, via: statement.via ?? null }, sources: { code: [source(item)].filter(Boolean) }
    });
  }
  for (const [name, entity] of entities) {
    const values = entity.statement?.values ?? [];
    const used = usedTypes.has(name);
    if (!values.length && !used) continue;
    records.push({
      id: recordId(entity.id), kind: 'contract', category: 'shape',
      text: values.length ? `${entity.statement.kind ?? 'enum'} ${name}: ${values.slice(0, 12).join(', ')}${values.length > 12 ? ', …' : ''}` : `${entity.statement.kind ?? 'type'} ${name} ${shapeText(entity, constraintsByType.get(name))}`,
      parts: { name, kind: entity.statement.kind ?? null, values, fields: entity.statement.fields ?? [] }, sources: { code: [source(entity)].filter(Boolean) }
    });
  }
  for (const item of items.filter((entry) => entry.kind === 'configuration' && entry.statement?.key && !/^(?:android permission|Gradle modules)$/u.test(entry.statement.key)).slice(0, configurationLimit)) {
    const value = SECRET_KEY.test(item.statement.key) ? '(withheld)' : item.statement.value;
    records.push({
      id: recordId(item.id), kind: 'contract', category: 'configuration',
      text: `Configuration ${item.statement.key}${value != null && value !== '' ? ` = ${value}` : ''}`,
      parts: { key: item.statement.key, value }, sources: { code: [source(item)].filter(Boolean) }
    });
  }
  const focusWords = subjectWords(focus);
  // A program start, timer or listener is context, not a contract a Story changes: it never ranks on words.
  const background = (record) => ['program', 'timer', 'message'].includes(record.parts?.kind);
  const relevance = (record) => (background(record) ? 0 : [...subjectWords(record.text)].filter((word) => focusWords.has(word)).length);
  const order = (record) => (background(record) ? 9 : CATEGORY_ORDER[record.category]);
  return records
    .map((record) => ({ ...record, relevance: relevance(record) }))
    .sort((a, b) => b.relevance - a.relevance || order(a) - order(b) || a.text.localeCompare(b.text, 'en'));
}

/** The records as a Markdown section for people (`wm knowledge show contracts`). */
export function renderContractRecords(records, { limit = 60 } = {}) {
  if (!records.length) return '';
  const titles = { endpoint: 'Exposed', seam: 'Seams', repository: 'Storage', client: 'Called', shape: 'Data shapes', configuration: 'Configuration' };
  const lines = ['## Contracts', ''];
  for (const category of Object.keys(CATEGORY_ORDER)) {
    const entries = records.filter((record) => record.category === category).slice(0, limit);
    if (!entries.length) continue;
    lines.push(`### ${titles[category]}`, '');
    for (const record of entries) {
      const at = record.sources.code.filter(Boolean).slice(0, 2).map((entry) => `${entry.path}${entry.line ? `:${entry.line}` : ''}`);
      const tested = record.tested == null ? '' : record.tested ? '; tested' : '; no test reaches it';
      lines.push(`- ${record.text}${tested}${at.length ? ` (${at.join('; ')})` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
