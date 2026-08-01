/**
 * Stories: what the Epic decomposed into, and where each piece landed.
 *
 * The lineage is the point. An Epic is a parent capability; each Story is a child that lives in one
 * repository, carries a named subset of the Epic's requirements, and eventually merges back. Reading
 * that as a flat list loses the two things worth knowing — which repository a Story belongs to, and
 * what it is waiting on — so this groups by repository and keeps the dependency edges.
 *
 * A planned Story and a materialized one are different things and are not conflated. Before
 * materialization a Story is an intention: an identifier, a repository, an allocation of
 * requirements. After it, it is also a branch with a head commit and a phase. Showing an intention
 * as though it had a branch would be the more expensive of the two mistakes.
 */
import type { BreakdownStory, DesktopSnapshot, InitiativeSnapshot } from '../cli/snapshot.ts';

export type StoryState = 'planned' | 'seeded' | 'in-progress' | 'complete' | 'merged' | 'blocked';

export interface StoryView {
  planId: string;
  /** The identifier the child repository knows it by; equals planId until Jira re-keys it. */
  workId: string;
  title: string;
  repository: string;
  blocking: boolean;
  requirements: string[];
  acceptanceCriteria: string[];
  dependsOn: string[];
  /** Stories that wait for this one — the other half of each edge, which the plan does not store. */
  blocks: string[];
  state: StoryState;
  /** Present only once materialized. */
  branch: string | null;
  head: string | null;
  atSeed: boolean;
  phase: string | null;
  stale: boolean;
  /** Conformance is the strongest statement a Story makes about its own code. */
  conformance: { status: string; treeSha256: string | null } | null;
}

export interface RepositoryGroup {
  repository: string;
  stories: StoryView[];
}

export interface Stories {
  initiativeId: string;
  title: string;
  /** Whether the plan has been pushed into the child repositories yet. */
  materialized: boolean;
  planned: number;
  groups: RepositoryGroup[];
  /** Cross-repository ordering, as the merge sequence sees it. */
  order: string[];
  empty: string | null;
}

function stateOf(story: BreakdownStory, child: Record<string, unknown> | undefined): StoryState {
  if (!child) return 'planned';
  if (child.blocked === true) return 'blocked';
  const status = String(child.status ?? 'seeded');
  if (status === 'complete' || status === 'merged') return status as StoryState;
  return child.currentPhase ? 'in-progress' : 'seeded';
}

export function buildStories(snapshot: DesktopSnapshot | null): Stories {
  const nothing = (empty: string): Stories => ({
    initiativeId: '', title: '', materialized: false, planned: 0, groups: [], order: [], empty
  });
  if (!snapshot) return nothing('Reading the repository…');
  const initiative = snapshot.initiative;
  if (!initiative) return nothing('No Epic is checked out on this branch.');

  const stories = initiative.breakdown?.stories ?? [];
  if (!stories.length) {
    return {
      ...nothing('This Epic has no Story plan yet. Planning decomposes it into Stories, one per repository.'),
      initiativeId: initiative.state.initiative.id,
      title: initiative.state.initiative.title ?? initiative.state.initiative.id
    };
  }
  return storiesOf(initiative, stories);
}

function storiesOf(initiative: InitiativeSnapshot, stories: BreakdownStory[]): Stories {
  const children = (initiative.state.childStories ?? {}) as Record<string, Record<string, unknown>>;

  // The plan records what each Story waits for; who waits on it is just as useful and has to be
  // derived, because nothing stores the reverse edge.
  const blocks = new Map<string, string[]>();
  for (const story of stories) {
    for (const dependency of story.dependsOn ?? []) {
      const existing = blocks.get(dependency.story);
      if (existing) existing.push(story.planId);
      else blocks.set(dependency.story, [story.planId]);
    }
  }

  const views: StoryView[] = stories.map((story) => {
    const child = children[story.planId] ?? children[story.id];
    const conformance = (child?.conformance ?? null) as { status?: string; treeSha256?: string | null } | null;
    const head = child ? String(child.observedCommit ?? '') : '';
    return {
      planId: story.planId,
      workId: story.workId || story.planId,
      title: story.title,
      repository: story.repository,
      blocking: story.blocking !== false,
      requirements: story.requirements ?? [],
      acceptanceCriteria: story.acceptanceCriteria ?? [],
      dependsOn: (story.dependsOn ?? []).map((dependency) => dependency.story),
      blocks: blocks.get(story.planId) ?? [],
      state: stateOf(story, child),
      branch: child ? String(child.branch ?? story.workId) : null,
      head: head || null,
      atSeed: Boolean(head) && head === String(child?.seedCommit ?? ''),
      phase: child?.currentPhase ? String(child.currentPhase) : null,
      stale: child?.stale === true,
      conformance: conformance
        ? { status: String(conformance.status ?? 'unknown'), treeSha256: conformance.treeSha256 ?? null }
        : null
    };
  });

  const grouped = new Map<string, StoryView[]>();
  for (const view of views) {
    const existing = grouped.get(view.repository);
    if (existing) existing.push(view);
    else grouped.set(view.repository, [view]);
  }

  return {
    initiativeId: initiative.state.initiative.id,
    title: initiative.state.initiative.title ?? initiative.state.initiative.id,
    materialized: views.some((view) => view.state !== 'planned'),
    planned: views.length,
    groups: [...grouped.entries()]
      .map(([repository, entries]) => ({ repository, stories: entries }))
      .sort((left, right) => left.repository.localeCompare(right.repository)),
    order: mergeOrder(views),
    empty: null
  };
}

/**
 * A dependency-respecting order, which is what decides the sequence repositories must land in.
 *
 * The plan's graph is already proved acyclic by validateInitiativeBreakdown, so a topological order
 * always exists; ties break by identifier so the sequence is the same every time it is read.
 */
function mergeOrder(views: StoryView[]): string[] {
  const byId = new Map(views.map((view) => [view.planId, view]));
  const ordered: string[] = [];
  const visited = new Set<string>();

  const visit = (planId: string): void => {
    if (visited.has(planId)) return;
    visited.add(planId);
    const view = byId.get(planId);
    if (!view) return;
    for (const dependency of [...view.dependsOn].sort()) visit(dependency);
    ordered.push(planId);
  };

  for (const planId of views.map((view) => view.planId).sort()) visit(planId);
  return ordered;
}
