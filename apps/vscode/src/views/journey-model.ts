/**
 * The journey, as data: where a Story or Epic stands and what it is waiting for.
 *
 * The tree answers "what exists". This answers "what is happening" — the question someone actually
 * opens a governance tool to ask. It is the PDLC read left to right: intake and pinned sources, the
 * phase rail, the artifacts and approvals of any selected phase, the control-plane chain each pack is
 * waiting on, and the Stories the work lands in.
 *
 * No `vscode` import, so the whole model is testable in a plain Node process. views/journey.ts turns
 * it into HTML and owns the webview.
 *
 * Everything here is derived from the snapshot. Nothing is inferred: where the engine does not say,
 * this says it does not know, because a governance summary that guesses is worse than one that is
 * incomplete.
 */
import {
  packsWithMembers, phasesInOrder, storiesByRepository,
  type RepositorySnapshot, type InitiativeSnapshot, type PhaseStatus, type StoryWorkflow,
  type StoryArtifact, type StoryApproval
} from '../cli/snapshot.ts';

export interface JourneyApproval {
  actor: string;
  at: string | null;
  authority: string | null;
}

export interface JourneyStage {
  id: string;
  label: string;
  status: PhaseStatus;
  current: boolean;
  approved: boolean;
  /** Artifacts generated / artifacts declared. */
  authored: number;
  declared: number;
  artifacts: JourneyArtifact[];
  approvals: JourneyApproval[];
}

export interface JourneyArtifact {
  id: string;
  phaseId: string;
  /** Engine subject used for initiative approval; null for phase-approved Story artifacts. */
  subjectId: string | null;
  label: string;
  status: string;
  required: boolean;
  path: string;
  sha256: string | null;
  approvable: boolean;
  approvals: JourneyApproval[];
}

export interface JourneyPack {
  id: string;
  label: string;
  complete: number;
  total: number;
  /** What the gate says this pack is waiting on, when it says anything. */
  waitingOn: string | null;
  approved: boolean;
}

export interface Journey {
  kind: 'story' | 'initiative';
  id: string;
  title: string;
  profile: string;
  branch: string | null;
  status: string;
  stages: JourneyStage[];
  currentStage: JourneyStage | null;
  /** The phase selected in the rail; current by default, but never confused with current. */
  selectedStage: JourneyStage | null;
  artifacts: JourneyArtifact[];
  approvals: JourneyApproval[];
  packs: JourneyPack[];
  /** Pinned intake sources, which are what requirements are allowed to cite. */
  sources: Array<{ id: string; name: string; sha256: string | null }>;
  repositories: Array<{ id: string; stories: Array<{ id: string; title: string; blocking: boolean }> }>;
  /** Blocking reasons from the phase gate, verbatim. */
  blockers: string[];
  nextAction: { command: string; reason: string } | null;
  /** Set when there is nothing to render, with the reason. */
  empty: string | null;
}

const EMPTY: Journey = {
  kind: 'story', id: '', title: '', profile: '', branch: null, status: '',
  stages: [], currentStage: null, selectedStage: null, artifacts: [], approvals: [], packs: [], sources: [],
  repositories: [], blockers: [], nextAction: null, empty: 'Nothing governed is checked out on this branch.'
};

/**
 * Pull each pack's chain position out of the gate's own words.
 *
 * The gate already composes these — "artifact pack X has waiting on Executive Decisioning (0/1) for
 * exact pack abc123" — and re-deriving the chain state here would be a second implementation of
 * approvalChainProgress that could disagree with the one that actually blocks the phase. Reading the
 * engine's sentence keeps one source of truth, at the cost of a regex; where the sentence does not
 * parse, the pack simply reports no waiting-on rather than a guess.
 */
function waitingOnByPack(blockers: string[]): Map<string, string> {
  const waiting = new Map<string, string>();
  for (const blocker of blockers) {
    const match = /artifact pack (\S+) has (.+?) for exact pack/.exec(blocker);
    if (match?.[1] && match[2]) waiting.set(match[1], match[2]);
  }
  return waiting;
}

export function buildJourney(snapshot: RepositorySnapshot | null, selectedStageId: string | null = null): Journey {
  if (!snapshot) return { ...EMPTY, empty: 'Reading the repository…' };
  if (snapshot.workflow) return storyJourneyOf(snapshot, snapshot.workflow, selectedStageId);
  const initiative = snapshot.initiative;
  if (!initiative) {
    return {
      ...EMPTY,
      empty: snapshot.initiatives?.length
        ? 'Nothing governed is checked out on this branch. Check out an Epic branch to see its journey.'
        : 'No work has been started in this repository yet.'
    };
  }
  return initiativeJourneyOf(initiative, selectedStageId);
}

function selectedStageFrom(stages: JourneyStage[], selectedStageId: string | null): JourneyStage | null {
  return stages.find((stage) => stage.id === selectedStageId)
    ?? stages.find((stage) => stage.current)
    ?? [...stages].reverse().find((stage) => stage.approved)
    ?? stages[0]
    ?? null;
}

function approvalActor(approval: StoryApproval): string {
  return approval.actor?.name?.trim()
    || approval.actor?.email?.trim()
    || approval.actor?.login?.trim()
    || 'Unknown reviewer';
}

function activeStoryApprovals(phaseApprovals: StoryApproval[]): JourneyApproval[] {
  const seen = new Set<string>();
  return phaseApprovals
    .filter((approval) => approval.decision === 'approved' && !approval.invalidatedAt)
    .map((approval) => ({
      actor: approvalActor(approval),
      at: approval.at ?? null,
      authority: approval.authorityGroup ?? null
    }))
    .filter((approval) => {
      const key = `${approval.actor.toLowerCase()}\0${approval.authority ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function storyArtifacts(snapshot: RepositorySnapshot, workflow: StoryWorkflow, phaseId: string): JourneyArtifact[] {
  const phase = workflow.phases[phaseId];
  if (!phase) return [];
  const approvals = activeStoryApprovals(phase.approvals ?? []);
  const catalog = (snapshot.documents ?? []).filter((artifact) => artifact.phase === phaseId && artifact.path);
  const records: StoryArtifact[] = catalog.length ? catalog : (phase.artifacts ?? []);
  return records.map((artifact, index) => ({
    id: `story:${phaseId}:${artifact.id ?? index}`,
    phaseId,
    subjectId: null,
    label: artifact.label ?? artifact.path.split('/').at(-1) ?? artifact.path,
    status: artifact.status ?? phase.status,
    required: artifact.path === phase.requiredArtifact?.path
      || artifact.path.endsWith(`/${phase.requiredArtifact?.path ?? ''}`),
    path: artifact.path,
    sha256: artifact.sha256 ?? null,
    // Story approval is phase-bound. The approval surface owns that guarded mutation.
    approvable: false,
    approvals
  })).sort((left, right) => left.label.localeCompare(right.label));
}

function storyJourneyOf(
  snapshot: RepositorySnapshot,
  workflow: StoryWorkflow,
  selectedStageId: string | null
): Journey {
  const stages: JourneyStage[] = workflow.phaseOrder
    .map((phaseId) => workflow.phases[phaseId])
    .filter((phase): phase is NonNullable<typeof phase> => Boolean(phase))
    .map((phase) => {
      const artifacts = storyArtifacts(snapshot, workflow, phase.id);
      return {
        id: phase.id,
        label: phase.label,
        status: phase.status,
        current: workflow.currentPhase === phase.id,
        approved: phase.status === 'approved',
        authored: artifacts.filter((artifact) => artifact.sha256).length,
        declared: Math.max(artifacts.length, phase.requiredArtifact ? 1 : 0),
        artifacts,
        approvals: activeStoryApprovals(phase.approvals ?? [])
      };
    });
  const currentStage = stages.find((stage) => stage.current) ?? null;
  const selectedStage = selectedStageFrom(stages, selectedStageId);
  return {
    kind: 'story',
    id: workflow.workItem.id,
    title: workflow.workItem.title ?? workflow.workItem.id,
    profile: workflow.workItem.workType ?? 'Story',
    branch: workflow.workItem.branch ?? null,
    status: workflow.status ?? 'in_progress',
    stages,
    currentStage,
    selectedStage,
    artifacts: selectedStage?.artifacts ?? [],
    approvals: selectedStage?.approvals ?? [],
    packs: [],
    sources: [],
    repositories: [],
    blockers: [],
    nextAction: null,
    empty: null
  };
}

interface InitiativeApprovalRecord {
  phase?: string;
  subjectType?: string;
  subjectId?: string;
  actorEmail?: string;
  at?: string;
  authorityGroup?: string;
  decision?: string;
}

function initiativeJourneyOf(initiative: InitiativeSnapshot, selectedStageId: string | null): Journey {
  const { state } = initiative;
  const blockers = initiative.phaseGate?.ready ? [] : (initiative.phaseGate?.errors ?? []);
  const waiting = waitingOnByPack(blockers);

  const approvalRecords = Object.values((initiative.report as {
    approvals?: { byPhase?: Record<string, InitiativeApprovalRecord[]> }
  } | undefined)?.approvals?.byPhase ?? {}).flat();

  const stages: JourneyStage[] = phasesInOrder(initiative).map((phase) => {
    const artifacts: JourneyArtifact[] = phase.outputs.map((output) => {
      const approvals = approvalRecords
        .filter((approval) => approval.phase === phase.id
          && approval.subjectType === 'output'
          && approval.subjectId === output.id
          && approval.decision !== 'rejected'
          && Boolean(approval.actorEmail))
        .map((approval) => ({
          actor: approval.actorEmail ?? 'Unknown reviewer',
          at: approval.at ?? null,
          authority: approval.authorityGroup ?? null
        }));
      return {
        id: `initiative:${phase.id}:${output.id}`,
        phaseId: phase.id,
        subjectId: output.id,
        label: output.label ?? output.id,
        status: output.status,
        required: output.required !== false,
        path: output.path,
        sha256: output.sha256,
        approvable: Boolean(output.sha256) && output.status !== 'approved',
        approvals
      };
    }).sort((left, right) => left.label.localeCompare(right.label));
    const approvals = approvalRecords
      .filter((approval) => approval.phase === phase.id
        && approval.decision !== 'rejected'
        && Boolean(approval.actorEmail))
      .map((approval) => ({
        actor: approval.actorEmail ?? 'Unknown reviewer',
        at: approval.at ?? null,
        authority: approval.authorityGroup ?? null
      }));
    return {
      id: phase.id,
      label: phase.label,
      status: phase.status,
      current: phase.current,
      approved: phase.status === 'approved',
      authored: phase.outputs.filter((output) => output.sha256).length,
      declared: phase.outputs.length,
      artifacts,
      approvals
    };
  });

  const currentStage = stages.find((stage) => stage.current) ?? null;
  const selectedStage = selectedStageFrom(stages, selectedStageId);

  const packs: JourneyPack[] = packsWithMembers(initiative).map((pack) => {
    const complete = pack.members.filter((member) => member.authored).length;
    return {
      id: pack.id,
      label: pack.label,
      complete,
      total: pack.members.length,
      waitingOn: waiting.get(pack.id) ?? null,
      // A pack whose members all exist and which the gate is not complaining about has been signed
      // off; the gate is the authority on that, not a count of approval records this view cannot see.
      approved: complete === pack.members.length && !waiting.has(pack.id)
    };
  });

  const rawSources = (initiative.sources?.sources ?? []) as Array<Record<string, unknown>>;
  const sources = rawSources.map((source) => ({
    id: String(source.sourceId ?? source.id ?? ''),
    name: String(source.name ?? source.sourceId ?? 'unnamed source'),
    sha256: typeof source.sha256 === 'string' ? source.sha256 : null
  }));

  const next = initiative.nextActions?.[0] ?? null;

  return {
    kind: 'initiative',
    id: state.initiative.id,
    title: state.initiative.title ?? state.initiative.id,
    profile: state.resolution.profile,
    branch: state.initiative.branch ?? null,
    status: state.status ?? 'in_progress',
    stages,
    currentStage,
    selectedStage,
    artifacts: selectedStage?.artifacts ?? [],
    approvals: selectedStage?.approvals ?? [],
    packs,
    sources,
    repositories: storiesByRepository(initiative).map((entry) => ({
      id: entry.repository,
      stories: entry.stories.map((story) => ({
        id: story.workId || story.id,
        title: story.title,
        blocking: story.blocking
      }))
    })),
    blockers,
    nextAction: next ? { command: next.command, reason: next.reason } : null,
    empty: null
  };
}
