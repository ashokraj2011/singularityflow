import path from 'node:path';
import { askSuggestions } from './navigation.mjs';

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const COMMON_WORDS = new Set(['a', 'an', 'are', 'by', 'can', 'do', 'does', 'find', 'for', 'how', 'i', 'in', 'is', 'me', 'of', 'on',
  'our', 'show', 'the', 'to', 'what', 'where', 'which', 'with', 'you']);
const PER_TYPE = 12;
const browserPages = new Set(['home', 'specs', 'stories', 'workflows', 'agents', 'skills', 'instructions', 'code', 'run', 'decisions', 'about', 'help']);
const MAX_DOCUMENTS = 5000;
const commitsOnly = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' };
const omitPaths = ['**/.env*', '**/node_modules/**', '**/vendor/**', '**/dist/**', '**/*.lock', '**/package-lock.json'];
const canSearchText = query => query.length >= 2 && query.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(query);
const label = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function queryTerms(query) {
  const phrase = normalize(query);
  const parts = [...new Set(phrase.split(/ +/u).filter(Boolean))].slice(0, 12);
  const words = parts.filter(word => !COMMON_WORDS.has(word));
  return { phrase, words: words.length ? words : parts };
}

function score(item, { phrase, words }) {
  const id = normalize(item.id);
  const title = normalize(item.title);
  const body = normalize([item.subtitle, item.snippet, item.keys?.join(' ')].join(' '));
  if (!phrase) return 0;
  if (phrase === id) return 1000;
  if (phrase === title) return 900;
  const found = words.filter(word => id.includes(word) || title.includes(word) || body.includes(word));
  if (!found.length || (found.length < words.length && words.length <= 2)) return 0;
  return found.length * 3 + (found.length === words.length ? 24 : 0) +
    (id.includes(phrase) || title.includes(phrase) ? 65 : body.includes(phrase) ? 25 : 0) +
    found.filter(word => id.includes(word) || title.includes(word)).length * 12;
}

function item(type, id, title, fields = {}) {
  return { type, id: label(id, 1000), title: label(title) || label(id), ...fields };
}

async function helpDocuments() {
  const { resolveHelp } = await import('../help-service.mjs');
  const { topics } = await resolveHelp('');
  return topics.map(topic => item('help', topic.id, topic.title, {
    keys: [...topic.aliases, ...topic.commands, ...topic.questions],
    snippet: label(topic.questions[0] ?? topic.commands.slice(0, 4).join(' · '), 400)
  }));
}

async function workDocuments(root, config, contextOnly) {
  const rows = new Map();
  let incomplete = false;
  const { buildRepositorySubjectIndex } = await import('../repository-subject-index.mjs');
  const local = contextOnly ? null : await buildRepositorySubjectIndex(root, { definition: config });
  incomplete ||= Boolean(local?.unreadable.length);
  for (const { kind, id, state, aliases } of local?.list() ?? []) {
    const work = state.workItem ?? state.initiative ?? {};
    rows.set(kind + ':' + id, item(kind, id, work.title, {
      subtitle: [state.currentPhase, state.status ?? state.state].filter(Boolean).join(' · '),
      snippet: label(work.description, 420), keys: aliases, local: true
    }));
  }
  if (config.ledger?.enabled) {
    try {
      const { ledgerStoryPointers } = await import('../ledger.mjs');
      const { items } = await ledgerStoryPointers(root, config.ledger, { offline: true });
      for (const { id, branch, story } of items) {
        if (rows.has('story:' + id)) continue;
        rows.set('story:' + id, item('story', id, story?.title ?? id, {
          subtitle: [story?.phase, story?.status].filter(Boolean).join(' · '),
          snippet: '', keys: [...story?.aliases ?? [], branch]
        }));
      }
    } catch { incomplete = true; }
  }
  return { items: [...rows.values()], incomplete };
}

async function specificationDocuments(root, config, contextOnly, query) {
  const [{ libraryView, readManifest }, { revisionDirectory, LIBRARY_ROOT }, { readRefTreeResult }, { listDrafts }] = await Promise.all([
    import('../spec-library/library.mjs'), import('../spec-library/ids.mjs'), import('../git-ref-tree.mjs'), import('../spec-library/draft-store.mjs')
  ]);
  const items = [];
  const unreadable = [];
  const [view, drafts] = await Promise.allSettled([
    libraryView(root, config, { refresh: false, env: commitsOnly }),
    contextOnly ? [] : listDrafts(root, { headOnly: true, unreadable })
  ]);
  if (drafts.status === 'fulfilled') {
    for (const draft of drafts.value) {
      if (!draft.head) continue;
      const { title, spec } = draft.head.draft;
      const snippet = canSearchText(query) && typeof spec === 'string'
        ? spec.split('\n').find(line => line.toLowerCase().includes(query.toLowerCase())) : '';
      items.push(item('spec', draft.specId, title, { subtitle: 'Local draft', draft: true, snippet: label(snippet, 420) }));
    }
  }
  if (view.status !== 'fulfilled') return { items, incomplete: true };
  const { commit, specs, status } = view.value;
  if (!commit || !specs.size) return { items, incomplete: status === 'not-fetched' || drafts.status !== 'fulfilled' || unreadable.length > 0 };
  const manifests = new Map([...specs].slice(0, MAX_DOCUMENTS).map(([id, revisions]) =>
    [revisionDirectory(id, revisions.at(-1)) + '/manifest.json', [id, revisions.at(-1)]]));
  const read = readRefTreeResult(root, commit, [LIBRARY_ROOT], { pathFilter: name => manifests.has(name), env: commitsOnly });
  const matches = new Map();
  let textIncomplete = false;
  if (!contextOnly && canSearchText(query)) {
    try {
      const { typedGrep } = await import('../git-access.mjs');
      const hits = typedGrep(root, { revision: commit, text: query, paths: [LIBRARY_ROOT],
        excludes: ['**/manifest.json', '**/gaps.json', '**/research.json', '**/quality.json', '**/presence.json'], ignoreCase: true, max: 60 });
      for (const hit of hits.matches) {
        if (hit.path.endsWith('/spec.md') && !matches.has(hit.path)) matches.set(hit.path, hit.preview);
      }
      textIncomplete = hits.truncated || hits.oversized.length > 0;
    } catch { textIncomplete = true; }
  }
  for (const [name, bytes] of read.contents) {
    const [id, rev] = manifests.get(name);
    try {
      const { manifest, manifestSha256 } = readManifest(root, view.value, id, rev, { manifestBytes: bytes });
      if (contextOnly && manifest.reviewState !== 'reviewed') continue;
      items.push(item('spec', id, manifest.title, {
        subtitle: 'Revision ' + rev + ' · ' + manifest.reviewState, reference: id + '@' + rev,
        snippet: label(matches.get(revisionDirectory(id, rev) + '/spec.md'), 420),
        stateCommit: commit, manifestSha256, contentSha256: manifest.files['spec.md']
      }));
    } catch { unreadable.push(id); }
  }
  return { items, incomplete: textIncomplete || read.contents.size !== manifests.size || specs.size > MAX_DOCUMENTS ||
    drafts.status !== 'fulfilled' || unreadable.length > 0 };
}

async function catalogDocuments(root) {
  const { withApprovedConfigurationRead, INSPECTION_READ } = await import('../approved-configuration-reader.mjs');
  return withApprovedConfigurationRead(root, async () => {
    const [{ configurationReadRoot }, { workflowCatalogMetadata }, { discoverAgents }, { loadSkillLibrary },
      { loadInstructionLibrary }] = await Promise.all([
      import('../configuration-read-scope.mjs'), import('../workflow-catalog.mjs'), import('../agents.mjs'),
      import('../skill-library.mjs'), import('../instruction-library.mjs')
    ]);
    const configRoot = configurationReadRoot(root);
    const catalogs = await Promise.allSettled([
      workflowCatalogMetadata(root), discoverAgents(root), loadSkillLibrary(configRoot), loadInstructionLibrary(configRoot)
    ]);
    const items = [];
    const add = (type, entry) => items.push(item(type, entry.id, entry.label ?? entry.name, {
      snippet: label(entry.description ?? entry.purpose, 420),
      subtitle: label(entry.scope ?? entry.status, 100),
      keys: [...(Array.isArray(entry.tags) ? entry.tags : []), ...(entry.phases ?? []).map(phase => phase.label ?? phase.id)]
    }));
    for (const entry of catalogs[0].value ?? []) add('workflow', entry);
    for (const entry of catalogs[1].value ?? []) add('agent', entry);
    for (const entry of catalogs[2].value?.skills.values() ?? []) add('skill', entry);
    for (const entry of catalogs[3].value?.instructions.values() ?? []) add('instruction', entry);
    return { items, incomplete: catalogs.some(entry => entry.status === 'rejected' || entry.value?.problems?.length) };
  }, { ...INSPECTION_READ, refreshAuthority: false });
}

function hiddenPath(file) {
  return file.split('/').some(part => part.startsWith('.env') || ['node_modules', 'vendor', 'dist'].includes(part)) ||
    /(?:^|\/)(?:package-lock\.json|[^/]+\.lock)$/u.test(file);
}

async function fileDocuments(root, query, terms) {
  const [{ committedTreePaths }, { typedGrep, typedRevision }] = await Promise.all([
    import('../git.mjs'), import('../git-access.mjs')
  ]);
  const revision = typedRevision(root, 'HEAD');
  if (!revision) return { items: [], incomplete: true };
  const paths = committedTreePaths(root, revision, ['.'], { env: commitsOnly });
  const items = new Map(paths.filter(file => !hiddenPath(file)).map(file => [file, item('file', file, path.posix.basename(file), { subtitle: file, revision })])
    .filter(([, entry]) => score(entry, terms)));
  let incomplete = false;
  if (canSearchText(query)) {
    try {
      const matches = typedGrep(root, { revision, text: query, excludes: omitPaths, ignoreCase: true, max: 40 });
      for (const { path: file, line, preview } of matches.matches) {
        if (hiddenPath(file) || items.get(file)?.line) continue;
        items.set(file, item('file', file, path.posix.basename(file), { subtitle: file, line, snippet: label(preview, 350), revision }));
      }
      incomplete = matches.truncated || matches.oversized.length > 0;
    } catch { incomplete = true; }
  }
  return { items: [...items.values()], incomplete };
}

/** Deterministic workspace discovery from the selected checkout and its locally held state. */
export async function searchWorkspace(root, question, { contextOnly = false } = {}) {
  const query = question.trim();
  const terms = queryTerms(query);
  const navigation = askSuggestions(query, browserPages).map(entry => item('page', entry.id, entry.label, { snippet: entry.detail }));
  const sources = [['SFlow Help', helpDocuments().then(items => ({ items }))]];
  if (root) {
    const configuration = import('../spec-library/library.mjs').then(module => module.libraryConfig(root));
    sources.push(['Work', configuration.then(config => workDocuments(root, config, contextOnly))],
      ['Specifications', configuration.then(config => specificationDocuments(root, config, contextOnly, query))]);
    if (!contextOnly && terms.words.length) sources.push(['Workflow library', catalogDocuments(root)], ['Tracked files', fileDocuments(root, query, terms)]);
  }
  const resolved = await Promise.allSettled(sources.map(([, source]) => source));
  const missing = sources.flatMap(([name], index) => resolved[index].status !== 'fulfilled' || resolved[index].value.incomplete ? [name] : []);
  const documents = [...navigation, ...resolved.flatMap(result => result.value?.items ?? [])];
  const ranked = documents.map(entry => ({ entry, rank: score(entry, terms) })).filter(match => match.rank > 0 || match.entry.line)
    .sort((a, b) => b.rank - a.rank || a.entry.title.localeCompare(b.entry.title) || a.entry.id.localeCompare(b.entry.id));
  const counts = {};
  const capped = ranked.filter(({ entry }) => {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    return counts[entry.type] <= PER_TYPE;
  }).map(({ entry: { keys: _keys, ...entry } }) => entry);
  const { withholdForModel } = await import('../spec-library/share-check.mjs');
  return { kind: 'workspace-search', status: capped.length ? 'resolved' : 'empty',
    results: withholdForModel(capped).value, counts, missing, total: ranked.length };
}

export async function workspaceSearchFallback(root, query, value) {
  if (!query || value.work || value.specifications?.length || value.choices?.length) return null;
  const directHelp = value.help && (/^(?:how|where|what|why|when)\b/iu.test(query) ||
    [value.help.id, value.help.title].some(text => normalize(text) === normalize(query)));
  if (directHelp) return null;
  if (value.kind === 'discovery' || ['spec', 'work', 'story-spec'].includes(value.kind) && value.status === 'empty') {
    return searchWorkspace(root, query);
  }
  return null;
}

export async function openWorkspaceSearchFile(root, revision, file) {
  const { sourceFileAt } = await import('../source-inspection.mjs');
  const { withholdForModel } = await import('../spec-library/share-check.mjs');
  const unavailable = { kind: 'search-file', status: 'unavailable', diagnostics: [{ message: 'The exact file cannot be previewed. It may be unavailable, binary, or too large.' }] };
  if (!root || hiddenPath(file)) return unavailable;
  const observed = sourceFileAt(root, revision, file, { offline: true, env: commitsOnly, maxBytes: 64 * 1024 });
  if (observed.status !== 'present' || observed.value.includes('\0')) return unavailable;
  const keep = observed.value.slice(0, 16_000);
  return { kind: 'search-file', status: 'resolved', file: { path: file, revision, text: withholdForModel(keep).value,
    truncated: keep.length < observed.value.length } };
}
