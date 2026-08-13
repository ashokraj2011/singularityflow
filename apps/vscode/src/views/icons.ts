/**
 * Singularity Flow's semantic icon language.
 *
 * Webviews cannot reuse VS Code's Codicon font without widening the CSP. They therefore render
 * these local, currentColor SVG paths. Native trees resolve the same nouns and states to Codicons
 * through TREE_ICONS below. A product concept has one name even though the two renderers differ.
 *
 * That last sentence was true of the nouns and false of the states, which is how a not-started
 * phase came to look approved. The trees name states `statusIdle`, `statusCurrent` and so on; this
 * table only had `ok`, `wait`, `blocked`. `semanticIcon` guesses from the name when it misses, and
 * two of the seven matched no guess and fell through to the node's kind — for a phase, a
 * circle-with-a-tick. Both vocabularies are now the same set, and `both renderers speak one
 * vocabulary` in the sidebar tests fails if a name is ever added to one and not the other.
 */
const BASE_PATHS = {
  // Product structure
  workspace: '<rect x="3" y="3" width="8" height="8" rx="2.2"/><rect x="13" y="3" width="8" height="8" rx="2.2"/><rect x="3" y="13" width="8" height="8" rx="2.2"/><rect x="13" y="13" width="8" height="8" rx="2.2"/>',
  workspaceManage: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h7M7 17h4"/>',
  workspaceAdd: '<rect x="3" y="4" width="14" height="16" rx="3"/><path d="M7 9h6M7 13h4M19 14v7M15.5 17.5h7"/>',
  organisation: '<path d="M4 21V5l8-3 8 3v16M2 21h20M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
  capability: '<rect x="8" y="2" width="8" height="6" rx="1.5"/><rect x="2" y="16" width="8" height="6" rx="1.5"/><rect x="14" y="16" width="8" height="6" rx="1.5"/><path d="M12 8v4M6 16v-4h12v4"/>',
  team: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c0-4 2.5-6 6-6s6 2 6 6M15 15c3 0 5 1.8 5 5"/>',
  teams: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c0-4 2.5-6 6-6s6 2 6 6M15 15c3 0 5 1.8 5 5"/>',
  collection: '<path d="M4 5h6M4 12h10M4 19h16"/><circle cx="18" cy="5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="8" cy="19" r="2"/>',
  delivery: '<path d="M4 4h16v13H4zM4 17h16v3H4zM8 8h8M8 12h5"/>',
  repository: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5zM6.5 18H20v4H6.5A2.5 2.5 0 0 1 6.5 18z"/>',
  directory: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  workflow: '<circle cx="4" cy="12" r="2.25"/><circle cx="12" cy="12" r="2.25"/><circle cx="20" cy="12" r="2.25"/><path d="M6.25 12h3.5M14.25 12h3.5"/>',
  configuration: '<path d="M4 6h7M15 6h5M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="13" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  phase: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-5"/>',

  // Instructions and knowledge
  agent: '<circle cx="10" cy="9" r="3"/><path d="M4 20c.4-4 2.4-6 6-6s5.6 2 6 6"/><path d="m18 4 .7 1.6L20.5 6l-1.8.5L18 8l-.7-1.5L15.5 6l1.8-.4z"/>',
  prompt: '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 8h8M8 12h5"/>',
  skill: '<path d="m12 2 2.3 4.7L19.5 8l-3.8 3.7.9 5.3-4.6-2.5L7.4 17l.9-5.3L4.5 8l5.2-1.3z"/>',
  pack: '<path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/>',
  worldModel: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  mcp: '<path d="M8 8V5a2 2 0 0 1 4 0v3M12 8V4a2 2 0 0 1 4 0v6M8 8V6a2 2 0 0 0-4 0v7c0 5 3 9 8 9s8-4 8-9v-2a2 2 0 0 0-4 0"/><path d="M8 12h8"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v17H6.5A2.5 2.5 0 0 0 4 22.5zM20 5.5A2.5 2.5 0 0 0 17.5 3H12v17h5.5a2.5 2.5 0 0 1 2.5 2.5z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 1 1 3.7 2.2c-1 .6-1.4 1.1-1.4 2.3M12 17.5h.01"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/>',

  // Work and governance
  initiative: '<path d="M12 3c4 2.5 6 6 6 10l-6 5-6-5c0-4 2-7.5 6-10z"/><circle cx="12" cy="10" r="2"/><path d="m8 18-2 3M16 18l2 3"/>',
  epic: '<path d="M12 3c4 2.5 6 6 6 10l-6 5-6-5c0-4 2-7.5 6-10z"/><circle cx="12" cy="10" r="2"/><path d="m8 18-2 3M16 18l2 3"/>',
  story: '<path d="M4 5a2 2 0 0 1 2-2h5a3 3 0 0 1 1 2 3 3 0 0 1 1-2h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5a2 2 0 0 0-1 1 2 2 0 0 0-1-1H6a2 2 0 0 1-2-2zM12 5v17"/>',
  artifact: '<path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/>',
  document: '<path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/>',
  approval: '<path d="m12 2 8 3.5v6c0 5-3.2 8.5-8 10.5-4.8-2-8-5.5-8-10.5v-6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  inbox: '<path d="M4 5h16l1 9v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/><path d="M3 14h5l1.5 3h5L16 14h5M8.5 9.5l2 2 4-4"/>',
  archive: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M9 13h6M5 2h14v3H5z"/>',
  gate: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  policy: '<path d="m12 2 8 3.5v6c0 5-3.2 8.5-8 10.5-4.8-2-8-5.5-8-10.5v-6z"/>',
  jira: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 2.5 2.5L16 9"/>',
  tracker: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 2.5 2.5L16 9"/>',
  impact: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',
  visual: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m5 17 4.5-4.5 3 3L15 13l4 4"/>',
  compare: '<rect x="3" y="4" width="13" height="13" rx="2"/><rect x="8" y="7" width="13" height="13" rx="2"/><path d="M12 7v10"/>',

  // Source control
  git: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 6v12M18 11c0 4-3 6-8 7"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 6v12M18 11c0 4-3 6-8 7"/>',
  commit: '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
  merge: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 6v12M8 4h4a4 4 0 0 1 4 4v2"/>',

  // Actions
  add: '<path d="M12 5v14M5 12h14"/>',
  start: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/>',
  edit: '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 7l3 3"/>',
  remove: '<path d="M5 7h14M9 7V4h6v3M8 7l1 14h6l1-14M10 11v6M14 11v6"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  drag: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 6M20 5v6h-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',

  // States
  ok: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16.5 9"/>',
  wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  waiting: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  warning: '<path d="m12 3 10 18H2z"/><path d="M12 9v5M12 17h.01"/>',
  blocked: '<circle cx="12" cy="12" r="9"/><path d="m8 8 8 8M16 8l-8 8"/>',
  stale: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2M6 5l-2 3h4"/>',
  bad: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>'
} as const;

/**
 * The state vocabulary both renderers speak, aliased to one glyph each so a state cannot drift
 * between them. The two without a `BASE_PATHS` equivalent are the two that were missing: a ring
 * with a filled centre for the phase you are standing in, and an empty ring for one not started —
 * which is the point, since an empty ring is the one shape that cannot be misread as done.
 */
const STATUS_PATHS = {
  statusSuccess: BASE_PATHS.success,
  statusWaiting: BASE_PATHS.wait,
  statusWarning: BASE_PATHS.warning,
  statusBlocked: BASE_PATHS.blocked,
  statusStale: BASE_PATHS.stale,
  statusCurrent: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
  statusIdle: '<circle cx="12" cy="12" r="9"/>'
} as const;

export const ICON_PATHS = { ...BASE_PATHS, ...STATUS_PATHS } as const;

export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.freeze(Object.keys(ICON_PATHS) as IconName[]);

export function icon(name: IconName, { size = 16 }: { size?: 14 | 16 | 20 | 24 } = {}): string {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

/** Semantic concepts used by native trees. Unknown legacy Codicons still pass through safely. */
export const TREE_ICONS = {
  // The three entry points use the restrained brand accent. Everything beneath them stays neutral
  // unless it communicates status, so the sidebar does not become a wall of green glyphs.
  workspace: { id: 'root-folder', color: 'charts.green' },
  workspaceManage: { id: 'project' }, workspaceAdd: { id: 'new-folder' },
  capability: { id: 'type-hierarchy', color: 'charts.green' },
  workflow: { id: 'list-tree', color: 'charts.green' },
  configuration: { id: 'settings-gear', color: 'charts.green' },
  collection: { id: 'type-hierarchy' }, delivery: { id: 'repo' },
  directory: { id: 'folder' },
  team: { id: 'organization' },
  phase: { id: 'symbol-event' }, artifact: { id: 'file' },
  agent: { id: 'hubot' }, prompt: { id: 'comment-discussion' }, skill: { id: 'sparkle' },
  pack: { id: 'package' }, approval: { id: 'verified' }, inbox: { id: 'inbox', color: 'charts.green' }, jira: { id: 'issues' },
  archive: { id: 'archive' },
  help: { id: 'question', color: 'charts.green' }, start: { id: 'play-circle' },
  worldModel: { id: 'globe' }, story: { id: 'git-pull-request' }, initiative: { id: 'milestone' },
  mcp: { id: 'plug' },
  visual: { id: 'preview', color: 'charts.green' }, compare: { id: 'diff' },
  statusSuccess: { id: 'pass-filled', color: 'testing.iconPassed' },
  statusWaiting: { id: 'clock', color: 'testing.iconQueued' },
  statusWarning: { id: 'warning', color: 'problemsWarningIcon.foreground' },
  statusBlocked: { id: 'error', color: 'problemsErrorIcon.foreground' },
  statusStale: { id: 'history', color: 'problemsWarningIcon.foreground' },
  statusCurrent: { id: 'circle-large-filled', color: 'charts.green' },
  statusIdle: { id: 'circle-outline' }
} as const;

export type TreeIconName = keyof typeof TREE_ICONS | string;
export function treeIcon(name: TreeIconName): { id: string; color?: string } {
  return TREE_ICONS[name as keyof typeof TREE_ICONS] ?? { id: name };
}
