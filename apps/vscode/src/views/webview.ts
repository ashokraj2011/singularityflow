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
  /* Built on the editor's own tokens so a panel reads as part of VS Code rather than a page inside
     it. Nothing here picks a colour outright: every value is a theme variable with a fallback, so
     the panel is correct in light, dark and high-contrast without knowing which it is in. */
  :root {
    color-scheme: light dark;
    --sf-gap: 1rem;
    --sf-radius: 6px;
    --sf-border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    --sf-surface: var(--vscode-editorWidget-background, transparent);
    --sf-ok: var(--vscode-testing-iconPassed, #3fb950);
    --sf-wait: var(--vscode-testing-iconQueued, #d29922);
    --sf-bad: var(--vscode-testing-iconFailed, #f85149);
    --sf-dim: var(--vscode-descriptionForeground);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 1.5rem 4rem;
    line-height: 1.55;
    max-width: 62rem;
  }

  h1 { font-size: 1.45rem; font-weight: 600; margin: 1.5rem 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: .74rem; font-weight: 600; text-transform: uppercase; letter-spacing: .09em;
       color: var(--sf-dim); margin: 2.25rem 0 .75rem; }
  h3 { font-size: .95rem; font-weight: 600; margin: 1rem 0 .35rem; }
  p { margin: .4rem 0; }
  .meta { color: var(--sf-dim); margin: 0 0 .25rem; }
  .muted { color: var(--sf-dim); }
  .question { color: var(--sf-dim); margin: -.35rem 0 .75rem; }
  .ok-text { color: var(--sf-ok); }

  section { border-top: var(--sf-border); padding-top: .25rem; }
  header, section.next, section.plain { border: 0; }

  /* Cards carry a single decision each, so the eye can move between them without re-reading. */
  .card {
    border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface);
    padding: .85rem 1rem; margin: .6rem 0; display: grid; gap: .5rem;
  }
  .card.yours { border-left: 3px solid var(--sf-ok); }
  .card.others { border-left: 3px solid var(--sf-wait); }
  .card.blocked { border-left: 3px solid var(--sf-bad); }
  .card-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  .card-head h3 { margin: 0; }
  .card-foot { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }

  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; font-size: .72rem; text-transform: uppercase;
       letter-spacing: .06em; color: var(--sf-dim);
       border-bottom: var(--sf-border); padding: .35rem .6rem .35rem 0; }
  td { padding: .45rem .6rem .45rem 0; border-bottom: var(--sf-border); vertical-align: top; }
  tr.drift td { background: var(--vscode-inputValidation-warningBackground, transparent); }

  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family); font-size: .85em;
         background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
         padding: .05rem .35rem; border-radius: 3px; }

  button {
    font-family: inherit; font-size: .85rem; font-weight: 500;
    padding: .35rem .85rem; cursor: pointer; border: 0; border-radius: 3px;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: .45; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    box-shadow: inset 0 0 0 1px var(--vscode-panel-border, rgba(128,128,128,.4));
  }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: .2rem 0; }
  /* Focus is never removed: a governance surface has to be usable from the keyboard. */
  button:focus-visible, input:focus-visible, a:focus-visible {
    outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px;
  }
  input[type="text"] {
    font-family: inherit; font-size: .9rem; padding: .3rem .5rem; border-radius: 3px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  label { display: inline-flex; align-items: center; gap: .5rem; }

  .rail { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .2rem 1.5rem; }
  .stage { display: flex; align-items: center; gap: .5rem; padding: .3rem 0; }
  .stage .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--sf-dim); flex: 0 0 auto; }
  .stage.ok .dot { background: var(--sf-ok); }
  .stage.wait .dot { background: var(--sf-wait); }
  .stage.active .dot { background: var(--vscode-textLink-foreground); }
  .stage.bad .dot { background: var(--sf-bad); }
  .stage.current .name { font-weight: 600; }
  .stage .count { color: var(--sf-dim); font-size: .8em; }

  .pill { font-size: .72rem; font-weight: 600; letter-spacing: .02em; padding: .1rem .5rem;
          border-radius: 999px; background: var(--vscode-badge-background);
          color: var(--vscode-badge-foreground); white-space: nowrap; }
  .pill.ok { background: var(--sf-ok); color: #06210d; }
  .pill.wait { background: var(--sf-wait); color: #241a00; }
  .pill.bad { background: var(--sf-bad); color: #2b0a08; }

  /* The chain reads left to right, because that is the order the bodies must sign in. */
  .chain { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
  .chain li { display: flex; align-items: center; gap: .4rem; font-size: .82rem; color: var(--sf-dim); }
  .chain li::after { content: "→"; opacity: .5; margin-left: .2rem; }
  .chain li:last-child::after { content: ""; }
  .chain li.satisfied { color: var(--sf-ok); }
  .chain li.open { color: var(--vscode-foreground); font-weight: 600; }

  .blockers { margin: .3rem 0; padding-left: 1.15rem; }
  .blockers li { margin: .25rem 0; }
  .sources { padding-left: 1.15rem; }
  .empty { padding: 3.5rem 0; color: var(--sf-dim); text-align: center; }
  .remedy { margin: .5rem 0 0; font-size: .9em; color: var(--sf-dim); }
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
