import { escape, icon } from './webview.ts';
import type { TestSetupView } from './test-setup-model.ts';
import { TEST_RESULT_ADAPTERS } from '../../../../src/external-command-policy.mjs';

function commandRow(command: Record<string, any> = {}): string {
  return `<div class="subsection" data-test-command data-original="${escape(JSON.stringify(command))}">
    <div class="form-grid">
      <label class="field"><span>Command ID</span><input data-test-id value="${escape(command.id ?? '')}" required></label>
      <label class="field"><span>Module directory</span><input data-test-cwd value="${escape(command.workingDirectory ?? '.')}" required></label>
      <label class="field span-2"><span>Executable and arguments (JSON array)</span><input data-test-argv value="${escape(JSON.stringify(command.argv ?? []))}" placeholder='["npm", "test", "--", "--watch=false"]' required><small>Separate arguments work on Windows and macOS. Do not paste a shell pipeline.</small></label>
      <label class="field"><span>Result adapter</span><select data-test-adapter><option value="">Choose reporter</option>${TEST_RESULT_ADAPTERS.map(adapter => `<option value="${adapter}"${command.result?.adapter === adapter ? ' selected' : ''}>${adapter}</option>`).join('')}</select></label>
      <label class="field"><span>Report path (relative to module directory)</span><input data-test-report value="${escape(command.result?.path ?? '')}" required></label>
      <label class="field"><span>Affected directories (comma separated)</span><input data-test-roots value="${escape((command.affectedRoots ?? []).join(', '))}" required></label>
      <label class="field"><span>Timeout (milliseconds)</span><input data-test-timeout type="number" min="1000" max="7200000" value="${escape(command.timeoutMs ?? 120000)}" required></label>
    </div><button type="button" class="secondary" data-test-remove>Remove command</button>
  </div>`;
}

export function testSetupHtml(view: TestSetupView): string {
  const selected = view.targets.find(target => target.id === view.selected);
  return `<section class="plain"><h2>${icon('phase')}Test setup</h2>
    <p>Configure test methods for this repository. Inspection reads only selected module manifests; it does not clone, install dependencies, run tests, or claim a passing baseline.</p>
    <p class="notice warning">Existing Stories retain their pinned configuration. After merging a runner change, use <code>/sf-test-setup</code> or <code>/sf-recover</code> to review adoption for the current code phase. Saving here does not change any Story.</p>
    <label class="field"><span>Inspect module directories (comma separated)</span><input id="test-inspection-roots" value="${escape(view.inspection?.sourceRoots.join(', ') ?? '.')}" placeholder="apps/client, services/api"><small>For nested Angular and monorepo applications, enter their exact directories. No recursive repository scan.</small></label>
    <p><button type="button" class="secondary" data-test-inspect>Read repository &amp; suggest</button><button type="button" class="secondary" data-action="test-setup-copilot">Ask Copilot for suggestions</button></p>
    <div id="test-inspection-results" aria-live="polite">${view.inspection ? `<p>Inspected <code>${escape(view.inspection.repositoryPath)}</code>. Baseline: unverified; no tests ran.</p>
      ${view.inspection.diagnostics.map(entry => `<p class="notice warning">${escape(entry.path)}: ${escape(entry.message)}</p>`).join('')}
      ${view.inspection.suggestions.map((command, index) => `<div class="summary-card"><code>${escape(JSON.stringify(command.argv))}</code><span>Module: ${escape(command.workingDirectory)} · ${escape((command.result as Record<string, unknown>)?.adapter)}</span><button type="button" class="secondary" data-test-suggestion="${index}" data-command="${escape(JSON.stringify(command))}">Add suggestion to draft</button></div>`).join('')}` : ''}</div>
    <label class="field"><span>Workflow / phase</span><select data-test-target><option value="">Choose workflow and phase</option>${view.targets.map(target => `<option value="${escape(target.id)}"${target.id === selected?.id ? ' selected' : ''}>${escape(target.label)}</option>`).join('')}</select><small>Choose one workflow to avoid changing other workflows; Shared workflows changes the shared phase default.</small></label>
    ${selected ? `<form id="test-setup-form" data-target="${escape(selected.id)}">
      ${selected.legacyCommands.length ? '<p class="notice warning">Legacy string quality commands are preserved. Review them in Workflow Studio if replacing one with a structured test command.</p>' : ''}
      <div id="test-command-rows">${selected.commands.map(commandRow).join('')}</div>
      <template id="test-command-template">${commandRow()}</template>
      <p><button type="button" class="secondary" data-test-add>Add test command</button></p>
      <p class="muted">The command must produce the selected report and execute real tests. Required commands remain required; intake separately selects changed-and-affected or all-configured execution and how to handle observed existing failures.</p>
      <button type="submit">Review &amp; save test configuration</button>
    </form>` : `<p>${view.targets.length ? 'Select the exact workflow and phase before adding commands.' : 'No configured phases. Create a workflow before saving test commands.'}</p>`}
  </section>`;
}

export const TEST_SETUP_SCRIPT = `
  const testRows = document.getElementById('test-command-rows');
  window.addEventListener('message', (event) => {
    if (!['test-setup-inspected', 'test-setup-inspection-error'].includes(event.data?.type)) return;
    const button = document.querySelector('[data-test-inspect]'); if (button) button.disabled = false;
    if (event.data.type === 'test-setup-inspection-error') return showRuntime(event.data.error, false);
    const inspection = event.data.inspection; const results = document.getElementById('test-inspection-results');
    if (!inspection || !results) return;
    results.replaceChildren();
    const note = document.createElement('p'); note.textContent = 'Inspected ' + inspection.repositoryPath + '. Baseline: unverified; no tests ran.'; results.append(note);
    for (const entry of inspection.diagnostics) {
      const warning = document.createElement('p'); warning.className = 'notice warning'; warning.textContent = entry.path + ': ' + entry.message; results.append(warning);
    }
    for (const [index, command] of inspection.suggestions.entries()) {
      const card = document.createElement('div'); card.className = 'summary-card';
      const text = document.createElement('code'); text.textContent = JSON.stringify(command.argv); card.append(text);
      const detail = document.createElement('span'); detail.textContent = 'Module: ' + command.workingDirectory + ' · ' + command.result.adapter; card.append(detail);
      const add = document.createElement('button'); add.type = 'button'; add.className = 'secondary'; add.dataset.testSuggestion = String(index); add.dataset.command = JSON.stringify(command); add.textContent = 'Add suggestion to draft'; card.append(add);
      results.append(card);
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target.closest('[data-test-target]');
    if (target) vscode.postMessage({ type: 'select-test-target', id: target.value });
  });
  document.addEventListener('click', (event) => {
    const inspect = event.target.closest('[data-test-inspect]');
    if (inspect) {
      inspect.disabled = true;
      vscode.postMessage({ type: 'inspect-test-setup', sourceRoots: csv(document.getElementById('test-inspection-roots').value) });
    }
    const remove = event.target.closest('[data-test-remove]');
    if (remove) { remove.closest('[data-test-command]').remove(); markDirty(); }
    const suggestion = event.target.closest('[data-test-suggestion]');
    if (event.target.closest('[data-test-add]') || suggestion) {
      const template = document.getElementById('test-command-template');
      if (!testRows || !template) return;
      const row = template.content.firstElementChild.cloneNode(true);
      if (suggestion) {
        const command = JSON.parse(suggestion.dataset.command); row.dataset.original = JSON.stringify(command);
        row.querySelector('[data-test-id]').value = command.id;
        row.querySelector('[data-test-cwd]').value = command.workingDirectory;
        row.querySelector('[data-test-argv]').value = JSON.stringify(command.argv);
        row.querySelector('[data-test-adapter]').value = command.result.adapter;
        row.querySelector('[data-test-report]').value = command.result.path;
        row.querySelector('[data-test-roots]').value = command.affectedRoots.join(', ');
        row.querySelector('[data-test-timeout]').value = command.timeoutMs ?? 120000;
      }
      testRows.append(row); markDirty();
    }
  });
  function submitTestSetup(form) {
    try {
      const commands = Array.from(testRows.querySelectorAll('[data-test-command]')).map(row => {
        const prior = JSON.parse(row.dataset.original);
        delete prior.command;
        return { ...prior, id: row.querySelector('[data-test-id]').value.trim(), kind: 'test', modelPolicy: 'never',
          argv: JSON.parse(row.querySelector('[data-test-argv]').value), workingDirectory: row.querySelector('[data-test-cwd]').value.trim(),
          affectedRoots: csv(row.querySelector('[data-test-roots]').value), timeoutMs: Number(row.querySelector('[data-test-timeout]').value),
          result: { ...prior.result, adapter: row.querySelector('[data-test-adapter]').value, path: row.querySelector('[data-test-report]').value.trim(), minimumDiscovered: prior.result?.minimumDiscovered ?? 1 } };
      });
      vscode.postMessage({ type: 'save-test-setup', target: form.dataset.target, commands });
    } catch (error) {
      savingForm = false;
      form.querySelector('button[type="submit"]').disabled = false;
      showRuntime('Arguments must be a valid JSON array: ' + error.message, false);
    }
  }
`;
