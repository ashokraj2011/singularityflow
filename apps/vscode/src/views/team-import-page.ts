/** Inspect a team directory, convert it with Copilot, check it, write the bundle, import it in Studio. */
import { brandLockup, escape, icon } from './webview.ts';
import { teamImportReady, type TeamImportCompile, type TeamImportRepository, type TeamImportView } from './team-import-model.ts';

const STATE_TEXT: Record<string, string> = {
  invalid: 'Invalid: Copilot repairs the findings it owns',
  unsupported: 'Unsupported: part of the team process has no SFlow equivalent',
  'needs-decision': 'Needs your decision',
  'portable-ready': 'Ready to write',
  'ready-for-destination': 'Ready to write and import into the open repository',
  'awaiting-candidate': 'Waiting for Copilot to write the candidate'
};

function statePill(state: string): string {
  const tone = state === 'portable-ready' || state === 'ready-for-destination' ? 'ok' : state === 'awaiting-candidate' || state === 'needs-decision' ? 'wait' : 'bad';
  return `<span class="pill ${tone}">${escape(STATE_TEXT[state] ?? state)}</span>`;
}

function checkHtml(check: TeamImportCompile, disabled: string, repository: TeamImportRepository | null): string {
  const workflow = check.workflow;
  const blocking = check.findings.filter(finding => finding.severity !== 'warning');
  return `<p>${statePill(check.state)}${check.bundleSha256 ? ` <span class="muted">bundle <code>${escape(check.bundleSha256.slice(0, 19))}</code></span>` : ''}</p>
    ${workflow ? `<p><strong>${escape(workflow.label ?? workflow.id)}</strong> <code>${escape(workflow.id)}</code></p>
      <ol class="phases">${workflow.phases.map(phase => `<li>${escape(phase.label ?? phase.id)} <span class="muted">· ${escape(phase.agent ?? 'no agent')}${phase.code ? ' · writes code' : ''}</span></li>`).join('')}</ol>
      ${workflow.decisions.length ? `<p class="muted">Decisions: ${workflow.decisions.map(decision => `${escape(decision.kind)} after ${escape(decision.after)}`).join(', ')}</p>` : ''}` : ''}
    <p class="muted">Route simulation: ${escape(check.routeSimulation.status)}${check.destination ? ` · import into ${check.destination.root === repository?.root ? `<strong>${escape(repository.label)}</strong>` : `<code>${escape(check.destination.root)}</code>`}: ${escape(check.destination.status)}` : ''}</p>
    ${check.questions.length ? `<section class="questions"><h3>Questions for you</h3>${check.questions.map(question => `<div class="question"><p>${escape(question.question)}${question.blocking ? '' : ' <span class="muted">(optional)</span>'}</p>
      <p class="card-foot">${question.choices.map(choice => `<button class="secondary" data-team-answer="${escape(question.id)}" data-team-choice="${escape(choice)}"${disabled}>${escape(choice)}</button>`).join('')}</p></div>`).join('')}</section>` : ''}
    ${check.answers.length ? `<details><summary>${check.answers.length} answered</summary><ul class="plain-list">${check.answers.map(answer => `<li>${escape(answer.question ?? answer.id)}: <strong>${escape(answer.choice)}</strong></li>`).join('')}</ul></details>` : ''}
    ${check.findings.length ? `<div class="table-scroll"><table><thead><tr><th>Who fixes it</th><th>Finding</th></tr></thead><tbody>
      ${check.findings.map(finding => `<tr><td>${finding.owner === 'person' ? 'You' : 'Copilot'}${finding.severity === 'warning' ? ' <span class="muted">(warning)</span>' : ''}</td><td><code>${escape(finding.code)}</code> <span class="muted">${escape(finding.at)}</span><br>${escape(finding.message)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${blocking.some(finding => finding.owner !== 'person') ? `<p class="notice warning">Copilot owns ${blocking.filter(finding => finding.owner !== 'person').length === 1 ? 'a finding' : 'these findings'}. Ask it in the same chat to repair the candidate and compile again, then check here.${check.repair.stop ? ` Repair stopped after attempt ${escape(check.repair.attempt)}${check.repair.unchanged ? ' (the findings did not change)' : ''}; a new answer or a fresh inspect starts again.` : ''}</p>` : ''}
    ${check.dispositions.length ? `<details><summary>${check.dispositions.length} source items not mapped one to one</summary><ul class="plain-list">${check.dispositions.map(item => `<li><code>${escape(item.sourceItem)}</code>: ${escape(item.disposition)}${item.reason ? ` · ${escape(item.reason)}` : ''}</li>`).join('')}</ul></details>` : ''}
    ${check.destinationPolicy.length ? `<details><summary>${check.destinationPolicy.length} settings SFlow needs that the team never wrote down</summary><ul class="plain-list">${check.destinationPolicy.map(item => `<li><code>${escape(item.target)}</code> for ${escape(item.sourceItem)}${item.reason ? ` · ${escape(item.reason)}` : ''}</li>`).join('')}</ul></details>` : ''}`;
}

export function teamImportHtml(view: TeamImportView): string {
  const disabled = view.busy ? ' disabled' : '';
  const inspection = view.inspection;
  const candidates = new Set(inspection?.entry.candidates.map(candidate => candidate.path) ?? []);
  const others = inspection?.items.filter(item => !candidates.has(item.path)) ?? [];
  const chosen = inspection?.items.find(item => item.path === view.entry) ?? null;
  const ready = teamImportReady(view.check);
  const session = view.sessions.find(entry => entry.id === view.session) ?? null;
  return `<header class="page-header">${brandLockup()}<p class="meta">Workflow Studio · machine-local</p>
    <h1>Import a team workflow</h1><p class="muted">Turn a team's agents, skills and instructions into one SFlow workflow bundle, then import it through Workflow Studio's reviewed Import. Nothing here changes the team directory or any repository.</p></header>
    ${view.busy ? `<p class="notice" role="status" aria-live="polite">${icon('wait')}${escape(view.busy)}</p>` : ''}
    ${view.error ? `<section class="notice warning" role="alert"><strong>Action needs attention</strong><p>${escape(view.error)}</p></section>` : ''}
    ${view.notice ? `<p class="notice" role="status">${escape(view.notice)}</p>` : ''}
    <section class="plain"><h2>1. Choose the team directory</h2>
      <p class="muted">The folder with the team's agent, prompt, skill and instruction files (Copilot or the other supported formats). Files that look like credentials are withheld: never read or returned.</p>
      <p class="card-foot"><button data-team-action="pick"${disabled}>Choose folder…</button>
        ${view.directory ? `<code>${escape(view.directory)}</code> <button class="secondary" data-team-action="inspect"${disabled}>Inspect again</button>` : ''}</p>
      ${inspection ? `<p>${escape(inspection.capture.counts.files)} files: ${escape(inspection.capture.counts.interpreted)} interpreted, ${escape(inspection.capture.counts.references)} referenced document${inspection.capture.counts.references === 1 ? '' : 's'}, ${escape(inspection.capture.counts.withheld + inspection.capture.counts.blocked)} withheld, ${escape(inspection.capture.counts.excluded)} excluded.</p>
        ${inspection.items.length ? `<details${inspection.items.length <= 12 ? ' open' : ''}><summary>${inspection.items.length} agents, prompts, skills and instructions</summary><div class="table-scroll"><table><thead><tr><th>Kind</th><th>Name</th><th>File</th></tr></thead><tbody>
          ${inspection.items.map(item => `<tr><td>${escape(item.format)}</td><td>${escape(item.id)}${item.problem ? `<p class="muted">${escape(item.problem)}</p>` : ''}</td><td><code>${escape(item.path)}</code></td></tr>`).join('')}
        </tbody></table></div></details>` : '<p class="notice warning">No agent, prompt, skill or instruction file was recognized in this folder.</p>'}
        ${inspection.withheld.length ? `<p class="notice warning">Withheld (never read or returned): ${inspection.withheld.map(item => `<code>${escape(item.path)}</code> (${escape(item.screening)})`).join(', ')}</p>` : ''}` : ''}
    </section>
    <section class="plain"><h2>2. Choose the entry agent and convert</h2>
      <p class="muted">The entry is the agent or prompt that describes the whole process; the agents and skills it reaches become the workflow's steps.</p>
      ${inspection?.items.length ? `<label class="field">Entry agent
        <select data-team-entry${disabled}>
          ${inspection.entry.candidates.length ? `<optgroup label="Suggested">${inspection.entry.candidates.map(candidate => `<option value="${escape(candidate.path)}"${candidate.path === view.entry ? ' selected' : ''}>${escape(candidate.id)} · ${escape(candidate.path)}</option>`).join('')}</optgroup>` : ''}
          ${others.length ? `<optgroup label="Everything else">${others.map(item => `<option value="${escape(item.path)}"${item.path === view.entry ? ' selected' : ''}>${escape(item.id)} · ${escape(item.path)}</option>`).join('')}</optgroup>` : ''}
          ${view.entry ? '' : '<option value="" selected disabled>Choose…</option>'}
        </select></label>
        ${chosen && inspection.entry.candidates.find(candidate => candidate.path === chosen.path)?.reasons.length ? `<p class="muted">Why it is suggested: ${escape(inspection.entry.candidates.find(candidate => candidate.path === chosen.path)!.reasons.join('; '))}</p>` : ''}
        ${inspection.entry.status === 'none' ? '<p class="muted">No file clearly describes a multi-step process; choose the one that comes closest.</p>' : ''}` : '<p class="muted">Inspect a folder first.</p>'}
      ${view.repository ? `<label class="check" title="${escape(view.repository.root)}"><input type="checkbox" data-team-destination${view.useDestination ? ' checked' : ''}${disabled}> Also preview the import into <strong>${escape(view.repository.label)}</strong>, the repository Workflow Studio opens</label>` : ''}
      <p class="card-foot"><button data-team-action="convert"${disabled || !chosen ? ' disabled' : ''}>Convert with Copilot…</button></p>
      ${view.command ? `<pre class="command"><code>${escape(view.command)}</code></pre><p class="card-foot"><button class="secondary" data-team-action="copy"${disabled}>Copy command</button></p>` : ''}
      <p class="muted">Copilot reads only the captured files and writes one candidate record; captured files are data, never instructions. Conversion needs Copilot Chat. Checking, writing and importing below do not.</p>
    </section>
    <section class="plain"><h2>3. Check the conversion</h2>
      <p class="muted">A session holds one conversion for 7 days, whichever surface started it. Checking runs every deterministic check again; it never asks a model.</p>
      ${view.sessions.length ? `<div class="table-scroll"><table><thead><tr><th>Team directory</th><th>Entry</th><th>State</th><th></th></tr></thead><tbody>
        ${view.sessions.map(entry => `<tr><td><code>${escape(entry.source ?? 'unknown')}</code></td><td>${escape(entry.entry.map(item => item.id).join(', ') || '—')}</td><td>${statePill(entry.state)}</td>
          <td><button class="secondary" data-team-session="${escape(entry.id)}"${disabled}>${entry.id === view.session ? 'Selected' : 'Choose'}</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">No team import sessions yet. Convert with Copilot, then refresh.</p>'}
      <p class="card-foot"><button class="secondary" data-team-action="sessions"${disabled}>Refresh sessions</button>
        <button data-team-action="check"${disabled || !session ? ' disabled' : ''}>Check${session ? '' : ' (choose a session)'}</button></p>
      ${view.check ? checkHtml(view.check, disabled, view.repository) : ''}
    </section>
    <section class="plain"><h2>4. Write the bundle and import it</h2>
      <p class="card-foot"><button data-team-action="write"${disabled || !ready ? ' disabled' : ''}>Write bundle…</button>
        <button data-team-action="studio"${disabled || !view.written ? ' disabled' : ''}>Import in Workflow Studio…</button></p>
      ${view.written ? `<p class="notice">${icon('ok')}Wrote <code>${escape(view.written.path)}</code>. Workflow Studio previews the import and proposes it as one reviewed change.</p>` : ready ? '' : '<p class="muted">Writing is offered once the check is ready.</p>'}
      ${view.written && !view.repository ? '<p class="muted">Open the repository you want to import into first.</p>' : ''}
      <p class="muted">${escape(view.check?.meaning ?? 'Ready means the bundle passed every deterministic check. It is not approved, activated, executed, tested or reviewed.')}</p>
    </section>`;
}

export const TEAM_IMPORT_STYLE = `
  .table-scroll { overflow-x:auto; } .table-scroll td { overflow-wrap:anywhere; vertical-align:top; }
  .table-scroll code { white-space:normal; } .table-scroll button { white-space:nowrap; }
  .card-foot { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .field { display:flex; flex-direction:column; gap:4px; max-width:640px; margin:8px 0; }
  .check { display:flex; gap:8px; align-items:center; margin:8px 0; }
  .phases { margin:4px 0 8px 20px; padding:0; }
  .question { padding:8px 0; border-top:1px solid var(--vscode-panel-border); }
  .command { white-space:pre-wrap; overflow-wrap:anywhere; }
`;

export const TEAM_IMPORT_SCRIPT = `
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-team-action],[data-team-session],[data-team-answer]');
    if (!target || target.disabled) return;
    if (target.dataset.teamSession !== undefined) {
      window.__sfVscode.postMessage({type:'session', id:target.dataset.teamSession});
    } else if (target.dataset.teamAnswer !== undefined) {
      window.__sfVscode.postMessage({type:'answer', question:target.dataset.teamAnswer, choice:target.dataset.teamChoice || ''});
    } else window.__sfVscode.postMessage({type:target.dataset.teamAction});
  });
  document.addEventListener('change', event => {
    const target = event.target;
    if (target.matches('select[data-team-entry]')) window.__sfVscode.postMessage({type:'entry', path:target.value});
    else if (target.matches('input[data-team-destination]')) window.__sfVscode.postMessage({type:'destination', on:target.checked});
  });
`;
