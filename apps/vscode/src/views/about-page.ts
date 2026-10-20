/** Pure read-only About view; all installed-build observations come from the CLI. */
import { BRAND_ART_STYLE, brandCard } from './brand-art.ts';
import { escape } from './webview.ts';

export interface AboutSurface {
  id: string; label: string; status: string; version: string | null; build: string | null;
  identity: string | null; builtAt: string | null; path?: string; reason?: string;
}
export interface AboutInfo {
  schemaVersion: number; resultType: string; checkedAt: string; alignment: string;
  running: AboutSurface; cli: AboutSurface; vscode: AboutSurface[];
  receipt: { status: string; path: string }; warnings: string[];
  runtime: { node: string; platform: string; executable?: string; architecture?: string; managed?: boolean };
}
export interface AboutWindow {
  version: string; build: string; editorVersion: string; reloadRequired: boolean;
}

export function isAboutInfo(value: unknown): value is AboutInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Partial<AboutInfo>;
  const nullable = (entry: unknown) => entry === null || typeof entry === 'string';
  const surface = (entry: unknown): boolean => {
    if (!entry || typeof entry !== 'object') return false;
    const row = entry as AboutSurface;
    return typeof row.id === 'string' && typeof row.label === 'string'
      && ['available', 'development', 'unavailable'].includes(row.status)
      && [row.version, row.build, row.identity, row.builtAt].every(nullable)
      && (row.reason === undefined || typeof row.reason === 'string')
      && (row.path === undefined || typeof row.path === 'string');
  };
  return info.schemaVersion === 1 && info.resultType === 'sflow-about'
    && typeof info.checkedAt === 'string' && ['matched', 'mismatch', 'unknown'].includes(info.alignment ?? '')
    && surface(info.running) && surface(info.cli) && Array.isArray(info.vscode) && info.vscode.length > 0
    && info.vscode.length <= 32 && info.vscode.every(surface)
    && Boolean(info.receipt && typeof info.receipt.path === 'string'
      && ['present', 'missing', 'invalid'].includes(info.receipt.status))
    && Boolean(info.runtime && typeof info.runtime.node === 'string' && typeof info.runtime.platform === 'string')
    && Array.isArray(info.warnings) && info.warnings.every(warning => typeof warning === 'string');
}

export function aboutHtml(info: AboutInfo | null, window: AboutWindow, error: string | null = null): string {
  const loadedDate = / (\d{4}-\d\d-\d\dT\S+Z)$/u.exec(window.build)?.[1] ?? 'unknown';
  return `<header class="page-header">${brandCard()}<h1>About Singularity Flow</h1>
    <p class="muted">Versions and build dates for this window and the CLI on PATH. No repository check, install or repair is performed.</p></header>
    <p><button data-about="refresh" class="secondary">Refresh build information</button>
      <button data-about="copy" class="secondary"${info ? '' : ' disabled'}>Copy diagnostics</button></p>
    ${error ? `<p class="notice warning" role="alert">${escape(error)}</p>` : ''}
    ${window.reloadRequired ? '<p class="notice warning" role="alert">The extension on disk changed after this window loaded. These are different observations. <button data-about="reload">Reload VS Code</button></p>' : ''}
    <h2>This VS Code window</h2><dl class="about-facts"><dt>Extension version</dt><dd>${escape(window.version)}</dd>
      <dt>Loaded UI build</dt><dd><code>${escape(window.build)}</code></dd><dt>UI build date (UTC)</dt><dd>${escape(loadedDate)}</dd>
      <dt>VS Code editor version</dt><dd>${escape(window.editorVersion)}</dd></dl>
    <h2>Installed product builds</h2>
    ${info ? `<p class="notice${info.alignment === 'mismatch' ? ' warning' : ''}">CLI / VS Code alignment: <strong>${escape(info.alignment)}</strong>.</p>
      <div class="about-table"><table><thead><tr><th>Surface</th><th>Version</th><th>Build identity</th><th>Build date (UTC)</th><th>Read status</th></tr></thead><tbody>
      ${[info.running, info.cli, ...info.vscode].map(item => `<tr><td>${escape(item.id === 'vscode' ? 'VS Code extension / bundled CLI (on disk)' : item.label)}</td>
        <td>${escape(item.version ?? 'unknown')}</td><td><code>${escape(item.identity ?? (item.status === 'development' ? 'development checkout' : 'unknown'))}</code></td>
        <td>${escape(item.builtAt ?? 'unknown')}</td><td>${escape(item.status)}${item.reason ? `<p>${escape(item.reason)}</p>` : ''}</td></tr>`).join('')}
      </tbody></table></div><p class="muted">Observed ${escape(info.checkedAt)}. Dates are build stamps, not installation times. Unknown fields are not inferred.</p>
      ${info.warnings.map(warning => `<p class="notice warning">${escape(warning)}</p>`).join('')}
      <details><summary>Runtime and local paths</summary><dl class="about-facts"><dt>Node / platform</dt><dd>${escape(info.runtime.node)} / ${escape(info.runtime.platform)}</dd>
        <dt>Engine runtime</dt><dd>${info.runtime.managed ? 'SFlow-managed' : 'External / host runtime'}${info.runtime.architecture ? ` · ${escape(info.runtime.architecture)}` : ''}</dd>
        ${info.runtime.executable ? `<dt>Node executable</dt><dd><code>${escape(info.runtime.executable)}</code></dd>` : ''}
        <dt>Installation receipt</dt><dd>${escape(info.receipt.status)} · <code>${escape(info.receipt.path)}</code></dd>
        ${[info.running, ...info.vscode].filter(item => item.path).map(item => `<dt>${escape(item.label)}</dt><dd><code>${escape(item.path)}</code></dd>`).join('')}</dl></details>`
      : !error ? '<p role="status" aria-live="polite">Reading local build information…</p>' : ''}
    <p>Copilot: <code>/sf-about</code> · Shell: <code>singularity-flow about</code> or <code>sflow-about</code>.</p>
    <p><button data-about="after-install" class="secondary">Open After install</button></p>`;
}

export const ABOUT_STYLE = BRAND_ART_STYLE + '.about-table{overflow-x:auto}.about-table code{overflow-wrap:anywhere;white-space:normal}.about-facts{display:grid;grid-template-columns:minmax(9rem,auto) 1fr;gap:.6rem 1.2rem}.about-facts dd{margin:0;overflow-wrap:anywhere}';
export const ABOUT_SCRIPT = `document.addEventListener('click',event=>{const button=event.target.closest('[data-about]');if(button&&!button.disabled)window.__sfVscode.postMessage({type:button.dataset.about})});`;
