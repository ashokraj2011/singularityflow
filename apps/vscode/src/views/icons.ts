/**
 * Singularity Flow's semantic icon language.
 *
 * Webviews cannot reuse VS Code's Codicon font without widening the CSP. They therefore render
 * these local, currentColor SVG paths. Native trees resolve the same nouns and states to Codicons
 * through TREE_ICONS below. A product concept has one name even though the two renderers differ.
 */
export const ICON_PATHS = {
  // Product structure
  workspace: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M8 2v3M16 2v3"/>',
  organisation: '<path d="M4 21V5l8-3 8 3v16M2 21h20M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2"/>',
  capability: '<rect x="8" y="2" width="8" height="6" rx="1.5"/><rect x="2" y="16" width="8" height="6" rx="1.5"/><rect x="14" y="16" width="8" height="6" rx="1.5"/><path d="M12 8v4M6 16v-4h12v4"/>',
  team: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c0-4 2.5-6 6-6s6 2 6 6M15 15c3 0 5 1.8 5 5"/>',
  teams: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><path d="M3 20c0-4 2.5-6 6-6s6 2 6 6M15 15c3 0 5 1.8 5 5"/>',
  collection: '<path d="M4 5h6M4 12h10M4 19h16"/><circle cx="18" cy="5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="8" cy="19" r="2"/>',
  delivery: '<path d="M4 4h16v13H4zM4 17h16v3H4zM8 8h8M8 12h5"/>',
  repository: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5zM6.5 18H20v4H6.5A2.5 2.5 0 0 1 6.5 18z"/>',
  directory: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  workflow: '<circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M7 5h10M18 7l-5 10M11 17 6 7"/>',
  phase: '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-5"/>',

  // Instructions and knowledge
  agent: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M9 12h.01M15 12h.01M9 16h6M12 7V3M9 3h6"/>',
  prompt: '<path d="M4 4h16v12H8l-4 4z"/><path d="M8 8h8M8 12h5"/>',
  skill: '<path d="m12 2 2.3 4.7L19.5 8l-3.8 3.7.9 5.3-4.6-2.5L7.4 17l.9-5.3L4.5 8l5.2-1.3z"/>',
  pack: '<path d="m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10"/>',
  worldModel: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  book: '<path d="M3 5a3 3 0 0 1 3-3h6v18H6a3 3 0 0 0-3 3zM21 5a3 3 0 0 0-3-3h-6v18h6a3 3 0 0 1 3 3z"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/>',

  // Work and governance
  initiative: '<path d="M12 3c4 2.5 6 6 6 10l-6 5-6-5c0-4 2-7.5 6-10z"/><circle cx="12" cy="10" r="2"/><path d="m8 18-2 3M16 18l2 3"/>',
  epic: '<path d="M12 3c4 2.5 6 6 6 10l-6 5-6-5c0-4 2-7.5 6-10z"/><circle cx="12" cy="10" r="2"/><path d="m8 18-2 3M16 18l2 3"/>',
  story: '<path d="M4 5a2 2 0 0 1 2-2h5a3 3 0 0 1 1 2 3 3 0 0 1 1-2h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5a2 2 0 0 0-1 1 2 2 0 0 0-1-1H6a2 2 0 0 1-2-2zM12 5v17"/>',
  artifact: '<path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/>',
  document: '<path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/>',
  approval: '<path d="m12 2 8 3.5v6c0 5-3.2 8.5-8 10.5-4.8-2-8-5.5-8-10.5v-6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
  gate: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
  policy: '<path d="m12 2 8 3.5v6c0 5-3.2 8.5-8 10.5-4.8-2-8-5.5-8-10.5v-6z"/>',
  jira: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 2.5 2.5L16 9"/>',
  tracker: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 2.5 2.5L16 9"/>',
  impact: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3"/>',

  // Source control
  git: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 6v12M18 11c0 4-3 6-8 7"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 6v12M18 11c0 4-3 6-8 7"/>',
  commit: '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
  merge: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 6v12M8 4h4a4 4 0 0 1 4 4v2"/>',

  // Actions
  add: '<path d="M12 5v14M5 12h14"/>',
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
  workspace: { id: 'root-folder' }, collection: { id: 'type-hierarchy' }, delivery: { id: 'repo' },
  team: { id: 'organization' },
  workflow: { id: 'list-tree' }, phase: { id: 'symbol-event' }, artifact: { id: 'file' },
  agent: { id: 'hubot' }, prompt: { id: 'comment-discussion' }, skill: { id: 'sparkle' },
  pack: { id: 'package' }, approval: { id: 'verified' }, jira: { id: 'issues' },
  worldModel: { id: 'globe' }, story: { id: 'git-pull-request' }, initiative: { id: 'milestone' },
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
