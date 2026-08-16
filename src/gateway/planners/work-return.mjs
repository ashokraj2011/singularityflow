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
 * ## Three states, and none of them is an error
 *
 * There is an open interval and it reconciles; there is one and it does not; or there is no
 * interval at all — the developer never started governed work on this phase, or already closed it.
 * The third is `[DHR:REQ-046]`'s unattached local work, and it is a perfectly ordinary answer. The
 * underlying function throws for it, which is right for a command and would be a crashed sidebar
 * here.
 */
import { SingularityFlowError } from '../../util.mjs';
import { catalogued } from '../catalog.mjs';
import { localChangesFor } from './work-continue.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';
import { workRecords } from '../work-records.mjs';

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
      state: report?.worktree?.cleanApplicationTree ? 'met' : 'unmet',
      source: 'evidence',
      evidence: report?.reconciliationSha256 ?? null,
      action: null,
      slots: { uncommitted: String(report?.worktree?.uncommittedApplicationPaths?.length ?? 0) }
    }
  ];
}

/**
 * The briefing, given whatever could be read.
 *
 * `report` is null when there is no open interval — not a failure, and the difference is carried in
 * `why[]` rather than by an empty checklist that reads like "nothing changed".
 */
export function workReturnResult(item, { report = null, localChanges = null, subject = null, acknowledgedAt = null } = {}) {
  const attached = Boolean(report);
  const decision = report?.decision ?? null;

  /**
   * "Since you were here" is only said when there is a *when*. `[DHR:REQ-024]`
   *
   * Without a last-acknowledged time the honest heading is the current state, because a reader told
   * "since you were here" will read the list as a delta and act on the assumption that anything
   * absent from it did not change.
   */
  const framing = acknowledgedAt ? 'return.since-you-were-here' : 'return.current-state';

  const why = [{ code: framing, source: 'deterministic', reference: acknowledgedAt, slots: {} }];
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

  return sflowResult({
    kind: 'read',
    operation: { id: 'work.return', classification: 'read' },
    subject: subject ?? {
      kind: item.kind,
      id: item.id,
      revision: {
        sourceCommit: report?.baseline?.sourceBaseCommit ?? null,
        worktreeHash: localChanges?.worktreeHash ?? null,
        lifecycleHash: null,
        policyHash: null,
        registryHash: null
      }
    },
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
      ? [{
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
      }]
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
  const item = records.items.find((entry) => entry.id === args.workId);
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

  return workReturnResult(item, {
    subject,
    report: await reconciliationFor(root, item, context),
    /**
     * The same reader `work.continue` uses, deliberately.
     *
     * Two briefings that count changed paths differently will disagree in front of someone who has
     * both open, and the one they believe will be whichever they read second.
     */
    localChanges: context.localChanges ?? localChangesFor(root),
    acknowledgedAt: context.acknowledgedAt ?? null
  });
}

/**
 * Reconcile without writing, and treat "no open interval" as an answer.
 *
 * Every failure here is a *missing fact*, not a broken planner: no interval, no baseline, a phase
 * that does not use intervals. The briefing renders in all of them and says which — the alternative
 * is a sidebar that disappears because the developer had not started governed work yet.
 */
async function reconciliationFor(root, item, context) {
  if (context.reconciliation !== undefined) return context.reconciliation;
  try {
    /**
     * Imported here rather than at module load.
     *
     * `state.mjs` and `work-intervals.mjs` pull in the publication kernel and the ledger, and this
     * planner is on the sidebar's path — the read model's own cost is why the snapshot took 62
     * seconds. A briefing that is never asked for should cost nothing to have.
     */
    const [{ reconcileWorkInterval }, { loadWorkflow, workDir }, { loadConfig }] = await Promise.all([
      import('../../work-intervals.mjs'), import('../../state.mjs'), import('../../config.mjs')
    ]);
    const config = await loadConfig(root);
    const workflow = await loadWorkflow(root, config, item.id);
    if (!workflow?.workIntervals?.current) return null;
    return await reconcileWorkInterval(root, config, workflow, {
      itemDirectory: workDir(root, config, workflow.workItem.id),
      // A read never persists `[INT:CON-041]`. See the module note.
      writeLocal: false
    });
  } catch {
    return null;
  }
}
