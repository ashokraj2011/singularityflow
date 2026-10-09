/**
 * Code Explainer model: the pure half of the source and change explainer.
 *
 * The panel host harvests facts — the Story's captured change (the XPL2 `change` view and its
 * bounded patch), the working files' text, and what the editor's own language services answer
 * about symbols, calls, references and signatures — and this module turns them into one model the
 * page draws. Nothing here reads a file, runs a command or asks a model. Every number is counted
 * from those facts, and every sentence says where it came from and what it does not prove: a call
 * edge is what the language service reported, a test reference is a name in a test file (not
 * coverage), and a requirement link is the change region's association (not proof that a given
 * function implements it). Complexity is estimated from the symbol's own text and says so.
 */

import type { CxLenses } from './code-explainer-lenses.ts';

export const CX_SCHEMA = 1;

/** Bounds that keep one build interactive on a large change. The host enforces the request ones. */
export const CX_LIMITS = Object.freeze({
  changedFiles: 40,
  modules: 48,
  symbolsPerFile: 200,
  symbols: 240,
  rowsPerModule: 12,
  diffLinesPerSymbol: 120,
  callRequests: 120,
  referenceRequests: 40,
  hoverRequests: 40,
  maxDepth: 3,
  otherFiles: 60,
  // The full view maps the worktree's own code, so it reads more files and asks more questions;
  // still bounded, and every bound that is reached is named on the canvas.
  fullFiles: 60,
  // A folder the reader chose is mapped more deeply than the whole worktree at once.
  scopedFiles: 150,
  // The worktree listing used when the repository is too large for the CLI to list every file.
  listedFiles: 5000,
  fullSeeds: 100,
  fullCallRequests: 360
});

/** VS Code's SymbolKind numbers, which the language services answer with. */
export const SYMBOL_KIND = Object.freeze({
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6, Field: 7,
  Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14,
  Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21, Struct: 22,
  Event: 23, Operator: 24, TypeParameter: 25
});

const CALLABLE_KINDS = new Set<number>([SYMBOL_KIND.Method, SYMBOL_KIND.Constructor, SYMBOL_KIND.Function]);
const CONTAINER_KINDS = new Set<number>([
  SYMBOL_KIND.Class, SYMBOL_KIND.Interface, SYMBOL_KIND.Struct, SYMBOL_KIND.Module,
  SYMBOL_KIND.Namespace, SYMBOL_KIND.Package, SYMBOL_KIND.Enum, SYMBOL_KIND.Object
]);
/** Variables, constants and properties count as callables only when their text defines a function. */
const MAYBE_CALLABLE_KINDS = new Set<number>([SYMBOL_KIND.Variable, SYMBOL_KIND.Constant, SYMBOL_KIND.Property, SYMBOL_KIND.Field]);

export type CxRole = 'changed' | 'focus' | 'repository' | 'caller' | 'callee' | 'test' | 'context' | 'external' | 'other';

/** Delta draws what the Story changed and what it touches; full maps the current worktree's code. */
export type CxView = 'delta' | 'full';
export type CxStatus = 'added' | 'modified' | 'removed' | 'unchanged';
export type CxSymbolKind = 'function' | 'method' | 'constructor' | 'class' | 'variable' | 'module-scope' | 'removed' | 'file';

export interface CxRange { start: number; end: number }
export interface CxPoint { line: number; character: number }

/** A symbol as a language service reported it, with 1-based lines. */
export interface CxRawSymbol {
  name: string;
  detail?: string | null;
  kind: number;
  range: CxRange;
  selection: CxPoint;
  container?: string | null;
  children?: CxRawSymbol[] | null;
}

/** A file the host read: its text, and the symbols its language service gave (null: none asked or none answered). */
export interface CxFileInput {
  path: string;
  language: string;
  lines: string[] | null;
  symbols: CxRawSymbol[] | null;
  symbolReason?: string | null;
  external?: boolean;
  label?: string | null;
}

/** One side of a call as the call hierarchy reported it. */
export interface CxCallEnd {
  path: string;
  name: string;
  kind: number;
  range: CxRange;
  selection: CxPoint;
  detail?: string | null;
}

/** One reported call; `positions` are its call sites with columns, when the service gave them. */
export interface CxCallInput { from: CxCallEnd; to: CxCallEnd; sites: number[]; positions?: CxPoint[] }

/** Where a symbol's calls came from: the editor's call hierarchy, or Singularity Flow's analysis of the code. */
export type CxCallStatus = 'complete' | 'analysis' | 'unavailable' | 'not-requested';

/** One end of a call Singularity Flow found in the committed code (`wm knowledge calls`). */
export interface CxAnalysisEnd { file: string; name: string; qualifiedName?: string | null; kind: string; line: number; start: number; end: number }
export interface CxAnalysisCall { from: CxAnalysisEnd; to: CxAnalysisEnd; line: number | null; how: 'by-name' | 'resolved' }

const ANALYSIS_KIND: Record<string, number> = { method: SYMBOL_KIND.Method, constructor: SYMBOL_KIND.Constructor, class: SYMBOL_KIND.Class, function: SYMBOL_KIND.Function };

/**
 * Calls from Singularity Flow's analysis as call-hierarchy calls, for files whose language gave none
 * (Java without its language server in Standard mode, for one). Each end becomes the innermost
 * outline symbol of its file that contains its line, so it lands on the card the outline drew; in a
 * file with no outline it keeps the analysis's own name and lines. Only calls that touch a file
 * `wanted` accepts are kept.
 */
export function analysisCalls(edges: CxAnalysisCall[], files: Iterable<CxFileInput>, wanted: (path: string) => boolean): CxCallInput[] {
  const outlines = new Map<string, CxRawSymbol[]>();
  const flatten = (entries: CxRawSymbol[], into: CxRawSymbol[]) => {
    for (const entry of entries) { into.push(entry); if (entry.children?.length) flatten(entry.children, into); }
    return into;
  };
  for (const file of files) if (file.symbols?.length) outlines.set(file.path, flatten(file.symbols, []));
  const endOf = (end: CxAnalysisEnd): CxCallEnd => {
    const inside = (outlines.get(end.file) ?? []).filter((entry) => CALLABLE_KINDS.has(entry.kind)
      && entry.range.start <= end.line && end.line <= entry.range.end);
    const owner = inside.sort((a, b) => (a.range.end - a.range.start) - (b.range.end - b.range.start))[0];
    if (owner) return { path: end.file, name: owner.name, kind: owner.kind, detail: owner.detail ?? null, range: owner.range, selection: owner.selection };
    return { path: end.file, name: end.name, kind: ANALYSIS_KIND[end.kind] ?? SYMBOL_KIND.Function, detail: null,
      range: { start: end.start, end: end.end }, selection: { line: end.line, character: 0 } };
  };
  return edges.filter((edge) => wanted(edge.from.file) || wanted(edge.to.file)).map((edge) => ({
    from: endOf(edge.from), to: endOf(edge.to), sites: [edge.line ?? edge.from.line]
  }));
}

export interface CxDiffLine { k: '+' | '-' | ' '; a: number | null; b: number | null; t: string }
export interface CxDiffHunk { header: string; beforeStart: number; afterStart: number; lines: CxDiffLine[] }

/** One XPL2 change view, kept to the fields this model reads. */
export interface CxChangeView {
  snapshot?: { baseline?: { revision?: string | null } | null; workId?: string | null; phase?: string | null } | null;
  nodes: Array<{ id: string; kind: string; label: string; status: string | null; detail?: Record<string, unknown> | null }>;
  relationships: Array<{ id?: string; type: string; from: string; to: string; granularity?: string; scope?: string; qualifier?: string | null }>;
  statements: Array<{ id: string; kind: string; about: string; text: string; arguments?: Record<string, unknown> }>;
  attention: Array<{ id: string; category: string; about: string; reason: string; statement: string }>;
  inventory: {
    files: Array<{ fileId: string; path: string; pathBefore: string | null; pathAfter: string | null; operation: string; unitIds: string[]; hunks: number; opaque: number; roles?: string[]; sources?: { before?: string; after?: string } }>;
    units: Array<{ unitId: string; fileId: string; path: string; pathBefore: string | null; pathAfter: string | null; operation: string; hunk: { hunkId: string; header: string; before: { start: number; lines: number }; after: { start: number; lines: number } } | null; opaqueReason?: string | null; opacity?: { reason: string } | null }>;
    counts?: Record<string, number>;
  };
}

export interface CxPatchFile {
  pathBefore: string | null;
  pathAfter: string | null;
  patchStart: number;
  patchEnd: number;
  operation?: string;
}

export interface CxStoryInput {
  workId: string;
  title?: string | null;
  branch?: string | null;
  currentPhase: string | null;
  phaseOrder: string[];
  phases: Record<string, { label?: string; status?: string; generation?: number }>;
  approval?: { phase: string; minimum: number; distinct: number; remainingAuthorities: string[]; met: boolean } | null;
  /** The readiness gate count the status bar shows, from the same derivation; never recounted here. */
  gates?: { met: number; total: number; unmet: number; outstanding: number } | null;
}

export interface CxBuildInput {
  repository: { name: string; branch: string | null; head: string | null };
  story: CxStoryInput | null;
  change: {
    view: CxChangeView | null;
    unavailableReason?: string | null;
    patch: string | null;
    patchFiles: CxPatchFile[];
    base: string | null;
    /** Line diffs the host computed from exact sources for files the bounded patch does not cover. */
    computed?: Record<string, CxDiffHunk[]>;
  };
  files: CxFileInput[];
  calls: CxCallInput[];
  /** Per symbol key: whether its call hierarchy answered (`complete`), failed or was not asked, or its calls came from Singularity Flow's analysis (`analysis`). */
  callStatus: Record<string, CxCallStatus>;
  references: Array<{ symbol: string; path: string; line: number }>;
  referenceStatus: Record<string, 'complete' | 'unavailable' | 'not-requested'>;
  hovers: Record<string, { signature: string | null; doc: string | null }>;
  focus: { path: string; line: number | null } | null;
  depth: number;
  /** Absent means delta, the view this explainer always drew. */
  view?: CxView;
  /** The folders the full view can be limited to, and the one chosen (an index), if any. */
  areas?: CxArea[];
  scope?: number | null;
  modelEnabled: boolean;
  notes?: string[];
  truncated?: string[];
  durationMs?: number | null;
  status?: 'pending' | 'complete' | 'partial';
}

/** A run of explanation text; `sym`/`mod` segments are links the page can follow. */
export type CxSegment = { t: string } | { code: string } | { sym: string; t: string } | { mod: string; t: string };

export interface CxMetrics {
  lines: number;
  complexity: number;
  decisions: number;
  breakdown: Record<string, number>;
  band: 'simple' | 'moderate' | 'complex' | 'very complex';
  params: number | null;
  nesting: number;
}

export interface CxSymbol {
  id: string;
  key: string;
  moduleId: string;
  /** The repository file it lives in; null outside the repository. */
  file: string | null;
  name: string;
  qualifiedName: string;
  kind: CxSymbolKind;
  start: number | null;
  end: number | null;
  line: number | null;
  status: CxStatus;
  role: CxRole;
  depth: number | null;
  primary: boolean;
  added: number;
  removed: number;
  /** How many hunks touch it. */
  hunks: number;
  units: string[];
  diff: CxDiffLine[];
  diffTruncated: boolean;
  signature: string | null;
  signatureSource: 'language-service' | 'declaration' | null;
  doc: string | null;
  metrics: CxMetrics | null;
  callers: string[];
  callees: string[];
  callStatus: CxCallStatus;
  tests: Array<{ path: string; line: number; symbolId: string | null }>;
  testStatus: 'complete' | 'unavailable' | 'not-requested';
  clauses: string[];
  /** `@clause` tags in its own lines (its leading comment block included): the author's declaration. */
  tags: CxClauseTag[];
  explanation: CxSegment[][];
}

/** A `@clause` comment in changed code, as the change view read it. */
export interface CxClauseTag { clause: string; line: number; note: string | null; added: boolean }

export interface CxModule {
  id: string;
  path: string;
  name: string;
  dir: string;
  language: string;
  role: CxRole;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unchanged' | 'external';
  added: number;
  removed: number;
  symbolIds: string[];
  clauses: string[];
  /** Clauses a `@clause` comment in this file names. */
  tagged: string[];
  units: string[];
  external: boolean;
  label: string | null;
  /** Where its outline came from: the editor's language service, the file's own text, or nowhere. */
  symbolSource: 'language-service' | 'text' | 'none';
  symbolReason: string | null;
  opaque: string | null;
  /** An exact before/after pair is captured, so a native diff can open. */
  diffable: boolean;
  /** A card that gathers whole files without symbols (documents, configuration, Story records). */
  group: boolean;
  /** Drawn folded until a person opens it. */
  collapsed: boolean;
}

export interface CxEdge { id: string; from: string; to: string; sites: number[]; at?: CxPoint[] }

export interface CxTrace {
  available: boolean;
  reason: string | null;
  requirements: Array<{
    id: string; label: string; text: string | null; status: 'tagged' | 'untagged' | 'declared'; modules: string[]; tests: string[]; gap: string | null;
    /** Files whose `@clause` comment names it, with the author's note; a subset of `modules`. */
    declaredIn: string[]; notes: Array<{ path: string; line: number; note: string }>;
    /** Clauses its specification text names, and those whose text names it. */
    cites: string[]; citedBy: string[];
  }>;
  code: Array<{ moduleId: string; symbols: string[] }>;
  tests: Array<{ id: string; path: string; requirements: string[]; symbols: string[]; inChange: boolean; source: 'declared-tag' | 'reference' | 'both' }>;
  runs: Array<{ id: string; label: string; status: string }>;
  counts: { requirements: number; tagged: number; declared: number; gaps: number; tests: number; runs: number; passed: number; failed: number };
}

export interface CxModel {
  schema: number;
  id: string;
  mode: 'change' | 'source';
  view: CxView;
  /** The folders the full view can be limited to; `selected` is an index into `list`, or null for the whole worktree. */
  areas: { list: CxArea[]; selected: number | null };
  repository: { name: string; branch: string | null; head: string | null; base: string | null };
  story: null | {
    workId: string; title: string | null; phase: string | null; phaseLabel: string | null; phaseStatus: string | null;
    /** Where the current phase sits in the workflow, and how many phases are approved or skipped. */
    phases: { index: number | null; total: number; decided: number };
    gates: { met: number; total: number; unmet: number; outstanding: number } | null;
    approval: { met: boolean; distinct: number; minimum: number; remaining: string[] } | null;
  };
  change: { status: 'available' | 'unavailable' | 'empty'; reason: string | null; files: number; codeFiles: number; symbols: number; added: number; removed: number };
  modules: CxModule[];
  symbols: CxSymbol[];
  edges: CxEdge[];
  trace: CxTrace;
  walkthrough: string[];
  /** What the change view could not explain, grouped by kind and reason with one example each. */
  attention: Array<{ category: string; label: string; reason: string; count: number; text: string }>;
  intelligence: {
    status: 'pending' | 'complete' | 'partial';
    languages: Array<{ language: string; files: number; symbols: 'language-service' | 'text' | 'none'; calls: 'available' | 'analysis' | 'unavailable' | 'not-requested' }>;
    depth: number;
    notes: string[];
    truncated: string[];
    durationMs: number | null;
  };
  focus: string | null;
  /** The symbol at the line a person asked about, when the request found one. */
  requested: string | null;
  modelEnabled: boolean;
  /** The other lenses on the same harvest (concepts, entities, data flow, logic), when the host built them. */
  lenses?: CxLenses;
}

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Controls and bidirectional overrides become visible markers; tabs stay, as in the Change Explorer. */
export function visibleCode(value: unknown): string {
  return String(value ?? '').replace(CONTROL, (character) => character === '\t'
    ? character
    : `[U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`);
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
  py: 'python', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', go: 'go', rb: 'ruby',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', c: 'c', h: 'c', rs: 'rust', php: 'php',
  scala: 'scala', dart: 'dart', m: 'objective-c', mm: 'objective-cpp', groovy: 'groovy', lua: 'lua',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ps1: 'powershell', r: 'r', vue: 'vue', svelte: 'svelte',
  json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', html: 'html', css: 'css', scss: 'scss', xml: 'xml', toml: 'toml', sql: 'sql'
};

const CODE_LANGUAGES = new Set([
  'typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'python', 'java', 'kotlin', 'swift', 'go', 'ruby',
  'csharp', 'cpp', 'c', 'rust', 'php', 'scala', 'dart', 'objective-c', 'objective-cpp', 'groovy', 'lua', 'vue', 'svelte',
  'shellscript', 'powershell', 'r'
]);

const HASH_COMMENT_LANGUAGES = new Set(['python', 'ruby', 'shellscript', 'r', 'powershell']);

/** The editor's language id for a path, by extension; `plaintext` when unknown. */
export function languageOf(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? EXTENSION_LANGUAGES[base.slice(dot + 1)] ?? 'plaintext' : 'plaintext';
}

export function isCodeLanguage(language: string): boolean {
  return CODE_LANGUAGES.has(language);
}

/**
 * Whether a repository path is a test file by the conventions of the common ecosystems. A test
 * file is shown as such; it never makes anything count as covered.
 */
export function isTestPath(file: string): boolean {
  const normal = file.replace(/\\/g, '/');
  const base = normal.slice(normal.lastIndexOf('/') + 1);
  return /(^|\/)(test|tests|__tests__|spec|specs|testing)\//i.test(normal)
    || /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i.test(base)
    || /^test_.+\.py$/i.test(base) || /_test\.(py|go|rb|exs?)$/i.test(base)
    || /(Test|Tests|Spec|IT)\.(java|kt|kts|scala|groovy|cs|swift)$/.test(base);
}

/** Folders that hold Git metadata, Singularity Flow's own records or tool output, never code to explain. */
const HIDDEN_ROOTS = new Set(['.git', 'singularity', '.singularity-flow']);
const HIDDEN_SEGMENTS = new Set(['.git', '.singularity-flow', 'node_modules', '.gradle', '.idea', '.vscode', '__pycache__', '.venv', '.mvn']);
/** Build output a worktree listing (not Git's) can contain. */
export const CX_OUTPUT_FOLDERS = Object.freeze(['target', 'build', 'bin', 'obj', 'out', 'dist']);

/** A repository path in one spelling: forward slashes, no leading `./` or `/`. */
export function repositoryPath(file: string): string {
  return String(file).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

/**
 * Whether a repository-relative path is code this explainer may show. The CLI already leaves
 * Singularity Flow's files out; this holds for every path the panel itself lists too, whichever
 * separator the platform writes.
 */
export function isExplainableRepositoryPath(file: string): boolean {
  const parts = repositoryPath(file).split('/').filter(Boolean);
  if (!parts.length) return false;
  if (HIDDEN_ROOTS.has(parts[0]!.toLowerCase())) return false;
  if (parts[0] === '.github' && parts[1] === 'agents') return false;
  return !parts.slice(0, -1).some((part) => HIDDEN_SEGMENTS.has(part.toLowerCase()));
}

/** One folder of code the full view can be limited to. `own` holds only the files directly inside it. */
export interface CxArea { path: string; files: number; own?: boolean }

interface AreaNode { path: string; files: number; direct: number; children: Map<string, AreaNode> }

/**
 * The folders a reader can choose between, sized so none is much larger than `target` files where
 * the tree allows it. Single-child chains (`src/main/java/com/acme`) collapse into the folder that
 * actually branches, so a Maven or Gradle service is one choice, not seven.
 */
export function codeAreas(paths: readonly string[], { target = CX_LIMITS.fullFiles, maxAreas = 40 } = {}): CxArea[] {
  const root: AreaNode = { path: '', files: 0, direct: 0, children: new Map() };
  for (const file of paths) {
    const parts = repositoryPath(file).split('/').filter(Boolean);
    let node = root;
    node.files += 1;
    for (const part of parts.slice(0, -1)) {
      const next = node.children.get(part) ?? { path: node.path ? `${node.path}/${part}` : part, files: 0, direct: 0, children: new Map() };
      node.children.set(part, next);
      node = next;
      node.files += 1;
    }
    node.direct += 1;
  }
  const collapse = (node: AreaNode): AreaNode => {
    let current = node;
    while (current.direct === 0 && current.children.size === 1) current = [...current.children.values()][0]!;
    return current;
  };
  type Entry = { node: AreaNode; own: boolean };
  let areas: Entry[] = [...root.children.values()].map((node) => ({ node: collapse(node), own: false }));
  if (root.direct) areas.push({ node: { ...root, files: root.direct, children: new Map() }, own: true });
  for (;;) {
    const splittable = areas.filter((entry) => !entry.own && entry.node.files > target && entry.node.children.size >= 2
      && areas.length - 1 + entry.node.children.size + (entry.node.direct ? 1 : 0) <= maxAreas)
      .sort((left, right) => right.node.files - left.node.files)[0];
    if (!splittable) break;
    const node = splittable.node;
    areas = areas.filter((entry) => entry !== splittable);
    areas.push(...[...node.children.values()].map((child) => ({ node: collapse(child), own: false })));
    if (node.direct) areas.push({ node: { ...node, files: node.direct, children: new Map() }, own: true });
  }
  return areas.map(({ node, own }) => (own ? { path: node.path, files: node.files, own: true } : { path: node.path, files: node.files }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

/** Whether a file belongs to an area: anywhere below it, or directly inside it for an `own` area. */
export function inArea(file: string, area: CxArea): boolean {
  const normal = repositoryPath(file);
  const folder = normal.includes('/') ? normal.slice(0, normal.lastIndexOf('/')) : '';
  if (area.own) return folder === area.path;
  return area.path === '' || normal.startsWith(`${area.path}/`);
}

/** The most specific area a file belongs to, or -1. */
export function areaIndex(file: string, areas: readonly CxArea[]): number {
  let best = -1;
  areas.forEach((area, index) => {
    if (inArea(file, area) && (best < 0 || area.path.length > areas[best]!.path.length)) best = index;
  });
  return best;
}

/**
 * Up to `limit` items, taken in turn from each area, so a bound leaves every folder represented
 * instead of keeping the alphabetically first ones and dropping the rest.
 */
export function fairSample<T>(items: readonly T[], keyOf: (item: T) => string, areas: readonly CxArea[], limit: number): T[] {
  if (items.length <= limit) return [...items];
  const queues = new Map<number, T[]>();
  for (const item of items) {
    const index = areaIndex(keyOf(item), areas);
    const queue = queues.get(index) ?? [];
    queue.push(item);
    queues.set(index, queue);
  }
  const order = [...queues.keys()].sort((left, right) => left - right);
  const picked: T[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let any = false;
    for (const index of order) {
      const item = queues.get(index)![round];
      if (item === undefined) continue;
      any = true;
      picked.push(item);
      if (picked.length >= limit) break;
    }
    if (!any) break;
  }
  return picked;
}

/**
 * Blank out strings and comments, keeping every newline and column, so counting keywords and
 * braces only sees code. A string keeps its quote characters, so `x ? "a" : "b"` still reads as a
 * ternary with operands. Template literals are blanked whole; that undercounts decisions inside
 * `${…}`, which the estimate accepts.
 */
export function maskSource(text: string, language: string): string {
  const hash = HASH_COMMENT_LANGUAGES.has(language);
  const python = language === 'python';
  const out: string[] = [];
  let index = 0;
  const length = text.length;
  const blank = (character: string) => (character === '\n' ? '\n' : ' ');
  while (index < length) {
    const character = text[index]!;
    const pair = text.slice(index, index + 2);
    if (!hash && pair === '//') {
      while (index < length && text[index] !== '\n') { out.push(' '); index += 1; }
      continue;
    }
    if (!hash && pair === '/*') {
      const close = text.indexOf('*/', index + 2);
      const stop = close < 0 ? length : close + 2;
      for (; index < stop; index += 1) out.push(blank(text[index]!));
      continue;
    }
    if (hash && character === '#') {
      while (index < length && text[index] !== '\n') { out.push(' '); index += 1; }
      continue;
    }
    if (python && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
      const quote = text.slice(index, index + 3);
      const close = text.indexOf(quote, index + 3);
      const stop = close < 0 ? length : close + 3;
      out.push(quote);
      for (index += 3; index < stop - 3; index += 1) out.push(blank(text[index]!));
      if (close >= 0) { out.push(quote); index = stop; }
      continue;
    }
    if (character === '"' || character === "'" || (character === '`' && !python)) {
      out.push(character);
      index += 1;
      while (index < length) {
        const inner = text[index]!;
        if (inner === '\\') { out.push(' '); if (index + 1 < length) out.push(blank(text[index + 1]!)); index += 2; continue; }
        if (inner === character) { out.push(character); index += 1; break; }
        if (inner === '\n' && character !== '`') { break; }
        out.push(blank(inner));
        index += 1;
      }
      continue;
    }
    out.push(character);
    index += 1;
  }
  return out.join('');
}

const C_LIKE_DECISIONS: Array<[string, RegExp]> = [
  ['if', /\bif\b/g], ['for', /\bfor\b/g], ['while', /\bwhile\b/g], ['case', /\bcase\b/g],
  ['catch', /\bcatch\b/g], ['and', /&&/g], ['or', /\|\|/g], ['nullish', /\?\?(?!=)/g]
];
const PYTHON_DECISIONS: Array<[string, RegExp]> = [
  ['if', /\b(?:if|elif)\b/g], ['for', /\bfor\b/g], ['while', /\bwhile\b/g], ['except', /\bexcept\b/g],
  ['case', /\bcase\b/g], ['and', /\band\b/g], ['or', /\bor\b/g]
];
const RUBY_DECISIONS: Array<[string, RegExp]> = [
  ['if', /\b(?:if|elsif|unless)\b/g], ['for', /\b(?:for|until)\b/g], ['while', /\bwhile\b/g], ['when', /\bwhen\b/g],
  ['rescue', /\brescue\b/g], ['and', /&&|\band\b/g], ['or', /\|\||\bor\b/g]
];

/** McCabe guidance: up to 5 is simple, up to 10 moderate, up to 20 complex. */
export function complexityBand(complexity: number): CxMetrics['band'] {
  return complexity <= 5 ? 'simple' : complexity <= 10 ? 'moderate' : complexity <= 20 ? 'complex' : 'very complex';
}

/**
 * An estimate of cyclomatic complexity: one plus the decision points counted in the symbol's own
 * code (strings and comments removed). It reads text, not a syntax tree, and says so wherever it is
 * shown; nested functions count toward their parent.
 */
export function estimateComplexity(text: string, language: string): { complexity: number; decisions: number; breakdown: Record<string, number> } {
  const masked = maskSource(text, language);
  const patterns = language === 'python' ? PYTHON_DECISIONS : language === 'ruby' ? RUBY_DECISIONS : C_LIKE_DECISIONS;
  const breakdown: Record<string, number> = {};
  let decisions = 0;
  for (const [name, pattern] of patterns) {
    const count = masked.match(pattern)?.length ?? 0;
    if (count) { breakdown[name] = count; decisions += count; }
  }
  if (language !== 'python' && language !== 'ruby') {
    // A ternary `?` is not `?.`, `??`, `?:` (an optional member or parameter) or `?)`/`?,`.
    let ternaries = 0;
    for (let index = masked.indexOf('?'); index >= 0; index = masked.indexOf('?', index + 1)) {
      if (masked[index - 1] === '?' || masked[index + 1] === '?' || masked[index + 1] === '.') continue;
      const next = masked.slice(index + 1).match(/\S/)?.[0];
      if (!next || next === ':' || next === ')' || next === ',' || next === '=' || next === ';' || next === '>') continue;
      ternaries += 1;
    }
    if (ternaries) { breakdown.ternary = ternaries; decisions += ternaries; }
  }
  return { complexity: decisions + 1, decisions, breakdown };
}

/** The deepest block nesting inside the symbol, counted from its own braces or indentation. */
export function nestingDepth(text: string, language: string): number {
  const masked = maskSource(text, language);
  if (language === 'python') {
    const indents = masked.split('\n').filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)?.[0].replace(/\t/g, '    ').length ?? 0);
    if (!indents.length) return 0;
    const base = indents[0]!;
    const steps = [...new Set(indents.filter((value) => value > base))].sort((a, b) => a - b);
    return Math.max(0, steps.length - 1);
  }
  let depth = 0;
  let deepest = 0;
  for (const character of masked) {
    if (character === '{') { depth += 1; deepest = Math.max(deepest, depth); }
    else if (character === '}') depth = Math.max(0, depth - 1);
  }
  return Math.max(0, deepest - 1);
}

/** Parameters in the first parenthesised list of a declaration or signature; null when there is none. */
export function countParameters(signature: string | null): number | null {
  if (!signature) return null;
  const open = signature.indexOf('(');
  if (open < 0) return null;
  let depth = 0;
  let count = 0;
  let sawContent = false;
  for (let index = open; index < signature.length; index += 1) {
    const character = signature[index]!;
    if ('([{<'.includes(character)) { depth += 1; if (depth > 1) sawContent = true; continue; }
    if (')]}>'.includes(character)) {
      if (character === '>' && signature[index - 1] === '=') continue;
      depth -= 1;
      if (depth === 0) return sawContent ? count + 1 : 0;
      continue;
    }
    if (depth === 1 && character === ',') { count += 1; continue; }
    if (depth >= 1 && /\S/.test(character)) sawContent = true;
  }
  return null;
}

/** Parse one file's section of a Git patch into hunks with before/after line numbers per line. */
export function parseFilePatch(section: string): CxDiffHunk[] {
  const hunks: CxDiffHunk[] = [];
  let current: CxDiffHunk | null = null;
  let before = 0;
  let after = 0;
  for (const raw of section.split('\n')) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      before = Number(header[1]);
      after = Number(header[2]);
      current = { header: raw, beforeStart: before, afterStart: after, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const marker = raw[0];
    const text = visibleCode(raw.slice(1));
    if (marker === '+') { current.lines.push({ k: '+', a: after, b: null, t: text }); after += 1; }
    else if (marker === '-') { current.lines.push({ k: '-', a: null, b: before, t: text }); before += 1; }
    else if (marker === ' ') { current.lines.push({ k: ' ', a: after, b: before, t: text }); after += 1; before += 1; }
  }
  return hunks;
}

/** Where a line sits on the after side: its own number, or for a removed line the after line it precedes. */
function anchors(hunk: CxDiffHunk): number[] {
  const result: number[] = [];
  let next = hunk.afterStart;
  for (const line of hunk.lines) {
    if (line.a !== null) { result.push(line.a); next = line.a + 1; }
    else result.push(next);
  }
  return result;
}

/**
 * The name a person reads. Some services put a method's parameter types or return type in its name
 * (`evaluate(Map<String, Object>, JsonNode)`, `testIsNull() : void`); a test case's title in
 * parentheses (`test('adds')`) is kept, since it is the name.
 */
export function displayName(name: string): string {
  const match = name.match(/^\s*([A-Za-z_$][\w$]*)\s*\(([^'"`]*)\)\s*(?::\s*[^()]*)?$/);
  return match ? match[1]! : name;
}

export function symbolKey(file: string, line: number, name: string): string {
  return `${file}:${line}:${name}`;
}

interface FlatSymbol {
  raw: CxRawSymbol;
  qualifiedName: string;
  kind: CxSymbolKind;
  callable: boolean;
  container: boolean;
}

/**
 * Whether a variable, constant or property is bound to a function: what follows its name must be
 * `= function`, `= (…) =>`, `= x =>` or `: (…) =>` (an optional type annotation allowed), not just
 * any line that happens to contain an arrow.
 */
export function looksLikeFunction(lines: string[] | null, symbol: CxRawSymbol): boolean {
  if (!lines) return false;
  const line = lines[symbol.selection.line - 1] ?? '';
  const rest = `${line.slice(symbol.selection.character + symbol.name.length)} ${lines[symbol.selection.line] ?? ''}`;
  // A parameter list that runs over several lines (a component destructuring its props one per
  // line): balance it, then the arrow must follow.
  if (/^\s*(?::\s*[^=;]+?)?\s*=\s*(?:async\s+)?\(/.test(rest)) {
    const text = [line.slice(symbol.selection.character + symbol.name.length), ...lines.slice(symbol.selection.line, symbol.selection.line + 60)].join('\n');
    let depth = 0;
    for (let index = text.indexOf('('); index >= 0 && index < text.length; index += 1) {
      const character = text[index];
      if (character === '(' || character === '[' || character === '{') depth += 1;
      else if (character === ')' || character === ']' || character === '}') {
        depth -= 1;
        if (depth === 0) {
          if (/^\s*(?::\s*[^=;{]+?)?\s*=>/.test(text.slice(index + 1, index + 200))) return true;
          break;
        }
      }
    }
  }
  return /^\s*(?::\s*[^=;]+?)?\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)/.test(rest)
    || /^\s*:\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(rest)
    || /^\s*=\s*lambda\b/.test(rest)
    // A function wrapped in a hook or helper that returns it: `= useCallback((x) => …)`, `= memo(…)`.
    || /^\s*(?::\s*[^=;]+?)?\s*=\s*(?:[\w$]+\s*\.\s*)?(?:useCallback|memo|forwardRef|debounce|throttle)\s*\(/.test(rest);
}

function symbolKindName(raw: CxRawSymbol, callable: boolean, parentKind: number | null): CxSymbolKind {
  if (raw.kind === SYMBOL_KIND.Constructor) return 'constructor';
  if (raw.kind === SYMBOL_KIND.Method) return 'method';
  if (raw.kind === SYMBOL_KIND.Function) return parentKind !== null && CONTAINER_KINDS.has(parentKind) && parentKind !== SYMBOL_KIND.Module && parentKind !== SYMBOL_KIND.Namespace ? 'method' : 'function';
  if (CONTAINER_KINDS.has(raw.kind)) return 'class';
  if (callable) return parentKind !== null && (parentKind === SYMBOL_KIND.Class || parentKind === SYMBOL_KIND.Struct) ? 'method' : 'function';
  return 'variable';
}

const TEXT_CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:(?:public|private|protected|internal|abstract|final|sealed|open|data|static)\s+)*(?:class|interface|struct|enum|trait|object)\s+([A-Za-z_$][\w$]*)/;
const TEXT_METHOD = /^\s*(?:(?:public|private|protected|static|readonly|async|override|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*$/;
/**
 * A typed member in Java or C# with no access modifier: `BigDecimal totalOf(Order order) {`,
 * `void rejectsEmptyOrders() {`. Statements that start with a keyword (`return foo(`) are not declarations.
 */
const TEXT_TYPED_METHOD = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|override|virtual|async|sealed)\s+)*(?:<[^>]+>\s+)?(?!(?:return|new|else|throw|case|await|yield|goto|using|var)\b)[A-Za-z_][\w.]*(?:<[^()]*>)?(?:\[\])*\s+([A-Za-z_]\w*)\s*\([^;]*$/;
const TYPED_MEMBER_LANGUAGES = new Set(['java', 'csharp']);
/** Test cases in the common JavaScript runners: `test('…', …)`, `it(…)`, `describe(…)`. */
const TEXT_TEST = /^\s*((?:test|it|describe|suite|context)(?:\.(?:only|skip|each|concurrent))?)\s*\(\s*(['"`])(.{1,80}?)\2/;

/**
 * An outline read from the file's own text, for a code file no language service answered for:
 * declarations by pattern, extents by matching braces (or indentation for Python and Ruby). It is
 * marked `text` wherever it is shown, and it is only used to say which function a changed line is
 * in; calls and references still need a language service.
 */
export function textSymbols(lines: string[], language: string): CxRawSymbol[] {
  const masked = maskSource(lines.join('\n'), language).split('\n');
  const indentBased = language === 'python' || language === 'ruby';
  const found: CxRawSymbol[] = [];
  const indentOf = (line: string) => (line.match(/^[ \t]*/)?.[0].replace(/\t/g, '    ').length ?? 0);
  const extent = (start: number): number => {
    if (indentBased) {
      const base = indentOf(lines[start - 1] ?? '');
      let end = start;
      for (let line = start + 1; line <= lines.length; line += 1) {
        const text = masked[line - 1] ?? '';
        if (!text.trim()) continue;
        if (indentOf(text) <= base) break;
        end = line;
      }
      return end;
    }
    let depth = 0;
    let opened = false;
    for (let line = start; line <= Math.min(lines.length, start + 2000); line += 1) {
      for (const character of masked[line - 1] ?? '') {
        if (character === '{') { depth += 1; opened = true; }
        else if (character === '}') { depth -= 1; if (opened && depth <= 0) return line; }
        else if (!opened && character === ';' && line === start) return start;
      }
      if (!opened && line >= start + 2) return start;
    }
    return start;
  };
  let classEnd = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const text = masked[index] ?? '';
    const line = index + 1;
    const klass = text.match(TEXT_CLASS)?.[1];
    if (klass) {
      const end = extent(line);
      found.push({ name: klass, kind: SYMBOL_KIND.Class, range: { start: line, end }, selection: { line, character: Math.max(0, (lines[index] ?? '').indexOf(klass)) } });
      classEnd = Math.max(classEnd, end);
      continue;
    }
    const insideClass = line <= classEnd;
    // Strings are masked, so a test's title is read from the original line.
    const testCase = (lines[index] ?? '').match(TEXT_TEST);
    if (testCase && /^\s*(?:test|it|describe|suite|context)\b/.test(text)) {
      const label = `${testCase[1]}('${testCase[3]}')`;
      found.push({ name: label, kind: SYMBOL_KIND.Function, range: { start: line, end: extent(line) }, selection: { line, character: Math.max(0, (lines[index] ?? '').indexOf(testCase[1]!)) } });
      continue;
    }
    const name = declaredName(text) ?? (insideClass ? text.match(TEXT_METHOD)?.[1]
      ?? (TYPED_MEMBER_LANGUAGES.has(language) ? text.match(TEXT_TYPED_METHOD)?.[1] : null) ?? null : null);
    if (!name || NOT_A_NAME.has(name)) continue;
    const end = extent(line);
    found.push({
      name, kind: insideClass ? SYMBOL_KIND.Method : SYMBOL_KIND.Function, range: { start: line, end },
      selection: { line, character: Math.max(0, (lines[index] ?? '').indexOf(name)) }
    });
  }
  // Nest by containment, so methods are named after their class.
  const roots: CxRawSymbol[] = [];
  const stack: CxRawSymbol[] = [];
  for (const symbol of found.sort((a, b) => a.range.start - b.range.start || b.range.end - a.range.end)) {
    while (stack.length && stack[stack.length - 1]!.range.end < symbol.range.start) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent && symbol.range.end <= parent.range.end) (parent.children ??= []).push(symbol);
    else roots.push(symbol);
    stack.push(symbol);
  }
  return roots;
}

/** Flatten a language service's symbol tree into callables and containers, with qualified names. */
export function flattenSymbols(symbols: CxRawSymbol[], lines: string[] | null, limit = CX_LIMITS.symbolsPerFile, fileName: string | null = null): FlatSymbol[] {
  const result: FlatSymbol[] = [];
  const visit = (entries: CxRawSymbol[], prefix: string, parentKind: number | null, insideCallable: boolean) => {
    for (const raw of [...entries].sort((a, b) => a.range.start - b.range.start || a.selection.character - b.selection.character)) {
      if (result.length >= limit) return;
      // A package declaration (Java's `package a.b;`) says where the file lives; it is not code.
      if (raw.kind === SYMBOL_KIND.Package) {
        if (raw.children?.length) visit(raw.children, prefix, parentKind, insideCallable);
        continue;
      }
      const container = CONTAINER_KINDS.has(raw.kind);
      const callable = CALLABLE_KINDS.has(raw.kind) || (MAYBE_CALLABLE_KINDS.has(raw.kind) && looksLikeFunction(lines, raw));
      // An anonymous callback inside a function is part of that function, not a row of its own; the
      // functions it declares by name (a handler inside an effect) still are.
      if (insideCallable && anonymousName(raw.name)) {
        if (raw.children?.length) visit(raw.children, prefix, parentKind, insideCallable);
        continue;
      }
      // A symbol that is the file itself (some services wrap a module in one) is transparent.
      if ((raw.kind === SYMBOL_KIND.File || raw.kind === SYMBOL_KIND.Module) && fileName && (raw.name === fileName || /^["'].*["']$/.test(raw.name))) {
        if (raw.children?.length) visit(raw.children, prefix, parentKind, insideCallable);
        continue;
      }
      // A flat symbol list (SymbolInformation) names its container instead of nesting under it.
      const own = displayName(raw.name);
      const qualifiedName = prefix ? `${prefix}.${own}` : raw.container ? `${raw.container}.${own}` : own;
      // Locals inside a function are part of it; only its nested functions are worth a row.
      if ((callable || container) && !(insideCallable && !callable)) {
        result.push({ raw, qualifiedName, kind: symbolKindName(raw, callable, parentKind), callable, container });
      }
      if (raw.children?.length && (container || callable)) {
        visit(raw.children, container || callable ? qualifiedName : prefix, raw.kind, insideCallable || callable);
      }
    }
  };
  visit(symbols, '', null, false);
  return result;
}

function innermost(symbols: FlatSymbol[], line: number, leads?: Map<FlatSymbol, number>): FlatSymbol | null {
  let best: FlatSymbol | null = null;
  for (const symbol of symbols) {
    const start = leads?.get(symbol) ?? symbol.raw.range.start;
    if (start <= line && line <= symbol.raw.range.end) {
      if (!best || (symbol.raw.range.end - symbol.raw.range.start) <= (best.raw.range.end - best.raw.range.start)) best = symbol;
    }
  }
  return best;
}

/**
 * Where a declaration's own lines begin: the comment, doc comment or decorator block directly
 * above it (no blank line between) belongs to it, so editing a function's documentation is a change
 * to that function rather than to the space between functions.
 */
export function leadingStart(lines: string[], start: number, limit = 25): number {
  let line = start - 1;
  let inBlock = false;
  while (line >= 1 && start - line <= limit) {
    const text = (lines[line - 1] ?? '').trim();
    if (!text) break;
    if (inBlock) {
      if (text.startsWith('/*')) inBlock = false;
      line -= 1;
      continue;
    }
    if (text.endsWith('*/') && !text.startsWith('/*')) { inBlock = true; line -= 1; continue; }
    if (/^(\/\/|\/\*|#(?!include)|@[A-Za-z_]|\*)/.test(text)) { line -= 1; continue; }
    break;
  }
  return line + 1;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z_$][a-z0-9_$]+/g) ?? []);
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Names the language services give to anonymous functions (`map() callback`, `<function>`). */
function anonymousName(name: string): boolean {
  return / callback$/.test(name) || /^<[^>]*>$/.test(name) || name === 'anonymous';
}

const DECLARATION = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|open|suspend|async)\s+)*(?:fun|func)\s+([A-Za-z_][\w]*)\s*[(<]/,
  /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|async|synchronized)\s+)+[\w<>[\],.? ]+\s+([A-Za-z_][\w]*)\s*\([^;]*$/,
  /^\s*(?:(?:public|private|protected|static|readonly|async|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/
];
const NOT_A_NAME = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try', 'with']);

/** A declaration's name in one removed line, when the line plainly declares a function. */
export function declaredName(line: string): string | null {
  for (const pattern of DECLARATION) {
    const name = line.match(pattern)?.[1];
    if (name && !NOT_A_NAME.has(name)) return name;
  }
  return null;
}

function firstSentence(text: string, limit = 220): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const stop = cleaned.search(/[.!?](\s|$)/);
  const sentence = stop >= 0 ? cleaned.slice(0, stop + 1) : cleaned;
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function declarationText(lines: string[] | null, symbol: { start: number; end: number; line: number }): string | null {
  if (!lines) return null;
  const start = Math.max(1, Math.min(symbol.line, symbol.start));
  const collected: string[] = [];
  for (let line = start; line <= Math.min(symbol.end, start + 7); line += 1) {
    const text = lines[line - 1] ?? '';
    collected.push(text);
    if (/[{:]\s*$|=>\s*\{?\s*$|\{/.test(text) && line >= symbol.line) break;
  }
  const joined = collected.map((entry) => entry.trim()).join(' ').replace(/\s*\{\s*$/, '').trim();
  return joined ? visibleCode(joined.length > 400 ? `${joined.slice(0, 399)}…` : joined) : null;
}

function relativeBase(file: string): { name: string; dir: string } {
  const slash = file.lastIndexOf('/');
  return { name: slash >= 0 ? file.slice(slash + 1) : file, dir: slash >= 0 ? file.slice(0, slash) : '' };
}

/**
 * A line diff in Git's shape (three lines of context), for files whose bounded patch is not
 * available. Common prefix and suffix are trimmed first, so a localized edit costs little; a middle
 * that needs more than `maxEdit` edits is shown as replaced rather than searched further.
 */
export function diffLines(before: string[], after: string[], context = 3, maxEdit = 1500): CxDiffHunk[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > head && endAfter > head && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const a = before.slice(head, endBefore);
  const b = after.slice(head, endAfter);
  const middle = myers(a, b, maxEdit) ?? [...a.map(() => '-' as const), ...b.map(() => '+' as const)];
  const ops: Array<' ' | '-' | '+'> = [...new Array<' '>(head).fill(' '), ...middle, ...new Array<' '>(before.length - endBefore).fill(' ')];
  const lines: CxDiffLine[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  for (const op of ops) {
    if (op === ' ') { lines.push({ k: ' ', a: afterLine, b: beforeLine, t: visibleCode(after[afterLine - 1]) }); beforeLine += 1; afterLine += 1; }
    else if (op === '-') { lines.push({ k: '-', a: null, b: beforeLine, t: visibleCode(before[beforeLine - 1]) }); beforeLine += 1; }
    else { lines.push({ k: '+', a: afterLine, b: null, t: visibleCode(after[afterLine - 1]) }); afterLine += 1; }
  }
  const hunks: CxDiffHunk[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.k === ' ') { index += 1; continue; }
    const start = Math.max(0, index - context);
    let end = index;
    // Extend while the next change is within two contexts of this one.
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      if (lines[cursor]!.k !== ' ') end = cursor;
      else if (cursor - end > context * 2) break;
    }
    const stop = Math.min(lines.length, end + context + 1);
    const slice = lines.slice(start, stop);
    // Git names an empty side by the line before it (0 for the top of the file).
    const firstBefore = slice.find((line) => line.b !== null)?.b ?? lines.slice(0, start).filter((line) => line.b !== null).length;
    const firstAfter = slice.find((line) => line.a !== null)?.a ?? lines.slice(0, start).filter((line) => line.a !== null).length;
    const beforeCount = slice.filter((line) => line.k !== '+').length;
    const afterCount = slice.filter((line) => line.k !== '-').length;
    hunks.push({ header: `@@ -${firstBefore},${beforeCount} +${firstAfter},${afterCount} @@`, beforeStart: firstBefore, afterStart: firstAfter, lines: slice });
    index = stop;
  }
  return hunks;
}

/**
 * The line diff for one changed file: its exact base text against its working lines. Null when the
 * working side could not be read: an unreadable file is not an empty one, and diffing against
 * nothing would report every line as removed.
 */
export function workingDiff(before: string | null, working: string[] | null, deleted: boolean): CxDiffHunk[] | null {
  if (!deleted && !working) return null;
  const lines = (text: string) => (text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : []);
  return diffLines(before === null ? [] : lines(before), deleted ? [] : lines(working!.join('\n')));
}

/** Myers' O(ND) shortest edit script over lines; null when it needs more than `limit` edits. */
function myers(a: string[], b: string[], limit: number): Array<' ' | '-' | '+'> | null {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map(() => '+');
  if (!m) return a.map(() => '-');
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        const ops: Array<' ' | '-' | '+'> = [];
        let cx = n;
        let cy = m;
        for (let back = d; back > 0; back -= 1) {
          const previous = trace[back]!;
          const ck = cx - cy;
          const down = ck === -back || (ck !== back && previous[offset + ck - 1]! < previous[offset + ck + 1]!);
          const pk = down ? ck + 1 : ck - 1;
          const px = previous[offset + pk]!;
          const py = px - pk;
          while (cx > px && cy > py && cx > (down ? px : px + 1)) { ops.push(' '); cx -= 1; cy -= 1; }
          if (down) { ops.push('+'); cy -= 1; } else { ops.push('-'); cx -= 1; }
        }
        while (cx > 0 && cy > 0) { ops.push(' '); cx -= 1; cy -= 1; }
        return ops.reverse();
      }
    }
  }
  return null;
}

interface FileChange {
  path: string;
  operation: string;
  units: string[];
  hunks: CxDiffHunk[];
  unitByHunk: Map<CxDiffHunk, string>;
  opaque: string | null;
  clauses: string[];
  tags: CxClauseTag[];
  fileId: string | null;
  diffable: boolean;
}

/**
 * Singularity Flow's own files: its governed records, agent definitions and machine-local state.
 * They are never explained as code. The engine leaves them out of the capture; this keeps an older
 * capture from drawing them.
 */
export function isSingularityOwnedPath(path: string): boolean {
  // Git metadata and tool folders are held to the same rule, in either path separator.
  return Boolean(path) && !isExplainableRepositoryPath(path);
}

/** A `clause-tag` statement's file and tag; null for any other statement or a malformed one. */
function clauseTagOf(statement: CxChangeView['statements'][number]): { path: string; tag: CxClauseTag } | null {
  if (statement.kind !== 'clause-tag') return null;
  const args = statement.arguments ?? {};
  const line = Number(args.line);
  if (typeof args.path !== 'string' || !args.path || typeof args.clauseId !== 'string' || !Number.isSafeInteger(line) || line < 1) return null;
  return {
    path: args.path,
    tag: {
      clause: visibleCode(args.clauseId), line,
      note: typeof args.note === 'string' && args.note ? visibleCode(args.note) : null,
      added: args.placement === 'added'
    }
  };
}

/** The change set per path: parsed hunks (with their XPL2 unit ids), operation and clause associations. */
function changeByPath(input: CxBuildInput['change']): Map<string, FileChange> {
  const result = new Map<string, FileChange>();
  const view = input.view;
  const sections = new Map<string, string>();
  if (input.patch) {
    for (const file of input.patchFiles) {
      const key = file.pathAfter ?? file.pathBefore;
      if (key) sections.set(key, input.patch.slice(file.patchStart, file.patchEnd));
    }
  }
  const clausesByFile = new Map<string, string[]>();
  for (const relationship of view?.relationships ?? []) {
    if (relationship.type !== 'region-associated-with-clause') continue;
    const clause = relationship.from.replace(/^clause:/, '');
    clausesByFile.set(relationship.to, [...(clausesByFile.get(relationship.to) ?? []), clause]);
  }
  const tagsByPath = new Map<string, CxClauseTag[]>();
  for (const statement of view?.statements ?? []) {
    const tag = clauseTagOf(statement);
    if (tag) tagsByPath.set(tag.path, [...(tagsByPath.get(tag.path) ?? []), tag.tag]);
  }
  for (const file of view?.inventory.files ?? []) {
    const path = file.pathAfter ?? file.pathBefore ?? file.path;
    if (isSingularityOwnedPath(path)) continue;
    const section = sections.get(path);
    const hunks = section ? parseFilePatch(section) : (input.computed?.[path] ?? []);
    const units = view?.inventory.units.filter((unit) => unit.fileId === file.fileId) ?? [];
    const unitByHunk = new Map<CxDiffHunk, string>();
    const textUnits = units.filter((unit) => unit.hunk);
    hunks.forEach((hunk, index) => {
      const unit = textUnits.find((entry) => entry.hunk!.after.start === hunk.afterStart && entry.hunk!.before.start === hunk.beforeStart)
        ?? textUnits[index];
      if (unit) unitByHunk.set(hunk, unit.unitId);
    });
    const opaqueUnit = units.find((unit) => !unit.hunk);
    result.set(path, {
      path,
      operation: file.operation,
      units: file.unitIds,
      hunks,
      unitByHunk,
      opaque: opaqueUnit && !hunks.length ? (opaqueUnit.opacity?.reason ?? opaqueUnit.opaqueReason ?? 'opaque-content') : null,
      clauses: [...new Set(clausesByFile.get(file.fileId) ?? [])].sort(),
      tags: (tagsByPath.get(path) ?? []).sort((left, right) => left.line - right.line || left.clause.localeCompare(right.clause)),
      fileId: file.fileId,
      diffable: Boolean(file.sources?.before || file.sources?.after)
    });
  }
  // A patch without a computed view still explains what changed, just without units or clauses.
  if (!view && input.patch) {
    for (const file of input.patchFiles) {
      const path = file.pathAfter ?? file.pathBefore;
      if (!path || result.has(path)) continue;
      const hunks = parseFilePatch(sections.get(path) ?? '');
      result.set(path, {
        path, operation: file.operation ?? (file.pathAfter ? (file.pathBefore ? 'modified' : 'added') : 'deleted'),
        units: [], hunks, unitByHunk: new Map(), opaque: hunks.length ? null : 'no-text-hunks', clauses: [], tags: [], fileId: null, diffable: false
      });
    }
  }
  return result;
}

interface WorkingSymbol extends CxSymbol { flat: FlatSymbol | null }

function emptySymbol(partial: Partial<WorkingSymbol> & Pick<CxSymbol, 'id' | 'key' | 'moduleId' | 'name' | 'qualifiedName' | 'kind'>): WorkingSymbol {
  return {
    file: null, start: null, end: null, line: null, status: 'unchanged', role: 'context', depth: null, primary: false,
    added: 0, removed: 0, hunks: 0, units: [], diff: [], diffTruncated: false, signature: null, signatureSource: null, doc: null,
    metrics: null, callers: [], callees: [], callStatus: 'not-requested', tests: [], testStatus: 'not-requested',
    clauses: [], tags: [], explanation: [], flat: null, ...partial
  };
}

function trimDiff(lines: CxDiffLine[], limit: number): { diff: CxDiffLine[]; truncated: boolean } {
  // Keep at most three unchanged lines around each run of changes.
  const keep = lines.map((line, index) => line.k !== ' '
    || lines.slice(Math.max(0, index - 3), index + 4).some((entry) => entry.k !== ' '));
  const kept: CxDiffLine[] = [];
  let skipped = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (keep[index]) {
      if (skipped && kept.length) kept.push({ k: ' ', a: null, b: null, t: '⋯' });
      kept.push(lines[index]!);
      skipped = false;
    } else skipped = true;
  }
  return kept.length > limit ? { diff: kept.slice(0, limit), truncated: true } : { diff: kept, truncated: false };
}

/**
 * Build the model the page draws. Deterministic for the same facts: modules, symbols and edges are
 * sorted, and the build id is the only per-build value (the host passes it in through `notes` order).
 */
export function buildCodeExplainerModel(input: CxBuildInput, id: string): CxModel {
  const changes = changeByPath(input.change);
  const filesByPath = new Map(input.files.map((file) => [file.path, file]));
  const modules = new Map<string, CxModule>();
  const symbols = new Map<string, WorkingSymbol>();
  const byKey = new Map<string, WorkingSymbol>();
  const flatByPath = new Map<string, FlatSymbol[]>();

  const moduleFor = (file: string, external = false, label: string | null = null): CxModule => {
    const existing = modules.get(`m:${file}`);
    if (existing) return existing;
    const change = changes.get(file);
    const { name, dir } = relativeBase(file);
    const fileInput = filesByPath.get(file);
    const operation = change?.operation ?? null;
    const module: CxModule = {
      id: `m:${file}`, path: file, name, dir, language: fileInput?.language ?? languageOf(file),
      role: 'context',
      status: external ? 'external' : operation === 'added' ? 'added' : operation === 'deleted' ? 'deleted'
        : operation === 'renamed' ? 'renamed' : operation ? 'modified' : 'unchanged',
      added: 0, removed: 0, symbolIds: [], clauses: change?.clauses ?? [],
      tagged: [...new Set((change?.tags ?? []).map((tag) => tag.clause))].sort(), units: change?.units ?? [],
      external, label, symbolSource: fileInput?.symbols?.length ? 'language-service' : 'none',
      symbolReason: fileInput?.symbols?.length ? null : (fileInput?.symbolReason ?? null), opaque: change?.opaque ?? null,
      diffable: change?.diffable ?? false, group: false, collapsed: false
    };
    for (const hunk of change?.hunks ?? []) {
      for (const line of hunk.lines) {
        if (line.k === '+') module.added += 1;
        else if (line.k === '-') module.removed += 1;
      }
    }
    // An added file Git did not diff (untracked) counts its working lines as added.
    if (operation === 'added' && !change?.hunks.length && fileInput?.lines) module.added = fileInput.lines.length;
    modules.set(module.id, module);
    return module;
  };

  const addSymbol = (symbol: WorkingSymbol) => {
    symbols.set(symbol.id, symbol);
    byKey.set(symbol.key, symbol);
    const module = modules.get(symbol.moduleId);
    if (module && !module.symbolIds.includes(symbol.id)) module.symbolIds.push(symbol.id);
  };

  /**
   * Changed files with no symbols (documents, configuration, images) share one card. Singularity
   * Flow's own records never get this far (isSingularityOwnedPath).
   */
  const groupFor = (file: string): CxModule => {
    const id = 'm:(other files)';
    const existing = modules.get(id);
    if (existing) return existing;
    const module: CxModule = {
      id, path: '(other files)', name: 'Other changed files',
      dir: '', language: 'plaintext', role: 'other', status: 'modified', added: 0, removed: 0,
      symbolIds: [], clauses: [], tagged: [], units: [], external: false, label: null, symbolSource: 'none', symbolReason: null,
      opaque: null, diffable: false, group: true, collapsed: false
    };
    modules.set(id, module);
    return module;
  };

  const metricsFor = (file: CxFileInput | undefined, start: number, end: number, line: number, signature: string | null): CxMetrics | null => {
    if (!file?.lines || start < 1 || end < start) return null;
    const text = file.lines.slice(start - 1, end).join('\n');
    const estimate = estimateComplexity(text, file.language);
    return {
      lines: end - start + 1,
      complexity: estimate.complexity,
      decisions: estimate.decisions,
      breakdown: estimate.breakdown,
      band: complexityBand(estimate.complexity),
      params: countParameters(signature ?? declarationText(file.lines, { start, end, line })),
      nesting: nestingDepth(text, file.language)
    };
  };

  // 1. Every harvested file with an outline: its callables and containers become symbols. A code
  // file no language service answered for gets an outline read from its own text.
  for (const file of input.files) {
    if (file.external || isSingularityOwnedPath(file.path)) continue;
    const fromService = Boolean(file.symbols && file.symbols.length);
    const outline = fromService ? file.symbols! : file.lines && isCodeLanguage(file.language) ? textSymbols(file.lines, file.language) : null;
    if (!outline) continue;
    const module = moduleFor(file.path);
    if (!fromService && outline.length) module.symbolSource = 'text';
    const flat = flattenSymbols(outline, file.lines, CX_LIMITS.symbolsPerFile, file.path.slice(file.path.lastIndexOf('/') + 1));
    flatByPath.set(file.path, flat);
    for (const entry of flat) {
      const key = symbolKey(file.path, entry.raw.selection.line, entry.raw.name);
      if (byKey.has(key)) continue;
      const start = entry.raw.range.start;
      const end = entry.raw.range.end;
      const line = entry.raw.selection.line;
      addSymbol(emptySymbol({
        id: `s:${key}`, key, moduleId: module.id, file: file.path, name: visibleCode(displayName(entry.raw.name)), qualifiedName: visibleCode(entry.qualifiedName),
        kind: entry.kind, start, end, line, flat: entry,
        signature: declarationText(file.lines, { start, end, line }), signatureSource: file.lines ? 'declaration' : null,
        metrics: entry.kind === 'class' ? null : metricsFor(file, start, end, line, null)
      }));
    }
  }

  // 2. Map every changed line onto the innermost symbol that contains it.
  const moduleScope = new Map<string, WorkingSymbol>();
  for (const [file, change] of changes) {
    const fileInput = filesByPath.get(file);
    const flat = flatByPath.get(file) ?? [];
    if (!flat.length && !isCodeLanguage(fileInput?.language ?? languageOf(file))) {
      const group = groupFor(file);
      const lines = change.hunks.flatMap((hunk) => hunk.lines);
      const added = change.operation === 'added' && !change.hunks.length ? (fileInput?.lines?.length ?? 0) : lines.filter((line) => line.k === '+').length;
      const removed = lines.filter((line) => line.k === '-').length;
      const trimmed = trimDiff(lines, CX_LIMITS.diffLinesPerSymbol);
      group.added += added;
      group.removed += removed;
      group.units.push(...change.units);
      group.clauses = [...new Set([...group.clauses, ...change.clauses])].sort();
      const key = `${file}:module`;
      addSymbol(emptySymbol({
        id: `s:${key}`, key, moduleId: group.id, file, name: visibleCode(file), qualifiedName: visibleCode(file), kind: 'file',
        status: change.operation === 'added' ? 'added' : change.operation === 'deleted' ? 'removed' : 'modified',
        added, removed, hunks: change.hunks.length, units: change.units, diff: trimmed.diff, diffTruncated: trimmed.truncated,
        clauses: change.clauses
      }));
      continue;
    }
    const module = moduleFor(file);
    const keyFor = (entry: FlatSymbol) => symbolKey(file, entry.raw.selection.line, entry.raw.name);
    const touched = new Map<string, { lines: CxDiffLine[]; units: Set<string>; hunks: Set<CxDiffHunk>; added: number; removed: number }>();
    let current: CxDiffHunk | null = null;
    const record = (owner: string, line: CxDiffLine, unit: string | undefined) => {
      const entry = touched.get(owner) ?? { lines: [], units: new Set<string>(), hunks: new Set<CxDiffHunk>(), added: 0, removed: 0 };
      entry.lines.push(line);
      if (unit) entry.units.add(unit);
      if (line.k !== ' ' && current) entry.hunks.add(current);
      if (line.k === '+') entry.added += 1;
      else if (line.k === '-') entry.removed += 1;
      touched.set(owner, entry);
    };
    // Functions this change deleted: a declaration on a removed line whose name no longer exists.
    const removedDeclarations = new Map<CxDiffLine, string>();
    if (change.operation !== 'deleted') {
      // A name is gone only when neither the outline nor the working text still declares it.
      const present = new Set([...flat.map((entry) => displayName(entry.raw.name)),
        ...(fileInput?.lines ?? []).map((line) => declaredName(line)).filter((name): name is string => Boolean(name))]);
      if (!fileInput?.lines) present.add('*');
      for (const hunk of change.hunks) {
        for (const line of hunk.lines) {
          if (line.k !== '-') continue;
          const name = declaredName(line.t);
          if (!name || present.has(name) || present.has('*')) continue;
          present.add(name);
          const key = `${file}:removed:${name}`;
          removedDeclarations.set(line, key);
          addSymbol(emptySymbol({
            id: `s:${key}`, key, moduleId: module.id, file, name, qualifiedName: name, kind: 'removed', status: 'removed',
            signature: visibleCode(line.t.trim()), signatureSource: 'declaration', line: null, clauses: change.clauses
          }));
        }
      }
    }
    const leads = new Map<FlatSymbol, number>(flat.map((entry) => [entry,
      fileInput?.lines ? leadingStart(fileInput.lines, entry.raw.range.start) : entry.raw.range.start]));
    const ownerAt = (line: number): string => {
      const owner = fileInput?.lines ? innermost(flat, line, leads) : null;
      return owner ? keyFor(owner) : 'module';
    };
    for (const hunk of change.hunks) {
      current = hunk;
      const unit = change.unitByHunk.get(hunk);
      const positions = anchors(hunk);
      const lines = hunk.lines;
      const owners = lines.map((line) => change.operation === 'deleted' ? 'module' : line.k === '-' ? '' : ownerAt(line.a!));
      // A removed line belongs where it went: to a function this change deleted, to the most similar
      // added line of the same rewrite, or, for a pure deletion, to the symbol around the gap.
      for (let start = 0; start < lines.length;) {
        if (lines[start]!.k === ' ') { start += 1; continue; }
        let end = start;
        while (end < lines.length && lines[end]!.k !== ' ') end += 1;
        const added: number[] = [];
        const removed: number[] = [];
        for (let index = start; index < end; index += 1) (lines[index]!.k === '+' ? added : removed).push(index);
        let deletedOwner: string | null = null;
        removed.forEach((index, ordinal) => {
          if (owners[index]) return;
          const line = lines[index]!;
          const declared = removedDeclarations.get(line);
          if (declared) deletedOwner = declared;
          else if (declaredName(line.t)) deletedOwner = null;
          if (deletedOwner) { owners[index] = deletedOwner; return; }
          if (added.length) {
            const tokens = tokenSet(line.t);
            let best = -1;
            let score = 0;
            for (const candidate of added) {
              const value = similarity(tokens, tokenSet(lines[candidate]!.t));
              if (value > score) { score = value; best = candidate; }
            }
            if (best < 0) best = added[Math.min(added.length - 1, Math.floor(ordinal * added.length / removed.length))]!;
            owners[index] = owners[best]!;
            return;
          }
          const after = positions[index]!;
          const before = ownerAt(after - 1);
          owners[index] = after > 1 && before === ownerAt(after) ? before : 'module';
        });
        start = end;
      }
      lines.forEach((line, index) => record(owners[index] || 'module', line, line.k === ' ' ? undefined : unit));
    }
    for (const [owner, entry] of touched) {
      if (!entry.added && !entry.removed) continue;
      const trimmed = trimDiff(entry.lines, CX_LIMITS.diffLinesPerSymbol);
      if (owner === 'module') {
        const key = `${file}:module`;
        const symbol = emptySymbol({
          id: `s:${key}`, key, moduleId: module.id, file,
          name: change.operation === 'deleted' ? '(deleted file)' : flat.length ? '(module scope)' : '(file)',
          qualifiedName: change.operation === 'deleted' ? '(deleted file)' : flat.length ? '(module scope)' : '(whole file)', kind: flat.length ? 'module-scope' : 'file',
          status: change.operation === 'added' ? 'added' : change.operation === 'deleted' ? 'removed' : 'modified',
          added: entry.added, removed: entry.removed, hunks: entry.hunks.size, units: [...entry.units].sort(), diff: trimmed.diff, diffTruncated: trimmed.truncated,
          clauses: change.clauses
        });
        moduleScope.set(file, symbol);
        addSymbol(symbol);
        continue;
      }
      const symbol = byKey.get(owner);
      if (!symbol) continue;
      symbol.added = entry.added;
      symbol.removed = entry.removed;
      symbol.hunks = entry.hunks.size;
      symbol.units = [...entry.units].sort();
      symbol.diff = trimmed.diff;
      symbol.diffTruncated = trimmed.truncated;
      symbol.clauses = change.clauses;
      const span = (symbol.end ?? 0) - (symbol.start ?? 0) + 1;
      if (symbol.kind !== 'removed') symbol.status = change.operation === 'added' || (entry.removed === 0 && entry.added >= span) ? 'added' : 'modified';
    }
    // An added file Git did not diff: every symbol in it is new.
    if (change.operation === 'added' && !change.hunks.length) {
      for (const entry of flat) {
        const symbol = byKey.get(keyFor(entry));
        if (symbol) { symbol.status = 'added'; symbol.added = (symbol.end ?? 0) - (symbol.start ?? 0) + 1; symbol.clauses = change.clauses; }
      }
      if (!flat.length) {
        const key = `${file}:module`;
        const symbol = emptySymbol({
          id: `s:${key}`, key, moduleId: module.id, file, name: '(file)', qualifiedName: '(whole file)', kind: 'file', status: 'added',
          added: module.added, clauses: change.clauses, units: change.units
        });
        moduleScope.set(file, symbol);
        addSymbol(symbol);
      }
    }
    // Opaque changes (binary, mode-only) are one file-level row.
    if (!change.hunks.length && change.operation !== 'added' && !moduleScope.has(file)) {
      const key = `${file}:module`;
      const symbol = emptySymbol({
        id: `s:${key}`, key, moduleId: module.id, file, name: change.operation === 'deleted' ? '(deleted file)' : '(file)',
        qualifiedName: change.operation === 'deleted' ? '(deleted file)' : '(whole file)', kind: 'file', status: change.operation === 'deleted' ? 'removed' : 'modified',
        units: change.units, clauses: change.clauses
      });
      moduleScope.set(file, symbol);
      addSymbol(symbol);
    }
    // A `@clause` tag belongs to the function whose own lines hold it, its leading comment block
    // included, by the same rule that assigns changed lines. A tag outside every function stays with
    // the file's module-scope row when the change has one.
    for (const tag of change.tags) {
      const owner = ownerAt(tag.line);
      const symbol = owner === 'module' ? moduleScope.get(file) : byKey.get(owner);
      if (symbol && !symbol.tags.some((entry) => entry.clause === tag.clause && entry.line === tag.line)) symbol.tags.push(tag);
    }
  }

  // 3. Calls: both ends become symbols (creating those outside the harvested files), then edges.
  const endsSeen = new Map<string, WorkingSymbol>();
  const lastPart = (value: string) => value.split(/[./\\]/).filter(Boolean).pop() ?? value;
  const ensureEnd = (end: CxCallEnd): WorkingSymbol => {
    // A call from a file's top level (a test file's `test(…)` calls) names the file itself.
    const fileName = end.path.slice(end.path.lastIndexOf('/') + 1);
    if ((end.kind === SYMBOL_KIND.File || end.kind === SYMBOL_KIND.Module) && (end.name === fileName || end.range.start <= 1)
        && !end.path.startsWith('external:')) {
      const key = `${end.path}:module`;
      const scope = byKey.get(key);
      if (scope) return scope;
      const owner = moduleFor(end.path);
      const symbol = emptySymbol({
        id: `s:${key}`, key, moduleId: owner.id, file: end.path, name: '(module scope)', qualifiedName: '(module scope)',
        kind: 'module-scope', start: null, end: null, line: end.selection.line
      });
      addSymbol(symbol);
      return symbol;
    }
    const key = symbolKey(end.path, end.selection.line, end.name);
    const existing = byKey.get(key);
    if (existing) return existing;
    // A call end inside a harvested symbol's range that the service named differently (a property
    // of a class, an arrow function bound to a variable) folds into that symbol.
    const flat = flatByPath.get(end.path);
    if (flat) {
      const container = flat.find((entry) => entry.raw.range.start === end.range.start && entry.raw.range.end === end.range.end);
      if (container) {
        const folded = byKey.get(symbolKey(end.path, container.raw.selection.line, container.raw.name));
        if (folded) return folded;
      }
      // A lambda or anonymous function reported on its own (Java's `Outer$1.accept`, a `map() callback`)
      // is part of the function that contains it.
      if (/\$\d/.test(`${end.name} ${end.detail ?? ''}`) || anonymousName(displayName(end.name))) {
        const owner = innermost(flat, end.range.start);
        const folded = owner ? byKey.get(symbolKey(end.path, owner.raw.selection.line, owner.raw.name)) : undefined;
        if (folded) return folded;
      }
    }
    // Some services move an item's selection to each call site; one range and name is one function.
    const shown = displayName(end.name);
    const sameRange = `${end.path}#${end.range.start}-${end.range.end}#${shown}`;
    const sameName = `${end.path}#${end.detail ?? ''}#${shown}#${end.kind}`;
    const again = endsSeen.get(sameRange) ?? (flat ? undefined : endsSeen.get(sameName));
    if (again) return again;
    const file = filesByPath.get(end.path);
    const external = Boolean(file?.external);
    const module = moduleFor(end.path, external, file?.label ?? null);
    const kind: CxSymbolKind = end.kind === SYMBOL_KIND.Constructor ? 'constructor'
      : end.kind === SYMBOL_KIND.Method ? 'method' : CONTAINER_KINDS.has(end.kind) ? 'class' : 'function';
    const symbol = emptySymbol({
      id: `s:${key}`, key, moduleId: module.id, file: external ? null : end.path, name: visibleCode(shown),
      qualifiedName: visibleCode(end.detail && kind === 'method' ? `${lastPart(end.detail)}.${shown}` : shown), kind,
      start: end.range.start, end: end.range.end, line: end.selection.line,
      signature: declarationText(file?.lines ?? null, { start: end.range.start, end: end.range.end, line: end.selection.line }),
      signatureSource: file?.lines ? 'declaration' : null,
      metrics: external ? null : metricsFor(file, end.range.start, end.range.end, end.selection.line, null)
    });
    addSymbol(symbol);
    endsSeen.set(sameRange, symbol);
    if (!flat) endsSeen.set(sameName, symbol);
    return symbol;
  };
  const edges = new Map<string, CxEdge>();
  for (const call of input.calls) {
    const from = ensureEnd(call.from);
    const to = ensureEnd(call.to);
    if (from.id === to.id) continue;
    const edgeId = `e:${from.id}>${to.id}`;
    const edge = edges.get(edgeId) ?? { id: edgeId, from: from.id, to: to.id, sites: [] };
    edge.sites = [...new Set([...edge.sites, ...call.sites])].sort((a, b) => a - b);
    if (call.positions?.length) {
      const at = [...(edge.at ?? []), ...call.positions];
      edge.at = at.filter((point, index) => at.findIndex((other) => other.line === point.line && other.character === point.character) === index)
        .sort((a, b) => a.line - b.line || a.character - b.character);
    }
    edges.set(edgeId, edge);
  }
  for (const edge of edges.values()) {
    const from = symbols.get(edge.from)!;
    const to = symbols.get(edge.to)!;
    if (!from.callees.includes(to.id)) from.callees.push(to.id);
    if (!to.callers.includes(from.id)) to.callers.push(from.id);
  }

  // 4. Signatures, documentation, call and reference status, test references.
  for (const symbol of symbols.values()) {
    const hover = input.hovers[symbol.key];
    if (hover?.signature) { symbol.signature = visibleCode(hover.signature); symbol.signatureSource = 'language-service'; }
    if (hover?.doc) symbol.doc = visibleCode(firstSentence(hover.doc, 400));
    symbol.callStatus = input.callStatus[symbol.key] ?? 'not-requested';
    symbol.testStatus = input.referenceStatus[symbol.key] ?? 'not-requested';
    if (symbol.metrics && hover?.signature) symbol.metrics.params = countParameters(hover.signature) ?? symbol.metrics.params;
  }
  for (const reference of input.references) {
    const symbol = byKey.get(reference.symbol);
    if (!symbol || !isTestPath(reference.path)) continue;
    if (symbol.tests.some((entry) => entry.path === reference.path && entry.line === reference.line)) continue;
    const flat = flatByPath.get(reference.path);
    const owner = flat ? innermost(flat, reference.line) : null;
    symbol.tests.push({
      path: reference.path, line: reference.line,
      symbolId: owner ? byKey.get(symbolKey(reference.path, owner.raw.selection.line, owner.raw.name))?.id ?? null : null
    });
  }

  // 5. Roles by distance from the changed (or focused) symbols along call edges.
  const focusSymbol = (() => {
    if (!input.focus) return null;
    const flat = flatByPath.get(input.focus.path);
    if (!flat) return null;
    if (input.focus.line === null) return null;
    const owner = innermost(flat, input.focus.line);
    return owner ? byKey.get(symbolKey(input.focus.path, owner.raw.selection.line, owner.raw.name)) ?? null : null;
  })();
  const changed = [...symbols.values()].filter((symbol) => symbol.status !== 'unchanged');
  const centre = changed.length ? changed : focusSymbol ? [focusSymbol] : [];
  const distance = (forward: boolean) => {
    const seen = new Map<string, number>(centre.map((symbol) => [symbol.id, 0]));
    const queue = centre.map((symbol) => symbol.id);
    while (queue.length) {
      const current = queue.shift()!;
      const symbol = symbols.get(current)!;
      for (const next of forward ? symbol.callees : symbol.callers) {
        if (seen.has(next)) continue;
        seen.set(next, seen.get(current)! + 1);
        queue.push(next);
      }
    }
    return seen;
  };
  const downstream = distance(true);
  const upstream = distance(false);
  const full = input.view === 'full';
  const mapped = (symbol: CxSymbol) => ['function', 'method', 'constructor', 'class'].includes(symbol.kind)
    || symbol.callers.length > 0 || symbol.callees.length > 0;
  for (const symbol of symbols.values()) {
    const module = modules.get(symbol.moduleId)!;
    const up = upstream.get(symbol.id);
    const down = downstream.get(symbol.id);
    if (module.group) { symbol.role = 'other'; symbol.depth = 0; symbol.primary = true; continue; }
    if (symbol.status !== 'unchanged') { symbol.role = 'changed'; symbol.depth = 0; }
    else if (focusSymbol && symbol.id === focusSymbol.id) { symbol.role = 'focus'; symbol.depth = 0; }
    else if (module.external) { symbol.role = 'external'; symbol.depth = down ?? up ?? null; }
    // A test in the full map is drawn when it calls the code; near a change, when it reaches it.
    else if (isTestPath(module.path) && (full ? symbol.callees.length > 0 : up !== undefined)) { symbol.role = 'test'; symbol.depth = full ? 1 : up!; }
    else if (full && !isTestPath(module.path) && mapped(symbol)) { symbol.role = 'repository'; symbol.depth = 0; }
    else if (up !== undefined && (down === undefined || up <= down)) { symbol.role = 'caller'; symbol.depth = up; }
    else if (down !== undefined) { symbol.role = 'callee'; symbol.depth = down; }
    else symbol.role = 'context';
    symbol.primary = symbol.role !== 'context' || (focusSymbol?.id === symbol.id);
  }
  for (const module of modules.values()) {
    const members = module.symbolIds.map((symbolId) => symbols.get(symbolId)!);
    const has = (role: CxRole) => members.some((symbol) => symbol.role === role);
    if (module.group) { module.role = 'other'; continue; }
    // A test file keeps its test colour whether it changed or only calls changed code.
    module.role = module.external ? 'external'
      : isTestPath(module.path) && (changes.has(module.path) || has('changed') || has('test') || has('caller')) ? 'test'
        : changes.has(module.path) || has('changed') ? 'changed'
          : has('focus') ? 'focus'
            : has('repository') ? 'repository'
            : has('caller') && !has('callee') ? 'caller'
              : has('callee') && !has('caller') ? 'callee'
                : has('caller') ? 'caller' : 'context';
  }

  // 6. Explanations, after every fact above is settled.
  const name = (symbolId: string): CxSegment => {
    const symbol = symbols.get(symbolId)!;
    return { sym: symbolId, t: symbol.qualifiedName };
  };
  const list = (ids: string[], home: string, limit = 4): CxSegment[] => {
    const shown = ids.slice(0, limit);
    const segments: CxSegment[] = [];
    shown.forEach((symbolId, index) => {
      if (index) segments.push({ t: index === shown.length - 1 && ids.length <= limit ? ' and ' : ', ' });
      segments.push(name(symbolId));
      const module = modules.get(symbols.get(symbolId)!.moduleId)!;
      // The file is named only when it is not the one being explained.
      if (module.id !== home) segments.push({ t: ' in ' }, { mod: module.id, t: module.external ? (module.label ?? module.name) : module.path });
    });
    if (ids.length > limit) segments.push({ t: `, and ${ids.length - limit} more` });
    return segments;
  };
  const clauseText = new Map<string, string>();
  for (const statement of input.change.view?.statements ?? []) {
    if (statement.kind === 'clause-declared') {
      const quoted = statement.text.match(/“(.+)”/)?.[1];
      if (quoted) clauseText.set(statement.about.replace(/^clause:/, ''), quoted);
    }
  }
  for (const symbol of symbols.values()) {
    const module = modules.get(symbol.moduleId)!;
    const sentences: CxSegment[][] = [];
    const kindWord = symbol.kind === 'method' ? 'method' : symbol.kind === 'constructor' ? 'constructor'
      : symbol.kind === 'class' ? 'class or type' : symbol.kind === 'variable' ? 'binding' : 'function';
    if (symbol.kind === 'file' || symbol.kind === 'module-scope') {
      sentences.push([{ t: symbol.kind === 'file' ? 'This row stands for ' : 'These lines of ' }, { mod: module.id, t: module.path },
        { t: symbol.kind === 'file' ? ' as a whole: no symbol boundaries are available for it.' : ' sit outside every function and class the language service reported (imports, top-level statements or declarations).' }]);
    } else if (symbol.kind === 'removed') {
      sentences.push([{ code: symbol.name }, { t: ' was declared on a removed line of ' }, { mod: module.id, t: module.path },
        { t: ' and no longer exists in the working file, so this change deletes or renames it.' }]);
    } else {
      const where: CxSegment[] = module.external
        ? [{ t: ' outside this repository (' }, { mod: module.id, t: module.label ?? module.name }, { t: ')' }]
        : [{ t: ' in ' }, { mod: module.id, t: module.path }];
      const span = symbol.start !== null && symbol.end !== null ? `, lines ${symbol.start}–${symbol.end}` : '';
      sentences.push([{ code: symbol.qualifiedName }, { t: ` is a ${kindWord}` }, ...where, { t: `${span}${symbol.metrics ? ` (${plural(symbol.metrics.lines, 'line')})` : ''}.` }]);
    }
    if (symbol.doc) sentences.push([{ t: 'Its documentation says: “' }, { t: symbol.doc }, { t: '”' }]);
    if (symbol.status === 'added' && symbol.kind !== 'file') sentences.push([{ t: `It is new in this change (${plural(symbol.added, 'added line')}).` }]);
    else if (symbol.status === 'modified') {
      const where = symbol.hunks ? ` in ${plural(symbol.hunks, 'hunk')}${symbol.units.length ? ` (${symbol.units.join(', ')})` : ''}` : '';
      sentences.push([{ t: `This change edits it: ${plural(symbol.added, 'line')} added and ${plural(symbol.removed, 'line')} removed${where}.` }]);
    }
    else if (symbol.status === 'added') sentences.push([{ t: `The whole file is new in this change (${plural(symbol.added, 'line')}).` }]);
    else if (symbol.role === 'caller' || symbol.role === 'test') sentences.push([{ t: `It is unchanged. It is shown because it calls changed code${symbol.depth && symbol.depth > 1 ? `, ${symbol.depth} calls away` : ''}.` }]);
    else if (symbol.role === 'callee') sentences.push([{ t: `It is unchanged. It is shown because changed code calls it${symbol.depth && symbol.depth > 1 ? `, ${symbol.depth} calls away` : ''}.` }]);
    else if (symbol.role === 'focus') sentences.push([{ t: 'It is the code you asked about; this change does not edit it.' }]);
    else if (symbol.role === 'repository') sentences.push([{ t: `It is part of the full map of the current worktree${input.story ? '; this Story does not change it' : ''}.` }]);
    if (symbol.kind !== 'file' && symbol.kind !== 'module-scope' && symbol.kind !== 'removed' && !module.external) {
      if (symbol.callers.length) sentences.push([{ t: `It is called from ${plural(symbol.callers.length, 'place')}: ` }, ...list(symbol.callers, module.id), { t: '.' }]);
      else if (symbol.callStatus === 'complete') sentences.push([{ t: 'The language service found no callers in this workspace.' }]);
      else if (symbol.callStatus === 'unavailable') sentences.push([{ t: 'Its callers are unknown: the language service could not answer a call hierarchy here.' }]);
      if (symbol.callees.length) sentences.push([{ t: `It calls ${plural(symbol.callees.length, 'function')}: ` }, ...list(symbol.callees, module.id), { t: '.' }]);
      if (symbol.metrics && symbol.kind !== 'class') {
        const parts = Object.entries(symbol.metrics.breakdown).map(([kind, count]) => `${count} ${kind}`).join(', ');
        sentences.push([{ t: `It has ${plural(symbol.metrics.decisions, 'decision point')}${parts ? ` (${parts})` : ''}: an estimated cyclomatic complexity of ${symbol.metrics.complexity}, ${symbol.metrics.band}. Counted from its text, not a syntax tree.` }]);
      }
      if (symbol.tests.length) {
        const files = [...new Set(symbol.tests.map((entry) => entry.path))];
        sentences.push([{ t: `${plural(files.length, 'test file')} ${files.length === 1 ? 'refers' : 'refer'} to it: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}. A reference shows a test names it, not that the test exercises this change.` }]);
      } else if (symbol.testStatus === 'complete') sentences.push([{ t: 'No test file refers to it (by the language service\'s references).' }]);
    }
    for (const tag of symbol.tags.slice(0, 3)) {
      const text = clauseText.get(tag.clause);
      sentences.push([{ t: `Its @clause comment on line ${tag.line}${tag.added ? ', added by this change,' : ''} names requirement ` }, { code: tag.clause },
        { t: text ? ` (“${firstSentence(text, 160)}”)` : '' },
        { t: tag.note ? `, with the author's note “${tag.note}”.` : ', with no note on how the code meets it.' },
        { t: ' A tag is the author\'s declaration; it does not prove this code meets the requirement.' }]);
    }
    for (const clause of symbol.clauses.slice(0, 3)) {
      const text = clauseText.get(clause);
      sentences.push([{ t: 'Requirement ' }, { code: clause }, { t: text ? ` (“${firstSentence(text, 160)}”)` : '' },
        { t: ' is associated with this file\'s change region. That link is at file level; it does not prove this code implements it.' }]);
    }
    if (symbol.status === 'modified' && symbol.callers.length) {
      sentences.push([{ t: symbol.callers.length === 1
        ? 'Worth checking: the caller above runs this code and may rely on how it behaved before.'
        : `Worth checking: the ${symbol.callers.length} callers above run this code and may rely on how it behaved before.` }]);
    }
    symbol.explanation = sentences;
  }

  // 7. Requirement → code → test → result trace from the change view, plus reference links.
  const trace = buildTrace(input.change.view, modules, symbols, clauseText);

  // 8. Reading order: changed code before changed tests, callers before callees, whole-file rows last.
  const readingRank = (symbol: WorkingSymbol) => (isTestPath(modules.get(symbol.moduleId)!.path) ? 2 : 0)
    + (symbol.kind === 'file' || symbol.kind === 'module-scope' || symbol.kind === 'removed' ? 1 : 0);
  const byReading = (a: WorkingSymbol, b: WorkingSymbol) => readingRank(a) - readingRank(b) || compareSymbols(a, b);
  const changedIds = [...symbols.values()].filter((symbol) => symbol.role === 'changed' || symbol.role === 'focus');
  const order: string[] = [];
  const pending = new Set(changedIds.map((symbol) => symbol.id));
  const visit = (symbol: WorkingSymbol) => {
    if (!pending.has(symbol.id)) return;
    pending.delete(symbol.id);
    order.push(symbol.id);
    for (const callee of symbol.callees.map((calleeId) => symbols.get(calleeId)!).sort(byReading)) visit(callee);
  };
  const roots = changedIds.filter((symbol) => !symbol.callers.some((callerId) => pending.has(callerId))).sort(byReading);
  for (const symbol of roots) visit(symbol);
  for (const symbol of changedIds.sort(byReading)) visit(symbol);

  // 9. Assemble, sorted for determinism.
  const sortedModules = [...modules.values()].sort((a, b) => a.path.localeCompare(b.path));
  for (const module of sortedModules) {
    module.symbolIds.sort((a, b) => compareSymbols(symbols.get(a)!, symbols.get(b)!));
  }
  const sortedSymbols = [...symbols.values()].sort(compareSymbols).map(({ flat, ...symbol }) => {
    void flat;
    symbol.callers.sort();
    symbol.callees.sort();
    symbol.tests.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    return symbol;
  });
  const codeFiles = [...changes.values()].filter((change) => isCodeLanguage(filesByPath.get(change.path)?.language ?? languageOf(change.path))).length;
  const changedSymbols = sortedSymbols.filter((symbol) => symbol.status !== 'unchanged' && symbol.kind !== 'file' && symbol.kind !== 'module-scope');
  const view = input.change.view;
  const attentionLabels: Record<string, string> = {
    blocker: 'Reported failure', visibility: 'Visibility limit', 'missing-explanation': 'Reason not recorded', advisory: 'Worth inspecting'
  };
  const statementText = new Map((view?.statements ?? []).map((statement) => [statement.id, statement.text]));
  const languages = new Map<string, { language: string; files: number; symbols: 'language-service' | 'text' | 'none'; calls: 'available' | 'analysis' | 'unavailable' | 'not-requested' }>();
  for (const module of sortedModules) {
    if (module.external || !isCodeLanguage(module.language)) continue;
    const entry = languages.get(module.language) ?? { language: module.language, files: 0, symbols: 'none' as const, calls: 'not-requested' as const };
    entry.files += 1;
    if (module.symbolSource === 'language-service') entry.symbols = 'language-service';
    else if (module.symbolSource === 'text' && entry.symbols === 'none') entry.symbols = 'text';
    for (const symbolId of module.symbolIds) {
      const status = symbols.get(symbolId)?.callStatus;
      if (status === 'complete') entry.calls = 'available';
      else if (status === 'analysis' && entry.calls !== 'available') entry.calls = 'analysis';
      else if (status === 'unavailable' && entry.calls !== 'available' && entry.calls !== 'analysis') entry.calls = 'unavailable';
    }
    languages.set(module.language, entry);
  }
  const story = input.story;
  return {
    schema: CX_SCHEMA,
    id,
    mode: view || input.change.patch ? 'change' : 'source',
    view: input.view === 'full' ? 'full' : 'delta',
    areas: {
      list: input.areas ?? [],
      selected: input.scope != null && input.scope >= 0 && input.scope < (input.areas?.length ?? 0) ? input.scope : null
    },
    repository: { name: input.repository.name, branch: input.repository.branch, head: input.repository.head, base: input.change.base },
    story: story ? {
      workId: story.workId,
      title: story.title ?? null,
      phase: story.currentPhase,
      phaseLabel: story.currentPhase ? story.phases[story.currentPhase]?.label ?? story.currentPhase : null,
      phaseStatus: story.currentPhase ? story.phases[story.currentPhase]?.status ?? null : null,
      phases: {
        index: story.currentPhase && story.phaseOrder.includes(story.currentPhase) ? story.phaseOrder.indexOf(story.currentPhase) + 1 : null,
        total: story.phaseOrder.length,
        decided: story.phaseOrder.filter((phase) => ['approved', 'skipped'].includes(story.phases[phase]?.status ?? '')).length
      },
      gates: story.gates ?? null,
      approval: story.approval ? {
        met: story.approval.met, distinct: story.approval.distinct, minimum: story.approval.minimum,
        remaining: story.approval.remainingAuthorities
      } : null
    } : null,
    change: {
      status: view || input.change.patch ? (changes.size ? 'available' : 'empty') : 'unavailable',
      reason: view || input.change.patch ? null : (input.change.unavailableReason ?? 'No captured change is available for this repository.'),
      files: changes.size,
      codeFiles,
      symbols: changedSymbols.length,
      added: sortedModules.reduce((sum, module) => sum + module.added, 0),
      removed: sortedModules.reduce((sum, module) => sum + module.removed, 0)
    },
    modules: sortedModules,
    symbols: sortedSymbols,
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    trace,
    walkthrough: order,
    attention: groupAttention(view?.attention ?? [], statementText, attentionLabels),
    intelligence: {
      status: input.status ?? 'complete',
      languages: [...languages.values()].sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
      depth: input.depth,
      notes: input.notes ?? [],
      truncated: input.truncated ?? [],
      durationMs: input.durationMs ?? null
    },
    focus: focusSymbol?.id ?? (order[0] ?? null),
    requested: focusSymbol?.id ?? null,
    modelEnabled: input.modelEnabled
  };
}

const ATTENTION_ORDER = ['blocker', 'missing-explanation', 'advisory', 'visibility'];

function groupAttention(
  entries: CxChangeView['attention'], statementText: Map<string, string>, labels: Record<string, string>
): CxModel['attention'] {
  const groups = new Map<string, CxModel['attention'][number]>();
  for (const entry of entries) {
    const key = `${entry.category}:${entry.reason}`;
    const group = groups.get(key);
    if (group) { group.count += 1; continue; }
    groups.set(key, {
      category: entry.category, label: labels[entry.category] ?? entry.category, reason: entry.reason, count: 1,
      text: visibleCode(statementText.get(entry.statement) ?? entry.reason)
    });
  }
  return [...groups.values()].sort((a, b) => (ATTENTION_ORDER.indexOf(a.category) - ATTENTION_ORDER.indexOf(b.category))
    || b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Module, then source order; rows without a position (file-level, removed) come last. */
function compareSymbols(a: CxSymbol, b: CxSymbol): number {
  return a.moduleId.localeCompare(b.moduleId)
    || (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name);
}

function buildTrace(
  view: CxChangeView | null,
  modules: Map<string, CxModule>,
  symbols: Map<string, CxSymbol>,
  clauseText: Map<string, string>
): CxTrace {
  const empty: CxTrace = {
    available: false, reason: null, requirements: [], code: [], tests: [], runs: [],
    counts: { requirements: 0, tagged: 0, declared: 0, gaps: 0, tests: 0, runs: 0, passed: 0, failed: 0 }
  };
  const changedModules = [...modules.values()].filter((module) => module.role === 'changed' || module.role === 'other');
  const code = changedModules.map((module) => ({
    moduleId: module.id,
    symbols: module.symbolIds.filter((symbolId) => symbols.get(symbolId)?.status !== 'unchanged')
  }));
  if (!view) {
    return { ...empty, code, reason: 'No captured change view is available, so requirements and recorded results cannot be shown.' };
  }
  const fileModule = new Map<string, string>();
  for (const file of view.inventory.files) {
    const path = file.pathAfter ?? file.pathBefore ?? file.path;
    fileModule.set(file.fileId, `m:${path}`);
  }
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
  const tests = new Map<string, CxTrace['tests'][number]>();
  const requirements = new Map<string, CxTrace['requirements'][number]>();
  for (const node of view.nodes) {
    if (node.kind === 'clause') {
      const clause = node.id.replace(/^clause:/, '');
      requirements.set(node.id, {
        id: clause, label: visibleCode(node.label), text: clauseText.get(clause) ? visibleCode(clauseText.get(clause)) : null,
        status: 'declared', modules: [], tests: [], gap: null, declaredIn: [], notes: [], cites: [], citedBy: []
      });
    }
    if (node.kind === 'test') {
      tests.set(node.id, { id: node.id, path: visibleCode(node.label), requirements: [], symbols: [], inChange: false, source: 'declared-tag' });
    }
  }
  for (const relationship of view.relationships) {
    if (relationship.type === 'region-associated-with-clause') {
      const requirement = requirements.get(relationship.from);
      const module = fileModule.get(relationship.to);
      if (requirement && module && !requirement.modules.includes(module)) requirement.modules.push(module);
    } else if (relationship.type === 'source-tags-clause') {
      const requirement = requirements.get(relationship.to);
      const module = fileModule.get(relationship.from);
      if (requirement && module) {
        if (!requirement.modules.includes(module)) requirement.modules.push(module);
        if (!requirement.declaredIn.includes(module)) requirement.declaredIn.push(module);
      }
    } else if (relationship.type === 'clause-cites-clause') {
      const from = requirements.get(relationship.from);
      const to = requirements.get(relationship.to);
      if (from && to) {
        if (!from.cites.includes(to.id)) from.cites.push(to.id);
        if (!to.citedBy.includes(from.id)) to.citedBy.push(from.id);
      }
    } else if (relationship.type === 'test-source-tags-clause') {
      const requirement = requirements.get(relationship.to);
      const test = tests.get(relationship.from);
      if (requirement && test) {
        if (!requirement.tests.includes(test.id)) requirement.tests.push(test.id);
        if (!test.requirements.includes(requirement.id)) test.requirements.push(requirement.id);
        requirement.status = 'tagged';
      }
    } else if (relationship.type === 'test-source-in-change') {
      const test = tests.get(relationship.from);
      if (test) test.inChange = true;
    } else if (relationship.type === 'observation-gap') {
      const requirement = requirements.get(relationship.from);
      const gap = nodes.get(relationship.to);
      if (requirement && gap) {
        requirement.gap = visibleCode(gap.label);
        if (requirement.status !== 'tagged') requirement.status = 'untagged';
      }
    }
  }
  // The author's notes after each `@clause` tag, a few per requirement.
  for (const statement of view.statements) {
    const tag = clauseTagOf(statement);
    const requirement = tag?.tag.note ? requirements.get(statement.about) : null;
    if (tag && requirement && requirement.notes.length < 4) {
      requirement.notes.push({ path: visibleCode(tag.path), line: tag.tag.line, note: tag.tag.note! });
    }
  }
  // Language-service references from test files to changed symbols: method-level, named as references.
  for (const symbol of symbols.values()) {
    if (symbol.status === 'unchanged') continue;
    for (const reference of symbol.tests) {
      const id = `test:ref:${reference.path}`;
      const existing = [...tests.values()].find((test) => test.path === reference.path);
      const test = existing ?? tests.get(id) ?? { id, path: reference.path, requirements: [], symbols: [], inChange: false, source: 'reference' as const };
      if (existing && existing.source === 'declared-tag') existing.source = 'both';
      if (!test.symbols.includes(symbol.id)) test.symbols.push(symbol.id);
      if (!existing) tests.set(id, test);
    }
  }
  const runs = view.nodes.filter((node) => node.kind === 'run').map((node) => ({ id: node.id, label: visibleCode(node.label), status: node.status ?? 'recorded' }));
  const requirementList = [...requirements.values()].sort((a, b) => a.id.localeCompare(b.id));
  const testList = [...tests.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    available: true,
    reason: null,
    requirements: requirementList,
    code,
    tests: testList,
    runs,
    counts: {
      requirements: requirementList.length,
      tagged: requirementList.filter((requirement) => requirement.status === 'tagged').length,
      declared: requirementList.filter((requirement) => requirement.declaredIn.length).length,
      gaps: requirementList.filter((requirement) => requirement.gap).length,
      tests: testList.length,
      runs: runs.length,
      passed: runs.filter((run) => run.status === 'passed').length,
      failed: runs.filter((run) => run.status === 'failed').length
    }
  };
}

/** Plain text for one symbol's explanation: what Copy and the Copilot prompt carry. */
export function explanationText(model: CxModel, symbolId: string): string {
  const symbol = model.symbols.find((entry) => entry.id === symbolId);
  if (!symbol) return '';
  return symbol.explanation.map((sentence) => sentence.map((segment) =>
    'code' in segment ? `\`${segment.code}\`` : segment.t).join('')).join(' ');
}

/**
 * A prompt a person reviews before sending: the facts above, the exact location, and what to
 * answer. Opening chat with it sends nothing by itself.
 */
export function copilotPrompt(model: CxModel, symbolId: string): string | null {
  const symbol = model.symbols.find((entry) => entry.id === symbolId);
  if (!symbol) return null;
  const module = model.modules.find((entry) => entry.id === symbol.moduleId);
  if (!module) return null;
  const where = symbol.start !== null ? `${module.path} lines ${symbol.start}-${symbol.end}` : module.path;
  const ask = symbol.status === 'unchanged'
    ? 'Explain what it does, how it relates to the changed code, and what could break if the changed code behaves differently.'
    : 'Explain what it does, why this change edits it, how its callers are affected, and which tests should check it.';
  return [
    `Explain \`${symbol.qualifiedName}\` in ${where}${model.story ? ` for Story ${model.story.workId}` : ''}.`,
    `Facts from Singularity Flow's Code Explainer (derived from the code, no model): ${explanationText(model, symbolId)}`,
    ask,
    'Keep to what the code shows; say when something cannot be told from it.',
    module.external ? '' : `#file:${module.path}`
  ].filter(Boolean).join('\n\n');
}

/** A position and range as the editor API shapes them (0-based lines), kept structural. */
interface ApiPosition { line: number; character: number }
interface ApiRange { start: ApiPosition; end: ApiPosition }
interface ApiSymbol {
  name?: unknown; kind?: unknown; detail?: string; containerName?: string;
  range?: ApiRange; selectionRange?: ApiRange; children?: unknown[]; location?: { range?: ApiRange };
}

function rangeLines(range: ApiRange): CxRange {
  return { start: range.start.line + 1, end: range.end.line + 1 };
}

/**
 * DocumentSymbol trees and SymbolInformation lists, as the plain symbols the model reads.
 *
 * The editor answers `vscode.executeDocumentSymbolProvider` with objects that carry both shapes
 * at once (a `location` and a `selectionRange`), so the document-symbol shape is tested first: its
 * selection range is the symbol's name, which is where a call hierarchy must be asked. A
 * SymbolInformation-only answer has no name position; its range start stands in for it.
 */
export function convertSymbols(result: unknown): CxRawSymbol[] | null {
  if (!Array.isArray(result)) return null;
  const convert = (entry: unknown): CxRawSymbol | null => {
    const symbol = entry as ApiSymbol | null;
    if (!symbol || typeof symbol.name !== 'string' || typeof symbol.kind !== 'number') return null;
    if (symbol.range && symbol.selectionRange) {
      return {
        name: symbol.name, detail: symbol.detail ?? null, kind: symbol.kind, range: rangeLines(symbol.range),
        selection: { line: symbol.selectionRange.start.line + 1, character: symbol.selectionRange.start.character },
        children: (symbol.children ?? []).map(convert).filter((child): child is CxRawSymbol => Boolean(child))
      };
    }
    if (!symbol.location?.range) return null;
    return {
      name: symbol.name, kind: symbol.kind, range: rangeLines(symbol.location.range),
      selection: { line: symbol.location.range.start.line + 1, character: symbol.location.range.start.character },
      container: symbol.containerName || null, children: null
    };
  };
  return result.map(convert).filter((entry): entry is CxRawSymbol => Boolean(entry));
}

/** The first code block of a hover is its signature; the remaining text is its documentation. */
export function hoverParts(hovers: unknown): { signature: string | null; doc: string | null } {
  if (!Array.isArray(hovers)) return { signature: null, doc: null };
  const texts: string[] = [];
  for (const hover of hovers as Array<{ contents?: unknown[] } | null>) {
    for (const content of hover?.contents ?? []) {
      if (typeof content === 'string') texts.push(content);
      else if (content && typeof (content as { value?: unknown }).value === 'string') {
        const value = (content as { value: string; language?: string }).value;
        texts.push((content as { language?: string }).language ? `\`\`\`\n${value}\n\`\`\`` : value);
      }
    }
  }
  const joined = texts.join('\n\n');
  const fence = joined.match(/```[^\n]*\n([\s\S]*?)```/);
  const signature = fence ? fence[1]!.trim().replace(/\n{2,}/g, '\n') : null;
  const rest = (fence ? joined.replace(fence[0], '') : joined)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]|^-{3,}$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { signature: signature ? signature.slice(0, 800) : null, doc: rest ? rest.slice(0, 600) : null };
}

/** A label for code outside the repository: the package, the standard library, or the file. */
export function externalLabel(file: string): string {
  const normal = file.replace(/\\/g, '/');
  const marker = normal.lastIndexOf('/node_modules/');
  if (marker >= 0) {
    const parts = normal.slice(marker + '/node_modules/'.length).split('/');
    const name = parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1] ?? ''}` : parts[0] ?? 'package';
    return name === 'typescript' && /\/lib\/lib\.[^/]*\.d\.ts$/.test(normal) ? 'TypeScript standard library' : name;
  }
  if (/\/lib\.[^/]*\.d\.ts$/.test(normal)) return 'TypeScript standard library';
  return normal.slice(normal.lastIndexOf('/') + 1);
}

/** A prompt about the whole change, for Ask Copilot with nothing selected. */
export function changePrompt(model: CxModel): string {
  const changed = model.walkthrough.map((symbolId) => model.symbols.find((entry) => entry.id === symbolId))
    .filter((symbol): symbol is CxSymbol => Boolean(symbol) && symbol!.kind !== 'file' && symbol!.kind !== 'module-scope');
  const lines = changed.slice(0, 24).map((symbol) => {
    const module = model.modules.find((entry) => entry.id === symbol.moduleId);
    const change = symbol.status === 'unchanged' ? 'unchanged' : `${symbol.status} +${symbol.added} -${symbol.removed}`;
    return `- \`${symbol.qualifiedName}\` (${module?.path ?? ''}${symbol.start !== null ? `:${symbol.start}` : ''}): ${change}; ${symbol.callers.length} callers, ${symbol.callees.length} callees`;
  });
  return [
    `Explain this change${model.story ? ` for Story ${model.story.workId}` : ''} to a reviewer, in reading order.`,
    `Changed code, from Singularity Flow's Code Explainer (derived from the code, no model): ${model.change.files} files, +${model.change.added} -${model.change.removed} lines.`,
    lines.join('\n') || '- (no code symbols changed)',
    changed.length > 24 ? `… and ${changed.length - 24} more.` : '',
    'For each part: what it does, why it might have changed, and what a reviewer should check. Keep to what the code shows.'
  ].filter(Boolean).join('\n\n');
}

/** The export: the model without diff text bodies beyond what the page shows, plus what it is. */
export function exportDocument(model: CxModel, generatedAt: string): Record<string, unknown> {
  return {
    kind: 'singularity-flow-code-explanation',
    schemaVersion: CX_SCHEMA,
    generatedAt,
    authority: 'none',
    note: 'Derived from the captured change and the editor language services. A call edge is what the language service reported; a test reference is not coverage; a requirement link is region-level or an author\'s @clause tag, never proof.',
    repository: model.repository,
    story: model.story,
    change: model.change,
    intelligence: model.intelligence,
    modules: model.modules.map((module) => ({
      path: module.path, language: module.language, role: module.role, status: module.status,
      added: module.added, removed: module.removed, requirements: module.clauses, declaredRequirements: module.tagged
    })),
    symbols: model.symbols.filter((symbol) => symbol.role !== 'context').map((symbol) => ({
      id: symbol.id, name: symbol.qualifiedName, kind: symbol.kind, module: symbol.moduleId.slice(2),
      lines: symbol.start !== null ? [symbol.start, symbol.end] : null, status: symbol.status, role: symbol.role,
      added: symbol.added, removed: symbol.removed, units: symbol.units, signature: symbol.signature,
      metrics: symbol.metrics, callers: symbol.callers, callees: symbol.callees,
      tests: symbol.tests.map((entry) => `${entry.path}:${entry.line}`), requirements: symbol.clauses, clauseTags: symbol.tags,
      explanation: explanationText(model, symbol.id)
    })),
    calls: model.edges.map((edge) => ({ from: edge.from, to: edge.to, sites: edge.sites })),
    trace: model.trace
  };
}
