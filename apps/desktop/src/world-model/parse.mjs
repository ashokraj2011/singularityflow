/**
 * Client-side parser for the repository world model.
 *
 * The Electron snapshot (src/desktop.mjs) already hands the renderer the full content of every
 * world-model file under `data.worldModel.files[]` plus the manifest-derived `generatedAt`,
 * `rebuildReason`, and the view dependency catalog. This module turns that raw bundle into a single
 * normalized object the RGM Explorer view renders, without any further IPC.
 *
 * Everything here is defensive: a world model is authored by an LLM builder and may be incomplete,
 * predate the v2.0 `## Facts` convention, or carry only prose. Parsers return null / empty rather
 * than throwing, and an `availability` map lets the view show "not captured by this build" instead
 * of an empty widget or a fabricated number.
 */
import YAML from 'yaml';

/** Canonical view order and presentation metadata. Views absent from a build are simply skipped. */
export const VIEW_ORDER = [
  { id: 'business', label: 'Business', icon: 'business', accent: 'amber' },
  { id: 'architecture', label: 'Architecture', icon: 'architecture', accent: 'azure' },
  { id: 'development', label: 'Development', icon: 'development', accent: 'azure' },
  { id: 'testing', label: 'Testing', icon: 'testing', accent: 'emerald' },
  { id: 'release', label: 'Release', icon: 'release', accent: 'emerald' },
  { id: 'operations', label: 'Operations', icon: 'operations', accent: 'azure' },
  { id: 'security', label: 'Security', icon: 'security', accent: 'ruby' }
];

const ANCHOR_NAMESPACE = { core: 'core', business: 'biz', architecture: 'arch', development: 'dev', testing: 'test', release: 'rel', operations: 'ops', security: 'sec' };

function fileList(worldModel) {
  return Array.isArray(worldModel?.files) ? worldModel.files : [];
}

/** A world-model file is addressed by its `name` (path relative to the model root, POSIX). */
export function findFile(worldModel, matcher) {
  const files = fileList(worldModel);
  if (typeof matcher === 'string') return files.find((file) => file.name === matcher || file.name.endsWith('/' + matcher)) ?? null;
  return files.find((file) => matcher(file)) ?? null;
}

export function readFile(worldModel, matcher) {
  return findFile(worldModel, matcher)?.content ?? null;
}

function basename(pathValue) {
  return String(pathValue ?? '').split('/').filter(Boolean).at(-1) ?? '';
}

/** Parse manifest.json into a normalized, camelCase index. Tolerates schema 1.0 and 2.0. */
export function parseManifest(worldModel) {
  const raw = readFile(worldModel, 'manifest.json');
  if (!raw) return null;
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return null; }
  const views = {};
  for (const [id, entry] of Object.entries(manifest.views ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    views[id] = {
      id,
      path: entry.path ?? null,
      briefPath: entry.brief_path ?? entry.briefPath ?? null,
      anchors: Array.isArray(entry.anchors) ? entry.anchors : [],
      generated: entry.generated !== false
    };
  }
  return {
    schemaVersion: manifest.schema_version ?? manifest.schemaVersion ?? null,
    commit: manifest.repository_commit ?? manifest.repository?.commit ?? null,
    branch: manifest.repository_branch ?? manifest.repository?.branch ?? null,
    generatedAt: manifest.generated_at ?? manifest.generatedAt ?? null,
    generatedDate: manifest.generated_date ?? manifest.generatedDate ?? null,
    workingTreeClean: manifest.working_tree_clean ?? manifest.workingTreeClean ?? null,
    builderVersion: manifest.builder_version ?? manifest.builderVersion ?? null,
    builderPromptSha256: manifest.builder_prompt_sha256 ?? null,
    analysisDepth: manifest.analysis_depth ?? manifest.analysisDepth ?? null,
    viewsGenerated: manifest.views_generated ?? manifest.requested_views ?? Object.keys(views),
    sourceTreeSha256: manifest.source_tree_sha256 ?? null,
    views,
    domains: Array.isArray(manifest.domains) ? manifest.domains.map((domain) => ({
      id: domain.id ?? basename(domain.path), path: domain.path ?? null,
      relevantViews: domain.relevant_views ?? domain.relevantViews ?? []
    })) : [],
    taskGuides: Array.isArray(manifest.task_guides) ? manifest.task_guides.map((guide) => ({
      id: guide.id ?? basename(guide.path), path: guide.path ?? null, task: guide.task ?? null
    })) : [],
    evidencePath: manifest.evidence?.path ?? null,
    pathIndexPath: manifest.path_index?.path ?? null
  };
}

/**
 * The consumer header is the fenced blockquote every v2.0 Markdown document opens with:
 *   > **Grounding** · <repo> @ `<sha>` · view: `<id>` · tier: `<brief|full>`
 *   > **Generated** <date> (<utc>) · depth: `<depth>` · builder `<version>`
 * Returns best-effort fields; missing pieces are simply absent.
 */
export function parseConsumerHeader(markdown) {
  if (!markdown) return null;
  const header = {};
  const grounding = markdown.match(/\*\*Grounding\*\*[^\n]*?@\s*`([^`]+)`[^\n]*?view:\s*`([^`]+)`[^\n]*?tier:\s*`([^`]+)`/i);
  if (grounding) { header.commit = grounding[1]; header.view = grounding[2]; header.tier = grounding[3]; }
  const generatedLine = markdown.match(/\*\*Generated\*\*([^\n]*)/i);
  if (generatedLine) {
    let rest = generatedLine[1];
    const depth = rest.match(/depth:\s*`([^`]+)`/i);
    if (depth) header.depth = depth[1];
    const builder = rest.match(/builder\s*`?([^`\n]+?)`?\s*$/i);
    if (builder) header.builder = builder[1].trim();
    const utc = rest.match(/\(([^)]+)\)/);
    if (utc) header.generatedUtc = utc[1].trim();
    // The date is the leading segment, before the first "(" or "·" separator.
    const date = rest.replace(/^[\s·]+/, '').split(/[(·]/)[0].trim();
    if (date) header.generatedDate = date;
  }
  return Object.keys(header).length ? header : null;
}

/** Extract the plain text of the `## TL;DR` block (v2.0 requires it near the top of full-tier docs). */
export function parseTldr(markdown) {
  if (!markdown) return null;
  const match = markdown.match(/^##\s+TL;DR[^\n]*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/m);
  if (!match) return null;
  const text = match[1].replace(/\r/g, '').trim();
  return text || null;
}

/**
 * Parse the fenced YAML block that opens every full-tier view's `## Facts {#<ns>.facts}` section.
 * Returns the decoded object, or null when the view predates the convention or the block is invalid.
 */
export function parseFactsBlock(markdown) {
  if (!markdown) return null;
  const heading = markdown.match(/^##\s+Facts\b[^\n]*\n/m);
  if (!heading) return null;
  const after = markdown.slice(heading.index + heading[0].length);
  const fenced = after.match(/```ya?ml\s*\n([\s\S]*?)\n```/i);
  if (!fenced) return null;
  try {
    const value = YAML.parse(fenced[1]);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Collect `## Heading {#anchor}` pairs so a view can offer section-level navigation. */
export function parseAnchors(markdown) {
  if (!markdown) return [];
  const anchors = [];
  const regex = /^##\s+(.+?)\s*(?:\{#([a-z0-9][a-z0-9._-]*)\})?\s*$/gim;
  let match;
  while ((match = regex.exec(markdown))) anchors.push({ title: match[1].trim(), anchor: match[2] ?? null });
  return anchors;
}

/**
 * Split a document into `## ` sections, dropping the consumer header, TL;DR, and Facts blocks so the
 * "prose" a view renders is genuinely the judgement/analysis, not the machine-readable preamble.
 */
export function parseProseSections(markdown) {
  if (!markdown) return [];
  const sections = [];
  const regex = /^##\s+(.+?)\s*(?:\{#([a-z0-9][a-z0-9._-]*)\})?\s*$/gim;
  const heads = [];
  let match;
  while ((match = regex.exec(markdown))) heads.push({ title: match[1].trim(), anchor: match[2] ?? null, start: match.index, bodyStart: regex.lastIndex });
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index];
    const end = index + 1 < heads.length ? heads[index + 1].start : markdown.length;
    const title = head.title.toLowerCase();
    if (title.startsWith('tl;dr') || title === 'facts') continue;
    const body = markdown.slice(head.bodyStart, end).replace(/\r/g, '').trim();
    if (body) sections.push({ title: head.title, anchor: head.anchor, body });
  }
  return sections;
}

/** Parse evidence.jsonl into records, tolerating blank lines and malformed rows. */
export function parseEvidence(jsonl) {
  if (!jsonl) return { records: [], errors: 0 };
  const records = [];
  let errors = 0;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { records.push(JSON.parse(trimmed)); } catch { errors += 1; }
  }
  return { records, errors };
}

export function parseModelJson(worldModel) {
  const raw = readFile(worldModel, 'core/model.json') ?? readFile(worldModel, 'model.json');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function resolveViewContent(worldModel, manifest, viewId) {
  const fromManifest = manifest?.views?.[viewId]?.path;
  return (fromManifest && readFile(worldModel, fromManifest))
    ?? readFile(worldModel, `views/${viewId}.md`)
    ?? readFile(worldModel, `${viewId}.md`);
}

function buildViewModel(worldModel, manifest, meta, referencesById) {
  const content = resolveViewContent(worldModel, manifest, meta.id);
  if (!content) return { ...meta, present: false };
  return {
    ...meta,
    present: true,
    namespace: ANCHOR_NAMESPACE[meta.id] ?? meta.id,
    header: parseConsumerHeader(content),
    tldr: parseTldr(content),
    facts: parseFactsBlock(content),
    anchors: parseAnchors(content).filter((entry) => entry.anchor),
    sections: parseProseSections(content),
    references: referencesById.get(meta.id) ?? [],
    raw: content
  };
}

function attachDoc(worldModel, entry) {
  const content = entry.path ? readFile(worldModel, entry.path) : null;
  return {
    ...entry,
    present: Boolean(content),
    header: parseConsumerHeader(content),
    tldr: parseTldr(content),
    sections: parseProseSections(content),
    raw: content
  };
}

/** Best-effort count of source facts across views, for the Core Summary stat tiles. Returns null when nothing quantifiable was captured. */
function countFacts(views, key) {
  let total = 0;
  let seen = false;
  for (const view of views) {
    const value = view.facts?.[key];
    if (Array.isArray(value)) { total += value.length; seen = true; }
  }
  return seen ? total : null;
}

/**
 * Turn `data.worldModel` + `data.repository` into the single object the Explorer renders.
 * `availability` records which surfaces actually have backing data so the UI never fabricates.
 */
export function buildExplorerModel(worldModel, repository = {}) {
  const manifest = parseManifest(worldModel);
  const model = parseModelJson(worldModel);
  const referencesById = new Map((worldModel?.views ?? []).map((view) => [view.id, view.references ?? view.structuredReferences ?? []]));

  const views = VIEW_ORDER
    .map((meta) => buildViewModel(worldModel, manifest, meta, referencesById))
    .filter((view) => view.present);

  const summaryContent = readFile(worldModel, 'core/summary.md') ?? readFile(worldModel, 'summary.md');
  const core = summaryContent ? {
    header: parseConsumerHeader(summaryContent),
    tldr: parseTldr(summaryContent),
    facts: parseFactsBlock(summaryContent),
    sections: parseProseSections(summaryContent),
    raw: summaryContent
  } : null;

  const domains = (manifest?.domains ?? []).map((domain) => attachDoc(worldModel, domain));
  const taskGuides = (manifest?.taskGuides ?? []).map((guide) => attachDoc(worldModel, guide));
  const evidence = parseEvidence(manifest?.evidencePath ? readFile(worldModel, manifest.evidencePath) : readFile(worldModel, 'evidence/evidence.jsonl'));

  const repoName = basename(repository.root) || 'repository';
  const commit = manifest?.commit ?? repository.head ?? null;
  const branch = manifest?.branch ?? repository.branch ?? null;
  const changeCount = Array.isArray(repository.changes) ? repository.changes.length : (typeof repository.changes === 'number' ? repository.changes : null);
  const workingTreeClean = manifest?.workingTreeClean ?? (changeCount == null ? null : changeCount === 0);

  // Summary prose is the model's own one-line description of the repository, if it wrote one.
  const description = core?.tldr ?? core?.sections?.[0]?.body ?? null;

  const stats = {
    views: views.length,
    domains: domains.length,
    taskGuides: taskGuides.length,
    evidence: evidence.records.length || null,
    entryPoints: countFacts(views, 'entrypoints'),
    components: countFacts(views, 'components'),
    keySymbols: countFacts(views, 'key_symbols'),
    hotspots: countFacts(views, 'hotspots'),
    analysisDepth: manifest?.analysisDepth ?? null
  };

  const availability = {
    manifest: Boolean(manifest),
    core: Boolean(core),
    views: views.length > 0,
    facts: views.some((view) => view.facts),
    domains: domains.length > 0,
    taskGuides: taskGuides.length > 0,
    evidence: evidence.records.length > 0
  };

  return {
    present: Boolean(manifest || views.length || core),
    rebuildReason: worldModel?.rebuildReason ?? null,
    provenance: {
      name: repoName,
      branch,
      commit,
      shortCommit: commit ? String(commit).slice(0, 10) : null,
      generatedAt: manifest?.generatedAt ?? worldModel?.generatedAt ?? null,
      generatedDate: manifest?.generatedDate ?? null,
      builderVersion: manifest?.builderVersion ?? null,
      analysisDepth: manifest?.analysisDepth ?? null,
      workingTreeClean,
      sourceTreeSha256: manifest?.sourceTreeSha256 ?? null,
      stale: Boolean(worldModel?.rebuildReason)
    },
    manifest,
    model,
    core,
    description,
    views,
    domains,
    taskGuides,
    evidence,
    stats,
    availability
  };
}
