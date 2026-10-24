/**
 * "What this phase sees": the Repository brief one Story phase's prompt carries, exactly as
 * `singularity-flow wm brief --phase P --work-id W --json` returns it. Pure (no editor APIs), so it
 * is tested directly; phase-brief.ts is the panel that asks for it and shows this page.
 */
import { escape } from './webview.ts';

export type PhaseBriefResult = {
  status: 'ok' | 'none';
  phase: string | null;
  bytes: number;
  text: string;
  budget: number | null;
  profile: string | null;
  /** The phase's prompt was already composed, so this is the brief it was composed with. */
  saved: boolean;
  /** False when the phase's prompt cannot be composed yet: `note` says why, and this is the brief it would carry now. */
  composed?: boolean;
  phrasing: { by: 'template' } | { by: 'model'; model: string | null; sentences: number } | null;
  records: string[];
  omitted: number | null;
  polish?: { accepted: number; applied: number; rejected: Array<{ text: string; reason: string }> } | null;
  note?: string | null;
};

export type PhaseBriefState = {
  workId: string;
  phase: string;
  phases: Array<{ id: string; label: string }>;
  loading: 'read' | 'polish' | null;
  error: string | null;
};

const code = (text: string): string => escape(text).replace(/`([^`]+)`/gu, '<code>$1</code>');

/** The brief's Markdown as the page shows it: sections, bullets with their sources set apart. */
function briefHtml(text: string): string {
  const out: string[] = [];
  let list = false;
  const close = (): void => { if (list) { out.push('</ul>'); list = false; } };
  for (const line of text.split('\n')) {
    if (!line.trim()) { close(); continue; }
    if (line.startsWith('# ')) { close(); out.push(`<p class="meta brief-title">${code(line.slice(2))}</p>`); continue; }
    if (line.startsWith('## ')) { close(); out.push(`<h2>${code(line.slice(3))}</h2>`); continue; }
    if (line.startsWith('- ')) {
      if (!list) { out.push('<ul class="brief-list">'); list = true; }
      const [, said = line.slice(2), source = null] = /^(.*) \(([^()]*(?:\.[\w]+(?::\d+)?|›[^()]*)|commit [0-9a-f]{7,})\)$/u.exec(line.slice(2)) ?? [];
      out.push(`<li><p>${code(said)}${source ? ` <span class="brief-source">${escape(source)}</span>` : ''}</p></li>`);
      continue;
    }
    close();
    out.push(`<p class="${line.startsWith('Not known:') ? 'meta brief-not-known' : 'meta'}">${code(line)}</p>`);
  }
  close();
  return out.join('');
}

/** How the brief was made, in one sentence. */
function provenance(result: PhaseBriefResult): string {
  if (result.saved) return 'This phase\'s prompt is already composed; this is the brief it was composed with.';
  if (result.phrasing?.by === 'model') return `Phrased by ${escape(result.phrasing.model ?? 'a model')} from the records it cites; each line was checked against them, and the rest keep their fixed wording.`;
  return 'Read without a model from the committed source.';
}

/** The page body for one phase's brief and the panel's state. */
export function phaseBriefBody(result: PhaseBriefResult | null, state: PhaseBriefState): string {
  const label = state.phases.find((phase) => phase.id === state.phase)?.label ?? state.phase;
  const options = state.phases.map((phase) => `<option value="${escape(phase.id)}"${phase.id === state.phase ? ' selected' : ''}>${escape(phase.label)}</option>`).join('');
  const busy = state.loading === 'polish'
    ? '<p class="callout" role="status">Asking the model to phrase the brief. Each sentence is checked against the records it cites as soon as it answers.</p>'
    : state.loading === 'read' ? '<p class="meta" role="status">Reading what this phase receives…</p>' : '';
  const error = state.error ? `<p class="warning" role="alert">${escape(state.error)}</p>` : '';
  const header = `<header class="brief-header">
    <div><h1>What this phase sees</h1><p class="meta">${escape(label)} · Story ${escape(state.workId)} · the Repository brief in its prompt</p></div>
    <div class="brief-actions">
      <label class="meta" for="brief-phase">Phase</label>
      <select id="brief-phase" data-message="phase"${state.loading ? ' disabled' : ''}>${options}</select>
      <button type="button" data-message="polish" title="Ask the model to phrase the lines in plain words; the records and their checks stay the same"${state.loading || result?.saved ? ' disabled' : ''}>Phrase with model</button>
      <button type="button" class="secondary" data-message="refresh"${state.loading ? ' disabled' : ''}>Refresh</button>
    </div>
  </header>`;
  if (!result) return `${header}${busy}${error}`;
  if (result.status !== 'ok') {
    return `${header}${busy}${error}<div class="empty"><p>This phase receives no Repository brief: the brief is off for this work type or repository, or the repository has no code to read.</p></div>`;
  }
  const size = result.budget ? `${result.bytes.toLocaleString('en')} of ${result.budget.toLocaleString('en')} bytes` : `${result.bytes.toLocaleString('en')} bytes`;
  const counts = result.saved ? '' : ` · ${result.records.length} record${result.records.length === 1 ? '' : 's'}${result.omitted ? ` · ${result.omitted} more not shown` : ''}`;
  const kept = result.polish?.rejected?.length
    ? `<details class="card"><summary>${result.polish.rejected.length} model sentence${result.polish.rejected.length === 1 ? '' : 's'} kept the fixed wording</summary><ul class="brief-list compact">${result.polish.rejected.slice(0, 12).map((entry) => `<li><p>${escape(entry.text)}</p><p class="meta">${escape(entry.reason)}</p></li>`).join('')}</ul></details>`
    : '';
  return `${header}${busy}${error}
    <p class="brief-mode${result.phrasing?.by === 'model' ? ' model' : ''}"><strong>${provenance(result)}</strong> It is guidance: open the cited lines before relying on a detail.</p>
    ${result.note ? `<p class="callout" role="status">${escape(result.note)}</p>` : ''}
    <p class="meta">${size}${counts}</p>
    <section class="brief-view">${briefHtml(result.text)}</section>${kept}`;
}

export const PHASE_BRIEF_STYLES = `
  .brief-header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; justify-content: space-between; margin-bottom: .75rem; }
  .brief-header h1 { margin: 0 0 .25rem; }
  .brief-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
  .brief-mode { padding: .6rem .8rem; border-radius: 6px; border: var(--sf-border); background: var(--sf-surface); }
  .brief-mode.model { border-left: 4px solid var(--sf-ok); }
  .brief-view h2 { margin: 1rem 0 .3rem; font-size: 1.05rem; }
  .brief-list { list-style: none; padding: 0; margin: .3rem 0 .8rem; display: grid; gap: .45rem; }
  .brief-list > li { padding: .5rem .75rem; border: var(--sf-border); border-radius: 6px; background: var(--sf-surface); }
  .brief-list.compact > li { padding: .35rem .6rem; }
  .brief-list p { margin: 0; }
  .brief-source { color: var(--sf-dim); font-size: .9em; white-space: nowrap; }
  .brief-title { margin-top: .6rem; }
  .brief-not-known { margin-top: 1rem; }
`;

export const PHASE_BRIEF_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-message="polish"]')) return vscode.postMessage({ type: 'polish' });
    if (event.target.closest('[data-message="refresh"]')) return vscode.postMessage({ type: 'refresh' });
  });
  document.addEventListener('change', (event) => {
    const select = event.target.closest('[data-message="phase"]');
    if (select) vscode.postMessage({ type: 'phase', phase: select.value });
  });
`;
