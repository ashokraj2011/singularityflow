/** Deterministic visual-review pages for the extension's shared enterprise component language. */
import { icon } from './icons.ts';
import { brandLockup, page } from './webview.ts';

export type VisualTheme = 'light' | 'dark' | 'high-contrast';
export type VisualWidth = 320 | 640 | 1024 | 1200 | 1440;
export interface VisualReviewCase { theme: VisualTheme; width: VisualWidth }

export const VISUAL_REVIEW_CASES: VisualReviewCase[] = [
  { theme: 'light', width: 320 }, { theme: 'light', width: 640 },
  { theme: 'light', width: 1024 }, { theme: 'light', width: 1200 }, { theme: 'light', width: 1440 },
  { theme: 'dark', width: 320 }, { theme: 'dark', width: 640 },
  { theme: 'dark', width: 1024 }, { theme: 'dark', width: 1200 }, { theme: 'dark', width: 1440 },
  { theme: 'high-contrast', width: 320 }, { theme: 'high-contrast', width: 640 },
  { theme: 'high-contrast', width: 1024 }, { theme: 'high-contrast', width: 1200 }, { theme: 'high-contrast', width: 1440 }
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
  return `${brandLockup()}
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
  <section class="fixture-task"><h2>${icon('configuration')}Configuration navigation</h2>
    <div class="configuration-shell"><aside class="configuration-sidebar"><nav class="configuration-nav" aria-label="Configuration areas">
      <section class="configuration-nav-group"><h2>Repository setup</h2><ul><li><button class="configuration-nav-item active" aria-current="page">${icon('configuration')}<span>Overview</span></button></li><li><button class="configuration-nav-item">${icon('capability')}<span>Capabilities</span></button></li></ul></section>
      <section class="configuration-nav-group"><h2>Governance &amp; review</h2><ul><li><button class="configuration-nav-item">${icon('approval')}<span>People &amp; approvals</span></button></li></ul></section>
    </nav></aside><main class="configuration-content"><div class="summary-grid"><div class="summary-card"><strong>4</strong><span>approval groups</span></div><div class="summary-card"><strong>3</strong><span>governed agents</span></div></div>
      <div class="configuration-action-list"><button class="configuration-action-row">${icon('workflow')}<span><strong>Workflow Designer</strong><small>Work types, phases, gates, and artifact flow.</small></span>${icon('next')}</button></div></main></div>
  </section>
  <section><h2>${icon('artifact')}Artifact inventory</h2><table><thead><tr><th>Artifact</th><th>Status</th><th>Owner</th></tr></thead>
    <tbody><tr><td>${icon('document')}Requirements specification</td><td><span class="pill ok">${icon('success')}Approved</span></td><td>Product owner</td></tr>
    <tr><td>${icon('document')}Implementation specification</td><td><span class="pill bad">${icon('blocked')}Blocked</span></td><td>Architect</td></tr></tbody></table></section>
  <section><p class="eyebrow">Surface parity review</p><h2>${icon('impact')}Goals, recovery, and local controls</h2>
    <nav class="tabs" aria-label="Diagnostic scopes"><button class="active">Repository</button><button>Capabilities</button><button>Workspace Reliability</button><button>Schema Health</button></nav>
    <div class="summary-grid"><div class="summary-card important"><strong>1</strong><span>future-version record</span></div><div class="summary-card"><strong>4</strong><span>record families</span></div><div class="summary-card"><strong>128</strong><span>records scanned</span></div></div>
    <div class="split-layout"><article class="fixture-task card"><h3>${icon('impact')}Goal · GOAL-17</h3><p>Reduce checkout recovery time.</p><ul><li>p95 recovery under two minutes</li><li>Every repair has a review receipt</li></ul><button>Open Goal</button></article>
      <article class="fixture-task card"><h3>${icon('warning')}Fault · FLT-42</h3><p>Verification failed. Raw evidence remains outside this view.</p><p><code>[&quot;npm&quot;,&quot;test&quot;]</code></p><button>Open details &amp; recovery</button></article></div>
    <div class="table-wrap"><table><thead><tr><th>Family</th><th>Versions found</th><th>Readable</th><th>Current</th></tr></thead><tbody><tr><td>Story state</td><td>2: 12, 3: 84</td><td>2–3</td><td>3</td></tr><tr><td>Repair plan</td><td>1: 4</td><td>1–1</td><td>1</td></tr></tbody></table></div>
    <h3>Local Data &amp; Reset</h3><div class="split-layout"><article class="fixture-task card"><h4>Forget local registrations</h4><p>Workspace directories, repository bytes, branches, and dirty files are preserved.</p><button>Preview forget-only</button></article><article class="fixture-task card warning"><h4>Delete workspace directories</h4><p>Available only from an empty VS Code window. Nothing is preselected.</p><button class="secondary">Preview destructive reset</button></article></div>
  </section>`;
}

/** A standalone, offline page that can be opened in any browser for deterministic visual review. */
export function enterpriseVisualFixture(review: VisualReviewCase): string {
  const token = 'singularity-flow-visual-fixture';
  const overrides = `<style nonce="${token}">:root{${PALETTES[review.theme]}}body{max-width:${review.width}px}</style>`;
  return page(
    `Singularity Flow ${review.theme} ${review.width}`,
    `${overrides}${fixtureBody(review.theme)}`,
    // No script-src at all: this opens in a browser with no extension behind it, so the shared
    // footer is omitted rather than rendered as navigation that leads nowhere.
    `default-src 'none'; style-src 'nonce-${token}'`, token, '', { nav: false }
  );
}
