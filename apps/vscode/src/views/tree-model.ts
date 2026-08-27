/**
 * The lifecycle tree, as data.
 *
 * Kept free of any `vscode` import so it can be tested in a plain Node process — the shape of this
 * tree is the extension's main claim about what the lifecycle *is*, and that claim deserves tests
 * that do not need an editor to run. views/lifecycle.ts turns these nodes into TreeItems and owns
 * everything editor-specific.
 *
 * The hierarchy follows the PDLC rather than the file system: Initiative → phase → pack → artifact,
 * with Stories grouped by the repository they land in. Packs are shown alongside phases rather than
 * inside one, because a pack deliberately spans phases — Validation & Release Readiness covers both
 * construction and delivery — and nesting it under a single phase would misrepresent what is being
 * reviewed.
 */
import {
  packsWithMembers, phasesInOrder, storiesByRepository,
  type BreakdownStory, type FastPathProjection, type InitiativeOutput, type InitiativeSnapshot,
  type RepositorySnapshot, type PhaseStatus, type StoryArtifact, type StoryPhase,
  type StoryWorkflow
} from '../cli/snapshot.ts';
import { commandArgv } from '../commands.ts';
import { buildCapabilityTree, type CapabilityReadiness } from './navigation-trees.ts';

export type NodeKind =
  | 'message' | 'initiative' | 'phase' | 'pack' | 'artifact'
  | 'group' | 'repository' | 'story' | 'action' | 'source';

export interface TreeNode {
  kind: NodeKind;
  id: string;
  label: string;
  /** Shown after the label, dimmed: status, counts, the reason something is blocked. */
  description?: string;
  tooltip?: string;
  /** A codicon id, chosen by state rather than by kind wherever state is what matters. */
  icon?: string;
  children?: TreeNode[];
  /** Set for artifacts the editor can open. Repository-relative unless `packagePath` is present. */
  path?: string;
  /** Read-only path beneath the CLI package root for agents and skills shipped with the engine. */
  packagePath?: string;
  /**
   * An absolute folder this node opens into. Distinct from `path`, which is an artifact inside the
   * repository — a workspace opens into its lead repository, which is somewhere else entirely.
   */
  openPath?: string;
  /**
   * A command this node runs when clicked. For rows that exist to be acted on rather than read —
   * an empty state offering the way out of itself.
   */
  runCommand?: string;
  /** True when opening this artifact should be read-only. */
  readOnly?: boolean;
  /** A CLI invocation this node offers, already split into argv. */
  command?: string[];
  /**
   * Set when the CLI will demand an exact confirmation string for this command. Carried so the
   * editor can ask a human to type it — never so the extension can supply it silently.
   */
  confirmation?: { expected: string; summary: string };
  /**
   * An approval, which goes through a selection receipt rather than plain flags: a receipt binds to
   * HEAD and to the exact artifact hashes, and it is also where `initiative approve`'s governed-agent
   * answer lives, since that path has no --agent.
   */
  approve?:
    | { kind: 'initiative'; initiativeId: string; subject: string; expected: string; summary: string }
    | {
      kind: 'story'; workId: string; phaseId: string; expected: string; summary: string;
      selfApproval?: boolean;
    };
  contextValue?: string;
  evidence?: {
    ownerKind: 'story' | 'epic'; ownerId: string; evidenceId: string;
    packageId?: string; status: 'active' | 'detached';
  };
}

const PHASE_ICON: Record<string, string> = {
  approved: 'statusSuccess',
  awaiting_approval: 'statusWaiting',
  in_progress: 'statusCurrent',
  rejected: 'statusBlocked',
  // Stale has its own glyph in both renderers and was being sent the plain warning one, so a phase
  // whose upstream artifact changed looked like any other warning. The description already drew the
  // distinction; the icon now does too.
  stale: 'statusStale',
  not_started: 'statusIdle'
};

const PHASE_DESCRIPTION: Record<string, string> = {
  approved: 'approved',
  awaiting_approval: 'awaiting approval',
  in_progress: 'in progress',
  rejected: 'rejected',
  stale: 'stale — an upstream artifact changed',
  not_started: 'not started'
};

/**
 * Render a status the engine owns, without ever rendering nothing.
 *
 * A status this file has not seen becomes a readable label rather than a blank: the engine may add
 * one, and a phase with no icon and no description reads as a phase with nothing happening in it.
 */
const phaseIcon = (status: PhaseStatus): string => PHASE_ICON[status] ?? 'statusIdle';
const phaseDescription = (status: PhaseStatus): string =>
  PHASE_DESCRIPTION[status] ?? String(status).replace(/_/g, ' ');

/**
 * The phase a pack's approval is attributed to: the latest phase any member sits in.
 *
 * Mirrors packTerminalPhase in initiative-evidence.mjs. It has to be the *terminal* phase, not the
 * first: Validation & Release Readiness spans construction and delivery, and attributing it to
 * construction would ask for the approval a phase too early and produce a confirmation string the
 * CLI would reject.
 */
function packTerminalPhase(phaseOrder: string[], members: Array<{ phase: string }>): string | null {
  let terminal: string | null = null;
  let latest = -1;
  for (const member of members) {
    const position = phaseOrder.indexOf(member.phase);
    if (position > latest) { latest = position; terminal = member.phase; }
  }
  return terminal;
}

function artifactNode(output: InitiativeOutput, phaseId: string, initiativeId: string): TreeNode {
  const pinned = output.status === 'approved' && Boolean(output.sha256);
  const icon = output.status === 'approved' ? 'statusSuccess' : 'artifact';
  return {
    kind: 'artifact',
    id: `artifact:${phaseId}/${output.id}`,
    label: output.label ?? output.id,
    description: output.sha256 ? output.status : (output.required ? 'not generated' : 'optional, not generated'),
    tooltip: output.sha256
      ? `${output.path}\nsha256 ${output.sha256}`
      : `${output.path}\nNot generated yet.`,
    icon,
    path: output.path,
    readOnly: pinned,
    // Only an artifact that exists and is not already approved can be approved. Offering the action
    // on an unwritten artifact would produce a refusal the reviewer could have been spared.
    ...(output.sha256 && output.status !== 'approved' ? {
      approve: {
        kind: 'initiative',
        initiativeId,
        subject: output.id,
        expected: `${phaseId}:${output.id}`,
        summary: `Approve ${output.label ?? output.id}`
      }
    } : {}),
    contextValue: pinned
      ? 'sflow.artifact.pinned'
      : output.sha256 ? 'sflow.artifact.approvable' : 'sflow.artifact'
  };
}

function phaseNode(phase: ReturnType<typeof phasesInOrder>[number], initiativeId: string): TreeNode {
  const authored = phase.outputs.filter((output) => output.sha256).length;
  const required = phase.outputs.filter((output) => output.required).length;
  return {
    kind: 'phase',
    id: `phase:${phase.id}`,
    label: phase.label,
    description: phase.current
      ? `${phaseDescription(phase.status)} · current`
      : phaseDescription(phase.status),
    tooltip: `${authored} of ${phase.outputs.length} artifacts generated, ${required} required.`,
    icon: phaseIcon(phase.status),
    contextValue: phase.current ? 'sflow.phase.current' : 'sflow.phase',
    children: phase.outputs
      .slice()
      .sort((left, right) => (left.label ?? left.id).localeCompare(right.label ?? right.id))
      .map((output) => artifactNode(output, phase.id, initiativeId))
  };
}

function storyNode(story: BreakdownStory): TreeNode {
  const dependencies = story.dependsOn.map((dependency) => dependency.story);
  return {
    kind: 'story',
    id: `story:${story.id}`,
    label: story.workId || story.id,
    description: story.blocking ? story.title : `${story.title} · non-blocking`,
    tooltip: dependencies.length
      ? `${story.title}\nDepends on ${dependencies.join(', ')}`
      : story.title,
    icon: 'story',
    contextValue: 'sflow.story'
  };
}

/**
 * The tree to show when the extension cannot serve this workspace at all.
 *
 * A contributed view with no registered provider makes VS Code say "There is no data provider
 * registered that can provide view data", which tells the reader nothing about their repository.
 * Returning early from activation and leaving the view unprovided is what produced that, so every
 * such path now registers a provider that says what is wrong and what would fix it.
 */
export function unavailableTree(
  label: string,
  detail: string,
  contextValue?: string,
  /** A lead repository to offer, when this folder turns out to be a workspace directory. */
  leadRepository?: string | null
): TreeNode[] {
  const repositoryUnavailable = contextValue === 'sflow.workspace.repositoryUnavailable';
  const nothingSelected = label === 'No workspace is active';
  return [{
    kind: 'action',
    id: 'unavailable',
    label: nothingSelected ? 'Choose a workspace to begin' : label,
    description: repositoryUnavailable ? 'repository required' : 'intake and delivery',
    tooltip: detail,
    icon: repositoryUnavailable ? 'statusWarning' : 'workspace',
    runCommand: repositoryUnavailable ? 'singularityFlow.repairWorkspace' : 'singularityFlow.openWorkspaces',
    ...(contextValue ? { contextValue } : {}),
    // Lifecycle deliberately remains an intake surface rather than repeating workspace setup as a
    // nested mini-wizard. The single row is both the explanation and the recovery action.
  }];
}

/**
 * Build the whole tree from one snapshot.
 *
 * Every empty case returns a node that says what is missing and what would fix it, rather than an
 * empty branch. An empty tree in a governance tool reads as "nothing to do", which is the single
 * most expensive thing it could wrongly say.
 */
/**
 * What a view shows when the repository will not load at all.
 *
 * This is the state a person is most stuck in and it used to be the least helpful thing on screen:
 * one row, the engine's sentence, and no way forward. The sentence names a file and usually a line
 * of it, so the file is offered — reading the message and then hunting for `singularity/` in the
 * explorer is a step the tree can simply take.
 */
function configurationFailure(error: Error, view: 'lifecycle' | 'configuration'): TreeNode[] {
  // The engine names the file it refused, when it knows: "portfolio.yml", "workflow.yml",
  // "capabilities.yml". Anything else and there is nothing honest to offer.
  const named = /\b(portfolio|workflow|capabilities)\.yml\b/.exec(error.message)?.[1]
    ?? (/\b(checklist|initiative profile|phase|applicability|approval authority)\b/i.test(error.message)
      ? 'portfolio'
      : /\bwork type\b/i.test(error.message) ? 'workflow' : null);

  const workflowVersionUnsupported = /workflow\.yml version must be 2|Version 1 is not supported/i
    .test(error.message);

  return [{
    kind: 'message',
    id: view === 'lifecycle' ? 'error' : 'configuration:error',
    label: error.message,
    icon: 'error',
    tooltip: view === 'configuration'
      ? 'Singularity Flow refused to use this configuration. Its files remain visible below so it can be repaired.'
      : 'Singularity Flow refused to run this lifecycle until the configuration is repaired.'
  }, ...(named ? [{
    kind: 'artifact' as const,
    id: `${view}:error:open`,
    label: `Open singularity/${named}.yml`,
    description: 'fix it here',
    icon: 'go-to-file',
    path: `singularity/${named}.yml`,
    contextValue: 'sflow.config'
  }] : []), ...(workflowVersionUnsupported ? [{
    kind: 'action' as const,
    id: `${view}:error:reinitialize`,
    label: 'Reset and reinitialize workflow v2',
    description: 'no migration',
    tooltip: 'Preview the repository-scoped reset, type its exact confirmation, and install the packaged workflow v2 configuration.',
    icon: 'debug-restart',
    runCommand: 'singularityFlow.reinitialize'
  }] : []), {
    kind: 'action',
    id: `${view}:error:doctor`,
    label: 'Run diagnostics',
    description: 'doctor',
    tooltip: 'The full report, including everything else that is wrong.',
    icon: 'pulse',
    runCommand: 'singularityFlow.doctor'
  }];
}

export function buildLifecycleTree(snapshot: RepositorySnapshot | null, error: Error | null = null): TreeNode[] {
  if (error) return configurationFailure(error, 'lifecycle');
  if (!snapshot) {
    return [{ kind: 'message', id: 'loading', label: 'Reading the repository…', icon: 'loading~spin' }];
  }

  const workspaceImpact: TreeNode = {
    kind: 'action', id: 'workspace:impact', label: 'Explore workspace impact',
    description: 'advisory · no Work ID', icon: 'impact',
    tooltip: 'Ask Copilot to assess a proposed change across the selected workspace without creating lifecycle state or a branch.',
    runCommand: 'singularityFlow.openImpact', contextValue: 'sflow.workspace.impact'
  };
  if (snapshot.workflow) {
    const activeStories = activeStoryArchive(snapshot, snapshot.workflow.workItem.id);
    const completedArchive = completedStoryArchive(snapshot, snapshot.workflow.workItem.id);
    const cancelledArchive = cancelledStoryArchive(snapshot, snapshot.workflow.workItem.id);
    if (snapshot.workflow.status === 'cancelled') {
      return [archivedFolder([cancelledStoryNode(snapshot.workflow, snapshot.documents ?? [])]),
        ...(activeStories ? [activeStories] : []), ...(completedArchive ? [completedArchive] : []), workspaceImpact];
    }
    if (snapshot.workflow.status === 'complete') {
      const completed = completedStoryNode(snapshot.workflow, snapshot.documents ?? []);
      const siblings = completedStorySummaries(snapshot, snapshot.workflow.workItem.id);
      return [completedFolder([completed, ...siblings], countArtifacts(completed)),
        ...(activeStories ? [activeStories] : []), ...(cancelledArchive ? [cancelledArchive] : []), workspaceImpact];
    }
    return [storyWorkflowNode(
      snapshot.workflow,
      snapshot.documents ?? [],
      snapshot.detachedDocuments ?? [],
      snapshot.fastPath ?? null,
      identityOf(snapshot.identities?.git)
    ),
      ...(activeStories ? [activeStories] : []), ...(completedArchive ? [completedArchive] : []),
      ...(cancelledArchive ? [cancelledArchive] : []), workspaceImpact];
  }

  const initiative = snapshot.initiative;
  if (!initiative) {
    const available = (snapshot.initiatives?.length ?? 0) + (snapshot.workItems?.length ?? 0);
    const active = activeStoryArchive(snapshot);
    const archived = completedStoryArchive(snapshot);
    const cancelled = cancelledStoryArchive(snapshot);
    return [{
      kind: 'message',
      id: 'no-initiative',
      label: available
        ? 'Nothing is checked out on this branch'
        : 'No work has been started in this repository',
      description: available ? `${available} available` : undefined,
      icon: 'info',
      tooltip: available
        ? 'Check out a governed branch, or start something new.'
        : 'An Initiative, an Epic or a Story — with or without a tracker.',
      contextValue: 'sflow.lifecycle.empty'
    }, {
      kind: 'action',
      id: 'start-intake',
      label: 'Start intake',
      description: 'choose work and workflow',
      tooltip: 'Choose Initiative, Epic or Story intake, then select the configured workflow that '
        + 'will govern its phases.',
      icon: 'play-circle',
      runCommand: 'singularityFlow.startWork',
      contextValue: 'sflow.start'
    }, ...(active ? [active] : []), ...(archived ? [archived] : []), ...(cancelled ? [cancelled] : []), workspaceImpact];
  }

  // Workflow selection belongs to intake. Once work exists, Lifecycle shows only that work and its
  // phases; showing every other configured workflow beside it made Configuration and Lifecycle look
  // like duplicate workflow browsers.
  if (initiative.state.status === 'complete') {
    const completed = completedInitiativeNode(initiative);
    const stories = completedStorySummaries(snapshot);
    return [completedFolder([completed, ...stories], countArtifacts(completed)), workspaceImpact];
  }
  const archived = completedStoryArchive(snapshot);
  return [initiativeNode(initiative), ...(archived ? [archived] : []), workspaceImpact];
}

/** Active sibling Stories stay selectable even though only one checkout can supply full artifacts. */
function activeStorySummaries(snapshot: RepositorySnapshot, excludeId?: string): TreeNode[] {
  return (snapshot.workItems ?? [])
    .filter((item) => item.id !== excludeId
      && !['complete', 'completed', 'cancelled', 'invalid'].includes(String(item.status)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      kind: 'story' as const,
      id: `active-story-summary:${item.id}`,
      label: item.id,
      description: [item.currentPhase, item.status]
        .filter(Boolean).map((value) => String(value).replaceAll('_', ' ')).join(' · ')
        || item.title || 'Active Story',
      tooltip: `${item.title ?? item.id}\nSelect to synchronize and open its governed checkout.`,
      icon: 'statusCurrent',
      command: ['session', 'attach', item.id],
      runCommand: 'singularityFlow.runAction',
      contextValue: 'sflow.story.active.summary'
    }));
}

function activeStoryArchive(snapshot: RepositorySnapshot, excludeId?: string): TreeNode | null {
  const stories = activeStorySummaries(snapshot, excludeId);
  return stories.length ? {
    kind: 'group', id: 'active-stories', label: 'Active Stories',
    description: `${stories.length} ${stories.length === 1 ? 'Story' : 'Stories'}`,
    tooltip: 'Active governed work in sibling branches. Select a Story to open its isolated checkout.',
    icon: 'list-tree', contextValue: 'sflow.activeStories', children: stories
  } : null;
}

/** Count unique, openable artifact paths beneath one completed subject. */
function countArtifacts(node: TreeNode): number {
  const paths = new Set<string>();
  const visit = (current: TreeNode): void => {
    if (current.kind === 'artifact' && current.path) paths.add(current.path);
    for (const child of current.children ?? []) visit(child);
  };
  visit(node);
  return paths.size;
}

/**
 * Completion changes where work is presented, not where governed state is stored.
 *
 * Git paths stay immutable for lineage and resume. `Completed` is therefore a presentation folder:
 * it removes terminal work from the active rail while preserving direct access to its evidence.
 */
function completedFolder(subjects: TreeNode[], artifactCount: number): TreeNode {
  const workCount = subjects.length;
  return {
    kind: 'group',
    id: 'completed',
    label: 'Completed',
    description: artifactCount
      ? `${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'}`
      : `${workCount} ${workCount === 1 ? 'item' : 'items'}`,
    tooltip: 'Finished work is archived here. Expand it to browse every generated artifact.',
    icon: 'pack',
    contextValue: 'sflow.completed',
    children: subjects
  };
}

/** Completed sibling Stories are catalogued from Git refs even when another Story is checked out. */
function completedStorySummaries(snapshot: RepositorySnapshot, excludeId?: string): TreeNode[] {
  return (snapshot.workItems ?? [])
    .filter((item) => item.id !== excludeId && ['complete', 'completed'].includes(String(item.status)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      kind: 'story' as const,
      id: `completed-story-summary:${item.id}`,
      label: item.id,
      description: item.title ?? 'Completed Story',
      tooltip: `Completed on ${item.branch ?? item.id}. Select it to synchronize that governed branch and browse its artifacts.`,
      icon: 'statusSuccess',
      command: ['session', 'attach', item.id],
      runCommand: 'singularityFlow.runAction',
      contextValue: 'sflow.story.completed.summary'
    }));
}

function completedStoryArchive(snapshot: RepositorySnapshot, excludeId?: string): TreeNode | null {
  const stories = completedStorySummaries(snapshot, excludeId);
  return stories.length ? completedFolder(stories, 0) : null;
}

function archivedFolder(subjects: TreeNode[]): TreeNode {
  return {
    kind: 'group', id: 'archived', label: 'Archived',
    description: `${subjects.length} ${subjects.length === 1 ? 'cancelled item' : 'cancelled items'}`,
    tooltip: 'Cancelled work is retained here with its artifacts, approvals, reason, actor, and Git history.',
    icon: 'archive', contextValue: 'sflow.archived', children: subjects
  };
}

function cancelledStorySummaries(snapshot: RepositorySnapshot, excludeId?: string): TreeNode[] {
  return (snapshot.workItems ?? [])
    .filter((item) => item.id !== excludeId && item.status === 'cancelled')
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      kind: 'story' as const, id: `archived-story-summary:${item.id}`, label: item.id,
      description: item.title ?? 'Cancelled Story',
      tooltip: `Cancelled on ${item.branch ?? item.id}. Select it to synchronize that governed branch and browse its preserved artifacts.`,
      icon: 'archive', command: ['session', 'attach', item.id], runCommand: 'singularityFlow.runAction',
      contextValue: 'sflow.story.archived.summary'
    }));
}

function cancelledStoryArchive(snapshot: RepositorySnapshot, excludeId?: string): TreeNode | null {
  const stories = cancelledStorySummaries(snapshot, excludeId);
  return stories.length ? archivedFolder(stories) : null;
}

function storyArtifactGroups(
  workflow: StoryWorkflow,
  documents: StoryArtifact[],
  archiveKind: 'completed' | 'archived' = 'completed'
): TreeNode[] {
  const unique = new Map<string, StoryArtifact>();
  for (const document of documents) {
    if (document.path) unique.set(document.path, document);
  }
  const phaseOrder = [...workflow.phaseOrder, 'documents'];
  const phaseLabels = new Map(workflow.phaseOrder.map((phaseId) =>
    [phaseId, workflow.phases[phaseId]?.label ?? phaseId] as const));
  phaseLabels.set('documents', 'Other documents');

  const grouped = new Map<string, StoryArtifact[]>();
  for (const document of unique.values()) {
    const phaseId = document.phase && workflow.phases[document.phase] ? document.phase : 'documents';
    grouped.set(phaseId, [...(grouped.get(phaseId) ?? []), document]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => phaseOrder.indexOf(left) - phaseOrder.indexOf(right))
    .map(([phaseId, artifacts]) => ({
      kind: 'group' as const,
      id: `${archiveKind}-story-phase:${phaseId}`,
      label: phaseLabels.get(phaseId) ?? phaseId,
      description: String(artifacts.length),
      icon: 'phase',
      children: artifacts
        .sort((left, right) => (left.label ?? left.id ?? left.path)
          .localeCompare(right.label ?? right.id ?? right.path))
        .map((document) => ({
          kind: 'artifact' as const,
          id: `${archiveKind}-story-artifact:${phaseId}:${document.id ?? document.path}`,
          label: document.label ?? document.id ?? document.path,
          description: document.status?.replace(/_/g, ' ') ?? 'generated',
          tooltip: `${document.path}\nsha256 ${document.sha256 ?? 'unavailable'}`,
          icon: document.status === 'approved' ? 'statusSuccess' : 'artifact',
          path: document.path,
          readOnly: archiveKind === 'archived' || document.status === 'approved',
          contextValue: document.status === 'approved' ? 'sflow.artifact.pinned' : 'sflow.artifact'
        }))
    }));
}

function completedStoryNode(workflow: StoryWorkflow, documents: StoryArtifact[]): TreeNode {
  const artifacts = storyArtifactGroups(workflow, documents);
  const count = artifacts.reduce((total, group) => total + (group.children?.length ?? 0), 0);
  return {
    kind: 'story',
    id: `completed-story:${workflow.workItem.id}`,
    label: workflow.workItem.id,
    description: `${workflow.workItem.title ?? workflow.workItem.workType ?? 'Story'} · ${count} ${count === 1 ? 'artifact' : 'artifacts'}`,
    tooltip: `Completed ${workflow.workItem.workType ?? 'Story'} workflow\nBranch ${workflow.workItem.branch ?? 'unknown'}`,
    icon: 'statusSuccess',
    contextValue: 'sflow.story.completed',
    children: [{
      kind: 'action', id: 'completed-story:reopen', label: 'Request post-completion changes',
      description: 'choose phase · record comment · reopen', icon: 'git-pull-request-go-to-changes',
      runCommand: 'singularityFlow.reopenCompleted', contextValue: 'sflow.story.reopen'
    }, {
      kind: 'action', id: 'completed-story:open', label: 'Open complete artifact catalog',
      description: 'documents · approvals · provenance', icon: 'inbox',
      runCommand: 'singularityFlow.openInbox', contextValue: 'sflow.completed.open'
    }, {
      kind: 'action', id: 'completed-story:analytics', label: 'Open lifecycle analytics',
      description: 'phases · time · tokens · cost', icon: 'impact',
      runCommand: 'singularityFlow.openDashboard', contextValue: 'sflow.story.analytics'
    }, {
      kind: 'action', id: 'completed-story:flow-impact', label: 'Open Flow Impact measurement',
      description: 'receipt · evidence · study report', icon: 'impact',
      runCommand: 'singularityFlow.openFlowImpact', contextValue: 'sflow.story.impact'
    }, {
      kind: 'group', id: 'completed-story:artifacts', label: 'All generated artifacts',
      description: String(count), icon: 'pack',
      children: artifacts.length ? artifacts : [{
        kind: 'message', id: 'completed-story:artifacts-empty', label: 'No generated artifacts were recorded',
        icon: 'info'
      }]
    }]
  };
}

function cancelledStoryNode(workflow: StoryWorkflow, documents: StoryArtifact[]): TreeNode {
  const artifacts = storyArtifactGroups(workflow, documents, 'archived');
  const count = artifacts.reduce((total, group) => total + (group.children?.length ?? 0), 0);
  const actor = workflow.cancellation?.cancelledBy;
  const actorLabel = actor?.name ?? actor?.email ?? actor?.login ?? 'unknown actor';
  return {
    kind: 'story', id: `archived-story:${workflow.workItem.id}`, label: workflow.workItem.id,
    description: `${workflow.workItem.title ?? workflow.workItem.workType ?? 'Story'} · cancelled`,
    tooltip: `Cancelled during ${workflow.cancellation?.phase ?? 'unknown phase'} by ${actorLabel}\n${workflow.cancellation?.reason ?? 'No reason recorded'}`,
    icon: 'archive', contextValue: 'sflow.story.archived',
    children: [{
      kind: 'message', id: 'archived-story:reason', label: 'Cancellation reason',
      description: workflow.cancellation?.reason ?? 'Not recorded', icon: 'comment-discussion',
      tooltip: `${actorLabel} · ${workflow.cancellation?.cancelledAt ?? 'time unavailable'}`
    }, {
      kind: 'action', id: 'archived-story:open', label: 'Open preserved artifact catalog',
      description: `${count} ${count === 1 ? 'artifact' : 'artifacts'}`, icon: 'inbox',
      runCommand: 'singularityFlow.openInbox', contextValue: 'sflow.archived.open'
    }, {
      kind: 'action', id: 'archived-story:analytics', label: 'Open lifecycle analytics',
      description: 'phases · time · tokens · cost', icon: 'impact',
      runCommand: 'singularityFlow.openDashboard', contextValue: 'sflow.story.analytics'
    }, {
      kind: 'action', id: 'archived-story:flow-impact', label: 'Open Flow Impact measurement',
      description: 'enrollment · evidence · retained receipt', icon: 'impact',
      runCommand: 'singularityFlow.openFlowImpact', contextValue: 'sflow.story.impact'
    }, {
      kind: 'group', id: 'archived-story:artifacts', label: 'Preserved generated artifacts',
      description: String(count), icon: 'pack', children: artifacts.length ? artifacts : [{
        kind: 'message', id: 'archived-story:artifacts-empty', label: 'No generated artifacts were recorded', icon: 'info'
      }]
    }]
  };
}

function completedInitiativeNode(initiative: InitiativeSnapshot): TreeNode {
  const { state } = initiative;
  const phaseLabels = new Map(state.resolution.phases.map((phase) => [phase.id, phase.label] as const));
  const phaseOrder = state.phaseOrder;
  const unique = new Map<string, InitiativeOutput>();
  for (const output of initiative.documents ?? []) {
    const repositoryPath = output.repositoryPath ?? output.path;
    if (repositoryPath && output.sha256) unique.set(repositoryPath, output);
  }
  const grouped = new Map<string, InitiativeOutput[]>();
  for (const output of unique.values()) {
    const phaseId = output.phase ?? 'documents';
    grouped.set(phaseId, [...(grouped.get(phaseId) ?? []), output]);
  }
  const artifacts: TreeNode[] = [...grouped.entries()]
    .sort(([left], [right]) => {
      const leftIndex = phaseOrder.indexOf(left); const rightIndex = phaseOrder.indexOf(right);
      return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
        - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
    })
    .map(([phaseId, outputs]) => ({
      kind: 'group' as const,
      id: `completed-initiative-phase:${phaseId}`,
      label: phaseLabels.get(phaseId) ?? (phaseId === 'documents' ? 'Other documents' : phaseId),
      description: String(outputs.length),
      icon: 'phase',
      children: outputs
        .sort((left, right) => (left.label ?? left.id).localeCompare(right.label ?? right.id))
        .map((output) => ({
          kind: 'artifact' as const,
          id: `completed-initiative-artifact:${phaseId}/${output.id}`,
          label: output.label ?? output.id,
          description: output.status.replace(/_/g, ' '),
          tooltip: `${output.repositoryPath ?? output.path}\nsha256 ${output.sha256 ?? 'unavailable'}`,
          icon: output.status === 'approved' ? 'statusSuccess' : 'artifact',
          path: output.repositoryPath ?? output.path,
          readOnly: output.status === 'approved',
          contextValue: output.status === 'approved' ? 'sflow.artifact.pinned' : 'sflow.artifact'
        }))
    }));
  const count = artifacts.reduce((total, group) => total + (group.children?.length ?? 0), 0);
  return {
    kind: 'initiative',
    id: `completed-initiative:${state.initiative.id}`,
    label: state.initiative.id,
    description: `${state.initiative.title ?? state.resolution.profile} · ${count} ${count === 1 ? 'artifact' : 'artifacts'}`,
    tooltip: `Completed ${state.resolution.profile}\nBranch ${state.initiative.branch ?? 'unknown'}`,
    icon: 'statusSuccess',
    contextValue: 'sflow.initiative.completed',
    children: [{
      kind: 'action', id: 'completed-initiative:open', label: 'Open complete artifact catalog',
      description: 'documents · approvals · provenance', icon: 'inbox',
      runCommand: 'singularityFlow.openInbox', contextValue: 'sflow.completed.open'
    }, {
      kind: 'group', id: 'completed-initiative:artifacts', label: 'All generated artifacts',
      description: String(count), icon: 'pack',
      children: artifacts.length ? artifacts : [{
        kind: 'message', id: 'completed-initiative:artifacts-empty', label: 'No generated artifacts were recorded',
        icon: 'info'
      }]
    }]
  };
}

function storyDocumentNodes(documents: StoryArtifact[], phaseId: string): TreeNode[] {
  return documents
    // Current snapshots identify generated outputs explicitly. Keep accepting the earlier
    // phase-scoped shape as well so a coherent lifecycle rail survives while the extension and
    // CLI are upgraded independently.
    .filter((document) => (document.type === 'artifact' || (!document.type && Boolean(document.phase)))
      && document.phase === phaseId && Boolean(document.path))
    .sort((left, right) => (left.label ?? left.path).localeCompare(right.label ?? right.path))
    .map((document) => ({
      kind: 'artifact' as const,
      id: `story-document:${phaseId}:${document.id ?? document.path}`,
      label: document.label ?? document.id ?? document.path,
      description: document.status?.replace(/_/g, ' ') ?? 'generated',
      tooltip: `${document.path}\nsha256 ${document.sha256 ?? 'unavailable'}`,
      icon: document.status === 'approved' ? 'lock-small' : 'file',
      path: document.path,
      readOnly: document.status === 'approved',
      contextValue: document.status === 'approved' ? 'sflow.artifact.pinned' : 'sflow.artifact'
    }));
}

function storyGeneratedArtifacts(workflow: StoryWorkflow, documents: StoryArtifact[]): TreeNode {
  const phases = workflow.phaseOrder.map((id) => workflow.phases[id])
    .filter((phase): phase is StoryPhase => Boolean(phase));
  const groups = phases.map((phase) => ({
    phase,
    artifacts: storyDocumentNodes(documents, phase.id)
  })).filter((entry) => entry.artifacts.length);
  const count = groups.reduce((total, entry) => total + entry.artifacts.length, 0);
  return {
    kind: 'group', id: `story:${workflow.workItem.id}:generated-artifacts`,
    label: 'Generated artifacts', description: String(count), icon: 'files',
    tooltip: `Governed outputs generated for ${workflow.workItem.id}, grouped by lifecycle phase.`,
    contextValue: 'sflow.story.artifacts',
    children: groups.length ? groups.map(({ phase, artifacts }) => ({
      kind: 'group' as const, id: `story:${workflow.workItem.id}:artifacts:${phase.id}`,
      label: phase.label, description: String(artifacts.length), icon: 'directory', children: artifacts
    })) : [{
      kind: 'message', id: `story:${workflow.workItem.id}:artifacts:empty`,
      label: 'No generated artifacts yet', description: 'publish a phase first', icon: 'info'
    }]
  };
}

function storyEvidenceNode(workId: string, document: StoryArtifact, detached = false): TreeNode {
  const id = document.id ?? document.path;
  return {
    kind: 'source', id: `story-evidence:${workId}:${id}`,
    label: document.label ?? id,
    description: detached ? 'detached' : (document.mimeType ?? document.kind ?? 'evidence'),
    tooltip: detached
      ? `${document.detachReason ?? 'Detached'}${document.detachedAt ? `\n${document.detachedAt}` : ''}`
      : `${document.path ?? document.url ?? ''}\nsha256 ${document.sha256 ?? 'external reference'}`,
    icon: detached ? 'archive' : (document.mimeType?.startsWith('image/') ? 'visual' : 'references'),
    ...(document.path ? { path: document.path } : {}),
    readOnly: detached,
    contextValue: detached ? 'sflow.evidence.detached' : 'sflow.evidence.active',
    evidence: {
      ownerKind: 'story', ownerId: workId, evidenceId: document.id ?? id,
      packageId: document.packageId, status: detached ? 'detached' : 'active'
    }
  };
}

function storyEvidenceGroups(workId: string, active: StoryArtifact[], detached: StoryArtifact[]): TreeNode[] {
  const support = active.filter((document) => ['file', 'url'].includes(document.type ?? ''));
  const history = detached.filter((document) => ['file', 'url'].includes(document.type ?? ''));
  return [{
    kind: 'group', id: `story:${workId}:evidence`, label: 'Supporting evidence',
    description: support.length ? String(support.length) : 'none attached', icon: 'references',
    contextValue: 'sflow.evidence.group',
    children: [...support.map((document) => storyEvidenceNode(workId, document)), {
      kind: 'action', id: `story:${workId}:evidence:manage`, label: 'Manage evidence & designs',
      description: 'attach · preview · detach', icon: 'visual',
      runCommand: 'singularityFlow.manageEvidence', contextValue: 'sflow.evidence.manage'
    }]
  }, ...(history.length ? [{
    kind: 'group' as const, id: `story:${workId}:evidence:detached`, label: 'Detached evidence',
    description: String(history.length), icon: 'archive', contextValue: 'sflow.evidence.detached.group',
    children: history.map((document) => storyEvidenceNode(workId, document, true))
  }] : [])];
}

function identityOf(identity: string | { email?: string; login?: string | null; name?: string } | null | undefined): string {
  if (typeof identity === 'string') return identity.trim().toLowerCase();
  return (identity?.email ?? identity?.login ?? identity?.name ?? '').trim().toLowerCase();
}

function storyPhaseActions(workflow: StoryWorkflow, phase: StoryPhase, actor: string): TreeNode[] {
  if (workflow.currentPhase !== phase.id) return [];
  if (phase.status === 'awaiting_approval') {
    return [{
      kind: 'action', id: `story:${phase.id}:approve`, label: `Review and approve ${phase.label}`,
      description: 'exact generation', icon: 'verified',
      approve: {
        kind: 'story', workId: workflow.workItem.id, phaseId: phase.id, expected: phase.id,
        summary: `Approve ${workflow.workItem.id} / ${phase.label}`,
        selfApproval: Boolean(actor) && identityOf(phase.generatedBy) === actor
      },
      contextValue: 'sflow.story.approval'
    }];
  }
  if (phase.status !== 'in_progress' && phase.status !== 'rejected') return [];
  return [{
    kind: 'action', id: `story:${phase.id}:copilot`, label: 'Continue with Copilot CLI',
    description: 'governed context · local usage captured after consent', icon: 'sparkle', runCommand: 'singularityFlow.openMeteredCopilot'
  }, {
    kind: 'action', id: `story:${phase.id}:native-copilot`, label: 'Open Native Copilot Chat',
    description: 'usage unavailable · work can continue', icon: 'comment-discussion', runCommand: 'singularityFlow.openCopilot'
  }, {
    kind: 'action', id: `story:${phase.id}:prepare`, label: `Prepare ${phase.label}`,
    description: 'create phase workspace', icon: 'tools', command: ['prepare', phase.id],
    runCommand: 'singularityFlow.prepareStoryPhase', contextValue: 'sflow.story.prepare'
  }, {
    kind: 'action', id: `story:${phase.id}:publish`, label: 'Publish generated artifacts',
    description: `generation ${phase.generation + 1}`, icon: 'cloud-upload',
    command: ['phase', 'publish', phase.id], runCommand: 'singularityFlow.publishStoryPhase',
    contextValue: 'sflow.story.publish'
  }, ...(phase.generation > 0 ? [{
    kind: 'action' as const, id: `story:${phase.id}:submit`, label: 'Submit for approval',
    description: `generation ${phase.generation}`, icon: 'send',
    command: ['submit', '--phase', phase.id], runCommand: 'singularityFlow.submitStoryPhase',
    contextValue: 'sflow.story.submit'
  }] : [])];
}

/**
 * The five verbs as the primary rail. `[SPK:REQ-151]` `[SPK:REQ-150]`
 *
 * Rendered from `snapshot.fastPath`, which the engine planned with the same `planFastPath` call the
 * `sflow specify` family runs. Nothing is recomputed here — a rail that derived its own idea of
 * which milestone was reached would be a second opinion about the Story, and the two would
 * eventually disagree in front of a reader who has no way to tell which is right.
 *
 * Each verb expands into the phases it routes, so the rail is a lens over the lifecycle rather than
 * a replacement for it: the phase rail below still shows every phase, generation and artifact.
 *
 * Absent for a work type that declares no fast path, in which case this contributes nothing and the
 * tree is exactly what it was.
 */
function fastPathRailNode(fastPath: FastPathProjection | null | undefined, workflow: StoryWorkflow): TreeNode[] {
  if (!fastPath?.verbs?.length) return [];
  const reached = fastPath.verbs.filter((verb) => verb.reached).length;
  return [{
    kind: 'group', id: 'story:fast-path', label: 'Journey',
    description: `${reached}/${fastPath.verbs.length} milestones · ${fastPath.active ?? 'complete'}`,
    icon: 'list-ordered',
    tooltip: `The five verbs for ${fastPath.profile}. Each expands into the phases it routes.`,
    children: fastPath.verbs.map((verb) => {
      const here = fastPath.context === verb.verb;
      const phases = verb.phases
        .map((id) => workflow.phases?.[id])
        .filter((phase): phase is StoryPhase => Boolean(phase));
      /**
       * Actions belong to the verb you are standing in, and to no other.
       *
       * The planner answers "what would happen if I ran `sflow plan` right now?" for every verb, and
       * for a Story sitting in specification that answer is the same sentence five times: "use
       * specify for specification". Correct per verb, useless as a rail — four identical rows
       * telling a reader to go back where they already are. Only the current verb carries its
       * checkpoint action; the rest carry their phases, which is what a reader is scanning for.
       */
      const actions = here ? verb.next : [];
      return {
        kind: 'group' as const,
        id: `story-verb:${verb.verb}`,
        label: verb.verb,
        /**
         * A milestone counts only when workflow state proves it, so `reached` is the engine's word
         * and never "the command succeeded". `checkpoint.kind` is shown only where it means
         * something: on the active verb it names what the Story is waiting for, and everywhere else
         * it is planner vocabulary — `not-routed` says nothing to someone reading a rail.
         */
        description: verb.reached
          ? 'milestone reached'
          : here
            ? [verb.checkpoint?.kind ?? 'in progress', 'you are here'].join(' · ')
            : 'not started',
        /**
         * Reached gets a check, the verb you are standing in gets the play icon, and one not yet
         * started gets the empty ring.
         *
         * Raw Codicons (`pass`, `circle-outline`) pass through the table untouched and landed as
         * the unknown-icon glyph, so all five verbs looked identical — which is why these are
         * semantic names. `statusIdle` used to fall through too, and the rail shipped with no icon
         * at all on the unstarted verbs rather than a meaningless one. Now that the state
         * vocabulary resolves, the ring is better than the absence it stood in for: it holds the
         * column, so the eye reads down a row of rings to the one verb that is filled.
         */
        icon: verb.reached ? 'statusSuccess' : here ? 'start' : 'statusIdle',
        tooltip: [
          `Milestone: ${verb.milestone}`,
          here ? verb.checkpoint?.reason ?? null : null,
          here && verb.operations.length ? `Underlying operations: ${verb.operations.join(', ')}` : null
        ].filter(Boolean).join('\n'),
        contextValue: 'sflow.story.verb',
        children: [
          ...actions.map((action, index) => ({
            kind: 'message' as const,
            id: `story-verb:${verb.verb}:next:${index}`,
            label: action.label,
            description: action.command,
            tooltip: action.command,
            icon: 'play-circle'
          })),
          ...phases.map((phase) => ({
            kind: 'message' as const,
            id: `story-verb:${verb.verb}:phase:${phase.id}`,
            label: phase.label,
            description: [phaseDescription(phase.status), `generation ${phase.generation ?? 0}`]
              .filter(Boolean).join(' · '),
            icon: 'list-ordered'
          }))
        ]
      };
    })
  }];
}

function storyWorkflowNode(
  workflow: StoryWorkflow,
  documents: StoryArtifact[],
  detachedDocuments: StoryArtifact[],
  fastPath: FastPathProjection | null = null,
  actor = ''
): TreeNode {
  const phases = workflow.phaseOrder.map((id) => workflow.phases[id])
    .filter((phase): phase is StoryPhase => Boolean(phase));
  const approved = phases.filter((phase) => phase.status === 'approved').length;
  const openChangeRequests = (workflow.changeRequests ?? []).filter((request) => request.status === 'open');
  return {
    kind: 'story',
    id: `active-story:${workflow.workItem.id}`,
    label: workflow.workItem.id,
    description: workflow.workItem.title ?? workflow.workItem.workType ?? 'Story',
    tooltip: `${workflow.workItem.workType ?? 'Story'} workflow\nBranch ${workflow.workItem.branch ?? 'unknown'}`,
    icon: 'story',
    contextValue: 'sflow.story.active',
    children: [...fastPathRailNode(fastPath, workflow), {
      kind: 'action', id: 'story:continue-safely', label: 'Continue safely',
      description: 'review exact next action', icon: 'play-circle',
      runCommand: 'singularityFlow.continueSafely', contextValue: 'sflow.action.plan'
    }, {
      kind: 'action', id: 'story:progress-rail', label: 'Open progress & artifacts',
      description: 'phases · approvals · files', icon: 'list-ordered',
      runCommand: 'singularityFlow.openJourney', contextValue: 'sflow.story.progress'
    }, {
      kind: 'action', id: 'story:attach-evidence', label: 'Attach evidence & designs',
      description: 'files · Figma exports · HTTPS links', icon: 'visual',
      runCommand: 'singularityFlow.attachEvidence', contextValue: 'sflow.story.evidence'
    }, ...storyEvidenceGroups(workflow.workItem.id, documents, detachedDocuments), {
      kind: 'action', id: 'story:manage-evidence', label: 'Manage evidence & designs',
      description: 'list · preview · detach', icon: 'references',
      runCommand: 'singularityFlow.manageEvidence', contextValue: 'sflow.evidence.manage'
    }, storyGeneratedArtifacts(workflow, documents), {
      kind: 'action', id: 'story:cancel', label: 'Cancel and archive work',
      description: 'reason required · artifacts preserved', icon: 'archive',
      runCommand: 'singularityFlow.cancelWork', contextValue: 'sflow.story.cancel'
    }, {
      kind: 'action', id: 'story:analytics', label: 'Open lifecycle analytics',
      description: 'phases · time · tokens · cost', icon: 'impact',
      runCommand: 'singularityFlow.openDashboard', contextValue: 'sflow.story.analytics'
    }, {
      kind: 'action', id: 'story:flow-impact', label: 'Open Flow Impact measurement',
      description: 'classification · evidence · receipt', icon: 'impact',
      runCommand: 'singularityFlow.openFlowImpact', contextValue: 'sflow.story.impact'
    }, ...(openChangeRequests.length ? [{
      kind: 'group' as const, id: 'story:change-requests', label: 'Changes requested',
      description: `${openChangeRequests.length} open`, icon: 'prompt',
      children: openChangeRequests.map((request) => ({
        kind: 'message' as const, id: `story:change-request:${request.id}`,
        label: `${request.id} · ${request.targetPhase}`,
        description: request.comment,
        tooltip: `${request.sourcePhase} → ${request.targetPhase}\n${request.comment}\nRequested ${request.requestedAt}`,
        icon: 'prompt'
      }))
    }] : []), {
      kind: 'group', id: 'story:phase-rail', label: 'Story lifecycle',
      description: `${approved}/${phases.length} approved`, icon: 'list-ordered',
      children: phases.map((phase) => {
        const artifacts = storyDocumentNodes(documents, phase.id);
        const current = workflow.currentPhase === phase.id;
        return {
          kind: 'phase' as const, id: `story-phase:${phase.id}`, label: phase.label,
          description: [phaseDescription(phase.status), current ? 'current' : '',
            `${artifacts.length} ${artifacts.length === 1 ? 'artifact' : 'artifacts'}`]
            .filter(Boolean).join(' · '),
          icon: current ? 'statusCurrent' : phaseIcon(phase.status),
          contextValue: current ? 'sflow.story.phase.current' : 'sflow.story.phase',
          children: [
            ...(artifacts.length ? artifacts : [{
              kind: 'message' as const,
              id: `story-phase:${phase.id}:artifacts-empty`,
              label: 'No generated artifacts yet',
              description: current ? 'generated files appear here after preparation' : 'none recorded for this phase',
              icon: 'info'
            }]),
            ...storyPhaseActions(workflow, phase, actor)
          ]
        };
      })
    }]
  };
}

/**
 * Repository configuration has its own view.
 *
 * Keeping this out of Lifecycle matters: intake and delivery state change as work advances, while
 * these files define how that work is performed. Mixing both made templates and agents hard to
 * find and made Lifecycle look like a settings drawer rather than the place work moves forward.
 */
export function buildConfigurationTree(
  snapshot: RepositorySnapshot | null,
  error: Error | null = null,
  readiness: CapabilityReadiness = {}
): TreeNode[] {
  if (error && !snapshot) return configurationFailure(error, 'configuration');
  if (!snapshot) {
    return [{
      kind: 'message', id: 'configuration:loading', label: 'Reading repository configuration…',
      icon: 'loading~spin'
    }];
  }
  /**
   * One entry, not a tree.
   *
   * Everything this section used to list — templates, prompts, skills, agents, the designers, the
   * publish flow — is in the Configuration Center, and was there already. Two routes to the same
   * settings meant two places to look and, in practice, two answers to "where is that", because the
   * sidebar copy drifted behind the Center whenever a tab was added.
   *
   * The failure node stays: when configuration cannot be read, saying so here is more useful than a
   * button that opens a panel which will fail for the same reason.
   */
  return [
    ...(error ? configurationFailure(error, 'configuration') : []),
    {
      kind: 'action',
      id: 'configuration:center',
      label: 'Open Configuration Center',
      description: 'all settings',
      tooltip: 'Capabilities, workflows, artifact templates, model routing, world model, agents, approvals and MCP tools.',
      icon: 'configuration',
      runCommand: 'singularityFlow.openConfigurationCenter'
    }
  ];
}

/** Kept as the public lifecycle builder for callers compiled against the earlier name. */
export const buildTree = buildLifecycleTree;

/** The approve command for a pack, or null when it is not yet complete. */
function packApproval(
  phaseOrder: string[],
  initiativeId: string,
  pack: { id: string; label: string; members: Array<{ phase: string; authored: boolean }> }
): { approve: NonNullable<TreeNode['approve']> } | null {
  if (!pack.members.length || !pack.members.every((member) => member.authored)) return null;
  const terminal = packTerminalPhase(phaseOrder, pack.members);
  if (!terminal) return null;
  return {
      approve: {
        kind: 'initiative',
        initiativeId,
      subject: `pack:${pack.id}`,
      expected: `${terminal}:pack:${pack.id}`,
      summary: `Approve pack ${pack.label}`
    }
  };
}

function initiativeNode(initiative: InitiativeSnapshot): TreeNode {
  const { state } = initiative;
  const phases = phasesInOrder(initiative);
  const packs = packsWithMembers(initiative);
  const repositories = storiesByRepository(initiative);
  const children: TreeNode[] = [];

  children.push({
    kind: 'action', id: 'initiative:continue-safely', label: 'Continue safely',
    description: 'review exact next action', icon: 'play-circle',
    runCommand: 'singularityFlow.continueSafely', contextValue: 'sflow.action.plan'
  });
  const next = initiative.nextActions?.[0];
  if (next) {
    children.push({
      kind: 'action',
      id: 'next-action',
      label: next.reason,
      description: next.action,
      tooltip: next.command,
      icon: 'play-circle',
      command: commandArgv(next.command),
      contextValue: 'sflow.action'
    });
  }

  children.push({
    kind: 'action', id: 'initiative:progress-rail', label: 'Open progress & artifacts',
    description: 'phases · approvals · files', icon: 'list-ordered',
    runCommand: 'singularityFlow.openJourney', contextValue: 'sflow.initiative.progress'
  });

  const gate = initiative.phaseGate;
  if (gate && !gate.ready && gate.errors.length) {
    children.push({
      kind: 'group',
      id: 'gate',
      label: `This phase is not ready (${gate.errors.length})`,
      icon: 'shield',
      contextValue: 'sflow.gate',
      children: gate.errors.map((message, index) => ({
        kind: 'message' as const,
        id: `gate-error:${index}`,
        label: message,
        icon: 'circle-large-outline'
      }))
    });
  }

  const generatedByPhase = phases.map((phase) => ({
    phase,
    artifacts: phase.outputs.filter((output) => Boolean(output.sha256))
      .map((output) => artifactNode(output, phase.id, state.initiative.id))
  })).filter((entry) => entry.artifacts.length);
  const generatedCount = generatedByPhase.reduce((total, entry) => total + entry.artifacts.length, 0);
  children.push({
    kind: 'group', id: `initiative:${state.initiative.id}:generated-artifacts`,
    label: 'Generated artifacts', description: String(generatedCount), icon: 'files',
    tooltip: `Governed outputs generated for ${state.initiative.id}, grouped by lifecycle phase.`,
    contextValue: 'sflow.initiative.artifacts',
    children: generatedByPhase.length ? generatedByPhase.map(({ phase, artifacts }) => ({
      kind: 'group' as const, id: `initiative:${state.initiative.id}:artifacts:${phase.id}`,
      label: phase.label, description: String(artifacts.length), icon: 'directory', children: artifacts
    })) : [{
      kind: 'message', id: `initiative:${state.initiative.id}:artifacts:empty`,
      label: 'No generated artifacts yet', description: 'complete a phase first', icon: 'info'
    }]
  });

  children.push({
    kind: 'group',
    id: 'phases',
    label: 'Lifecycle',
    description: `${phases.filter((phase) => phase.status === 'approved').length}/${phases.length} approved`,
    icon: 'list-ordered',
    children: phases.map((phase) => phaseNode(phase, state.initiative.id))
  });

  if (packs.length) {
    children.push({
      kind: 'group',
      id: 'packs',
      label: 'Artifact packs',
      description: `${packs.filter((pack) => pack.members.every((member) => member.authored)).length}/${packs.length} complete`,
      icon: 'archive',
      children: packs.map((pack) => ({
        kind: 'pack' as const,
        id: `pack:${pack.id}`,
        label: pack.label,
        description: `${pack.members.filter((member) => member.authored).length}/${pack.members.length}`,
        icon: 'archive',
        // A pack is approvable once every member exists; that is what makes it a reviewable unit
        // rather than a folder.
        ...(packApproval(state.phaseOrder, state.initiative.id, pack) ?? {}),
        contextValue: packApproval(state.phaseOrder, state.initiative.id, pack) ? 'sflow.pack.approvable' : 'sflow.pack',
        children: pack.members.map((member) => (member.artifact
          ? artifactNode(member.artifact, member.phase, state.initiative.id)
          : {
            kind: 'message' as const,
            id: `pack-missing:${pack.id}/${member.phase}/${member.output}`,
            label: `${member.phase}/${member.output}`,
            description: 'not declared by this profile',
            icon: 'question'
          }))
      }))
    });
  }

  const sources = (initiative.sources?.sources ?? []) as Array<Record<string, unknown>>;
  const detachedSources = (initiative.detachedSources ?? []) as Array<Record<string, unknown>>;
  children.push({
    kind: 'group',
    id: 'sources',
    label: 'Supporting evidence',
    description: sources.length ? `${sources.length}` : 'none pinned',
    icon: 'references',
    // Everything a requirement cites has to appear here, so an empty list is a finding rather than
    // an absence — and this is the node that offers to fix it.
    tooltip: sources.length
      ? 'Requirements may cite only these.'
      : 'Requirements have no cited source to rest on. Pin the brief, research, or designs.',
    contextValue: 'sflow.sources',
    children: [...(sources.length
      ? sources.map((source) => ({
        kind: 'source' as const,
        id: `source:${String(source.sourceId ?? source.id ?? '')}`,
        label: String(source.name ?? source.sourceId ?? 'unnamed source'),
        description: String(source.provider ?? ''),
        tooltip: `${String(source.sourceId ?? '')}\nsha256 ${String(source.sha256 ?? 'unknown')}`,
        icon: 'file-symlink-file',
        // Only a locally-provided source has its bytes in the repository; anything else lives in
        // corporate storage and has no path here to open.
        ...(source.cachePath ? { path: String(source.cachePath) } : {}),
        contextValue: 'sflow.evidence.active',
        evidence: {
          ownerKind: 'epic' as const, ownerId: state.initiative.id,
          evidenceId: String(source.sourceId ?? source.id ?? ''), status: 'active' as const
        }
      }))
      : [{
        kind: 'message' as const,
        id: 'sources-empty',
        label: 'Nothing is pinned yet',
        icon: 'warning'
      }]), {
        kind: 'action' as const,
        id: 'sources-attach',
        label: 'Attach evidence & designs',
        description: 'files · Figma exports · HTTPS links',
        icon: 'visual',
        runCommand: 'singularityFlow.attachEvidence',
        contextValue: 'sflow.sources.attach'
      }, {
        kind: 'action' as const,
        id: 'sources-manage',
        label: 'Manage evidence & designs',
        description: 'list · preview · detach',
        icon: 'references',
        runCommand: 'singularityFlow.manageEvidence',
        contextValue: 'sflow.evidence.manage'
      }]
  });
  if (detachedSources.length) children.push({
    kind: 'group', id: 'sources-detached', label: 'Detached evidence',
    description: String(detachedSources.length), icon: 'archive', contextValue: 'sflow.evidence.detached.group',
    children: detachedSources.map((source) => ({
      kind: 'source' as const,
      id: `source-detached:${String(source.sourceId ?? source.id ?? '')}`,
      label: String(source.name ?? source.sourceId ?? 'unnamed source'),
      description: 'detached',
      tooltip: `${String(source.detachReason ?? 'Detached')}\n${String(source.detachedAt ?? '')}`,
      icon: 'archive',
      ...(source.recordPath ? { path: String(source.recordPath) } : {}),
      readOnly: true,
      contextValue: 'sflow.evidence.detached',
      evidence: {
        ownerKind: 'epic' as const, ownerId: state.initiative.id,
        evidenceId: String(source.sourceId ?? source.id ?? ''), status: 'detached' as const
      }
    }))
  });

  if (repositories.length) {
    children.push({
      kind: 'group',
      id: 'stories',
      label: 'Stories',
      description: `${initiative.breakdown?.stories.length ?? 0} across ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`,
      icon: 'repo',
      children: repositories.map((entry) => ({
        kind: 'repository' as const,
        id: `repository:${entry.repository}`,
        label: entry.repository,
        description: `${entry.stories.length} ${entry.stories.length === 1 ? 'Story' : 'Stories'}`,
        icon: 'repo',
        contextValue: 'sflow.repository',
        children: entry.stories.map(storyNode)
      }))
    });
  }

  return {
    kind: 'initiative',
    id: `initiative:${state.initiative.id}`,
    label: state.initiative.id,
    description: state.initiative.title ?? state.resolution.profile,
    tooltip: `${state.resolution.profile}\nBranch ${state.initiative.branch ?? 'unknown'}`,
    icon: 'rocket',
    contextValue: 'sflow.initiative',
    children
  };
}
