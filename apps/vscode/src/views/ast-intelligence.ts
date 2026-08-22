/** Guided VS Code surface for repository AST policy, machine preference, diagnostics, and cache. */
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { activeRepositoryContext, type ActiveRepositoryContext } from '../gateway-session.ts';
import { commandData, list } from './surface-adapters.ts';
import {
  astPolicyView, astRepositoryScopeView, parseAstLanguageRows, parseAstPredicateRows,
  astWorkspaceRepositoryInventory, updateAstPolicyYaml, validateAstPolicyDraft,
  type AstAssurance, type AstEvidenceMode, type AstFallback, type AstMode, type AstPolicyDraft,
  type AstRepositoryScopeView, type AstWorkspaceRepositoryInventory
} from './ast-intelligence-model.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';

interface AstCacheStatus { exists?: boolean; files?: number; bytes?: number }
interface AstDoctorResult {
  healthy?: boolean;
  configured?: AstPolicyDraft;
  effective?: { mode?: AstMode; sources?: Partial<Record<'repository' | 'local' | 'environment' | 'operation', AstMode>> };
  scope?: { kind?: string; paths?: string[] };
  cache?: AstCacheStatus;
  languages?: Array<{
    language?: string; selectedFiles?: number; maximumAssurance?: AstAssurance;
    availablePacks?: Array<{ id?: string; stage?: string; assurance?: AstAssurance; packVersion?: string }>;
    selectedProviders?: { syntax?: string | null; semantic?: string | null };
    toolchainStatus?: string; projectModelStatus?: string; degradationReason?: string | null;
  }>;
  projects?: {
    mode?: string; bindingCount?: number;
    bindings?: Array<{
      projectKind?: string; root?: string; modules?: string[]; sourceSets?: string[];
      profile?: string | null; complete?: boolean; unavailable?: string[]; projectModelSha256?: string;
    }>;
  };
  adapters?: Array<{
    id?: string; packVersion?: string; stage?: string; languages?: string[];
    assurance?: AstAssurance; status?: string;
  }>;
  optionalPacks?: Array<{
    id?: string; stage?: string; languages?: string[]; projectKinds?: string[];
    maturity?: string; status?: string; platformCompatible?: boolean;
  }>;
  assuranceAvailable?: AstAssurance[];
  lifecycle?: {
    enforced?: boolean; predicateCount?: number; requiredPredicateCount?: number;
    workId?: string | null; phase?: string | null; generation?: number | null;
    latestGate?: { generation?: number; status?: string; assurance?: string; path?: string } | null;
  };
  diagnostics?: Array<{ code?: string; severity?: string; message?: string }>;
}
interface AstRunResult {
  operation?: string; status?: string; assurance?: string;
  scope?: { kind?: string; paths?: string[] };
  coverage?: { selected?: number; processed?: number; skipped?: number; generated?: number; bytes?: number; facts?: number; factsExamined?: number; factsMatched?: number; factsReturned?: number; byLanguage?: Record<string, number> };
  provenance?: { cache?: { hits?: number; misses?: number; entries?: number; format?: string }; adapters?: Array<{ id?: string; status?: string }> };
  diagnostics?: Array<{ code?: string; message?: string }>;
  degradation?: Array<{ path?: string; reason?: string }>;
  resumeHandle?: string | null;
  nextCursor?: string | null;
  page?: { offset?: number; returned?: number; hasMore?: boolean };
}
interface AstCachePreview { action?: 'prune' | 'clear'; dryRun?: boolean; candidates?: number; removed?: number; bytes?: number; targets?: string[] }
interface AstWarmPreview {
  operation?: 'ast-semantic-warm'; project?: string; provider?: string; profile?: string;
  ready?: boolean; unavailable?: string[]; confirmation?: string;
  effects?: { repositoryWrites?: boolean; network?: string; executesRepositoryConfiguration?: boolean; writes?: string[] };
  commands?: Array<{ kind?: string; executable?: string; arguments?: string[]; cwd?: string }>;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  const csv = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  const repositoryScope = () => document.querySelector('[data-repository-scope]')?.dataset.repositoryScope || '';
  const send = (message) => vscode.postMessage({ ...message, repositoryScope: repositoryScope() });
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-message]');
    if (action) send({ type: action.dataset.message, kind: action.dataset.kind });
  });
  document.addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.target; const data = new FormData(form);
    if (form.id === 'ast-machine-form') send({ type: 'save-machine', mode: data.get('mode') });
    if (form.id === 'ast-repository-form') send({ type: 'select-repository', repository: data.get('repository') });
    if (form.id === 'ast-policy-form') send({
      type: 'save-policy', mode: data.get('mode'), fallback: data.get('fallback'),
      evidenceMode: data.get('evidenceMode'), evidenceStore: data.get('evidenceStore'),
      generatedRoots: String(data.get('generatedRoots') || ''),
      maxFiles: Number(data.get('maxFiles')), maxBytes: Number(data.get('maxBytes')),
      maxFileBytes: Number(data.get('maxFileBytes')),
      languages: String(data.get('languages') || ''), predicates: String(data.get('predicates') || '')
    });
    if (form.id === 'ast-scope-form') send({
      type: 'run-scope', operation: event.submitter?.value, mode: data.get('mode'),
      paths: csv(data.get('paths')), all: data.get('all') === 'on', maxFiles: Number(data.get('maxFiles'))
    });
    if (form.id === 'ast-warm-form') send({
      type: 'preview-warm', provider: data.get('provider'), profile: data.get('profile'), project: data.get('project')
    });
    if (form.id === 'ast-warm-confirm') send({ type: 'execute-warm', confirmation: data.get('confirmation') });
    if (form.id === 'ast-cache-confirm') send({
      type: 'execute-cache', kind: data.get('kind'), confirmation: data.get('confirmation')
    });
  });
`;

function bytes(value: number | undefined): string {
  const amount = Number(value ?? 0);
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 * 1024) return `${(amount / 1024).toFixed(1)} KiB`;
  return `${(amount / (1024 * 1024)).toFixed(1)} MiB`;
}

function option(value: string, current: string, label: string): string {
  return `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(label)}</option>`;
}

function languageRows(policy: AstPolicyDraft): string {
  return policy.languages.map((row) => [
    row.language, row.mode, row.minimumAssurance,
    row.syntaxProvider ?? '', row.semanticProvider ?? '', row.semanticProfile ?? ''
  ].join(' | ').replace(/(?: \| )+$/, '')).join('\n');
}

function predicateRows(policy: AstPolicyDraft): string {
  return policy.predicates.map((row) => [
    row.id, row.mode, row.type, row.target, row.minimumAssurance,
    (row.languages ?? []).join(','), (row.profiles ?? []).join(','), row.secondary ?? ''
  ].join(' | ').replace(/(?: \| )+$/, '')).join('\n');
}

function runtimeSummary(doctor: AstDoctorResult | null): string {
  if (!doctor) return '<section class="empty"><p>Reading effective AST policy and local cache…</p></section>';
  const effective = doctor.effective?.mode ?? 'auto';
  const sources = doctor.effective?.sources ?? {};
  const sourceRows: Array<[string, AstMode | undefined, string]> = [
    ['Repository policy', sources.repository, 'Reviewed in singularity/workflow.yml'],
    ['Machine preference', sources.local, 'Local to this machine'],
    ['VS Code environment', sources.environment, 'Inherited when VS Code launched; shown read-only'],
    ['Operation default', sources.operation, 'Individual previews may choose a stricter off mode']
  ];
  const lifecycle = doctor.lifecycle ?? {};
  const gateStatus = lifecycle.enforced
    ? lifecycle.latestGate
      ? `${lifecycle.latestGate.status ?? 'unknown'} · generation ${lifecycle.latestGate.generation ?? 'unknown'}`
      : lifecycle.phase ? 'required at next publication' : 'configured'
    : 'not configured';
  return `<section class="plain"><h2>${icon(effective === 'off' ? 'warning' : 'ok')}Effective mode</h2>
    <div class="summary-grid"><div class="summary-card ${effective === 'off' ? 'important' : ''}"><strong>${escape(effective)}</strong><span>effective AST mode</span></div>
      <div class="summary-card"><strong>${escape((doctor.assuranceAvailable ?? ['text']).join(', '))}</strong><span>available assurance</span></div>
      <div class="summary-card"><strong>${escape(doctor.scope?.kind ?? 'changed')}</strong><span>default scope</span></div>
      <div class="summary-card"><strong>${escape(doctor.cache?.files ?? 0)}</strong><span>derived cache records</span></div>
      <div class="summary-card"><strong>${escape(gateStatus)}</strong><span>lifecycle gate</span></div></div>
    <div class="table-wrap"><table><thead><tr><th>Source</th><th>Mode</th><th>Ownership</th></tr></thead><tbody>${sourceRows.map(([name, mode, detail]) => `<tr><td><strong>${escape(name)}</strong></td><td><code>${escape(mode ?? 'auto')}</code></td><td>${escape(detail)}</td></tr>`).join('')}</tbody></table></div>
    <p class="notice">The most restrictive source wins. There is deliberately no force-enable control that can override a repository, machine, or environment setting. Configured predicates are evaluated before phase publication and their exact receipt is revalidated before submission.</p>
    ${list<NonNullable<AstDoctorResult['diagnostics']>[number]>(doctor.diagnostics).length ? `<ul>${list<NonNullable<AstDoctorResult['diagnostics']>[number]>(doctor.diagnostics).map((entry) => `<li><code>${escape(entry.code ?? 'AST_DIAGNOSTIC')}</code>${entry.message ? ` — ${escape(entry.message)}` : ''}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function machinePreference(doctor: AstDoctorResult | null): string {
  const current = doctor?.effective?.sources?.local ?? 'auto';
  return `<section><h2>${icon('configuration')}Machine preference</h2><p>Controls AST intelligence for this machine. <strong>Auto</strong> makes it available on demand; it does not start a daemon or scan in the background.</p>
    <form id="ast-machine-form" class="editor-card"><div class="form-grid"><label><span>Local preference</span><select name="mode">${option('auto', current, 'Auto — available when requested')}${option('off', current, 'Off — disable structural analysis')}</select></label></div>
      <p class="card-foot"><button type="submit">Save machine preference</button></p></form></section>`;
}

function repositorySelector(
  scope: AstRepositoryScopeView,
  inventory: AstWorkspaceRepositoryInventory | null,
  inventoryError: string | null
): string {
  if (inventoryError) return `<p class="notice warning"><strong>Repository choices unavailable:</strong> ${escape(inventoryError)}</p>`;
  if (!inventory) return '<p class="muted">No workspace repository selector is shown because this context comes from the open repository rather than an active multi-repository workspace.</p>';
  if (inventory.repositories.length < 2) return `<p class="muted">${escape(inventory.workspaceName)} contains one repository. There is nothing else to select.</p>`;
  const options = inventory.repositories.map((repository) => {
    const selected = repository.id === inventory.selectedRepositoryId || repository.id === scope.repository;
    const unavailable = Boolean(repository.state && repository.state !== 'ready');
    const detail = [repository.role, repository.state && repository.state !== 'ready' ? repository.state : null].filter(Boolean).join(' · ');
    return `<option value="${escape(repository.id)}"${selected ? ' selected' : ''}${unavailable ? ' disabled' : ''}>${escape(repository.id)}${detail ? ` — ${escape(detail)}` : ''}</option>`;
  }).join('');
  return `<form id="ast-repository-form" class="editor-card"><label><span>Repository in ${escape(inventory.workspaceName)}</span><select name="repository">${options}</select><small>Changing this updates the workspace's shared active repository for My Work, Lifecycle, Configuration, Copilot, and the terminal—not only this panel.</small></label><p class="card-foot"><button type="submit">Use this repository</button></p></form>`;
}

function repositoryScope(scope: AstRepositoryScopeView | null, inventory: AstWorkspaceRepositoryInventory | null, inventoryError: string | null): string {
  if (!scope) return `<section class="warning"><h2>${icon('warning')}No repository selected</h2><p>This screen cannot read or change an AST policy until a governed workspace or repository is selected.</p><p class="card-foot"><button class="secondary" data-message="open-workspaces">Choose a workspace</button></p></section>`;
  return `<section class="plain" aria-label="Current repository scope"><div class="section-heading"><div><h2>${icon('repository')}Current repository scope</h2><p>Every repository policy, preview, cache action, and advanced YAML link on this screen applies to this repository.</p></div><button class="secondary" data-message="open-workspaces">Switch workspace</button></div>
    <div class="summary-grid"><div class="summary-card"><strong>${escape(scope.workspace)}</strong><span>workspace</span></div><div class="summary-card"><strong>${escape(scope.repository)}</strong><span>repository</span></div></div>
    <dl class="details"><div><dt>Repository root</dt><dd><code>${escape(scope.root)}</code></dd></div><div><dt>Selected from</dt><dd>${escape(scope.origin)}</dd></div></dl>
    ${repositorySelector(scope, inventory, inventoryError)}
    <p class="notice">This screen follows the shared active workspace and repository context. Switching either one updates the repository here before another action can run.</p></section>`;
}

function policyForm(policy: AstPolicyDraft, scope: AstRepositoryScopeView | null): string {
  const repository = scope?.repository ?? 'the selected repository';
  return `<section><div class="section-heading"><div><h2>${icon('worldModel')}Repository policy</h2><p>Saved through the governed configuration engine. Review and publish <code>singularity/workflow.yml</code> through the normal configuration path.</p></div><button class="secondary" data-message="open-configuration">Configuration Center</button></div>
    <form id="ast-policy-form">
      <div class="editor-card"><h3>Behavior</h3><div class="form-grid">
        <label><span>Repository mode for ${escape(repository)}</span><select name="mode">${option('auto', policy.mode, 'Auto — available when requested')}${option('off', policy.mode, `Off — disable for ${repository}`)}</select><small>Off is refused while any required predicate exists.</small></label>
        <label><span>Fallback</span><select name="fallback">${option('host-and-text', policy.fallback, 'Host and bounded text facts')}${option('text-only', policy.fallback, 'Bounded text facts only')}</select></label>
        <label><span>Durable evidence</span><select name="evidenceMode">${option('replayable', policy.evidence.mode, 'Replayable — retain exact toolchain')}${option('identified', policy.evidence.mode, 'Identified — record digests only')}${option('off', policy.evidence.mode, 'Off — previews only')}</select><small>Required lifecycle predicates always require replayable evidence.</small></label>
        <input type="hidden" name="evidenceStore" value="${escape(policy.evidence.store)}">
        <div><span>Evidence storage</span><p><strong>Workspace-local</strong></p><small>Replay artifacts are kept automatically under <code>.singularity-flow/ast-evidence-store</code>. No path configuration is required.</small></div>
        <label class="span-2"><span>Generated roots</span><input name="generatedRoots" value="${escape(policy.generatedRoots.join(', '))}" placeholder="generated/client, build/types"><small>Comma-separated repository-relative directories. Symlinks, traversal, and globs are refused.</small></label>
      </div></div>
      <div class="editor-card"><h3>Safety budgets</h3><div class="form-grid">
        <label><span>Maximum files</span><input name="maxFiles" type="number" min="1" step="1" value="${policy.budgets.maxFiles}"></label>
        <label><span>Total byte budget</span><input name="maxBytes" type="number" min="1" step="1024" value="${policy.budgets.maxBytes}"></label>
        <label><span>Maximum bytes per file</span><input name="maxFileBytes" type="number" min="1" step="1024" value="${policy.budgets.maxFileBytes}"></label>
      </div></div>
      <div class="editor-card"><h3>Language policy</h3><label class="stack"><span>One language per line</span><textarea name="languages" rows="5" placeholder="java | auto | text | sflow-polyglot-syntax\nkotlin | auto | semantic | | sflow-kotlin-analysis | android-debug">${escape(languageRows(policy))}</textarea><small><code>language | auto/off | text/syntax/semantic | parser provider | semantic provider | profile</code>. Provider and profile columns are optional. The legacy-named bundled polyglot provider is a text-assured structural preview, not a parser; syntax gates require a reviewed parser-backed provider.</small></label></div>
      <div class="editor-card"><h3>Structural predicates</h3><label class="stack"><span>One predicate per line</span><textarea name="predicates" rows="6" placeholder="boundary | required | import-boundary | src/api | syntax | java,kotlin | * | forbidden.internal">${escape(predicateRows(policy))}</textarea><small><code>id | required/advisory | type | path/symbol/module | assurance | languages | profiles | comparison</code>. Types: path/symbol exists, import boundary, annotation, inheritance/conformance/override, public-signature change, and module dependency. Rich predicates require explicit language/profile applicability; use <code>*</code> deliberately. Required unknown, failed, disabled, or partial results never pass.</small></label></div>
      <p class="card-foot"><button type="submit">Save repository AST policy</button><button class="secondary" type="button" data-message="open-workflow">Open advanced YAML</button></p>
    </form></section>`;
}

function runResult(result: AstRunResult | null): string {
  if (!result) return '';
  const coverage = result.coverage ?? {};
  const cache = result.provenance?.cache;
  const adapters = result.provenance?.adapters ?? [];
  return `<section><h2>Latest ${escape(result.operation ?? 'AST')} result</h2><div class="summary-grid">
    <div class="summary-card ${result.status === 'partial' || result.status === 'disabled' ? 'important' : ''}"><strong>${escape(result.status ?? 'unknown')}</strong><span>status</span></div>
    <div class="summary-card"><strong>${escape(result.assurance ?? 'text')}</strong><span>assurance</span></div>
    <div class="summary-card"><strong>${escape(`${coverage.processed ?? 0}/${coverage.selected ?? 0}`)}</strong><span>files processed</span></div>
    <div class="summary-card"><strong>${escape(bytes(coverage.bytes))}</strong><span>bytes examined</span></div>
    ${(coverage.generated ?? 0) > 0 ? `<div class="summary-card"><strong>${escape(coverage.generated ?? 0)}</strong><span>generated files identified</span></div>` : ''}
    ${cache ? `<div class="summary-card"><strong>${escape(`${cache.hits ?? 0} hit / ${cache.misses ?? 0} miss`)}</strong><span>${escape(cache.format ?? 'derived cache')}</span></div>` : ''}</div>
    ${adapters.length ? `<p class="muted">Adapters: ${adapters.map((entry) => `${escape(entry.id ?? 'adapter')} (${escape(entry.status ?? 'used')})`).join(', ')}</p>` : ''}
    ${list<NonNullable<AstRunResult['diagnostics']>[number]>(result.diagnostics).length ? `<ul>${list<NonNullable<AstRunResult['diagnostics']>[number]>(result.diagnostics).map((entry) => `<li><code>${escape(entry.code ?? 'AST_DIAGNOSTIC')}</code> — ${escape(entry.message ?? '')}</li>`).join('')}</ul>` : ''}
    ${list<NonNullable<AstRunResult['degradation']>[number]>(result.degradation).length ? `<details><summary>${list<NonNullable<AstRunResult['degradation']>[number]>(result.degradation).length} degraded or skipped path(s)</summary><ul>${list<NonNullable<AstRunResult['degradation']>[number]>(result.degradation).map((entry) => `<li><code>${escape(entry.path ?? 'path')}</code> — ${escape(entry.reason ?? 'not processed')}</li>`).join('')}</ul></details>` : ''}
    ${result.resumeHandle ? '<p class="notice warning">The configured budget stopped this build. Resume from the CLI using the opaque handle printed in the Singularity Flow output channel; handles are deliberately not embedded in webview HTML.</p>' : ''}
    ${result.nextCursor ? `<p class="notice warning">This bounded page returned ${escape(result.page?.returned ?? coverage.factsReturned ?? 0)} fact(s). More are available. The opaque cursor remains in extension memory and is never embedded in this page.</p><p class="card-foot"><button class="secondary" data-message="continue-context">Continue to next page</button></p>` : ''}
    <p class="muted">Facts and source bodies are not rendered in this settings page. This summary shows only coverage and diagnostics.</p></section>`;
}

function scopeRunner(policy: AstPolicyDraft): string {
  return `<section><h2>${icon('search')}Try the effective policy</h2><p>Preview is read-only. Build writes only derived, content-addressed cache records under Git's common directory. Neither action scans the whole repository unless you explicitly select it.</p>
    <form id="ast-scope-form" class="editor-card"><div class="form-grid">
      <label class="span-2"><span>Repository paths</span><input name="paths" placeholder="src, packages/payments"><small>Leave empty to use the pinned capability cone, or changed files when no cone exists.</small></label>
      <label><span>Operation mode</span><select name="mode"><option value="auto">Auto</option><option value="off">Off — verify disabled behavior</option></select></label>
      <label><span>Maximum files for this run</span><input name="maxFiles" type="number" min="1" step="1" value="${policy.budgets.maxFiles}"></label>
      <label class="check span-2"><input name="all" type="checkbox">Explicitly scan every tracked and unignored file in the repository</label>
    </div><p class="card-foot"><button type="submit" name="operation" value="context">Preview context</button><button class="secondary" type="submit" name="operation" value="build">Build derived cache</button></p></form></section>`;
}

function cacheSection(doctor: AstDoctorResult | null, preview: AstCachePreview | null): string {
  const cache = doctor?.cache ?? {};
  const expected = preview?.action === 'clear' ? 'CLEAR AST CACHE' : preview?.action === 'prune' ? 'PRUNE AST CACHE' : '';
  return `<section><h2>${icon('remove')}Derived cache</h2><p>${escape(cache.files ?? 0)} local record(s), ${escape(bytes(cache.bytes))}. Disabling AST does not delete them; cache cleanup never changes source, branches, or governed records.</p>
    <p class="card-foot"><button class="secondary" data-message="preview-cache" data-kind="prune">Preview stale-record pruning</button><button class="secondary" data-message="preview-cache" data-kind="clear">Preview complete cache cleanup</button></p>
    ${preview ? `<div class="editor-card"><h3>${preview.action === 'clear' ? 'Complete cleanup' : 'Stale-record pruning'} preview</h3><p>${preview.action === 'clear' ? `${escape(cache.files ?? 0)} record(s), ${escape(bytes(preview.bytes))}` : `${escape(preview.candidates ?? 0)} stale or expired record(s)`} would be removed.</p>
      ${list(preview.targets).length ? `<ul>${list(preview.targets).map((target) => `<li><code>${escape(target)}</code></li>`).join('')}</ul>` : ''}
      <form id="ast-cache-confirm"><input type="hidden" name="kind" value="${escape(preview.action ?? '')}"><label>Type <code>${escape(expected)}</code> exactly<input name="confirmation" autocomplete="off" required></label><button class="secondary" type="submit">Apply cleanup</button></form></div>` : ''}</section>`;
}

function adapterSection(doctor: AstDoctorResult | null): string {
  const adapters = list<NonNullable<AstDoctorResult['adapters']>[number]>(doctor?.adapters);
  const optional = list<NonNullable<AstDoctorResult['optionalPacks']>[number]>(doctor?.optionalPacks);
  return `<section><h2>${icon('mcp')}Structural adapter packs</h2><p>The bundled cross-platform structural preview and reviewed machine-installed parser packs run only on demand. The bundled scanner is capped at text assurance and cannot satisfy a syntax gate. Context and build operations invoke providers with structured arguments, bounded JSON input/output, no shell, and strict fact validation. Repository files cannot register an executable, and the broker never searches PATH for a provider.</p>
    ${adapters.length ? `<div class="table-wrap"><table><thead><tr><th>Pack</th><th>Stage</th><th>Languages</th><th>Assurance</th><th>Status</th></tr></thead><tbody>${adapters.map((adapter) => `<tr><td><strong>${escape(adapter.id ?? 'adapter')}</strong><br><small>${escape(adapter.packVersion ?? 'version unknown')}</small></td><td>${escape(adapter.stage ?? 'syntax')}</td><td>${escape((adapter.languages ?? []).join(', '))}</td><td>${escape(adapter.assurance ?? 'unknown')}</td><td>${escape(adapter.status ?? 'discovered')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No compatible adapter pack is available. Bounded text assurance remains available.</p>'}
    ${optional.length ? `<details><summary>${optional.length} reviewed optional semantic provider(s)</summary><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Languages</th><th>Project models</th><th>Maturity</th><th>Local status</th></tr></thead><tbody>${optional.map((pack) => `<tr><td><strong>${escape(pack.id ?? 'provider')}</strong></td><td>${escape((pack.languages ?? []).join(', '))}</td><td>${escape((pack.projectKinds ?? []).join(', '))}</td><td>${escape(pack.maturity ?? 'optional')}</td><td>${escape(pack.status ?? 'not-installed')}</td></tr>`).join('')}</tbody></table></div><p class="muted">Catalog entries are compatibility declarations, not bundled compiler binaries. Install reviewed pack bytes from an offline source before semantic use.</p></details>` : ''}</section>`;
}

function semanticWarmSection(doctor: AstDoctorResult | null, preview: AstWarmPreview | null): string {
  const bindings = list<NonNullable<NonNullable<AstDoctorResult['projects']>['bindings']>[number]>(doctor?.projects?.bindings);
  const selectedProject = preview?.project ?? '';
  return `<section><h2>${icon('refresh')}Semantic project warm-up</h2>
    <p>Semantic providers require an explicit, hash-bound toolchain and project profile. Preview first: SFlow discloses every structured command, runs it without a shell, and writes only derived machine-local binding metadata.</p>
    <form id="ast-warm-form" class="form-grid">
      <label>Provider<select name="provider" required>
        <option value="">Choose a semantic provider</option>
        <option value="sflow-java-jdt">Java · JDT</option><option value="sflow-python-pyright">Python · Pyright</option>
        <option value="sflow-kotlin-analysis">Kotlin · Analysis API</option><option value="sflow-swift-sourcekit">Swift · SourceKit</option>
      </select></label>
      <label>Project binding<select name="project" required>
        <option value="">${bindings.length ? 'Choose a discovered project' : 'No project bindings discovered'}</option>
        ${bindings.map((binding) => {
          const value = `${binding.projectKind ?? 'project'}:${binding.root ?? '.'}`;
          const readiness = binding.complete ? 'complete' : `incomplete — ${(binding.unavailable ?? []).join(', ') || 'toolchain/profile required'}`;
          return `<option value="${escape(value)}"${selectedProject === value ? ' selected' : ''}>${escape(`${value} · ${readiness}`)}</option>`;
        }).join('')}
      </select><small>Bindings come from existing Maven, Gradle/Android, Python, SwiftPM, or Xcode metadata; discovery does not run a build.</small></label>
      <label>Profile<input name="profile" required placeholder="default, debug, or scheme/configuration"></label>
      <p class="card-foot"><button class="secondary" type="submit">Preview semantic warm-up</button></p>
    </form>
    ${preview ? `<div class="review-card"><p><strong>${escape(preview.provider ?? 'provider')}</strong> · ${escape(preview.project ?? 'project')} · ${escape(preview.profile ?? 'profile')}</p>
      <p>${preview.ready ? 'Ready after exact confirmation.' : `Unavailable: ${escape((preview.unavailable ?? []).join(', ') || 'required toolchain inputs')}`}</p>
      <ul>${(preview.commands ?? []).map((command) => `<li><code>${escape([command.executable, ...(command.arguments ?? [])].filter(Boolean).join(' '))}</code> · cwd <code>${escape(command.cwd ?? '.')}</code></li>`).join('')}</ul>
      <p>Network: ${escape(preview.effects?.network ?? 'not declared')} · repository writes: ${preview.effects?.repositoryWrites ? 'yes' : 'no'} · repository configuration execution: ${preview.effects?.executesRepositoryConfiguration ? 'yes' : 'no'}</p>
      ${preview.ready ? `<form id="ast-warm-confirm"><input name="confirmation" required autocomplete="off" placeholder="${escape(preview.confirmation ?? '')}"><button class="secondary" type="submit">Warm semantic binding</button></form>` : ''}</div>` : ''}
  </section>`;
}

function languageMatrixSection(doctor: AstDoctorResult | null): string {
  const languages = list<NonNullable<AstDoctorResult['languages']>[number]>(doctor?.languages);
  const projects = doctor?.projects;
  const projectRows = list<NonNullable<NonNullable<AstDoctorResult['projects']>['bindings']>[number]>(projects?.bindings);
  return `<section><h2>${icon('worldModel')}Language and project readiness</h2><p>This is the effective repository matrix. The bundled Java, Python, Kotlin, and Swift scanner supplies text-assured declaration previews only. Syntax requires a real installed parser; semantic assurance additionally requires a compatible pack and a complete, hash-bound project/toolchain binding.</p>
    ${languages.length ? `<div class="table-wrap"><table><thead><tr><th>Language</th><th>Files</th><th>Maximum</th><th>Selected providers</th><th>Project/toolchain</th><th>Degradation</th></tr></thead><tbody>${languages.map((entry) => {
      const providers = [entry.selectedProviders?.syntax ? `syntax: ${entry.selectedProviders.syntax}` : null, entry.selectedProviders?.semantic ? `semantic: ${entry.selectedProviders.semantic}` : null].filter(Boolean).join(' · ');
      return `<tr><td><strong>${escape(entry.language ?? 'unknown')}</strong></td><td>${escape(entry.selectedFiles ?? 0)}</td><td>${escape(entry.maximumAssurance ?? 'text')}</td><td>${escape(providers || 'built-in text floor')}</td><td>${escape(`${entry.projectModelStatus ?? 'not-detected'} / ${entry.toolchainStatus ?? 'not-required'}`)}</td><td>${escape(entry.degradationReason ?? 'none')}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="empty">No files are selected by the current bounded scope.</p>'}
    <details><summary>${escape(projects?.bindingCount ?? 0)} existing project binding(s) discovered without running a build</summary>${projectRows.length ? `<ul>${projectRows.map((binding) => `<li><strong>${escape(binding.projectKind ?? 'project')}</strong> · <code>${escape(binding.root ?? '.')}</code> · ${binding.complete ? 'complete' : `incomplete: ${escape((binding.unavailable ?? []).join(', ') || 'toolchain/profile')}`}</li>`).join('')}</ul>` : '<p>No Maven, Gradle/Android, Python, SwiftPM, or Xcode metadata was found in the selected scope.</p>'}</details></section>`;
}

export function astIntelligenceBody(policy: AstPolicyDraft, doctor: AstDoctorResult | null, run: AstRunResult | null, preview: AstCachePreview | null, warmPreview: AstWarmPreview | null, notice: string | null, error: string | null, scope: AstRepositoryScopeView | null, inventory: AstWorkspaceRepositoryInventory | null, inventoryError: string | null): string {
  return `<div data-repository-scope="${escape(scope?.key ?? '')}"><header class="inbox-header"><p class="eyebrow">Configuration · World model</p><h1>${icon('worldModel', { size: 24 })}AST Intelligence</h1><p class="meta">Bounded structural facts, explicit assurance, and content-aware local caching. No daemon and no implicit whole-repository scan.</p></header>
    ${notice ? `<div class="notice ok">${escape(notice)}</div>` : ''}${error ? `<div class="notice error"><strong>AST action refused</strong><p>${escape(error)}</p></div>` : ''}
    <p class="card-foot"><button class="secondary" data-message="refresh">Refresh status</button><button class="secondary" data-message="open-help">Open AST guide</button></p>
    ${repositoryScope(scope, inventory, inventoryError)}${runtimeSummary(doctor)}${languageMatrixSection(doctor)}${semanticWarmSection(doctor, warmPreview)}${machinePreference(doctor)}${policyForm(policy, scope)}${scopeRunner(policy)}${runResult(run)}${cacheSection(doctor, preview)}${adapterSection(doctor)}</div>`;
}

function optionalString(message: InboundMessage, name: string): string {
  return typeof message[name] === 'string' ? message[name] as string : '';
}

function positiveInteger(message: InboundMessage, name: string): number {
  return typeof message[name] === 'number' && Number.isInteger(message[name]) ? message[name] as number : 0;
}

export class AstIntelligencePanel {
  private static current: AstIntelligencePanel | null = null;
  private doctor: AstDoctorResult | null = null; private result: AstRunResult | null = null;
  private preview: AstCachePreview | null = null; private notice: string | null = null; private error: string | null = null;
  private warmPreview: AstWarmPreview | null = null;
  private repositoryInventory: AstWorkspaceRepositoryInventory | null = null;
  private repositoryInventoryError: string | null = null; private repositoryInventoryLoaded = false;
  private refreshRevision = 0;
  private refreshPending = false;
  private readonly subscription: { dispose(): void };
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly store: WorkspaceStore;
  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, store: WorkspaceStore) {
    this.panel = panel; this.client = client; this.store = store;
    this.subscription = store.onDidChange((_state, change) => {
      if (change.kind !== 'snapshot' || !change.revisionChanged) return;
      if (this.panel.visible === false) { this.refreshPending = true; return; }
      this.preview = null; this.result = null; void this.refresh();
    });
    panel.webview.onDidReceiveMessage((raw) => {
      const navigation = navigationTarget(raw); if (navigation) return void navigateTo(navigation); this.router.route(raw);
    });
    panel.onDidDispose(() => { this.subscription.dispose(); AstIntelligencePanel.current = null; });
    panel.onDidChangeViewState?.(({ webviewPanel }) => {
      if (webviewPanel.visible === false || !this.refreshPending) return;
      this.refreshPending = false;
      this.preview = null; this.result = null; void this.refresh();
    });
    this.render(); void this.refresh();
  }
  static show(context: vscode.ExtensionContext, client: SingularityFlowClient, store: WorkspaceStore): AstIntelligencePanel {
    if (AstIntelligencePanel.current) { AstIntelligencePanel.current.panel.reveal(); void AstIntelligencePanel.current.refresh(); return AstIntelligencePanel.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.astIntelligence', 'AST Intelligence', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    AstIntelligencePanel.current = new AstIntelligencePanel(panel, client, store); return AstIntelligencePanel.current;
  }
  static repositoryChanged(): void { if (AstIntelligencePanel.current) { AstIntelligencePanel.current.doctor = null; AstIntelligencePanel.current.preview = null; AstIntelligencePanel.current.warmPreview = null; AstIntelligencePanel.current.result = null; AstIntelligencePanel.current.notice = null; AstIntelligencePanel.current.error = null; AstIntelligencePanel.current.repositoryInventory = null; AstIntelligencePanel.current.repositoryInventoryError = null; AstIntelligencePanel.current.repositoryInventoryLoaded = false; void AstIntelligencePanel.current.refresh(); } }
  private router = registerMessageRouter('singularityFlow.astIntelligence', {
    refresh: () => { void this.refresh(); },
    'save-machine': (message) => { const mode = enumField(message, 'mode', ['auto', 'off'] as const); if (mode) void this.saveMachine(mode); },
    'select-repository': (message) => { void this.selectRepository(message); },
    'save-policy': (message) => { void this.savePolicy(message); },
    'run-scope': (message) => { void this.runScope(message); },
    'continue-context': (message) => { void this.continueContext(message); },
    'preview-warm': (message) => { void this.previewWarm(message); },
    'execute-warm': (message) => { const confirmation = stringField(message, 'confirmation'); if (confirmation) void this.executeWarm(confirmation, message); },
    'preview-cache': (message) => { const kind = enumField(message, 'kind', ['prune', 'clear'] as const); if (kind) void this.previewCache(kind, message); },
    'execute-cache': (message) => { const kind = enumField(message, 'kind', ['prune', 'clear'] as const); const confirmation = stringField(message, 'confirmation'); if (kind && confirmation) void this.executeCache(kind, confirmation, message); },
    'open-configuration': () => { void vscode.commands.executeCommand('singularityFlow.openConfigurationCenter'); },
    'open-workspaces': () => { void vscode.commands.executeCommand('singularityFlow.openWorkspaces'); },
    'open-workflow': (message) => { if (this.acceptsRepositoryScope(message)) void vscode.commands.executeCommand('singularityFlow.openArtifact', { path: 'singularity/workflow.yml', label: 'workflow.yml' }); },
    'open-help': () => {
      void vscode.commands.executeCommand('singularityFlow.openHelp', { id: 'help:world-model' });
    }
  });
  private repositoryContext(): ActiveRepositoryContext | null { return activeRepositoryContext(); }
  private repositoryScope(): AstRepositoryScopeView | null {
    const context = this.repositoryContext(); return context ? astRepositoryScopeView(context) : null;
  }
  private acceptsRepositoryScope(message: InboundMessage): boolean {
    const expected = this.repositoryScope()?.key ?? null;
    if (expected && optionalString(message, 'repositoryScope') === expected) return true;
    this.error = 'The active repository changed after this screen was rendered. Review the repository scope above, then try again.';
    this.preview = null; this.result = null; this.render(); return false;
  }
  private policy(): AstPolicyDraft { return astPolicyView(this.store.current.snapshot ?? {}); }
  private async readRepositoryInventory(): Promise<AstWorkspaceRepositoryInventory | null> {
    const current = await this.client.run<{
      active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
      repositoryId?: string;
    }>(['workspace', 'current', '--json']);
    if (current.active !== true || !current.workspacePath) return null;
    const status = await this.client.run<{ repositories?: Array<{ id?: string; role?: string; state?: string }> }>(
      ['workspace', 'status', current.workspacePath, '--json']);
    return astWorkspaceRepositoryInventory(current, status);
  }
  private async refresh(): Promise<void> {
    const revision = ++this.refreshRevision;
    const inventory = this.repositoryInventoryLoaded
      ? Promise.resolve(this.repositoryInventory)
      : this.readRepositoryInventory();
    const [doctor, repositories] = await Promise.allSettled([
      this.client.run(['wm', 'ast', 'doctor', '--json']).then((result) => commandData<AstDoctorResult>(result)),
      inventory
    ]);
    if (revision !== this.refreshRevision) return;
    if (doctor.status === 'fulfilled') { this.doctor = doctor.value; this.error = null; }
    else this.error = doctor.reason instanceof Error ? doctor.reason.message : String(doctor.reason);
    if (repositories.status === 'fulfilled') {
      this.repositoryInventory = repositories.value; this.repositoryInventoryLoaded = true;
      this.repositoryInventoryError = null;
    } else {
      // AST diagnostics remain useful when the machine-wide workspace inventory is temporarily
      // unreadable. A later explicit refresh retries this independent read.
      this.repositoryInventoryError = repositories.reason instanceof Error
        ? repositories.reason.message : String(repositories.reason);
      this.repositoryInventoryLoaded = false;
    }
    this.render();
  }
  private async selectRepository(message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const repository = stringField(message, 'repository');
    const choice = repository
      ? this.repositoryInventory?.repositories.find((entry) => entry.id === repository)
      : null;
    if (!choice || (choice.state && choice.state !== 'ready')) {
      this.error = 'Choose a ready repository from the current workspace inventory.'; this.render(); return;
    }
    if (repository === this.repositoryInventory?.selectedRepositoryId) {
      this.notice = `${repository} is already the active repository.`; this.error = null; this.render(); return;
    }
    const switched = await vscode.commands.executeCommand<boolean>('singularityFlow.switchWorkspaceRepository', repository);
    if (!switched) {
      this.error = `Could not switch the active workspace to repository ${repository}.`; this.render();
    }
  }
  private async saveMachine(mode: AstMode): Promise<void> {
    try {
      await this.client.run(['wm', 'ast', 'preference', 'set', mode, '--json']);
      this.notice = `Machine AST preference set to ${mode}.`; this.error = null; await this.refresh();
    } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private draft(message: InboundMessage): AstPolicyDraft {
    return {
      mode: optionalString(message, 'mode') as AstMode,
      fallback: optionalString(message, 'fallback') as AstFallback,
      evidence: {
        mode: optionalString(message, 'evidenceMode') as AstEvidenceMode,
        store: optionalString(message, 'evidenceStore')
      },
      generatedRoots: optionalString(message, 'generatedRoots').split(',').map((entry) => entry.trim()).filter(Boolean),
      budgets: {
        maxFiles: positiveInteger(message, 'maxFiles'), maxBytes: positiveInteger(message, 'maxBytes'),
        maxFileBytes: positiveInteger(message, 'maxFileBytes')
      },
      languages: parseAstLanguageRows(optionalString(message, 'languages')),
      predicates: parseAstPredicateRows(optionalString(message, 'predicates'))
    };
  }
  private async savePolicy(message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const draft = this.draft(message); const errors = validateAstPolicyDraft(draft);
    if (errors.length) { this.error = errors.join(' '); this.render(); return; }
    const snapshot = this.store.current.snapshot; const source = String(snapshot?.definitionText ?? '');
    if (!snapshot || !source) { this.error = 'The governed workflow definition is unavailable. Refresh the repository before saving.'; this.render(); return; }
    try {
      const expected = createHash('sha256').update(source).digest('hex');
      await this.client.runText(['configuration', 'save', snapshot.definitionPath ?? 'singularity/workflow.yml', '--expected-sha256', expected], { input: updateAstPolicyYaml(source, draft) });
      this.notice = `Repository AST policy saved locally for ${this.repositoryScope()?.repository ?? 'the selected repository'}. Review and publish the configuration when ready.`; this.error = null;
      // Saving is complete before the independent repository refresh begins. Keep that success
      // visible even when a hidden panel deliberately defers its heavier diagnostics reload.
      this.render();
      await this.store.refresh();
    } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private async runScope(message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const operation = enumField(message, 'operation', ['context', 'build'] as const);
    const mode = enumField(message, 'mode', ['auto', 'off'] as const);
    if (!operation || !mode) return;
    const paths = Array.isArray(message.paths) ? message.paths.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry)) : [];
    const maxFiles = positiveInteger(message, 'maxFiles');
    const args = ['wm', 'ast', operation, '--mode', mode, '--max-files', String(maxFiles), '--json'];
    if (message.all === true) args.push('--all');
    for (const path of paths) args.push('--paths', path);
    try {
      this.result = commandData<AstRunResult>(await this.client.run(args));
      this.notice = operation === 'build' ? 'Derived AST cache built.' : 'AST context preview completed.';
      this.error = null;
      // The requested AST operation is complete at this point. Render that durable result before
      // refreshing independent doctor and workspace-inventory reads: either refresh may be slow on
      // a busy extension host, and must not make a completed preview appear to have hung.
      this.render();
      await this.refresh();
    }
    catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private async continueContext(message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const cursor = this.result?.nextCursor;
    if (!cursor || this.result?.operation !== 'context') {
      this.error = 'This AST result has no current continuation page.'; this.render(); return;
    }
    try {
      this.result = commandData<AstRunResult>(await this.client.run(['wm', 'ast', 'context', '--cursor', cursor, '--json']));
      this.notice = 'Next bounded AST context page loaded.'; this.error = null;
      // Continuation pages are useful as soon as their bounded command finishes. Do not hold the
      // new page behind unrelated diagnostics refreshes.
      this.render();
      await this.refresh();
    } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private async previewWarm(message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const provider = enumField(message, 'provider', ['sflow-java-jdt', 'sflow-python-pyright', 'sflow-kotlin-analysis', 'sflow-swift-sourcekit'] as const);
    const profile = stringField(message, 'profile'); const project = stringField(message, 'project');
    if (!provider || !profile || !project) return;
    try {
      this.warmPreview = commandData<AstWarmPreview>(await this.client.run([
        'wm', 'ast', 'warm', '--semantic', '--provider', provider, '--project', project,
        '--profile', profile, '--dry-run', '--json'
      ]));
      this.notice = 'Semantic warm-up preview is ready. Review every effect and type the exact confirmation.';
      this.error = null; this.render();
    } catch (error) { this.warmPreview = null; this.error = (error as Error).message; this.render(); }
  }
  private async executeWarm(confirmation: string, message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const preview = this.warmPreview;
    if (!preview?.ready || !preview.provider || !preview.project || !preview.profile || confirmation !== preview.confirmation) {
      this.error = 'The semantic warm-up confirmation does not match the current preview.'; this.render(); return;
    }
    try {
      await this.client.run(['wm', 'ast', 'warm', '--semantic', '--provider', preview.provider,
        '--project', preview.project, '--profile', preview.profile, '--confirm', confirmation, '--json']);
      this.warmPreview = null; this.notice = `Semantic binding warmed for ${preview.project}.`;
      this.error = null; this.render(); await this.refresh();
    } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private async previewCache(kind: 'prune' | 'clear', message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    try { this.preview = commandData<AstCachePreview>(await this.client.run(['wm', 'ast', 'cache', kind, '--dry-run', '--json'])); this.error = null; this.render(); }
    catch (error) { this.preview = null; this.error = (error as Error).message; this.render(); }
  }
  private async executeCache(kind: 'prune' | 'clear', confirmation: string, message: InboundMessage): Promise<void> {
    if (!this.acceptsRepositoryScope(message)) return;
    const expected = kind === 'clear' ? 'CLEAR AST CACHE' : 'PRUNE AST CACHE';
    if (this.preview?.action !== kind || confirmation !== expected) { this.error = `Type ${expected} exactly after previewing this operation.`; this.render(); return; }
    try {
      await this.client.run(['wm', 'ast', 'cache', kind, '--confirm', confirmation, '--json']);
      this.preview = null; this.notice = kind === 'clear' ? 'AST cache cleared.' : 'Stale AST cache records pruned.'; this.error = null; await this.refresh();
    } catch (error) { this.error = (error as Error).message; this.render(); }
  }
  private render(): void {
    const scope = this.repositoryScope();
    this.panel.title = scope ? `AST Intelligence — ${scope.repository}` : 'AST Intelligence';
    const token = nonce(); this.panel.webview.html = page('AST Intelligence', astIntelligenceBody(this.policy(), this.doctor, this.result, this.preview, this.warmPreview, this.notice, this.error, scope, this.repositoryInventory, this.repositoryInventoryError), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT, { nav: 'configuration' });
  }
}
