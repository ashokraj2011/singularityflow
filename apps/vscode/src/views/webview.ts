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

/**
 * The icon set, inline.
 *
 * Codicons are a font the editor loads for its own chrome; a webview would have to ship and
 * whitelist it, which means a `font-src` in a CSP that currently allows nothing. Twenty small paths
 * cost less than that, and they inherit `currentColor` so they follow whatever the label beside them
 * is doing — including the theme, the disabled state, and the status colours.
 *
 * Kept together rather than beside each use so that "which icon means a repository" has one answer.
 */
const ICONS: Record<string, string> = {
  // Source control and code
  git: '<path d="M14.5 1.5 8 8m0 0L1.5 14.5M8 8 1.5 1.5M8 8l6.5 6.5"/>',
  repository: '<path d="M2 2.5A1.5 1.5 0 0 1 3.5 1H13v11H3.5A1.5 1.5 0 0 0 2 13.5zM3.5 12H13v3H3.5A1.5 1.5 0 0 1 3.5 12z"/>',
  branch: '<circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 4.6v6.8M12 7.6c0 2.2-1.6 3.4-4 3.8"/>',
  commit: '<circle cx="8" cy="8" r="2.6"/><path d="M1 8h4.4M10.6 8H15"/>',
  merge: '<circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 4.6v6.8M5.6 3h2.6A2 2 0 0 1 10.2 5v1.4"/>',
  code: '<path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4"/>',

  // Structure
  organisation: '<path d="M2 14.5V3.2a1 1 0 0 1 .7-1L7.3 1a1 1 0 0 1 1.2 1v12.5M8.5 6h4.8a1 1 0 0 1 1 1v7.5M1 14.5h14M4.2 4.6h2M4.2 7.2h2M4.2 9.8h2M10.4 8.6h1.6M10.4 11.2h1.6"/>',
  capability: '<rect x="5.5" y="1.5" width="5" height="4" rx="1"/><rect x="1.5" y="10.5" width="4.5" height="4" rx="1"/><rect x="10" y="10.5" width="4.5" height="4" rx="1"/><path d="M8 5.5v3M3.75 10.5v-2h8.5v2"/>',
  directory: '<path d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.2l1.4 1.6h5.4a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  workspace: '<rect x="1.5" y="3.5" width="13" height="10" rx="1.5"/><path d="M1.5 6.5h13M5 1.5v2M11 1.5v2"/>',
  teams: '<circle cx="5.5" cy="5" r="2.2"/><path d="M1.5 13c0-2.2 1.8-3.6 4-3.6s4 1.4 4 3.6"/><circle cx="11.8" cy="6" r="1.8"/><path d="M11 9.6c2 .1 3.5 1.4 3.5 3.4"/>',

  // Governance
  approval: '<path d="M8 1.5 13.5 4v4.2c0 3.1-2.2 5.4-5.5 6.3C4.7 13.6 2.5 11.3 2.5 8.2V4z"/><path d="M5.8 8.2 7.3 9.7l3-3.2"/>',
  policy: '<path d="M8 1.5 14 4.2v3.4c0 3.4-2.4 5.9-6 6.9-3.6-1-6-3.5-6-6.9V4.2z"/>',
  gate: '<rect x="2" y="6.5" width="12" height="7.5" rx="1.5"/><path d="M4.8 6.5V4.2a3.2 3.2 0 0 1 6.4 0v2.3"/>',

  // Work
  epic: '<path d="M8 1.5c2.6 1.8 4 4.4 4 7.3L8 12.5 4 8.8c0-2.9 1.4-5.5 4-7.3z"/><circle cx="8" cy="6.6" r="1.4"/><path d="M5.6 12.2 4 14.5M10.4 12.2 12 14.5"/>',
  story: '<path d="M2 3.2A1.4 1.4 0 0 1 3.4 2h3.2A2 2 0 0 1 8 3.4 2 2 0 0 1 9.4 2h3.2A1.4 1.4 0 0 1 14 3.4v8.4a1.4 1.4 0 0 1-1.4 1.4H9.4A1.4 1.4 0 0 0 8 14.6a1.4 1.4 0 0 0-1.4-1.4H3.4A1.4 1.4 0 0 1 2 11.8z"/><path d="M8 3.4v11.2"/>',
  tracker: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5.5 8.2 7 9.7l3.5-3.6"/>',
  document: '<path d="M3.5 1.5h6L12.5 5v9.5h-9z"/><path d="M9.5 1.5V5h3M5.5 8h5M5.5 11h5"/>',
  impact: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="5.5"/><path d="M8 .5v2M8 13.5v2M.5 8h2M13.5 8h2"/>',

  // States
  ok: '<circle cx="8" cy="8" r="6.3"/><path d="M5.4 8.2 7.2 10l3.5-3.8"/>',
  wait: '<circle cx="8" cy="8" r="6.3"/><path d="M8 4.6V8l2.3 1.6"/>',
  bad: '<circle cx="8" cy="8" r="6.3"/><path d="M8 4.6v4M8 11.2v.2"/>'
};

/**
 * One icon, sized to sit on a text baseline.
 *
 * Unknown names render nothing rather than an empty box: a missing icon should cost a reader nothing,
 * and a placeholder glyph reads as a real state.
 */
export function icon(name: string, { size = 14 }: { size?: number } = {}): string {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

export const STYLE = `
  /* The editor's own tokens carry the surface — background, foreground, inputs — so a panel reads as
     part of VS Code and stays correct in light, dark and high-contrast. The accent is ours: a deep
     green for the action that commits, a blue for the ones that merely navigate, so "this changes
     something" and "this takes me somewhere" never look alike. The status three are kept close to
     the editor's own testing colours, since those are the ones a reader already knows. */
  :root {
    color-scheme: light dark;
    --sf-gap: 1rem;
    --sf-radius: 8px;
    --sf-border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
    --sf-surface: var(--vscode-editorWidget-background, transparent);

    --sf-accent: #2e7d32;
    --sf-accent-hover: #256428;
    --sf-accent-quiet: rgba(46,125,50,.12);
    --sf-on-accent: #ffffff;
    --sf-link: var(--vscode-textLink-foreground, #1263c4);

    --sf-ok: var(--vscode-testing-iconPassed, #2e7d32);
    --sf-wait: var(--vscode-testing-iconQueued, #b26a00);
    --sf-bad: var(--vscode-testing-iconFailed, #c62828);
    --sf-dim: var(--vscode-descriptionForeground);
  }
  /* The accent has to clear the background it sits on, and a dark editor is a different background.
     Same hue, lifted so it stays legible rather than turning into a hole in the page. */
  @media (prefers-color-scheme: dark) {
    :root {
      --sf-accent: #3d9a42;
      --sf-accent-hover: #48ad4d;
      --sf-accent-quiet: rgba(61,154,66,.16);
      --sf-on-accent: #06210d;
    }
  }

  /* Icons sit on the baseline of whatever they label and take its colour, including when that is a
     status colour or a disabled button. */
  .ico { vertical-align: -.15em; flex: 0 0 auto; }
  h1 .ico, h2 .ico, h3 .ico { margin-right: .4rem; }
  td .ico, li .ico { margin-right: .35rem; opacity: .85; }
  button .ico { margin-right: .35rem; }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 1.5rem 4rem;
    line-height: 1.55;
    max-width: 62rem;
  }

  h1 { font-size: 1.45rem; font-weight: 600; margin: 1.25rem 0 .2rem; letter-spacing: -.01em; }
  h2 { display: flex; align-items: center; font-size: .74rem; font-weight: 700;
       text-transform: uppercase; letter-spacing: .09em;
       color: var(--sf-dim); margin: 1.6rem 0 .5rem; }
  h3 { font-size: .95rem; font-weight: 600; margin: 1rem 0 .35rem; }
  p { margin: .4rem 0; }
  .meta { color: var(--sf-dim); margin: 0 0 .25rem; }
  .muted { color: var(--sf-dim); }
  .question { color: var(--sf-dim); margin: -.35rem 0 .75rem; }
  .ok-text { color: var(--sf-ok); font-weight: 500; }

  section { border-top: var(--sf-border); padding-top: .1rem; padding-bottom: .35rem; }
  header, section.next, section.plain { border: 0; }

  /* Cards carry a single decision each, so the eye can move between them without re-reading. */
  .card {
    border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface);
    padding: .85rem 1rem; margin: .6rem 0; display: grid; gap: .5rem;
  }
  .card.yours { border-left: 3px solid var(--sf-accent); }
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

  a { color: var(--sf-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family); font-size: .85em;
         background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
         padding: .05rem .35rem; border-radius: 3px; }

  /* Pill-shaped, generously padded, and only ever one of them filled per section. The filled one is
     the action that commits; everything else is outlined or plain, so the eye finds the consequential
     control without reading all of them. */
  button {
    display: inline-flex; align-items: center; justify-content: center;
    font-family: inherit; font-size: .85rem; font-weight: 600; letter-spacing: .01em;
    padding: .45rem 1.15rem; cursor: pointer; border: 1px solid transparent; border-radius: 999px;
    background: var(--sf-accent); color: var(--sf-on-accent);
    transition: background .12s ease, border-color .12s ease;
  }
  button:hover:not(:disabled) { background: var(--sf-accent-hover); }
  button:disabled { opacity: .4; cursor: default; }
  button.secondary {
    background: transparent; color: var(--sf-accent);
    border-color: var(--sf-accent);
  }
  button.secondary:hover:not(:disabled) { background: var(--sf-accent-quiet); }
  button.link {
    background: none; border-color: transparent; color: var(--sf-link);
    padding: .2rem .1rem; font-weight: 500; border-radius: 4px;
  }
  button.link:hover:not(:disabled) { background: none; text-decoration: underline; }
  /* Focus is never removed: a governance surface has to be usable from the keyboard. */
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, var(--sf-accent)); outline-offset: 2px;
  }
  input[type="text"], select {
    font-family: inherit; font-size: .9rem; padding: .38rem .6rem; border-radius: var(--sf-radius);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  }
  input[type="text"]:focus, select:focus { border-color: var(--sf-accent); }
  input[type="checkbox"], input[type="radio"] { accent-color: var(--sf-accent); }
  label { display: inline-flex; align-items: center; gap: .5rem; }

  .rail { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .2rem 1.5rem; }
  .stage { display: flex; align-items: center; gap: .5rem; padding: .3rem 0; }
  .stage .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--sf-dim); flex: 0 0 auto; }
  .stage.ok .dot { background: var(--sf-ok); }
  .stage.wait .dot { background: var(--sf-wait); }
  .stage.active .dot { background: var(--sf-accent); box-shadow: 0 0 0 3px var(--sf-accent-quiet); }
  .stage.bad .dot { background: var(--sf-bad); }
  .stage.current .name { font-weight: 600; }
  .stage .count { color: var(--sf-dim); font-size: .8em; }

  /* Outlined rather than filled. A row of solid badges competes with the one filled button that
     actually does something; these are labels, and should read as labels. */
  .pill { display: inline-flex; align-items: center; gap: .25rem;
          font-size: .72rem; font-weight: 600; letter-spacing: .02em; padding: .08rem .55rem;
          border-radius: 999px; border: 1px solid currentColor; color: var(--sf-dim);
          white-space: nowrap; }
  .pill.ok { color: var(--sf-ok); background: var(--sf-accent-quiet); }
  .pill.wait { color: var(--sf-wait); }
  .pill.bad { color: var(--sf-bad); }

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
