/**
 * All skills [owner, 2026-11-25: "Is there any page we can see all marketplace skills and analyze it?"]: every skill in
 * this repository's library and in each marketplace it trusts, read from `skill catalog --json` (src/skill-catalog.mjs).
 *
 * The page shows the engine's answer: a short summary (counts, the steps no skill covers, the skills that look alike),
 * filters, a sortable table and a detail row for each skill. Its actions name a row by its key; the host finds that row
 * in its own copy of the answer and opens Workflow Studio, so the page never sends a reference, a command or a path.
 * No commit or hash is shown. The root carries no data-* attribute: only the rows do, and only for filtering.
 */
import { escape } from './webview.ts';

export interface SkillPick { kind: string; how: string; steps: string[]; intents: string[]; words: string }
export interface SkillUses {
  agents: { id: string; label: string; steps: string[] }[];
  workflows: { id: string; steps: string[] }[];
  tasks: { workId: string; kind: string; steps: string[] }[];
}
export interface SkillCatalogRow {
  key: string; id: string; label: string; description: string; source: 'library' | 'marketplace';
  marketplace: string | null; marketplaceLabel: string | null; version: string | null; lifecycle: string | null;
  readiness: string; intents: string[]; tasks: string[]; pickedBy: SkillPick[]; softwareKinds: string[]; tags: string[];
  inLibrary: boolean; libraryVersion: string | null; newerVersion: string | null; usedBy: SkillUses; overlaps: string[];
  actions: { show?: string; preview?: string; reference?: string };
  /** Who owns it, its lifecycle with who and when, its channel, and whether it is deprecated and used here (OMK §5.3). */
  owner: { name: string; words: string } | null;
  lifecycleRecord: { word: string | null; words: string; guardWords: string | null; notGuarded: boolean } | null;
  channel: 'stable' | 'beta' | null;
  /** Deprecated or retired by its marketplace and still used here, with the replacement it offers (OMK §8). */
  deprecatedInUse: { state: string; words: string; replacement: { id: string; reference: string } | null } | null;
  /** What SFlow's text checks found in the library's copy (OMK §7): refused, or lines to look at. */
  safety: { state: 'blocked' | 'look'; words: string } | null;
}
/** A source: read, or not; `approved: false` is trusted only in the working copy of workflow.yml, and `notApproved` says so. */
export interface SkillCatalogSource { id: string; kind: string; label: string; read: boolean; approved: boolean; skills: number; warning?: string; notApproved?: string }
export interface SkillOverlap { skills: string[]; ids: string[]; intents: string[]; why: string }
export interface SkillCoverage { intent: string; status: string; words: string }
export interface SkillCatalog {
  repository: { softwareKinds: string[]; words: string };
  sources: SkillCatalogSource[];
  rows: SkillCatalogRow[];
  summary: { skills: number; notInLibrary: number; newerAvailable: number; overlaps: SkillOverlap[]; coverage: SkillCoverage[]; tasksNotComposed: { kind: string; why: string }[] };
  warnings: string[];
}

/** The step intents in the order a workflow keeps them. */
const INTENT_ORDER = ['intake', 'requirements', 'design', 'plan', 'code', 'test', 'review', 'release', 'report', 'document'];
const READINESS_WORDS: Record<string, string> = { ready: 'Ready', unreviewed: 'Needs a yes', retired: 'Retired' };
const CHANNEL_WORDS: Record<string, string> = { stable: 'Stable', beta: 'Beta' };
const KIND_WORDS: Record<string, string> = { web: 'Web app', backend: 'Backend', job: 'Batch job', cli: 'Command-line tool', library: 'Library',
  mobile: 'Mobile app', artifact: 'Infrastructure files', any: 'Any kind' };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' || typeof item === 'number').map(String) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);

/** A replacement offered from the same marketplace (OMK §8): only a marketplace reference is ever previewed. */
function replacementFrom(value: unknown): { id: string; reference: string } | null {
  const replacement = record(value);
  return replacement.offered === true && typeof replacement.id === 'string' && typeof replacement.reference === 'string' && /^market:[a-z0-9-]+\/[a-z0-9-]+$/.test(replacement.reference)
    ? { id: replacement.id, reference: replacement.reference } : null;
}

/** The engine's answer, checked field by field: anything it does not say is empty, never guessed. */
export function skillCatalogFrom(value: unknown): SkillCatalog | null {
  const data = record(value);
  if (data.resultType !== 'skill-catalog' || !Array.isArray(data.rows)) return null;
  const summary = record(data.summary);
  const repository = record(data.repository);
  return {
    repository: { softwareKinds: strings(repository.softwareKinds), words: text(repository.words) },
    sources: records(data.sources).map((source) => ({ id: text(source.id), kind: text(source.kind), label: text(source.label) || text(source.id),
      read: source.read === true, approved: source.approved !== false, skills: Number(source.skills) || 0, ...(typeof source.warning === 'string' ? { warning: source.warning } : {}),
      ...(typeof source.notApproved === 'string' ? { notApproved: source.notApproved } : {}) })),
    rows: records(data.rows).filter((row) => typeof row.key === 'string' && typeof row.id === 'string').map((row) => {
      const used = record(row.usedBy);
      const actions = record(row.actions);
      return {
        key: text(row.key), id: text(row.id), label: text(row.label) || text(row.id), description: text(row.description),
        source: row.source === 'library' ? 'library' : 'marketplace', marketplace: textOrNull(row.marketplace), marketplaceLabel: textOrNull(row.marketplaceLabel),
        version: textOrNull(row.version), lifecycle: textOrNull(row.lifecycle), readiness: text(row.readiness),
        intents: strings(row.intents), tasks: strings(row.tasks),
        pickedBy: records(row.pickedBy).map((pick) => ({ kind: text(pick.kind), how: text(pick.how), steps: strings(pick.steps), intents: strings(pick.intents), words: text(pick.words) })),
        softwareKinds: strings(row.softwareKinds), tags: strings(row.tags),
        inLibrary: row.inLibrary === true, libraryVersion: textOrNull(row.libraryVersion), newerVersion: textOrNull(row.newerVersion),
        usedBy: {
          agents: records(used.agents).map((use) => ({ id: text(use.id), label: text(use.label) || text(use.id), steps: strings(use.steps) })),
          workflows: records(used.workflows).map((use) => ({ id: text(use.id), steps: strings(use.steps) })),
          tasks: records(used.tasks).map((use) => ({ workId: text(use.workId), kind: text(use.kind), steps: strings(use.steps) }))
        },
        overlaps: strings(row.overlaps),
        actions: { ...(typeof actions.show === 'string' ? { show: actions.show } : {}), ...(typeof actions.preview === 'string' ? { preview: actions.preview } : {}),
          ...(typeof actions.reference === 'string' ? { reference: actions.reference } : {}) },
        owner: typeof record(row.owner).words === 'string' ? { name: text(record(row.owner).name), words: text(record(row.owner).words) } : null,
        lifecycleRecord: typeof record(row.lifecycleRecord).words === 'string' ? { word: textOrNull(record(row.lifecycleRecord).word), words: text(record(row.lifecycleRecord).words),
          guardWords: textOrNull(record(row.lifecycleRecord).guardWords), notGuarded: record(row.lifecycleRecord).notGuarded === true } : null,
        channel: row.channel === 'stable' || row.channel === 'beta' ? row.channel : null,
        deprecatedInUse: ['deprecated', 'retired'].includes(String(record(row.deprecatedInUse).state)) ? { state: String(record(row.deprecatedInUse).state),
          words: text(record(row.deprecatedInUse).words), replacement: replacementFrom(record(row.deprecatedInUse).replacement) } : null,
        safety: ['blocked', 'look'].includes(String(record(row.safety).state)) && typeof record(row.safety).words === 'string'
          ? { state: record(row.safety).state as 'blocked' | 'look', words: text(record(row.safety).words) } : null
      };
    }),
    summary: {
      skills: Number(summary.skills) || 0, notInLibrary: Number(summary.notInLibrary) || 0, newerAvailable: Number(summary.newerAvailable) || 0,
      overlaps: records(summary.overlaps).map((overlap) => ({ skills: strings(overlap.skills), ids: strings(overlap.ids), intents: strings(overlap.intents), why: text(overlap.why) })),
      coverage: records(summary.coverage).map((entry) => ({ intent: text(entry.intent), status: text(entry.status), words: text(entry.words) })),
      tasksNotComposed: records(summary.tasksNotComposed).map((entry) => ({ kind: text(entry.kind), why: text(entry.why) }))
    },
    warnings: strings(data.warnings)
  };
}

/** What the source column says: the library, or the marketplace's name. */
export function sourceWords(row: SkillCatalogRow): string {
  return row.source === 'library' ? 'Library' : row.marketplaceLabel ?? row.marketplace ?? 'Marketplace';
}

/** Whether the library has it, in a few words. */
export function libraryWords(row: SkillCatalogRow): string {
  if (row.source === 'library') return row.newerVersion ? `Yes · newer: ${row.newerVersion}` : 'Yes';
  if (!row.inLibrary) return 'No';
  return `Yes${row.libraryVersion ? ` (${row.libraryVersion})` : ''}${row.newerVersion ? ` · newer: ${row.newerVersion}` : ''}`;
}

const users = (row: SkillCatalogRow): number => row.usedBy.agents.length + row.usedBy.workflows.length + row.usedBy.tasks.length;
const intentRank = (row: SkillCatalogRow): number => (row.intents.length ? Math.min(...row.intents.map((intent) => {
  const at = INTENT_ORDER.indexOf(intent); return at < 0 ? INTENT_ORDER.length : at;
})) : INTENT_ORDER.length + 1);
const pills = (values: string[], words: Record<string, string> = {}): string => values.map((value) => `<span class="ask-pill">${escape(words[value] ?? value)}</span>`).join(' ');
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function filterOptions(id: string, label: string, all: string, values: [string, string][]): string {
  return `<label class="ask-filter"><span>${escape(label)}</span><select id="${id}" aria-label="${escape(label)}"><option value="">${escape(all)}</option>${values
    .map(([value, words]) => `<option value="${escape(value)}">${escape(words)}</option>`).join('')}</select></label>`;
}

function summaryHtml(catalog: SkillCatalog): string {
  const library = catalog.rows.filter((row) => row.source === 'library').length;
  const tiles = [
    [String(catalog.summary.skills), 'skills'], [String(library), 'in the library'], [String(catalog.rows.length - library), 'in marketplaces'],
    [String(catalog.summary.notInLibrary), 'not in the library'], [String(catalog.summary.newerAvailable), 'newer available'], [String(catalog.summary.overlaps.length), 'look alike']
  ].map(([count, words]) => `<div class="ask-tile"><strong>${escape(count)}</strong><span>${escape(words)}</span></div>`).join('');
  // A marketplace trusted only in the working copy is never shown as trusted: its row says it is not approved yet.
  const sources = catalog.sources.map((source) => `<li>${escape(source.kind === 'library' ? 'Library' : source.label)}: ${!source.approved
    ? '<span class="ask-warn">not approved yet</span>' : source.read ? escape(plural(source.skills, 'skill')) : '<span class="ask-warn">not read</span>'}${source.notApproved
    ? ` <span class="ask-dim">${escape(source.notApproved)}</span>` : ''}</li>`).join('');
  const gaps = catalog.summary.coverage.filter((entry) => entry.status === 'none');
  const marketOnly = catalog.summary.coverage.filter((entry) => entry.status === 'marketplace');
  const coverage = gaps.length || marketOnly.length ? `<div class="ask-box"><h2>Steps the library does not cover</h2><ul>${[...gaps, ...marketOnly]
    .map((entry) => `<li class="${entry.status === 'none' ? 'ask-gap' : 'ask-market-only'}">${escape(entry.words)}</li>`).join('')}</ul></div>`
    : '<div class="ask-box"><h2>Steps</h2><p>The library has a skill for every step this repository\'s workflow has.</p></div>';
  const overlaps = catalog.summary.overlaps.length ? `<div class="ask-box"><h2>Skills that look alike</h2><ul>${catalog.summary.overlaps.slice(0, 12)
    .map((overlap) => `<li>${escape(overlap.why)}</li>`).join('')}${catalog.summary.overlaps.length > 12 ? `<li>${escape(`and ${catalog.summary.overlaps.length - 12} more: filter by Looks alike.`)}</li>` : ''}</ul></div>` : '';
  return `<section class="ask-summary" aria-label="Summary">
  <div class="ask-tiles">${tiles}</div>
  <p class="ask-words">${escape(catalog.repository.words)}</p>
  <ul class="ask-sources" aria-label="Where the skills come from">${sources}</ul>
  <div class="ask-boxes">${coverage}${overlaps}</div>
</section>`;
}

function detailHtml(catalog: SkillCatalog, row: SkillCatalogRow): string {
  const facts: [string, string][] = [
    ['Comes from', `${escape(row.source === 'library' ? 'This repository\'s skill library' : `Marketplace ${row.marketplaceLabel ?? row.marketplace}`)}${row.source === 'library' && row.marketplace
      ? escape(`, imported from marketplace ${row.marketplace}`) : ''}${row.version ? escape(`, version ${row.version}`) : ''}`],
    ['Owner', escape(row.owner?.words ?? 'No owner named')],
    ['Lifecycle', `${escape(row.lifecycleRecord?.words ?? row.lifecycle ?? 'Not marked')} · ${escape(READINESS_WORDS[row.readiness] ?? row.readiness)}${row.lifecycleRecord?.guardWords
      ? ` <span class="ask-dim">${escape(row.lifecycleRecord.guardWords)}</span>` : ''}${row.channel ? ` <span class="ask-dim">${escape(`Read through its marketplace's ${row.channel} channel.`)}</span>` : ''}${row.deprecatedInUse
      ? ` <span class="ask-warn">${escape(row.deprecatedInUse.words)}</span>` : ''}`],
    ...(row.safety ? [['Text checks', `<span class="${row.safety.state === 'blocked' ? 'ask-warn' : 'ask-dim'}">${escape(row.safety.words)}</span>`] as [string, string]] : []),
    ['For steps', row.intents.length ? `${pills(row.intents)}${row.tasks.length ? ` <span class="ask-dim">${escape(`tasks: ${row.tasks.join(', ')}`)}</span>` : ''}` : 'No step: it names no task or step intent.'],
    ['Picked by /sf-task', row.pickedBy.length ? `<ul>${row.pickedBy.map((pick) => `<li>${escape(pick.words)}</li>`).join('')}</ul>`
      : escape('No kind of task picks it on its own here; a person can still name it.')],
    ['For', `${row.softwareKinds.length ? pills(row.softwareKinds, KIND_WORDS) : escape('Any kind of software')}${row.tags.length ? ` <span class="ask-dim">${escape(`tags: ${row.tags.join(', ')}`)}</span>` : ''}`],
    ['In the library', escape(row.source === 'library' ? (row.newerVersion ? `Yes. Its marketplace has a newer version: ${row.newerVersion}.` : 'Yes.')
      : row.inLibrary ? `Yes${row.libraryVersion ? `, version ${row.libraryVersion}` : ''}.${row.newerVersion ? ` This marketplace has a newer version: ${row.newerVersion}.` : ''}` : 'No.')]
  ];
  if (row.source === 'library') {
    const uses = [
      ...row.usedBy.agents.map((use) => `Agent ${use.label}${use.steps.length ? ` in ${use.steps.join(', ')}` : ''}`),
      ...row.usedBy.workflows.map((use) => `Workflow ${use.id}${use.steps.length ? ` in ${use.steps.join(', ')}` : ''}`),
      ...row.usedBy.tasks.map((use) => `Task ${use.workId} (${use.kind})${use.steps.length ? ` in ${use.steps.join(', ')}` : ''}`)
    ];
    facts.push(['Used by', uses.length ? `<ul>${uses.map((use) => `<li>${escape(use)}</li>`).join('')}</ul>` : escape('No agent, workflow or task in this checkout uses it yet.')]);
  }
  const alike = catalog.summary.overlaps.filter((overlap) => overlap.skills.includes(row.key));
  if (alike.length) facts.push(['Looks like', `<ul>${alike.map((overlap) => `<li>${escape(overlap.why)}</li>`).join('')}</ul>`]);
  const actions = [
    row.actions.reference && !row.inLibrary ? `<button type="button" data-preview="${escape(row.key)}" title="Shows its exact text in Workflow Studio's Library, where you can add it">Preview and add</button>` : '',
    row.actions.reference && row.newerVersion ? `<button type="button" data-preview="${escape(row.key)}" title="Shows the newer version's text in Workflow Studio's Library">Preview the newer version</button>` : '',
    row.deprecatedInUse?.replacement ? `<button type="button" data-replace="${escape(row.key)}" title="${escape(`Shows ${row.deprecatedInUse.replacement.id}'s exact text in Workflow Studio's Library, where you add it; then attach it where ${row.id} is attached`)}">Replace with…</button>` : '',
    row.inLibrary ? `<button type="button" class="secondary" data-open="${escape(row.key)}">Open in Skill master</button>` : ''
  ].filter(Boolean).join(' ');
  return `<dl class="ask-facts">${facts.map(([term, value]) => `<dt>${escape(term)}</dt><dd>${value}</dd>`).join('')}</dl>${actions ? `<div class="ask-actions">${actions}</div>` : ''}`;
}

function rowHtml(catalog: SkillCatalog, row: SkillCatalogRow, index: number): string {
  const searchText = [row.id, row.label, row.description, row.marketplace ?? '', row.owner?.name ?? '', row.tags.join(' '), row.tasks.join(' ')].join(' ').toLowerCase();
  const detailId = `ask-detail-${index}`;
  return `<tr class="ask-row" data-key="${escape(row.key)}" data-order="${index}" data-name="${escape(row.id)}" data-source="${escape(row.source === 'library' ? 'library' : row.marketplace ?? '')}"
  data-lifecycle="${escape(row.lifecycle ?? 'not marked')}" data-intents="${escape(row.intents.length ? row.intents.join(' ') : 'none')}" data-intent-rank="${intentRank(row)}"
  data-kinds="${escape(row.softwareKinds.length ? row.softwareKinds.join(' ') : 'any')}" data-missing="${row.inLibrary ? '0' : '1'}" data-newer="${row.newerVersion ? '1' : '0'}"
  data-overlap="${row.overlaps.length ? '1' : '0'}" data-used="${users(row)}" data-text="${escape(searchText)}">
  <td><button type="button" class="ask-open" data-detail="${detailId}" aria-expanded="false" aria-controls="${detailId}" title="${escape(row.description)}">${escape(row.id)}</button></td>
  <td>${escape(sourceWords(row))}</td>
  <td>${escape(row.owner?.name ?? '')}</td>
  <td>${escape(row.version ?? '')}</td>
  <td>${escape(row.lifecycle ?? '')}${row.readiness === 'unreviewed' ? ' <span class="ask-dim">needs a yes</span>' : row.readiness === 'retired' ? ' <span class="ask-warn">retired</span>' : ''}${
    row.channel ? ` <span class="ask-pill">${escape(CHANNEL_WORDS[row.channel])}</span>` : ''}${row.lifecycleRecord?.notGuarded ? ' <span class="ask-pill ask-alike" title="No code owner guards its lifecycle record">Not guarded</span>' : ''}${
    row.deprecatedInUse ? ` <span class="ask-pill ask-in-use">${escape(row.deprecatedInUse.state === 'retired' ? 'Retired · in use here' : 'Deprecated · in use here')}</span>` : ''}${
    row.safety ? ` <span class="ask-pill ${row.safety.state === 'blocked' ? 'ask-in-use' : 'ask-alike'}" title="${escape(row.safety.words)}">${row.safety.state === 'blocked' ? 'Refused by text checks' : 'Lines to look at'}</span>` : ''}</td>
  <td>${row.intents.length ? pills(row.intents) : '<span class="ask-dim">none</span>'}</td>
  <td>${row.softwareKinds.length ? pills(row.softwareKinds, KIND_WORDS) : '<span class="ask-dim">any</span>'}</td>
  <td>${escape(row.pickedBy.length ? [...new Set(row.pickedBy.map((pick) => pick.kind))].join(', ') : '')}</td>
  <td>${escape(libraryWords(row))}${row.overlaps.length ? ' <span class="ask-pill ask-alike" title="Looks like another skill">alike</span>' : ''}</td>
  <td>${row.source === 'library' ? escape(String(users(row))) : ''}</td>
</tr>
<tr class="ask-detail" id="${detailId}" hidden><td colspan="10">${detailHtml(catalog, row)}</td></tr>`;
}

export function allSkillsPageHtml({ catalog, busy, error, notice }: { catalog: SkillCatalog | null; busy: boolean; error: string | null; notice: string | null }): string {
  const header = `<header class="ask-bar"><h1>All skills</h1>
    <span class="ask-lede">The skill library and every marketplace this repository trusts, in one table.</span>
    <button type="button" class="secondary" data-marketplace title="Install, update and remove skills, agents and workflows from the trusted marketplaces">Marketplace</button>
    <button type="button" class="secondary" data-skill-master>Skill master</button>
    <button type="button" data-refresh ${busy ? 'disabled' : ''}>${busy ? 'Reading…' : 'Refresh'}</button></header>`;
  const messages = `${notice ? `<p class="ask-notice" role="status">${escape(notice)}</p>` : ''}${error ? `<p class="ask-error" role="alert">${escape(error)}</p>` : ''}${(catalog?.warnings ?? [])
    .map((warning) => `<p class="ask-notice ask-warn">${escape(warning)}</p>`).join('')}`;
  if (!catalog) return `<main class="ask" id="ask-root">${header}${messages}${busy ? '<p class="ask-dim">Reading the library and the trusted marketplaces…</p>' : ''}</main>`;
  const sources: [string, string][] = [['library', 'Library'], ...catalog.sources.filter((source) => source.kind !== 'library' && source.read)
    .map((source): [string, string] => [source.id, source.label])];
  const lifecycles = [...new Set(catalog.rows.map((row) => row.lifecycle ?? 'not marked'))].sort().map((value): [string, string] => [value, value]);
  const intents = [...new Set(catalog.rows.flatMap((row) => (row.intents.length ? row.intents : ['none'])))]
    .sort((left, right) => (INTENT_ORDER.indexOf(left) < 0 ? 99 : INTENT_ORDER.indexOf(left)) - (INTENT_ORDER.indexOf(right) < 0 ? 99 : INTENT_ORDER.indexOf(right)))
    .map((value): [string, string] => [value, value === 'none' ? 'No step' : value]);
  const kinds = [...new Set(catalog.rows.flatMap((row) => (row.softwareKinds.length ? row.softwareKinds : ['any'])))].sort()
    .map((value): [string, string] => [value, KIND_WORDS[value] ?? value]);
  const filters = `<section class="ask-filters" aria-label="Filters">
  <label class="ask-filter ask-search"><span>Search</span><input type="search" id="ask-search" placeholder="Name, description, tag or task" aria-label="Search skills"></label>
  ${filterOptions('ask-source', 'From', 'Everywhere', sources)}
  ${filterOptions('ask-lifecycle', 'Lifecycle', 'Any lifecycle', lifecycles)}
  ${filterOptions('ask-intent', 'For steps', 'Any step', intents)}
  ${filterOptions('ask-kind', 'Software', 'Any software', kinds)}
  <label class="ask-check"><input type="checkbox" id="ask-missing"> Not in the library</label>
  <label class="ask-check"><input type="checkbox" id="ask-newer"> Newer available</label>
  <label class="ask-check"><input type="checkbox" id="ask-overlap"> Looks alike</label>
  <button type="button" class="secondary" data-clear>Clear</button>
  <span id="ask-count" class="ask-dim" role="status" aria-live="polite">${escape(plural(catalog.rows.length, 'skill'))}</span>
</section>`;
  const sortable = (key: string, words: string) => `<th scope="col"><button type="button" class="ask-sort" data-sort="${key}">${escape(words)}</button></th>`;
  const table = catalog.rows.length ? `<table class="ask-table">
  <thead><tr>${sortable('name', 'Skill')}${sortable('source', 'From')}<th scope="col">Owner</th><th scope="col">Version</th>${sortable('lifecycle', 'Lifecycle')}${sortable('intent', 'For steps')}<th scope="col">Software</th><th scope="col">Picked by</th>${sortable('library', 'In the library')}${sortable('used', 'Used by')}</tr></thead>
  <tbody id="ask-rows">${catalog.rows.map((row, index) => rowHtml(catalog, row, index)).join('\n')}</tbody>
</table>
<p class="ask-empty ask-dim" id="ask-none" hidden>No skill matches these filters.</p>`
    : '<p class="ask-dim">No skills yet: the library is empty and no trusted marketplace lists a skill. Add one in Workflow Studio\'s Skill master or Library.</p>';
  return `<main class="ask" id="ask-root">${header}${messages}${summaryHtml(catalog)}${filters}${table}</main>`;
}

export const ALL_SKILLS_STYLE = `
.ask { padding: 12px 16px; max-width: 1400px; }
.ask-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ask-bar h1 { margin: 0; font-size: 1.3em; }
.ask-lede { flex: 1 1 260px; color: var(--vscode-descriptionForeground); }
.ask-dim { color: var(--vscode-descriptionForeground); }
.ask-warn { color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground)); }
.ask-error { color: var(--vscode-errorForeground); }
.ask-notice { color: var(--vscode-descriptionForeground); }
.ask-tiles { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.ask-tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 10px; min-width: 96px; display: flex; flex-direction: column; }
.ask-tile strong { font-size: 1.3em; }
.ask-tile span { font-size: .85em; color: var(--vscode-descriptionForeground); }
.ask-sources { list-style: none; padding: 0; margin: 4px 0; display: flex; gap: 12px; flex-wrap: wrap; font-size: .9em; }
.ask-boxes { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; }
.ask-box { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 10px; }
.ask-box h2 { font-size: 1em; margin: 2px 0 4px; }
.ask-box ul { margin: 0; padding-left: 18px; }
.ask-gap { color: var(--vscode-editorWarning-foreground, inherit); }
.ask-filters { display: flex; gap: 8px 12px; flex-wrap: wrap; align-items: flex-end; margin: 12px 0 8px; }
.ask-filter { display: flex; flex-direction: column; gap: 2px; font-size: .85em; }
.ask-search { flex: 1 1 200px; }
.ask-search input { width: 100%; min-width: 0; }
.ask-check { display: flex; gap: 4px; align-items: center; font-size: .9em; }
.ask-table { width: 100%; border-collapse: collapse; font-size: .92em; }
.ask-table th, .ask-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
.ask-sort, .ask-open { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; text-align: left; }
.ask-sort[aria-sort] { font-weight: 600; }
.ask-pill { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 0 6px; font-size: .85em; white-space: nowrap; }
.ask-alike { border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); }
.ask-in-use { border-color: var(--vscode-errorForeground, var(--vscode-panel-border)); }
.ask-detail td { background: var(--vscode-editorWidget-background); }
.ask-facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 4px 0; }
.ask-facts dt { font-weight: 600; }
.ask-facts dd { margin: 0; }
.ask-facts ul { margin: 0; padding-left: 18px; }
.ask-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 6px 0 2px; }
`;

/**
 * The page's script: filters, sorting and the detail rows, in the page only. Its pure parts (matches, compareRows,
 * factsOf) run without a document, so a test reads them as the page does.
 */
export const ALL_SKILLS_SCRIPT = String.raw`
(function () {
  var FILTERS = ['search', 'source', 'lifecycle', 'intent', 'kind', 'missing', 'newer', 'overlap'];
  function factsOf(data) {
    var words = function (value) { return String(value || '').split(' ').filter(Boolean); };
    return { key: data.key || '', name: data.name || '', source: data.source || '', lifecycle: data.lifecycle || '', intents: words(data.intents),
      intentRank: Number(data.intentRank) || 0, kinds: words(data.kinds), missing: data.missing === '1', newer: data.newer === '1',
      overlap: data.overlap === '1', used: Number(data.used) || 0, order: Number(data.order) || 0, text: data.text || '' };
  }
  function matches(row, filters) {
    if (filters.source && row.source !== filters.source) return false;
    if (filters.lifecycle && row.lifecycle !== filters.lifecycle) return false;
    if (filters.intent && row.intents.indexOf(filters.intent) < 0) return false;
    if (filters.kind && row.kinds.indexOf(filters.kind) < 0) return false;
    if (filters.missing && !row.missing) return false;
    if (filters.newer && !row.newer) return false;
    if (filters.overlap && !row.overlap) return false;
    var words = String(filters.search || '').toLowerCase().split(/\s+/).filter(Boolean);
    for (var index = 0; index < words.length; index += 1) if (row.text.indexOf(words[index]) < 0) return false;
    return true;
  }
  function compareRows(left, right, sort) {
    var by = sort && sort.by || 'order';
    var direction = sort && sort.descending ? -1 : 1;
    var difference = 0;
    if (by === 'name') difference = left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    else if (by === 'source') difference = (left.source === 'library' ? '' : left.source) < (right.source === 'library' ? '' : right.source) ? -1
      : (left.source === 'library' ? '' : left.source) > (right.source === 'library' ? '' : right.source) ? 1 : 0;
    else if (by === 'lifecycle') difference = left.lifecycle < right.lifecycle ? -1 : left.lifecycle > right.lifecycle ? 1 : 0;
    else if (by === 'intent') difference = left.intentRank - right.intentRank;
    else if (by === 'library') difference = (left.missing ? 2 : left.newer ? 1 : 0) - (right.missing ? 2 : right.newer ? 1 : 0);
    else if (by === 'used') difference = right.used - left.used;
    return difference * direction || left.order - right.order;
  }
  window.__allSkills = { factsOf: factsOf, matches: matches, compareRows: compareRows };
  if (typeof document === 'undefined') return;
  var api = window.__sfVscode;
  var saved = {};
  try { saved = (api && api.getState && api.getState()) || {}; } catch (error) { saved = {}; }
  var state = { filters: saved.filters || {}, sort: saved.sort || null, open: saved.open || [] };
  function keep() { try { if (api && api.setState) api.setState(state); } catch (error) { /* the page works without it */ } }
  function control(name) { return document.getElementById('ask-' + name); }
  function readFilters() {
    var filters = {};
    FILTERS.forEach(function (name) {
      var input = control(name);
      if (!input) return;
      filters[name] = input.type === 'checkbox' ? input.checked : input.value;
    });
    return filters;
  }
  function writeFilters() {
    FILTERS.forEach(function (name) {
      var input = control(name);
      if (!input) return;
      if (input.type === 'checkbox') input.checked = Boolean(state.filters[name]);
      else if (state.filters[name] !== undefined) input.value = state.filters[name];
    });
  }
  function rows() { return Array.prototype.slice.call(document.querySelectorAll('tr.ask-row')); }
  function apply() {
    var body = document.getElementById('ask-rows');
    if (!body) return;
    var list = rows();
    if (state.sort) {
      list.sort(function (left, right) { return compareRows(factsOf(left.dataset), factsOf(right.dataset), state.sort); });
      list.forEach(function (row) { var detail = row.nextElementSibling; body.appendChild(row); if (detail) body.appendChild(detail); });
    }
    var shown = 0;
    list.forEach(function (row) {
      var visible = matches(factsOf(row.dataset), state.filters);
      var detail = row.nextElementSibling;
      var button = row.querySelector('[data-detail]');
      var open = state.open.indexOf(row.dataset.key) >= 0;
      row.hidden = !visible;
      if (detail) detail.hidden = !visible || !open;
      if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (visible) shown += 1;
    });
    var count = document.getElementById('ask-count');
    if (count) count.textContent = shown === list.length ? list.length + (list.length === 1 ? ' skill' : ' skills') : shown + ' of ' + list.length + ' skills';
    var none = document.getElementById('ask-none');
    if (none) none.hidden = shown > 0;
    Array.prototype.forEach.call(document.querySelectorAll('[data-sort]'), function (button) {
      if (state.sort && state.sort.by === button.dataset.sort) button.setAttribute('aria-sort', state.sort.descending ? 'descending' : 'ascending');
      else button.removeAttribute('aria-sort');
    });
    keep();
  }
  writeFilters();
  // A kept filter whose choice is gone (a marketplace no longer trusted) is dropped, so no row is hidden unseen.
  state.filters = readFilters();
  apply();
  document.addEventListener('input', function (event) { if (event.target && event.target.id && event.target.id.indexOf('ask-') === 0) { state.filters = readFilters(); apply(); } });
  document.addEventListener('change', function (event) { if (event.target && event.target.id && event.target.id.indexOf('ask-') === 0) { state.filters = readFilters(); apply(); } });
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-detail],[data-sort],[data-preview],[data-replace],[data-open],[data-refresh],[data-skill-master],[data-marketplace],[data-clear]');
    if (!target || target.disabled) return;
    if (target.dataset.detail) {
      var key = target.closest('tr').dataset.key;
      var at = state.open.indexOf(key);
      if (at >= 0) state.open.splice(at, 1); else state.open.push(key);
      apply();
    } else if (target.dataset.sort) {
      state.sort = state.sort && state.sort.by === target.dataset.sort ? { by: target.dataset.sort, descending: !state.sort.descending } : { by: target.dataset.sort, descending: false };
      apply();
    } else if (target.dataset.preview) api.postMessage({ type: 'allSkills.preview', key: target.dataset.preview });
    else if (target.dataset.replace) api.postMessage({ type: 'allSkills.replace', key: target.dataset.replace });
    else if (target.dataset.open) api.postMessage({ type: 'allSkills.open', key: target.dataset.open });
    else if (target.hasAttribute('data-refresh')) api.postMessage({ type: 'allSkills.refresh' });
    else if (target.hasAttribute('data-skill-master')) api.postMessage({ type: 'allSkills.skillMaster' });
    else if (target.hasAttribute('data-marketplace')) api.postMessage({ type: 'allSkills.marketplace' });
    else if (target.hasAttribute('data-clear')) { state.filters = {}; writeFilters(); FILTERS.forEach(function (name) { var input = control(name); if (input && input.type !== 'checkbox') input.value = ''; }); apply(); }
  });
})();
`;
