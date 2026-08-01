/**
 * Shared webview plumbing: escaping, nonces, the CSP, and the stylesheet.
 *
 * One copy so the security posture cannot drift between panels. A second panel that quietly forgot
 * to escape, or relaxed its CSP, would be exactly the kind of difference nobody notices until it
 * matters — and there is no reason for two panels in the same extension to disagree about this.
 */
import type * as vscode from 'vscode';

/** Everything that reaches a page goes through this. */
export function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Not a secret — a CSP nonce only has to be unpredictable per render. */
export function nonce(): string {
  let value = '';
  for (let index = 0; index < 32; index += 1) value += Math.floor(Math.random() * 16).toString(16);
  return value;
}

/**
 * No default source at all, and the only style and script are the ones carrying this render's nonce.
 * Images are limited to the webview's own resource scheme; nothing else is loadable.
 */
export function contentSecurityPolicy(webview: vscode.Webview, token: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${token}'`,
    `script-src 'nonce-${token}'`,
    `img-src ${webview.cspSource}`
  ].join('; ');
}

export const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0 1.2rem 3rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 1.2rem 0 .2rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
       color: var(--vscode-descriptionForeground); margin: 2rem 0 .6rem; }
  h3 { font-size: .95rem; margin: .8rem 0 .3rem; }
  .meta { color: var(--vscode-descriptionForeground); margin: 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  .ok-text { color: var(--vscode-testing-iconPassed, #3fb950); }
  section { border-top: 1px solid var(--vscode-panel-border); }
  header, section.next, section.plain { border: 0; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; font-size: .78rem; text-transform: uppercase;
       letter-spacing: .05em; color: var(--vscode-descriptionForeground);
       border-bottom: 1px solid var(--vscode-panel-border); padding: .3rem .5rem .3rem 0; }
  td { padding: .35rem .5rem .35rem 0; border-bottom: 1px solid var(--vscode-panel-border);
       vertical-align: top; }
  tr.drift td { background: var(--vscode-inputValidation-warningBackground, transparent); }
  a { color: var(--vscode-textLink-foreground); }
  code { font-family: var(--vscode-editor-font-family); font-size: .85em; }
  button { font-family: inherit; font-size: .85em; padding: .25rem .7rem; cursor: pointer;
           border: 0; border-radius: 2px;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .rail { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .2rem 1.4rem; }
  .stage { display: flex; align-items: center; gap: .45rem; padding: .25rem 0; }
  .stage .dot { width: .6rem; height: .6rem; border-radius: 50%;
                background: var(--vscode-descriptionForeground); flex: 0 0 auto; }
  .stage.ok .dot { background: var(--vscode-testing-iconPassed, #3fb950); }
  .stage.wait .dot { background: var(--vscode-testing-iconQueued, #d29922); }
  .stage.active .dot { background: var(--vscode-textLink-foreground); }
  .stage.bad .dot { background: var(--vscode-testing-iconFailed, #f85149); }
  .stage.current .name { font-weight: 700; }
  .stage .count { color: var(--vscode-descriptionForeground); font-size: .8em; }
  .pill { font-size: .78em; padding: .1rem .5rem; border-radius: 999px;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .pill.ok { background: var(--vscode-testing-iconPassed, #3fb950); color: #06210d; }
  .pill.wait { background: var(--vscode-testing-iconQueued, #d29922); color: #241a00; }
  .pill.bad { background: var(--vscode-testing-iconFailed, #f85149); color: #2b0a08; }
  .blockers li { margin: .2rem 0; }
  .sources { padding-left: 1.1rem; }
  .empty { padding: 3rem 0; color: var(--vscode-descriptionForeground); }
  .question { color: var(--vscode-descriptionForeground); margin: 0 0 .6rem; }
  .remedy { margin: .5rem 0 0; font-size: .9em; }
  .remedy code { background: var(--vscode-textCodeBlock-background); padding: .1rem .35rem; border-radius: 2px; }
`;

/** Wrap a rendered body in the document shell, with the CSP and nonce already applied. */
export function page(title: string, body: string, csp: string, token: string, script = ''): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escape(title)}</title>
<style nonce="${token}">${STYLE}</style>
</head><body>
${body}
${script ? `<script nonce="${token}">${script}</script>` : ''}
</body></html>`;
}
