/**
 * Machine-local navigation personas for the VS Code shell.
 *
 * A persona changes ordering and suggestions only. It is deliberately unrelated to governed
 * agents and approval authorities: those continue to come from the pinned workflow and identity
 * records. Keeping the complete menu visible also means changing persona cannot remove access to a
 * command somebody still needs.
 */

export const PROFILE_PERSONA_IDS = [
  'product-owner', 'business-analyst', 'product-designer', 'architect', 'developer',
  'qa', 'security', 'delivery-manager', 'operations', 'admin', 'other'
] as const;

export type ProfilePersonaId = (typeof PROFILE_PERSONA_IDS)[number];

export interface ProfilePersona {
  readonly id: ProfilePersonaId;
  readonly label: string;
  readonly description: string;
  /** Suggested favorites, ordered by usefulness for this persona. */
  readonly menuIds: readonly string[];
  /** The same complete Navigator sections in a role-relevant order. */
  readonly sectionOrder: readonly string[];
}

const BASE_SECTIONS = ['favorites', 'inbox', 'workspaces', 'lifecycle', 'configuration', 'help', 'logs'] as const;

export const PROFILE_PERSONAS: readonly ProfilePersona[] = Object.freeze([
  {
    id: 'product-owner', label: 'Product owner', description: 'outcomes, intake, and decisions',
    menuIds: ['my-work', 'work-start', 'inbox-open', 'approvals-open'],
    sectionOrder: ['favorites', 'inbox', 'lifecycle', 'workspaces', 'configuration', 'help', 'logs']
  },
  {
    id: 'business-analyst', label: 'Business analyst', description: 'requirements, impact, and intake',
    menuIds: ['my-work', 'work-start', 'impact-form', 'inbox-open'],
    sectionOrder: ['favorites', 'lifecycle', 'inbox', 'configuration', 'workspaces', 'help', 'logs']
  },
  {
    id: 'product-designer', label: 'Product designer', description: 'visual evidence and experience',
    menuIds: ['my-work', 'visual-assurance', 'impact-form', 'work-start'],
    sectionOrder: ['favorites', 'lifecycle', 'inbox', 'configuration', 'workspaces', 'help', 'logs']
  },
  {
    id: 'architect', label: 'Architect', description: 'system impact and governed design',
    menuIds: ['my-work', 'impact-form', 'flow-impact', 'configuration-center'],
    sectionOrder: ['favorites', 'configuration', 'lifecycle', 'inbox', 'workspaces', 'help', 'logs']
  },
  {
    id: 'developer', label: 'Developer', description: 'current work, change impact, and diagnostics',
    menuIds: ['my-work', 'work-start', 'impact-form', 'logs-open'],
    sectionOrder: ['favorites', 'lifecycle', 'inbox', 'workspaces', 'logs', 'help', 'configuration']
  },
  {
    id: 'qa', label: 'QA', description: 'verification, evidence, and decisions',
    menuIds: ['my-work', 'inbox-open', 'visual-assurance', 'approvals-open'],
    sectionOrder: ['favorites', 'inbox', 'lifecycle', 'logs', 'workspaces', 'help', 'configuration']
  },
  {
    id: 'security', label: 'Security', description: 'risk, audit, and approval evidence',
    menuIds: ['my-work', 'inbox-open', 'approvals-open', 'prompt-audit'],
    sectionOrder: ['favorites', 'inbox', 'configuration', 'lifecycle', 'logs', 'workspaces', 'help']
  },
  {
    id: 'delivery-manager', label: 'Delivery manager', description: 'flow, queues, and delivery health',
    menuIds: ['my-work', 'inbox-open', 'approvals-open', 'workspace-manage'],
    sectionOrder: ['favorites', 'inbox', 'lifecycle', 'workspaces', 'logs', 'configuration', 'help']
  },
  {
    id: 'operations', label: 'Operations', description: 'workspaces, runtime impact, and logs',
    menuIds: ['my-work', 'workspace-manage', 'logs-open', 'impact-form'],
    sectionOrder: ['favorites', 'workspaces', 'logs', 'lifecycle', 'inbox', 'configuration', 'help']
  },
  {
    id: 'admin', label: 'Admin', description: 'workspace and product configuration',
    menuIds: ['workspace-manage', 'configuration-center', 'capability-map', 'logs-open'],
    sectionOrder: ['favorites', 'workspaces', 'configuration', 'logs', 'help', 'inbox', 'lifecycle']
  },
  {
    id: 'other', label: 'General', description: 'a balanced view of governed work',
    menuIds: ['my-work', 'work-start', 'inbox-open'],
    sectionOrder: BASE_SECTIONS
  }
]);

const PERSONA_BY_ID = new Map(PROFILE_PERSONAS.map((persona) => [persona.id, persona]));

export function isProfilePersonaId(value: unknown): value is ProfilePersonaId {
  return typeof value === 'string' && PERSONA_BY_ID.has(value as ProfilePersonaId);
}

export function resolveProfilePersona(value: unknown): ProfilePersona {
  return (isProfilePersonaId(value) ? PERSONA_BY_ID.get(value) : null)
    ?? PERSONA_BY_ID.get('other')!;
}
