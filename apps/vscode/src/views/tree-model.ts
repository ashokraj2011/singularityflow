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
  type BreakdownStory, type InitiativeOutput, type InitiativeSnapshot,
  type DesktopSnapshot, type PhaseStatus
} from '../cli/snapshot.ts';

export type NodeKind =
  | 'message' | 'initiative' | 'phase' | 'pack' | 'artifact'
  | 'group' | 'repository' | 'story' | 'action';

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
  /** Set for artifacts the editor can open. Repository-relative. */
  path?: string;
  /** True when opening this artifact should be read-only. */
  readOnly?: boolean;
  /** A CLI invocation this node offers, already split into argv. */
  command?: string[];
  contextValue?: string;
}

const PHASE_ICON: Record<string, string> = {
  approved: 'pass-filled',
  awaiting_approval: 'clock',
  in_progress: 'circle-large-outline',
  rejected: 'error',
  stale: 'warning',
  not_started: 'circle-outline'
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
const phaseIcon = (status: PhaseStatus): string => PHASE_ICON[status] ?? 'circle-outline';
const phaseDescription = (status: PhaseStatus): string =>
  PHASE_DESCRIPTION[status] ?? String(status).replace(/_/g, ' ');

function artifactNode(output: InitiativeOutput, phaseId: string): TreeNode {
  const pinned = output.status === 'approved' && Boolean(output.sha256);
  const icon = output.status === 'approved' ? 'lock-small'
    : output.sha256 ? 'file'
      : 'file-code';
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
    contextValue: pinned ? 'sflow.artifact.pinned' : 'sflow.artifact'
  };
}

function phaseNode(phase: ReturnType<typeof phasesInOrder>[number]): TreeNode {
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
      .map((output) => artifactNode(output, phase.id))
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
    icon: story.blocking ? 'git-pull-request' : 'git-pull-request-draft',
    contextValue: 'sflow.story'
  };
}

/**
 * Build the whole tree from one snapshot.
 *
 * Every empty case returns a node that says what is missing and what would fix it, rather than an
 * empty branch. An empty tree in a governance tool reads as "nothing to do", which is the single
 * most expensive thing it could wrongly say.
 */
export function buildTree(snapshot: DesktopSnapshot | null, error: Error | null = null): TreeNode[] {
  if (error) {
    return [{
      kind: 'message',
      id: 'error',
      label: error.message,
      icon: 'error',
      tooltip: 'The Singularity Flow CLI reported this. Run the same command in a terminal for the full output.'
    }];
  }
  if (!snapshot) {
    return [{ kind: 'message', id: 'loading', label: 'Reading the repository…', icon: 'loading~spin' }];
  }

  const initiative = snapshot.initiative;
  if (!initiative) {
    const available = snapshot.initiatives?.length ?? 0;
    return [{
      kind: 'message',
      id: 'no-initiative',
      label: available
        ? 'No Epic is checked out on this branch'
        : 'No Epic has been started in this repository',
      description: available ? `${available} available` : undefined,
      icon: 'info',
      tooltip: available
        ? 'Check out an Epic branch, or start one with: singularity-flow epic start'
        : 'Start one with: singularity-flow epic start --local --title … --description … --goal …'
    }];
  }

  return [initiativeNode(initiative)];
}

function initiativeNode(initiative: InitiativeSnapshot): TreeNode {
  const { state } = initiative;
  const phases = phasesInOrder(initiative);
  const packs = packsWithMembers(initiative);
  const repositories = storiesByRepository(initiative);
  const children: TreeNode[] = [];

  const next = initiative.nextActions?.[0];
  if (next) {
    children.push({
      kind: 'action',
      id: 'next-action',
      label: next.reason,
      description: next.action,
      tooltip: next.command,
      icon: 'play-circle',
      command: next.command.replace(/^singularity-flow\s+/, '').split(/\s+/),
      contextValue: 'sflow.action'
    });
  }

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
        icon: 'circle-slash'
      }))
    });
  }

  children.push({
    kind: 'group',
    id: 'phases',
    label: 'Lifecycle',
    description: `${phases.filter((phase) => phase.status === 'approved').length}/${phases.length} approved`,
    icon: 'list-ordered',
    children: phases.map(phaseNode)
  });

  if (packs.length) {
    children.push({
      kind: 'group',
      id: 'packs',
      label: 'Artifact packs',
      description: `${packs.filter((pack) => pack.members.every((member) => member.authored)).length}/${packs.length} complete`,
      icon: 'package',
      children: packs.map((pack) => ({
        kind: 'pack' as const,
        id: `pack:${pack.id}`,
        label: pack.label,
        description: `${pack.members.filter((member) => member.authored).length}/${pack.members.length}`,
        icon: 'package',
        contextValue: 'sflow.pack',
        children: pack.members.map((member) => (member.artifact
          ? artifactNode(member.artifact, member.phase)
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
