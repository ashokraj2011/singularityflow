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
import { createHash } from 'node:crypto';
import { readWorkspaceRegistry } from '../../workspace.mjs';
import { workspaceRegistryFile } from '../../workspace-context.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, plannerNavigation, sflowResult } from '../result.mjs';
import { localChangesFor } from './work-continue.mjs';
import { deriveHomeState } from '../home-work-projection.mjs';
import { WORK_GROUP_ORDER, workRecords } from '../work-records.mjs';
import { personalizationFromGitIdentity } from '../../personalization.mjs';
import { branch as gitBranch } from '../../git.mjs';
import { normalizeHomeLens } from '../home-projection-v2.mjs';
import { autoHomeSummary } from '../auto-home-summary.mjs';

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
  { id: 'goal.next', label: 'Continue governed Goal' },
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

const ROOTLESS_CHOICES = Object.freeze({
  bootstrap: { id: 'workspace.bootstrap.status', label: 'Continue workspace setup' },
  open: { id: 'repository.open.guide', label: 'Use an existing repository clone' },
  prepare: { id: 'workspace.prepare.guide', label: 'Prepare a new workspace' },
  doctor: { id: 'workspace.doctor.guide', label: 'Run workspace diagnostics' },
  explore: { id: 'workspace.explore.guide', label: 'Explore saved workspaces' }
});

const FALLBACKS = Object.freeze({
  'work.continue': { command: 'singularity-flow resume <WORK-ID>', skill: '/sf-resume <WORK-ID>' },
  'work.return': { command: 'singularity-flow story return <WORK-ID>', skill: '/sf-work-interval reconcile' },
  'work.list': { command: 'singularity-flow session candidates', skill: '/sf-session' },
  'goal.next': { command: 'singularity-flow goal next <GOAL-ID>', skill: '/sf-goal inspect <GOAL-ID>' },
  'work.start.intake': { command: 'singularity-flow start <WORK-ID>', skill: '/sf-start <WORK-ID>' },
  'workspace.switch': { command: 'singularity-flow workspace list', skill: '/sf-workspace' },
  'workspace.bootstrap.status': { command: 'singularity-flow workspace bootstrap status <BOOTSTRAP-ID>', skill: '/sf-workspace-bootstrap <BOOTSTRAP-ID>' },
  'workspace.prepare.guide': { command: 'singularity-flow workspace prepare', skill: '/sf-workspace-create' },
  'repository.open.guide': { command: 'singularity-flow workspace adopt <DIRECTORY> --id <ID> --dry-run', skill: '/sf-workspace' },
  'workspace.doctor.guide': { command: 'singularity-flow workspace doctor', skill: '/sf-workspace' },
  'workspace.explore.guide': { command: 'singularity-flow workspace list', skill: '/sf-workspace' },
  'impact.quick': { command: 'singularity-flow workspace impact', skill: '/sf-workspace-impact' },
  'repository.explore': { command: 'singularity-flow status', skill: '/sf-inspect' },
  'help.explain': { command: 'singularity-flow explain', skill: '/sf-help' }
});

function fallbackFor(id, label, slots) {
  if (id === 'workspace.bootstrap.status' && slots.bootstrap) {
    return {
      label,
      command: `singularity-flow workspace bootstrap status ${slots.bootstrap}`,
      skill: `/sf-workspace-bootstrap ${slots.bootstrap}`
    };
  }
  if (id === 'work.list' && slots.work) {
    return {
      label: `Review ${slots.work}`,
      command: 'singularity-flow status',
      skill: '/sf-status'
    };
  }
  const fallback = FALLBACKS[id];
  const workId = slots.work ?? '<WORK-ID>';
  const goalId = slots.goal ?? '<GOAL-ID>';
  const bootstrapId = slots.bootstrap ?? '<BOOTSTRAP-ID>';
  return {
    label,
    command: fallback.command.replace('<WORK-ID>', workId).replace('<GOAL-ID>', goalId).replace('<BOOTSTRAP-ID>', bootstrapId),
    skill: fallback.skill.replace('<WORK-ID>', workId).replace('<GOAL-ID>', goalId).replace('<BOOTSTRAP-ID>', bootstrapId)
  };
}

function homeNavigation(entry, { workId = null, workKind = null, bootstrapId = null } = {}) {
  if (['work.continue', 'work.return', 'work.readiness'].includes(entry.id)) {
    return workId
      ? { operationId: entry.id, arguments: { workId, ...(workKind ? { workKind } : {}) } }
      : { operationId: 'work.list', arguments: {} };
  }
  if (entry.id === 'workspace.switch') return { operationId: 'workspace.list', arguments: {} };
  if (entry.id === 'goal.next') return { operationId: 'goal.next', arguments: { goalId: workId } };
  if (entry.id === 'workspace.bootstrap.status') {
    return { operationId: entry.id, arguments: { bootstrapId } };
  }
  if (entry.id === 'repository.explore') {
    return { operationId: 'repository.explore', arguments: { repositoryId: 'current' } };
  }
  if (entry.id === 'help.explain') {
    return { operationId: 'help.explain', arguments: { question: 'how does sflow work' } };
  }
  return { operationId: entry.id, arguments: {} };
}

function choice(entry, index, reasonCode, slots = {}, navigation = {}, emphasis = index === 0 ? 'primary' : 'secondary') {
  const target = homeNavigation(entry, navigation);
  return plannerNavigation({
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
    emphasis,
    /**
     * A menu item is never executable `[INT:IFC-001]`.
     *
     * Selecting it resolves the goal, which binds a subject and recomputes legality. A menu rendered
     * at breakfast that could still act at lunchtime is the whole problem with embedded actions.
     */
    executable: false,
    fallback: fallbackFor(entry.id, entry.label, slots),
    slots
  }, target.operationId, target.arguments);
}

function faultChoice(fault, action, rank, emphasis = 'secondary') {
  const definitions = {
    fix: {
      label: `Fix ${fault.faultId}`,
      reasonCode: 'fault.repair-guided',
      command: `singularity-flow fix ${fault.faultId}`,
      skill: `/sf-fix ${fault.faultId}`
    },
    diagnose: {
      label: `Diagnose ${fault.faultId}`,
      reasonCode: 'fault.diagnose-first',
      command: `singularity-flow fix ${fault.faultId} --diagnose-only`,
      skill: `/sf-fix ${fault.faultId} --diagnose-only`
    },
    evidence: {
      label: `Open evidence for ${fault.faultId}`,
      reasonCode: 'fault.open-evidence',
      command: `singularity-flow fault show ${fault.faultId}`,
      skill: `/sf-fault show ${fault.faultId}`
    }
  };
  const definition = definitions[action];
  return {
    handle: `ceremony:fault:${fault.faultId}:${action}`,
    id: `fault:${action}:${fault.faultId}`,
    label: definition.label,
    rank,
    kind: 'ceremony',
    reasonCode: definition.reasonCode,
    confirmation: 'ceremony',
    interaction: 'ceremony',
    emphasis,
    executable: false,
    fallback: { label: definition.label, command: definition.command, skill: definition.skill },
    slots: { fault: fault.faultId }
  };
}

function reviewChoice(work, rank, emphasis = 'secondary') {
  const workKind = work.kind ?? 'story';
  return plannerNavigation({
    handle: `home:review:${workKind}:${work.id}`,
    id: `home:review:${workKind}:${work.id}`,
    label: `Review ${work.id}`,
    rank,
    kind: 'read',
    reasonCode: 'home.needs-your-decision',
    confirmation: 'none',
    interaction: 'navigation',
    emphasis,
    executable: false,
    fallback: {
      label: `Review ${work.id}`,
      command: `singularity-flow approvals ${work.id}`,
      skill: `/sf-approve ${work.id}`
    },
    slots: { work: work.id, phase: work.phase ?? 'none' }
  }, 'review.packet', { workId: work.id, workKind });
}

function actorProjection(actor) {
  const stable = actor?.email ?? actor?.login ?? null;
  return Object.freeze({
    id: stable
      ? `actor:${createHash('sha256').update(String(stable).toLowerCase()).digest('hex').slice(0, 24)}`
      : 'actor:unavailable',
    display: personalizationFromGitIdentity(actor).displayName
  });
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
function homeRank(entry, { active, recovery, needsReconciliation }) {
  if (entry.id === 'work.continue') {
    /**
     * Rule 1 before rule 3, and it is the same choice either way.
     *
     * An interrupted publication and an active Story are both continued by `work.continue`, so the
     * rank is the same — but the *reason* is not, and rule 1 exists because a half-finished
     * publication is the one state where doing anything else first can lose work. The distinction
     * is carried in `why[]` rather than by a different button.
     */
    if (recovery) return 0;
    return active ? 0 : 3;
  }
  // Rule 4: local work that has not been compared against the plan.
  if (entry.id === 'work.return') return needsReconciliation ? 1 : 4;
  // A governed Goal is the outcome-level rail above its linked Story. Publication recovery still
  // wins because continuing anything else first can strand a retained commit.
  if (entry.id === 'goal.next') return recovery ? 2 : -1;
  return 2;
}

export function homeOverviewResult({
  workspace = null,
  repository = null,
  actor = null,
  records = null,
  state = null,
  current = {},
  subject = null,
  localChanges = null,
  faults = [],
  faultsUnavailable = false,
  bootstrap = null,
  lens = 'developer',
  today = null,
  yesterday = null,
  journalAvailable = true,
  governedGoal = null,
  latestReceipt = null,
  auto = null,
  /**
   * How many *other* workspaces the registry knows about, or null when it could not be read.
   *
   * Passed in rather than read here: this function is the deterministic core and its unit fixtures
   * must not depend on whatever registry happens to exist on the machine running the tests.
   */
  otherWorkspaces = null
} = {}) {
  const homeState = state ?? deriveHomeState(records ?? {}, { repositoryScoped: true, ...current });
  const groups = homeState.groups;
  const counts = homeState.counts;
  const active = homeState.activeWork;
  const currentWork = homeState.currentWork;
  const decisions = homeState.needsYourDecision;
  const attentionWork = (groups['waiting-on-you'] ?? [])[0] ?? null;
  const unresolvedFault = faults.find((fault) => fault.disposition !== 'resolved') ?? null;

  const projectWork = (work) => work ? {
    kind: work.kind, id: work.id, title: work.title, phase: work.phase,
    status: work.status ?? null, group: work.group ?? null,
    repositoryId: work.repositoryId ?? work.repository ?? null,
    branch: work.branch ?? null, nextAction: work.nextAction ?? null
  } : null;

  const ordered = [...HOME_CHOICES];
  const why = [];

  if (!workspace) {
    /**
     * `[INT:REQ-024]`. Not merely "put workspace first" — the work choices come out entirely,
     * because offering "see current work" with no workspace selected promises evidence that cannot
     * exist and produces an empty screen the reader reads as "you have nothing to do".
     */
    const lead = [
      ...(bootstrap ? [ROOTLESS_CHOICES.bootstrap] : []),
      ROOTLESS_CHOICES.open,
      ROOTLESS_CHOICES.prepare,
      ROOTLESS_CHOICES.doctor,
      ROOTLESS_CHOICES.explore
    ];
    return sflowResult({
      kind: 'read',
      operation: { id: 'home.overview', classification: 'read' },
      outcome: { status: 'succeeded', messageId: 'gateway.home', slots: { workspace: 'none' } },
      effects: noEffects(),
      why: [{ code: 'home.no-workspace-selected', source: 'deterministic' }],
      next: lead.map((entry, index) => choice(
        entry, index, 'home.select-a-workspace-first',
        entry.id === 'workspace.bootstrap.status'
          ? { bootstrap: bootstrap.bootstrapId, status: bootstrap.status }
          : {},
        entry.id === 'workspace.bootstrap.status' ? { bootstrapId: bootstrap.bootstrapId } : {}
      )),
      restState: null,
      /** No workspace means no Story, so there is no rail to draw and none is claimed. */
      /** No workspace means no repository was read, so the worktree is unread rather than clean. */
      data: {
        rail: [], workspace: null, repository: null, counts: null, localChanges: null,
        currentWork: null, activeWork: null, attentionWork: null,
        actor: actorProjection(actor), lens: normalizeHomeLens(lens), today: null, yesterday: null,
        journalAvailable: false, recent: [], latestReceipt: null,
        personalization: personalizationFromGitIdentity(actor),
        bootstrap: bootstrap ? {
          bootstrapId: bootstrap.bootstrapId,
          status: bootstrap.status,
          workspaceId: bootstrap.plan?.workspace?.id ?? bootstrap.request?.workspaceId ?? null,
          workspaceName: bootstrap.plan?.workspace?.name ?? bootstrap.request?.workspaceName ?? null,
          targetPath: bootstrap.plan?.workspace?.targetPath ?? null,
          blocking: bootstrap.preflight?.findings?.filter((finding) => finding.severity === 'blocker').length ?? 0,
          nextAction: bootstrap.nextAction ?? null
        } : null,
        briefingAvailable: false, choiceSet: lead.map((entry) => entry.id), auto: null
      }
    });
  }

  /**
   * Uncommitted work against an active Story is what the briefing exists for `[DHR:REQ-041]`.
   *
   * Null means the worktree was not read, which is not the same as clean — so the briefing is not
   * promoted on an unread tree. Promoting it would be acting on a fact nobody established.
   */
  const needsReconciliation = Boolean(active && localChanges?.dirty);

  /**
   * An interrupted publication, which `[DHR:REQ-070]` rule 1 puts above everything. `[UXH:REQ-051]`
   *
   * The group already existed and the home never mentioned it, so the highest-priority rule in §8
   * was the one rule not implemented — a reader with a half-finished publication saw the ordinary
   * "continue current work" home and no indication that this state is the one where doing something
   * else first can lose work.
   */
  const recovery = homeState.recoveryWork;
  const leading = recovery ?? active;

  /**
   * Availability is state, not presentation. A Continue row with no current work is not a harmless
   * shortcut: it becomes the primary action by declaration order and contradicts the headline.
   */
  if (!leading) ordered.splice(ordered.findIndex((entry) => entry.id === 'work.continue'), 1);
  if (!governedGoal) ordered.splice(ordered.findIndex((entry) => entry.id === 'goal.next'), 1);
  if (!homeState.activeCount) {
    const listIndex = ordered.findIndex((entry) => entry.id === 'work.list');
    if (listIndex >= 0) ordered.splice(listIndex, 1);
    const startIndex = ordered.findIndex((entry) => entry.id === 'work.start.intake');
    if (startIndex > 0) ordered.unshift(...ordered.splice(startIndex, 1));
  }

  if (leading || needsReconciliation || governedGoal) {
    const context = { active, recovery, needsReconciliation };
    ordered.sort((left, right) => homeRank(left, context) - homeRank(right, context)
      || HOME_CHOICES.indexOf(left) - HOME_CHOICES.indexOf(right));
    why.push(recovery
      ? {
        code: 'home.recovery-required',
        source: 'lifecycle',
        reference: recovery.id,
        slots: { work: recovery.id, phase: recovery.phase ?? 'none' }
      }
      : governedGoal ? {
        code: 'home.governed-goal-active',
        source: 'lifecycle',
        reference: governedGoal.id,
        slots: { goal: governedGoal.id, status: governedGoal.status }
      } : {
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
    if (governedGoal && recovery) {
      why.push({
        code: 'home.governed-goal-active', source: 'lifecycle', reference: governedGoal.id,
        slots: { goal: governedGoal.id, status: governedGoal.status }
      });
    }
  }

  /**
   * A decision only a person can make. `[UXH:REQ-051]` `[DHR:REQ-062]`
   *
   * Counted, never acted on — the home says how many are waiting and selecting one opens the
   * ceremony `[INT:CON-024]`. Named separately from the leading action because "you have work in
   * progress" and "somebody is blocked on your decision" are different obligations, and a reader
   * who only sees the first will not know the second exists.
   */
  if (decisions) {
    why.push({
      code: 'home.needs-your-decision',
      source: 'lifecycle',
      reference: (groups['waiting-on-you'] ?? [])[0]?.id ?? null,
      slots: { count: String(decisions) }
    });
  }


  if (unresolvedFault) {
    why.push({
      code: 'fault.unresolved',
      source: 'evidence',
      reference: unresolvedFault.faultId,
      slots: {
        fault: unresolvedFault.faultId,
        severity: unresolvedFault.severity,
        type: unresolvedFault.failure?.type ?? 'unknown',
        summary: unresolvedFault.failure?.message ?? 'Recorded fault'
      }
    });
  }

  /**
   * Nothing anywhere is an answer, and the only one this planner can give that is good news.
   *
   * `[INT:REQ-041]` forbids a dead end, and the temptation here is to leave the menu to speak for
   * itself — six choices and no statement reads as "we found nothing", which is what a broken read
   * also looks like. Saying it explicitly is the difference between rest and failure.
   */
  const nothingWaiting = !leading && !governedGoal && !decisions
    && WORK_GROUP_ORDER.every((group) => !(groups[group] ?? []).length);
  if (nothingWaiting) {
    why.push({ code: 'home.nothing-waiting', source: 'lifecycle', slots: { workspace: workspace.name ?? workspace.id } });
  }

  const standardLimit = Math.max(0, MAX_HOME_CHOICES - (unresolvedFault ? 3 : 0));
  const shown = ordered.slice(0, standardLimit);
  return sflowResult({
    kind: 'read',
    operation: { id: 'home.overview', classification: 'read' },
    /**
     * Uncommitted bytes are part of the revision this menu was computed against. `[INT:REQ-035]`
     *
     * The ordering above is decided partly by whether the tree is dirty, so an answer that declared
     * only a commit would claim to depend on less than it does. Overlaid rather than set, because
     * the commit and the hashes come from the handle this read was authorized by.
     */
    subject: subjectWith(subject, { revision: {
      worktreeHash: localChanges?.worktreeHash ?? null,
      worktreeAlgorithm: localChanges?.worktreeAlgorithm ?? null
    } }),
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.home',
      slots: { workspace: workspace.name ?? workspace.id, active: counts.active, decisions }
    },
    effects: noEffects(),
    why: why.length ? why : [{ code: 'home.default-order', source: 'deterministic' }],
    /**
     * The My Flow briefing is cross-workspace `[INT:REQ-172]` and this planner reads one repository.
     * Declared rather than silently omitted: a briefing that is missing looks exactly like a
     * briefing with nothing in it.
     *
     * The gap now carries a number. "The cross-workspace briefing is unavailable" told a reader
     * nothing about whether *elsewhere* meant zero other workspaces or twelve — and those are
     * completely different situations to be in while looking at a home that covers one. The count
     * comes from the registry, which is a single file read and no repository work at all; what is
     * still not known is what is *in* those workspaces, and that is what the slot says.
     *
     * Deliberately not resolved further here. Counting work across workspaces means reading each
     * one, a read path may not do that, and warming a cache for it has no honest trigger short of
     * a background job or a workspace-switch hook. Reporting "not checked" for a thing nobody
     * looked at is the same distinction this planner already draws about the worktree.
     */
    warnings: [
      ...(otherWorkspaces === 0 ? [] : [{
      code: 'home.briefing-unavailable',
      source: 'unavailable',
      slots: {
        scope: 'cross-workspace',
        /** How many other workspaces exist, or `unknown` when even the registry could not be read. */
        others: otherWorkspaces === null ? 'unknown' : String(otherWorkspaces)
      }
    }]),
      ...(faultsUnavailable ? [{ code: 'fault.records-unavailable', source: 'unavailable', slots: {} }] : []),
      ...(auto && auto.availability !== 'available'
        ? [{ code: 'home.auto-unavailable', source: 'unavailable', slots: {} }] : [])
    ],
    next: (() => {
      const decisionBlocksCurrent = Boolean(attentionWork && !recovery && !active
        && currentWork?.id === attentionWork.id && currentWork?.group === 'waiting-on-you');
      let components = shown.map((entry) => ({ type: 'standard', entry }));
      if (attentionWork) {
        const index = decisionBlocksCurrent ? 0 : (leading ? 1 : 0);
        components.splice(index, 0, { type: 'review', work: attentionWork });
      }
      if (unresolvedFault) {
        const faults = ['fix', 'diagnose', 'evidence'].map((action) => ({ type: 'fault', action }));
        const index = recovery ? 1 : (decisionBlocksCurrent ? 1 : 0);
        components.splice(index, 0, ...faults);
      }
      return components.slice(0, MAX_HOME_CHOICES).map((component, rank) => {
        const emphasis = rank === 0 ? 'primary' : 'secondary';
        if (component.type === 'review') return reviewChoice(component.work, rank, emphasis);
        if (component.type === 'fault') return faultChoice(unresolvedFault, component.action, rank, emphasis);
        const entry = component.entry;
        /** A promoted choice carries the deterministic reason it moved. */
        if (entry.id === 'work.return' && needsReconciliation) {
          return choice(entry, rank, 'home.local-work-unreconciled', {
            files: String(localChanges.files ?? 0), work: active?.id ?? 'none'
          }, { workId: active?.id ?? null, workKind: active?.kind ?? null }, emphasis);
        }
        if (entry.id === 'work.continue' && leading) {
          return choice(entry, rank, recovery ? 'home.recovery-required' : 'home.continue-active-work', {
            work: leading.id,
            title: leading.title,
            repository: leading.repository ?? 'current',
            phase: leading.phase ?? 'none',
            nextAction: leading.nextAction?.operation ?? 'none'
          }, { workId: leading.id, workKind: leading.kind }, emphasis);
        }
        if (entry.id === 'work.list') {
          return choice(entry, rank, 'home.work-summary', {
            active: String(counts.active),
            decisions: String(decisions),
            ...(currentWork ? {
              work: currentWork.id,
              phase: currentWork.phase ?? 'none',
              group: currentWork.group ?? 'active'
            } : {})
          }, {}, emphasis);
        }
        if (entry.id === 'goal.next' && governedGoal) {
          return choice(entry, rank, 'home.governed-goal-active', {
            goal: governedGoal.id, status: governedGoal.status
          }, { workId: governedGoal.id, workKind: 'goal' }, emphasis);
        }
        return choice(entry, rank, 'home.stable-choice', {}, {
          workId: active?.id ?? null, workKind: active?.kind ?? null
        }, emphasis);
      });
    })(),
    restState: null,
    data: {
      /**
       * Screen B draws the rail above the one filled action, so the home carries it.
       *
       * Empty when there is no active Story. An empty rail renders as nothing, where a rail of all
       * pending phases would draw a lifecycle for work nobody has started.
       */
      rail: currentWork?.rail ?? [],
      actor: actorProjection(actor),
      lens: normalizeHomeLens(lens),
      today,
      yesterday,
      journalAvailable,
      recent: homeState.ordered
        .filter((work) => work.id !== currentWork?.id || work.repositoryId !== currentWork?.repositoryId)
        .slice(0, 5).map(projectWork),
      personalization: personalizationFromGitIdentity(actor),
      workspace: { id: workspace.id, name: workspace.name ?? workspace.id },
      repository: repository ? {
        id: repository.id ?? null,
        path: repository.path ?? null,
        branch: repository.branch ?? null,
        head: repository.head ?? null,
        resolvedFrom: repository.resolvedFrom ?? null
      } : null,
      counts,
      /** The selected Story regardless of whether it is active, awaiting a decision, or blocked. */
      currentWork: projectWork(currentWork),
      /** Compatibility field: only work in the mechanical `active` group belongs here. */
      activeWork: projectWork(active),
      governedGoal,
      latestReceipt,
      auto,
      /** The first decision this actor is authorized to make, even when another Story is selected. */
      attentionWork: projectWork(attentionWork),
      /**
       * Clean and unread are different answers, and `subject.revision` cannot hold both.
       *
       * The v2 hash identifies both clean and dirty observation state, including index visibility
       * flags. Dirtiness is therefore read only from this record: `null` is unread, and
       * `dirty: false` is a read that found nothing. `work.return` carries it here for the same reason.
       */
      localChanges,
      faults: faults.slice(0, 5).map((fault) => ({
        faultId: fault.faultId,
        severity: fault.severity,
        source: fault.source,
        environment: fault.environment,
        occurredAt: fault.occurredAt,
        type: fault.failure?.type ?? 'unknown',
        summary: fault.failure?.message ?? 'Recorded fault',
        disposition: fault.disposition,
        repair: fault.repair ?? null
      })),
      // `[INT:CON-024]`: shown as a count here; selecting it opens the ceremony, never records one.
      needsYourDecision: decisions,
      briefingAvailable: false,
      /**
       * What is known about elsewhere, and what is not. `[INT:REQ-172]`
       *
       * `count` is cheap and real; `work` is honestly `not-checked` rather than zero, because
       * nobody read those workspaces. A surface rendering `0` here would be asserting that the
       * other workspaces are empty on the evidence of never having opened them.
       */
      crossWorkspace: Object.freeze({
        count: otherWorkspaces,
        lookup: otherWorkspaces === null ? 'not-checked' : 'resolved',
        work: 'not-checked'
      }),
      choiceSet: shown.map((entry) => entry.id)
    }
  });
}

/**
 * How many workspaces exist besides this one, from the registry alone. `[INT:REQ-172]`
 *
 * One file read and no repository work: the registry is the whole world here, exactly as
 * `workspace.list` treats it, and scanning disk for likely-looking clones would be both a privacy
 * problem and a correctness one.
 *
 * Null on any failure, which the caller reports as `not-checked`. A missing or unreadable registry
 * is not evidence that a person has one workspace — it is evidence that nobody could tell.
 */
async function countOtherWorkspaces(context) {
  try {
    const entries = await readWorkspaceRegistry(workspaceRegistryFile(context.env ?? process.env));
    const active = context.workspace?.id ?? null;
    const live = entries.filter((entry) => !entry.archivedAt);
    return Math.max(0, live.filter((entry) => entry.id !== active).length);
  } catch {
    return null;
  }
}

export async function homeOverview({ subject = null, root = null, context = {} } = {}) {
  /**
   * A missing root is "no workspace selected", not an error.
   *
   * A host can legitimately open the gateway before anything is chosen — that is the first-run
   * case — and §3.2's answer for it is a menu that leads with workspace selection.
   */
  if (!root) return homeOverviewResult({
    workspace: null,
    actor: context.actor ?? null,
    subject,
    bootstrap: context.bootstrap ?? null,
    lens: context.lens ?? 'developer'
  });
  const repositoryId = context.repositoryId ?? root;
  let currentBranch = context.branch ?? null;
  if (!currentBranch && (context.repositoryId || context.workspace)) {
    try { currentBranch = gitBranch(root); } catch { /* The binding still reports the unreadable repository. */ }
  }
  const otherWorkspaces = await countOtherWorkspaces(context);
  const records = context.records ?? await workRecords(root, { ...context, repositoryId });
  let faults = context.faults ?? null;
  let faultsUnavailable = false;
  if (!faults) {
    try {
      const { listFaults } = await import('../../fault-repair.mjs');
      faults = await listFaults(root, { limit: 5 });
    } catch {
      faults = [];
      faultsUnavailable = true;
    }
  }
  let today = context.today ?? null;
  let yesterday = context.yesterday ?? null;
  let journalAvailable = context.journalAvailable !== false;
  if ((context.today === undefined || context.yesterday === undefined) && context.workspace?.id) {
    try {
      const { dailyReturnContext } = await import('../../local-work-journal.mjs');
      const daily = await dailyReturnContext(context.workspace.id, { env: context.env ?? process.env });
      if (context.today === undefined) today = daily.today;
      if (context.yesterday === undefined) yesterday = daily.yesterday;
    } catch {
      if (context.today === undefined) today = null;
      if (context.yesterday === undefined) yesterday = null;
      journalAvailable = false;
    }
  }
  let governedGoal = context.governedGoal ?? null;
  if (context.governedGoal === undefined) {
    try {
      // A workspace may select any member repository for Story work, while governed Goals are
      // owned by the lead repository. Standalone repositories use the planner root for both.
      const goalRepository = context.leadRepositoryPath ?? root;
      const [{ listGovernedGoals }, { loadConfig }] = await Promise.all([
        import('../../governed-goals.mjs'), import('../../state-stores.mjs')
      ]);
      const config = await loadConfig(goalRepository);
      const listed = listGovernedGoals({ leadRepositoryPath: goalRepository }, { config, refresh: false });
      governedGoal = listed.goals.find((goal) => !['achieved', 'abandoned', 'failed'].includes(goal.status)) ?? null;
    } catch {
      governedGoal = null;
    }
  }
  const current = {
    workId: context.workId ?? context.storyId ?? null,
    workKind: context.workKind ?? null,
    storyId: context.storyId ?? null,
    repositoryId,
    branch: currentBranch,
    repositoryScoped: !context.workId && !context.storyId && !currentBranch
  };
  const homeState = deriveHomeState(records, current);
  let latestReceipt = context.latestReceipt ?? null;
  if (context.latestReceipt === undefined && homeState.currentWork?.kind === 'story') {
    try {
      const [{ loadConfig }, { loadWorkflow }, { readStoryReviewPacket }, { composeEvidenceReceipt }] = await Promise.all([
        import('../../state-stores.mjs'), import('../../state.mjs'),
        import('../../story-lineage.mjs'), import('../../evidence-receipt.mjs')
      ]);
      const config = await loadConfig(root);
      const workflow = await loadWorkflow(root, config, homeState.currentWork.id);
      const packet = await readStoryReviewPacket(root, config, workflow);
      latestReceipt = await composeEvidenceReceipt(root, config, workflow, packet);
    } catch {
      // No submission is a normal Home state. A receipt appears only after durable evidence exists.
      latestReceipt = null;
    }
  }
  const auto = context.auto !== undefined
    ? context.auto
    : await autoHomeSummary(root, { workId: homeState.currentWork?.id ?? null });
  return homeOverviewResult({
    workspace: context.workspace ?? { id: root, name: context.workspaceName ?? root },
    repository: context.repository ?? {
      id: repositoryId,
      path: root,
      branch: currentBranch,
      head: subject?.revision?.sourceCommit ?? null,
      resolvedFrom: context.repositoryResolvedFrom ?? null
    },
    actor: context.actor ?? null,
    records,
    current,
    state: homeState,
    subject,
    faults,
    faultsUnavailable,
    lens: context.lens ?? 'developer',
    today,
    yesterday,
    journalAvailable,
    governedGoal,
    latestReceipt,
    auto,
    otherWorkspaces,
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
