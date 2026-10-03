/**
 * Contextual help for every Navigator menu: what it is for, the same thing from a terminal, and the
 * offline guide that explains it.
 *
 * Shown on hover or keyboard focus, never on its own, so the menu stays as short as it is. Each
 * guide is a served documentation topic (`singularity-flow explain <topic>`), and each command is a
 * top-level CLI command, so nothing here can name a route that does not exist. Pure data.
 */

export interface NavigatorHelp {
  /** One sentence: what this menu or action is for. */
  readonly summary: string;
  /** The terminal equivalent, a top-level command, when there is one. */
  readonly cli?: string;
  /** The served documentation topic that explains it. */
  readonly topic: string;
}

export const SECTION_HELP: Readonly<Record<string, NavigatorHelp>> = Object.freeze({
  favorites: { summary: 'The menus you pinned, in your order. Personal to this VS Code installation and never shared.', topic: 'copilot-and-surfaces' },
  inbox: { summary: 'Everything waiting on you: submitted phases to approve, capability changes and visual evidence to review.', cli: 'singularity-flow inbox', topic: 'inbox-and-review' },
  lifecycle: { summary: 'The governed work in this workspace: where it is, what it waits on, and how to start more.', cli: 'singularity-flow status', topic: 'story-lifecycle' },
  workspaces: { summary: 'Which governed repository this window works on, and how to map a capability or create a workspace.', cli: 'singularity-flow workspace', topic: 'workspaces-and-sessions' },
  configuration: { summary: 'The governed configuration on the capability’s configuration branch: workflows, agents and policies.', cli: 'singularity-flow configuration', topic: 'configuration' },
  help: { summary: 'Guides, the command reference, health checks and safe recovery when something is wrong.', cli: 'singularity-flow doctor', topic: 'help-and-docs' },
  logs: { summary: 'One timeline of activity, prompts, Copilot usage and workspace operations.', cli: 'singularity-flow logs', topic: 'activity-and-prompt-audit' }
});

export const LINK_HELP: Readonly<Record<string, NavigatorHelp>> = Object.freeze({
  'my-work': { summary: 'Your current work and the next action for each item.', cli: 'singularity-flow home', topic: 'developer-home' },
  'favorites-manage': { summary: 'Choose which menus are pinned at the top of the Navigator.', topic: 'copilot-and-surfaces' },
  'persona-manage': { summary: 'Tailor menu order and suggestions to how you work.', topic: 'copilot-and-surfaces' },
  'workspace-switch': { summary: 'Change the governed repository this window works on.', cli: 'singularity-flow workspace', topic: 'workspaces-and-sessions' },
  'work-start': { summary: 'Begin governed work: an Initiative, an Epic or a Story, tracked or not.', cli: 'singularity-flow start', topic: 'starting-work' },
  'adhoc-work': { summary: 'Land bounded work that started locally, without a Story.', cli: 'singularity-flow adhoc', topic: 'ad-hoc-work' },
  'inbox-open': { summary: 'Open everything waiting on you in one place.', cli: 'singularity-flow inbox', topic: 'inbox-and-review' },
  'approvals-open': { summary: 'Review and decide submitted phases with their evidence.', cli: 'singularity-flow approvals', topic: 'approvals' },
  'capability-proposals': { summary: 'Review proposed changes to a capability before they are published.', cli: 'singularity-flow capability', topic: 'capability-management' },
  'visual-assurance': { summary: 'Compare design and screenshot evidence for visual acceptance.', cli: 'singularity-flow visual', topic: 'visual-verification' },
  'capability-map': { summary: 'Record who owns a capability and which repositories it spans.', cli: 'singularity-flow capability', topic: 'capability-management' },
  'workspace-create': { summary: 'Create a workspace that points at a governed repository.', cli: 'singularity-flow workspace', topic: 'workspaces-and-sessions' },
  'setup-wizard': { summary: 'A guided path from capability to workspace to first governed work item.', cli: 'singularity-flow quickstart', topic: 'getting-started' },
  'workspace-manage': { summary: 'Choose, open, archive and repair workspaces on this machine.', cli: 'singularity-flow workspace', topic: 'workspaces-and-sessions' },
  refresh: { summary: 'Read the governed repository again.', cli: 'singularity-flow status', topic: 'repository-state-and-snapshots' },
  'change-explorer': { summary: 'The current changes, why each was made, and what it touches.', cli: 'singularity-flow explain', topic: 'code-explanation' },
  'code-explanation': { summary: 'Why each changed hunk is there, line by line.', cli: 'singularity-flow explain', topic: 'code-explanation' },
  'comprehension-center': { summary: 'Exact change regions, their causes, unknowns and replay.', cli: 'singularity-flow comprehension', topic: 'code-explanation' },
  goals: { summary: 'Outcomes and the governed work linked to them.', cli: 'singularity-flow goal', topic: 'goals-and-outcomes' },
  'impact-form': { summary: 'Preview and explain a proposed change before it starts.', cli: 'singularity-flow impact', topic: 'impact-framework' },
  'command-center': { summary: 'Governed execution processes, their steps and the requests they wait on.', cli: 'singularity-flow process', topic: 'sgos-governed-execution' },
  'configuration-center': { summary: 'Edit governed product configuration as a reviewed proposal.', cli: 'singularity-flow configuration', topic: 'configuration' },
  'ast-intelligence': { summary: 'Structural code policy, its assurance and its cache.', topic: 'ast-intelligence' },
  'flow-impact': { summary: 'Impact studies and reports for this capability.', cli: 'singularity-flow impact', topic: 'impact-framework' },
  'help-open': { summary: 'Offline guides, the command reference and the Copilot skills.', cli: 'singularity-flow help', topic: 'help-and-docs' },
  diagnostics: { summary: 'Check the repository, its branches, schemas and ledger are healthy.', cli: 'singularity-flow doctor', topic: 'diagnostics-and-regression' },
  'fault-repairs': { summary: 'Record a failure and recover from it safely.', cli: 'singularity-flow fault', topic: 'fault-intake-and-repair' },
  journal: { summary: 'Your private, machine-local work history. Never governance evidence.', cli: 'singularity-flow journal', topic: 'local-work-journal' },
  'activity-log': { summary: 'The governed activity recorded for this workspace.', cli: 'singularity-flow logs', topic: 'activity-and-prompt-audit' },
  'prompt-audit': { summary: 'Exactly what was sent to a model, and when.', cli: 'singularity-flow prompt-log', topic: 'activity-and-prompt-audit' },
  'local-reset': { summary: 'Preview and clean up machine-local Singularity Flow data.', cli: 'singularity-flow factory-reset', topic: 'resets-and-cleanup' },
  'logs-open': { summary: 'Open the combined workspace timeline.', cli: 'singularity-flow logs', topic: 'activity-and-prompt-audit' },
  'logs-refresh': { summary: 'Read the workspace timeline again.', cli: 'singularity-flow logs', topic: 'activity-and-prompt-audit' }
});

/** Every topic a help card may open, so the host never opens a topic a page asked for by name. */
export const HELP_TOPICS: ReadonlySet<string> = new Set([...Object.values(SECTION_HELP), ...Object.values(LINK_HELP)].map((entry) => entry.topic));

/** Every command a help card may copy. */
export const HELP_COMMANDS: ReadonlySet<string> = new Set([...Object.values(SECTION_HELP), ...Object.values(LINK_HELP)]
  .flatMap((entry) => [entry.cli, `singularity-flow explain ${entry.topic}`]).filter((value): value is string => Boolean(value)));
