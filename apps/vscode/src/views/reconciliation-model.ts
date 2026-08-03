/**
 * Reconciliation: whether the four things that are supposed to agree actually do.
 *
 * An Epic is a claim made in several places at once — a plan, a set of Story branches, the code in
 * each repository, and the contracts between them. Each can drift from the others independently, and
 * the expensive failures are the ones where nobody noticed they had. These are the four levels:
 *
 *   1. child branch → Story   the commit a Story branch is on versus the one it was seeded with
 *   2. Story → Epic           which Stories actually count toward the Epic being done
 *   3. cross-repository       the order repositories must land in, and what is blocking
 *   4. spec ↔ code            contract snapshots versus what consumers observed
 *
 * The load-bearing rule here is that "no data" is never reported as "aligned". An Epic that has not
 * been materialized has no branches to compare, and saying its branches agree would be the most
 * dangerous sentence this view could produce. Every level therefore has an explicit
 * `notApplicable` state carrying the reason, distinct from `aligned`.
 *
 * No `vscode` import: the whole model is testable in a plain Node process.
 */
import type { RepositorySnapshot, InitiativeSnapshot } from '../cli/snapshot.ts';

export type Verdict = 'aligned' | 'drifted' | 'not-applicable';

export interface ReconciliationRow {
  id: string;
  /** Columns, already stringified for display; the model decides what is worth showing. */
  cells: string[];
  drifted: boolean;
  detail?: string;
}

export interface ReconciliationLevel {
  id: 'branches' | 'stories' | 'repositories' | 'conformance';
  label: string;
  question: string;
  verdict: Verdict;
  /** Why this level cannot be judged, when it cannot. */
  reason: string | null;
  columns: string[];
  rows: ReconciliationRow[];
  /** What would resolve the drift, in the engine's own terms where it has said. */
  remedy: string | null;
}

export interface Reconciliation {
  initiativeId: string;
  levels: ReconciliationLevel[];
  /** Set when there is no Epic at all. */
  empty: string | null;
}

/** The merge plan, which needs its own CLI call — `epic merge-plan --json`. */
export interface MergePlan {
  initiativeId?: string;
  epicBranch?: string;
  stories?: Array<{
    order: number; id: string; workId: string; repository: string;
    blocking: boolean; status: string; blockedBy: string[];
  }>;
  nextToMerge?: { workId: string } | null;
  epicReady?: boolean;
  outstanding?: string[];
  unreachable?: string[];
}

function level(
  id: ReconciliationLevel['id'],
  label: string,
  question: string,
  columns: string[],
  rows: ReconciliationRow[],
  { reason = null, remedy = null }: { reason?: string | null; remedy?: string | null } = {}
): ReconciliationLevel {
  const verdict: Verdict = reason ? 'not-applicable' : rows.some((row) => row.drifted) ? 'drifted' : 'aligned';
  return { id, label, question, verdict, reason, columns, rows, remedy };
}

/** 1. Has a Story branch moved away from what the Epic seeded it with? */
function branchLevel(initiative: InitiativeSnapshot): ReconciliationLevel {
  const children = Object.entries(initiative.state.childStories ?? {}) as Array<[string, Record<string, unknown>]>;
  if (!children.length) {
    return level('branches', 'Child branch → Story',
      'Is each Story branch still on the work the Epic seeded it with?', [], [], {
        reason: 'No Story branch has been materialized yet, so there is nothing to compare.',
        remedy: 'singularity-flow initiative materialize'
      });
  }

  const rows = children.map(([id, story]) => {
    const seed = String(story.seedCommit ?? '');
    const observed = String(story.observedCommit ?? '');
    const stale = story.stale === true;
    // Moving on from the seed is normal — that *is* the work. Drift here means the Epic's record of
    // the branch is stale, or the branch was never observed at all.
    const unobserved = !observed;
    return {
      id,
      cells: [
        String(story.workId ?? id),
        String(story.repository ?? '—'),
        String(story.status ?? 'unknown'),
        String(story.currentPhase ?? '—'),
        unobserved ? 'never observed' : observed === seed ? 'at seed' : `${observed.slice(0, 8)} (moved on)`
      ],
      drifted: stale || unobserved,
      ...(stale ? { detail: 'The Epic\'s record of this branch is stale; sync to re-observe it.' } : {})
    };
  });

  return level('branches', 'Child branch → Story',
    'Is each Story branch still on the work the Epic seeded it with?',
    ['Story', 'Repository', 'Status', 'Phase', 'Head'], rows, {
      remedy: rows.some((row) => row.drifted) ? 'singularity-flow initiative sync' : null
    });
}

/** 2. Which Stories actually count toward the Epic being done? */
function storyLevel(initiative: InitiativeSnapshot): ReconciliationLevel {
  const delivery = initiative.delivery as {
    stories?: Array<{ id?: string; workId?: string; repository?: string; ready?: boolean; blocking?: boolean; reason?: string }>;
    blockers?: string[];
    materialized?: boolean;
  } | null | undefined;

  if (!delivery) {
    return level('stories', 'Story → Epic',
      'Which Stories still stand between this Epic and done?', [], [], {
        reason: 'This profile does not track Epic delivery readiness.'
      });
  }
  if (!delivery.stories?.length) {
    return level('stories', 'Story → Epic',
      'Which Stories still stand between this Epic and done?', [], [], {
        reason: delivery.materialized === false
          ? 'The Story plan has not been materialized, so no Story can be ready yet.'
          : 'This Epic has no Stories.',
        remedy: 'singularity-flow initiative materialize'
      });
  }

  const rows = delivery.stories.map((story) => ({
    id: String(story.id ?? story.workId ?? ''),
    cells: [
      String(story.workId ?? story.id ?? ''),
      String(story.repository ?? '—'),
      story.blocking === false ? 'non-blocking' : 'blocking',
      story.ready ? 'ready' : 'not ready'
    ],
    drifted: story.blocking !== false && !story.ready,
    ...(story.reason ? { detail: story.reason } : {})
  }));

  return level('stories', 'Story → Epic',
    'Which Stories still stand between this Epic and done?',
    ['Story', 'Repository', 'Gates the Epic?', 'Readiness'], rows, {
      remedy: delivery.blockers?.length ? delivery.blockers.join('; ') : null
    });
}

/** 3. In what order must repositories land, and what is blocking? */
function repositoryLevel(plan: MergePlan | null): ReconciliationLevel {
  if (!plan?.stories?.length) {
    return level('repositories', 'Cross-repository',
      'In what order must these repositories land, and what is blocking?', [], [], {
        reason: plan
          ? 'This Epic has no Story plan to sequence.'
          : 'The merge plan has not been read yet.'
      });
  }

  const rows = plan.stories.map((story) => ({
    id: story.id,
    cells: [
      String(story.order),
      story.workId,
      story.repository,
      story.blocking ? 'blocking' : 'non-blocking',
      story.status === 'blocked' ? `blocked by ${story.blockedBy.join(', ')}` : story.status
    ],
    // Only a blocking Story that has not merged is drift at this level; the rest is normal progress.
    drifted: story.blocking && story.status !== 'merged'
  }));

  const remedy = plan.epicReady
    ? null
    : plan.nextToMerge
      ? `Next to merge: ${plan.nextToMerge.workId} → ${plan.epicBranch ?? 'the Epic branch'}`
      : `Nothing is ready to merge. Outstanding: ${(plan.outstanding ?? []).join(', ') || 'none'}`;

  return level('repositories', 'Cross-repository',
    'In what order must these repositories land, and what is blocking?',
    ['#', 'Story', 'Repository', 'Gates the Epic?', 'Status'], rows, { remedy });
}

/** 4. Do the contracts the Epic published still match what its consumers built against? */
function conformanceLevel(initiative: InitiativeSnapshot): ReconciliationLevel {
  const contracts = (initiative.contracts ?? []) as Array<{
    key: string; id?: string; version?: string; sha256?: string; integrity?: string;
    consumers?: Array<{ storyId: string; repository: string | null; stale: boolean; observedContractSha256: string | null }>;
  }>;
  const completion = (initiative.state as { delivery?: { completion?: { reportPath?: string; sha256?: string } } })
    .delivery?.completion ?? null;

  // Each Story that has reached its conformance phase carries the tree hash its code was checked
  // against. That is the most direct spec-versus-code evidence this system holds, so it belongs
  // here alongside the contracts rather than only in the Story's own workflow.
  const children = Object.values(initiative.state.childStories ?? {}) as Array<Record<string, unknown>>;
  const storyRows: ReconciliationRow[] = children
    .filter((story) => story.conformance)
    .map((story) => {
      const conformance = story.conformance as { status?: string; treeSha256?: string | null };
      const passed = conformance.status === 'approved' || conformance.status === 'complete';
      return {
        id: `story:${String(story.workId ?? '')}`,
        cells: [
          'code conformance',
          '—',
          `${String(story.workId ?? '')}${story.repository ? ` (${String(story.repository)})` : ''}`,
          conformance.treeSha256
            ? `${passed ? 'conforms' : String(conformance.status ?? 'unknown')} @ ${String(conformance.treeSha256).slice(0, 8)}`
            : 'no conformance tree recorded'
        ],
        drifted: !passed || !conformance.treeSha256
      };
    });

  if (!contracts.length && !storyRows.length) {
    return level('conformance', 'Spec ↔ code',
      'Do the contracts this Epic published still match what was built against them?', [], [], {
        reason: 'This Epic declares no interface contracts, and no Story has reached its conformance phase.',
        ...(completion?.reportPath ? { remedy: `Spec-to-code completion report: ${completion.reportPath}` } : {})
      });
  }

  const rows: ReconciliationRow[] = contracts.flatMap((contract) => {
    const consumers = contract.consumers ?? [];
    if (!consumers.length) {
      return [{
        id: contract.key,
        cells: [contract.key, String(contract.version ?? '—'), '—', contract.integrity ?? 'unknown'],
        drifted: contract.integrity !== 'verified',
        detail: 'No Story consumes this contract yet.'
      }];
    }
    return consumers.map((consumer) => {
      // A consumer that built against a different hash than the contract now carries is the exact
      // spec-versus-code divergence this level exists to surface.
      const behind = Boolean(consumer.observedContractSha256)
        && Boolean(contract.sha256)
        && consumer.observedContractSha256 !== contract.sha256;
      return {
        id: `${contract.key}/${consumer.storyId}`,
        cells: [
          contract.key,
          String(contract.version ?? '—'),
          `${consumer.storyId}${consumer.repository ? ` (${consumer.repository})` : ''}`,
          contract.integrity !== 'verified' ? 'contract file changed'
            : behind ? 'built against an older version'
              : consumer.stale ? 'observation stale'
                : 'conforms'
        ],
        drifted: contract.integrity !== 'verified' || behind || consumer.stale
      };
    });
  });

  const all = [...rows, ...storyRows];
  return level('conformance', 'Spec ↔ code',
    'Do the contracts this Epic published still match what was built against them?',
    ['Contract', 'Version', 'Consumer', 'Conformance'], all, {
      remedy: all.some((row) => row.drifted) ? 'singularity-flow initiative sync' : null
    });
}

export function buildReconciliation(
  snapshot: RepositorySnapshot | null,
  mergePlan: MergePlan | null = null
): Reconciliation {
  if (!snapshot) return { initiativeId: '', levels: [], empty: 'Reading the repository…' };
  const initiative = snapshot.initiative;
  if (!initiative) {
    return {
      initiativeId: '',
      levels: [],
      empty: snapshot.initiatives?.length
        ? 'Nothing governed is checked out on this branch. Check out a governed branch to reconcile it.'
        : 'No work has been started in this repository yet.'
    };
  }

  return {
    initiativeId: initiative.state.initiative.id,
    levels: [
      branchLevel(initiative),
      storyLevel(initiative),
      repositoryLevel(mergePlan),
      conformanceLevel(initiative)
    ],
    empty: null
  };
}
