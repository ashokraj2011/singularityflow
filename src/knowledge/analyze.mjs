/**
 * Turn a repository's committed source into knowledge items, level by level.
 *
 * The shared analysis engine (the Code Explainer's outline, decision trees, call and data flow,
 * entities and concepts) runs once per area, so a large repository is analysed in bounded parts
 * that can later be cached and rebuilt independently. The readers in `producers.mjs` add what the
 * engine does not cover. Everything here is deterministic and model-free: the same commit gives
 * the same items, and every observed item cites the lines it was read from.
 */
import path from 'node:path';

import { buildLenses } from '../code-intelligence/generated/code-explainer-lenses.mjs';
import { buildCodeExplainerModel, codeAreas, inArea, isTestPath } from '../code-intelligence/generated/code-explainer-model.mjs';
import { scanSourceClauseTags } from '../traceability-ids.mjs';
import { citation, invalidCitations, knowledgeItem, KNOWLEDGE_LEVELS, KNOWLEDGE_FORMAT } from './items.mjs';
import {
  androidManifest, clientRoutes, configurationKeys, dataClasses, declaredHttpClients, enumsAndRecords, exceptionStatuses, gradleModules, manifestCommands, namedLimits, outboundHttp,
  pathAliases, resolvedImports, testCases, typeShapes
} from './producers.mjs';
import { clauseEndLine, textTerms, wordMatches } from './requirements.mjs';

export const KNOWLEDGE_ANALYZER_VERSION = 1;
const PRODUCER = `knowledge-analyzer@${KNOWLEDGE_ANALYZER_VERSION}`;
const AREA_TARGET_FILES = 150;
const MAXIMUM_AREAS = 80;
const COMMON_NAMES = new Set(['get', 'set', 'run', 'map', 'test', 'it', 'describe', 'expect', 'then', 'main', 'apply', 'call', 'equals', 'toString', 'hashCode', 'build', 'create', 'init', 'render', 'value', 'name', 'id']);

/** Comparative wording a test title can use, and the operator it implies. */
const COMPARATIVES = [
  { words: /\b(?:more than|greater than|over|above|exceeds?|exceeding)\b/iu, strict: true, direction: 'greater' },
  { words: /\b(?:at least|or more|minimum of|no less than)\b/iu, strict: false, direction: 'greater' },
  { words: /\b(?:less than|under|below|fewer than)\b/iu, strict: true, direction: 'less' },
  { words: /\b(?:at most|or less|maximum of|no more than|up to)\b/iu, strict: false, direction: 'less' }
];

/** A string literal in test code that names this route, with `{id}` matching any segment. */
function routePattern(route) {
  const quote = '["\'`]';
  const escaped = route.split('').map((character) => ('.*+?^$()|[]\\'.includes(character) ? '\\' + character : character)).join('');
  const segments = escaped.split(/\{[^}]+\}/u).join('[^"\'`/]+');
  return new RegExp(quote + segments + '(?:\\?[^"\'`]*)?' + quote, 'u');
}

function isAccessor(symbol) {
  const owner = symbol.qualifiedName.includes('.') ? symbol.qualifiedName.split('.')[0] : null;
  return /^(?:get|set|is|has)[A-Z]/u.test(symbol.name) || symbol.kind === 'constructor' || symbol.name === owner;
}

function fileIdentifiers(file) {
  file.identifiers ??= new Set(file.lines.join('\n').match(/[A-Z][\w$]*/gu) ?? []);
  return file.identifiers;
}

function engineInput(name, files) {
  return {
    repository: { name, branch: null, head: null },
    story: null,
    change: { view: null, patch: null, patchFiles: [], base: null },
    files: files.map((file) => ({ path: file.path, language: file.language, lines: file.lines, symbols: null, symbolReason: null })),
    calls: [], callStatus: {}, references: [], referenceStatus: {}, hovers: {},
    focus: null, depth: 3, view: 'full', modelEnabled: false
  };
}

/** The first outcome of a branch, in words: what it returns, refuses, shows or sets. */
function outcomeOf(steps = []) {
  for (const step of steps) {
    if (step.k === 'return') return { kind: 'returns', text: step.text || '(nothing)', line: step.line };
    if (step.k === 'throw') return { kind: 'refuses', text: messageOf(step.text) ?? step.text, raw: step.text, line: step.line };
    if (step.k === 'step') {
      for (const entry of step.lines) {
        const message = messageOf(entry.text);
        if (message && /\b(?:set\w*|toast\.?\w*|alert|notify\w*|showError|message)\s*\(/u.test(entry.text)) return { kind: 'shows', text: message, line: entry.line };
        // Kotlin and Python state: `error = "Title is required"`, `self.error_message = '…'`.
        const assigned = entry.text.match(/\b(?:_?error\w*|\w*[Ee]rror[A-Z]?\w*|message|errorMessage|validationError)\s*(?:\.value\s*)?=\s*(["'])((?:(?!\1).){3,200})\1/u);
        if (assigned) return { kind: 'shows', text: assigned[2], line: entry.line };
      }
      const first = step.lines[0];
      if (first) return { kind: 'does', text: first.text, line: first.line };
    }
    if (step.k === 'if') return { kind: 'checks', text: step.cond, line: step.line };
    if (step.k === 'jump') return { kind: 'stops', text: step.text, line: step.line };
  }
  return null;
}

/**
 * The engine shortens labels for its panel (72 characters, ending in "…"). Knowledge keeps the
 * whole condition or statement, read back from the cited source line(s).
 */
function sourceCondition(file, line, shortened) {
  if (!String(shortened ?? '').endsWith('…')) return shortened;
  const text = file.lines.slice(line - 1, line + 5).join(' ');
  const start = text.search(/\b(?:if|while|elif|else\s+if)\b\s*\(?/u);
  if (start < 0) return shortened;
  const open = text.indexOf('(', start);
  if (open < 0) return (text.slice(start).match(/^(?:if|elif|while)\s+(.+?):\s*$/u)?.[1] ?? shortened).trim();
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && (depth -= 1) === 0) return text.slice(open + 1, index).replace(/\s+/gu, ' ').trim();
  }
  return shortened;
}

function sourceStatement(file, line, shortened) {
  if (!String(shortened ?? '').endsWith('…')) return shortened;
  const original = String(file.lines[line - 1] ?? '').trim();
  return original.replace(/^(?:return|throw)\s+/u, '').replace(/;\s*$/u, '') || shortened;
}

function messageOf(text) {
  const match = String(text ?? '').match(/\(\s*(["'`])((?:(?!\1).){3,200})\1/u);
  return match && !match[2].includes('${') ? match[2] : null;
}

/** Arithmetic that computes a business value, outside UI rendering code. */
function isFormula(text, language) {
  if (['typescriptreact', 'javascriptreact'].includes(language)) return false;
  const value = String(text ?? '');
  if (/^\s*(?:for|while|if)\b|\+\+|--|\bindex\b|\bi\s*[+<]/u.test(value)) return false;
  const arithmetic = /\b(?:multiply|divide|subtract|setScale|RoundingMode\.\w+|Math\.(?:round|floor|ceil)|pow)\b|[\w)\]]\s*[*/]\s*[\w(]/u.test(value);
  const named = /[*/+-]\s*[\w.]*[a-z][\w.]*|\.(?:multiply|divide|subtract|add)\(/u.test(value);
  return arithmetic && named && /=|\breturn\b|^\s*[\w.]+\s*\(/u.test(value) || /^(?!.*\?)[^=]*\b\w+\([^)]*\)\s*[-+]\s*\w+\([^)]*\)\s*[-+]\s*\w+\(/u.test(value);
}

function fullOutcome(file, outcome) {
  if (!outcome) return outcome;
  return { ...outcome, text: outcome.kind === 'refuses' || outcome.kind === 'shows' ? outcome.text : sourceStatement(file, outcome.line, outcome.text) };
}

function conditionValues(cond, limits) {
  const numbers = [...cond.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/gu)].map((match) => match[0]);
  const strings = [...cond.matchAll(/(["'])((?:(?!\1).){1,80})\1/gu)].map((match) => match[2]);
  const constants = [...new Set(cond.match(/\b[A-Z][A-Z0-9_]{2,}\b/gu) ?? [])]
    .map((name) => ({ name, value: limits.get(name)?.value ?? null }));
  return { numbers, strings, constants };
}

function ruleKind(cond, outcome, values) {
  if (outcome?.kind === 'refuses') return 'refusal';
  if (outcome?.kind === 'shows') return 'message';
  if (outcome && /\b[A-Z][A-Z0-9_]{2,}\b|(?<![\w.])\d+(?:\.\d+)?(?![\w.])/u.test(outcome.text ?? '') && ['does', 'returns'].includes(outcome.kind)
      && /[*\/+-]|multiply|subtract|add\(|divide|round/u.test(outcome.text ?? '')) return 'calculation';
  if (/[<>]=?/u.test(cond) && (values.numbers.length || values.constants.length || /compareTo|size\(\)|length/u.test(cond))) return 'threshold';
  if (values.strings.length || values.constants.length) return 'match';
  if (/compareTo\(|isBefore|isAfter|[<>]=?/u.test(cond)) return 'comparison';
  return 'guard';
}

/** The comparison operator a condition applies to a literal or constant, when there is one. */
function comparisonIn(cond) {
  const match = cond.match(/([<>]=?)\s*(?:-?\d|[A-Z][A-Z0-9_]{2,})/u) ?? cond.match(/(?:\d|[A-Z][A-Z0-9_]{2,})\s*([<>]=?)/u);
  if (match) return { operator: match[1], strict: !match[1].includes('='), direction: match[1].startsWith('>') ? 'greater' : 'less' };
  const compare = cond.match(/compareTo\([^)]*\)\s*([<>]=?)\s*0/u);
  if (compare) return { operator: compare[1], strict: !compare[1].includes('='), direction: compare[1].startsWith('>') ? 'greater' : 'less' };
  return null;
}

export function analyzeKnowledge(source, { churn = null, commits = null } = {}) {
  const files = source.files;
  const filesByPath = new Map([...files, ...source.manifests, ...(source.documents ?? [])].map((file) => [file.path, file]));
  const knownPaths = new Set(files.map((file) => file.path));
  const items = [];
  const add = (spec) => {
    const item = knowledgeItem({ producer: PRODUCER, ...spec });
    items.push(item);
    return item;
  };
  const areas = codeAreas(files.map((file) => file.path), { target: AREA_TARGET_FILES, maxAreas: MAXIMUM_AREAS });
  const areaOf = (relative) => {
    let best = null;
    for (const area of areas) if (inArea(relative, area) && (!best || area.path.length > best.path.length)) best = area;
    return best ? best.path || '.' : '.';
  };

  // ---- L0 inventory -------------------------------------------------------------------------
  const languages = new Map();
  for (const file of files) languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
  for (const [language, count] of [...languages].sort((a, b) => b[1] - a[1])) {
    add({ kind: 'language', key: language, grain: 'repository', statement: { language, files: count }, assurance: 'derived' });
  }
  const { commands, frameworks } = manifestCommands(source.manifests, files);
  for (const manifest of source.manifests) {
    add({ kind: 'manifest', key: manifest.path, grain: 'repository', subject: { path: manifest.path },
      statement: { kind: path.posix.basename(manifest.path) }, citations: [citation(manifest, 1)], area: areaOf(manifest.path) });
  }
  for (const entry of commands) {
    add({ kind: 'command', key: `${entry.purpose}:${entry.command}`, grain: 'repository', statement: entry,
      citations: [citation(filesByPath.get(entry.path), entry.line)] });
  }

  // ---- Engine, one area at a time -----------------------------------------------------------
  const symbolsByName = new Map();
  const symbolsById = new Map();
  const callEdges = [];
  const sinksBySymbol = new Map();
  const logicBySymbol = new Map();
  const entries = [];
  const conceptTotals = new Map();
  const entityKeys = new Set();
  for (const area of areas) {
    const areaFiles = files.filter((file) => areaOf(file.path) === (area.path || '.'));
    if (!areaFiles.length) continue;
    const input = engineInput(source.name ?? 'repository', areaFiles);
    let model;
    let lenses;
    try {
      model = buildCodeExplainerModel(input, `knowledge-${area.path}`);
      lenses = buildLenses(input, model);
    } catch {
      continue;
    }
    for (const symbol of model.symbols) {
      if (!symbol.file || symbol.kind === 'file' || symbol.kind === 'module-scope') continue;
      const entry = { id: symbol.id, name: symbol.name, qualifiedName: symbol.qualifiedName, kind: symbol.kind, file: symbol.file,
        line: symbol.line ?? symbol.start ?? 1, start: symbol.start ?? symbol.line ?? 1, end: symbol.end ?? symbol.line ?? 1,
        complexity: symbol.metrics?.complexity ?? null, decisions: symbol.metrics?.decisions ?? 0, test: isTestPath(symbol.file) };
      symbolsById.set(symbol.id, entry);
      const list = symbolsByName.get(symbol.name) ?? [];
      list.push(entry);
      symbolsByName.set(symbol.name, list);
    }
    for (const layer of lenses.concepts.layers) {
      for (const module of layer.modules) {
        const relative = module.id.replace(/^m:/u, '');
        const file = filesByPath.get(relative);
        if (!file) continue;
        add({ kind: 'layer', key: relative, grain: 'component', subject: { path: relative },
          statement: { layer: layer.id, label: layer.label, reason: module.reason }, citations: [citation(file, 1)], area: areaOf(relative) });
      }
    }
    for (const concept of lenses.concepts.concepts) {
      const total = conceptTotals.get(concept.term) ?? { term: concept.term, label: concept.label, score: 0, modules: new Set(), symbols: new Set() };
      total.score += concept.score;
      for (const module of concept.modules) total.modules.add(module.replace(/^m:/u, ''));
      for (const id of concept.symbols) total.symbols.add(id);
      conceptTotals.set(concept.term, total);
    }
    for (const entity of lenses.entities.entities) {
      if (['props', 'shape'].includes(entity.kind) && !entity.fields.length) continue;
      const relative = entity.moduleId.replace(/^m:/u, '');
      const file = filesByPath.get(relative);
      if (!file) continue;
      const key = `${relative}:${entity.name}`;
      entityKeys.add(key);
      add({ kind: 'entity', key, grain: 'component', subject: { name: entity.name, path: relative },
        statement: { name: entity.name, kind: entity.kind, fields: entity.fields.map((field) => ({ name: field.name, type: field.type })),
          values: entity.values, extends: entity.extends, usedBy: entity.usedBy.length },
        citations: [citation(file, entity.line ?? 1)], area: areaOf(relative) });
    }
    for (const entry of lenses.flow.entries) {
      const symbol = entry.symbol ? model.byId?.[entry.symbol] ?? model.symbols.find((item) => item.id === entry.symbol) : null;
      const file = symbol?.file ? filesByPath.get(symbol.file) : null;
      if (!file) continue;
      if (entry.kind === 'http' && declaredHttpClients(file).client) continue;
      entries.push({ ...entry, file: symbol.file, line: symbol.line ?? 1, path: lenses.flow.paths[entry.id] ?? null, nodes: lenses.flow.nodes });
      add({ kind: 'entry-point', key: `${symbol.file}:${entry.label}`, grain: 'unit', subject: { symbol: symbol.qualifiedName, path: symbol.file },
        statement: { kind: entry.kind, label: entry.label, reason: entry.reason }, citations: [citation(file, symbol.line ?? 1)], area: areaOf(symbol.file) });
    }
    const nodeById = new Map(lenses.flow.nodes.map((node) => [node.id, node]));
    for (const edge of lenses.flow.edges) {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      if (!from?.symbol) continue;
      if (to?.symbol && edge.kind === 'call') callEdges.push({ from: from.symbol, to: to.symbol, inferred: edge.inferred === true, line: edge.line });
      if (to && (to.kind === 'sink' || to.kind === 'source') && to.category) {
        const list = sinksBySymbol.get(from.symbol) ?? [];
        list.push({ category: to.category, label: to.label, kind: to.kind, line: edge.line });
        sinksBySymbol.set(from.symbol, list);
      }
    }
    for (const [id, flow] of Object.entries(lenses.logic.flows)) logicBySymbol.set(id, flow);
  }

  // ---- Readers that need every file ---------------------------------------------------------
  const limits = new Map();
  for (const file of files) {
    if (isTestPath(file.path)) continue;
    for (const limit of namedLimits(file)) {
      if (limits.has(limit.name)) continue;
      limits.set(limit.name, { ...limit, path: file.path });
      add({ kind: 'limit', key: `${file.path}:${limit.name}`, grain: 'unit', subject: { name: limit.name, path: file.path },
        statement: { name: limit.name, value: limit.value }, citations: [citation(file, limit.line)], area: areaOf(file.path) });
    }
    for (const shape of typeShapes(file)) {
      const key = `${file.path}:${shape.name}`;
      if (entityKeys.has(key)) continue;
      entityKeys.add(key);
      add({ kind: 'entity', key, grain: 'component', subject: { name: shape.name, path: file.path },
        statement: { name: shape.name, kind: shape.kind, fields: shape.fields.map((field) => ({ name: field.name, type: field.type, optional: field.optional })) },
        citations: [citation(file, shape.line, shape.fields.at(-1)?.line ?? shape.line)], area: areaOf(file.path) });
    }
    for (const shape of enumsAndRecords(file)) {
      const key = `${file.path}:${shape.name}`;
      const existing = items.find((item) => item.kind === 'entity' && item.subject.path === file.path && item.subject.name === shape.name);
      if (existing) {
        if (shape.values.length && !existing.statement.values?.length) existing.statement.values = shape.values;
        if (shape.fields.length && !existing.statement.fields?.length) existing.statement.fields = shape.fields;
        continue;
      }
      entityKeys.add(key);
      add({ kind: 'entity', key, grain: 'component', subject: { name: shape.name, path: file.path },
        statement: { name: shape.name, kind: shape.kind, fields: shape.fields, values: shape.values },
        citations: [citation(file, shape.line)], area: areaOf(file.path) });
    }
    for (const route of clientRoutes(file)) {
      add({ kind: 'entry-point', key: `${file.path}:route:${route.path}`, grain: 'unit', subject: { component: route.component, path: file.path },
        statement: { kind: 'route', label: `route ${route.path} → ${route.component}`, path: route.path, component: route.component },
        citations: [citation(file, route.line)], area: areaOf(file.path) });
    }
    for (const call of declaredHttpClients(file).calls) {
      add({ kind: 'external-dependency', key: `${file.path}:${call.method}:${call.target}:${call.line}`, grain: 'unit',
        subject: { path: file.path }, statement: { protocol: 'http', method: call.method, target: call.target, via: 'declared client' },
        citations: [citation(file, call.line)], area: areaOf(file.path) });
    }
    for (const shape of dataClasses(file)) {
      const key = `${file.path}:${shape.name}`;
      if (entityKeys.has(key)) continue;
      entityKeys.add(key);
      add({ kind: 'entity', key, grain: 'component', subject: { name: shape.name, path: file.path },
        statement: { name: shape.name, kind: shape.kind, fields: shape.fields, values: [] }, citations: [citation(file, shape.line)], area: areaOf(file.path) });
    }
    for (const call of outboundHttp(file)) {
      add({ kind: 'external-dependency', key: `${file.path}:${call.method}:${call.target}:${call.line}`, grain: 'unit',
        subject: { path: file.path }, statement: { protocol: 'http', method: call.method, target: call.target, via: call.via ?? null },
        citations: [citation(file, call.line)], area: areaOf(file.path) });
    }
  }
  // Where each limit is used: the functions that apply it, so "MAX = 10" says what it caps.
  const enclosing = (relative, line) => {
    let best = null;
    for (const symbol of symbolsById.values()) {
      if (symbol.file !== relative || symbol.start > line || symbol.end < line || !['function', 'method', 'constructor'].includes(symbol.kind)) continue;
      if (!best || symbol.end - symbol.start < best.end - best.start) best = symbol;
    }
    return best;
  };
  for (const item of items.filter((entry) => entry.kind === 'limit')) {
    const pattern = new RegExp(`\\b${item.statement.name}\\b`, 'u');
    const uses = [];
    for (const file of files) {
      file.lines.forEach((line, index) => {
        if (!pattern.test(line) || (file.path === item.subject.path && index + 1 === item.citations[0].lines[0])) return;
        if (/^\s*import\b/u.test(line)) return;
        uses.push({ path: file.path, line: index + 1, symbol: enclosing(file.path, index + 1)?.qualifiedName ?? null, test: isTestPath(file.path) });
      });
    }
    item.statement.usedIn = uses.slice(0, 12);
  }
  const configuration = [];
  for (const manifest of source.manifests) {
    for (const entry of configurationKeys(manifest)) {
      configuration.push(entry);
      add({ kind: 'configuration', key: `${manifest.path}:${entry.key}`, grain: 'repository', subject: { path: manifest.path },
        statement: { key: entry.key, value: entry.value }, citations: [citation(manifest, entry.line)], area: areaOf(manifest.path) });
    }
  }
  for (const manifest of source.manifests) {
    const android = androidManifest(manifest);
    for (const component of android.components) {
      const label = `${component.kind} ${component.name}${component.launcher ? ' (launcher)' : ''}${component.exported ? ' (exported)' : ''}`;
      add({ kind: 'entry-point', key: `${manifest.path}:${component.kind}:${component.name}`, grain: 'unit', subject: { path: manifest.path, component: component.name },
        statement: { kind: `android-${component.kind}`, label, exported: component.exported, launcher: component.launcher },
        citations: [citation(manifest, component.line)], area: areaOf(manifest.path) });
    }
    for (const permission of android.permissions) {
      add({ kind: 'configuration', key: `${manifest.path}:permission:${permission.name}`, grain: 'repository', subject: { path: manifest.path },
        statement: { key: 'android permission', value: permission.name }, citations: [citation(manifest, permission.line)], area: areaOf(manifest.path) });
    }
    const modules = gradleModules(manifest);
    if (modules.length) {
      add({ kind: 'configuration', key: `${manifest.path}:gradle-modules`, grain: 'repository', subject: { path: manifest.path },
        statement: { key: 'Gradle modules', value: modules.map((entry) => entry.module).join(', ') },
        citations: [citation(manifest, modules[0].line, modules.at(-1).line)], area: areaOf(manifest.path) });
    }
  }
  const statusByException = new Map();
  for (const file of files) for (const mapping of exceptionStatuses(file)) statusByException.set(mapping.exception, { ...mapping, path: file.path });

  // ---- Import graph -------------------------------------------------------------------------
  const aliases = pathAliases(source.manifests, files.map((file) => file.path));
  const imports = [];
  for (const file of files) for (const edge of resolvedImports(file, knownPaths, aliases)) imports.push({ from: file.path, to: edge.to, line: edge.line });
  const importers = new Map();
  for (const edge of imports) {
    const list = importers.get(edge.to) ?? new Set();
    list.add(edge.from);
    importers.set(edge.to, list);
  }

  // ---- L2 decisions, L3 rules, messages and error paths -------------------------------------
  const rulesBySymbol = new Map();
  const messages = new Set();
  for (const [id, flow] of logicBySymbol) {
    const symbol = symbolsById.get(id);
    if (!symbol || symbol.test) continue;
    const file = filesByPath.get(symbol.file);
    if (!file) continue;
    const decisionLines = [];
    // Rules are numbered within their function, so an edited condition keeps its id (and its review).
    let ruleOrdinal = 0;
    const ruleKey = () => `${symbol.file}:${symbol.qualifiedName}:rule:${ruleOrdinal++}`;
    const formulaLines = new Set();
    // A calculation the code always performs (a total, a rate, a rounding) is a rule too.
    const addFormula = (entry, context) => {
      if (formulaLines.has(entry.line)) return;
      formulaLines.add(entry.line);
      const values = conditionValues(entry.text, limits);
      const rule = add({
        kind: 'rule', key: ruleKey(), grain: 'unit',
        subject: { symbol: symbol.qualifiedName, path: symbol.file },
        statement: { kind: 'calculation', when: context, then: { kind: 'computes', text: entry.text, line: entry.line }, otherwise: null, values, comparison: null },
        citations: [citation(file, entry.line)], area: areaOf(symbol.file)
      });
      const list = rulesBySymbol.get(id) ?? [];
      list.push(rule);
      rulesBySymbol.set(id, list);
    };
    const visit = (steps, context) => {
      for (let step of steps) {
        if (step.k === 'if') {
          step = { ...step, cond: sourceCondition(file, step.line, step.cond) };
          const outcome = fullOutcome(file, outcomeOf(step.then));
          const otherwise = step.else ? fullOutcome(file, outcomeOf(step.else)) : null;
          const values = conditionValues(step.cond, limits);
          const kind = ruleKind(step.cond, outcome, values);
          decisionLines.push(step.line);
          const rule = add({
            kind: 'rule', key: ruleKey(), grain: 'unit',
            subject: { symbol: symbol.qualifiedName, path: symbol.file },
            statement: { kind, when: [...context, step.cond], then: outcome, otherwise, values, comparison: comparisonIn(step.cond) },
            citations: [citation(file, step.line, Math.max(step.line, outcome?.line ?? step.line))], area: areaOf(symbol.file)
          });
          const list = rulesBySymbol.get(id) ?? [];
          list.push(rule);
          rulesBySymbol.set(id, list);
          visit(step.then ?? [], [...context, step.cond]);
          if (step.else) visit(step.else, [...context, `not (${step.cond})`]);
        } else if (step.k === 'switch') {
          decisionLines.push(step.line);
          for (const entry of step.cases) visit(entry.body, [...context, `${step.subject || 'case'} is ${entry.label}`]);
        } else if (step.k === 'loop') visit(step.body, context);
        else if (step.k === 'try') {
          visit(step.body, context);
          for (const handler of step.catches) visit(handler.body, [...context, `the step before fails (${handler.label || 'any error'})`]);
          if (step.final) visit(step.final, context);
        } else if (step.k === 'return') {
          step = { ...step, text: sourceStatement(file, step.line, step.text) };
          const ternary = step.text.match(/^(.+?)\s+\?\s+(.+?)\s+:\s+(.+)$/u);
          if (!ternary && isFormula(step.text, file.language)) addFormula({ text: step.text, line: step.line }, context);
          if (ternary && !/=>/u.test(ternary[1])) {
            const values = conditionValues(ternary[1], limits);
            decisionLines.push(step.line);
            const rule = add({
              kind: 'rule', key: ruleKey(), grain: 'unit',
              subject: { symbol: symbol.qualifiedName, path: symbol.file },
              statement: { kind: ruleKind(ternary[1], null, values), when: [...context, ternary[1]],
                then: { kind: 'returns', text: ternary[2], line: step.line }, otherwise: { kind: 'returns', text: ternary[3], line: step.line },
                values, comparison: comparisonIn(ternary[1]) },
              citations: [citation(file, step.line)], area: areaOf(symbol.file)
            });
            const list = rulesBySymbol.get(id) ?? [];
            list.push(rule);
            rulesBySymbol.set(id, list);
          }
        } else if (step.k === 'throw') {
          const exception = step.text.match(/(?:new\s+)?([\w.]*?(?:Exception|Error|Fault)\w*)\s*\(/u)?.[1]?.split('.').pop() ?? null;
          const message = messageOf(step.text);
          const coded = step.text.match(/status_code\s*=\s*(\d{3})|HttpStatus\.([A-Z_]+)|status\((\d{3})\)/u);
          const mapped = exception ? statusByException.get(exception) : null;
          add({ kind: 'error-path', key: `${symbol.file}:${step.line}`, grain: 'unit', subject: { symbol: symbol.qualifiedName, path: symbol.file },
            statement: { exception, message, when: context, status: mapped?.status ?? coded?.[1] ?? coded?.[2] ?? coded?.[3] ?? null, handler: mapped ? mapped.path : null },
            citations: [citation(file, step.line)], area: areaOf(symbol.file) });
        }
        if (step.k === 'step') {
          for (let entry of step.lines) {
            entry = { ...entry, text: sourceStatement(file, entry.line, entry.text) };
            const cap = entry.text.match(/\b(?:Math\.(?:min|max)|coerce(?:AtMost|AtLeast|In)|clamp|Math\.clamp)\s*\(/u)
              && entry.text.match(/\b[A-Z][A-Z0-9_]{2,}\b/u);
            if (cap) {
              const values = conditionValues(entry.text, limits);
              const rule = add({
                kind: 'rule', key: ruleKey(), grain: 'unit',
                subject: { symbol: symbol.qualifiedName, path: symbol.file },
                statement: { kind: 'cap', when: context, then: { kind: 'does', text: entry.text, line: entry.line }, otherwise: null, values, comparison: null },
                citations: [citation(file, entry.line)], area: areaOf(symbol.file)
              });
              const list = rulesBySymbol.get(id) ?? [];
              list.push(rule);
              rulesBySymbol.set(id, list);
            }
            if (!cap && isFormula(entry.text, file.language)) addFormula(entry, context);
            const message = messageOf(entry.text);
            if (message && /\b(?:set\w*Error|setMessage|toast\.?\w*|alert|notify\w*|showError)\s*\(/u.test(entry.text) && !messages.has(`${symbol.file}:${entry.line}`)) {
              messages.add(`${symbol.file}:${entry.line}`);
              add({ kind: 'message', key: `${symbol.file}:${entry.line}`, grain: 'unit', subject: { symbol: symbol.qualifiedName, path: symbol.file },
                statement: { text: message, when: context }, citations: [citation(file, entry.line)], area: areaOf(symbol.file) });
            }
          }
        }
      }
    };
    visit(flow.steps, []);
    if (flow.decisions > 0 || decisionLines.length) {
      add({ kind: 'decision', key: `${symbol.file}:${symbol.qualifiedName}`, grain: 'unit', subject: { symbol: symbol.qualifiedName, path: symbol.file },
        statement: { decisions: flow.decisions, steps: flow.steps, truncated: flow.truncated, complexity: symbol.complexity },
        citations: [citation(file, symbol.start, symbol.end)], area: areaOf(symbol.file) });
    }
  }
  // Messages set inside callbacks (`.catch(() => setError('…'))`) never reach a decision tree.
  for (const file of files) {
    if (isTestPath(file.path)) continue;
    file.lines.forEach((line, index) => {
      if (messages.has(`${file.path}:${index + 1}`) || !/\b(?:set\w*Error|setMessage|toast\.?\w*|alert|notify\w*|showError)\s*\(/u.test(line)) return;
      const text = line.match(/\b(?:set\w*Error|setMessage|toast\.?\w*|alert|notify\w*|showError)\s*\(\s*(["'`])((?:(?!\1).){3,200})\1/u)?.[2];
      if (!text || text.includes('${')) return;
      messages.add(`${file.path}:${index + 1}`);
      add({ kind: 'message', key: `${file.path}:${index + 1}`, grain: 'unit', subject: { path: file.path, symbol: null },
        statement: { text, when: /\.catch\(|catch\s*\(/u.test(line) ? ['the step before fails'] : [] }, citations: [citation(file, index + 1)], area: areaOf(file.path) });
    });
  }
  // Exceptions thrown from expressions (`orElseThrow(() -> new NotFound(id))`) are error paths too.
  for (const file of files) {
    if (isTestPath(file.path)) continue;
    file.lines.forEach((line, index) => {
      const match = line.match(/->\s*new\s+(\w+(?:Exception|Error))\s*\(/u);
      if (!match) return;
      const mapped = statusByException.get(match[1]);
      add({ kind: 'error-path', key: `${file.path}:${index + 1}`, grain: 'unit', subject: { path: file.path },
        statement: { exception: match[1], message: null, when: [], status: mapped?.status ?? null, handler: mapped ? mapped.path : null },
        citations: [citation(file, index + 1)], area: areaOf(file.path) });
    });
  }

  // ---- L2 calls and sinks -------------------------------------------------------------------
  const calleesOf = new Map();
  const callersOf = new Map();
  for (const edge of callEdges) {
    if (!calleesOf.has(edge.from)) calleesOf.set(edge.from, new Set());
    calleesOf.get(edge.from).add(edge.to);
    if (!callersOf.has(edge.to)) callersOf.set(edge.to, new Set());
    callersOf.get(edge.to).add(edge.from);
  }
  for (const [id, sinks] of sinksBySymbol) {
    const symbol = symbolsById.get(id);
    const file = symbol ? filesByPath.get(symbol.file) : null;
    if (!file || symbol.test) continue;
    for (const sink of new Map(sinks.map((entry) => [`${entry.kind}:${entry.category}:${entry.label}`, entry])).values()) {
      add({ kind: 'sink', key: `${symbol.file}:${symbol.qualifiedName}:${sink.kind}:${sink.category}:${sink.label}`, grain: 'unit',
        subject: { symbol: symbol.qualifiedName, path: symbol.file },
        statement: { direction: sink.kind === 'source' ? 'reads' : 'writes', category: sink.category, label: sink.label },
        citations: [citation(file, sink.line ?? symbol.line)], area: areaOf(symbol.file) });
    }
  }

  // ---- L3 concepts --------------------------------------------------------------------------
  for (const concept of [...conceptTotals.values()].sort((a, b) => b.score - a.score).slice(0, 30)) {
    add({ kind: 'concept', key: concept.term, grain: 'repository', assurance: 'derived',
      statement: { term: concept.term, label: concept.label, score: Math.round(concept.score * 10) / 10,
        modules: [...concept.modules].sort(), symbols: [...concept.symbols].map((id) => symbolsById.get(id)?.qualifiedName).filter(Boolean).slice(0, 20) } });
  }

  // ---- L3 requirement links -----------------------------------------------------------------
  for (const file of files) {
    let tags = [];
    try { tags = scanSourceClauseTags(file.lines.join('\n'), { sourcePath: file.path }); } catch { tags = []; }
    for (const tag of tags) {
      const line = Number(tag.line ?? tag.lineNumber ?? 1);
      add({ kind: 'requirement-link', key: `${file.path}:${line}:${tag.id ?? tag.clauseId}`, grain: 'unit', subject: { path: file.path },
        statement: { clause: tag.id ?? tag.clauseId, tag: tag.tag ?? null, test: isTestPath(file.path) },
        citations: [citation(file, line)], area: areaOf(file.path) });
    }
  }

  // ---- L3 tests, coverage, untested rules, drift --------------------------------------------
  const testsByFunction = new Map();
  const cases = [];
  // An HTTP test names the route it calls (`post("/orders/{id}")`), not the controller method.
  const httpRoutes = entries.filter((entry) => entry.kind === 'http' && entry.symbol)
    .map((entry) => ({ pattern: routePattern(entry.label.replace(/^[A-Z]+\s+/u, '')), symbol: entry.symbol }));
  for (const file of files) {
    const fileImports = imports.filter((edge) => edge.from === file.path).map((edge) => edge.to);
    for (const test of testCases(file)) {
      const covered = [];
      for (const identifier of test.identifiers) {
        if (COMMON_NAMES.has(identifier)) continue;
        for (const symbol of symbolsByName.get(identifier) ?? []) {
          if (symbol.test || !['function', 'method', 'constructor'].includes(symbol.kind)) continue;
          // Prefer functions in modules this test file imports; Java/Kotlin tests often share a package instead.
          if (fileImports.length && !fileImports.includes(symbol.file) && !['java', 'kotlin'].includes(file.language)) continue;
          covered.push(symbol);
        }
      }
      const body = file.lines.slice(test.line - 1, test.end).join('\n');
      for (const route of httpRoutes) {
        const target = symbolsById.get(route.symbol);
        if (target && route.pattern.test(body)) covered.push(target);
      }
      // A JVM test names the class it exercises; a bare method name like `place` is ambiguous.
      if (['java', 'kotlin'].includes(file.language)) {
        // The class under test is usually a field or the file's name (`OrderServiceTest`), not a word in the method body.
        const owners = new Set([...test.identifiers, ...fileIdentifiers(file), path.posix.basename(file.path).replace(/(?:Tests?|IT|Spec)?\.(?:java|kt)$/u, '')]);
        const named = covered.filter((symbol) => owners.has(symbol.qualifiedName.split('.')[0]));
        covered.length = 0;
        covered.push(...named.filter((symbol) => symbol.kind !== 'constructor'));
        for (const route of httpRoutes) {
          const target = symbolsById.get(route.symbol);
          if (target && route.pattern.test(body) && !covered.includes(target)) covered.push(target);
        }
      }
      const item = add({ kind: 'test-case', key: `${file.path}:${test.line}:${test.title}`, grain: 'unit', subject: { path: file.path },
        statement: { title: test.title, exercises: [...new Set(covered.filter((symbol) => !isAccessor(symbol)).map((symbol) => symbol.qualifiedName))] },
        citations: [citation(file, test.line, test.end)], area: areaOf(file.path) });
      cases.push({ item, test, covered });
      for (const symbol of covered) {
        const list = testsByFunction.get(symbol.id) ?? [];
        list.push({ item, title: test.title, path: file.path });
        testsByFunction.set(symbol.id, list);
      }
    }
  }
  // A function a tested function calls is tested through it: a private helper is rarely named by a test.
  const testedThrough = new Map();
  for (const [testedId, tests] of testsByFunction) {
    const seen = new Set([testedId]);
    let frontier = [testedId];
    for (let level = 0; level < 4; level += 1) {
      const next = [];
      for (const current of frontier) {
        for (const callee of calleesOf.get(current) ?? []) {
          if (seen.has(callee)) continue;
          seen.add(callee);
          next.push(callee);
          if (!testsByFunction.has(callee) && !testedThrough.has(callee)) testedThrough.set(callee, { via: testedId, tests });
        }
      }
      frontier = next;
    }
  }
  for (const [id, rules] of rulesBySymbol) {
    const symbol = symbolsById.get(id);
    const tests = testsByFunction.get(id) ?? [];
    const through = tests.length ? null : testedThrough.get(id) ?? null;
    if (through) {
      const via = symbolsById.get(through.via)?.qualifiedName ?? 'a tested function';
      for (const rule of rules) rule.relations.push(...through.tests.slice(0, 5).map((test) => ({ type: 'tested-through', to: test.item.id, label: `${test.title} (via ${via})` })));
    }
    for (const rule of rules) {
      rule.relations.push(...tests.map((test) => ({ type: 'tested-by', to: test.item.id, label: test.title })));
      for (const test of tests) {
        const implied = COMPARATIVES.find((entry) => entry.words.test(test.title));
        const comparison = rule.statement.comparison;
        if (!implied || !comparison || implied.direction !== comparison.direction || implied.strict === comparison.strict) continue;
        const tokens = [...rule.statement.values.strings, ...rule.statement.values.constants.map((entry) => entry.name)];
        if (tokens.length && !tokens.some((token) => test.title.toLowerCase().includes(String(token).toLowerCase()))) continue;
        add({ kind: 'drift', key: `${rule.id}:${test.item.id}`, grain: 'unit', assurance: 'derived',
          subject: { symbol: symbol.qualifiedName, path: symbol.file },
          statement: { rule: rule.id, test: test.item.id, testTitle: test.title, condition: rule.statement.when.at(-1),
            detail: `the test title says "${test.title.match(implied.words)[0]}" (${implied.strict ? 'strict' : 'inclusive'}), the code uses ${comparison.operator}` },
          relations: [{ type: 'contradicts', to: rule.id }, { type: 'contradicts', to: test.item.id }] });
      }
    }
    if (!tests.length && !through && rules.some((rule) => rule.statement.kind !== 'guard')) {
      add({ kind: 'untested-rule', key: id, grain: 'unit', assurance: 'derived', subject: { symbol: symbol.qualifiedName, path: symbol.file },
        statement: { rules: rules.length, reason: 'no test case names this function' }, relations: rules.map((rule) => ({ type: 'about', to: rule.id })) });
    }
  }

  // ---- L3 journeys: an entry or a UI event, the calls it makes, and what they reach ---------
  const reach = (startId, depth = 3) => {
    const seen = new Set([startId]);
    let frontier = [startId];
    for (let level = 0; level < depth; level += 1) {
      const next = [];
      for (const id of frontier) for (const callee of calleesOf.get(id) ?? []) if (!seen.has(callee)) { seen.add(callee); next.push(callee); }
      frontier = next;
    }
    return [...seen];
  };
  const effectsOf = (ids) => {
    const effects = new Set();
    for (const id of ids) {
      for (const sink of sinksBySymbol.get(id) ?? []) { const effect = effectText(sink); if (effect) effects.add(effect); }
      const symbol = symbolsById.get(id);
      if (!symbol) continue;
      const file = filesByPath.get(symbol.file);
      for (const call of file ? outboundHttp(file) : []) if (call.line >= symbol.start && call.line <= symbol.end) effects.add(`calls ${call.method} ${call.target}`);
    }
    return [...effects].sort();
  };
  for (const entry of entries) {
    if (!entry.symbol) continue;
    const ids = reach(entry.symbol);
    // An endpoint that calls nothing (a health check) has no journey to describe.
    if (ids.length < 2 && !effectsOf(ids).some((effect) => !effect.startsWith('responds'))) continue;
    const file = filesByPath.get(entry.file);
    add({ kind: 'journey', key: `${entry.file}:${entry.label}`, grain: 'area', assurance: 'derived', subject: { path: entry.file },
      statement: { trigger: entry.label, steps: ids.map((id) => symbolsById.get(id)?.qualifiedName).filter((name, index) => name && !(index === 0 && entry.label.endsWith(name))), effects: effectsOf(ids) },
      citations: file ? [citation(file, entry.line)] : [], area: areaOf(entry.file) });
  }
  for (const file of files) {
    if (file.language !== 'kotlin' || isTestPath(file.path)) continue;
    // Compose and Android views: `Button(onClick = { viewModel.save(…) })`.
    file.lines.forEach((line, index) => {
      for (const match of line.matchAll(/\b(on[A-Z]\w*)\s*=\s*\{\s*(?:[\w.]+\.)?(\w+)\s*\(/gu)) {
        const candidates = symbolsByName.get(match[2]) ?? [];
        const handler = candidates.find((symbol) => !symbol.test && /ViewModel|Presenter|Controller/u.test(symbol.qualifiedName)) ?? candidates.find((symbol) => !symbol.test);
        if (!handler) continue;
        const ids = reach(handler.id);
        const element = line.slice(0, match.index).match(/(\w+)\s*\([^()]*$/u)?.[1] ?? 'element';
        add({ kind: 'journey', key: `${file.path}:${index + 1}:${match[1]}`, grain: 'area', subject: { path: file.path },
          statement: { trigger: `${match[1]} on ${element} in ${path.posix.basename(file.path)}`, steps: ids.map((id) => symbolsById.get(id)?.qualifiedName).filter(Boolean),
            effects: effectsOf(ids) },
          citations: [citation(file, index + 1)], area: areaOf(file.path) });
      }
    });
  }
  for (const file of files) {
    if (!['typescriptreact', 'javascriptreact'].includes(file.language) || isTestPath(file.path)) continue;
    file.lines.forEach((line, index) => {
      for (const match of line.matchAll(/\b(on[A-Z]\w*)=\{\s*(?:\([^)]*\)\s*=>\s*\{?\s*)?(\w+)/gu)) {
        const handler = (symbolsByName.get(match[2]) ?? []).find((symbol) => symbol.file === file.path) ?? (symbolsByName.get(match[2]) ?? [])[0];
        if (!handler || handler.test) continue;
        const ids = reach(handler.id);
        const element = line.slice(0, match.index).match(/<(\w+)[^<]*$/u)?.[1] ?? 'element';
        add({ kind: 'journey', key: `${file.path}:${index + 1}:${match[1]}`, grain: 'area', subject: { path: file.path },
          statement: { trigger: `${match[1]} on <${element}> in ${path.posix.basename(file.path)}`, steps: ids.map((id) => symbolsById.get(id)?.qualifiedName).filter(Boolean),
            effects: effectsOf(ids) },
          citations: [citation(file, index + 1)], area: areaOf(file.path) });
      }
    });
  }

  // ---- L5 files that change together --------------------------------------------------------
  // Pairs of application files changed in the same commits, from commits small enough to be one
  // change (bulk renames and formatting sweeps would pair everything with everything).
  const coChanged = new Map();
  if (commits?.length) {
    const pairs = new Map();
    for (const entry of commits) {
      // A root commit adds everything at once; it says nothing about what changes together.
      if (Array.isArray(entry.parents) && !entry.parents.length) continue;
      const touched = [...new Set(entry.files.filter((file) => knownPaths.has(file) && !isTestPath(file)))].sort();
      if (touched.length < 2 || touched.length > 20) continue;
      for (let left = 0; left < touched.length; left += 1) {
        for (let right = left + 1; right < touched.length; right += 1) {
          const key = `${touched[left]}\0${touched[right]}`;
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
      }
    }
    const ranked = [...pairs].map(([key, together]) => {
      const [left, right] = key.split('\0');
      const fewer = Math.min(churn?.get(left) ?? together, churn?.get(right) ?? together);
      return { left, right, together, share: fewer ? together / fewer : 0 };
    }).filter((entry) => entry.together >= 2 && entry.share >= 0.5)
      .sort((a, b) => b.together - a.together || b.share - a.share || a.left.localeCompare(b.left, 'en')).slice(0, 25);
    for (const entry of ranked) {
      for (const [from, to] of [[entry.left, entry.right], [entry.right, entry.left]]) {
        if (!coChanged.has(from)) coChanged.set(from, []);
        coChanged.get(from).push(to);
      }
      add({ kind: 'co-change', key: `${entry.left}\0${entry.right}`, grain: 'component', assurance: 'derived',
        subject: { path: entry.left, with: entry.right },
        statement: { files: [entry.left, entry.right], together: entry.together, share: Math.round(entry.share * 100) / 100,
          importLinked: imports.some((edge) => (edge.from === entry.left && edge.to === entry.right) || (edge.from === entry.right && edge.to === entry.left)) },
        area: areaOf(entry.left) });
    }
  }

  // ---- L5 hotspots and impact ---------------------------------------------------------------
  const complexityByFile = new Map();
  for (const symbol of symbolsById.values()) {
    if (symbol.test || symbol.complexity == null) continue;
    complexityByFile.set(symbol.file, (complexityByFile.get(symbol.file) ?? 0) + symbol.complexity);
  }
  const scored = files.filter((file) => !isTestPath(file.path)).map((file) => {
    const changes = churn?.get(file.path) ?? 0;
    const complexity = complexityByFile.get(file.path) ?? 0;
    const fanIn = importers.get(file.path)?.size ?? 0;
    const score = (churn ? Math.max(1, changes) : 1) * (1 + complexity / 10) * (1 + fanIn);
    return { file, changes, complexity, fanIn, score };
  }).filter((entry) => entry.complexity > 0 || entry.fanIn > 0 || entry.changes > 1).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path, 'en'));
  for (const entry of scored.slice(0, 15)) {
    add({ kind: 'hotspot', key: entry.file.path, grain: 'component', assurance: 'derived', subject: { path: entry.file.path },
      statement: { changes: churn ? entry.changes : null, complexity: entry.complexity, importedBy: entry.fanIn, score: Math.round(entry.score * 10) / 10 },
      area: areaOf(entry.file.path) });
  }
  for (const [id, rules] of rulesBySymbol) {
    const symbol = symbolsById.get(id);
    const callers = new Set();
    let frontier = [id];
    for (let level = 0; level < 2; level += 1) {
      const next = [];
      for (const current of frontier) for (const caller of callersOf.get(current) ?? []) if (!callers.has(caller) && caller !== id) { callers.add(caller); next.push(caller); }
      frontier = next;
    }
    add({ kind: 'impact', key: id, grain: 'unit', assurance: 'derived', subject: { symbol: symbol.qualifiedName, path: symbol.file },
      statement: { callers: [...callers].map((caller) => symbolsById.get(caller)?.qualifiedName).filter(Boolean).sort(),
        importedBy: [...(importers.get(symbol.file) ?? [])].sort(), changesWith: [...new Set(coChanged.get(symbol.file) ?? [])].sort(), tests: (testsByFunction.get(id) ?? testedThrough.get(id)?.tests ?? []).map((test) => test.path).filter((value, index, list) => list.indexOf(value) === index),
        testedThrough: testsByFunction.has(id) ? null : symbolsById.get(testedThrough.get(id)?.via)?.qualifiedName ?? null,
        rules: rules.length },
      relations: rules.map((rule) => ({ type: 'about', to: rule.id })) });
  }

  // ---- L3 approved requirements -------------------------------------------------------------
  // A clause of an approved specification, linked exactly to the code and tests that tag it, and
  // separately (labelled as matched by words) to the rules, limits and journeys whose words it shares.
  const tagged = new Map();
  for (const link of items.filter((item) => item.kind === 'requirement-link')) {
    const clause = String(link.statement.clause ?? '').toUpperCase();
    if (!tagged.has(clause)) tagged.set(clause, []);
    tagged.get(clause).push(link);
  }
  const matchable = items.filter((item) => (item.kind === 'rule' && item.statement.kind !== 'guard')
      || ['limit', 'journey', 'message', 'entry-point'].includes(item.kind))
    // On equal words a rule is the better lead than a message or a journey that passes through it.
    .map((item) => ({ id: item.id, group: item.subject?.symbol ? `${item.subject.path}#${item.subject.symbol}` : item.id,
      weight: item.kind === 'rule' ? 0.5 : item.kind === 'limit' ? 0.25 : 0, terms: textTerms(JSON.stringify([item.subject?.symbol, item.statement.name, item.statement.label,
      item.statement.trigger, item.statement.text, item.statement.when, item.statement.then?.text, item.statement.value])) }));
  for (const clause of source.requirements ?? []) {
    const document = filesByPath.get(clause.source.path);
    if (!document) continue;
    const links = tagged.get(clause.id) ?? [];
    const matched = links.length ? [] : wordMatches(clause.body, matchable);
    add({ kind: 'requirement', key: `${clause.story}:${clause.id}`, grain: 'unit',
      subject: { name: clause.id, path: clause.source.path, story: clause.story },
      statement: { clause: clause.id, type: clause.type, text: String(clause.body ?? '').replace(/\s+/gu, ' ').trim().slice(0, 400),
        story: clause.story, storyTitle: clause.title ?? null, phase: clause.phase, approvedAt: clause.approvedAt ?? null, approvedBy: clause.approvedBy ?? null,
        implementedAt: links.filter((link) => !link.statement.test).map((link) => `${link.citations[0].path}:${link.citations[0].lines[0]}`),
        testedAt: links.filter((link) => link.statement.test).map((link) => `${link.citations[0].path}:${link.citations[0].lines[0]}`),
        wordMatches: matched.map((entry) => ({ item: entry.id, shared: entry.shared })) },
      citations: [citation(document, clause.source.line, clauseEndLine(document, clause.source.line))],
      relations: [
        ...links.map((link) => ({ type: link.statement.test ? 'tested-by' : 'implemented-by', to: link.id })),
        ...matched.map((entry) => ({ type: 'matches-words', to: entry.id, inferred: true }))
      ],
      area: links[0]?.area ?? null });
  }

  // ---- Areas, levels and checks -------------------------------------------------------------
  for (const area of areas) {
    const label = area.path || '.';
    const inside = items.filter((item) => item.area === label);
    add({ kind: 'area', key: label, grain: 'area', assurance: 'derived', subject: { path: label },
      statement: { files: area.files, own: Boolean(area.own), tests: files.filter((file) => (areaOf(file.path) === label) && isTestPath(file.path)).length,
        rules: inside.filter((item) => item.kind === 'rule').length, entryPoints: inside.filter((item) => item.kind === 'entry-point').length,
        layers: [...new Set(inside.filter((item) => item.kind === 'layer').map((item) => item.statement.label))].sort() }, area: label });
  }
  const count = (kind) => items.filter((item) => item.kind === kind).length;
  const meaningfulRules = items.filter((item) => item.kind === 'rule' && item.statement.kind !== 'guard').length;
  const levels = {
    L0: state(files.length > 0, commands.length > 0, files.length ? null : 'no application source in scope'),
    L1: state(areas.length > 0 && (count('entity') + count('entry-point') > 0), areas.length > 0,
      areas.length ? 'no data shapes or entry points were found' : 'no areas, data shapes or entry points were found'),
    L2: state(count('decision') > 0 && callEdges.length > 0, count('decision') + callEdges.length > 0,
      missing([['decisions', count('decision')], ['calls between functions', callEdges.length]])),
    L3: state(meaningfulRules > 0 && count('test-case') > 0, count('rule') + count('test-case') > 0,
      missing([['rules', meaningfulRules], ['test cases', count('test-case')]])),
    L4: state(count('external-dependency') + count('configuration') > 0 || items.some((item) => item.kind === 'entry-point' && item.statement.kind === 'http'), false,
      'no endpoints, outbound calls or configuration were found'),
    L5: churn ? state(scored.some((entry) => entry.changes > 1) && count('impact') > 0, count('hotspot') > 0, 'no change history was available')
      : { status: count('hotspot') ? 'thin' : 'insufficient', reason: 'no change history was read; hotspots use complexity and imports only' }
  };
  const invalid = invalidCitations(items, filesByPath);
  return {
    format: KNOWLEDGE_FORMAT,
    analyzerVersion: KNOWLEDGE_ANALYZER_VERSION,
    repository: { name: source.name ?? null, commit: source.commit, area: source.area, roots: source.roots, frameworks,
      files: files.length, manifests: source.manifests.length, skipped: source.skipped, commits: commits?.length ?? null,
      specifications: (source.documents ?? []).length, specificationsSkipped: source.requirementSkipped ?? [] },
    areas: areas.map((area) => ({ path: area.path || '.', files: area.files, own: Boolean(area.own) })),
    levels,
    metrics: {
      items: items.length,
      byKind: Object.fromEntries([...new Set(items.map((item) => item.kind))].sort().map((kind) => [kind, count(kind)])),
      byLevel: Object.fromEntries(KNOWLEDGE_LEVELS.map((level) => [level, items.filter((item) => item.level === level).length])),
      citations: items.reduce((sum, item) => sum + item.citations.length, 0),
      invalidCitations: invalid.length,
      calls: callEdges.length,
      callsMatchedByName: callEdges.filter((edge) => edge.inferred).length,
      imports: imports.length
    },
    graph: {
      imports: imports.map((edge) => [edge.from, edge.to]),
      calls: callEdges.map((edge) => [symbolsById.get(edge.from)?.qualifiedName ?? edge.from, symbolsById.get(edge.to)?.qualifiedName ?? edge.to, edge.inferred ? 'by-name' : 'resolved'])
    },
    items
  };
}

/** A sink as a reader would say it. The screen is every UI's sink and says nothing on its own. */
function effectText(sink) {
  if (sink.category === 'screen') return null;
  if (sink.category === 'error') return `may fail with ${sink.label}`;
  if (sink.category === 'response') return `responds with ${sink.label.replace(/^HTTP /u, 'an HTTP ')}`;
  if (sink.category === 'log') return 'writes logs';
  return `${sink.kind === 'source' ? 'reads' : 'writes'} ${sink.label.replace(/^The /u, 'the ')}`;
}

/** Name exactly what was not found: "no test cases were found", not "no rules or test cases". */
function missing(pairs) {
  const absent = pairs.filter(([, value]) => !value).map(([label]) => label);
  return absent.length ? `no ${absent.join(' or ')} ${absent.length === 1 && !absent[0].endsWith('s') ? 'was' : 'were'} found` : null;
}

function state(ready, thin, reason) {
  if (ready) return { status: 'ready', reason: null };
  if (thin) return { status: 'thin', reason };
  return { status: 'insufficient', reason };
}
