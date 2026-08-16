/**
 * `home.overview`: the startup menu. `[INT:REQ-021]` `[INT:REQ-022]` `[INT:CON-023]`
 *
 * At most six choices, drawn from a fixed set, ordered by rules rather than by a model
 * `[INT:CON-023]`. The ordering is the entire product decision on this screen: what the reader sees
 * first is what they will do, so it is derived from their work rather than from what is easy to
 * render or interesting to suggest.
 *
 * Two rules override the default order and both come from the specification rather than taste.
 * When an active Story exists, continuing it leads and names the Story, repository, phase and legal
 * next action `[INT:REQ-023]`. When no workspace is selected, workspace selection leads and the
 * menu does not pretend current work or repository evidence is available `[INT:REQ-024]`.
 */
import { noEffects, sflowResult } from '../result.mjs';
import { localChangesFor } from './work-continue.mjs';
import { WORK_GROUP_ORDER, workRecords } from '../work-records.mjs';

/** The stable choice set. Six at most, and never one this list does not contain `[INT:REQ-022]`. */
/**
 * The stable menu. Every `id` is a registered operation, and a test holds it so `[DHR:CON-004]`.
 *
 * These carried a third field, `goal`, that nothing read — `choice()` keys everything off `id`.
 * It had already drifted on two entries (`work.start` against `work.start.intake`, `help` against
 * `help.explain`), which is what a dead field does and why it was harmless: an unread value cannot
 * be wrong about anything. Removed, and replaced with the check it was standing in for — that a
 * choice names an operation the registry actually has, because a menu item resolving to nothing is
 * a goal advertised without a reachable operation.
 */
export const HOME_CHOICES = Object.freeze([
  { id: 'work.continue', label: 'Continue current work' },
  { id: 'work.list', label: 'See current work' },
  /**
   * Third in the stable order, and second when promoted.
   *
   * Its resting position has to match its rank. Placed second it sat above "see current work" on
   * every home that had no active Story — a briefing about work you have not started, ranked above
   * the list of work you have. The sort only runs when there is something to promote, so the
   * declaration order *is* the answer in the ordinary case.
   */
  { id: 'work.return', label: 'See what changed while you were away' },
  { id: 'work.start.intake', label: 'Start new work' },
  { id: 'workspace.switch', label: 'Switch workspace' },
  { id: 'impact.quick', label: 'Run a quick impact analysis' },
  { id: 'repository.explore', label: 'Explore repositories or investigate a problem' },
  { id: 'help.explain', label: 'Learn how SFlow works' }
]);

export const MAX_HOME_CHOICES = 6;

const FALLBACKS = Object.freeze({
  'work.continue': 'sflow resume',
  'work.return': 'sflow story return',
  'work.list': 'sflow inbox',
  'work.start.intake': 'sflow start',
  'workspace.switch': 'sflow workspace list',
  'impact.quick': 'sflow impact',
  'repository.explore': 'sflow status',
  'help.explain': 'sflow explain'
});

function choice(entry, index, reasonCode, slots = {}) {
  return {
    handle: `home:${entry.id}`,
    /** The choice, not its position. Reordering the menu must not rename its items. */
    id: `home:${entry.id}`,
    label: entry.label,
    rank: index,
    kind: 'read',
    reasonCode,
    confirmation: 'none',
    /** Selecting a menu item resolves a goal; nothing here collects input or signs anything. */
    interaction: 'navigation',
    /**
     * The lead choice is the one filled button `[UXH:REQ-023]` `[UXH:REQ-064]`.
     *
     * `index === 0` rather than a separate flag, because the ordering rules above already decided
     * which choice leads, and a second way of saying "this one" is a second thing to keep in sync.
     * The menu below it stays secondary: six equally-weighted buttons and one emphasised one are
     * different screens, and only the second answers "what now?".
     */
    emphasis: index === 0 ? 'primary' : 'secondary',
    /**
     * A menu item is never executable `[INT:IFC-001]`.
     *
     * Selecting it resolves the goal, which binds a subject and recomputes legality. A menu rendered
     * at breakfast that could still act at lunchtime is the whole problem with embedded actions.
     */
    executable: false,
    fallback: { label: entry.label, command: FALLBACKS[entry.id] },
    slots
  };
}

/**
 * The order the primary is chosen in. `[DHR:REQ-070]`
 *
 * §8 lists five rules and this encodes the three the home can evaluate from records and a worktree
 * read. Written as a rank rather than a comparator on purpose: a comparator that special-cases one
 * id is not a total order, which is the bug this planner already had once — it claimed
 * `work.continue` sorted before itself, and the rest of the menu held its order only because V8's
 * sort is stable in practice.
 *
 * Rule 3 beats rule 4 deliberately, and it is worth saying why since the opposite reads as more
 * helpful: someone with an active Story and uncommitted changes is being offered "continue" above
 * "see what changed", because they know what they changed — they changed it. The briefing leads
 * only when there is something they could *not* have known, which is the case the ordering below
 * promotes it for.
 */
function homeRank(entry, { active, needsReconciliation }) {
  // Rule 3: the active Story on this branch.
  if (entry.id === 'work.continue') return active ? 0 : 3;
  // Rule 4: local work that has not been compared against the plan.
  if (entry.id === 'work.return') return needsReconciliation ? 1 : 4;
  return 2;
}

export function homeOverviewResult({ workspace = null, records = null, subject = null, localChanges = null } = {}) {
  const groups = records?.groups ?? {};
  const counts = Object.fromEntries(WORK_GROUP_ORDER.map((name) => [name, (groups[name] ?? []).length]));
  const active = (groups.active ?? [])[0] ?? null;
  const decisions = (groups['waiting-on-you'] ?? []).length;

  const ordered = [...HOME_CHOICES];
  const why = [];

  if (!workspace) {
    /**
     * `[INT:REQ-024]`. Not merely "put workspace first" — the work choices come out entirely,
     * because offering "see current work" with no workspace selected promises evidence that cannot
     * exist and produces an empty screen the reader reads as "you have nothing to do".
     */
    const lead = ordered.filter((entry) => entry.id === 'workspace.switch' || entry.id === 'help.explain');
    return sflowResult({
      kind: 'read',
      operation: { id: 'home.overview', classification: 'read' },
      outcome: { status: 'succeeded', messageId: 'gateway.home', slots: { workspace: 'none' } },
      effects: noEffects(),
      why: [{ code: 'home.no-workspace-selected', source: 'deterministic' }],
      next: lead.map((entry, index) => choice(entry, index, 'home.select-a-workspace-first')),
      restState: null,
      /** No workspace means no Story, so there is no rail to draw and none is claimed. */
      data: { rail: [], workspace: null, counts: null, briefingAvailable: false, choiceSet: lead.map((entry) => entry.id) }
    });
  }

  /**
   * Uncommitted work against an active Story is what the briefing exists for `[DHR:REQ-041]`.
   *
   * Null means the worktree was not read, which is not the same as clean — so the briefing is not
   * promoted on an unread tree. Promoting it would be acting on a fact nobody established.
   */
  const needsReconciliation = Boolean(active && localChanges?.dirty);

  if (active || needsReconciliation) {
    const context = { active, needsReconciliation };
    ordered.sort((left, right) => homeRank(left, context) - homeRank(right, context)
      || HOME_CHOICES.indexOf(left) - HOME_CHOICES.indexOf(right));
    why.push({
      code: 'home.active-work-leads',
      source: 'lifecycle',
      reference: active.id,
      slots: { work: active.id, phase: active.phase ?? 'none', next: active.nextAction?.operation ?? 'none' }
    });
    if (needsReconciliation) {
      why.push({
        code: 'home.local-work-unreconciled',
        source: 'evidence',
        reference: localChanges.worktreeHash ?? null,
        slots: { files: String(localChanges.files ?? 0) }
      });
    }
  }

  const shown = ordered.slice(0, MAX_HOME_CHOICES);
  return sflowResult({
    kind: 'read',
    operation: { id: 'home.overview', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.home',
      slots: { workspace: workspace.name ?? workspace.id, active: counts.active, decisions }
    },
    effects: noEffects(),
    why: why.length ? why : [{ code: 'home.default-order', source: 'deterministic' }],
    /**
     * The My Flow briefing is cross-workspace `[INT:REQ-172]` and this planner reads one repository.
     * Declared as unavailable rather than silently omitted: a briefing that is missing looks exactly
     * like a briefing with nothing in it.
     */
    warnings: [{ code: 'home.briefing-unavailable', source: 'unavailable', slots: { scope: 'cross-workspace' } }],
    next: shown.map((entry, index) => {
      /**
       * A promoted choice says why it was promoted.
       *
       * `home.stable-choice` reads "Always available", which is true of this entry and useless on
       * the one occasion it has been moved to the top. A reader who sees an item jump position and
       * is told it is always available learns nothing about why today is different.
       */
      if (entry.id === 'work.return' && needsReconciliation) {
        return choice(entry, index, 'home.local-work-unreconciled', {
          files: String(localChanges.files ?? 0),
          work: active?.id ?? 'none'
        });
      }
      if (entry.id === 'work.continue' && active) {
        return choice(entry, index, 'home.continue-active-work', {
          work: active.id,
          title: active.title,
          repository: active.repository ?? 'current',
          phase: active.phase ?? 'none',
          nextAction: active.nextAction?.operation ?? 'none'
        });
      }
      if (entry.id === 'work.list') {
        return choice(entry, index, 'home.work-summary', { active: String(counts.active), decisions: String(decisions) });
      }
      return choice(entry, index, 'home.stable-choice');
    }),
    restState: null,
    data: {
      /**
       * Screen B draws the rail above the one filled action, so the home carries it.
       *
       * Empty when there is no active Story. An empty rail renders as nothing, where a rail of all
       * pending phases would draw a lifecycle for work nobody has started.
       */
      rail: active?.rail ?? [],
      workspace: { id: workspace.id, name: workspace.name ?? workspace.id },
      counts,
      activeWork: active ? { id: active.id, title: active.title, phase: active.phase, nextAction: active.nextAction } : null,
      // `[INT:CON-024]`: shown as a count here; selecting it opens the ceremony, never records one.
      needsYourDecision: decisions,
      briefingAvailable: false,
      choiceSet: shown.map((entry) => entry.id)
    }
  });
}

export async function homeOverview({ subject = null, root = null, context = {} } = {}) {
  /**
   * A missing root is "no workspace selected", not an error.
   *
   * A host can legitimately open the gateway before anything is chosen — that is the first-run
   * case — and §3.2's answer for it is a menu that leads with workspace selection.
   */
  if (!root) return homeOverviewResult({ workspace: null, subject });
  const records = await workRecords(root, context);
  return homeOverviewResult({
    workspace: context.workspace ?? { id: root, name: context.workspaceName ?? root },
    records,
    subject,
    /**
     * The same worktree read `work.continue` and `work.return` use.
     *
     * One `git status` on a path already reading work records, and it decides whether the briefing
     * is promoted. Three surfaces counting changed paths three ways is how they come to disagree in
     * front of someone who has all three open.
     */
    localChanges: context.localChanges ?? localChangesFor(root)
  });
}
