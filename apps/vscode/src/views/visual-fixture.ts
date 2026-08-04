/** Deterministic visual-review pages for the extension's shared enterprise component language. */
import { icon } from './icons.ts';
import { page } from './webview.ts';

export type VisualTheme = 'light' | 'dark' | 'high-contrast';
export type VisualWidth = 640 | 1200;
export interface VisualReviewCase { theme: VisualTheme; width: VisualWidth }

export const VISUAL_REVIEW_CASES: VisualReviewCase[] = [
  { theme: 'light', width: 640 }, { theme: 'light', width: 1200 },
  { theme: 'dark', width: 640 }, { theme: 'dark', width: 1200 },
  { theme: 'high-contrast', width: 640 }, { theme: 'high-contrast', width: 1200 }
];

const PALETTES: Record<VisualTheme, string> = {
  light: `--vscode-editor-background:#ffffff;--vscode-foreground:#242424;--vscode-descriptionForeground:#666666;
    --vscode-panel-border:#d8d8d8;--vscode-editorWidget-background:#fafafa;--vscode-sideBar-background:#f5f5f5;
    --vscode-input-background:#ffffff;--vscode-input-foreground:#242424;--vscode-input-border:#b8b8b8;
    --vscode-textLink-foreground:#0969da;--vscode-textCodeBlock-background:#f2f2f2;--vscode-list-hoverBackground:#eeeeee`,
  dark: `--vscode-editor-background:#1e1e1e;--vscode-foreground:#d7d7d7;--vscode-descriptionForeground:#a5a5a5;
    --vscode-panel-border:#454545;--vscode-editorWidget-background:#252526;--vscode-sideBar-background:#252526;
    --vscode-input-background:#313131;--vscode-input-foreground:#f0f0f0;--vscode-input-border:#5a5a5a;
    --vscode-textLink-foreground:#5da8ff;--vscode-textCodeBlock-background:#2c2c2c;--vscode-list-hoverBackground:#303030`,
  'high-contrast': `--vscode-editor-background:#000000;--vscode-foreground:#ffffff;--vscode-descriptionForeground:#ffffff;
    --vscode-panel-border:#ffffff;--vscode-editorWidget-background:#000000;--vscode-sideBar-background:#000000;
    --vscode-input-background:#000000;--vscode-input-foreground:#ffffff;--vscode-input-border:#ffffff;
    --vscode-textLink-foreground:#6fc3ff;--vscode-textCodeBlock-background:#000000;--vscode-list-hoverBackground:#1a1a1a;
    --vscode-focusBorder:#ffff00`
};

function fixtureBody(theme: VisualTheme): string {
  return `<div class="brand-lockup">SINGULARITY <span>FLOW</span></div>
  <header><p class="eyebrow">Enterprise component review</p><h1>${icon('workflow', { size: 24 })}Lifecycle workspace</h1>
    <p class="meta">${theme} theme · dashboard, intake, approval, configuration, and instruction patterns</p></header>
  <div class="summary-grid">
    <div class="summary-card important"><strong>7</strong><span>phases complete</span></div>
    <div class="summary-card"><strong>12</strong><span>generated artifacts</span></div>
    <div class="summary-card"><strong>2</strong><span>waiting for approval</span></div>
  </div>
  <section class="fixture-task"><div class="section-heading"><h2>${icon('approval')}Approval inbox</h2><span class="pill wait">${icon('waiting')}Waiting</span></div>
    <article class="decision-card"><p class="eyebrow">Phase gate</p><h3>Solution design</h3><p class="muted">Review the exact approved specification and its source hash.</p>
      <div class="card-foot"><button>Review &amp; approve</button><button class="secondary">Open artifact</button><button class="link">Reject</button></div></article></section>
  <section><h2>${icon('workflow')}Workflow progress</h2><div class="workflow-rail"><span class="rail-node"><b>1</b>Intake</span><span class="rail-arrow">${icon('next')}</span><span class="rail-node"><b>2</b>Requirements</span><span class="rail-arrow">${icon('next')}</span><span class="rail-node"><b>3</b>Planning</span></div></section>
  <section class="fixture-task editor-card"><div class="editor-title"><p class="eyebrow">Configuration studio</p><h3>${icon('agent')}Governed agent</h3></div>
    <div class="form-grid"><label class="field"><span>Display name</span><input type="text" value="Solution architect"></label>
      <label class="field"><span>Default phase</span><select><option>Design</option></select></label>
      <label class="field full"><span>Prompt guidance</span><textarea rows="3">Ground every recommendation in the selected world-model views.</textarea></label></div>
    <div class="form-actions"><button>Save agent</button><button class="secondary">Cancel</button><button class="icon-button danger" aria-label="Delete agent" title="Delete agent">${icon('remove')}</button></div></section>
  <section><h2>${icon('artifact')}Artifact inventory</h2><table><thead><tr><th>Artifact</th><th>Status</th><th>Owner</th></tr></thead>
    <tbody><tr><td>${icon('document')}Requirements specification</td><td><span class="pill ok">${icon('success')}Approved</span></td><td>Product owner</td></tr>
    <tr><td>${icon('document')}Implementation specification</td><td><span class="pill bad">${icon('blocked')}Blocked</span></td><td>Architect</td></tr></tbody></table></section>`;
}

/** A standalone, offline page that can be opened in any browser for deterministic visual review. */
export function enterpriseVisualFixture(review: VisualReviewCase): string {
  const token = 'singularity-flow-visual-fixture';
  const overrides = `<style nonce="${token}">:root{${PALETTES[review.theme]}}body{max-width:${review.width}px}</style>`;
  return page(
    `Singularity Flow ${review.theme} ${review.width}`,
    `${overrides}${fixtureBody(review.theme)}`,
    `default-src 'none'; style-src 'nonce-${token}'`, token
  );
}
