/** Guided upgrade plus a one-confirm hard cutover over the existing guarded authorities. */
import { brandLockup, escape, icon } from './webview.ts';
import { afterInstallComplete, safeUpgradeComplete, type AfterInstallView } from './after-install-model.ts';
import { isSafeWorkspaceReinitializationPreview } from './workspaces-model.ts';

export function afterInstallHtml(view: AfterInstallView): string {
  const disabled = view.busy ? ' disabled' : '';
  const productReady = view.product?.verdict === 'aligned';
  const upgraded = safeUpgradeComplete(view.upgrade);
  const complete = afterInstallComplete(view);
  const result = view.upgrade;
  return `<header class="page-header">${brandLockup()}<p class="meta">Existing capabilities &amp; workspaces</p>
    <h1>After install</h1><p class="muted">Bring your existing repositories and workspace references up to the installed SFlow build. No remapping or workspace recreation.</p></header>
    ${view.busy ? `<p class="notice" role="status" aria-live="polite">${icon('wait')}${escape(view.busy)}</p>` : ''}
    ${view.error ? `<section class="notice warning" role="alert"><strong>Action needs attention</strong><p>${escape(view.error)}</p><p>Preserved work is not discarded. Recheck after resolving the reported issue.</p></section>` : ''}
    <section class="plain"><h2>1. Check the installed build ${productReady ? '<span class="pill ok">aligned</span>' : ''}</h2>
      <p class="muted">The terminal, VS Code and Copilot should run the same installed build—not just the same version number.</p>
      ${view.product ? `<div class="table-scroll"><table><thead><tr><th>Surface</th><th>Status</th><th>Running build</th></tr></thead><tbody>
        ${view.product.surfaces.map(surface => `<tr><td>${escape(surface.id)}</td><td>${escape(surface.state)}</td><td><code>${escape(surface.live ?? 'not reported')}</code>${surface.reason ? `<p class="muted">${escape(surface.reason)}</p>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Build alignment has not been verified.</p>'}
      ${view.productError ? `<p class="notice warning">${escape(view.productError)}</p>` : ''}
      ${view.product && !productReady ? `<p class="notice warning">${escape(view.product.verdict)}. Align retained surfaces where offered, or reinstall the complete matching package and reload VS Code before upgrading repositories.</p>
        ${view.product.next.map(next => `<p class="muted">${escape(next.reason)}<br><code>${escape(next.command)}</code></p>`).join('')}` : ''}
      <p class="card-foot"><button class="secondary" data-after-action="recheck"${disabled}>Recheck build &amp; workspaces</button>
        ${view.product?.verdict === 'repairable' ? `<button data-after-action="align"${disabled}>Align installed surfaces…</button>` : ''}
        <button class="secondary" data-after-action="reload"${disabled}>Reload VS Code</button></p>
    </section>
    <section class="plain"><h2>2. Choose an existing workspace</h2>
      <p class="muted">Upgrade one workspace at a time. This covers all its registered repositories, including a shared capability authority where registered.</p>
      ${view.workspaces.length ? `<div class="table-scroll"><table><thead><tr><th>Workspace</th><th>Directory</th><th></th></tr></thead><tbody>
        ${view.workspaces.map(workspace => `<tr><td>${escape(workspace.name || workspace.id)}</td><td><code>${escape(workspace.path)}</code></td><td><button class="secondary" data-after-select="${escape(workspace.path)}"${disabled}>${view.selected === workspace.path ? 'Selected' : 'Choose'}</button></td></tr>`).join('')}
      </tbody></table></div>` : `<p class="muted">No active workspace could be listed. For an already-onboarded capability, use an existing clone or repository setup recovery—not a factory reset.</p>`}
      ${view.workspace ? `<p><strong>${escape(view.workspace.workspace.name)}</strong> · ${view.workspace.repositories.length} repositories</p>
        <ul class="plain-list">${view.workspace.repositories.map(repository => `<li>${escape(repository.id)} · ${escape(repository.state ?? 'unknown')}<br><code>${escape(repository.absolutePath ?? repository.path ?? 'path unavailable')}</code></li>`).join('')}</ul>` : ''}
      <p class="card-foot"><button class="secondary" data-after-action="workspaces"${disabled}>Open workspace maintenance</button>
        <button class="secondary" data-after-action="repository-setup"${disabled}>Find / repair repository setup…</button></p>
      <section class="cutover-action"><h3>Hard cutover (pilot)</h3>
        <p class="muted">One guided action: preview the exact Story list and upgrade, confirm once, retire those Stories read-only, upgrade current configuration, refresh local pins, and verify. Their historical records no longer need upgrading. No Story files or branches are deleted, and no workspace is recreated.</p>
        <p class="card-foot"><button class="secondary" data-after-action="cutover"${disabled || !productReady || !view.workspace ? ' disabled' : ''}>Hard cutover: discontinue old Stories…</button></p>
      </section>
    </section>
    <section class="plain"><h2>3. Upgrade repository configuration ${upgraded ? '<span class="pill ok">verified</span>' : ''}</h2>
      <p class="muted">Preview framework-owned workflow, agent, skill and template updates to <code>sflow/config</code> and its state mirror. Custom assets, mappings, source code, approvals and Story history are preserved.</p>
      <p class="card-foot"><button data-after-action="preview"${disabled || !productReady || !view.workspace ? ' disabled' : ''}>Preview safe upgrade</button></p>
      ${result ? `<p>Status: <strong>${escape(result.status)}</strong> · ${escape(result.total)} repositories · ${escape(result.updated)} updated</p>
        ${result.storyCutover ? `<p>Story cutover: <strong>${escape(result.storyCutover.status)}</strong></p><p>${escape(result.storyCutover.statement)}</p>
          <ul class="plain-list">${result.storyCutover.repositories.map(item => `<li>${escape(item.repository)}: ${escape(item.retiredIds?.join(', ') || 'No known Stories')}</li>`).join('')}</ul>` : ''}
        ${result.planId ? `<p class="muted">Reviewed plan: <code>${escape(result.planId)}</code></p>` : ''}
        <div class="table-scroll"><table><thead><tr><th>Repository</th><th>Result / next step</th></tr></thead><tbody>${result.results.map(repository => `<tr><td>${escape(repository.repository)}</td><td>${escape(repository.status)}
          ${repository.error ? `<p class="notice warning">${escape(repository.error)}</p>` : ''}
          ${repository.proposalBranch ? `<p>Review and merge the retained proposal through normal Git review:<br><code>${escape(repository.proposalBranch)}</code>. Then create a fresh preview.</p>` : ''}
          ${repository.conflicts?.length ? `<p class="muted">Preserved custom content: ${repository.conflicts.map(conflict => escape(conflict.path)).join(', ')}</p>` : ''}
          ${repository.files?.length ? `<details><summary>${repository.files.length} configuration files</summary><ul class="plain-list">${repository.files.map(file => `<li><code>${escape(file)}</code></li>`).join('')}</ul></details>` : ''}
        </td></tr>`).join('')}</tbody></table></div>
        <details><summary>Schema compatibility, warnings and exact diagnostics</summary><pre>${escape(JSON.stringify(result, null, 2))}</pre></details>
        ${isSafeWorkspaceReinitializationPreview(result) ? `<p class="card-foot"><button data-after-action="apply"${disabled || !productReady ? ' disabled' : ''}>Review &amp; apply this upgrade…</button></p>` : ''}
        ${result.status === 'partial' || result.status === 'blocked' ? '<p class="notice warning">Upgrade is not complete. Resolve the reported Git review, schema or checkout issue, then preview again. Nothing is force-pushed or reset.</p>' : ''}` : ''}
    </section>
    <section class="plain"><h2>4. Refresh workspace references &amp; verify</h2>
      <p class="muted">After the upgrade completes, refresh each existing checkout’s selected authority pin and recheck this workspace. This does not pull source, switch branches, clone deferred repositories, run tests or change an existing Story’s configuration snapshot.</p>
      <p class="card-foot"><button data-after-action="references"${disabled || !productReady || !upgraded ? ' disabled' : ''}>Refresh &amp; verify this workspace…</button></p>
      ${view.references ? `<ul class="plain-list">${view.references.map(reference => `<li><strong>${escape(reference.id)}</strong> · ${escape(reference.status)}${reference.reason ? `<p class="muted">${escape(reference.reason)}</p>` : ''}</li>`).join('')}</ul>` : ''}
      ${complete ? `<p class="notice">${icon('ok')}After-install checks complete for this workspace. New Stories can use the upgraded configuration.</p>` : view.verified ? '<p class="notice warning">Verification needs attention. Use workspace maintenance for the listed checkout or authority issue, then repeat the affected step.</p>' : ''}
      <p class="muted">${result?.storyCutover ? 'Retired Stories are read-only; start new Stories with new IDs.' : 'Existing Stories retain their pinned configuration and approvals.'} Repeat this journey on other laptops to refresh their local references.</p>
    </section>`;
}

export const AFTER_INSTALL_STYLE = `
  .table-scroll { overflow-x:auto; } .table-scroll td { overflow-wrap:anywhere; }
  .table-scroll code { white-space:normal; } pre { max-height:320px; overflow:auto; }
  .card-foot { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  h2 .pill { font-size:12px; font-weight:400; margin-left:8px; }
  .cutover-action { margin-top:20px; padding-top:12px; border-top:1px solid var(--vscode-panel-border); }
`;

export const AFTER_INSTALL_SCRIPT = `
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-after-action],[data-after-select]');
    if (!target || target.disabled) return;
    if (target.dataset.afterSelect !== undefined) {
      window.__sfVscode.postMessage({type:'select', path:target.dataset.afterSelect});
    } else window.__sfVscode.postMessage({type:target.dataset.afterAction});
  });
`;
