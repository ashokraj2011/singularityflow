/** The shared Code Explainer view's bounded, editor-independent snapshot. */
import { randomUUID } from 'node:crypto';
import {
  analysisCalls, buildCodeExplainerModel, CX_LIMITS, isTestPath, visibleCode
} from '../code-intelligence/generated/code-explainer-model.mjs';
import { buildLenses } from '../code-intelligence/generated/code-explainer-lenses.mjs';
import { scanSourceClauseTags } from '../source-clause-tags.mjs';
import { withholdForModel } from '../spec-library/share-check.mjs';

const MAX_TRACE_ROWS = 200;
const MAX_LOGIC_BYTES = 1024 * 1024;
const MAX_DIFF_LINES = 24;
const clip = text => visibleCode(text).slice(0, 320);

function prioritized(symbols) {
  return [...symbols.filter(symbol => symbol.status !== 'unchanged'),
    ...symbols.filter(symbol => symbol.status === 'unchanged')].slice(0, CX_LIMITS.symbols);
}

function staticRelations(symbols, flow, { delta, depth }) {
  const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));
  const nodes = new Map(flow.nodes.map(node => [node.id, byId.get(node.symbol)]));
  const edges = flow.edges.flatMap(edge => {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    return edge.kind === 'call' && from?.file && to?.file && from.line && to.line && from.id !== to.id
      ? [{ from, to, line: edge.line, how: 'by-name' }] : [];
  });
  let selected = edges;
  if (delta) {
    const seeds = symbols.filter(symbol => symbol.status !== 'unchanged').map(symbol => symbol.id);
    const connected = new Set();
    for (const [direction, peer] of [['from', 'to'], ['to', 'from']]) {
      let frontier = new Set(seeds);
      const visited = new Set(seeds);
      for (let step = 0; step < depth && frontier.size; step += 1) {
        const next = new Set();
        for (const edge of edges) {
          if (!frontier.has(edge[direction].id)) continue;
          connected.add(edge);
          const id = edge[peer].id;
          if (!visited.has(id)) { next.add(id); visited.add(id); }
        }
        frontier = next;
      }
    }
    selected = [...connected];
  }
  return {
    calls: analysisCalls(selected, [], () => true),
    callStatus: Object.fromEntries(symbols.filter(symbol => symbol.file && symbol.status !== 'removed').map(symbol => [symbol.key, 'analysis'])),
    references: edges.filter(({ from, to, line }) => line != null && isTestPath(from.file) && !isTestPath(to.file))
      .map(({ from, to, line }) => ({ symbol: to.key, path: from.file, line }))
  };
}

function boundModel(model, lenses, notices) {
  const selected = prioritized(model.symbols);
  const kept = new Set(selected.map(symbol => symbol.id));
  if (selected.length < model.symbols.length) notices.push(`Showing up to ${CX_LIMITS.symbols} declarations. Open a smaller folder for more detail.`);
  model.symbols = selected.map(symbol => {
    const start = Math.max(0, symbol.diff.findIndex(row => row.k !== ' ') - 2);
    return { ...symbol, callers: symbol.callers.filter(id => kept.has(id)), callees: symbol.callees.filter(id => kept.has(id)),
      diff: symbol.diff.slice(start, start + MAX_DIFF_LINES).map(row => ({ ...row, t: clip(row.t) })),
      diffTruncated: symbol.diffTruncated || start > 0 || symbol.diff.length > MAX_DIFF_LINES };
  });
  model.modules = model.modules.map(module => ({ ...module, symbolIds: module.symbolIds.filter(id => kept.has(id)) }));
  model.edges = model.edges.filter(edge => kept.has(edge.from) && kept.has(edge.to));
  model.walkthrough = model.walkthrough.filter(id => kept.has(id));
  for (const name of ['requirements', 'tests', 'runs']) {
    if (model.trace[name].length > MAX_TRACE_ROWS) {
      notices.push(`The trace shows the first ${MAX_TRACE_ROWS} ${name}.`);
      model.trace[name] = model.trace[name].slice(0, MAX_TRACE_ROWS);
    }
  }
  let bytes = 0, omitted = false;
  const flows = {};
  for (const symbol of selected) {
    const flow = lenses.logic.flows[symbol.id];
    if (!flow) continue;
    bytes += Buffer.byteLength(JSON.stringify(flow));
    if (bytes > MAX_LOGIC_BYTES) { omitted = true; break; }
    flows[symbol.id] = flow;
  }
  if (omitted) notices.push('Some flowcharts exceed the view limit. Open their folder or file to see the logic.');
  model.lenses = { ...lenses, logic: { ...lenses.logic, flows } };
}

function repositoryView(inventory, browser, scope, files, symbols) {
  const byPath = new Map();
  for (const symbol of symbols) {
    if (!symbol.file || !symbol.line || !['class', 'constructor', 'function', 'method', 'variable'].includes(symbol.kind)) continue;
    const file = byPath.get(symbol.file) ?? [];
    file.push({ name: symbol.qualifiedName, kind: symbol.kind, line: symbol.line });
    byPath.set(symbol.file, file);
  }
  const clauses = new Map();
  const described = files.map(file => {
    const declarations = byPath.get(file.path) ?? [];
    const tags = scanSourceClauseTags(file.lines.join('\n'), { sourcePath: file.path }).slice(0, 40);
    for (const { clauseId, tag, line } of tags) {
      const clause = clauses.get(clauseId) ?? { clauseId, code: [], tests: [] };
      (tag === 'clause' ? clause.code : clause.tests).push({ path: file.path, line });
      clauses.set(clauseId, clause);
    }
    return { path: file.path, language: file.language, bytes: file.bytes, test: isTestPath(file.path),
      symbols: declarations.slice(0, 40), symbolCount: declarations.length, tags };
  });
  return {
    codeMap: true, scope: { path: scope, kind: !scope ? 'repository' : files.some(file => file.path === scope) ? 'file' : 'folder' },
    budget: { files: inventory?.files ?? null },
    entries: browser?.entries ?? [], entriesTotal: browser?.total ?? 0,
    files: described, clauses: [...clauses.values()].slice(0, MAX_TRACE_ROWS), counts: { files: inventory?.files ?? null }
  };
}

export function buildCodeMapPanel(input, { scope, view, depth, areas, notices, inventory, browser, workId }) {
  const delta = view === 'changes';
  const id = randomUUID();
  const initial = buildCodeExplainerModel(input, id);
  const visible = prioritized(initial.symbols);
  const lenses = buildLenses(input, { ...initial, symbols: visible });
  const relations = staticRelations(visible, lenses.flow, { delta, depth });
  const areaOptions = (scope ? [{ path: scope, files: inventory?.paths.length ?? 0 }, ...areas.filter(area => area.path && area.path !== scope)] : areas)
    .filter(area => area.path).slice(0, 40);
  const model = buildCodeExplainerModel({
    ...input, ...relations, view: delta ? 'delta' : 'full', depth, modelEnabled: true,
    areas: areaOptions, scope: scope ? 0 : null,
    ...(workId ? { story: { workId, currentPhase: input.change.view?.snapshot?.phase ?? null, phaseOrder: [], phases: {} } } : {}),
    notes: ['Calls and test references are inferred from source in this checkout.']
  }, id);
  boundModel(model, lenses, notices);
  const opened = new Set(input.files.map(file => file.path));
  for (const item of model.modules) item.previewable = opened.has(item.path);
  model.intelligence.truncated = notices;
  if (notices.length) model.intelligence.status = 'partial';
  const repository = delta ? null : repositoryView(inventory, browser, scope, input.files, model.symbols);
  const sources = input.files.map(({ path, sha256, lines }) => ({ path, sha256, lines: lines.length }));
  return withholdForModel({ view, scope, notices, model, repository, sources }).value;
}
