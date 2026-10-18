/**
 * The Singularity Flow brand art: the ∫₀^∞ mark and the two lockups drawn from the brand sheet.
 *
 * Everything is inline SVG because the pages that show it load no local resources
 * (`localResourceRoots: []`), and because inline SVG is the only form that can follow the editor
 * theme. The mark and lockups are the sheet redrawn, not a crop of it: the sheet is a mockup whose
 * "transparent" banner has a checkerboard painted into its pixels. The coordinates below are the
 * sheet's own pixel coordinates, so a redraw can be overlaid on the sheet and checked line by line.
 *
 * The wordmark is live text, stretched to the sheet's line widths with `textLength`: each line ends
 * where the sheet's does whichever system font the editor uses, and screen readers get one label.
 *
 * Two treatments only, by request: the transparent banner on My Work, and the navy card on About.
 * The extension icon (`media/icon.png`, drawn from `media/icon.svg`) is the third.
 */

/**
 * The f with ∞ above and 0 below, in the sheet's coordinates (bounding box 83,86 → 246,294).
 * `media/brand.svg` and `media/lockup.svg` carry the same geometry. Below about 30 px it does not
 * hold up, so the activity bar, chat avatar, sidebar header and page lockups use the 24-unit redraw
 * in `media/activity.svg` (the chat avatar in its fixed-ink copies `media/chat-light.svg` and
 * `media/chat-dark.svg`) and webview.ts instead.
 */
function integralMark(gradient: string): string {
  return `<g fill="none" stroke="url(#${gradient})" stroke-linecap="round" stroke-linejoin="round">
    <path stroke-width="9" d="M178 107.5C176.8 103.2 173.8 101.2 170.2 101.4C165 101.6 159.5 108 158.8 114L141.6 266C141 271 137 274.8 131.8 274.8C129.4 274.8 127.3 274.3 125.5 273.4M134.5 176H169.5"/>
    <path stroke-width="7" d="M217 102C212.5 95.5 208 89.5 202.5 89.5C196 89.5 191.5 95 191.5 102S196 114.5 202.5 114.5C208 114.5 212.5 108.5 217 102S226 89.5 231.5 89.5C238 89.5 242.5 95 242.5 102S238 114.5 231.5 114.5C226 114.5 221.5 108.5 217 102Z"/>
    <ellipse stroke-width="7" cx="98" cy="271" rx="11.5" ry="19.5"/></g>`;
}

/** Dark green at the 0, light at the top of the f, as on the sheet. */
function markGradient(id: string, stops: string): string {
  return `<linearGradient id="${id}" x1="105" y1="290" x2="235" y2="90" gradientUnits="userSpaceOnUse">${stops}</linearGradient>`;
}

/**
 * The first treatment: mark, SINGULARITY FLOW, SFLOW and the tagline on a transparent ground.
 *
 * Its colours are theme variables (see `BRAND_ART_STYLE`): white SFLOW would vanish in a light
 * editor, and the sheet's light card shows the darker greens the brand uses on white.
 */
export function brandBanner(): string {
  return `<svg class="sf-brand-banner" width="610" height="214" viewBox="78 83 610 214" role="img"
    aria-label="Singularity Flow. SFLOW: from intent to verified delivery.">
    <defs>${markGradient('sf-banner-ink', '<stop offset="0" class="sf-mark-low"/><stop offset=".5" class="sf-mark-mid"/><stop offset="1" class="sf-mark-high"/>')}</defs>
    ${integralMark('sf-banner-ink')}
    <text class="sf-logo-word" x="272" y="140" font-size="37.5" font-weight="700" textLength="410" lengthAdjust="spacing">SINGULARITY FLOW</text>
    <text class="sf-logo-name" x="268" y="242" font-size="114" font-weight="800" textLength="414" lengthAdjust="spacing">SFLOW</text>
    <text class="sf-logo-tag" x="271" y="279" font-size="21.5" font-weight="600" textLength="410" lengthAdjust="spacing">FROM INTENT TO VERIFIED DELIVERY</text>
  </svg>`;
}

/**
 * The third treatment: the navy documentation card. It brings its own ground, so its colours are
 * fixed in every theme except high contrast, where `BRAND_ART_STYLE` hands them back to the editor.
 */
export function brandCard(): string {
  return `<svg class="sf-brand-card" width="339" height="191" viewBox="0 0 339 191" role="img" aria-label="Singularity Flow. SFLOW.">
    <defs>${markGradient('sf-card-ink', '<stop offset="0" stop-color="#1f6e48"/><stop offset=".5" stop-color="#3f9462"/><stop offset="1" stop-color="#72b98a"/>')}</defs>
    <rect class="sf-card-plate" width="339" height="191" rx="10" fill="#252c37"/>
    <g transform="translate(48 50) scale(.4423) translate(-83 -86)">${integralMark('sf-card-ink')}</g>
    <text x="136" y="80" font-size="21" font-weight="700" textLength="161" lengthAdjust="spacing" fill="#5fa27c">SINGULARITY</text>
    <text x="135" y="122" font-size="45" font-weight="800" textLength="163" lengthAdjust="spacing" fill="#f6f8fa">SFLOW</text>
  </svg>`;
}

/** Sizes and per-theme colours for both lockups; dark is the default, as on the sheet. */
export const BRAND_ART_STYLE = `
.sf-brand-banner, .sf-brand-card { display: block; width: 100%; height: auto; margin: 0 0 1rem; }
.sf-brand-banner { max-width: 26rem; --sf-mark-low: #1b6a43; --sf-mark-mid: #3f9462; --sf-mark-high: #72b98a;
  --sf-logo-word: #5aa877; --sf-logo-name: #f5f7f8; --sf-logo-tag: #cfd5da; }
body.vscode-light .sf-brand-banner { --sf-mark-low: #145a3a; --sf-mark-mid: #2b7a52; --sf-mark-high: #4f9b70;
  --sf-logo-word: #1f6b45; --sf-logo-name: #1e2227; --sf-logo-tag: #3a4047; }
.sf-brand-banner text, .sf-brand-card text { font-family: var(--sf-font-sans, var(--vscode-font-family, system-ui, sans-serif)); }
.sf-mark-low { stop-color: var(--sf-mark-low); } .sf-mark-mid { stop-color: var(--sf-mark-mid); } .sf-mark-high { stop-color: var(--sf-mark-high); }
.sf-logo-word { fill: var(--sf-logo-word); } .sf-logo-name { fill: var(--sf-logo-name); } .sf-logo-tag { fill: var(--sf-logo-tag); }
.sf-brand-card { max-width: 21rem; margin-top: 1rem; border-radius: 10px; box-shadow: 0 6px 18px rgb(0 0 0 / .22); }
body:is(.vscode-high-contrast, .vscode-high-contrast-light) .sf-brand-card { box-shadow: none; }
body:is(.vscode-high-contrast, .vscode-high-contrast-light) .sf-card-plate { fill: transparent; stroke: var(--vscode-contrastBorder, CanvasText); stroke-width: 2; }
body:is(.vscode-high-contrast, .vscode-high-contrast-light) :is(.sf-brand-banner, .sf-brand-card) stop { stop-color: var(--vscode-foreground); }
body:is(.vscode-high-contrast, .vscode-high-contrast-light) :is(.sf-brand-banner, .sf-brand-card) text { fill: var(--vscode-foreground); }
`;
