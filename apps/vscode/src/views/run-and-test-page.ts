/**
 * The capability page's "Run & test" section. [RUN, VS Code]
 *
 * Markup only: every button posts `{ type: 'run-and-test', action, capability, ... }` through the
 * capability page's script, and the host decides. Environment values never appear here; only each
 * environment's binding status and, when it is not bound, the command a person runs themselves.
 */
import { escape, icon } from './webview.ts';
import type { RunAndTestView, StartRow } from './run-and-test-model.ts';

const attributes = (view: RunAndTestView, action: string, extra: Record<string, string> = {}): string =>
  ` data-rt="${escape(action)}" data-rt-capability="${escape(view.capability)}"${Object.entries(extra)
    .map(([name, value]) => ` data-rt-${name}="${escape(value)}"`).join('')}`;

const PILL: Record<StartRow['state'], string> = {
  ready: 'ok', starting: 'wait', started: 'wait', stopped: '', failed: 'bad', 'not-declared': 'bad'
};

function startRow(view: RunAndTestView, row: StartRow): string {
  return `<tr data-rt-entry="${escape(row.id)}" data-rt-state="${escape(row.state)}">
    <td><strong><code>${escape(row.id)}</code></strong><br><small class="muted rt-command">${escape(row.command)}</small>
      ${row.workingDirectory ? `<br><small class="muted">in ${escape(row.workingDirectory)}</small>` : ''}</td>
    <td><span class="pill ${PILL[row.state]}">${escape(row.stateWords)}</span>${row.detail ? ` <small>${escape(row.detail)}</small>` : ''}
      ${row.environment ? `<br><small class="muted">environment ${escape(row.environment)}</small>` : ''}</td>
    <td><div class="rt-actions">
      <button type="button" class="compact-action"${attributes(view, 'start', { entry: row.id })}${row.canStart ? '' : ' disabled'}>${icon('start')}Start</button>
      <button type="button" class="secondary compact-action"${attributes(view, 'stop', { entry: row.id })}${row.canStop ? '' : ' disabled'}>Stop</button>
      <button type="button" class="secondary compact-action"${attributes(view, 'open', { entry: row.id })}${row.canOpen ? '' : ' disabled'}>Open in browser</button>
    </div></td></tr>`;
}

function environmentHtml(view: RunAndTestView): string {
  if (!view.environments.length) return '';
  const options = view.environments.map((choice) =>
    `<option value="${escape(choice.name)}"${choice.selected ? ' selected' : ''}>${escape(`${choice.name}: ${choice.words}`)}</option>`).join('');
  const bind = view.bind && view.environment ? `<div class="notice rt-bind" role="status">
      <p><strong>${escape(view.environment)}</strong> is not bound on this computer. Bind its values with your own secret helper, on standard input:</p>
      <p><code>${escape(view.bind)}</code>
        <button type="button" class="secondary compact-action"${attributes(view, 'copy-bind', { environment: view.environment })}>Copy</button></p>
      <p class="muted">VS Code never asks for, holds or shows a value.</p></div>` : '';
  return `<label class="field rt-environment"><span>Environment</span>
      <select data-rt-picker data-rt-capability="${escape(view.capability)}" aria-label="Environment for ${escape(view.name)}">${options}</select>
      <small>Each environment has its own values, bound privately on this computer. The last one you chose is remembered for this capability.</small>
    </label>${bind}`;
}

function testsHtml(view: RunAndTestView): string {
  const commands = view.testCommands.map((command) =>
    `<button type="button" class="secondary compact-action"${attributes(view, 'tests', { command })}${view.testsRunning ? ' disabled' : ''}>Run ${escape(command)}</button>`).join('');
  const last = view.lastRun
    ? `<p class="rt-last" data-rt-last="${escape(view.lastRun.runId)}"><strong>Last run:</strong> ${escape(view.lastRun.classLabel)} · ${escape(view.lastRun.line)}
        <button type="button" class="link"${attributes(view, 'summary')}>Open test summary</button>
        ${view.lastRun.label ? `<br><small class="muted">${escape(view.lastRun.label)}</small>` : ''}</p>
      ${view.lastRun.blocked.map((line) => `<p class="notice rt-blocked" role="status"><strong>Not run.</strong> ${escape(line)}</p>`).join('')}`
    : view.lastRunNote ? `<p class="rt-last muted">${escape(view.lastRunNote)}
        <button type="button" class="link"${attributes(view, 'summary')}>Open test summary</button></p>` : '';
  return `<h3>${icon('phase')}Tests</h3>
    <div class="action-grid rt-tests">
      <button type="button"${attributes(view, 'tests', { command: '' })}${view.testsRunning ? ' disabled' : ''}>${icon('start')}Run all tests</button>
      ${commands}
      ${view.testsRunning ? `<button type="button" class="secondary"${attributes(view, 'cancel-tests')}>Cancel the run</button>` : ''}
    </div>
    ${view.testsRunning ? '<p class="muted" role="status">Tests are running in their task terminal.</p>' : ''}
    ${last}`;
}

/** Nothing for a collection or another repository; a hint when the window does not know its repository. */
export function runAndTestHtml(view: RunAndTestView | null): string {
  if (!view || view.ownership === 'not-delivery' || view.ownership === 'elsewhere') return '';
  const head = `<div class="card-head"><div><h2>${icon('start')}Run &amp; test</h2>
      <p class="muted">Start ${escape(view.name)} and run its tests on this computer. Commands come from singularity/capabilities.yml and the workflow; each one asks once before it first runs.</p></div>
      <span class="grow"></span>${view.ownership === 'here'
    ? `<button type="button" class="secondary compact-action"${attributes(view, 'refresh')}${view.loading ? ' disabled' : ''}>${icon('refresh')}Refresh</button>` : ''}</div>`;
  if (view.ownership === 'unknown-repository') {
    return `<section class="plain run-and-test" data-run-and-test="${escape(view.capability)}">${head}
      <p class="notice">Open this capability's repository from Workspaces to run it here: this window does not know which repository it has open.</p></section>`;
  }
  const starts = view.starts.length
    ? `<table class="rt-start"><thead><tr><th>Start entry</th><th>State</th><th>Actions</th></tr></thead><tbody>${view.starts.map((row) => startRow(view, row)).join('')}</tbody></table>`
    : `<p class="muted">${escape(view.startsNote ?? (view.loading ? 'Reading the start entries…' : ''))}</p>`;
  return `<section class="plain run-and-test" data-run-and-test="${escape(view.capability)}">${head}
    ${view.error ? `<p class="notice error" role="alert">${icon('blocked')}${escape(view.error)}</p>` : ''}
    ${view.notice ? `<p class="notice ok" role="status">${escape(view.notice)}</p>` : ''}
    ${environmentHtml(view)}
    <h3>${icon('delivery')}Application</h3>
    ${starts}
    ${testsHtml(view)}
  </section>`;
}

export const RUN_AND_TEST_STYLE = `
.run-and-test h3 { display:flex; gap:.4rem; align-items:center; margin:1rem 0 .4rem; }
.rt-start td { vertical-align:top; }
.rt-command { overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family); }
.rt-actions { display:flex; flex-wrap:wrap; gap:.4rem; }
.rt-environment { max-width:28rem; }
.rt-bind code { overflow-wrap:anywhere; }
.rt-last { margin:.6rem 0 0; }
.run-and-test .rt-tests { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.run-and-test .rt-tests > button { margin:0; }
`;

/**
 * Click and change handling for the section, run inside the capability page's script. It reads
 * only data attributes the markup above wrote; the host validates every field again.
 */
export const RUN_AND_TEST_SCRIPT = `
  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-rt]');
    if (!button || button.disabled) return;
    event.preventDefault();
    vscode.postMessage({ type: 'run-and-test', action: button.dataset.rt, capability: button.dataset.rtCapability,
      entry: button.dataset.rtEntry || '', command: button.dataset.rtCommand || '', environment: button.dataset.rtEnvironment || '' });
  });
  document.addEventListener('change', (event) => {
    const select = event.target.closest && event.target.closest('[data-rt-picker]');
    if (!select) return;
    vscode.postMessage({ type: 'run-and-test', action: 'environment', capability: select.dataset.rtCapability, environment: select.value });
  });
`;
