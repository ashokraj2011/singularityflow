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
  type RepositorySnapshot, type PhaseStatus, type StoryArtifact, type StoryPhase,
  type StoryWorkflow
} from '../cli/snapshot.ts';
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
    | { kind: 'story'; workId: string; phaseId: string; expected: string; summary: string };
  contextValue?: string;
}

const PHASE_ICON: Record<string, string> = {
  approved: 'statusSuccess',
  awaiting_approval: 'statusWaiting',
  in_progress: 'statusCurrent',
  rejected: 'statusBlocked',
  stale: 'statusWarning',
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

  if (snapshot.workflow) return [storyWorkflowNode(snapshot.workflow, snapshot.documents ?? [])];

  const initiative = snapshot.initiative;
  if (!initiative) {
    const available = (snapshot.initiatives?.length ?? 0) + (snapshot.workItems?.length ?? 0);
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
    }, workflowsNode(snapshot)];
  }

  // Workflow selection belongs to intake. Once work exists, Lifecycle shows only that work and its
  // phases; showing every other configured workflow beside it made Configuration and Lifecycle look
  // like duplicate workflow browsers.
  return [initiativeNode(initiative)];
}

function storyDocumentNodes(documents: StoryArtifact[], phaseId: string): TreeNode[] {
  return documents
    .filter((document) => document.phase === phaseId && Boolean(document.path))
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

function storyPhaseActions(workflow: StoryWorkflow, phase: StoryPhase): TreeNode[] {
  if (workflow.currentPhase !== phase.id) return [];
  if (phase.status === 'awaiting_approval') {
    return [{
      kind: 'action', id: `story:${phase.id}:approve`, label: `Review and approve ${phase.label}`,
      description: 'exact generation', icon: 'verified',
      approve: {
        kind: 'story', workId: workflow.workItem.id, phaseId: phase.id, expected: phase.id,
        summary: `Approve ${workflow.workItem.id} / ${phase.label}`
      },
      contextValue: 'sflow.story.approval'
    }];
  }
  if (phase.status !== 'in_progress' && phase.status !== 'rejected') return [];
  return [{
    kind: 'action', id: `story:${phase.id}:copilot`, label: 'Continue this Story in Copilot',
    description: 'open its repository + governed phase', icon: 'sparkle', runCommand: 'singularityFlow.openCopilot'
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

function storyWorkflowNode(workflow: StoryWorkflow, documents: StoryArtifact[]): TreeNode {
  const phases = workflow.phaseOrder.map((id) => workflow.phases[id])
    .filter((phase): phase is StoryPhase => Boolean(phase));
  const approved = phases.filter((phase) => phase.status === 'approved').length;
  return {
    kind: 'story',
    id: `active-story:${workflow.workItem.id}`,
    label: workflow.workItem.id,
    description: workflow.workItem.title ?? workflow.workItem.workType ?? 'Story',
    tooltip: `${workflow.workItem.workType ?? 'Story'} workflow\nBranch ${workflow.workItem.branch ?? 'unknown'}`,
    icon: 'story',
    contextValue: 'sflow.story.active',
    children: [{
      kind: 'action', id: 'story:analytics', label: 'Open lifecycle analytics',
      description: 'phases · time · tokens · cost', icon: 'impact',
      runCommand: 'singularityFlow.openDashboard', contextValue: 'sflow.story.analytics'
    }, {
      kind: 'group', id: 'story:phase-rail', label: 'Story lifecycle',
      description: `${approved}/${phases.length} approved`, icon: 'list-ordered',
      children: phases.map((phase) => ({
        kind: 'phase', id: `story-phase:${phase.id}`, label: phase.label,
        description: workflow.currentPhase === phase.id
          ? `${phaseDescription(phase.status)} · current`
          : phaseDescription(phase.status),
        icon: phaseIcon(phase.status),
        contextValue: workflow.currentPhase === phase.id ? 'sflow.story.phase.current' : 'sflow.story.phase',
        children: [
          ...storyPhaseActions(workflow, phase),
          ...storyDocumentNodes(documents, phase.id)
        ]
      }))
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
  return [
    ...(error ? configurationFailure(error, 'configuration') : []),
    configurationNode(snapshot, readiness)
  ];
}

/** Kept as the public lifecycle builder for callers compiled against the earlier name. */
export const buildTree = buildLifecycleTree;

/**
 * The workflows this repository can start work with.
 *
 * This is what a lifecycle view is for: the work in flight, and the shapes that work can take. The
 * capability tree used to sit here as well, duplicating the Capabilities view exactly, and the
 * world model sat here too — but a capability is what the organisation builds and a world model is
 * grounding for prompts. Neither is a stage of anything, and neither belonged in a view about
 * stages.
 */
function workflowsNode(snapshot: RepositorySnapshot): TreeNode {
  const portfolio = snapshot.portfolio as {
    initiativeProfiles?: Record<string, { label?: string; phases?: string[] }>;
  } | undefined;
  const workTypes = Object.entries(snapshot.definition?.workTypes ?? {});
  const profiles = Object.entries(portfolio?.initiativeProfiles ?? {});
  const portfolioPath = snapshot.portfolioPath ?? 'singularity/portfolio.yml';
  const definitionPath = snapshot.definitionPath ?? 'singularity/workflow.yml';
  const rows = [
    ...profiles.map(([id, profile]) => ({
      id,
      label: profile?.label ?? id,
      phases: profile?.phases ?? [],
      governs: 'initiative',
      path: portfolioPath
    })),
    ...workTypes.map(([id, type]) => ({
      id,
      label: (type as { label?: string })?.label ?? id,
      phases: (type as { phases?: string[] })?.phases ?? [],
      governs: 'story',
      path: definitionPath
    }))
  ];

  return {
    kind: 'group',
    id: 'workflows',
    label: 'Choose a workflow during intake',
    icon: 'git-merge',
    description: rows.length ? `${rows.length}` : 'none',
    tooltip: 'The shapes work can take here. A workflow is an ordered list of phases; which of them '
      + 'governs an Initiative and which a Story is a property of the workflow, not two ideas.',
    children: rows.length
      ? rows.map((row) => ({
        kind: 'artifact' as const,
        id: `workflow:${row.governs}:${row.id}`,
        label: row.label,
        // The phase chain is what actually distinguishes one workflow from another, so it is the
        // description rather than something to open the file to discover.
        description: `${row.governs} · ${row.phases.join(' → ')}`,
        tooltip: `${row.id}\nDefined in ${row.path}. Edit it in the Designer or in the file.`,
        icon: row.governs === 'initiative' ? 'initiative' : 'story',
        // Lifecycle presents the available choice. Editing its definition belongs in Configuration.
        contextValue: 'sflow.workflow.choice'
      }))
      : [{
        kind: 'message' as const,
        id: 'workflows:empty',
        label: 'No workflows are configured',
        description: 'add one',
        icon: 'info',
        contextValue: 'sflow.workflows.empty'
      }]
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
function worldModelNode(snapshot: RepositorySnapshot): TreeNode {
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
    icon: 'initiative',
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
    icon: 'worldModel',
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
 * The repository's own configuration: what the lifecycle is, who may approve, and which governed
 * agents execute each phase. These are files, and the editor is good at files — the value is knowing they
 * exist and where, which is exactly what a newcomer does not.
 */
/**
 * The editable file sets, as groups of openable files.
 *
 * Artifact templates, skills, agents and agent mappings are all Markdown or YAML
 * that the engine already lists and already guards on save. What the editor adds is knowing they
 * exist: a template that nobody can find is a template nobody edits, and the shape of an artifact is
 * one of the few things a team genuinely wants to change about this product.
 *
 * An empty set is shown rather than hidden, so "there are no agents" is a fact you can read
 * instead of an absence you have to infer.
 */
function fileSetNodes(snapshot: RepositorySnapshot): TreeNode[] {
  // Both kinds of agent. The snapshot has carried the packaged ones as `flowSkills` all along
  // and this view showed only the repository's, so a repository that had written none of its own
  // was told it had no agents while eighty-two shipped with the product sat unlisted. The
  // repository's own come first: those are the ones a team wrote and can change.
  const packs = [
    ...(snapshot.repositorySkills ?? []).map((file) => ({ ...file, scope: 'repository' as const })),
    ...(snapshot.flowSkills ?? []).map((skill) => ({
      path: skill.path,
      packagePath: skill.packagePath ?? skill.path,
      name: skill.id ?? skill.name ?? skill.path,
      scope: 'packaged' as const,
      description: skill.description
    }))
  ];

  const sets: Array<{
    id: string; label: string; icon: string;
    files: Array<{
      path: string; packagePath?: string; name: string; scope?: string; description?: string;
    }>;
  }> = [
    { id: 'templates', label: 'Artifact templates', icon: 'artifact', files: snapshot.templates ?? [] },
    {
      id: 'prompts', label: 'Repository prompts', icon: 'prompt',
      files: snapshot.prompts ?? snapshot.agentPrompts ?? snapshot.personaPrompts ?? []
    },
    { id: 'skills', label: 'Skills and prompt packs', icon: 'skill', files: packs }
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
          // Which ones this team wrote, and which came with the product — the difference decides
          // whether editing it is a change to your repository or a change you will lose on upgrade.
          description: file.scope === 'packaged' ? 'packaged' : file.scope === 'repository' ? 'repository' : undefined,
          tooltip: [file.description, file.path].filter(Boolean).join('\n'),
          icon: set.icon,
          path: file.path,
          packagePath: file.packagePath,
          readOnly: Boolean(file.packagePath),
          contextValue: 'sflow.config'
        }))
      : [{ kind: 'message' as const, id: `config:${set.id}:empty`, label: `No ${set.label.toLowerCase()}`, icon: 'blank' }]
  }));

  const agents = snapshot.agents ?? [];
  nodes.push({
    kind: 'group',
    id: 'config:agents',
    label: 'Agents and prompts',
    description: agents.length ? `${agents.length}` : 'none',
    icon: 'agent',
    children: [
      ...agents.map((agent) => ({
        kind: 'artifact' as const,
        id: `agent:${agent.id}`,
        label: agent.id,
        description: agent.scope,
        tooltip: agent.path,
        icon: 'agent',
        path: agent.path,
        packagePath: agent.packagePath ?? undefined,
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
      }] : []),
      ...(!agents.length && !snapshot.agentMappings ? [{
        kind: 'message' as const,
        id: 'config:agents:empty',
        label: 'No agents or mappings are configured',
        icon: 'blank'
      }] : [])
    ]
  });
  return nodes;
}

function configurationNode(snapshot: RepositorySnapshot, readiness: CapabilityReadiness = {}): TreeNode {
  const ledger = snapshot.definition?.ledger as { enabled?: boolean; branch?: string } | undefined;
  return {
    kind: 'group',
    id: 'configuration',
    label: 'Configuration',
    icon: 'settings-gear',
    description: snapshot.configurationValid === false
      ? 'repair required'
      : ledger?.enabled ? `state on ${ledger.branch ?? 'ledger'}` : 'no state branch',
    tooltip: ledger?.enabled
      ? `Workflow progress is recorded on the orphan branch '${ledger.branch}'.`
      : 'No append-only workflow ledger is enabled for this repository.',
    children: [
      // Capabilities come first because they define what the organisation builds and which
      // repositories a workspace will contain. Hiding them behind workspace and workflow settings
      // recreates the onboarding circle the standalone mapper exists to remove.
      capabilityConfigurationNode(snapshot, readiness),
      {
        kind: 'group', id: 'config:local-profile', label: 'User and integrations',
        description: 'local · keychain protected', icon: 'account',
        children: [{
          kind: 'action', id: 'config:profile', label: 'Configure user profile',
          description: 'name and role', icon: 'account', runCommand: 'singularityFlow.configureProfile'
        }, {
          kind: 'action', id: 'config:jira', label: 'Connect or replace Jira',
          description: 'VS Code SecretStorage', icon: 'key', runCommand: 'singularityFlow.connectJira'
        }, {
          kind: 'action', id: 'config:jira-reset', label: 'Reset saved Jira',
          description: 'remove keychain secret', icon: 'trash', runCommand: 'singularityFlow.resetJira'
        }, {
          kind: 'action', id: 'config:copilot', label: 'Continue active Story in Copilot',
          description: 'open its repository + governed phase', icon: 'sparkle', runCommand: 'singularityFlow.openCopilot'
        }, {
          kind: 'action', id: 'config:prompt-audit', label: 'Prompt audit',
          description: 'off by default · workspace local', icon: 'prompt', runCommand: 'singularityFlow.openPromptAudit'
        }]
      },
      worldModelNode(snapshot),
      {
        kind: 'group', id: 'config:workflow-design', label: 'Workflow and phase design',
        description: 'workflows, phases, gates', icon: 'symbol-structure',
        children: [{
          kind: 'action', id: 'config:designer', label: 'Open Workflow Designer',
          description: 'visual editor', icon: 'layout', runCommand: 'singularityFlow.openDesigner'
        }, {
          kind: 'action', id: 'config:instruction-designer', label: 'Open Agent, Prompt & Skill Designer',
        description: 'agents · prompts · skills · prompt packs', icon: 'agent',
          runCommand: 'singularityFlow.openInstructionDesigner'
        }, {
          kind: 'artifact', id: 'config:workflow', label: 'workflow.yml',
          description: 'Story workflows, phases, agent defaults, grounding', icon: 'layers',
          path: snapshot.definitionPath ?? 'singularity/workflow.yml', contextValue: 'sflow.config'
        }, {
          kind: 'artifact', id: 'config:portfolio', label: 'portfolio.yml',
          description: 'Initiative profiles, gates, approvers, repositories', icon: 'organization',
          path: snapshot.portfolioPath ?? 'singularity/portfolio.yml', contextValue: 'sflow.config'
        }]
      },
      ...fileSetNodes(snapshot)
    ]
  };
}

/**
 * What the organisation builds belongs to Configuration, not to the workspace selector.
 *
 * A workspace answers "where am I working?". The capability map is governed repository
 * configuration that answers "what does this organisation build?". Keeping the editor actions and
 * the map together also makes adding the first capability discoverable instead of hiding it behind
 * a synthetic workspace-scope row.
 */
function capabilityConfigurationNode(snapshot: RepositorySnapshot, readiness: CapabilityReadiness): TreeNode {
  const roots = buildCapabilityTree(snapshot, null, readiness);
  const count = snapshot.capabilityMap?.capabilities?.length ?? 0;
  return {
    kind: 'group',
    id: 'config:capabilities',
    label: 'Capabilities',
    description: count ? `${count} mapped` : 'none mapped',
    tooltip: `The governed capability map is stored in ${snapshot.capabilityMapPath ?? 'singularity/capabilities.yml'}.`,
    icon: 'type-hierarchy',
    contextValue: 'sflow.capabilities',
    children: [{
      kind: 'action',
      id: 'config:capabilities:add',
      label: 'Add capability',
      description: 'define what the organisation builds',
      tooltip: 'Create a root capability or add one beneath an existing capability.',
      icon: 'add',
      runCommand: 'singularityFlow.addCapability'
    }, {
      kind: 'action',
      id: 'config:capabilities:open',
      label: 'Open capability designer',
      description: 'view and edit the full map',
      icon: 'type-hierarchy',
      runCommand: 'singularityFlow.openCapabilities'
    }, {
      kind: 'artifact',
      id: 'config:capabilities:file',
      label: 'capabilities.yml',
      description: 'governed capability map',
      icon: 'file-code',
      path: snapshot.capabilityMapPath ?? 'singularity/capabilities.yml',
      contextValue: 'sflow.config'
    }, ...roots]
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
