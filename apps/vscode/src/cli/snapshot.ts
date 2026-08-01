/**
 * Types over `desktop snapshot --json`, plus the small accessors the views need.
 *
 * These describe what the extension reads, not everything the snapshot carries. The snapshot is a
 * large object serving a whole desktop application; mirroring all of it here would create a second
 * schema that drifts from src/desktop.mjs the first time either changes, and a type that lies is
 * worse than one that admits it does not know. Unread regions stay `unknown`, so touching them is a
 * compile error that forces a look at the engine rather than a guess.
 *
 * Every accessor tolerates absence. A snapshot legitimately has no selected initiative, no
 * breakdown, and no world model, and each of those is a normal state to render rather than an error.
 */

/**
 * Phase and artifact status vocabularies are the engine's, not this extension's.
 *
 * They are typed as a union of the known values *plus* string, deliberately. A closed union would
 * make an engine that adds a status a compile error here, which sounds like a good alarm but is the
 * wrong one: the extension is a reader, and a reader that refuses to render an unfamiliar state is
 * worse than one that renders it plainly. Every lookup below falls back rather than producing
 * `undefined`, which is what a closed Record silently did — later phases showed no icon at all
 * because the real value is `not_started` and this file had guessed `pending`.
 */
export type PhaseStatus =
  | 'not_started' | 'in_progress' | 'awaiting_approval' | 'approved' | 'rejected' | 'stale'
  | (string & {});

/** `not_generated` before a phase runs, `published` once it has, `approved` once it is signed off. */
export type OutputStatus =
  | 'not_generated' | 'draft' | 'published' | 'awaiting_approval' | 'approved' | 'rejected' | 'stale'
  | (string & {});

export interface InitiativeOutput {
  id: string;
  label: string;
  kind: string;
  /** Relative to the initiative directory in phase state; already repository-relative in `documents`. */
  path: string;
  repositoryPath?: string;
  phase?: string;
  required: boolean;
  status: OutputStatus;
  generation: number;
  sha256: string | null;
  bytes?: number | null;
  generatedBy?: string | null;
  generatedPersona?: string | null;
  /** Present only on `initiative.documents`, where renderable artifacts are inlined. */
  content?: string | null;
}

export interface InitiativePhase {
  id: string;
  label: string;
  order: number;
  status: PhaseStatus;
  startedAt?: string | null;
  submittedAt?: string | null;
  approvedAt?: string | null;
  generation: number;
  outputs: Record<string, InitiativeOutput>;
  checklist?: Record<string, unknown>;
  invalidatedBy?: string | null;
}

export interface ApprovalPolicy {
  mode: string;
  authorities: string[] | null;
  minimum: number;
  allowSelfApproval: boolean;
  chain: Array<{ authority: string; minimum: number }> | null;
}

export interface InitiativeResolutionPhase {
  id: string;
  label: string;
  order: number;
  lanes?: unknown;
  worldModelViews?: string[];
  outputs: Array<{
    id: string;
    label: string;
    kind: string;
    path: string;
    required: boolean;
    approval?: ApprovalPolicy;
  }>;
  checklist?: Array<{ id: string; label?: string }>;
  bundleApproval?: ApprovalPolicy;
}

export interface InitiativeState {
  initiative: { id: string; title?: string; branch?: string; createdAt?: string };
  currentPhase: string | null;
  phaseOrder: string[];
  phases: Record<string, InitiativePhase>;
  status?: string;
  resolution: {
    profile: string;
    phases: InitiativeResolutionPhase[];
    packs?: Array<{ id: string; label?: string; members: string[] }>;
    worldModelGrounding?: 'off' | 'warn' | 'enforce';
    [key: string]: unknown;
  };
  history?: Array<{ event: string; detail?: string; at?: string }>;
  childStories?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BreakdownStory {
  id: string;
  planId: string;
  workId: string;
  title: string;
  repository: string;
  epicId: string;
  blocking: boolean;
  dependsOn: Array<{ story: string; requiredPhase: string }>;
}

export interface InitiativeBreakdown {
  version: 1 | 2;
  initiativeId: string | null;
  epics: Array<{ id: string; planId: string; title: string; stories: BreakdownStory[] }>;
  stories: BreakdownStory[];
}

export interface NextAction {
  action: string;
  command: string;
  /** Why the engine is asking for this, shown as-is: it is already written for a human. */
  reason: string;
}

export interface InitiativeSnapshot {
  state: InitiativeState;
  progress?: unknown;
  breakdown: InitiativeBreakdown | null;
  materialization?: unknown;
  report?: unknown;
  phaseGate: {
    ready: boolean;
    errors: string[];
    warnings: string[];
    passes: string[];
    bundleSha256?: string;
    checklist?: unknown;
  } | null;
  nextActions: NextAction[];
  journey?: unknown;
  phaseWork?: unknown;
  outputChoicesByPhase?: Record<string, {
    editable: boolean;
    choices: Array<{ id: string; label: string; required: boolean; included: boolean; authored: boolean }>;
  }>;
  sources?: { version: number; initiativeId: string; sources: unknown[]; jiraSnapshot?: unknown };
  documents: InitiativeOutput[];
  delivery?: unknown;
  [key: string]: unknown;
}

export interface WorkItemSummary {
  id: string;
  branch?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

export interface InitiativeSummary {
  id: string;
  branch?: string;
  title?: string;
  status?: string;
  profile?: string;
  [key: string]: unknown;
}

export interface DesktopSnapshot {
  repository?: { root?: string; branch?: string; [key: string]: unknown };
  workItems: WorkItemSummary[];
  initiatives: InitiativeSummary[];
  selectedWorkId: string | null;
  selectedInitiativeId: string | null;
  initiative: InitiativeSnapshot | null;
  workflow: unknown;
  documents?: unknown[];
  worldModel?: {
    root: string;
    generatedAt: string | null;
    rebuildReason: string | null;
    views: Array<{ id: string; references: string[] }>;
    files?: Array<{ path: string; content?: string }>;
  };
  session?: { persona?: string; workId?: string | null } | null;
  diagnostics?: unknown;
  [key: string]: unknown;
}

/** The phases in declared order, joined to the state each one is in. */
export function phasesInOrder(initiative: InitiativeSnapshot): Array<{
  id: string;
  label: string;
  status: PhaseStatus;
  current: boolean;
  outputs: InitiativeOutput[];
}> {
  const { state } = initiative;
  return state.phaseOrder.map((id) => {
    const phase = state.phases[id];
    return {
      id,
      label: phase?.label ?? id,
      status: phase?.status ?? 'pending',
      current: state.currentPhase === id,
      outputs: Object.values(phase?.outputs ?? {})
    };
  });
}

/**
 * Packs, joined to the outputs they contain.
 *
 * Members are `<phase>/<output>`, and a member may legitimately not be authored yet — that is the
 * normal state before a phase runs, so a missing output is reported as absent rather than skipped.
 */
export function packsWithMembers(initiative: InitiativeSnapshot): Array<{
  id: string;
  label: string;
  members: Array<{ phase: string; output: string; authored: boolean; artifact: InitiativeOutput | null }>;
}> {
  const packs = initiative.state.resolution.packs ?? [];
  return packs.map((pack) => ({
    id: pack.id,
    label: pack.label ?? pack.id,
    members: pack.members.map((member) => {
      const separator = member.indexOf('/');
      const phase = separator < 0 ? member : member.slice(0, separator);
      const output = separator < 0 ? '' : member.slice(separator + 1);
      const artifact = initiative.state.phases[phase]?.outputs?.[output] ?? null;
      return { phase, output, authored: Boolean(artifact?.sha256), artifact };
    })
  }));
}

/** Stories grouped by the repository they land in, matching how `epic impact` reports them. */
export function storiesByRepository(initiative: InitiativeSnapshot): Array<{ repository: string; stories: BreakdownStory[] }> {
  const stories = initiative.breakdown?.stories ?? [];
  const grouped = new Map<string, BreakdownStory[]>();
  for (const story of stories) {
    const existing = grouped.get(story.repository);
    if (existing) existing.push(story);
    else grouped.set(story.repository, [story]);
  }
  return [...grouped.entries()]
    .map(([repository, entries]) => ({ repository, stories: entries }))
    .sort((left, right) => left.repository.localeCompare(right.repository));
}

/**
 * True when editing this artifact in place would break something.
 *
 * An approved artifact is pinned by hash into a bundle and into whatever consumed it downstream, so
 * editing it silently invalidates approvals that already happened. A merely *generated* artifact is
 * still being worked on — that is exactly when a human should be able to correct it — so it stays
 * writable. The distinction is the phase's own record, not a guess from the file.
 */
export function isApprovalPinned(output: InitiativeOutput): boolean {
  return output.status === 'approved' && Boolean(output.sha256);
}
