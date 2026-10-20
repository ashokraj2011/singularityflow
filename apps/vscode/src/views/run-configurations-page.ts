/**
 * The Run/Debug Configurations page, laid out like IntelliJ IDEA's dialog. [IntelliJ amendment §2]
 *
 * Markup only. Left: the configurations grouped by type, with a toolbar (Add from a template per
 * type, Copy, Remove, Move up/down, Import from IDE run configurations). Right: the selected
 * configuration's form for its type, a Base | <environment> tab strip for per-environment overrides
 * ("differs from Base" beside each overridden field), the environment variables table, Before
 * launch, URL and readiness, debug, and the read-only Command line the engine resolves. The footer
 * marks unsaved changes and offers Apply and OK.
 *
 * Regions marked `data-cf-region` are replaced in place by the host after an edit, so typing never
 * loses focus. A secret never appears here: the table holds literal non-secret values, and a
 * privately bound variable is a name with the `env bind` command beside it.
 *
 * The type icons are local SVG marks in the shape of the Codicons VS Code uses: the page's content
 * security policy loads no font (icons.ts says why).
 */
import { brandLockup, escape, icon } from './webview.ts';
import {
  applyProblem, beforeLaunchLines, bindWords, CONFIGURATION_TYPES, differsFromBase, draftDirty, effectiveValue, envRows, isModified,
  overridableFields, runtimeOf, TYPE_SPECS, typeOf, type ConfigPreview, type DeclaredBlock, type DraftConfiguration, type EditorDraft,
  type FieldSpec, type PlanFacts, type SavedEditorState, type Tab, type TypeGlyph
} from './run-configurations-model.ts';

export interface EditorPageState {
  capability: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  draft: EditorDraft | null;
  block: DeclaredBlock | null;
  facts: PlanFacts[];
  selected: string | null;
  tab: Tab;
  /** The last refused edit of the selected configuration: where, and why (never the value). */
  refused: { key: string; tab: Tab; field: string; message: string } | null;
  preview: ConfigPreview | null;
  previewState: 'idle' | 'pending' | 'unavailable';
  previewNote: string | null;
  confirmDiscard: boolean;
  /** singularity/capabilities.yml changed since this draft started. */
  stale: boolean;
  /** environments.yml additions from the last import, names only, to copy. */
  environmentsDraft: string | null;
  saved: SavedEditorState | null;
}

const GLYPHS: Record<TypeGlyph, string> = {
  leaf: '<path d="M5 19C5 10 11 5 20 4c0 9-5 15-14 15"/><path d="M5 19c3-5 6-8 10-10"/>',
  java: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H15.5M8.5 3.5v3M11.5 3.5v3"/>',
  maven: '<path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/>',
  gradle: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12.5 9 5 9-5M3 16.5l9 5 9-5"/>',
  python: '<path d="M12 3c-3.5 0-4 1.5-4 3v2h5v1H6.5C4.5 9 3 10.5 3 13s1.5 4 3.5 4H8v-2.5C8 13 9 12 10.5 12h4c1.4 0 2.5-1.1 2.5-2.5V6c0-1.5-1-3-5-3z"/><path d="M12 21c3.5 0 4-1.5 4-3v-2h-5v-1h6.5c2 0 3.5-1.5 3.5-4"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  node: '<path d="m12 2.5 8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3z"/><path d="M9.5 9v6M14.5 9c-1.6 0-2.5.6-2.5 1.6 0 2.2 5 1 5 3.2 0 1-1 1.7-2.6 1.7"/>',
  npm: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M7 15v-5h3v5M14 10v5M17 10v5"/>',
  go: '<path d="M2.5 10h5M3.5 13h4M5 16h3"/><ellipse cx="15" cy="12.5" rx="6.5" ry="5"/><circle cx="13" cy="11" r="1"/><circle cx="17" cy="11" r="1"/>',
  dotnet: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 16V8l4.5 8V8M15 8v8h3"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M12.5 15H17"/>'
};

export function glyph(name: TypeGlyph): string {
  return `<svg class="ico cf-glyph" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`;
}

const selectedConfiguration = (state: EditorPageState): { configuration: DraftConfiguration; index: number } | null => {
  const index = state.draft?.configurations.findIndex((item) => item.key === state.selected) ?? -1;
  return index >= 0 ? { configuration: state.draft!.configurations[index]!, index } : null;
};

const labelOf = (configuration: DraftConfiguration): string => String(configuration.entry.name ?? configuration.entry.id ?? 'Unnamed');

function errorsFor(state: EditorPageState, index: number): ConfigPreview['errors'] {
  return state.previewState === 'pending' ? [] : (state.preview?.errors ?? []).filter((error) => error.index === index);
}

// ---------------------------------------------------------------------------------------------
// Regions the host replaces after an edit

export function listRegionHtml(state: EditorPageState): string {
  const draft = state.draft;
  if (!draft || !state.block) return '';
  if (!draft.configurations.length) return '<p class="muted cf-empty">No run configurations yet. Add one from a template, or import them from your IDE\'s run configurations.</p>';
  const groups = [...CONFIGURATION_TYPES, null].flatMap((type) => {
    const items = draft.configurations.map((configuration, index) => ({ configuration, index }))
      .filter(({ configuration }) => typeOf(configuration.entry) === type);
    if (!items.length) return [];
    const head = type ? `${glyph(TYPE_SPECS[type].glyph)}${escape(TYPE_SPECS[type].label)}` : `${icon('warning')}Other types`;
    return [`<div class="cf-group" data-cf-group="${escape(type ?? 'other')}"><div class="cf-group-head">${head}</div><ul class="cf-items">${items.map(({ configuration, index }) => {
      const selected = configuration.key === state.selected;
      const modified = isModified(configuration, state.block!);
      const errors = errorsFor(state, index).length;
      return `<li><button type="button" class="cf-item${selected ? ' selected' : ''}" data-cf-select="${escape(configuration.key)}" aria-current="${selected}">
        ${type ? glyph(TYPE_SPECS[type].glyph) : icon('warning')}<span class="cf-item-name">${escape(labelOf(configuration))}</span>
        <small class="muted">${escape(String(configuration.entry.id ?? ''))}</small>
        ${modified ? '<span class="cf-modified" title="Unsaved changes" data-cf-modified>●</span>' : ''}
        ${errors ? `<span class="cf-error-mark" title="${errors} error${errors === 1 ? '' : 's'}" data-cf-errors="${errors}">!</span>` : ''}</button></li>`;
    }).join('')}</ul></div>`];
  });
  return groups.join('');
}

export function tabsRegionHtml(state: EditorPageState): string {
  const found = selectedConfiguration(state);
  if (!found) return '';
  const { entry } = found.configuration;
  const environments = Array.isArray(entry.environments) ? entry.environments.map(String) : [];
  if (!environments.length) return '<p class="muted cf-tabs-note">No environments: the configuration runs as it is. Name environments under Run to override fields for each one.</p>';
  const facts = state.facts.find((item) => item.id === entry.id);
  const tabs = [{ id: 'base', label: 'Base', status: null as string | null, count: 0 },
    ...environments.map((name) => ({ id: name, label: name, status: facts?.environments.find((choice) => choice.name === name)?.status ?? null,
      count: differsFromBase(entry, name).length }))];
  return `<div class="cf-tabs" role="tablist" aria-label="Base and per-environment overrides">${tabs.map((tab) => `<button type="button" role="tab" class="cf-tab${tab.id === state.tab ? ' active' : ''}" data-cf-tab="${escape(tab.id)}" aria-selected="${tab.id === state.tab}">${escape(tab.label)}${
    tab.id === environments[0] ? ' <small class="muted">default</small>' : ''}${tab.status && tab.status !== 'bound' ? ` <small class="muted">${escape(tab.status === 'undeclared' ? 'not declared' : 'not bound')}</small>` : ''}${
    tab.count ? ` <span class="cf-badge" title="${tab.count} field${tab.count === 1 ? '' : 's'} differ from Base">${tab.count}</span>` : ''}</button>`).join('')}</div>
    <p class="muted cf-tabs-note">${state.tab === 'base' ? 'Base applies to every environment. Choose an environment to override fields for it alone.'
    : `A field you change here applies to ${escape(state.tab)} only and is marked "differs from Base". Use Base takes the override away.`}</p>`;
}

/** The note under one field: the refusal or the engine's error for it, and whether it differs from Base. */
export function noteRegionHtml(state: EditorPageState, field: string): string {
  const found = selectedConfiguration(state);
  if (!found) return '';
  const { configuration, index } = found;
  const refused = state.refused && state.refused.key === configuration.key && state.refused.tab === state.tab && state.refused.field === field ? state.refused.message : null;
  const engine = errorsFor(state, index).filter((error) => error.field === field && (state.tab === 'base' ? error.environment === null : error.environment === state.tab));
  const differs = state.tab !== 'base' && differsFromBase(configuration.entry, state.tab).includes(field);
  const overridable = state.tab !== 'base' && overridableFields(typeOf(configuration.entry) ?? 'command').includes(field);
  return `${refused ? `<span class="cf-field-error" role="alert">${icon('blocked')}${escape(refused)}</span>` : ''}${engine.map((error) =>
    `<span class="cf-field-error" role="alert" data-cf-engine-error>${icon('blocked')}${escape(error.message)}</span>`).join('')}${differs
    ? `<span class="cf-differs" data-cf-differs="${escape(field)}">differs from Base</span> <button type="button" class="link" data-cf-action="reset-field" data-cf-field="${escape(field)}">Use Base</button>`
    : overridable ? '<span class="muted cf-same">same as Base</span>' : ''}`;
}

export function previewRegionHtml(state: EditorPageState): string {
  const found = selectedConfiguration(state);
  if (!found) return '';
  const { configuration, index } = found;
  const head = '<h3>Command line</h3>';
  if (state.previewState === 'unavailable') {
    return `${head}<p class="notice" role="status">${escape(state.previewNote ?? 'The command line preview is not available.')}</p>`;
  }
  if (state.previewState === 'pending' && !state.preview) return `${head}<p class="muted" role="status">Asking the engine how this configuration runs…</p>`;
  const entry = state.preview?.entries.find((item) => item.index === index);
  const environments = Array.isArray(configuration.entry.environments) ? configuration.entry.environments.map(String) : [];
  const rows = (entry?.environments ?? []).map((environment) => {
    const current = environment.name === (state.tab === 'base' ? environments[0] ?? null : state.tab);
    const extra = [
      environment.envNames.length ? `Variables: ${environment.envNames.join(', ')} <span class="muted">(values never shown)</span>` : '',
      environment.beforeLaunch.length ? `Before launch: ${environment.beforeLaunch.map((step) => `<code>${escape(step)}</code>`).join(' → ')}` : ''
    ].filter(Boolean);
    return `<tr data-cf-preview-env="${escape(environment.name ?? '')}"${current ? ' class="current"' : ''}><th>${escape(environment.name ?? 'No environment')}${environment.name && environment.name === environments[0] ? ' <small class="muted">default</small>' : ''}</th>
      <td>${environment.commandLine ? `<code class="cf-command-line">${escape(environment.commandLine)}</code>` : '<span class="muted">Not resolved: see the errors below.</span>'}${extra.length ? `<br><small>${extra.join('<br>')}</small>` : ''}</td></tr>`;
  }).join('');
  const errors = errorsFor(state, index);
  const general = state.previewState === 'pending' ? [] : (state.preview?.errors ?? []).filter((error) => error.index === null);
  return `${head}${state.previewState === 'pending' ? '<p class="muted" role="status">Updating…</p>' : ''}
    ${rows ? `<table class="cf-command" aria-label="Command line per environment"><tbody>${rows}</tbody></table>` : state.previewState === 'pending' ? '' : '<p class="muted">The engine resolved no command line for this configuration yet.</p>'}
    ${[...errors, ...general].length ? `<ul class="cf-errors">${[...errors, ...general].map((error) => `<li role="alert" data-cf-error-field="${escape(error.field ?? '')}">${icon('blocked')}${
      error.environment ? `<strong>${escape(error.environment)}</strong> · ` : ''}${error.field ? `<code>${escape(error.field)}</code>: ` : ''}${escape(error.message)}</li>`).join('')}</ul>` : ''}
    <p class="muted cf-preview-note">Read-only: the engine resolves it from the form (app config preview). It is what Run starts.</p>`;
}

export function statusRegionHtml(state: EditorPageState): string {
  if (!state.draft || !state.block) return '';
  const dirty = draftDirty(state.draft, state.block);
  const problem = dirty ? applyProblem(state.draft, state.block, state.previewState === 'pending' ? null : state.preview) : null;
  const disabled = state.busy || !dirty ? ' disabled' : '';
  return `${dirty ? '<span class="cf-dirty" data-cf-dirty>● Unsaved changes</span>' : '<span class="muted" data-cf-clean>No unsaved changes</span>'}
    ${problem ? `<small class="cf-apply-problem" role="status">${escape(problem)}</small>` : ''}
    <span class="grow"></span>
    ${state.confirmDiscard ? `<span role="alert">Discard every unsaved change?</span>
      <button type="button" class="secondary" data-cf-action="discard-confirm">Discard</button>
      <button type="button" class="secondary" data-cf-action="discard-cancel">Keep editing</button>`
    : `<button type="button" class="secondary" data-cf-action="discard"${disabled}>Discard changes</button>`}
    <button type="button" class="secondary" data-cf-action="apply"${disabled}>Apply…</button>
    <button type="button" data-cf-action="ok"${disabled}>OK…</button>`;
}

// ---------------------------------------------------------------------------------------------
// The form

function fieldInput(spec: FieldSpec, value: unknown, disabled: boolean): string {
  const name = ` data-cf-field="${escape(spec.key)}" aria-label="${escape(spec.label)}"${disabled ? ' disabled' : ''}`;
  const placeholder = spec.placeholder ? ` placeholder="${escape(spec.placeholder)}"` : '';
  switch (spec.kind) {
    case 'list': {
      const lines = Array.isArray(value) ? value.map(String) : [];
      return `<textarea${name}${placeholder} rows="${Math.min(8, Math.max(2, lines.length + 1))}" spellcheck="false">${escape(lines.join('\n'))}</textarea>`;
    }
    case 'properties': {
      const lines = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([key, given]) => `${key}=${String(given)}`) : [];
      return `<textarea${name}${placeholder} rows="${Math.min(8, Math.max(2, lines.length + 1))}" spellcheck="false">${escape(lines.join('\n'))}</textarea>`;
    }
    case 'select':
      return `<select${name}>${spec.required ? '' : `<option value=""${value === undefined ? ' selected' : ''}>(default)</option>`}${(spec.options ?? []).map((option) =>
        `<option value="${escape(option)}"${String(value ?? '') === option ? ' selected' : ''}>${escape(option)}</option>`).join('')}</select>`;
    case 'boolean':
      return `<input type="checkbox"${name}${value === true ? ' checked' : ''}>`;
    case 'port':
      return `<input type="number" min="1" max="65535"${name}${placeholder} value="${escape(value ?? '')}">`;
    default:
      return `<input type="text"${name}${placeholder} value="${escape(value ?? '')}" spellcheck="false" autocomplete="off">`;
  }
}

function fieldRow(state: EditorPageState, spec: FieldSpec, value: unknown, { disabled = false, after = '' } = {}): string {
  const inline = spec.kind === 'boolean';
  return `<div class="cf-field${inline ? ' inline' : ''}" data-cf-row="${escape(spec.key)}">
    <label><span>${escape(spec.label)}${spec.required ? ' <small class="muted">required</small>' : ''}</span>${fieldInput(spec, value, disabled)}${after}</label>
    ${spec.help ? `<small class="muted">${escape(spec.help)}</small>` : ''}
    <div class="cf-note" data-cf-region="note-${escape(spec.key)}">${noteRegionHtml(state, spec.key)}</div></div>`;
}

const envRow = (name: string, value: string): string => `<tr data-cf-env-row><td><input type="text" data-cf-env-name value="${escape(name)}" aria-label="Variable name" spellcheck="false" autocomplete="off"></td>
      <td><input type="text" data-cf-env-value value="${escape(value)}" aria-label="Value${name ? ` of ${escape(name)}` : ''}" spellcheck="false" autocomplete="off"></td>
      <td><button type="button" class="secondary compact-action" data-cf-action="env-remove" aria-label="Remove${name ? ` ${escape(name)}` : ''}">${icon('remove')}</button></td></tr>`;

function envSection(state: EditorPageState, configuration: DraftConfiguration, index: number): string {
  const { entry } = configuration;
  const tab = state.tab;
  const environments = Array.isArray(entry.environments) ? entry.environments.map(String) : [];
  const environment = tab === 'base' ? environments[0] ?? null : tab;
  const rows = envRows(entry, tab).map((row) => envRow(row.name, row.value)).join('');
  const fromBase = tab === 'base' ? [] : Object.entries((entry.env && typeof entry.env === 'object' ? entry.env : {}) as Record<string, unknown>);
  const literal = new Set(Object.keys((effectiveValue(entry, tab, 'env') ?? {}) as Record<string, unknown>));
  const resolved = state.preview?.entries.find((item) => item.index === index)?.environments.find((item) => item.name === environment)?.envNames
    ?? (environment ? state.facts.find((item) => item.id === entry.id)?.envNames[environment] : undefined) ?? [];
  const bound = resolved.filter((name) => !literal.has(name));
  return `<fieldset class="cf-section"><legend>Environment variables${tab === 'base' ? '' : ` for ${escape(tab)}`}</legend>
    <table class="cf-env"><thead><tr><th>Name</th><th>Value</th><th><span class="sr-only">Remove</span></th></tr></thead><tbody data-cf-env>${rows}</tbody></table><template data-cf-env-template>${envRow('', '')}</template>
    <p><button type="button" class="secondary compact-action" data-cf-action="env-add">${icon('add')}Add variable</button>
      <small class="muted">Literal values only, never a secret. A name or value that looks like a secret is refused.</small></p>
    <div class="cf-note" data-cf-region="note-env">${noteRegionHtml(state, 'env')}</div>
    ${fromBase.length ? `<p class="muted cf-from-base">Also from Base: ${fromBase.map(([name, value]) => `<code>${escape(name)}=${escape(String(value))}</code>`).join(' ')}</p>` : ''}
    <div class="cf-private" data-cf-private>
      ${bound.length ? `<p>${bound.map((name) => `<code>${escape(name)}</code>`).join(' ')}: <strong>bound privately on this computer</strong>, from singularity/environments.yml. Values are never shown or typed here.</p>` : ''}
      <p class="muted">Secrets and endpoints belong in singularity/environments.yml as names; each person binds the values with their own secret helper, on standard input:</p>
      <p><code>${escape(bindWords(environment))}</code>${environment ? ` <button type="button" class="secondary compact-action" data-cf-action="copy-bind" data-cf-environment="${escape(environment)}">Copy</button>` : ''}</p>
    </div></fieldset>`;
}

function runSection(state: EditorPageState, configuration: DraftConfiguration): string {
  const { entry } = configuration;
  const ready = (entry.ready && typeof entry.ready === 'object' ? entry.ready : {}) as Record<string, unknown>;
  const kind = ready.log !== undefined ? 'log' : 'http';
  const environments = Array.isArray(entry.environments) ? entry.environments.map(String) : [];
  return `<fieldset class="cf-section"><legend>Run</legend>
    ${fieldRow(state, { key: 'url', label: 'URL', kind: 'text', placeholder: 'http://127.0.0.1:8080/', help: 'Opened in the browser once ready. Loopback only: 127.0.0.1, localhost or [::1].' }, entry.url)}
    <div class="cf-field" data-cf-row="ready"><label><span>Ready when</span>
      <span class="cf-inline"><select data-cf-field="ready.kind" aria-label="Readiness check"><option value="http"${kind === 'http' ? ' selected' : ''}>this path answers below 500</option><option value="log"${kind === 'log' ? ' selected' : ''}>the output shows</option></select>
      <input type="text" data-cf-field="ready.value" aria-label="${kind === 'http' ? 'Readiness path' : 'Ready text'}" value="${escape(ready[kind] ?? '')}" placeholder="${kind === 'http' ? '/actuator/health' : 'Started'}" spellcheck="false">
      <input type="number" min="1" max="600" data-cf-field="ready.timeout" aria-label="Timeout in seconds" value="${typeof ready.timeoutMs === 'number' ? Math.round(ready.timeoutMs / 1000) : ''}" placeholder="60"> s</span></label>
      <div class="cf-note" data-cf-region="note-ready.value">${noteRegionHtml(state, 'ready.value')}</div><div class="cf-note" data-cf-region="note-ready.timeout">${noteRegionHtml(state, 'ready.timeout')}</div></div>
    ${fieldRow(state, { key: 'environments', label: 'Environments', kind: 'text', placeholder: 'dev, qa', help: 'From singularity/environments.yml, separated by commas; the first is the default. Each one gets a tab above for its overrides; removing one removes its overrides.' }, environments.join(', '))}
    ${entry.repository !== undefined ? fieldRow(state, { key: 'repository', label: 'Repository', kind: 'text', help: 'One of the capability\'s repositories.' }, entry.repository) : ''}
  </fieldset>`;
}

function debugSection(state: EditorPageState, configuration: DraftConfiguration): string {
  const { entry } = configuration;
  const type = typeOf(entry) ?? 'command';
  const debug = entry.debug && typeof entry.debug === 'object' ? entry.debug as Record<string, unknown> : null;
  const runtime = runtimeOf(entry);
  const body = debug ? `
    ${type === 'command' ? fieldRow(state, { key: 'debug.runtime', label: 'Debugger', kind: 'select', options: ['java', 'python', 'node', 'go', 'dotnet'], required: true }, debug.runtime) : ''}
    ${runtime === 'dotnet' ? '<p class="muted">.NET: VS Code attaches to the started process by its ID; there is no port.</p>'
    : fieldRow(state, { key: 'debug.port', label: 'Debug port', kind: 'port', placeholder: '5005', help: 'The debugger listens on 127.0.0.1 only.' }, debug.port)}
    ${runtime === 'java' || runtime === 'node' ? fieldRow(state, { key: 'debug.suspend', label: 'Wait for the debugger before running', kind: 'boolean' }, debug.suspend) : ''}` : '';
  return `<fieldset class="cf-section"><legend>Debug</legend>
    ${fieldRow(state, { key: 'debug.enabled', label: `Offer Debug${runtime && type !== 'command' ? ` (${runtime})` : ''}`, kind: 'boolean' }, Boolean(debug))}${body}</fieldset>`;
}

function formHtml(state: EditorPageState): string {
  const found = selectedConfiguration(state);
  if (!found) {
    return `<div class="empty cf-nothing"><p>${state.draft?.configurations.length ? 'Choose a configuration on the left.' : 'Add a configuration from a template (Add), or import your IDE\'s run configurations.'}</p></div>`;
  }
  const { configuration, index } = found;
  const { entry } = configuration;
  const type = typeOf(entry);
  const base = state.tab === 'base';
  if (!type) {
    return `<section class="cf-form" data-cf-key="${escape(configuration.key)}" data-cf-current-tab="base"><h2>${icon('warning')}${escape(labelOf(configuration))}</h2>
      <p class="notice">Its type ${escape(JSON.stringify(entry.type))} is not one this VS Code edits. It is kept exactly as declared; Copy and Remove still work.</p></section>`;
  }
  const spec = TYPE_SPECS[type];
  const fields = spec.fields.map((field) => fieldRow(state, field, effectiveValue(entry, state.tab, field.key))).join('');
  const appended = type === 'command' && !base
    ? fieldRow(state, { key: 'appended', label: `Arguments appended for ${state.tab}`, kind: 'list', help: 'One per line, added after the command.' }, effectiveValue(entry, state.tab, 'appended')) : '';
  return `<section class="cf-form" data-cf-key="${escape(configuration.key)}" data-cf-current-tab="${escape(state.tab)}">
    <div class="cf-identity">
      ${base ? fieldRow(state, { key: 'name', label: 'Name', kind: 'text', placeholder: String(entry.id ?? '') }, entry.name)
    + fieldRow(state, { key: 'id', label: 'ID', kind: 'text', help: 'Lower-case kebab case; Run and app start use it.' }, entry.id)
    : `<h2>${escape(labelOf(configuration))} <small class="muted">${escape(String(entry.id ?? ''))}</small></h2>`}
      <span class="pill cf-type">${glyph(spec.glyph)}${escape(spec.label)}</span>
    </div>
    <p class="muted cf-runs-as">Runs as ${escape(spec.runsAs)}.</p>
    <div data-cf-region="tabs">${tabsRegionHtml(state)}</div>
    <fieldset class="cf-section"><legend>Configuration</legend>${fields}${appended}
      ${fieldRow(state, { key: 'workingDirectory', label: 'Working directory', kind: 'path', placeholder: '.', help: 'Relative to the repository; empty is its root.' },
    effectiveValue(entry, state.tab, 'workingDirectory'), { after: ` <button type="button" class="secondary compact-action" data-cf-action="browse" data-cf-field="workingDirectory">${icon('directory')}Browse…</button>` })}
    </fieldset>
    ${envSection(state, configuration, index)}
    <fieldset class="cf-section"><legend>Before launch</legend>
      ${fieldRow(state, { key: 'beforeLaunch', label: 'Steps', kind: 'list', placeholder: '../../mvnw -q compile', help: 'One command per line, run in order before the application starts; a failing step stops the start. Arguments split at spaces; quote one that has spaces. No shell: nothing is expanded.' },
    beforeLaunchLines(entry, state.tab).split('\n').filter(Boolean))}
    </fieldset>
    ${base ? `${runSection(state, configuration)}${debugSection(state, configuration)}`
    : '<p class="muted cf-base-only">Name, URL, readiness, environments and debug are set on Base, for every environment.</p>'}
    <section class="cf-preview" data-cf-region="preview">${previewRegionHtml(state)}</section>
  </section>`;
}

export function runConfigurationsHtml(state: EditorPageState): string {
  const header = `<header class="inbox-header cf-header"><div>${brandLockup()}<p class="eyebrow">Run/Debug Configurations</p>
      <h1>${icon('start', { size: 24 })}Run configurations · ${escape(state.capability)}</h1>
      <p class="meta">Typed run configurations from singularity/capabilities.yml, edited like an IDE's. Nothing is written until you review the change after Apply or OK.</p></div>
      <div class="header-actions"><button type="button" class="secondary" data-cf-action="refresh"${state.busy ? ' disabled' : ''}>${icon('refresh')}Refresh</button></div></header>`;
  const messages = `${state.loading ? '<div class="notice" role="status">Reading the run configurations…</div>' : ''}
    ${state.notice ? `<div class="notice ok" role="status" data-cf-notice>${escape(state.notice)}${state.environmentsDraft
    ? ' <button type="button" class="secondary compact-action" data-cf-action="copy-environments">Copy the environments.yml additions</button>' : ''}</div>` : ''}
    ${state.error ? `<div class="notice error" role="alert">${icon('blocked')}${escape(state.error)}</div>` : ''}
    ${state.stale ? '<div class="notice" role="status">singularity/capabilities.yml changed since these edits began. The review after Apply shows the difference from what is declared now.</div>' : ''}`;
  if (!state.draft || !state.block) return `${header}${messages}`;
  const found = selectedConfiguration(state);
  const one = found ? '' : ' disabled';
  const addMenu = CONFIGURATION_TYPES.map((type) => `<button type="button" role="menuitem" data-cf-add="${type}">${glyph(TYPE_SPECS[type].glyph)}${escape(TYPE_SPECS[type].label)}</button>`).join('');
  const saved = state.saved ? JSON.stringify(state.saved).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026') : 'null';
  return `${header}${messages}
  <div class="cf-layout">
    <aside class="cf-side" aria-label="Run configurations">
      <div class="cf-toolbar" role="toolbar" aria-label="Configurations">
        <details class="cf-add"><summary class="button" title="Add New Configuration" aria-label="Add New Configuration">${icon('add')}Add</summary>
          <div class="cf-menu" role="menu" aria-label="Add New Configuration">${addMenu}</div></details>
        <button type="button" class="secondary compact-action" data-cf-action="copy" title="Copy Configuration"${one}>Copy</button>
        <button type="button" class="secondary compact-action" data-cf-action="remove" title="Remove Configuration"${one}>${icon('remove')}<span class="sr-only">Remove</span></button>
        <button type="button" class="secondary compact-action" data-cf-action="up" title="Move Up"${one}>${icon('up')}<span class="sr-only">Move up</span></button>
        <button type="button" class="secondary compact-action" data-cf-action="down" title="Move Down"${one}>${icon('down')}<span class="sr-only">Move down</span></button>
        <button type="button" class="secondary compact-action" data-cf-action="import" title="Import from IDE run configurations"${state.busy ? ' disabled' : ''}>Import…</button>
      </div>
      <div class="cf-list" data-cf-region="list">${listRegionHtml(state)}</div>
    </aside>
    <main class="cf-main">${formHtml(state)}</main>
  </div>
  <footer class="cf-footer" data-cf-region="status">${statusRegionHtml(state)}</footer>
  <script type="application/json" id="cf-saved">${saved}</script>`;
}

export const RUN_CONFIGURATIONS_STYLE = `
.cf-layout { display:grid; grid-template-columns:minmax(14rem,18rem) minmax(0,1fr); gap:1rem; align-items:start; }
@media (max-width:760px) { .cf-layout { grid-template-columns:1fr; } }
.cf-side { position:sticky; top:.5rem; z-index:2; border:var(--sf-border); border-radius:6px; padding:.4rem; }
.cf-list { max-height:calc(100vh - 13rem); overflow:auto; }
.cf-toolbar { display:flex; flex-wrap:wrap; gap:.25rem; align-items:center; padding-bottom:.4rem; border-bottom:var(--sf-border); margin-bottom:.4rem; }
.cf-toolbar .compact-action, .cf-add summary { padding:.2rem .45rem; }
.cf-add { position:relative; }
.cf-add summary { list-style:none; cursor:pointer; display:inline-flex; gap:.3rem; align-items:center; border-radius:4px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.cf-add summary::-webkit-details-marker { display:none; }
.cf-menu { position:absolute; z-index:5; top:100%; left:0; min-width:13rem; display:grid; padding:.25rem; border:var(--sf-border); border-radius:6px; background:var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow:0 4px 14px rgba(0,0,0,.25); }
.cf-menu button { display:flex; gap:.45rem; align-items:center; justify-content:flex-start; background:transparent; color:var(--vscode-menu-foreground, inherit); border:0; text-align:left; padding:.3rem .45rem; }
.cf-menu button:hover, .cf-menu button:focus { background:var(--vscode-list-hoverBackground); }
.cf-group-head { display:flex; gap:.35rem; align-items:center; font-weight:600; margin:.4rem 0 .15rem; }
.cf-items { list-style:none; margin:0; padding:0 0 0 .6rem; }
.cf-item { width:100%; display:flex; gap:.35rem; align-items:center; text-align:left; background:transparent; color:inherit; border:0; border-radius:4px; padding:.25rem .35rem; }
.cf-item:hover { background:var(--vscode-list-hoverBackground); }
.cf-item.selected { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
.cf-item-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.cf-item small { margin-left:auto; }
.cf-modified { color:var(--vscode-gitDecoration-modifiedResourceForeground, #d7a000); }
.cf-error-mark { color:var(--vscode-errorForeground); font-weight:700; }
.cf-identity { display:flex; flex-wrap:wrap; gap:.6rem 1rem; align-items:flex-end; }
.cf-identity .cf-field { min-width:14rem; }
.cf-identity h2 { display:flex; gap:.5rem; align-items:baseline; margin:0; }
.cf-same { font-size:.8rem; }
.cf-type { display:inline-flex; gap:.35rem; align-items:center; }
.cf-tabs { display:flex; flex-wrap:wrap; gap:0; border-bottom:var(--sf-border); margin:.6rem 0 .3rem; }
.cf-tab { display:inline-flex; gap:.35rem; align-items:baseline; background:transparent; color:inherit; border:0; border-bottom:2px solid transparent; border-radius:0; padding:.35rem .75rem; }
.cf-tab.active { border-bottom-color:var(--vscode-focusBorder); font-weight:600; }
.cf-badge { display:inline-block; min-width:1.1rem; padding:0 .3rem; border-radius:.6rem; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); font-size:.75rem; text-align:center; }
.cf-section { border:var(--sf-border); border-radius:6px; margin:.7rem 0; padding:.5rem .75rem .75rem; }
.cf-section legend { font-weight:600; padding:0 .3rem; }
.cf-field { display:grid; gap:.15rem; margin:.45rem 0; }
.cf-field label { display:grid; gap:.2rem; }
.cf-field.inline label { display:flex; flex-direction:row-reverse; justify-content:flex-end; gap:.45rem; align-items:center; }
.cf-field input[type=text], .cf-field input[type=number], .cf-field textarea, .cf-field select, .cf-env input { font-family:var(--vscode-editor-font-family); width:100%; box-sizing:border-box; }
.cf-field input[type=number] { max-width:9rem; }
.cf-inline { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.cf-inline select, .cf-inline input[type=text] { width:auto; flex:1 1 12rem; }
.cf-inline input[type=number] { width:6rem; }
.cf-field label:has(button) { grid-template-columns:1fr auto; }
.cf-field label:has(button) > span { grid-column:1 / -1; }
.cf-note:empty { display:none; }
.cf-note { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.cf-field-error { color:var(--vscode-errorForeground); display:inline-flex; gap:.3rem; align-items:flex-start; overflow-wrap:anywhere; }
.cf-differs { font-size:.8rem; padding:0 .4rem; border-radius:.6rem; background:var(--vscode-gitDecoration-modifiedResourceForeground, #d7a000); color:var(--vscode-editor-background); }
.cf-env { width:100%; border-collapse:collapse; }
.cf-env td, .cf-env th { padding:.15rem .25rem; text-align:left; }
.cf-env td:last-child { width:2.5rem; }
.cf-private { border-left:3px solid var(--vscode-textLink-foreground); padding:.1rem .6rem; margin-top:.5rem; }
.cf-private code, .cf-from-base code { overflow-wrap:anywhere; }
.cf-preview { border:var(--sf-border); border-radius:6px; margin:.7rem 0; padding:.5rem .75rem; background:var(--vscode-textCodeBlock-background, transparent); }
.cf-preview h3 { margin:.2rem 0 .4rem; }
.cf-command { width:100%; border-collapse:collapse; }
.cf-command th { text-align:left; white-space:nowrap; vertical-align:top; padding:.25rem .8rem .25rem 0; }
.cf-command td { padding:.25rem 0; }
.cf-command tr.current th { color:var(--vscode-textLink-foreground); }
.cf-command-line { white-space:pre-wrap; overflow-wrap:anywhere; }
.cf-errors { margin:.4rem 0; padding-left:1rem; color:var(--vscode-errorForeground); }
.cf-errors li { overflow-wrap:anywhere; }
.cf-footer { position:sticky; bottom:0; z-index:3; display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; padding:.5rem 0; margin-top:.75rem; border-top:var(--sf-border); background:var(--vscode-editor-background); }
.cf-footer .grow { flex:1; }
.cf-dirty { color:var(--vscode-gitDecoration-modifiedResourceForeground, #d7a000); font-weight:600; }
.cf-apply-problem { color:var(--vscode-errorForeground); }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
`;

/**
 * Change, click and patch handling. It reads only what the markup above wrote; the host checks every
 * field again. A field is posted when it changes (on leaving it, or Enter), never per keystroke, so a
 * secret typed one character at a time is judged whole and no prefix of it is ever kept. The page
 * keeps only the draft the host sends back (webview state), never what was refused.
 */
export const RUN_CONFIGURATIONS_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  const previous = api.getState ? api.getState() : null;
  api.postMessage({ type: 'config.ready', saved: previous || null });
  try { const kept = JSON.parse(document.getElementById('cf-saved').textContent); if (kept && api.setState) api.setState(kept); } catch (error) { /* nothing kept */ }
  const form = () => document.querySelector('[data-cf-key]');
  const key = () => (form() && form().dataset.cfKey) || '';
  const tab = () => (form() && form().dataset.cfCurrentTab) || 'base';
  const rows = () => [...document.querySelectorAll('[data-cf-env-row]')].map((row) => ({
    name: row.querySelector('[data-cf-env-name]').value, value: row.querySelector('[data-cf-env-value]').value }));
  const envMessage = () => ({ type: 'config.env', key: key(), tab: tab(), rows: rows() });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.closest('[data-cf-env-row]')) return api.postMessage(envMessage());
    if (target.dataset && target.dataset.cfField) api.postMessage({ type: 'config.field', key: key(), tab: tab(), field: target.dataset.cfField,
      value: target.type === 'checkbox' ? String(target.checked) : target.value });
  });
  document.addEventListener('click', (event) => {
    const target = event.target.closest && event.target.closest('[data-cf-select],[data-cf-tab],[data-cf-add],[data-cf-action]');
    if (!target || target.disabled) return;
    event.preventDefault();
    const action = target.dataset.cfAction;
    if (action === 'env-add') {
      const row = document.querySelector('[data-cf-env-template]').content.firstElementChild.cloneNode(true);
      document.querySelector('[data-cf-env]').appendChild(row);
      row.querySelector('input').focus();
      return;
    }
    if (action === 'env-remove') { target.closest('[data-cf-env-row]').remove(); return api.postMessage(envMessage()); }
    if (target.dataset.cfSelect) api.postMessage({ type: 'config.select', key: target.dataset.cfSelect });
    else if (target.dataset.cfTab) api.postMessage({ type: 'config.tab', key: key(), tab: target.dataset.cfTab });
    else if (target.dataset.cfAdd) { const menu = target.closest('details'); if (menu) menu.removeAttribute('open'); api.postMessage({ type: 'config.add', configurationType: target.dataset.cfAdd }); }
    else api.postMessage({ type: 'config.action', action, key: key(), tab: tab(), field: target.dataset.cfField || '', environment: target.dataset.cfEnvironment || '' });
  });
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'config.patch') return;
    for (const region of message.regions || []) {
      const element = document.querySelector('[data-cf-region="' + CSS.escape(region.id) + '"]');
      if (element) element.innerHTML = region.html;
    }
    if (message.state && api.setState) api.setState(message.state);
  });
})();
`;
