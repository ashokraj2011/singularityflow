/**
 * Marketplace [owner, 2026-11-25: "see what is installed in local and update, like an app store"]: every skill, agent,
 * workflow and template of the marketplaces this repository trusts, and what is installed here, read from `marketplace
 * catalog --json` (src/marketplace-catalog.mjs).
 *
 * The page shows the engine's answer: a summary, the marketplaces not approved yet, a tab per kind, search and filters,
 * and one row per item with its status and the buttons for that status. A button names a row by its key; the host finds
 * the row in its own copy of the answer and opens Workflow Studio's own preview, conversion review, archive or removal
 * (studioTargetFor), so the page never sends a reference, a command or a path, and never writes configuration. No commit
 * or hash is shown. The root carries no data-* attribute: only the rows and the controls do.
 */
import { escape } from './webview.ts';

export type MarketplaceStatus = 'installed' | 'update-available' | 'not-installed' | 'local-only' | 'not-approved-yet';
export type MarketplaceKind = 'skill' | 'agent' | 'workflow' | 'template' | 'mcp-server' | 'generated' | 'marketplace';
export type MarketplaceAct = 'install' | 'update' | 'remove' | 'open' | 'approve';
export interface MarketplaceAction { command: string; label: string }
export interface MarketplaceInstall { as: string; id: string | null; agent: string | null; label: string | null; importKey: string | null; archived: boolean }
export interface MarketplaceItem {
  key: string; kind: MarketplaceKind; id: string; name: string; description: string; source: 'marketplace' | 'here';
  marketplace: string | null; marketplaceLabel: string | null; marketplaceKind: string | null; version: string | null; installedVersion: string | null;
  lifecycle: string | null; readiness: string | null; tags: string[]; softwareKinds: string[];
  status: MarketplaceStatus; statusWords: string; update: { kind: string; from: string | null; to: string | null; newer: boolean; words: string } | null;
  installedAs: MarketplaceInstall | null; fromAgent: { marketplace: string; agent: string } | null; conflict: { replaces: boolean; words: string } | null;
  importable: boolean; actions: Partial<Record<'preview' | 'install' | 'update' | 'remove' | 'open' | 'approve', MarketplaceAction>>;
}
export interface MarketplaceSource { id: string; kind: string; label: string; approved: boolean; read: boolean; items: number; warning?: string; notApproved?: string }
export interface MarketplaceCatalog {
  sources: MarketplaceSource[];
  items: MarketplaceItem[];
  summary: { items: number; byKind: Record<string, number>; byStatus: Record<string, number>; updates: number };
  warnings: string[];
}

export const MARKETPLACE_TABS: readonly { kind: MarketplaceKind; words: string }[] = Object.freeze([
  { kind: 'skill', words: 'Skills' }, { kind: 'agent', words: 'Agents' }, { kind: 'workflow', words: 'Workflows' }, { kind: 'template', words: 'Templates' },
  { kind: 'mcp-server', words: 'MCP servers' }, { kind: 'generated', words: 'Generated' }]);
/** Kinds whose tab shows only when an item of that kind is listed. */
const OPTIONAL_TABS: MarketplaceKind[] = ['template', 'mcp-server', 'generated'];
const STATUSES: MarketplaceStatus[] = ['update-available', 'installed', 'not-installed', 'local-only', 'not-approved-yet'];
export const STATUS_WORDS: Record<MarketplaceStatus, string> = { installed: 'Installed', 'update-available': 'Update available', 'not-installed': 'Not installed',
  'local-only': 'Only here', 'not-approved-yet': 'Not approved yet' };
const KINDS: MarketplaceKind[] = ['skill', 'agent', 'workflow', 'template', 'mcp-server', 'generated', 'marketplace'];
const ACTIONS = ['preview', 'install', 'update', 'remove', 'open', 'approve'] as const;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item) => typeof item === 'string').map(String) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.map(record) : []);
const counts = (value: unknown): Record<string, number> => Object.fromEntries(Object.entries(record(value)).map(([key, count]) => [key, Number(count) || 0]));

/** The engine's answer, checked field by field: anything it does not say is empty, never guessed. */
export function marketplaceCatalogFrom(value: unknown): MarketplaceCatalog | null {
  const data = record(value);
  if (data.resultType !== 'marketplace-catalog' || !Array.isArray(data.items)) return null;
  const summary = record(data.summary);
  return {
    sources: records(data.sources).map((source) => ({ id: text(source.id), kind: text(source.kind), label: text(source.label) || text(source.id),
      approved: source.approved !== false, read: source.read === true, items: Number(source.items) || 0,
      ...(typeof source.warning === 'string' ? { warning: source.warning } : {}), ...(typeof source.notApproved === 'string' ? { notApproved: source.notApproved } : {}) })),
    items: records(data.items).filter((item) => typeof item.key === 'string' && typeof item.id === 'string' && KINDS.includes(item.kind as MarketplaceKind)
      && STATUSES.includes(item.status as MarketplaceStatus)).map((item) => {
      const update = record(item.update);
      const installed = record(item.installedAs);
      const fromAgent = record(item.fromAgent);
      const conflict = record(item.conflict);
      const actions = record(item.actions);
      return {
        key: text(item.key), kind: item.kind as MarketplaceKind, id: text(item.id), name: text(item.name) || text(item.id), description: text(item.description),
        source: item.source === 'here' ? 'here' : 'marketplace', marketplace: textOrNull(item.marketplace), marketplaceLabel: textOrNull(item.marketplaceLabel),
        marketplaceKind: textOrNull(item.marketplaceKind), version: textOrNull(item.version), installedVersion: textOrNull(item.installedVersion),
        lifecycle: textOrNull(item.lifecycle), readiness: textOrNull(item.readiness), tags: strings(item.tags), softwareKinds: strings(item.softwareKinds),
        status: item.status as MarketplaceStatus, statusWords: text(item.statusWords),
        update: item.update ? { kind: text(update.kind), from: textOrNull(update.from), to: textOrNull(update.to), newer: update.newer === true, words: text(update.words) } : null,
        installedAs: item.installedAs ? { as: text(installed.as), id: textOrNull(installed.id), agent: textOrNull(installed.agent), label: textOrNull(installed.label),
          importKey: textOrNull(installed.importKey), archived: installed.archived === true } : null,
        fromAgent: typeof fromAgent.marketplace === 'string' && typeof fromAgent.agent === 'string' ? { marketplace: fromAgent.marketplace, agent: fromAgent.agent } : null,
        conflict: item.conflict ? { replaces: conflict.replaces === true, words: text(conflict.words) } : null,
        importable: item.importable !== false,
        actions: Object.fromEntries(ACTIONS.filter((name) => typeof record(actions[name]).command === 'string')
          .map((name) => [name, { command: text(record(actions[name]).command), label: text(record(actions[name]).label) }]))
      };
    }),
    summary: { items: Number(summary.items) || 0, byKind: counts(summary.byKind), byStatus: counts(summary.byStatus), updates: Number(summary.updates) || 0 },
    warnings: strings(data.warnings)
  };
}

/** Where Workflow Studio opens for a button, and what the page says meanwhile; null when the row has no such button. */
export interface StudioTarget { studio: Record<string, unknown>; notice: string }

/**
 * A row's button as one of Workflow Studio's own routes [owner, 2026-11-25]: install and update preview the exact text
 * (or the conversion review of an agent), remove asks there, and each change is published from Studio as a reviewed
 * proposal. The engine's action names what the route ends in; a row without that action has no button.
 */
export function studioTargetFor(act: MarketplaceAct, item: MarketplaceItem): StudioTarget | null {
  const installed = item.installedAs;
  const reference = item.marketplace ? `market:${item.marketplace}/${item.id}` : null;
  if (act === 'approve') {
    return item.status === 'not-approved-yet' && item.actions.approve ? { studio: { view: 'changes' }, notice: `Workflow Studio's Changes shows the change that trusts ${item.name}.` } : null;
  }
  if (act === 'install') {
    // An MCP server is added for the agents that may use its tools: Studio's preview shows them and asks which.
    if (item.kind === 'mcp-server') {
      return item.status === 'not-installed' && item.actions.preview && reference ? { studio: { view: 'library', preview: { reference, replace: false, as: 'mcp-server' } },
        notice: `Workflow Studio shows ${item.name}'s exact text and its tools: choose the agents that may use them, then publish.` } : null;
    }
    if (item.status !== 'not-installed' || !item.actions.install || !reference) return null;
    if (item.kind === 'agent' && item.marketplaceKind === 'repository') {
      if (installed?.as === 'workflow' && installed.archived && installed.id) {
        return { studio: { retire: { action: 'restore', selector: `story:${installed.id}` } }, notice: `Workflow Studio asks before it offers ${installed.label ?? installed.id} to new Stories again.` };
      }
      return { studio: { view: 'library', agentWorkflow: { target: `${item.marketplace}/${item.id}`, update: false } },
        notice: `Workflow Studio shows the workflow ${item.name} becomes. Make it there, then review its import.` };
    }
    if (item.kind === 'skill') {
      return { studio: { view: 'library', preview: { reference, replace: item.conflict?.replaces === true } }, notice: `Workflow Studio shows ${item.name}'s exact text. Add it there, then publish.` };
    }
    if (item.kind === 'agent' || item.kind === 'template') {
      return { studio: { view: 'library', preview: { reference, replace: false, as: item.kind } }, notice: `Workflow Studio shows ${item.name}'s exact text. Add it there, then publish.` };
    }
    // A generated source is set up from its marketplace's entries, where Studio asks which agent fetches it.
    if (item.kind === 'generated' && item.marketplace) {
      return { studio: { view: 'library', browse: item.marketplace }, notice: `Workflow Studio lists ${item.marketplaceLabel ?? item.marketplace}'s entries: choose Set up on ${item.name}, then publish.` };
    }
    return null;
  }
  if (act === 'update') {
    if (item.status !== 'update-available' || !item.actions.update || !installed) return null;
    if (installed.as === 'workflow') {
      const agent = item.fromAgent ?? (item.marketplace ? { marketplace: item.marketplace, agent: item.id } : null);
      return agent ? { studio: { view: 'library', agentWorkflow: { target: `${agent.marketplace}/${agent.agent}`, update: true } },
        notice: `Workflow Studio shows what changed in ${agent.agent} and the workflow it becomes now.` } : null;
    }
    if (!reference) return null;
    if (installed.as === 'library-skill') return { studio: { view: 'library', preview: { reference, replace: true } }, notice: `Workflow Studio shows the marketplace's text of ${item.name}. Add it there to replace yours.` };
    if (installed.as === 'agent' || installed.as === 'template' || installed.as === 'mcp-server') {
      return { studio: { view: 'library', preview: { reference, replace: true, as: installed.as } }, notice: `Workflow Studio shows the marketplace's text of ${item.name}. Add it there to replace yours.` };
    }
    // A generated source has no text to preview: its update is the command under actions, through review.
    if (installed.as === 'generated') return null;
    // A skill one agent imported for itself: Studio's Library updates it from its own check.
    return { studio: { view: 'library' }, notice: `In the Library, choose Check for updates, then Review update on ${installed.importKey ?? item.id}.` };
  }
  if (act === 'remove') {
    if (!item.actions.remove || !installed?.id) return null;
    if (installed.as === 'workflow') {
      return { studio: { retire: { action: 'archive', selector: `story:${installed.id}` } }, notice: `Workflow Studio asks before it archives ${installed.label ?? installed.id}. Running Stories keep it.` };
    }
    if (installed.as === 'library-skill') return { studio: { view: 'skills', skill: installed.id, remove: true }, notice: `Workflow Studio asks before it deletes ${installed.id}. Publish there to propose it.` };
    return installed.importKey ? { studio: { view: 'library', removeImport: installed.importKey }, notice: `${installed.importKey} is removed once you publish in Workflow Studio.` } : null;
  }
  // Open: what is installed, where Workflow Studio keeps it.
  if (!installed?.id || item.status === 'not-installed') return null;
  if (installed.as === 'workflow') return { studio: { workflowId: installed.id }, notice: '' };
  if (installed.as === 'library-skill') return { studio: { view: 'skills', skill: installed.id }, notice: '' };
  return { studio: { view: 'library' }, notice: '' };
}

const BUTTONS: readonly { act: MarketplaceAct; words: string; primary: boolean }[] = [
  { act: 'install', words: 'Install…', primary: true }, { act: 'update', words: 'Update…', primary: true },
  { act: 'open', words: 'Open', primary: false }, { act: 'remove', words: 'Remove…', primary: false }];

function buttonsHtml(item: MarketplaceItem): string {
  return BUTTONS.filter((button) => studioTargetFor(button.act, item)).map((button) => `<button type="button" ${button.primary ? '' : 'class="secondary" '}data-act="${button.act}" data-key="${escape(item.key)}"
    aria-label="${escape(`${button.words.replace('…', '')} ${item.name}`)}" title="${escape(item.actions[button.act]?.label ?? '')}">${escape(button.words)}</button>`).join(' ');
}

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function whereWords(item: MarketplaceItem): string {
  if (item.source === 'marketplace') return item.marketplaceLabel ?? item.marketplace ?? '';
  return item.marketplace ? `Here, from ${item.marketplaceLabel ?? item.marketplace}` : 'Here';
}

function versionWords(item: MarketplaceItem): string {
  if (item.status === 'update-available' && item.installedVersion && item.version && item.installedVersion !== item.version) return `${item.version} (here ${item.installedVersion})`;
  return item.version ?? '';
}

function rowHtml(item: MarketplaceItem, index: number): string {
  const search = [item.id, item.name, item.description, item.marketplace ?? '', item.marketplaceLabel ?? '', item.tags.join(' ')].join(' ').toLowerCase();
  const sub = item.name !== item.id ? `<span class="mkt-dim">${escape(item.id)}</span>` : '';
  const agent = item.fromAgent ? `<div class="mkt-dim">${escape(`Made from agent ${item.fromAgent.agent}`)}</div>` : '';
  return `<tr class="mkt-row" data-key="${escape(item.key)}" data-order="${index}" data-kind="${escape(item.kind)}" data-status="${escape(item.status)}"
  data-marketplace="${escape(item.marketplace ?? 'here')}" data-lifecycle="${escape(item.lifecycle ?? 'not marked')}" data-text="${escape(search)}">
  <th scope="row"><span class="mkt-name">${escape(item.name)}</span> ${sub}${item.description ? `<div class="mkt-desc">${escape(item.description)}</div>` : ''}${agent}</th>
  <td>${escape(whereWords(item))}</td>
  <td>${escape(versionWords(item))}</td>
  <td>${escape(item.lifecycle ?? '')}</td>
  <td><span class="mkt-badge mkt-${escape(item.status)}">${escape(STATUS_WORDS[item.status])}</span>${item.status === 'installed' && !item.statusWords.includes('could not be read') ? ''
    : `<div class="mkt-words">${escape(item.statusWords)}</div>`}</td>
  <td class="mkt-actions">${buttonsHtml(item)}</td>
</tr>`;
}

function filterOptions(id: string, label: string, all: string, values: [string, string][]): string {
  return `<label class="mkt-filter"><span>${escape(label)}</span><select id="${id}" aria-label="${escape(label)}"><option value="">${escape(all)}</option>${values
    .map(([value, words]) => `<option value="${escape(value)}">${escape(words)}</option>`).join('')}</select></label>`;
}

function summaryHtml(catalog: MarketplaceCatalog): string {
  const tiles = STATUSES.filter((status) => status !== 'not-approved-yet').map((status) => `<div class="mkt-tile mkt-tile-${status}"><strong>${
    escape(String(catalog.summary.byStatus[status] ?? 0))}</strong><span>${escape(STATUS_WORDS[status])}</span></div>`).join('');
  const sources = catalog.sources.filter((source) => source.approved).map((source) => `<li>${escape(source.label)}: ${source.read
    ? escape(plural(source.items, 'item')) : '<span class="mkt-warn">not read</span>'}${source.notApproved ? ` <span class="mkt-dim">${escape(source.notApproved)}</span>` : ''}</li>`).join('');
  return `<section class="mkt-summary" aria-label="Summary"><div class="mkt-tiles">${tiles}</div>
  <p class="mkt-dim">This is what Stories use now: an install, update or removal shows here once its change is approved.</p>${sources
    ? `<ul class="mkt-sources" aria-label="Trusted marketplaces">${sources}</ul>` : '<p class="mkt-dim">This repository trusts no marketplace yet. Trust one in Workflow Studio\'s Library.</p>'}</section>`;
}

function pendingHtml(catalog: MarketplaceCatalog): string {
  const pending = catalog.items.filter((item) => item.kind === 'marketplace');
  if (!pending.length) return '';
  return `<section class="mkt-pending" aria-label="Marketplaces not approved yet"><h2>Not approved yet</h2><ul>${pending.map((item) => `<li><strong>${escape(item.name)}</strong>
    <span class="mkt-dim">${escape(item.statusWords)}</span> ${studioTargetFor('approve', item) ? `<button type="button" class="secondary" data-act="approve" data-key="${escape(item.key)}">See waiting changes</button>` : ''}</li>`)
    .join('')}</ul></section>`;
}

export function marketplacePageHtml({ catalog, busy, error, notice }: { catalog: MarketplaceCatalog | null; busy: boolean; error: string | null; notice: string | null }): string {
  const header = `<header class="mkt-bar"><h1>Marketplace</h1>
    <span class="mkt-lede">Skills, agents and workflows from the marketplaces this repository trusts, and what is installed here.</span>
    <button type="button" class="secondary" data-all-skills>All skills</button>
    <button type="button" class="secondary" data-studio>Workflow Studio</button>
    <button type="button" data-refresh ${busy ? 'disabled' : ''}>${busy ? 'Reading…' : 'Refresh'}</button></header>`;
  const messages = `${notice ? `<p class="mkt-notice" role="status">${escape(notice)}</p>` : ''}${error ? `<p class="mkt-error" role="alert">${escape(error)}</p>` : ''}${(catalog?.warnings ?? [])
    .map((warning) => `<p class="mkt-notice mkt-warn">${escape(warning)}</p>`).join('')}`;
  if (!catalog) return `<main class="mkt" id="mkt-root">${header}${messages}${busy ? '<p class="mkt-dim">Reading the trusted marketplaces and what is installed here…</p>' : ''}</main>`;
  const listed = catalog.items.filter((item) => item.kind !== 'marketplace');
  const tabs = MARKETPLACE_TABS.filter((tab) => !OPTIONAL_TABS.includes(tab.kind) || listed.some((item) => item.kind === tab.kind));
  const markets: [string, string][] = [...new Map(listed.filter((item) => item.marketplace).map((item) => [item.marketplace as string, item.marketplaceLabel ?? item.marketplace as string])).entries()]
    .sort((left, right) => (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0));
  if (listed.some((item) => !item.marketplace)) markets.push(['here', 'Only this repository']);
  const lifecycles = [...new Set(listed.map((item) => item.lifecycle ?? 'not marked'))].sort().map((value): [string, string] => [value, value]);
  const statuses = STATUSES.filter((status) => status !== 'not-approved-yet' && listed.some((item) => item.status === status)).map((status): [string, string] => [status, STATUS_WORDS[status]]);
  const tabList = `<div class="mkt-tabs" role="tablist" aria-label="Kinds of item">${tabs.map((tab, index) => {
    const count = listed.filter((item) => item.kind === tab.kind).length;
    const updates = listed.filter((item) => item.kind === tab.kind && item.status === 'update-available').length;
    return `<button type="button" role="tab" id="mkt-tab-${tab.kind}" data-tab="${tab.kind}" aria-controls="mkt-panel-${tab.kind}" aria-selected="${index === 0 ? 'true' : 'false'}"
      tabindex="${index === 0 ? '0' : '-1'}">${escape(tab.words)} <span class="mkt-count">${escape(String(count))}</span>${updates ? ` <span class="mkt-badge mkt-update-available" title="${escape(plural(updates, 'update'))} available">${escape(String(updates))}</span>` : ''}</button>`;
  }).join('')}</div>`;
  const filters = `<section class="mkt-filters" aria-label="Filters">
  <label class="mkt-filter mkt-search"><span>Search</span><input type="search" id="mkt-search" placeholder="Name, description, tag or marketplace" aria-label="Search items"></label>
  ${filterOptions('mkt-status', 'Status', 'Any status', statuses)}
  ${filterOptions('mkt-marketplace', 'From', 'Everywhere', markets)}
  ${filterOptions('mkt-lifecycle', 'Lifecycle', 'Any lifecycle', lifecycles)}
  <button type="button" class="secondary" data-clear>Clear</button>
  <span id="mkt-shown" class="mkt-dim" role="status" aria-live="polite"></span>
</section>`;
  const panels = tabs.map((tab, index) => {
    const rows = listed.filter((item) => item.kind === tab.kind);
    const empty = tab.kind === 'workflow' ? 'No workflow here was made from a marketplace agent yet: install an agent from the Agents tab.'
      : `No ${tab.words.toLowerCase()} in the trusted marketplaces or installed here.`;
    return `<div role="tabpanel" id="mkt-panel-${tab.kind}" aria-labelledby="mkt-tab-${tab.kind}" data-panel="${tab.kind}"${index === 0 ? '' : ' hidden'}>${rows.length ? `<table class="mkt-table">
  <thead><tr><th scope="col">Name</th><th scope="col">From</th><th scope="col">Version</th><th scope="col">Lifecycle</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
  <tbody>${rows.map((item) => rowHtml(item, catalog.items.indexOf(item))).join('\n')}</tbody></table>
  <p class="mkt-dim mkt-none" hidden>No item here matches these filters.</p>` : `<p class="mkt-dim">${escape(empty)}</p>`}</div>`;
  }).join('\n');
  return `<main class="mkt" id="mkt-root">${header}${messages}${summaryHtml(catalog)}${pendingHtml(catalog)}${tabList}${filters}${panels}</main>`;
}

export const MARKETPLACE_STYLE = `
.mkt { padding: 12px 16px; max-width: 1400px; }
.mkt-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mkt-bar h1 { margin: 0; font-size: 1.3em; }
.mkt-lede { flex: 1 1 260px; color: var(--vscode-descriptionForeground); }
.mkt-dim { color: var(--vscode-descriptionForeground); }
.mkt-warn { color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground)); }
.mkt-error { color: var(--vscode-errorForeground); }
.mkt-notice { color: var(--vscode-descriptionForeground); }
.mkt-tiles { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 4px; }
.mkt-tile { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 6px 10px; min-width: 110px; display: flex; flex-direction: column; }
.mkt-tile strong { font-size: 1.3em; }
.mkt-tile span { font-size: .85em; color: var(--vscode-descriptionForeground); }
.mkt-tile-update-available { border-color: var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); }
.mkt-sources { list-style: none; padding: 0; margin: 4px 0; display: flex; gap: 12px; flex-wrap: wrap; font-size: .9em; }
.mkt-pending { border: 1px solid var(--vscode-editorWarning-foreground, var(--vscode-panel-border)); border-radius: 6px; padding: 6px 10px; margin: 8px 0; }
.mkt-pending h2 { font-size: 1em; margin: 2px 0 4px; }
.mkt-pending ul { margin: 0; padding-left: 18px; }
.mkt-tabs { display: flex; gap: 4px; margin: 14px 0 0; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.mkt-tabs [role="tab"] { background: none; color: var(--vscode-foreground); border: 0; border-bottom: 2px solid transparent; padding: 6px 12px; cursor: pointer; font: inherit; }
.mkt-tabs [role="tab"][aria-selected="true"] { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.mkt-tabs [role="tab"]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.mkt-count { color: var(--vscode-descriptionForeground); margin-left: 6px; }
.mkt-filters { display: flex; gap: 8px 12px; flex-wrap: wrap; align-items: flex-end; margin: 10px 0 8px; }
.mkt-filter { display: flex; flex-direction: column; gap: 2px; font-size: .85em; }
.mkt-search { flex: 1 1 200px; }
.mkt-search input { width: 100%; min-width: 0; }
.mkt-table { width: 100%; border-collapse: collapse; font-size: .92em; }
.mkt-table th, .mkt-table td { text-align: left; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
.mkt-table tbody th { font-weight: normal; }
.mkt-name { font-weight: 600; }
.mkt-desc { color: var(--vscode-descriptionForeground); margin-top: 2px; max-width: 60ch; }
.mkt-words { font-size: .9em; color: var(--vscode-descriptionForeground); margin-top: 2px; max-width: 48ch; }
.mkt-badge { display: inline-block; border: 1px solid currentColor; border-radius: 999px; padding: 0 8px; font-size: .85em; white-space: nowrap; }
.mkt-installed { color: var(--vscode-testing-iconPassed, var(--vscode-foreground)); }
.mkt-update-available { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); font-weight: 600; }
.mkt-not-installed { color: var(--vscode-descriptionForeground); }
.mkt-local-only { color: var(--vscode-textLink-foreground, var(--vscode-foreground)); }
.mkt-not-approved-yet { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
.mkt-actions { white-space: nowrap; }
.mkt-actions button { margin: 0 4px 4px 0; }
`;

/**
 * The page's script: tabs, filters and the buttons, in the page only. Its pure parts (factsOf, matches) run without a
 * document, so a test reads them as the page does.
 */
export const MARKETPLACE_SCRIPT = String.raw`
(function () {
  var FILTERS = ['search', 'status', 'marketplace', 'lifecycle'];
  function factsOf(data) {
    return { key: data.key || '', kind: data.kind || '', status: data.status || '', marketplace: data.marketplace || '', lifecycle: data.lifecycle || '',
      order: Number(data.order) || 0, text: data.text || '' };
  }
  function matches(row, filters) {
    if (filters.status && row.status !== filters.status) return false;
    if (filters.marketplace && row.marketplace !== filters.marketplace) return false;
    if (filters.lifecycle && row.lifecycle !== filters.lifecycle) return false;
    var words = String(filters.search || '').toLowerCase().split(/\s+/).filter(Boolean);
    for (var index = 0; index < words.length; index += 1) if (row.text.indexOf(words[index]) < 0) return false;
    return true;
  }
  window.__marketplace = { factsOf: factsOf, matches: matches };
  if (typeof document === 'undefined') return;
  var api = window.__sfVscode;
  var saved = {};
  try { saved = (api && api.getState && api.getState()) || {}; } catch (error) { saved = {}; }
  var state = { tab: saved.tab || null, filters: saved.filters || {} };
  function keep() { try { if (api && api.setState) api.setState(state); } catch (error) { /* the page works without it */ } }
  function control(name) { return document.getElementById('mkt-' + name); }
  function tabs() { return Array.prototype.slice.call(document.querySelectorAll('[role="tab"]')); }
  function readFilters() {
    var filters = {};
    FILTERS.forEach(function (name) { var input = control(name); if (input) filters[name] = input.value; });
    return filters;
  }
  function writeFilters() {
    FILTERS.forEach(function (name) { var input = control(name); if (input && state.filters[name] !== undefined) input.value = state.filters[name]; });
  }
  function apply() {
    var all = tabs();
    if (!all.length) return;
    if (!all.some(function (tab) { return tab.dataset.tab === state.tab; })) state.tab = all[0].dataset.tab;
    var shown = 0; var total = 0;
    all.forEach(function (tab) {
      var selected = tab.dataset.tab === state.tab;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
      var panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (!panel) return;
      panel.hidden = !selected;
      var rows = Array.prototype.slice.call(panel.querySelectorAll('tr.mkt-row'));
      var visible = 0;
      rows.forEach(function (row) { var ok = matches(factsOf(row.dataset), state.filters); row.hidden = !ok; if (ok) visible += 1; });
      var none = panel.querySelector('.mkt-none');
      if (none) none.hidden = visible > 0 || !rows.length;
      if (selected) { shown = visible; total = rows.length; }
    });
    var count = document.getElementById('mkt-shown');
    if (count) count.textContent = shown === total ? total + (total === 1 ? ' item' : ' items') : shown + ' of ' + total + ' items';
    keep();
  }
  function choose(tab, focus) { state.tab = tab.dataset.tab; apply(); if (focus) tab.focus(); }
  writeFilters();
  // A kept choice that is gone (a marketplace no longer trusted) is dropped, so no row is hidden unseen.
  state.filters = readFilters();
  apply();
  document.addEventListener('input', function (event) { if (event.target && event.target.id && event.target.id.indexOf('mkt-') === 0) { state.filters = readFilters(); apply(); } });
  document.addEventListener('change', function (event) { if (event.target && event.target.id && event.target.id.indexOf('mkt-') === 0) { state.filters = readFilters(); apply(); } });
  document.addEventListener('keydown', function (event) {
    var tab = event.target && event.target.closest ? event.target.closest('[role="tab"]') : null;
    if (!tab) return;
    var all = tabs(); var at = all.indexOf(tab); var next = null;
    if (event.key === 'ArrowRight') next = all[(at + 1) % all.length];
    else if (event.key === 'ArrowLeft') next = all[(at - 1 + all.length) % all.length];
    else if (event.key === 'Home') next = all[0];
    else if (event.key === 'End') next = all[all.length - 1];
    if (next) { event.preventDefault(); choose(next, true); }
  });
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[role="tab"],[data-act],[data-refresh],[data-all-skills],[data-studio],[data-clear]');
    if (!target || target.disabled) return;
    if (target.getAttribute('role') === 'tab') choose(target, false);
    else if (target.dataset.act) api.postMessage({ type: 'marketplace.' + target.dataset.act, key: target.dataset.key });
    else if (target.hasAttribute('data-refresh')) api.postMessage({ type: 'marketplace.refresh' });
    else if (target.hasAttribute('data-all-skills')) api.postMessage({ type: 'marketplace.allSkills' });
    else if (target.hasAttribute('data-studio')) api.postMessage({ type: 'marketplace.studio' });
    else if (target.hasAttribute('data-clear')) { state.filters = {}; FILTERS.forEach(function (name) { var input = control(name); if (input) input.value = ''; }); apply(); }
  });
})();
`;
