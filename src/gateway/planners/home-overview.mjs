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
import { WORK_GROUP_ORDER, workRecords } from '../work-records.mjs';

/** The stable choice set. Six at most, and never one this list does not contain `[INT:REQ-022]`. */
export const HOME_CHOICES = Object.freeze([
  { id: 'work.continue', label: 'Continue current work', goal: 'work.continue' },
  { id: 'work.list', label: 'See current work', goal: 'work.list' },
  { id: 'work.start.intake', label: 'Start new work', goal: 'work.start' },
  { id: 'workspace.switch', label: 'Switch workspace', goal: 'workspace.switch' },
  { id: 'impact.quick', label: 'Run a quick impact analysis', goal: 'impact.quick' },
  { id: 'repository.explore', label: 'Explore repositories or investigate a problem', goal: 'repository.explore' },
  { id: 'help.explain', label: 'Learn how SFlow works', goal: 'help' }
]);

export const MAX_HOME_CHOICES = 6;

const FALLBACKS = Object.freeze({
  'work.continue': 'sflow resume',
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

export function homeOverviewResult({ workspace = null, records = null, subject = null } = {}) {
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
      data: { workspace: null, counts: null, briefingAvailable: false, choiceSet: lead.map((entry) => entry.id) }
    });
  }

  if (active) {
    /**
     * `[INT:REQ-023]`: continuing leads, and names what it would continue.
     *
     * Ranked rather than compared pairwise. The obvious version — return -1 when the left item is
     * `work.continue` — is not a total order: it also claims `work.continue` sorts before itself,
     * and every other pair is "equal", so the rest of the menu holds its order only because V8's
     * sort happens to be stable. True today, unspecified, and silently load-bearing.
     */
    const rank = (entry) => (entry.id === 'work.continue' ? 0 : 1);
    ordered.sort((left, right) => rank(left) - rank(right)
      || HOME_CHOICES.indexOf(left) - HOME_CHOICES.indexOf(right));
    why.push({
      code: 'home.active-work-leads',
      source: 'lifecycle',
      reference: active.id,
      slots: { work: active.id, phase: active.phase ?? 'none', next: active.nextAction?.operation ?? 'none' }
    });
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
  return homeOverviewResult({ workspace: context.workspace ?? { id: root, name: context.workspaceName ?? root }, records, subject });
}
