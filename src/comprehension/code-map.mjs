/** Model-free Code Explainer views over the checkout selected by the browser transport. */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { branch } from '../git.mjs';
import { readRepositoryManifest } from '../repository-manifest.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  buildCodeExplainerModel, CX_LIMITS, isCodeLanguage, isExplainableRepositoryPath, languageOf, visibleCode
} from '../code-intelligence/generated/code-explainer-model.mjs';
import { buildLenses } from '../code-intelligence/generated/code-explainer-lenses.mjs';
import { repositoryCodeEntries, repositoryCodeInventory } from './repository-explanation.mjs';

const MAX_FILES = 36;
const MAX_FILE_BYTES = 192 * 1024;
const MAX_SOURCE_BYTES = 1_500_000;
const MAX_EXCERPT_LINES = 16;
const MAX_LOGIC_LINES = 28;
const MAX_TRACE_ROWS = 200;
const decoder = new TextDecoder('utf-8', { fatal: true });

function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000
    && !/[:\\*?[\]{}\p{C}]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function codePath(file) {
  return validPath(file) && isExplainableRepositoryPath(file) && isCodeLanguage(languageOf(file));
}

const clip = value => visibleCode(value).slice(0, 320);
const changePath = file => file.pathAfter ?? file.pathBefore ?? file.path;

async function readSources(root, paths, affected) {
  const files = [];
  let bytes = 0;
  let unavailable = 0;
  for (const file of paths) {
    try {
      const { bytes: source } = await readRepositoryManifest(root, file, {
        allowLinks: false, maxBytes: Math.min(MAX_FILE_BYTES, MAX_SOURCE_BYTES - bytes)
      });
      bytes += source.length;
      const location = affected.get(file)?.location;
      if (location && location.contentAfterSha256 !== `sha256:${createHash('sha256').update(source).digest('hex')}`) {
        unavailable += 1;
        continue;
      }
      const text = decoder.decode(source);
      if (text.includes('\0')) { unavailable += 1; continue; }
      const lines = text.split(/\r\n|\n|\r/u);
      if (lines.at(-1) === '') lines.pop();
      files.push({ path: file, language: languageOf(file), lines, symbols: null });
    } catch {
      // The file may be absent in a sparse checkout, unavailable, or outside the read limits.
      unavailable += 1;
    }
  }
  return { files, unavailable };
}

/** Keep nested branches as ordered, indented rows so the transport can redact every value. */
function logicRows(flow) {
  if (!flow) return null;
  const rows = [];
  let partial = flow.truncated;
  function add(line, kind, text, depth) {
    if (rows.length >= MAX_LOGIC_LINES) { partial = true; return; }
    rows.push({ line, kind, text: clip(text), depth });
  }
  function walk(steps, depth) {
    if (depth > 5) { partial ||= steps.length > 0; return; }
    for (const step of steps) {
      if (rows.length >= MAX_LOGIC_LINES) { partial = true; break; }
      switch (step.k) {
        case 'step':
          for (const line of step.lines) add(line.line, 'step', line.text, depth);
          break;
        case 'if':
          add(step.line, 'if', step.cond, depth);
          walk(step.then, depth + 1);
          if (step.else?.length) {
            add(null, 'else', '', depth);
            walk(step.else, depth + 1);
          }
          break;
        case 'loop':
          add(step.line, 'loop', step.head, depth);
          walk(step.body, depth + 1);
          break;
        case 'switch':
          add(step.line, 'switch', step.subject, depth);
          for (const entry of step.cases) {
            add(entry.line, 'case', entry.label, depth + 1);
            walk(entry.body, depth + 2);
          }
          break;
        case 'try':
          add(step.line, 'try', '', depth);
          walk(step.body, depth + 1);
          for (const entry of step.catches) {
            add(entry.line, 'catch', entry.label, depth);
            walk(entry.body, depth + 1);
          }
          if (step.final?.length) {
            add(null, 'finally', '', depth);
            walk(step.final, depth + 1);
          }
          break;
        default: add(step.line, step.k, step.text, depth);
      }
    }
  }
  walk(flow.steps, 0);
  return { rows, partial };
}

function rowsFor(symbol, filesByPath) {
  if (symbol.diff.length) {
    // Include the edited lines before context when only part of a large diff fits.
    const important = symbol.diff.findIndex(line => line.k !== ' ');
    const start = Math.max(0, important - 2);
    return {
      kind: 'diff',
      partial: symbol.diffTruncated || start > 0 || symbol.diff.length > MAX_EXCERPT_LINES,
      rows: symbol.diff.slice(start, start + MAX_EXCERPT_LINES)
        .map(line => ({ mark: line.k, before: line.b, after: line.a, text: clip(line.t) }))
    };
  }
  const lines = filesByPath.get(symbol.file);
  if (!lines?.length || symbol.status === 'removed') return null;
  const first = Math.max(0, (symbol.start ?? symbol.line ?? 1) - 1);
  const last = Math.min(lines.length, symbol.end ?? lines.length);
  return {
    kind: 'source', partial: last - first > MAX_EXCERPT_LINES,
    rows: lines.slice(first, Math.min(last, first + MAX_EXCERPT_LINES))
      .map((text, index) => ({ mark: ' ', before: null, after: first + index + 1, text: clip(text) }))
  };
}

function traceRows(trace) {
  const { requirements, tests, runs } = trace;
  return {
    available: trace.available,
    requirements: requirements.slice(0, MAX_TRACE_ROWS).map(requirement => ({
      id: requirement.id, label: clip(requirement.label), text: requirement.text?.slice(0, 1200),
      gap: requirement.gap && clip(requirement.gap),
      modules: requirement.modules.slice(0, MAX_FILES), tests: requirement.tests.slice(0, MAX_TRACE_ROWS)
    })),
    tests: tests.slice(0, MAX_TRACE_ROWS).map(({ id, path }) => ({ id, path })),
    runs: runs.slice(0, MAX_TRACE_ROWS).map(({ id, label, status }) => ({ id, label: clip(label), status }))
  };
}

function project(input) {
  const model = buildCodeExplainerModel(input, 'local-code-map');
  const ordered = [
    ...model.symbols.filter(symbol => symbol.status !== 'unchanged'),
    ...model.symbols.filter(symbol => symbol.status === 'unchanged')
  ];
  const visible = ordered.slice(0, CX_LIMITS.symbols);
  const included = new Set(visible.map(symbol => symbol.id));
  const lenses = buildLenses(input, { ...model, symbols: visible });
  const lines = new Map(input.files.map(file => [file.path, file.lines]));
  const symbols = visible.map(symbol => ({
    id: symbol.id, moduleId: symbol.moduleId, file: symbol.file, name: symbol.name,
    kind: symbol.kind, line: symbol.line, status: symbol.status, added: symbol.added, removed: symbol.removed,
    signature: symbol.signature ? clip(symbol.signature) : null,
    metrics: symbol.metrics && { lines: symbol.metrics.lines, decisions: symbol.metrics.decisions },
    explanation: symbol.explanation.slice(0, 5)
      .map(paragraph => paragraph.map(segment => clip(segment.t ?? segment.code)).join('')),
    excerpt: rowsFor(symbol, lines),
    logic: logicRows(lenses.logic.flows[symbol.id])
  }));
  const modules = model.modules.map(module => ({
    id: module.id, path: module.path, status: module.status, language: module.language,
    symbolIds: module.symbolIds.filter(id => included.has(id))
  }));
  const flowSymbols = new Map(lenses.flow.nodes.map(node => [node.id, node.symbol]));
  const calls = lenses.flow.edges.flatMap(edge => {
    const from = flowSymbols.get(edge.from);
    const to = flowSymbols.get(edge.to);
    return edge.kind === 'call' && from && to
      ? [{ from, to, line: edge.line, inferred: edge.inferred === true }] : [];
  });
  return {
    modules, symbols, calls, walkthrough: model.walkthrough.filter(id => included.has(id)), trace: traceRows(model.trace),
    concepts: lenses.concepts, entities: lenses.entities, flow: lenses.flow,
    outlineLimited: visible.length < model.symbols.length,
    traceLimited: [model.trace.requirements, model.trace.tests, model.trace.runs].some(rows => rows.length > MAX_TRACE_ROWS)
  };
}

function supportingPaths(tracked, affected, changed) {
  const nearby = [], other = [];
  const folders = new Set(changed.map(file => path.posix.dirname(file)));
  for (const file of tracked) {
    if (affected.has(file)) continue;
    if (folders.has(path.posix.dirname(file))) nearby.push(file);
    else other.push(file);
  }
  return [...nearby, ...other];
}

function currentBranch(root) {
  try { return branch(root); }
  catch (error) {
    if (error.message === 'Detached HEAD is not supported.') return null;
    throw error;
  }
}

export async function loadCodeMap(root, { view, scope = null }) {
  if (!['changes', 'repository'].includes(view) || (scope != null && (view !== 'repository' || !validPath(scope)))) {
    throw new SingularityFlowError('Choose Changes or Repository and use a repository-relative folder or file.', {
      code: 'CMP_CODE_MAP_QUERY_INVALID'
    });
  }
  const activeBranch = currentBranch(root);
  const slice = view === 'changes'
    ? await (await import('./ide-slice.mjs')).loadComprehensionIdeSlice(root, activeBranch ? {} : { base: 'HEAD' })
    : null;
  const affected = new Map((slice?.manifest.regions ?? [])
    .map(region => [changePath(region.location), region])
    .filter(([file]) => codePath(file)));
  const changed = [...affected.keys()];
  const inventory = !slice || changed.length
    ? await repositoryCodeInventory(root, { scope, listOnly: true })
    : null;
  const tracked = [...new Set((inventory?.paths ?? []).filter(codePath))];
  const linkedInventory = inventory && { ...inventory, paths: tracked };
  const browser = !slice && linkedInventory ? repositoryCodeEntries(linkedInventory, scope) : null;
  const selectedChanges = new Set(changed.slice(0, MAX_FILES));
  const raw = slice?.explanationView;
  const changeView = raw ? {
    ...raw,
    inventory: {
      ...raw.inventory,
      files: raw.inventory.files.filter(file => selectedChanges.has(changePath(file)))
    }
  } : null;

  // A changed file must be part of the capture and match its after-content digest.
  // This lets a saved new file appear before staging. Unchanged context is tracked only.
  const candidates = slice
    ? [...changed.filter(file => affected.get(file).location.pathAfter),
      ...supportingPaths(tracked, affected, changed)]
    : tracked;
  const selected = (!slice || changed.length) ? candidates.slice(0, MAX_FILES) : [];
  const source = await readSources(root, selected, affected);
  const notices = [];
  if (inventory?.complete === false) notices.push('The tracked-file list is too large. Open a folder by path to see its code.');
  if (candidates.length > selected.length) {
    notices.push(slice
      ? `The call map includes up to ${MAX_FILES} files. Browse Repository for more context.`
      : `Showing up to ${MAX_FILES} files in this view. Open a folder or file to see more.`);
  }
  if (browser && browser.total > browser.entries.length) notices.push('Some folder entries are omitted. Use the path field to open them.');
  if (source.unavailable) notices.push(`${source.unavailable} selected file(s) could not be read within this view’s limits or changed during the read.`);
  if (changed.length > selectedChanges.size) notices.push(`The Changes outline shows the first ${MAX_FILES} changed code files.`);
  if (changed.length && slice?.diff.trackedRegions && slice.diff.fileProjectionStatus !== 'available') {
    notices.push('Changed-line previews are unavailable for this capture.');
  }
  const result = project({
    repository: { name: path.basename(root), branch: activeBranch, head: slice?.headCommit ?? null },
    story: null,
    change: {
      view: changeView,
      patch: slice?.diff.patch ?? null,
      patchFiles: (slice?.diff.files ?? []).filter(file => selectedChanges.has(changePath(file))),
      base: slice?.baselineCommit ?? null
    },
    files: source.files, calls: [], callStatus: {}, references: [], referenceStatus: {}, hovers: {},
    focus: null, view: 'full', depth: 1, modelEnabled: false,
    ...(notices.length ? { status: 'partial' } : {})
  });
  if (result.outlineLimited) notices.push(`Showing up to ${CX_LIMITS.symbols} declarations. Open a smaller folder or file for more detail.`);
  if (result.traceLimited) notices.push(`The trace shows up to ${MAX_TRACE_ROWS} entries each for requirements, tests and runs.`);
  return {
    view, scope, workId: slice?.context.workId ?? null, branch: activeBranch,
    changedFiles: changed.length, sourceFiles: source.files.length, notices,
    entries: browser?.entries.map(({ path, kind, files }) => ({ path, kind, files })) ?? [],
    ...result
  };
}
