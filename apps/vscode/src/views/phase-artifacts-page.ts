import { escape } from './webview.ts';

export type ArtifactVersion = 'draft' | 'approved';
export interface PhaseArtifactCatalog {
  workId: string;
  currentPhase: string | null;
  phases: Array<{ id: string; label: string; status: string; generation: number; approved: boolean;
    artifacts: Array<{ id: string; label: string; path: string; kind: string }> }>;
}
export interface PhaseArtifactPreview {
  workId: string; phase: string; generation: number; version: ArtifactVersion; commit: string | null;
  record: { id: string; path: string; label: string; kind: string };
  sha256: string; binary: boolean; content: string | null;
}

export function phaseArtifactsBody(catalog: PhaseArtifactCatalog, selected: string, version: ArtifactVersion): string {
  const phase = catalog.phases.find(item => item.id === selected);
  const rows = phase && (version === 'draft' || phase.approved) ? phase.artifacts : [];
  return `<header><h1>Artifacts</h1><p>${escape(catalog.workId)} · Documents by workflow phase</p></header>
    <div class="artifact-layout"><nav class="artifact-phases" aria-label="Workflow phases">${catalog.phases.map(item =>
      `<button type="button" class="secondary" data-phase="${escape(item.id)}"${item.id === selected ? ' aria-current="step"' : ''}>
        <span>${escape(item.label)}</span><small>${escape(item.status.replaceAll('_', ' '))}</small></button>`).join('')}</nav>
    <section><div class="artifact-toolbar"><h2>${escape(phase?.label ?? 'Choose a phase')}</h2>
      <button type="button" class="secondary" data-refresh>Refresh</button></div>
    <div class="artifact-versions" role="group" aria-label="Artifact version">${(['draft', 'approved'] as const).map(item =>
      `<button type="button" class="secondary" data-version="${item}" aria-pressed="${item === version}">${item === 'draft' ? 'Draft' : 'Approved'}</button>`).join('')}</div>
    <p class="muted">${version === 'draft'
      ? 'Current working files. Opening a draft does not publish, submit or approve it.'
      : 'Read-only published bytes for the currently approved generation. Edits to working drafts are not included; superseded approvals are not presented as current.'}</p>
    ${phase ? `<p class="muted">Generation ${phase.generation} · ${escape(phase.status.replaceAll('_', ' '))}</p>` : ''}
    ${rows.length ? `<table><thead><tr><th>Artifact</th><th>Kind</th><th></th></tr></thead><tbody>${rows.map(item =>
      `<tr><td>${escape(item.label)}<small class="artifact-path">${escape(item.path)}</small></td><td>${escape(item.kind)}</td>
        <td><button type="button" class="secondary" data-artifact="${escape(item.id)}">View Markdown</button></td></tr>`).join('')}</tbody></table>`
      : `<p class="muted">${version === 'approved' && phase && !phase.approved
        ? 'No currently approved artifacts for this phase.' : 'No artifacts are registered for this phase yet.'}</p>`}
    </section></div>`;
}

const inline = (value: string): string => value.replace(/[\r\n]/gu, ' ').replace(/[\\`*_{}[\]()#+.!<>|]/gu, '\\$&');
/** Source is fenced for non-Markdown artifacts. A read-only preview never renders JSON as raw mode. */
export function artifactPreviewMarkdown(preview: PhaseArtifactPreview): string {
  const header = `# ${inline(preview.record.label)}\n\n> ${preview.version === 'approved' ? 'Approved · read-only published version' : 'Draft · current working version'} — ${inline(preview.workId)} / ${inline(preview.phase)} / generation ${preview.generation}\n\n`
    + `SHA-256: \`${preview.sha256}\`\n\n${preview.commit ? `Publication commit: \`${preview.commit}\`\n\n` : ''}---\n\n`;
  if (preview.binary || preview.content == null) return header + 'This binary artifact has no Markdown text preview. Its original bytes were not changed.\n';
  if (/\.(md|markdown)$/iu.test(preview.record.path)) return header + preview.content;
  let fenceLength = 3;
  for (const match of preview.content.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return `${header}${fence}\n${preview.content}\n${fence}\n`;
}

export const PHASE_ARTIFACTS_STYLE = `.artifact-layout{display:grid;grid-template-columns:minmax(150px,220px) minmax(0,1fr);gap:24px}
 .artifact-phases{display:flex;flex-direction:column;gap:6px}.artifact-phases button{text-align:left;white-space:normal;display:flex;flex-direction:column;gap:4px}
 .artifact-phases [aria-current],.artifact-versions [aria-pressed="true"]{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}
 .artifact-phases small,.artifact-path{display:block;color:var(--vscode-descriptionForeground);font-weight:400}.artifact-path{overflow-wrap:anywhere;margin-top:4px}
 .artifact-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.artifact-versions{display:flex;gap:8px;margin:12px 0}
 td{vertical-align:middle}td:last-child{white-space:nowrap}@media(max-width:650px){.artifact-layout{grid-template-columns:1fr}.artifact-phases{flex-direction:row;overflow-x:auto}.artifact-phases button{flex:0 0 auto}}`;
export const PHASE_ARTIFACTS_SCRIPT = `document.addEventListener('click',event=>{
 const button=event.target.closest('button');if(!button)return;
 if(button.dataset.phase)window.__sfVscode.postMessage({type:'phase',id:button.dataset.phase});
 else if(button.dataset.version)window.__sfVscode.postMessage({type:'version',version:button.dataset.version});
 else if(button.dataset.artifact)window.__sfVscode.postMessage({type:'open',id:button.dataset.artifact});
 else if(button.hasAttribute('data-refresh'))window.__sfVscode.postMessage({type:'refresh'});
});`;
