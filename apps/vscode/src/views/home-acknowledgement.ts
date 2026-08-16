/**
 * "Since you last checked", computed from two envelopes. `[DHR:REQ-024]` `[UXH:REQ-020]`
 *
 * A developer who opens the home twice a day is asking one question the current state cannot
 * answer: *what moved while I was gone?* The answer is a comparison, so something has to remember
 * where they were. Nothing in the envelope can — a result describes now — so the host keeps a
 * snapshot of the last home the reader said they had read, and this module diffs the two.
 *
 * ## Three answers, and the middle one is not the default
 *
 * `not-checked`, `compared` and `incomparable` are kept apart for the reason the checklist keeps
 * `unmet` and `unknown` apart `[UXH:REQ-062]`, and it is the same failure at a different altitude:
 *
 *   - **not-checked** — no acknowledgement exists. The honest heading is the current state, because
 *     a reader shown "since you last checked" reads the absence of a change list as *nothing
 *     changed*. This mirrors `return.current-state` in `work-return.mjs`, which chooses its framing
 *     the same way and for the same reason.
 *   - **compared** — both snapshots carry the facts, and either they differ or they do not. "Nothing
 *     changed" is a real finding and is said out loud.
 *   - **incomparable** — an acknowledgement exists and the comparison could not be made: the
 *     worktree was unreadable, or the revision came back without a commit, or the stored snapshot
 *     predates a field. *We could not compare* and *nothing changed* are opposite instructions —
 *     one sends the reader to look, the other tells them not to bother — and a delta that renders
 *     both as an empty change list gives the reassuring one to the case that has not earned it.
 *
 * This is the whole of why the feature was worth rebuilding rather than dropping: the delta is a
 * claim about the world, and a claim nobody could check must not be phrased like one that was.
 */

/**
 * What was true when the reader last said they had read it.
 *
 * Deliberately a flat record of primitives: it is written to `globalState`, survives restarts and
 * extension upgrades, and will be read by a build that does not exist yet. `version` is what lets
 * that build know it is looking at a snapshot it understands rather than guessing from which fields
 * happen to be present.
 */
export type HomeAcknowledgement = {
  readonly version: 1;
  readonly at: string;
  readonly workspaceId: string | null;
  readonly sourceCommit: string | null;
  /** Null is *clean*; absent (`undefined`) is *not read*. The two are never merged — see below. */
  readonly worktreeHash: string | null;
  readonly dirty: boolean | null;
  readonly activeWorkId: string | null;
  readonly activeWorkPhase: string | null;
};

export type HomeDelta = {
  readonly state: 'not-checked' | 'compared' | 'incomparable';
  /** When the reader last acknowledged, for the heading. Null before they ever have. */
  readonly at: string | null;
  /** One sentence per thing that moved. Empty on `compared` means nothing did. */
  readonly changes: readonly string[];
  /** Why no comparison was possible. Null unless `state` is `incomparable`. */
  readonly obstacle: string | null;
  readonly heading: string;
  readonly summary: string;
  /**
   * The button, or null when there is nothing worth remembering.
   *
   * A snapshot with no facts in it cannot ground a later comparison, so offering to store one would
   * be offering a button whose only effect is to move the reader from *not checked* to *could not
   * compare* — visibly worse, and caused by pressing the control that promised the opposite.
   */
  readonly action: { readonly id: string; readonly label: string } | null;
};

export const ACKNOWLEDGE_ACTION_ID = 'home:acknowledge';

/**
 * The facts a home envelope offers for comparison. `[INT:REQ-035]`
 *
 * Two sources, and which one holds what is not arbitrary. `subject.revision` carries what the
 * answer was computed *against* — the commit, the uncommitted bytes — because that is what a
 * revision is. `data` carries what the answer is *about* — the workspace, the active work — because
 * that is the projection the planner built. Reading a commit out of `data` would work today and
 * would be reading a lifecycle fact from the revision slot, which is the confusion `[INT:REQ-035]`
 * was written after.
 */
function factsOf(result: any): {
  workspaceId: string | null; sourceCommit: string | null;
  worktreeHash: string | null; dirty: boolean | null;
  activeWorkId: string | null; activeWorkPhase: string | null;
} {
  const local = result?.data?.localChanges;
  return {
    workspaceId: result?.data?.workspace?.id ?? null,
    sourceCommit: result?.subject?.revision?.sourceCommit ?? null,
    /**
     * `dirty` comes from the record, never from the hash.
     *
     * `worktreeHash` is null both for a clean tree and for a tree Git could not read, so deriving
     * dirtiness from it would report "your worktree is clean" on the strength of a failed
     * `git status`. The record is null only when nothing was read, and says `dirty: false` when a
     * read found nothing — which is the distinction this whole module is about.
     */
    worktreeHash: result?.subject?.revision?.worktreeHash ?? null,
    dirty: local ? Boolean(local.dirty) : null,
    activeWorkId: result?.data?.activeWork?.id ?? null,
    activeWorkPhase: result?.data?.activeWork?.phase ?? null
  };
}

/**
 * The snapshot to store for this envelope, or null if it holds nothing to compare against.
 *
 * A home read with no commit and no worktree answer is one where the repository could not be read
 * at all. Storing it would record the reader's position as "unknown", and every later home would
 * then be honestly but uselessly `incomparable` until they happened to press the button again on a
 * good read.
 */
export function homeAcknowledgementFor(result: any, now: () => Date = () => new Date()): HomeAcknowledgement | null {
  const facts = factsOf(result);
  if (!facts.sourceCommit && facts.dirty === null) return null;
  return Object.freeze({ version: 1, at: now().toISOString(), ...facts });
}

/** The `globalState` key. Per workspace and per actor, because a delta is personal to both. */
export function acknowledgementKey(workspaceId: string | null, actorId: string | null): string {
  return `sflow.home.ack.${workspaceId ?? 'unknown'}.${actorId ?? 'unknown'}`;
}

function shortCommit(commit: string | null): string {
  return commit ? commit.slice(0, 12) : 'unknown';
}

/**
 * What moved between two homes.
 *
 * Each comparison guards itself rather than trusting the caller's overall verdict: a snapshot may
 * carry a commit and not a worktree answer, and the half that can be compared still should be. A
 * field neither side can speak to produces no sentence, which is correct — silence about a fact
 * nobody read is honest, and it is the *heading* that has to tell the reader the list is partial.
 */
function changesBetween(before: HomeAcknowledgement, after: ReturnType<typeof factsOf>): string[] {
  const changes: string[] = [];

  if (before.sourceCommit && after.sourceCommit && before.sourceCommit !== after.sourceCommit) {
    changes.push(`the repository moved from ${shortCommit(before.sourceCommit)} to ${shortCommit(after.sourceCommit)}`);
  }

  if (before.activeWorkId !== after.activeWorkId) {
    changes.push(after.activeWorkId
      ? `the active Story is now ${after.activeWorkId}`
      : 'there is no active Story');
  } else if (before.activeWorkId && before.activeWorkPhase !== after.activeWorkPhase) {
    changes.push(`${after.activeWorkId} moved from ${before.activeWorkPhase ?? 'no phase'} to ${after.activeWorkPhase ?? 'no phase'}`);
  }

  /**
   * Dirtiness first, then the bytes.
   *
   * Both are worth saying and they are different events: clean-to-dirty is "you left changes here",
   * and dirty-to-still-dirty-but-different is "these are not the changes you left". The second is
   * the one a developer coming back to a shared machine most needs and is invisible from `dirty`
   * alone, so it is reported from the hash — but only when both sides actually have one.
   */
  if (before.dirty !== null && after.dirty !== null && before.dirty !== after.dirty) {
    changes.push(after.dirty ? 'the worktree now has uncommitted changes' : 'the worktree is now clean');
  } else if (before.dirty && after.dirty && before.worktreeHash && after.worktreeHash
    && before.worktreeHash !== after.worktreeHash) {
    changes.push('the uncommitted changes in the worktree are not the ones you left');
  }

  return changes;
}

/**
 * Which of the three answers this pair supports, and the words for it.
 *
 * The obstacle is named rather than generalised. "We could not compare" tells a reader the screen
 * failed; "the worktree could not be read, so a change there would not be listed" tells them what
 * to go and check, which is the difference between a disclosure and an apology.
 */
export function homeDelta(result: any, acknowledgement: HomeAcknowledgement | null): HomeDelta {
  const facts = factsOf(result);
  const storable = homeAcknowledgementFor(result) !== null;
  const action = storable
    ? { id: ACKNOWLEDGE_ACTION_ID, label: acknowledgement ? 'Update acknowledgement' : 'Mark as checked' }
    : null;

  if (!acknowledgement) {
    return Object.freeze({
      state: 'not-checked' as const,
      at: null,
      changes: [],
      obstacle: null,
      /** `return.current-state`'s framing, for the same reason it exists there `[DHR:REQ-024]`. */
      heading: 'Current state',
      summary: storable
        ? 'You have not marked this home as checked, so there is nothing to compare against yet.'
        : 'This repository could not be read, so there is nothing to compare against yet.',
      action
    });
  }

  /**
   * A workspace change is not a delta, it is a different subject.
   *
   * Diffing a snapshot of one repository against a home for another would produce a confident list
   * of changes, every line of which is wrong — the commit "moved", the Story "changed" — because
   * the two were never the same thing. Caught before any comparison rather than after.
   */
  if (acknowledgement.workspaceId && facts.workspaceId && acknowledgement.workspaceId !== facts.workspaceId) {
    return Object.freeze({
      state: 'incomparable' as const,
      at: acknowledgement.at,
      changes: [],
      obstacle: 'the acknowledgement you have was taken in a different workspace',
      heading: 'Could not compare',
      summary: 'The acknowledgement you have was taken in a different workspace, so nothing here can'
        + ' be compared against it. Mark this home as checked to start a comparison for this one.',
      action
    });
  }

  const commitComparable = Boolean(acknowledgement.sourceCommit && facts.sourceCommit);
  const worktreeComparable = acknowledgement.dirty !== null && facts.dirty !== null;
  if (!commitComparable && !worktreeComparable) {
    return Object.freeze({
      state: 'incomparable' as const,
      at: acknowledgement.at,
      changes: [],
      obstacle: !facts.sourceCommit && facts.dirty === null
        ? 'this repository could not be read just now'
        : 'the acknowledgement you have does not carry the facts to compare against',
      heading: 'Could not compare',
      summary: !facts.sourceCommit && facts.dirty === null
        ? 'This repository could not be read just now, so what changed since you last checked is'
          + ' unknown — not nothing.'
        : 'The acknowledgement you have does not carry the facts this home would compare against, so'
          + ' what changed is unknown — not nothing.',
      action
    });
  }

  const changes = changesBetween(acknowledgement, facts);

  /**
   * A partial comparison says so, and still shows what it found.
   *
   * Dropping to `incomparable` because one of the two facts was unreadable would throw away a real
   * finding; claiming a clean `compared` would let the reader take the list as exhaustive. The
   * state is `compared` and the summary names the gap, so the changes stand and their limits do too.
   */
  const partial = !commitComparable
    ? 'the repository revision could not be compared, so a commit change would not be listed'
    : !worktreeComparable
      ? 'the worktree could not be compared, so a change there would not be listed'
      : null;

  const found = changes.length
    ? `${changes.join('; ')}.`
    : 'Nothing has changed here since then.';

  return Object.freeze({
    state: 'compared' as const,
    at: acknowledgement.at,
    changes,
    obstacle: partial,
    heading: 'Since you last checked',
    summary: partial ? `${found} Note that ${partial}.` : found,
    action
  });
}
