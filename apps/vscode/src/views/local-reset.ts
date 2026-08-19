/** Global local-state cleanup. No reset mode is implied and confirmations are mode-bound. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { commandData, list } from './surface-adapters.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { enumField, registerMessageRouter, stringField } from './messages.ts';
import { resetExecuteArgs, resetPlanFingerprint, resetPreviewArgs, type ResetMode } from './surface-contracts.ts';

interface ResetWorkspace { id?: string; name?: string; path?: string; disposition?: 'preserved' | 'deleted' }
interface ResetTarget { path?: string; type?: string; label?: string }
interface ResetPlan { schemaVersion?: number; mode?: ResetMode; confirmation?: string; completed?: boolean; cancelled?: boolean; workspaces?: ResetWorkspace[]; missingRegistrations?: string[]; remove?: string[]; preserve?: string[]; machineTargets?: ResetTarget[]; installerGeneratedPaths?: string[]; registryWarning?: string | null; capabilityState?: { registryFile?: string; cacheRoot?: string }; journalState?: { root?: string; remoteSync?: string }; vscodeReset?: { marker?: string; reset?: string[] } }

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('submit', (event) => { event.preventDefault(); vscode.postMessage({ type: event.target.dataset.message, ...Object.fromEntries(new FormData(event.target)) }); });
  document.addEventListener('click', (event) => { const el = event.target.closest('[data-message]'); if (el) vscode.postMessage({ type: el.dataset.message }); });
`;

export function localResetBody(plan: ResetPlan | null, error: string | null): string {
  const mode = plan?.mode ?? null; const expected = plan?.confirmation ?? '';
  return `<header><p class="eyebrow">Workspaces</p><h1>${icon('remove', { size: 24 })} Local Data & Reset</h1>
    <p class="meta">Preview exactly what will be preserved or deleted. This never uninstalls the CLI, extension, plugin, or skills, and never changes remote governed data.</p></header>
  ${error ? `<section class="warning"><strong>Reset refused</strong><p>${escape(error)}</p></section>` : ''}
  <section><h2>1. Choose a mode</h2><p>No mode is preselected.</p><div class="split-layout"><form data-message="preview"><input type="hidden" name="mode" value="forget-only"><div class="card"><h3>Forget local registrations</h3><p>Preserves every workspace directory, clone, branch, dirty file, worktree, and repository recovery record. Clears machine registrations and Singularity Flow personalization.</p><button type="submit">Preview forget-only</button></div></form>
    <form data-message="preview"><input type="hidden" name="mode" value="delete-workspaces"><div class="card warning"><h3>Delete workspace directories</h3><p>Permanently deletes validated registered workspace directories and their repository clones. Execution is allowed only from an empty VS Code window.</p><button class="secondary" type="submit">Preview destructive reset</button></div></form></div></section>
  ${plan ? `<section><h2>2. Review ${mode === 'forget-only' ? 'forget-only' : 'workspace deletion'} preview</h2><p><span class="badge">Schema v${escape(plan.schemaVersion ?? '?')}</span> Confirmation is <code>${escape(expected)}</code>.</p>
    ${plan.registryWarning ? `<p class="warning-text">${escape(plan.registryWarning)}</p>` : ''}
    <h3>Registered workspaces</h3><div class="table-wrap"><table><thead><tr><th>Disposition</th><th>Workspace</th><th>Directory</th></tr></thead><tbody>${list<ResetWorkspace>(plan.workspaces).map((workspace) => `<tr><td><strong>${escape(workspace.disposition ?? (mode === 'forget-only' ? 'preserved' : 'deleted'))}</strong></td><td>${escape(workspace.name ?? workspace.id ?? 'workspace')}</td><td><code>${escape(workspace.path ?? '')}</code></td></tr>`).join('') || '<tr><td colspan="3">No registered workspaces</td></tr>'}</tbody></table></div>
    <div class="split-layout"><div><h3>Remove</h3><ul>${list<string>(plan.remove).map((item) => `<li><code>${escape(item)}</code></li>`).join('') || '<li>Nothing</li>'}</ul></div><div><h3>Preserve</h3><ul>${list<string>(plan.preserve).map((item) => `<li>${escape(item)}</li>`).join('') || '<li>Nothing</li>'}</ul></div></div>
    <h3>Resolved machine targets</h3><ul>${list<ResetTarget>(plan.machineTargets).map((target) => `<li><strong>remove · ${escape(target.label ?? target.type ?? 'local state')}</strong> · <code>${escape(target.path ?? '')}</code></li>`).join('') || '<li>No existing machine targets</li>'}</ul>
    ${list<string>(plan.installerGeneratedPaths).length ? `<h3>Generated installer-checkout targets</h3><ul>${list<string>(plan.installerGeneratedPaths).map((target) => `<li><strong>remove</strong> · <code>${escape(target)}</code></li>`).join('')}</ul>` : ''}
    ${list<string>(plan.missingRegistrations).length ? `<h3>Missing registrations</h3><ul>${list<string>(plan.missingRegistrations).map((workspace) => `<li><code>${escape(workspace)}</code></li>`).join('')}</ul>` : ''}
    <div class="split-layout"><div><h3>Capability state</h3><p>Registry: <code>${escape(plan.capabilityState?.registryFile ?? 'none')}</code></p><p>Cache: <code>${escape(plan.capabilityState?.cacheRoot ?? 'none')}</code></p><h3>Journal</h3><p><code>${escape(plan.journalState?.root ?? 'none')}</code> · remote sync ${escape(plan.journalState?.remoteSync ?? 'never')}</p></div>
    <div><h3>VS Code reset marker</h3><p><code>${escape(plan.vscodeReset?.marker ?? 'none')}</code></p><ul>${list<string>(plan.vscodeReset?.reset).map((scope) => `<li>${escape(scope)}</li>`).join('') || '<li>No VS Code state</li>'}</ul></div></div>
    <h2>3. Confirm</h2><form data-message="execute"><input type="hidden" name="mode" value="${escape(mode ?? '')}"><label>Type <code>${escape(expected)}</code> exactly<input name="confirm" autocomplete="off" required></label><button class="${mode === 'delete-workspaces' ? 'secondary' : ''}" type="submit">${mode === 'forget-only' ? 'Forget local state' : 'Delete workspace directories'}</button></form></section>` : ''}`;
}

export class LocalResetPanel {
  private static current: LocalResetPanel | null = null;
  private plan: ResetPlan | null = null; private fingerprint: string | null = null; private error: string | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient) {
    this.panel = panel; this.client = client;
    panel.webview.onDidReceiveMessage((raw) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      this.router.route(raw);
    });
    panel.onDidDispose(() => { LocalResetPanel.current = null; }); this.render();
  }
  static show(context: vscode.ExtensionContext, client: SingularityFlowClient): LocalResetPanel {
    if (LocalResetPanel.current) { LocalResetPanel.current.panel.reveal(); return LocalResetPanel.current; }
    const panel = vscode.window.createWebviewPanel('singularityFlow.localReset', 'Local Data & Reset', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    LocalResetPanel.current = new LocalResetPanel(panel, client); return LocalResetPanel.current;
  }
  private router = registerMessageRouter('singularityFlow.localReset', {
    preview: (m) => { const mode = enumField(m, 'mode', ['forget-only', 'delete-workspaces'] as const); if (mode) void this.preview(mode); },
    execute: (m) => { const mode = enumField(m, 'mode', ['forget-only', 'delete-workspaces'] as const); const confirm = stringField(m, 'confirm'); if (mode && confirm) void this.execute(mode, confirm); }
  });
  private async readPlan(mode: ResetMode): Promise<ResetPlan> { return commandData<ResetPlan>(await this.client.run(resetPreviewArgs(mode))); }
  private async preview(mode: ResetMode): Promise<void> {
    try { this.plan = await this.readPlan(mode); this.fingerprint = resetPlanFingerprint(this.plan); this.error = null; } catch (e) { this.plan = null; this.fingerprint = null; this.error = (e as Error).message; }
    this.render();
  }
  private async execute(mode: ResetMode, confirmation: string): Promise<void> {
    if (!this.plan || this.plan.mode !== mode || confirmation !== this.plan.confirmation) return void vscode.window.showWarningMessage(`Type ${this.plan?.confirmation ?? 'the displayed confirmation'} exactly.`);
    if (mode === 'delete-workspaces' && (vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      this.error = 'Physical workspace deletion is allowed only from an empty VS Code window. Open a new empty window, then run Local Data & Reset there.'; this.render(); return;
    }
    try {
      const fresh = await this.readPlan(mode);
      if (resetPlanFingerprint(fresh) !== this.fingerprint) { this.plan = fresh; this.fingerprint = resetPlanFingerprint(fresh); this.error = 'Local reset targets changed after the preview. Review the refreshed preview and confirm again.'; this.render(); return; }
      await this.client.run(resetExecuteArgs(mode, confirmation));
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (e) { this.error = (e as Error).message; this.render(); }
  }
  private render(): void { const token = nonce(); this.panel.webview.html = page('Local Data & Reset', localResetBody(this.plan, this.error), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT); }
}
