/**
 * The agent packages page body and script, kept free of the `vscode` module so tests render it
 * directly. It shows what `apm status` read; its buttons only ask the panel to open a file, open
 * Workflow Studio, or put an APM command in a terminal for the person to run.
 */
import { escape } from './webview.ts';
import { APM_STATE_WORDS, type ApmBinding, type ApmPackage, type ApmView } from './apm-packages-model.ts';

function button(action: string, label: string, secondary = true): string {
  return `<button type="button"${secondary ? ' class="secondary"' : ''} data-apm="${escape(action)}">${escape(label)}</button>`;
}

function primitiveWords(entry: ApmPackage): string {
  return ['agent', 'skill', 'instruction', 'prompt'].map((kind) => {
    const names = [...new Set(entry.primitives.filter((item) => item.kind === kind).map((item) => item.name))];
    return names.length ? `${kind}${names.length === 1 ? '' : 's'} ${names.join(', ')}` : null;
  }).filter(Boolean).join('; ');
}

function packageHtml(entry: ApmPackage): string {
  const at = [entry.version, entry.commit ? `@ ${entry.commit.slice(0, 12)}` : null].filter(Boolean).join(' ');
  const changed = entry.files.modified + entry.files.missing;
  return `<li><strong>${escape(entry.label)}</strong>${at ? ` <span class="meta">${escape(at)}</span>` : ''}${entry.depth > 1 ? ' <span class="meta">(needed by another package)</span>' : ''}
    <p>${escape(primitiveWords(entry) || 'no agents, skills, instructions or prompts')} · ${entry.files.total} file${entry.files.total === 1 ? '' : 's'}${changed
      ? ` · <strong class="apm-warning">${changed} not as APM wrote ${changed === 1 ? 'it' : 'them'}</strong>` : ''}</p></li>`;
}

function bindingHtml(binding: ApmBinding): string {
  const steps = `${binding.defaultFor.length ? binding.defaultFor.join(', ') : 'no step by default'}${binding.steps.length ? ` (may draft ${binding.steps.join(', ')})` : ''}`;
  return binding.active
    ? `<li><strong>${escape(binding.agent)}</strong> drafts ${escape(steps)}.</li>`
    : `<li><strong>${escape(binding.agent)}</strong> would draft ${escape(steps)}, but ${escape(binding.waiting ?? 'it cannot be used')}.
        <p class="meta">Until then each step keeps its workflow's own agent; nothing is blocked.</p></li>`;
}

/** The page body; `error` replaces it when the status could not be read. */
export function apmPackagesHtml(view: ApmView | null, error: string | null): string {
  const header = `<header><h1>Agent packages</h1>
    <p>The agents, skills, instructions and prompts this repository gets from APM packages, whether each file is still the one APM wrote, and which steps their agents draft. Reading this needs no APM CLI and no network.</p>
    ${button('refresh', 'Refresh')}</header>`;
  if (error || !view) return `${header}<p class="notice${error ? ' error' : ''}" role="status">${escape(error ?? 'Reading the APM files…')}</p>`;
  const healthy = view.state === 'intact' || view.state === 'absent';
  const packages = view.packages.length
    ? `<ul>${view.packages.map(packageHtml).join('')}</ul>`
    : '<p>No packages are locked yet.</p>';
  const bindings = view.bindings.length ? `<section><h2>Steps APM agents draft</h2><ul>${view.bindings.map(bindingHtml).join('')}</ul>
      <div class="apm-actions">${button('studio', 'Choose steps in Workflow Studio')}</div></section>` : '';
  const unusable = view.unusable.length ? `<section><h2>Agents SFlow cannot use</h2><ul>${view.unusable.map((entry) =>
    `<li><strong>${escape(entry.name)}</strong> <code>${escape(entry.path)}</code>, from ${escape(entry.package)}: ${escape(entry.reason)}</li>`).join('')}</ul>
      <p class="meta">They are left out of SFlow's agents and never stop configuration from loading.</p></section>` : '';
  const findings = view.findings.length ? `<section><h2>What apm status found</h2><ul>${view.findings.slice(0, 20).map((entry) =>
    `<li>${escape(entry.message)}${entry.owner ? ` <span class="meta">(from ${escape(entry.owner)})</span>` : ''}</li>`).join('')}</ul>
      ${view.findings.length > 20 ? `<p class="meta">…and ${view.findings.length - 20} more (singularity-flow apm status --json).</p>` : ''}</section>` : '';
  const own = view.ownAgents.length ? `<p class="meta">${view.ownAgents.length} agent${view.ownAgents.length === 1 ? ' in .github/agents is' : 's in .github/agents are'} this repository's own, not from APM.</p>` : '';
  const next = view.nextActions.length ? `<section><h2>Next</h2><ul>${view.nextActions.map((action) =>
    `<li><code>${escape(action.command)}</code>${action.why ? ` — ${escape(action.why)}` : ''}</li>`).join('')}</ul></section>` : '';
  const cli = view.cli ? `APM CLI here: ${escape(view.cli)}.` : 'No APM CLI on this machine; installing and updating need it, reading does not.';
  return `${header}
    ${view.project ? `<p class="meta">APM project ${escape(view.project)}${view.lockedBy ? ` · locked by apm ${escape(view.lockedBy)}` : ''}</p>` : ''}
    <p class="notice${healthy ? '' : ' warning'}" role="status">${escape(APM_STATE_WORDS[view.state] ?? view.state)}</p>
    <section><h2>Packages</h2>${packages}${own}
      <div class="apm-actions">${button('install', 'Install a package…', false)}${view.packages.length ? button('update', 'Update packages…') : ''}
        ${view.project ? button('open-manifest', 'Open apm.yml') : ''}${view.lockedBy ? button('open-lock', 'Open apm.lock.yaml') : ''}</div></section>
    ${bindings}${unusable}${findings}${next}
    <p class="muted">${cli} Installing and updating run in a terminal, where you press Enter yourself: they change which agents run, and each is committed on an apm/ branch for a pull request.</p>`;
}

export const APM_PACKAGES_STYLE = `
.apm-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.apm-warning{color:var(--vscode-editorWarning-foreground)}
section ul li p,code{overflow-wrap:anywhere}`;

export const APM_PACKAGES_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-apm]') : null;
    if (!target || target.disabled) return;
    vscode.postMessage({ type: 'action', action: target.dataset.apm });
  });
`;
