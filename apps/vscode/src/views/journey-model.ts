/**
 * The journey, as data: where an Epic stands and what it is waiting for.
 *
 * The tree answers "what exists". This answers "what is happening" — the question someone actually
 * opens a governance tool to ask. It is the PDLC read left to right: intake and pinned sources, the
 * phase rail, the artifacts of the phase you are standing in, the control-plane chain each pack is
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
  type RepositorySnapshot, type InitiativeSnapshot, type PhaseStatus
} from '../cli/snapshot.ts';

export interface JourneyStage {
  id: string;
  label: string;
  status: PhaseStatus;
  current: boolean;
  approved: boolean;
  /** Artifacts generated / artifacts declared. */
  authored: number;
  declared: number;
}

export interface JourneyArtifact {
  id: string;
  label: string;
  status: string;
  required: boolean;
  path: string;
  sha256: string | null;
  approvable: boolean;
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
  id: string;
  title: string;
  profile: string;
  branch: string | null;
  status: string;
  stages: JourneyStage[];
  currentStage: JourneyStage | null;
  artifacts: JourneyArtifact[];
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
  id: '', title: '', profile: '', branch: null, status: '',
  stages: [], currentStage: null, artifacts: [], packs: [], sources: [],
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

export function buildJourney(snapshot: RepositorySnapshot | null): Journey {
  if (!snapshot) return { ...EMPTY, empty: 'Reading the repository…' };
  const initiative = snapshot.initiative;
  if (!initiative) {
    return {
      ...EMPTY,
      empty: snapshot.initiatives?.length
        ? 'Nothing governed is checked out on this branch. Check out an Epic branch to see its journey.'
        : 'No work has been started in this repository yet.'
    };
  }
  return journeyOf(initiative);
}

function journeyOf(initiative: InitiativeSnapshot): Journey {
  const { state } = initiative;
  const blockers = initiative.phaseGate?.ready ? [] : (initiative.phaseGate?.errors ?? []);
  const waiting = waitingOnByPack(blockers);

  const stages: JourneyStage[] = phasesInOrder(initiative).map((phase) => ({
    id: phase.id,
    label: phase.label,
    status: phase.status,
    current: phase.current,
    approved: phase.status === 'approved',
    authored: phase.outputs.filter((output) => output.sha256).length,
    declared: phase.outputs.length
  }));

  const currentStage = stages.find((stage) => stage.current) ?? null;
  const currentPhase = currentStage ? state.phases[currentStage.id] : null;

  const artifacts: JourneyArtifact[] = Object.values(currentPhase?.outputs ?? {})
    .map((output) => ({
      id: output.id,
      label: output.label ?? output.id,
      status: output.status,
      required: output.required !== false,
      path: output.path,
      sha256: output.sha256,
      approvable: Boolean(output.sha256) && output.status !== 'approved'
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

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
    id: state.initiative.id,
    title: state.initiative.title ?? state.initiative.id,
    profile: state.resolution.profile,
    branch: state.initiative.branch ?? null,
    status: state.status ?? 'in_progress',
    stages,
    currentStage,
    artifacts,
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
