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
  type CapabilityNode,
  type BreakdownStory, type InitiativeOutput, type InitiativeSnapshot,
  type DesktopSnapshot, type PhaseStatus
} from '../cli/snapshot.ts';

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
  /** Set for artifacts the editor can open. Repository-relative. */
  path?: string;
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
   * HEAD and to the exact artifact hashes, and it is also where `initiative approve`'s working-lens
   * answer lives, since that path has no --persona.
   */
  approve?: { initiativeId: string; subject: string; expected: string; summary: string };
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
    // Only an artifact that exists and is not already approved can be approved. Offering the action
    // on an unwritten artifact would produce a refusal the reviewer could have been spared.
    ...(output.sha256 && output.status !== 'approved' ? {
      approve: {
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
    icon: story.blocking ? 'git-pull-request' : 'git-pull-request-draft',
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
  return [{
    kind: 'message',
    id: 'unavailable',
    label,
    tooltip: detail,
    icon: 'info',
    ...(contextValue ? { contextValue } : {}),
    children: [
      { kind: 'message', id: 'unavailable-detail', label: detail, icon: 'blank' },
      // A state that explains itself and offers nothing is a dead end. Everything Singularity Flow
      // can do needs a repository, so the two ways to get one are the only useful rows here — and
      // both work from a window with nothing open, which is exactly where this state occurs.
      {
        kind: 'action', id: 'unavailable:bootstrap',
        label: 'Map a capability', description: 'start here',
        tooltip: 'Describe what this organisation builds and which repository each part ships from. '
          + 'Nothing is checked out.',
        icon: 'type-hierarchy', runCommand: 'singularityFlow.mapCapability'
      },
      {
        kind: 'action', id: 'unavailable:workspaces', label: 'Find a workspace you already have',
        icon: 'root-folder', runCommand: 'singularityFlow.openWorkspaces'
      },
      {
        kind: 'action', id: 'unavailable:create', label: 'Create a workspace',
        icon: 'add', runCommand: 'singularityFlow.createWorkspace'
      },
      ...(leadRepository ? [{
        kind: 'action' as const, id: 'unavailable:lead',
        label: 'Open this workspace\'s lead repository',
        description: leadRepository.split('/').at(-1),
        icon: 'repo', openPath: leadRepository, runCommand: 'singularityFlow.openWorkspace'
      }] : []),
      ...(contextValue === 'sflow.uninitialized' ? [{
        kind: 'action' as const, id: 'unavailable:init',
        label: 'Initialize Singularity Flow in this folder',
        icon: 'add', runCommand: 'singularityFlow.init'
      }] : [])
    ]
  }];
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

  const configuration = configurationNode(snapshot);
  const initiative = snapshot.initiative;
  if (!initiative) {
    const available = snapshot.initiatives?.length ?? 0;
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
      // The one thing to do from an empty repository, offered rather than described. A tree that
      // explains a command you must retype into a terminal is a worse tree than one with a button.
      contextValue: 'sflow.start'
    }, capabilityNode(snapshot), worldModelNode(snapshot), configuration];
  }

  return [initiativeNode(initiative), capabilityNode(snapshot), worldModelNode(snapshot), configuration];
}

/**
 * The capability map: what this organisation builds, as opposed to where its code is stored.
 *
 * Shown as the tree it is, to any depth. A delivery capability names the repository it ships from,
 * which is the join between this and everything else in the view — a Story lands in a repository,
 * and this is what says which part of the business that repository serves.
 */
function capabilityNode(snapshot: DesktopSnapshot): TreeNode {
  const map = snapshot.capabilityMap;
  const path = snapshot.capabilityMapPath ?? 'singularity/capability-map.yml';

  if (map?.error) {
    return {
      kind: 'group', id: 'capabilities', label: 'Capabilities',
      description: 'not valid', icon: 'warning', tooltip: map.error,
      children: [{ kind: 'message', id: 'capabilities:error', label: map.error, icon: 'error' }]
    };
  }

  const roots = map?.capabilities ?? [];
  if (!roots.length) {
    return {
      kind: 'group', id: 'capabilities', label: 'Capabilities',
      description: 'not described', icon: 'type-hierarchy',
      tooltip: `Nothing describes what this organisation builds. Create ${path} in the lead repository.`,
      children: [{
        kind: 'message', id: 'capabilities:empty',
        label: 'The lead repository has not described what it builds',
        icon: 'info'
      }]
    };
  }

  // Whether a capability ships is decided by naming a repository, not by what its `kind` says. Kind
  // is free text the organisation chooses; reading it as a flag made a capability labelled anything
  // other than "delivery" render as an empty grouping however clearly it named its repository.
  const toNode = (capability: CapabilityNode): TreeNode => ({
    kind: capability.repository ? 'artifact' : 'group',
    id: `capability:${capability.id}`,
    label: capability.name,
    description: capability.repository ?? undefined,
    tooltip: capability.description || (capability.repository
      ? `Ships from ${capability.repository}.`
      : 'Groups the capabilities beneath it.'),
    icon: capability.repository ? 'repo' : 'type-hierarchy',
    contextValue: capability.repository ? 'sflow.capability.delivery' : 'sflow.capability',
    ...(capability.children.length ? { children: capability.children.map(toNode) } : {})
  });

  const deliveries = map?.repositories?.length ?? 0;
  return {
    kind: 'group',
    id: 'capabilities',
    label: 'Capabilities',
    description: `${deliveries} delivering`,
    icon: 'type-hierarchy',
    tooltip: 'What this organisation builds. Delivery capabilities name the repository they ship from.',
    children: roots.map(toNode)
  };
}

/**
 * The world model: what grounding has to draw on, and whether it is current.
 *
 * Kept at the root rather than under an Epic because a model belongs to the repository, and every
 * Epic on every branch grounds against the same one. Its absence is the state worth naming — a
 * repository with no model grounds prompts on nothing, and that is invisible until the answers are
 * wrong.
 */
function worldModelNode(snapshot: DesktopSnapshot): TreeNode {
  const model = snapshot.worldModel;
  const views = model?.views ?? [];
  const built = Boolean(model?.generatedAt);

  const children: TreeNode[] = [];
  if (model?.rebuildReason) {
    children.push({
      kind: 'action',
      id: 'wm:rebuild',
      label: model.rebuildReason,
      description: 'rebuild',
      icon: 'warning',
      command: ['wm', 'build'],
      contextValue: 'sflow.action'
    });
  } else if (!built) {
    children.push({
      kind: 'action',
      id: 'wm:build',
      label: 'Build the world model',
      description: 'wm build',
      tooltip: 'Reads the repository and writes the views that ground every governed prompt.',
      icon: 'play-circle',
      command: ['wm', 'build'],
      contextValue: 'sflow.action'
    });
  }

  children.push(...views.map((view) => ({
    kind: 'artifact' as const,
    id: `wm:view:${view.id}`,
    label: view.id,
    description: view.references.length ? `${view.references.length} references` : 'no references',
    icon: 'milestone',
    path: `${model?.root ?? 'singularity/world-model'}/views/${view.id}.md`,
    contextValue: 'sflow.config'
  })));

  return {
    kind: 'group',
    id: 'world-model',
    label: 'World model',
    description: built
      ? `${views.length} ${views.length === 1 ? 'view' : 'views'}`
      : 'not built',
    icon: 'book',
    tooltip: built
      ? `Generated ${model?.generatedAt}. Every governed prompt is grounded against these views.`
      : 'Nothing has been generated. Governed prompts have no repository knowledge to draw on.',
    contextValue: 'sflow.worldmodel',
    children: children.length ? children : [{
      kind: 'message', id: 'wm:empty', label: 'No views declared', icon: 'blank'
    }]
  };
}

/**
 * The repository's own configuration: what the lifecycle is, who may approve, and the lenses work
 * is done under. These are files, and the editor is good at files — the value here is knowing they
 * exist and where, which is exactly what a newcomer does not.
 */
/**
 * The editable file sets, as groups of openable files.
 *
 * Artifact templates, working-lens prompts, prompt packs and agent mappings are all Markdown or YAML
 * that the engine already lists and already guards on save. What the editor adds is knowing they
 * exist: a template that nobody can find is a template nobody edits, and the shape of an artifact is
 * one of the few things a team genuinely wants to change about this product.
 *
 * An empty set is shown rather than hidden, so "there are no prompt packs" is a fact you can read
 * instead of an absence you have to infer.
 */
function fileSetNodes(snapshot: DesktopSnapshot): TreeNode[] {
  const sets: Array<{ id: string; label: string; icon: string; files: Array<{ path: string; name: string }> }> = [
    { id: 'templates', label: 'Artifact templates', icon: 'file-code', files: snapshot.templates ?? [] },
    { id: 'prompts', label: 'Lens prompts', icon: 'comment-discussion', files: snapshot.personaPrompts ?? [] },
    { id: 'skills', label: 'Prompt packs', icon: 'book', files: snapshot.repositorySkills ?? [] }
  ];

  const nodes: TreeNode[] = sets.map((set) => ({
    kind: 'group',
    id: `config:${set.id}`,
    label: set.label,
    description: set.files.length ? `${set.files.length}` : 'none',
    icon: set.icon,
    children: set.files.length
      ? set.files
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((file) => ({
          kind: 'artifact' as const,
          id: `file:${file.path}`,
          label: file.name,
          tooltip: file.path,
          icon: set.icon,
          path: file.path,
          contextValue: 'sflow.config'
        }))
      : [{ kind: 'message' as const, id: `config:${set.id}:empty`, label: `No ${set.label.toLowerCase()}`, icon: 'blank' }]
  }));

  const agents = snapshot.agents ?? [];
  if (agents.length || snapshot.agentMappings) {
    nodes.push({
      kind: 'group',
      id: 'config:agents',
      label: 'Agents',
      description: agents.length ? `${agents.length}` : 'none',
      icon: 'hubot',
      children: [
        ...agents.map((agent) => ({
          kind: 'artifact' as const,
          id: `agent:${agent.id}`,
          label: agent.id,
          description: agent.scope,
          tooltip: agent.path,
          icon: 'hubot',
          path: agent.path,
          // A packaged agent is read-only; only a repository one is the team's to change.
          readOnly: agent.editable === false,
          contextValue: 'sflow.config'
        })),
        ...(snapshot.agentMappings ? [{
          kind: 'artifact' as const,
          id: 'agent:mappings',
          label: 'agent-mappings.yml',
          description: snapshot.agentMappings.exists ? 'which agent runs which skill' : 'not created yet',
          icon: 'list-tree',
          path: snapshot.agentMappings.path,
          contextValue: 'sflow.config'
        }] : [])
      ]
    });
  }
  return nodes;
}

function configurationNode(snapshot: DesktopSnapshot): TreeNode {
  const personas = Object.entries(snapshot.definition?.personas ?? {});
  const ledger = snapshot.definition?.ledger as { enabled?: boolean; branch?: string } | undefined;
  return {
    kind: 'group',
    id: 'configuration',
    label: 'Configuration',
    icon: 'settings-gear',
    description: ledger?.enabled ? `state on ${ledger.branch ?? 'ledger'}` : 'no state branch',
    tooltip: ledger?.enabled
      ? `Workflow progress is recorded on the orphan branch '${ledger.branch}'.`
      : 'No append-only workflow ledger is enabled for this repository.',
    children: [
      {
        kind: 'artifact', id: 'config:workflow', label: 'workflow.yml',
        description: 'phases, lenses, grounding', icon: 'layers',
        path: snapshot.definitionPath ?? 'singularity/workflow.yml', contextValue: 'sflow.config'
      },
      {
        kind: 'artifact', id: 'config:portfolio', label: 'portfolio.yml',
        description: 'profiles, approvers, repositories', icon: 'organization',
        path: snapshot.portfolioPath ?? 'singularity/portfolio.yml', contextValue: 'sflow.config'
      },
      ...fileSetNodes(snapshot),
      {
        kind: 'group', id: 'config:personas', label: 'Working lenses',
        description: personas.length ? `${personas.length}` : 'none', icon: 'eye',
        children: personas.map(([id, persona]) => ({
          kind: 'artifact' as const,
          id: `persona:${id}`,
          label: persona?.label ?? id,
          description: id,
          icon: 'person',
          path: `singularity/personas/${id}.md`,
          contextValue: 'sflow.config'
        }))
      }
    ]
  };
}

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
        icon: 'circle-large-outline'
      }))
    });
  }

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
  children.push({
    kind: 'group',
    id: 'sources',
    label: 'Pinned sources',
    description: sources.length ? `${sources.length}` : 'none pinned',
    icon: 'references',
    // Everything a requirement cites has to appear here, so an empty list is a finding rather than
    // an absence — and this is the node that offers to fix it.
    tooltip: sources.length
      ? 'Requirements may cite only these.'
      : 'Requirements have no cited source to rest on. Pin the brief, research, or designs.',
    contextValue: 'sflow.sources',
    children: sources.length
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
        contextValue: 'sflow.source'
      }))
      : [{
        kind: 'message' as const,
        id: 'sources-empty',
        label: 'Nothing is pinned yet',
        icon: 'warning'
      }]
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
