/**
 * Change Explorer: the graphical XPL2 view inside the Comprehension Center [XPL2-REQ-022].
 *
 * Pure rendering over one XPL2 `change` view that the engine computed inside the leased
 * comprehension snapshot. Nothing here reads a file, runs a command or decides a fact: every node,
 * edge, count and sentence is taken from the computed view, and the page only arranges, highlights
 * and folds them. Edges are drawn only for relationships the view contains, labelled with their
 * scope, and every one is also listed in the Relationships table [XPL2-REQ-023]. Messages back to
 * the host carry a closed action name, the explanation-set digest and an exact unit digest — never
 * a path, command or URL to act on [XPL2-REQ-027].
 */
import { XPL2_RELATIONSHIPS } from '../../../../src/comprehension/xpl2/vocabulary.mjs';
import { XPL2_REASONS } from '../../../../src/comprehension/xpl2/reasons.mjs';
import { escape as escapeHtml } from './webview.ts';

export interface Xpl2Source {
  id: string;
  label: string | null;
  owner: string;
  family: string;
  digest: string | null;
  properties: { integrity: string; origin: string; applicability: string; availability: string };
  coverage: Record<string, unknown> | null;
}

export interface Xpl2Observation {
  id: string;
  adapter: string;
  scope: string;
  completeness: string;
  reason: string;
}

export interface Xpl2Statement {
  id: string;
  kind: string;
  about: string;
  template: string;
  cites: string[];
  limitations: string[];
  authority: 'none';
  text: string;
  /** The template's typed arguments (`path`, `line`, `clauseId`, …), already display-sanitized. */
  arguments?: Record<string, unknown>;
}

export interface Xpl2Node {
  id: string;
  kind: 'clause' | 'file' | 'unit' | 'test' | 'run' | 'decision' | 'invocation' | 'diagnostic';
  label: string;
  status: string | null;
  detail: Record<string, unknown> | null;
  cites: string[];
}

export interface Xpl2Relationship {
  id: string;
  type: string;
  from: string;
  to: string;
  granularity: string;
  scope: string;
  qualifier: string | null;
  cites: string[];
}

export interface Xpl2Attention {
  id: string;
  category: 'blocker' | 'visibility' | 'missing-explanation' | 'advisory';
  about: string;
  reason: string;
  statement: string;
}

export interface Xpl2Range { start: number; lines: number; end: number | null }

export interface Xpl2Unit {
  unitId: string;
  nodeId: string;
  fileId: string;
  unitKind: string;
  explanationStatus: string;
  path: string;
  pathBefore: string | null;
  pathAfter: string | null;
  operation: string;
  hunk: { hunkId: string; header: string; before: Xpl2Range; after: Xpl2Range } | null;
  opacity: { status: string; reason: string } | null;
  opaqueReason?: string | null;
  regionSha256: string;
  explanationUnitSha256: string;
}

export interface Xpl2File {
  fileId: string;
  path: string;
  pathBefore: string | null;
  pathAfter: string | null;
  operation: string;
  regionSha256: string;
  unitIds: string[];
  hunks: number;
  opaque: number;
  roles: string[];
  fileType?: { before: string | null; after: string | null };
  mode?: { before: string | null; after: string | null };
  sources: { before?: string; after?: string };
}

export interface Xpl2Explanation {
  kind: 'xpl2-explanation';
  subject: { kind: string; status: string; reason: string | null };
  snapshot: {
    truth: string;
    compatibilityCandidateSha256: string;
    baseline: { revision: string | null; selection: string | null };
    workId: string | null;
    phase: string | null;
    generation: number | null;
  };
  sources: Xpl2Source[];
  observations: Xpl2Observation[];
  statements: Xpl2Statement[];
  nodes: Xpl2Node[];
  relationships: Xpl2Relationship[];
  inventory: {
    files: Xpl2File[];
    units: Xpl2Unit[];
    counts: Record<string, number>;
    completeness: { status: string; reason: string | null };
  };
  availability: Record<string, string>;
  attention: Xpl2Attention[];
  presentation: {
    audience: string;
    audiences: Record<string, { order: string[]; folded: string[] }>;
    walkthrough: string[];
  };
  delivery: { complete: boolean; reason: string | null };
  explanationSetSha256: string;
  explanationSha256: string;
}

export type ExplorerAudience = 'reviewer' | 'auditor' | 'developer';

export interface PatchFile {
  pathBefore: string | null;
  pathAfter: string | null;
  patchStart: number;
  patchEnd: number;
  hunks: Array<{ header: string }>;
}

/**
 * Initial visible graph bound [XPL2 18]: three columns of at most twelve plus four "also changed"
 * files keeps the first view at forty nodes. Everything else is gathered into counted clusters
 * that stay in the page, the inventory and the Relationships table.
 */
export const EXPLORER_COLUMN_LIMIT = 12;
export const EXPLORER_ALSO_CHANGED_LIMIT = 4;
/** At most eighty edges are drawn at once; the selected item's edges are always among them. */
export const EXPLORER_EDGE_LIMIT = 80;
/** Bound on rendered preview rows for one hunk; the native diff remains available beyond it. */
export const EXPLORER_PREVIEW_ROWS = 400;

const TRUTH_LABELS: Record<string, string> = {
  'working-tree-observation': 'Working-tree observation',
  'repository-tree-comparison': 'Repository-tree comparison'
};

const CATEGORY_LABELS: Record<string, string> = {
  blocker: 'Reported failure',
  visibility: 'Visibility limit',
  'missing-explanation': 'Reason not recorded',
  advisory: 'Worth inspecting'
};

const STYLE_LABELS: Record<string, string> = {
  region: 'region only',
  proposed: 'declared tag',
  exact: 'exact path',
  diagnostic: 'observation gap',
  containment: 'contains',
  navigation: 'navigation hint',
  citation: 'cites'
};

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const marker = (character: string) => `[U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`;

/**
 * Controls, bidirectional overrides and separators become visible, inert markers, so a hostile
 * path can neither reorder what a reader sees nor pass for a different file [XPL2-AC-054]. Only the
 * display changes: identities and digests are compared on the untouched values.
 */
export function visibleText(value: unknown): string {
  return String(value ?? '').replace(CONTROL, marker);
}

/** Source lines keep their tabs; every other control is shown, never interpreted. */
export function visibleCode(value: unknown): string {
  return String(value ?? '').replace(CONTROL, (character) => character === '\t' ? character : marker(character));
}

/** Every text and attribute in this page is made visible-inert first, then HTML-escaped. */
function escape(value: unknown): string {
  return escapeHtml(visibleText(value));
}

function shortDigest(value: string | null | undefined): string {
  const text = String(value ?? '');
  return /^sha256:[a-f0-9]{64}$/u.test(text) ? text.slice(7, 19) : text ? text.slice(0, 12) : 'unavailable';
}

function reasonText(code: string): string {
  return (XPL2_REASONS as Record<string, string>)[code] ?? code;
}

/** Stable DOM token for an XPL2 node id; ids are closed-shape, but never used unescaped. */
function domId(nodeId: string): string {
  return `xpl-${nodeId.replace(/[^A-Za-z0-9_-]/gu, '-')}`;
}

// ---- Selected change: side-by-side hunk preview from the snapshot's own bounded patch -----------

export interface PreviewRow {
  before: { line: number; text: string; kind: 'context' | 'removed' } | null;
  after: { line: number; text: string; kind: 'context' | 'added' } | null;
}

/**
 * Parse one exact hunk from the snapshot's bounded patch into aligned rows. Removed and added runs
 * are paired in order; context lines appear on both sides. A final carriage return is the line
 * ending of a CRLF file, reported once rather than marked on every row; any other CR stays visible.
 * Returns null when the unit's hunk is not present in the patch section (the caller then states
 * that the preview is unavailable).
 */
export function hunkPreview(
  patch: string | null, files: PatchFile[], unit: Xpl2Unit
): { rows: PreviewRow[]; truncated: boolean; crlf: boolean } | null {
  if (!patch || !unit.hunk) return null;
  const file = files.find((entry) => (entry.pathAfter ?? entry.pathBefore) === (unit.pathAfter ?? unit.pathBefore)
    && entry.pathBefore === unit.pathBefore && entry.pathAfter === unit.pathAfter);
  if (!file) return null;
  const section = patch.slice(file.patchStart, file.patchEnd);
  const lines = section.split('\n');
  const withoutEnding = (line: string) => line.endsWith('\r') ? line.slice(0, -1) : line;
  const header = withoutEnding(unit.hunk.header);
  const start = lines.findIndex((line) => withoutEnding(line) === header);
  if (start < 0) return null;
  const rows: PreviewRow[] = [];
  let beforeLine = unit.hunk.before.start;
  let afterLine = unit.hunk.after.start;
  let removed: string[] = [];
  let added: string[] = [];
  let truncated = false;
  let crlf = false;
  const content = (line: string) => {
    const text = line.slice(1);
    if (!text.endsWith('\r')) return text;
    crlf = true;
    return text.slice(0, -1);
  };
  const flush = () => {
    const width = Math.max(removed.length, added.length);
    for (let index = 0; index < width; index += 1) {
      const before = removed[index];
      const after = added[index];
      rows.push({
        before: before === undefined ? null : { line: beforeLine++, text: before, kind: 'removed' },
        after: after === undefined ? null : { line: afterLine++, text: after, kind: 'added' }
      });
    }
    removed = [];
    added = [];
  };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('@@ ') || line.startsWith('diff --git ')) break;
    if (rows.length >= EXPLORER_PREVIEW_ROWS) { truncated = true; break; }
    if (line.startsWith('-')) removed.push(content(line));
    else if (line.startsWith('+')) added.push(content(line));
    else if (line.startsWith(' ')) {
      flush();
      const text = content(line);
      rows.push({
        before: { line: beforeLine++, text, kind: 'context' },
        after: { line: afterLine++, text, kind: 'context' }
      });
    }
  }
  flush();
  return { rows, truncated, crlf };
}

// ---- Deterministic, model-free summary ("Copy summary" / "Read this change") -------------------

/** The walkthrough as plain text: fixed order, exact statements, citation IDs; no model involved. */
export function explorerSummary(view: Xpl2Explanation): string {
  const byId = new Map(view.statements.map((entry) => [entry.id, entry]));
  const heading = [
    `Change Explorer — ${visibleText(view.snapshot.workId ?? 'repository changes')}`,
    `${TRUTH_LABELS[view.snapshot.truth] ?? view.snapshot.truth}; baseline ${shortDigest(view.snapshot.baseline.revision)}`
      + ` → capture ${shortDigest(view.snapshot.compatibilityCandidateSha256)}`,
    'Record-derived and read-only; this summary grants no approval, test result or merge verdict.'
  ];
  const body = view.presentation.walkthrough.map((id) => byId.get(id)).filter(Boolean)
    .map((entry) => `- ${visibleText(entry!.text)} [${entry!.cites.join(', ')}]`);
  return [...heading, '', ...body, '', `Explanation set ${shortDigest(view.explanationSetSha256)}`].join('\n');
}

// ---- Graph layout: three columns, bounded, clustered ------------------------------------------

interface Column { title: string; nodes: Xpl2Node[] }

function graphColumns(view: Xpl2Explanation): { intent: Column; code: Column; results: Column; alsoChanged: Xpl2Node[] } {
  const nodes = view.nodes;
  const linked = new Set<string>();
  for (const edge of view.relationships) {
    if (['region-associated-with-clause', 'source-tags-clause', 'test-source-in-change'].includes(edge.type)) {
      linked.add(edge.from); linked.add(edge.to);
    }
  }
  const files = nodes.filter((node) => node.kind === 'file');
  return {
    intent: { title: 'Intent', nodes: nodes.filter((node) => node.kind === 'clause') },
    code: { title: 'Changed code', nodes: files.filter((node) => linked.has(node.id)) },
    results: { title: 'Recorded results', nodes: nodes.filter((node) => ['test', 'run', 'diagnostic', 'decision'].includes(node.kind)) },
    alsoChanged: files.filter((node) => !linked.has(node.id))
  };
}

/** The manifest's recorded file kind, so a link target or gitlink pointer never reads as file text. */
function fileKindLabels(file: Xpl2File): string[] {
  const types = [file.fileType?.before, file.fileType?.after];
  const labels = [];
  if (types.includes('symlink')) labels.push('symbolic link');
  if (types.includes('gitlink')) labels.push('submodule pointer');
  const [before, after] = types;
  if (before && after && before !== after && before !== 'missing' && after !== 'missing') labels.push('type changed');
  if (file.mode?.before && file.mode.after && file.mode.before !== file.mode.after && before === after) {
    labels.push(`mode ${file.mode.before} → ${file.mode.after}`);
  }
  return labels;
}

function nodeSubtitle(view: Xpl2Explanation, node: Xpl2Node): string {
  if (node.kind === 'file') {
    const file = view.inventory.files.find((entry) => entry.fileId === node.id);
    if (!file) return '';
    const parts = [...fileKindLabels(file)];
    if (file.hunks) parts.push(`${file.hunks} text hunk${file.hunks === 1 ? '' : 's'}`);
    if (file.opaque) parts.push(`${file.opaque} opaque`);
    return `${parts.join(' · ')} · ${file.unitIds.join(' · ')}`;
  }
  if (node.kind === 'clause') {
    return node.status === 'declared' ? 'Declared requirement'
      : node.status === 'conflicting-declarations' ? 'Conflicting declarations — all shown'
        : 'Named here; no specification read here declares it';
  }
  if (node.kind === 'test') return 'Test source with a declared @ac tag';
  if (node.kind === 'run') return `Local delivery record · ${node.status ?? 'unknown'}`;
  if (node.kind === 'diagnostic') {
    return node.status === 'owner-reported-gap' ? 'Reported by its owner · not a failed test'
      : node.status === 'region-only-association' ? 'Region association only' : 'No exact cause link recorded';
  }
  return '';
}

function nodeEyebrow(node: Xpl2Node): string {
  return node.kind === 'clause' ? 'Requirement'
    : node.kind === 'file' ? 'Changed file'
      : node.kind === 'test' ? 'Declared mapping'
        : node.kind === 'run' ? 'Recorded result'
          : node.kind === 'diagnostic' ? 'Observation gap' : node.kind;
}

function nodeButton(view: Xpl2Explanation, node: Xpl2Node, column: string, index: number): string {
  const gap = node.kind === 'diagnostic' || (node.kind === 'run' && !['passed', 'pass', 'succeeded', 'success'].includes(String(node.status)));
  const described = view.relationships.filter((edge) => edge.from === node.id || edge.to === node.id)
    .map((edge) => relationshipSentence(view, edge)).join(' ');
  return `<button type="button" class="xpl-node xpl-${node.kind}${gap ? ' xpl-gap' : ''}" id="${domId(node.id)}" data-node="${escape(node.id)}" data-column="${column}" data-index="${index}" aria-label="${escape(`${nodeEyebrow(node)}: ${node.label}. ${nodeSubtitle(view, node)}. ${described}`)}">
    <span class="xpl-eyebrow">${escape(nodeEyebrow(node))}</span>
    <strong>${escape(node.label)}</strong>
    <span class="xpl-sub">${escape(nodeSubtitle(view, node))}</span>
  </button>`;
}

function columnHtml(view: Xpl2Explanation, key: string, column: Column): string {
  const visible = column.nodes.slice(0, EXPLORER_COLUMN_LIMIT);
  const hidden = column.nodes.slice(EXPLORER_COLUMN_LIMIT);
  const cluster = hidden.length
    ? `<details class="xpl-cluster"><summary>${hidden.length} more in ${escape(column.title.toLowerCase())} — counted, not hidden</summary>${hidden.map((node, index) => nodeButton(view, node, key, EXPLORER_COLUMN_LIMIT + index)).join('')}</details>`
    : '';
  const empty = column.nodes.length ? '' : `<p class="xpl-empty">${key === 'intent'
    ? 'No clause is named by a tag in the changed files, a recorded association or a delivery record.'
    : key === 'results' ? 'No recorded test result or observation gap.' : 'No changed file has a recorded relationship.'}</p>`;
  return `<div class="xpl-column" data-column-key="${key}" role="list" aria-label="${escape(column.title)}"><h3>${escape(column.title)}</h3>${visible.map((node, index) => nodeButton(view, node, key, index)).join('')}${cluster}${empty}</div>`;
}

function relationshipSentence(view: Xpl2Explanation, edge: Xpl2Relationship): string {
  const from = view.nodes.find((node) => node.id === edge.from)?.label ?? edge.from;
  const to = view.nodes.find((node) => node.id === edge.to)?.label ?? edge.to;
  const meaning = (XPL2_RELATIONSHIPS as Record<string, { means: string }>)[edge.type]?.means ?? edge.type;
  return `${from} → ${to}: ${meaning}`;
}

function mapHtml(view: Xpl2Explanation): string {
  const columns = graphColumns(view);
  const drawn = view.relationships.filter((edge) => edge.type !== 'file-contains-unit' && edge.from !== edge.to);
  const edges = drawn.map((edge) => ({
    id: edge.id,
    from: domId(edge.from),
    to: domId(edge.to),
    fromNode: edge.from,
    toNode: edge.to,
    style: (XPL2_RELATIONSHIPS as Record<string, { style: string }>)[edge.type]?.style ?? 'exact',
    label: STYLE_LABELS[(XPL2_RELATIONSHIPS as Record<string, { style: string }>)[edge.type]?.style ?? 'exact'] ?? edge.granularity
  }));
  const alsoVisible = columns.alsoChanged.slice(0, EXPLORER_ALSO_CHANGED_LIMIT);
  const alsoHidden = columns.alsoChanged.slice(EXPLORER_ALSO_CHANGED_LIMIT);
  const alsoOffset = columns.code.nodes.length;
  const alsoCluster = alsoHidden.length
    ? `<details class="xpl-cluster"><summary>${alsoHidden.length} more also changed — counted, not hidden</summary>${alsoHidden.map((node, index) => nodeButton(view, node, 'code', alsoOffset + EXPLORER_ALSO_CHANGED_LIMIT + index)).join('')}</details>`
    : '';
  const also = columns.alsoChanged.length
    ? `<div class="xpl-also" role="group" aria-label="Also changed"><h4>Also changed (${columns.alsoChanged.length})</h4><p class="xpl-sub">No recorded intent or test relationship; these files remain in the inventory.</p><div class="xpl-also-list">${alsoVisible.map((node, index) => nodeButton(view, node, 'code', alsoOffset + index)).join('')}${alsoCluster}</div></div>`
    : '';
  return `<div class="xpl-map" id="xpl-map" data-edges="${escape(JSON.stringify(edges))}" data-edge-limit="${EXPLORER_EDGE_LIMIT}">
    <svg class="xpl-edges" aria-hidden="true" focusable="false"></svg>
    <svg class="xpl-edge-labels" aria-hidden="true" focusable="false"></svg>
    ${columnHtml(view, 'intent', columns.intent)}
    <div class="xpl-column-wrap">${columnHtml(view, 'code', columns.code)}${also}</div>
    ${columnHtml(view, 'results', columns.results)}
  </div>
  <p class="xpl-note" id="xpl-edge-note" hidden></p>
  <ul class="xpl-sr-edges" aria-label="Relationships shown on the map">${drawn.map((edge) => `<li>${escape(relationshipSentence(view, edge))} (${escape(edge.scope)})</li>`).join('')}</ul>
  <p class="xpl-legend"><span class="xpl-key xpl-key-region"></span> Recorded region association <span class="xpl-key xpl-key-proposed"></span> Declared tag (@clause in code, @ac in tests) <span class="xpl-key xpl-key-citation"></span> Clause cites clause <span class="xpl-key xpl-key-exact"></span> Exact path identity <span class="xpl-key xpl-key-diagnostic"></span> Observation gap · <strong>No test-to-hunk coverage is inferred.</strong></p>`;
}

function relationshipsTable(view: Xpl2Explanation): string {
  if (!view.relationships.length) return '<p class="xpl-empty">No relationships are recorded in this snapshot.</p>';
  const label = (id: string) => view.nodes.find((node) => node.id === id)?.label ?? id;
  return `<div class="table-wrap"><table class="xpl-table"><caption>Every relationship in the computed view, including those the map folds or does not draw.</caption>
    <thead><tr><th scope="col">From</th><th scope="col">Relationship</th><th scope="col">To</th><th scope="col">Scope</th><th scope="col">Does not imply</th><th scope="col">Cites</th></tr></thead>
    <tbody>${view.relationships.map((edge) => {
      const vocabulary = (XPL2_RELATIONSHIPS as Record<string, { notImplied: string }>)[edge.type];
      return `<tr><td><button type="button" class="link" data-node="${escape(edge.from)}">${escape(label(edge.from))}</button></td><td>${escape(edge.type)}${edge.qualifier ? ` <span class="badge">${escape(edge.qualifier)}</span>` : ''}</td><td><button type="button" class="link" data-node="${escape(edge.to)}">${escape(label(edge.to))}</button></td><td>${escape(edge.scope)}</td><td>${escape(vocabulary?.notImplied ?? '')}</td><td>${edge.cites.map((id) => `<code>${escape(id)}</code>`).join(' ')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

export interface TimelineEvent { at?: string | null; kind: string; phase?: string | null; generation?: number | string | null; provenance?: string | null }

function timelineHtml(view: Xpl2Explanation, events: TimelineEvent[] | null): string {
  if (!events) {
    return `<p class="xpl-empty">No Story history is bound to this repository view. ${escape(reasonText('no-active-story'))}</p>`;
  }
  const rows = events.map((event) => `<tr><td>${escape(event.at ?? 'unknown')}</td><td>${escape(event.kind)}</td><td>${escape(event.phase ?? '—')}</td><td>${escape(event.generation ?? '—')}</td><td>${escape(event.provenance ?? 'unavailable')}</td></tr>`).join('');
  return `<p class="xpl-note">Normalized Story history in its recorded order. It is not a provenance timeline: observed writes and invocation links are ${escape(view.availability.provenance ?? 'unavailable')}.</p>
    ${rows ? `<div class="table-wrap"><table class="xpl-table"><thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Phase</th><th scope="col">Generation</th><th scope="col">Provenance</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="xpl-empty">No normalized events are recorded.</p>'}`;
}

// ---- Inspector panes (one per node, toggled by the page) ---------------------------------------

function citationList(view: Xpl2Explanation, ids: string[]): string {
  return ids.map((id) => {
    const source = view.sources.find((entry) => entry.id === id);
    if (source) {
      return `<li><code>${escape(id)}</code> ${escape(source.label ?? source.family)} — integrity ${escape(source.properties.integrity)}, ${escape(source.properties.origin)}, ${escape(source.properties.applicability)}, ${escape(source.properties.availability)}${source.digest ? ` · <code>${escape(shortDigest(source.digest))}</code>` : ''}</li>`;
    }
    const observation = view.observations.find((entry) => entry.id === id);
    if (observation) {
      return `<li><code>${escape(id)}</code> Read observation — ${escape(observation.scope)}: ${escape(reasonText(observation.reason))}</li>`;
    }
    return `<li><code>${escape(id)}</code> unresolved</li>`;
  }).join('');
}

function inspectorPane(view: Xpl2Explanation, node: Xpl2Node): string {
  const file = node.kind === 'file' ? view.inventory.files.find((entry) => entry.fileId === node.id) : null;
  const units = file ? view.inventory.units.filter((unit) => unit.fileId === node.id) : [];
  // A file's pane also states what is recorded about each of its change units.
  const unitNodes = new Set(units.map((unit) => unit.nodeId));
  const statements = view.statements.filter((entry) => entry.about === node.id || unitNodes.has(entry.about));
  const edges = view.relationships.filter((edge) => (edge.from === node.id || edge.to === node.id) && edge.type !== 'file-contains-unit');
  const citations = [...new Set([...node.cites, ...statements.flatMap((entry) => entry.cites), ...edges.flatMap((edge) => edge.cites)])].sort();
  const limits = [...new Set(statements.flatMap((entry) => entry.limitations))];
  const notImplied = [...new Set(edges.map((edge) => (XPL2_RELATIONSHIPS as Record<string, { notImplied: string }>)[edge.type]?.notImplied).filter(Boolean))];
  return `<section class="xpl-pane" data-pane="${escape(node.id)}" hidden>
    <p class="xpl-eyebrow">${escape(nodeEyebrow(node))}${node.status ? ` · ${escape(node.status)}` : ''}</p>
    <h3>${escape(node.label)}</h3>
    ${statements.length ? `<ul class="xpl-statements">${statements.map((entry) => `<li>${escape(entry.text)} <span class="xpl-cites">${entry.cites.map((id) => `<code>${escape(id)}</code>`).join(' ')}</span></li>`).join('')}</ul>` : '<p class="xpl-empty">No statement is recorded about this item.</p>'}
    ${units.length ? `<h4>Change units</h4><ul class="xpl-units">${units.map((unit) => `<li><button type="button" class="link" data-unit="${escape(unit.unitId)}">${escape(unit.unitId)}</button> ${unit.hunk ? `before ${unit.hunk.before.start},${unit.hunk.before.lines} · after ${unit.hunk.after.start},${unit.hunk.after.lines}` : escape(reasonText(unit.opaqueReason ?? 'opaque-content'))}</li>`).join('')}</ul>` : ''}
    ${edges.length ? `<h4>Recorded relationships</h4><ul>${edges.map((edge) => `<li>${escape(relationshipSentence(view, edge))} <span class="badge">${escape(edge.scope)}</span></li>`).join('')}</ul>` : '<h4>Recorded relationships</h4><p class="xpl-empty">None beyond file membership.</p>'}
    <div class="xpl-limit"><h4>What this does not establish</h4><ul>${[...notImplied.map((text) => `<li>${escape(text)}</li>`), ...limits.map((code) => `<li>${escape(reasonText(code))}</li>`)].join('') || '<li>This inspection is read-only; it grants no approval, test result or merge verdict.</li>'}</ul></div>
    <details class="xpl-sources"><summary>Supporting sources (${citations.length})</summary><ul>${citationList(view, citations)}</ul></details>
  </section>`;
}

function defaultPane(view: Xpl2Explanation): string {
  const admission = view.statements.find((entry) => entry.kind === 'admission-unavailable');
  return `<section class="xpl-pane" data-pane="" >
    <p class="xpl-eyebrow">Read-only inspection</p>
    <h3>Select an item</h3>
    <p>Choose a requirement, changed file, result or attention item to see exactly what is recorded about it, at what scope, and what it does not establish.</p>
    ${admission ? `<div class="xpl-limit"><h4>Admission status</h4><p>${escape(admission.text)}</p></div>` : ''}
    <details class="xpl-sources"><summary>All admitted sources (${view.sources.length + view.observations.length})</summary><ul>${citationList(view, [...view.sources.map((entry) => entry.id), ...view.observations.map((entry) => entry.id)])}</ul></details>
  </section>`;
}

// ---- Left rail --------------------------------------------------------------------------------

function inventoryRail(view: Xpl2Explanation, audience: ExplorerAudience): string {
  const byId = new Map(view.statements.map((entry) => [entry.id, entry]));
  const order = view.presentation.audiences[audience]?.order ?? [];
  const rank = new Map(order.map((id, index) => [id, index]));
  const fileRank = (file: Xpl2File) => Math.min(...view.statements.filter((entry) => entry.about === file.fileId
    || file.unitIds.some((unit) => entry.about === `unit:${unit}`)).map((entry) => rank.get(entry.id) ?? 1e9), 1e9);
  const files = [...view.inventory.files].sort((left, right) => fileRank(left) - fileRank(right) || left.path.localeCompare(right.path));
  const attention = view.attention.map((entry) => {
    const statement = byId.get(entry.statement);
    return `<li><button type="button" class="xpl-attention xpl-attention-${entry.category}" data-node="${escape(entry.about)}" data-attention="${escape(entry.id)}"><strong>${escape(CATEGORY_LABELS[entry.category] ?? entry.category)}</strong><span>${escape(statement?.text ?? reasonText(entry.reason))}</span></button></li>`;
  }).join('');
  return `<aside class="xpl-rail" aria-label="Change inventory">
    <div class="xpl-rail-head"><h2>Change inventory</h2><span class="badge">${view.inventory.counts.changeUnits} units</span></div>
    <label class="xpl-search-label" for="xpl-search">Find a changed file</label>
    <input id="xpl-search" type="search" placeholder="Search captured files…" autocomplete="off" spellcheck="false">
    <ul class="xpl-files" id="xpl-files">${files.map((file) => {
      const status = file.opaque && !file.hunks ? 'opaque resource'
        : view.relationships.some((edge) => edge.type === 'region-associated-with-clause' && edge.to === file.fileId) ? 'region association'
          : 'reason not recorded';
      return `<li data-path="${escape(file.path.toLowerCase())}"><button type="button" class="xpl-file" data-node="${escape(file.fileId)}"><span class="xpl-op" aria-label="${escape(file.operation)}">${escape(file.operation.slice(0, 1).toUpperCase())}</span><span><strong>${escape(file.path)}</strong><span class="xpl-sub">${fileKindLabels(file).map((label) => `${escape(label)} · `).join('')}${file.hunks ? `${file.hunks} text hunk${file.hunks === 1 ? '' : 's'}` : ''}${file.hunks && file.opaque ? ' · ' : ''}${file.opaque ? `${file.opaque} opaque` : ''} · ${escape(status)}</span></span></button></li>`;
    }).join('')}</ul>
    <p class="xpl-note" id="xpl-filter-note" hidden>Filtering changes this list, not the evidence set.</p>
    <h2 class="xpl-rail-section">Needs attention</h2>
    ${attention ? `<ol class="xpl-attention-list">${attention}</ol>` : '<p class="xpl-empty">No attention item was reported.</p>'}
    <p class="xpl-note">Every changed resource remains counted. Attention items are inspection prompts, not blockers, unless a source owner reported a failure.</p>
  </aside>`;
}

// ---- Selected change -------------------------------------------------------------------------

function unitPreviewHtml(view: Xpl2Explanation, unit: Xpl2Unit, patch: string | null, files: PatchFile[]): string {
  const preview = hunkPreview(patch, files, unit);
  const endings = preview?.crlf ? '<span class="badge">CRLF line endings</span> ' : '';
  const header = `<div class="xpl-diff-head"><code>${escape(unit.path)}</code><span>${endings}<span class="badge">${escape(unit.unitId)}</span></span></div>`;
  if (!unit.hunk) {
    const reason = unit.opaqueReason ?? (unit.unitKind === 'untracked-region-opaque' ? 'untracked-content-excluded' : 'opaque-content');
    return `<section class="xpl-unit" data-unit-pane="${escape(unit.unitId)}" hidden>${header}<p class="xpl-note">${escape(reasonText(reason))} Use <strong>Open working file</strong> to inspect the current file explicitly.</p></section>`;
  }
  if (!preview) {
    return `<section class="xpl-unit" data-unit-pane="${escape(unit.unitId)}" hidden>${header}<p class="xpl-note">The bounded patch in this snapshot does not include a text preview for ${escape(unit.unitId)}. The native diff reads the exact retained bytes.</p></section>`;
  }
  const cell = (side: PreviewRow['before'] | PreviewRow['after']) => side
    ? `<td class="xpl-ln">${side.line}</td><td class="xpl-code xpl-${side.kind}"><span class="xpl-mark" aria-hidden="true">${side.kind === 'removed' ? '−' : side.kind === 'added' ? '+' : ' '}</span>${escapeHtml(visibleCode(side.text))}</td>`
    : '<td class="xpl-ln"></td><td class="xpl-code xpl-none"></td>';
  return `<section class="xpl-unit" data-unit-pane="${escape(unit.unitId)}" hidden>${header}
    <table class="xpl-diff"><caption class="xpl-sr">Before and after lines of ${escape(unit.unitId)}; removed and added lines are marked with minus and plus signs.</caption>
      <colgroup><col class="xpl-ln-col"><col><col class="xpl-ln-col"><col></colgroup>
      <thead><tr><th scope="col" colspan="2">Before · baseline</th><th scope="col" colspan="2">After · capture</th></tr></thead>
      <tbody>${preview.rows.map((row) => `<tr>${cell(row.before)}${cell(row.after)}</tr>`).join('')}</tbody></table>
    ${preview.truncated ? `<p class="xpl-note">Preview stopped at ${EXPLORER_PREVIEW_ROWS} rows; the native diff shows the whole file.</p>` : ''}
  </section>`;
}

/**
 * What an editor, Explorer or Source Control menu asked the Change Explorer to show: one
 * repository-relative file and, from the editor, the cursor line on the after (working) side.
 */
export interface ExplorerFocusRequest {
  path: string;
  line: number | null;
  unsaved: boolean;
}

/** The selection a focus request resolves to in one exact view, and what the reader is told. */
export interface ExplorerFocus {
  node: string | null;
  unit: string | null;
  notice: string | null;
}

/**
 * Resolve a menu request against the pinned view, by the same rule as `explain --subject line`
 * on the after side: a text unit covers a line inside its after range, and an opaque unit stands
 * for its whole file [XPL2 4.1]. The notice describes the request ("that line is not a changed
 * line"), never the change; every fact on the page still comes from the computed view.
 */
export function resolveExplorerFocus(view: Xpl2Explanation, request: ExplorerFocusRequest): ExplorerFocus {
  const unsaved = request.unsaved ? ' The editor has unsaved edits; this snapshot reflects the saved file.' : '';
  // A deleted file can still be chosen from Source Control, so a file request also matches the
  // before path. A line is always a line of the working file, which a deleted file no longer has.
  const units = view.inventory.units.filter((unit) => unit.pathAfter === request.path
    || (request.line === null && unit.pathBefore === request.path));
  if (!units.length) {
    return { node: null, unit: null, notice: `${request.path} has no changes in this snapshot. Showing every change.${unsaved}` };
  }
  const first = units.find((unit) => unit.hunk) ?? units[0]!;
  const quiet = unsaved ? unsaved.trim() : null;
  if (request.line === null) return { node: first.fileId, unit: first.unitId, notice: quiet };
  const line = request.line;
  const covering = units.find((unit) => unit.hunk && unit.hunk.after.lines > 0
    && line >= unit.hunk.after.start && line <= unit.hunk.after.start + unit.hunk.after.lines - 1)
    ?? units.find((unit) => !unit.hunk);
  if (covering) return { node: covering.fileId, unit: covering.unitId, notice: quiet };
  return {
    node: first.fileId, unit: first.unitId,
    notice: `Line ${line} is not a changed line of ${request.path} in this snapshot. Showing this file's changes.${unsaved}`
  };
}

export interface ExplorerRenderInput {
  view: Xpl2Explanation | null;
  unavailableReason: string | null;
  patch: string | null;
  patchFiles: PatchFile[];
  timeline: TimelineEvent[] | null;
  audience: ExplorerAudience;
  newerSnapshot: boolean;
  token: string;
  /**
   * A resolved menu request. The host sends it with every render of the same explanation set, and
   * the page applies each `id` once: a render replaced before its script ran cannot lose it, and a
   * later render cannot undo a selection the reader made since.
   */
  focus?: (ExplorerFocus & { id: string }) | null;
}

/** Complete Change Explorer body; the host renders it inside the Comprehension Center page. */
export function changeExplorerBody(input: ExplorerRenderInput): string {
  const { view } = input;
  if (!view) {
    return `<section class="xpl-empty-state"><h2>Change Explorer</h2><p>The computed change view is unavailable in this snapshot${input.unavailableReason ? ` (<code>${escape(input.unavailableReason)}</code>)` : ''}. The Regions and Diff tabs still show every changed file; nothing is blocked.</p><p><button class="secondary" type="button" data-message="refresh">Refresh exact snapshot</button></p></section>`;
  }
  const focus = input.focus ?? null;
  const counts = view.inventory.counts;
  const truth = TRUTH_LABELS[view.snapshot.truth] ?? view.snapshot.truth;
  const wel = view.availability.wel === 'partial' ? 'WEL observe (not read here)' : view.availability.wel === 'disabled' ? 'WEL off' : 'WEL not evaluated';
  const firstUnit = view.inventory.units.find((unit) => unit.hunk) ?? view.inventory.units[0] ?? null;
  const unitsJson = JSON.stringify(view.inventory.units.map((unit) => ({
    unitId: unit.unitId, nodeId: unit.nodeId, fileId: unit.fileId, digest: unit.explanationUnitSha256
  })));
  return `<style nonce="${escape(input.token)}">${EXPLORER_STYLE}</style>
  <div class="xpl" id="xpl-root" data-set="${escape(view.explanationSetSha256)}" data-session="${escape(input.token)}" data-units="${escape(unitsJson)}" data-first-unit="${escape(firstUnit?.unitId ?? '')}"${focus ? ` data-focus-id="${escape(focus.id)}" data-focus-node="${escape(focus.node ?? '')}" data-focus-unit="${escape(focus.unit ?? '')}"` : ''}>
    ${input.newerSnapshot ? '<div class="xpl-banner" role="status"><strong>Snapshot changed.</strong> The repository moved since this view was built. You are still looking at the earlier snapshot. <button type="button" class="secondary" data-message="refresh">Refresh to the new snapshot</button></div>' : ''}
    <header class="xpl-header">
      <div>
        <p class="xpl-kicker">Singularity Flow / Change Explorer</p>
        <h1>Understand the change, follow the evidence.</h1>
        <p class="xpl-meta">${escape(view.snapshot.workId ?? 'Repository changes')}${view.snapshot.phase ? ` · ${escape(view.snapshot.phase)}` : ''} · ${escape(truth)} · baseline <code>${escape(shortDigest(view.snapshot.baseline.revision))}</code> → capture <code>${escape(shortDigest(view.snapshot.compatibilityCandidateSha256))}</code></p>
      </div>
      <div class="xpl-actions">
        <span class="xpl-pill xpl-pill-warn">Admission not evaluated</span>
        <span class="xpl-pill">Read-only</span>
        <label class="xpl-audience">View for <select id="xpl-audience" aria-label="Audience ordering">${(['reviewer', 'auditor', 'developer'] as const).map((value) => `<option value="${value}"${value === input.audience ? ' selected' : ''}>${value.charAt(0).toUpperCase()}${value.slice(1)}</option>`).join('')}</select></label>
        <button type="button" class="secondary" data-message="explorer-copy">Copy summary</button>
        <button type="button" class="secondary" data-message="refresh">Refresh snapshot</button>
      </div>
    </header>
    <section class="xpl-stats" aria-label="Change counts">
      <div><strong>${counts.files}</strong><span>changed files</span></div>
      <div><strong>${counts.textHunks}</strong><span>text hunks</span></div>
      <div><strong>${counts.opaqueUnits}</strong><span>opaque units</span></div>
      <div><strong>${counts.causeBoundUnits}</strong><span>hunk-bound cause links</span></div>
      <div><strong>${counts.clauses}</strong><span>clauses in scope</span></div>
      <p>Region associations and recorded results are not hunk-level proof.</p>
    </section>
    ${focus?.notice ? `<div class="xpl-notice" id="xpl-focus-notice" role="status">${escape(focus.notice)}</div>` : ''}
    <div class="xpl-layout">
      ${inventoryRail(view, input.audience)}
      <main class="xpl-center">
        <section class="xpl-card" aria-labelledby="xpl-map-title">
          <div class="xpl-card-head"><h2 id="xpl-map-title">Change map</h2>
            <div class="xpl-views" role="tablist" aria-label="Map views">
              <button type="button" role="tab" id="xpl-view-map" aria-controls="xpl-panel-map" aria-selected="true" data-view="map">Map</button>
              <button type="button" role="tab" id="xpl-view-relationships" aria-controls="xpl-panel-relationships" aria-selected="false" tabindex="-1" data-view="relationships">Relationships</button>
              <button type="button" role="tab" id="xpl-view-timeline" aria-controls="xpl-panel-timeline" aria-selected="false" tabindex="-1" data-view="timeline">Timeline</button>
            </div>
          </div>
          <p class="xpl-note">Select a requirement, changed file or result. Dashed and dotted lines are scoped associations, not proof. The Relationships view lists every relationship as a table.</p>
          <div id="xpl-panel-map" role="tabpanel" aria-labelledby="xpl-view-map">${mapHtml(view)}</div>
          <div id="xpl-panel-relationships" role="tabpanel" aria-labelledby="xpl-view-relationships" hidden>${relationshipsTable(view)}</div>
          <div id="xpl-panel-timeline" role="tabpanel" aria-labelledby="xpl-view-timeline" hidden>${timelineHtml(view, input.timeline)}</div>
        </section>
        <section class="xpl-card" aria-labelledby="xpl-selected-title">
          <div class="xpl-card-head"><h2 id="xpl-selected-title">Selected change</h2>
            <div class="xpl-diff-actions">
              <button type="button" class="secondary" data-step="-1" aria-label="Previous change unit">←</button>
              <button type="button" class="secondary" data-step="1" aria-label="Next change unit">→</button>
              <button type="button" data-message="explorer-open-diff">Open native diff</button>
              <button type="button" class="secondary" data-message="explorer-open-file">Open working file</button>
            </div>
          </div>
          ${view.inventory.units.map((unit) => unitPreviewHtml(view, unit, input.patch, input.patchFiles)).join('')}
          ${view.inventory.units.length ? '' : '<p class="xpl-empty">No changes in this selected interval.</p>'}
          <p class="xpl-note">Preview from this snapshot's bounded patch. <strong>Open native diff</strong> opens the exact retained before and after bytes read-only; <strong>Open working file</strong> opens today's file, which may have moved.</p>
        </section>
      </main>
      <aside class="xpl-inspector" aria-label="Why this is shown">
        <div class="xpl-card-head"><h2>Why this is shown</h2><span class="xpl-pill">Read-only</span></div>
        ${defaultPane(view)}
        ${view.nodes.filter((node) => node.kind !== 'unit').map((node) => inspectorPane(view, node)).join('')}
        <div class="xpl-inspector-actions"><button type="button" class="secondary" data-next-attention>Next attention item →</button></div>
        <p class="xpl-note">Selecting, expanding and inspecting do not approve, run tests, edit code or change Story state.</p>
      </aside>
    </div>
    <footer class="xpl-footer"><span>${counts.changeUnits} of ${counts.changeUnits} change units accounted for${view.inventory.completeness.status === 'complete' ? '' : ' (lower bound)'} · ${escape(wel)} · No model required for this view</span><span>Explanation set <code>${escape(shortDigest(view.explanationSetSha256))}</code></span></footer>
  </div>`;
}

export const EXPLORER_STYLE = `
  .xpl { display:flex; flex-direction:column; gap:14px; }
  .xpl code { font-family: var(--vscode-editor-font-family, monospace); }
  .xpl-banner { border:1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder)); background: var(--vscode-inputValidation-warningBackground, transparent); padding:8px 12px; border-radius:6px; }
  .xpl-notice { border:1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-focusBorder)); background: var(--vscode-inputValidation-infoBackground, transparent); padding:8px 12px; border-radius:6px; }
  .xpl-header { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; align-items:flex-start; }
  .xpl-kicker { text-transform:uppercase; letter-spacing:.08em; font-size:11px; color: var(--vscode-textLink-foreground); margin:0; }
  .xpl-header h1 { margin:4px 0; font-size:22px; }
  .xpl-meta { margin:0; color: var(--vscode-descriptionForeground); }
  .xpl-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .xpl-pill { border:1px solid var(--vscode-panel-border); border-radius:999px; padding:2px 10px; font-size:12px; }
  .xpl-pill-warn { border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); }
  .xpl-audience select { margin-left:4px; }
  .xpl-stats { display:flex; gap:0; flex-wrap:wrap; border:1px solid var(--vscode-panel-border); border-radius:8px; }
  .xpl-stats div { padding:10px 18px; border-right:1px solid var(--vscode-panel-border); display:flex; gap:8px; align-items:baseline; }
  .xpl-stats strong { font-size:20px; }
  .xpl-stats p { margin:auto 18px; color: var(--vscode-descriptionForeground); font-size:12px; flex:1; min-width:200px; }
  .xpl-layout { display:grid; grid-template-columns: minmax(200px, 240px) minmax(0, 1fr) minmax(220px, 280px); gap:14px; align-items:start; }
  .xpl-rail, .xpl-inspector, .xpl-card { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:12px; background: var(--vscode-editor-background); }
  .xpl-center { display:flex; flex-direction:column; gap:14px; min-width:0; }
  .xpl-rail-head, .xpl-card-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; }
  .xpl-rail h2, .xpl-card h2, .xpl-inspector h2 { font-size:15px; margin:0; }
  .xpl-rail-section { margin-top:16px !important; font-size:12px !important; text-transform:uppercase; letter-spacing:.06em; }
  .xpl-search-label { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.06em; margin:12px 0 4px; }
  #xpl-search { width:100%; box-sizing:border-box; }
  .xpl-files, .xpl-attention-list { list-style:none; margin:8px 0 0; padding:0; display:flex; flex-direction:column; gap:4px; }
  .xpl-file, .xpl-attention { width:100%; text-align:left; display:flex; gap:8px; background:transparent; color:inherit; border:1px solid transparent; border-radius:6px; padding:6px; cursor:pointer; }
  .xpl-file:hover, .xpl-attention:hover { border-color: var(--vscode-panel-border); }
  .xpl-attention { flex-direction:column; align-items:flex-start; gap:2px; font-size:12px; }
  .xpl-file { align-items:flex-start; justify-content:flex-start; }
  .xpl-attention-blocker strong { color: var(--vscode-errorForeground); }
  .xpl-op { font-weight:600; color: var(--vscode-textLink-foreground); min-width:12px; }
  .xpl-sub { display:block; font-size:11px; color: var(--vscode-descriptionForeground); }
  .xpl-eyebrow { display:block; font-size:10px; text-transform:uppercase; letter-spacing:.07em; color: var(--vscode-descriptionForeground); margin:0; }
  .xpl-note { font-size:12px; color: var(--vscode-descriptionForeground); }
  .xpl-empty { font-size:12px; color: var(--vscode-descriptionForeground); font-style:italic; }
  .xpl-views { display:flex; gap:4px; }
  .xpl-views button { background:transparent; color:inherit; border:1px solid transparent; border-radius:6px; padding:4px 10px; cursor:pointer; }
  .xpl-views button[aria-selected="true"] { border-color: var(--vscode-focusBorder); }
  .xpl-map { position:relative; display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:28px; padding:6px 0; }
  .xpl-column, .xpl-column-wrap { display:flex; flex-direction:column; gap:10px; position:relative; z-index:1; min-width:0; }
  .xpl-column h3 { font-size:11px; text-transform:uppercase; letter-spacing:.07em; margin:0; color: var(--vscode-descriptionForeground); }
  .xpl-node { text-align:left; display:flex; flex-direction:column; align-items:flex-start; justify-content:flex-start; gap:2px; border:1px solid var(--vscode-panel-border); border-radius:8px; padding:8px 10px; background: var(--vscode-editor-background); color:inherit; cursor:pointer; min-width:0; overflow-wrap:anywhere; }
  .xpl-node strong { font-size:13px; }
  .xpl-node.xpl-gap { border-style:dashed; }
  .xpl-node.xpl-selected, .xpl-file.xpl-selected, .xpl-attention.xpl-selected { outline:2px solid var(--vscode-focusBorder); outline-offset:1px; }
  .xpl-node.xpl-related { border-color: var(--vscode-focusBorder); }
  .xpl-node.xpl-dimmed { opacity:.55; }
  .xpl-also { border:1px solid var(--vscode-panel-border); border-radius:8px; padding:8px; }
  .xpl-also h4 { margin:0; font-size:12px; }
  .xpl-also-list { display:flex; flex-direction:column; gap:6px; margin-top:6px; }
  .xpl-cluster summary { cursor:pointer; font-size:12px; }
  .xpl-edges { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:0; overflow:visible; }
  .xpl-edges path { fill:none; stroke: var(--vscode-descriptionForeground); stroke-width:1.5; }
  .xpl-edges .xpl-edge-region { stroke-dasharray:6 4; }
  .xpl-edges .xpl-edge-proposed { stroke-dasharray:2 3; }
  .xpl-edges .xpl-edge-diagnostic { stroke-dasharray:4 4; stroke: var(--vscode-editorWarning-foreground, currentColor); }
  .xpl-edges .xpl-edge-citation { stroke: var(--vscode-textLink-foreground, currentColor); }
  .xpl-edges .xpl-edge-active { stroke: var(--vscode-focusBorder); stroke-width:2.5; }
  .xpl-edge-labels { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; z-index:2; overflow:visible; }
  .xpl-edge-labels rect { fill: var(--vscode-editor-background); stroke: var(--vscode-focusBorder); stroke-width:1; }
  .xpl-edge-labels text { font-size:10px; fill: var(--vscode-foreground); }
  /* Explorer items are buttons for keyboard reach, not actions: they never take the page's filled
     action styling on hover, and a selection stays readable in every theme. */
  .xpl button.xpl-node, .xpl button.xpl-file, .xpl button.xpl-attention, .xpl .xpl-views button { font-weight:inherit; font-size:inherit; min-height:0; box-shadow:none; }
  .xpl button.xpl-file:hover:not(:disabled), .xpl button.xpl-attention:hover:not(:disabled), .xpl .xpl-views button:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, transparent); color:inherit; box-shadow:none; }
  .xpl button.xpl-node:hover:not(:disabled) { background: var(--vscode-editor-background); color:inherit; border-color: var(--vscode-focusBorder); box-shadow:none; }
  .xpl button.xpl-file.xpl-selected, .xpl button.xpl-attention.xpl-selected { background: var(--vscode-list-inactiveSelectionBackground, transparent); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
  .xpl-legend { font-size:11px; color: var(--vscode-descriptionForeground); display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .xpl-key { display:inline-block; width:22px; height:0; border-top:2px solid var(--vscode-descriptionForeground); vertical-align:middle; }
  .xpl-key-region { border-top-style:dashed; }
  .xpl-key-proposed { border-top-style:dotted; }
  .xpl-key-diagnostic { border-top-style:dashed; border-top-color: var(--vscode-editorWarning-foreground, currentColor); }
  .xpl-key-citation { border-top-color: var(--vscode-textLink-foreground, currentColor); }
  .xpl-sr-edges, .xpl-sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .xpl-diff-actions { display:flex; gap:6px; flex-wrap:wrap; }
  .xpl-diff-head { display:flex; justify-content:space-between; margin:8px 0; }
  .xpl-diff { width:100%; border-collapse:collapse; table-layout:fixed; font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); }
  .xpl-diff th { text-align:left; font-weight:600; font-size:11px; padding:4px; border-bottom:1px solid var(--vscode-panel-border); }
  .xpl-diff td { padding:1px 4px; vertical-align:top; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
  .xpl-diff .xpl-ln-col { width:44px; }
  .xpl-diff .xpl-ln { text-align:right; color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground)); user-select:none; }
  .xpl-diff .xpl-removed { background: var(--vscode-diffEditor-removedTextBackground, transparent); }
  .xpl-diff .xpl-added { background: var(--vscode-diffEditor-insertedTextBackground, transparent); }
  .xpl-mark { display:inline-block; width:12px; user-select:none; }
  .xpl-pane h3 { margin:4px 0 8px; font-size:17px; }
  .xpl-pane h4 { margin:12px 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color: var(--vscode-descriptionForeground); }
  .xpl-statements, .xpl-pane ul { margin:0; padding-left:18px; }
  .xpl-cites code { font-size:10px; }
  .xpl-limit { border:1px solid var(--vscode-panel-border); border-left:3px solid var(--vscode-editorWarning-foreground, var(--vscode-focusBorder)); border-radius:6px; padding:6px 10px; margin-top:12px; }
  .xpl-inspector-actions { margin-top:12px; }
  .xpl-footer { display:flex; justify-content:space-between; flex-wrap:wrap; gap:8px; font-size:12px; color: var(--vscode-descriptionForeground); border-top:1px solid var(--vscode-panel-border); padding-top:8px; }
  .xpl-table { width:100%; border-collapse:collapse; font-size:12px; }
  .xpl-table caption { text-align:left; font-size:11px; color: var(--vscode-descriptionForeground); padding-bottom:4px; }
  .xpl-table th, .xpl-table td { text-align:left; border-bottom:1px solid var(--vscode-panel-border); padding:4px 6px; vertical-align:top; }
  @media (max-width: 1100px) { .xpl-layout { grid-template-columns: minmax(180px, 220px) minmax(0, 1fr); } .xpl-inspector { grid-column: 1 / -1; } }
  @media (max-width: 760px) { .xpl-layout { grid-template-columns: 1fr; } .xpl-map { grid-template-columns: 1fr; } .xpl-edges, .xpl-edge-labels { display:none; } }
  @media (prefers-reduced-motion: reduce) { .xpl * { transition:none !important; animation:none !important; } }
`;

/**
 * Page script. It only toggles visibility and highlight classes, draws edges between elements that
 * already exist, and posts closed messages carrying the explanation-set and unit digests.
 */
export const EXPLORER_SCRIPT = `
  const root = document.getElementById('xpl-root');
  if (root) {
    const vscode = window.__sfVscode;
    const set = root.dataset.set;
    let units = [];
    try { units = JSON.parse(root.dataset.units || '[]'); } catch { units = []; }
    const map = document.getElementById('xpl-map');
    let edges = [];
    try { edges = JSON.parse((map && map.dataset.edges) || '[]'); } catch { edges = []; }
    const state = Object.assign({ selected: '', unit: root.dataset.firstUnit || '', view: 'map' }, (vscode.getState && vscode.getState()) || {});
    if (state.set !== set) { state.selected = ''; state.unit = root.dataset.firstUnit || ''; }
    state.set = set;
    // A menu asked for one file or change. Every render of this snapshot repeats the request, and
    // the page applies each one once, over the remembered selection; an empty node clears the
    // selection to show every change. Once applied, its note is not shown again.
    const focusId = root.dataset.focusId || '';
    const applied = Boolean(focusId && state.focusId !== focusId);
    if (applied) {
      state.focusId = focusId;
      state.selected = root.dataset.focusNode || '';
      if (root.dataset.focusUnit) state.unit = root.dataset.focusUnit;
      state.view = 'map';
    } else if (focusId) {
      const note = document.getElementById('xpl-focus-notice');
      if (note) note.hidden = true;
    }
    let request = 0;
    const save = () => { if (vscode.setState) vscode.setState(state); };
    const nodeElements = () => Array.from(document.querySelectorAll('.xpl-map .xpl-node'));
    // A member of a closed cluster is laid out by some engines but never shown: it is not an
    // endpoint to draw to or a place for the keyboard to land.
    const shown = (element) => element.offsetParent !== null && !element.closest('details:not([open])');
    const related = (nodeId) => {
      const ids = new Set([nodeId]);
      for (const edge of edges) {
        if (edge.fromNode === nodeId) ids.add(edge.toNode);
        if (edge.toNode === nodeId) ids.add(edge.fromNode);
      }
      return ids;
    };
    const svg = document.querySelector('.xpl-edges');
    const labels = document.querySelector('.xpl-edge-labels');
    const drawEdges = () => {
      if (!svg || !map || map.offsetParent === null) return;
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      while (labels && labels.firstChild) labels.removeChild(labels.firstChild);
      const base = map.getBoundingClientRect();
      const selected = state.selected;
      const limit = Number(map.dataset.edgeLimit) || 80;
      const touches = (edge) => Boolean(selected) && (edge.fromNode === selected || edge.toNode === selected);
      // The selected item's edges first, then the rest in view order, never more than the limit.
      const ordered = edges.filter(touches).concat(edges.filter((edge) => !touches(edge)));
      let drawn = 0;
      let skipped = 0;
      for (const edge of ordered) {
        const from = document.getElementById(edge.from);
        const to = document.getElementById(edge.to);
        if (!from || !to || !shown(from) || !shown(to)) continue;
        if (drawn >= limit) { skipped += 1; continue; }
        drawn += 1;
        const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
        // Two cards of one column (a clause citing a clause) are joined by an arc along their right
        // edges, so the line never crosses either card.
        const sameColumn = Math.abs(a.left - b.left) < 2;
        const leftFirst = a.left <= b.left;
        const x1 = (sameColumn || leftFirst ? a.right : a.left) - base.left, y1 = a.top + a.height / 2 - base.top;
        const x2 = (leftFirst && !sameColumn ? b.left : b.right) - base.left, y2 = b.top + b.height / 2 - base.top;
        const mid = sameColumn ? Math.max(x1, x2) + 28 : (x1 + x2) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2);
        path.setAttribute('class', 'xpl-edge-' + edge.style + (selected && (edge.fromNode === selected || edge.toNode === selected) ? ' xpl-edge-active' : ''));
        svg.appendChild(path);
        // Labels only for the selected item's edges, on their own layer above the cards with a
        // theme background so they stay legible; the legend explains every line style.
        if (!labels || !(selected && (edge.fromNode === selected || edge.toNode === selected))) continue;
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', String(mid));
        label.setAttribute('y', String((y1 + y2) / 2));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'middle');
        label.textContent = edge.label;
        group.appendChild(box);
        group.appendChild(label);
        labels.appendChild(group);
        const bounds = label.getBBox();
        box.setAttribute('x', String(bounds.x - 4));
        box.setAttribute('y', String(bounds.y - 2));
        box.setAttribute('width', String(bounds.width + 8));
        box.setAttribute('height', String(bounds.height + 4));
        box.setAttribute('rx', '3');
      }
      const note = document.getElementById('xpl-edge-note');
      if (note) {
        note.hidden = skipped === 0;
        note.textContent = skipped ? skipped + ' more visible relationships are not drawn; the Relationships view lists every one.' : '';
      }
    };
    const showPane = (nodeId) => {
      let shown = false;
      for (const pane of document.querySelectorAll('[data-pane]')) {
        const match = pane.dataset.pane === nodeId;
        pane.hidden = !match;
        if (match) shown = true;
      }
      if (!shown) { const fallback = document.querySelector('[data-pane=""]'); if (fallback) fallback.hidden = false; }
    };
    const showUnit = (unitId) => {
      if (!unitId) return;
      state.unit = unitId;
      for (const pane of document.querySelectorAll('[data-unit-pane]')) pane.hidden = pane.dataset.unitPane !== unitId;
      save();
    };
    const select = (nodeId, { focus = false, scroll = true } = {}) => {
      state.selected = nodeId || '';
      const ids = nodeId ? related(nodeId) : null;
      for (const element of document.querySelectorAll('[data-node]')) {
        const id = element.dataset.node;
        element.classList.toggle('xpl-selected', id === nodeId);
        if (element.classList.contains('xpl-node')) {
          element.classList.toggle('xpl-related', Boolean(ids && ids.has(id) && id !== nodeId));
          element.classList.toggle('xpl-dimmed', Boolean(ids && !ids.has(id)));
        }
      }
      showPane(nodeId);
      // Follow the selection to exact code: the item's own unit, else the first unit of a file it
      // is related to by a recorded relationship. No file is chosen when none is related.
      const own = (id) => units.find((entry) => entry.nodeId === id || entry.fileId === id);
      const unit = own(nodeId) || (ids ? [...ids].map(own).find(Boolean) : null);
      if (unit && !units.some((entry) => entry.unitId === state.unit && entry.fileId === unit.fileId)) showUnit(unit.unitId);
      drawEdges();
      save();
      if (focus) {
        const target = document.querySelector('.xpl-map [data-node="' + CSS.escape(nodeId) + '"]') || document.querySelector('[data-node="' + CSS.escape(nodeId) + '"]');
        // A selected member of a folded cluster is unfolded, so focus lands on something visible.
        const cluster = target && target.closest('details:not([open])');
        if (cluster) { cluster.open = true; drawEdges(); }
        if (target) target.focus({ preventScroll: !scroll });
      }
    };
    // Every message names this exact render (session), a fresh request number and the digests it
    // acts on; the host refuses anything else rather than guessing [XPL2-AC-053].
    const session = root.dataset.session;
    const post = (type, extra = {}) => {
      const unit = units.find((entry) => entry.unitId === state.unit);
      vscode.postMessage(Object.assign({ type, set, session, request: ++request, unit: unit ? unit.digest : null }, extra));
    };
    const setView = (view) => {
      state.view = view;
      for (const tab of document.querySelectorAll('[data-view]')) {
        const active = tab.dataset.view === view;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      }
      for (const name of ['map', 'relationships', 'timeline']) {
        const panel = document.getElementById('xpl-panel-' + name);
        if (panel) panel.hidden = name !== view;
      }
      save();
      drawEdges();
    };
    root.addEventListener('click', (event) => {
      const target = event.target.closest('button, [data-node]');
      if (!target) return;
      if (target.dataset.view) return setView(target.dataset.view);
      if (target.dataset.unit) { showUnit(target.dataset.unit); return; }
      if (target.dataset.step) {
        const index = units.findIndex((entry) => entry.unitId === state.unit);
        const next = units[(index + Number(target.dataset.step) + units.length) % units.length];
        if (next) { showUnit(next.unitId); select(next.fileId); }
        return;
      }
      if (target.hasAttribute('data-next-attention')) {
        const items = Array.from(document.querySelectorAll('[data-attention]'));
        if (!items.length) return;
        const index = items.findIndex((item) => item.classList.contains('xpl-selected'));
        const next = items[(index + 1) % items.length];
        const about = next.dataset.node;
        for (const item of items) item.classList.toggle('xpl-selected', item === next);
        const unit = units.find((entry) => entry.nodeId === about);
        if (unit) { showUnit(unit.unitId); select(unit.fileId); }
        else select(about);
        next.classList.add('xpl-selected');
        next.focus();
        return;
      }
      if (target.dataset.message === 'explorer-open-diff' || target.dataset.message === 'explorer-open-file' || target.dataset.message === 'explorer-copy') {
        return post(target.dataset.message);
      }
      if (target.dataset.node) {
        const unit = units.find((entry) => entry.nodeId === target.dataset.node);
        if (unit) { showUnit(unit.unitId); return select(unit.fileId); }
        return select(target.dataset.node);
      }
    });
    root.addEventListener('keydown', (event) => {
      const current = event.target.closest && event.target.closest('.xpl-map .xpl-node');
      if (current && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const all = nodeElements().filter(shown);
        const column = current.dataset.column;
        const order = ['intent', 'code', 'results'];
        let target = null;
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const peers = all.filter((node) => node.dataset.column === column);
          const index = peers.indexOf(current);
          target = peers[index + (event.key === 'ArrowDown' ? 1 : -1)] || null;
        } else {
          const nextColumn = order[order.indexOf(column) + (event.key === 'ArrowRight' ? 1 : -1)];
          target = all.find((node) => node.dataset.column === nextColumn) || null;
        }
        if (target) { event.preventDefault(); target.focus(); }
      }
      const tab = event.target.closest && event.target.closest('[data-view]');
      if (tab && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const tabs = Array.from(document.querySelectorAll('[data-view]'));
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        event.preventDefault();
        setView(next.dataset.view);
        next.focus();
      }
    });
    const search = document.getElementById('xpl-search');
    if (search) search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      let hidden = 0;
      for (const item of document.querySelectorAll('#xpl-files li')) {
        const match = !query || item.dataset.path.includes(query);
        item.hidden = !match;
        if (!match) hidden += 1;
      }
      const note = document.getElementById('xpl-filter-note');
      if (note) note.hidden = hidden === 0;
    });
    const audience = document.getElementById('xpl-audience');
    if (audience) audience.addEventListener('change', () => post('explorer-audience', { audience: audience.value }));
    if (typeof ResizeObserver === 'function' && map) new ResizeObserver(() => drawEdges()).observe(map);
    setView(state.view || 'map');
    showUnit(state.unit || root.dataset.firstUnit);
    select(state.selected || '', { focus: Boolean(state.selected), scroll: !applied });
    // A request just applied brings its note, the inventory and the map into view together,
    // rather than scrolling to the map node and leaving the note above the fold.
    if (applied) {
      const anchor = document.getElementById('xpl-focus-notice') || document.querySelector('.xpl-layout');
      if (anchor) anchor.scrollIntoView({ block: 'start' });
    }
  }
`;

/** Closed messages the Change Explorer may post; anything else is ignored by the host. */
export const EXPLORER_MESSAGES = Object.freeze(['explorer-open-diff', 'explorer-open-file', 'explorer-copy', 'explorer-audience'] as const);

/**
 * Resolve an explorer message against the exact view on screen. A message from an older snapshot,
 * or naming a unit digest the view does not contain, resolves to null and is refused visibly.
 */
/**
 * Accept one explorer request only from the page render that is on screen, with a request number
 * higher than any accepted before for that render. Returns the next high-water mark, or null.
 */
export function acceptExplorerRequest(session: string | null, highWater: number, message: Record<string, unknown>): number | null {
  if (!session || message.session !== session) return null;
  const request = message.request;
  if (typeof request !== 'number' || !Number.isSafeInteger(request) || request <= highWater) return null;
  return request;
}

export function resolveExplorerUnit(view: Xpl2Explanation | null, set: unknown, unitDigest: unknown): Xpl2Unit | null {
  if (!view || typeof set !== 'string' || set !== view.explanationSetSha256) return null;
  if (typeof unitDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(unitDigest)) return null;
  return view.inventory.units.find((unit) => unit.explanationUnitSha256 === unitDigest) ?? null;
}
