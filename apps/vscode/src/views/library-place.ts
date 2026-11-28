/**
 * The Library place [FPL:REQ-027, REQ-003]: skills and agents, the repository's own and those of the marketplaces the
 * repository trusts. Until M4 builds the Library's own list, its page is today's Marketplace page as it is, with All
 * skills and Add your own agent folder… beside it, so the place is never empty and never a dead end.
 *
 * Pure: the extension lends it the commands (`LibraryHost`). Opening the tab opens nothing; only its buttons do, and each
 * runs today's command, whose installs and updates go through Workflow Studio's preview and a proposal [REQ-029].
 */
import { escape } from './webview.ts';

export interface LibraryHost {
  /** A VS Code command by its ID: the Marketplace page, All skills, Add your own agent folder…. */
  command(id: string): Promise<void>;
}

/** Each button and the command it runs. */
export const LIBRARY_ROUTES: Readonly<Record<string, { command: string; label: string }>> = Object.freeze({
  marketplace: { command: 'singularityFlow.marketplace', label: 'Open the Library' },
  skills: { command: 'singularityFlow.allSkills', label: 'All skills, with what each one is used in' },
  agent: { command: 'singularityFlow.addUserAgent', label: 'Add your own agent folder…' }
});

/** The Library tab's panel: one button to its page, and the two pages beside it. */
export function libraryPanelHtml(): string {
  const link = (id: keyof typeof LIBRARY_ROUTES) => `<p><button type="button" class="places-link" data-library="${id}">${escape(LIBRARY_ROUTES[id]!.label)}</button></p>`;
  return `<p><button type="button" class="library-open" data-library="marketplace">${escape(LIBRARY_ROUTES.marketplace!.label)}</button></p>
<p class="library-line">Find, install or update a skill or agent there. Each install is previewed before anything changes.</p>
${link('skills')}${link('agent')}`;
}

export const LIBRARY_STYLE = `
.library-open { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 3px 10px; cursor: pointer; font: inherit; }
.library-open:hover { background: var(--vscode-button-hoverBackground); }
.library-open:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.library-line { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0 8px; overflow-wrap: anywhere; }
`;

/** After the places' `vscode` handle: each button as a message; nothing here opens or records anything by itself. */
export const LIBRARY_SCRIPT = `
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-library]');
  if (target) vscode.postMessage({ type: 'places', action: 'library', open: target.dataset.library });
});
`;

/** The Library tab beside the other places (views/needs-you.ts `PlacePart`). */
export class LibraryPlace {
  readonly style = LIBRARY_STYLE;
  readonly script = LIBRARY_SCRIPT;
  private readonly host: LibraryHost;

  // A plain field, not a parameter property, so Node's type stripping reads this module as it is.
  constructor(host: LibraryHost) { this.host = host; }

  panel(): string { return libraryPanelHtml(); }

  /** A message from the Library tab; true when it was the Library's. */
  receive(message: Record<string, unknown>): boolean {
    if (message.action !== 'library' || typeof message.open !== 'string') return false;
    const route = Object.hasOwn(LIBRARY_ROUTES, message.open) ? LIBRARY_ROUTES[message.open] : undefined;
    if (route) void this.host.command(route.command);
    return Boolean(route);
  }

  /** The tab opened: its page is read when its button opens it, so nothing is read here. */
  activate(): void {}

  attach(): void { /* the Library tab repaints whole; nothing is posted to it */ }
}
