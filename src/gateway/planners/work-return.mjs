/**
 * `work.return`: what happened while you were away. `[DHR:REQ-040]`–`[DHR:REQ-046]`
 *
 * The briefing a developer needs when they come back to work they left — what changed, whether it
 * is reconcilable, and what is safe to do now. `src/work-intervals.mjs` has computed exactly this
 * for a long time and no planner imported it: the reconciliation existed only behind
 * `sflow story interval reconcile`, so the shell had nothing to render and DHR §6 had nothing to
 * compose. This is that import.
 *
 * ## A read that writes is not a read
 *
 * `reconcileWorkInterval` defaults to `writeLocal: true` and drops a reconciliation JSON into
 * `.git/singularity-flow/reconciliations/`. Correct for the command, wrong here: this planner is
 * `classification: 'read'`, the result declares every effect false, and a producer that persisted a
 * file while declaring `filesChanged: false` would be lying in the one record the contract exists
 * to make trustworthy. `writeLocal: false`, deliberately and permanently.
 *
 * ## Three states, and configuration errors are still errors
 *
 * There is an open interval and it reconciles; there is one and it does not; or there is no
 * interval at all — the developer never started governed work on this phase, or already closed it.
 * The third is `[DHR:REQ-046]`'s unattached local work, and it is a perfectly ordinary answer. The
 * underlying function throws for it, which is right for a command and would be a crashed sidebar
 * here. That ordinary state is checked explicitly. Parse errors, missing packaged resources, and
 * invalid baselines must propagate; calling all of those "no interval" makes corruption look safe.
 */
import { SingularityFlowError } from '../../util.mjs';
import { catalogued } from '../catalog.mjs';
import { localChangesFor } from './work-continue.mjs';
import { subjectWith } from '../handles.mjs';
import { noEffects, plannerNavigation, preservedAll, sflowResult } from '../result.mjs';
import { resolveWorkRecord, workRecords } from '../work-records.mjs';
import { branch, head } from '../../git.mjs';

/**
 * What a reconciliation can say about a changed path, in the order a reader meets it.
 *
 * `planned` first because it is the reassuring one, and a briefing that leads with problems trains
 * people not to open it.
 */
const VERDICTS = Object.freeze(['planned', 'unplanned', 'protected']);

const verdictCode = (verdict) => catalogued(`return.${verdict}`, 'return.unrecognised-verdict');

/**
 * Turn a reconciliation report into the shape the card renders. `[UXH:REQ-062]`
 *
 * Exported and pure so the whole briefing can be tested without a repository, and so the
 * report-to-checklist mapping is one function rather than a shape assembled inline.
 */
export function returnChecklist(report) {
  const summary = report?.summary ?? {};
  const worktree = report?.worktree ?? report?.target ?? {};
  return [
    {
      id: 'planned',
      code: verdictCode('planned'),
      // Met when nothing is unplanned: "some of it was planned" is not a gate anyone passes.
      state: summary.unplanned === 0 ? 'met' : 'unmet',
      source: 'evidence',
      evidence: report?.reconciliationSha256 ?? null,
      action: null,
      slots: { planned: String(summary.planned ?? 0), changed: String(summary.changedPaths ?? 0) }
    },
    {
      id: 'protected',
      code: verdictCode('protected'),
      state: (summary.protected ?? 0) === 0 ? 'met' : 'unmet',
      source: 'policy',
      evidence: report?.reconciliationSha256 ?? null,
      action: null,
      slots: { count: String(summary.protected ?? 0) }
    },
    {
      id: 'worktree',
      code: 'return.clean-worktree',
      state: worktree.cleanApplicationTree ? 'met' : 'unmet',
      source: 'evidence',
      evidence: report?.reconciliationSha256 ?? null,
      action: null,
      slots: { uncommitted: String(worktree.uncommittedApplicationPaths?.length ?? 0) }
    }
  ];
}

/**
 * The briefing, given whatever could be read.
 *
 * `report` is null when there is no open interval — not a failure, and the difference is carried in
 * `why[]` rather than by an empty checklist that reads like "nothing changed".
 */
export function workReturnResult(item, {
  report = null, localChanges = null, subject = null, acknowledgedAt = null, repository = null
} = {}) {
  const attached = Boolean(report);
  const decision = report?.decision ?? null;

  /**
   * "Since you were here" is only said when there is a *when*. `[DHR:REQ-024]`
   *
   * Without a last-acknowledged time the honest heading is the current state, because a reader told
   * "since you were here" will read the list as a delta and act on the assumption that anything
   * absent from it did not change.
   */
  // An acknowledgement timestamp is not a Git baseline. The reconciliation below is computed from
  // the work interval's source commit, which may be days older, so labelling it "since you were
  // here" would overstate the time boundary. A future acknowledgement-relative report can opt in
  // by carrying the exact timestamp it used as `acknowledgementBaseline`.
  const acknowledgementBounded = Boolean(
    acknowledgedAt && report?.acknowledgementBaseline === acknowledgedAt
  );
  const framing = acknowledgementBounded ? 'return.since-you-were-here' : 'return.current-state';

  const why = [{
    code: framing,
    source: 'deterministic',
    reference: acknowledgementBounded ? acknowledgedAt : null,
    slots: {}
  }];
  if (attached) {
    why.push({
      code: 'return.reconciled',
      source: 'evidence',
      reference: report.reconciliationSha256 ?? null,
      slots: {
        changed: String(report.summary?.changedPaths ?? 0),
        unplanned: String(report.summary?.unplanned ?? 0)
      }
    });
  } else {
    /**
     * `[DHR:REQ-046]`: local work with no governed interval attached to it.
     *
     * Said plainly, because the reader's uncommitted files are real and the absence of an interval
     * is about governance, not about their work having gone missing.
     */
    why.push({ code: 'return.no-open-interval', source: 'lifecycle', reference: item.id, slots: {} });
  }

  const changedLocally = localChanges?.files ?? null;
  const warnings = [];
  if (changedLocally === null) {
    warnings.push({ code: 'return.local-changes-unread', source: 'unavailable', slots: {} });
  }
  if (!attached) {
    warnings.push({ code: 'return.reconciliation-unavailable', source: 'unavailable', slots: { work: item.id } });
  }
  if (acknowledgedAt && !acknowledgementBounded) {
    warnings.push({
      code: 'return.acknowledgement-boundary-unavailable',
      source: 'unavailable',
      reference: acknowledgedAt,
      slots: {}
    });
  }

  return sflowResult({
    kind: 'read',
    operation: { id: 'work.return', classification: 'read' },
    /**
     * The interval's baseline and the tree as it is now, over the handle's own subject.
     *
     * Overlaid rather than chosen between: `subject ?? {…}` meant that reading this through the
     * kernel discarded both facts below in favour of a binding computed before anything was read.
     */
    subject: subjectWith(subject, {
      kind: item.kind,
      id: item.id,
      revision: {
        sourceCommit: report?.baseline?.sourceBaseCommit ?? null,
        worktreeHash: localChanges?.worktreeHash ?? null,
        worktreeAlgorithm: localChanges?.worktreeAlgorithm ?? null
      }
    }),
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.returned',
      slots: {
        work: item.id,
        phase: item.phase ?? 'none',
        changed: String(report?.summary?.changedPaths ?? changedLocally ?? 0)
      }
    },
    effects: noEffects(),
    why,
    warnings,
    /**
     * The sentence a returning developer is actually looking for. `[DHR:REQ-061]` `[DHR:REQ-045]`
     *
     * They left work behind and have come back to a screen telling them what moved. Before any of
     * that lands, they need to know the screen did not touch it — a briefing is a read, and reading
     * is the one thing it does.
     */
    preserved: preservedAll('return.nothing-was-carried-out', { reference: item.id }),
    checklist: attached ? returnChecklist(report) : [],
    next: attached && decision?.eligibleForSubmission === false
      ? [plannerNavigation({
        handle: `return:${item.id}:reconcile`,
        id: 'return:reconcile',
        label: 'Reconcile this work interval',
        rank: 0,
        kind: 'read',
        reasonCode: 'return.reconcile-before-submitting',
        confirmation: 'none',
        interaction: 'navigation',
        emphasis: 'primary',
        executable: false,
        fallback: { label: 'Reconcile', command: `sflow story interval reconcile --work-id ${item.id}` }
      }, 'work.continue', { workId: item.id, workKind: item.kind })]
      : [],
    /**
     * Nothing to do is an answer `[INT:REQ-041]`.
     *
     * A briefing whose honest content is "you are where you left off" must say so rather than
     * ending blank, which reads as a failed load.
     */
    restState: attached && decision?.eligibleForSubmission === false ? null : 'informational',
    data: {
      work: item.id,
      phase: item.phase,
      attached,
      localChanges,
      acknowledgedAt,
      workItem: {
        id: item.id,
        title: item.title ?? item.id,
        kind: item.kind,
        phase: item.phase ?? null,
        phaseLabel: item.phaseLabel ?? item.phase ?? null,
        status: item.status ?? null,
        group: item.group ?? null,
        rail: item.rail ?? []
      },
      lifecycle: {
        approved: (item.rail ?? []).filter((phase) => phase.state === 'done').length,
        total: (item.rail ?? []).length
      },
      repository,
      recovery: { required: item.group === 'recovery-required' },
      reconciliation: report
        ? {
          sha256: report.reconciliationSha256,
          reconciledAt: report.reconciledAt,
          summary: report.summary,
          decision: report.decision,
          // Bounded: a briefing is a summary, and the full set is in the reconciliation record.
          findings: (report.findings ?? []).slice(0, 100)
        }
        : null
    }
  });
}

export async function workReturn({ arguments: args = {}, subject = null, root = null, context = {} } = {}) {
  if (!root) throw new SingularityFlowError('work.return requires the repository root it should read.', { code: 'WORK_RETURN_NO_ROOT' });
  const records = await workRecords(root, { includeCompleted: true, ...context });
  const item = resolveWorkRecord(records, args);
  if (!item) {
    return sflowResult({
      kind: 'refusal',
      operation: { id: 'work.return', classification: 'read' },
      outcome: { status: 'refused', messageId: 'gateway.refused', slots: { workId: args.workId } },
      effects: noEffects(),
      why: [{ code: 'work.not-in-this-repository', source: 'lifecycle', slots: { workId: args.workId } }],
      preserved: preservedAll('work.nothing-was-carried-out', { reference: args.workId }),
      restState: 'blocked'
    });
  }

  const localChanges = context.localChanges ?? localChangesFor(root);
  let repository;
  try {
    repository = { branch: context.branch ?? branch(root), head: head(root) };
  } catch {
    repository = { branch: context.branch ?? null, head: null };
  }
  return workReturnResult(item, {
    subject,
    report: await reconciliationFor(root, item, context),
    /**
     * The same reader `work.continue` uses, deliberately.
     *
     * Two briefings that count changed paths differently will disagree in front of someone who has
     * both open, and the one they believe will be whichever they read second.
     */
    localChanges,
    acknowledgedAt: context.acknowledgedAt ?? null,
    repository
  });
}

/**
 * Reconcile without writing, and treat only the explicit "no open interval" state as an answer.
 */
export async function reconciliationFor(root, item, context) {
  if (context.reconciliation !== undefined) return context.reconciliation;
  /**
   * Imported here rather than at module load.
   *
   * `state.mjs` and `work-intervals.mjs` pull in the publication kernel and the ledger, and this
   * planner is on the sidebar's path — the read model's own cost is why the snapshot took 62
   * seconds. A briefing that is never asked for should cost nothing to have.
   */
  const [{ reconcileWorkInterval }, { loadWorkflow, workDir }, { loadDefinition }] = await Promise.all([
    import('../../work-intervals.mjs'), import('../../state.mjs'), import('../../config.mjs')
  ]);
  const config = await loadDefinition(root);
  const workflow = await loadWorkflow(root, config, item.id);
  const interval = workflow?.workIntervals?.current;
  if (!interval || interval.status !== 'open' || interval.phaseId !== workflow.currentPhase) return null;
  return reconcileWorkInterval(root, config, workflow, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    // A read never persists `[INT:CON-041]`. See the module note.
    writeLocal: false
  });
}
