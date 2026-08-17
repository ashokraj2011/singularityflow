/**
 * The canonical answer to "what should I do next?".
 *
 * Home owns current-work selection and recovery priority. `nextsteps` owns lifecycle ordering. This
 * planner composes those two existing authorities without storing a third answer and without
 * turning the displayed command into ambient execution authority.
 */
import { previewAction } from '../../action-plans.mjs';
import { resolveSnapshot } from '../../commands/nextsteps.mjs';
import {
  noEffects, plannerNavigation, plannerNavigationTarget, primaryAction, sflowResult
} from '../result.mjs';
import { homeOverview } from './home-overview.mjs';

function labelFor(preview) {
  const [command, subcommand] = preview?.argv ?? [];
  if (command === 'sync') return 'Finish publishing your work';
  if (command === 'resume') return 'Resume the active Story';
  if (command === 'assign') return 'Assign the active phase';
  if (command === 'agents') return 'Restore the governed agent';
  if (command === 'wm') return 'Prepare repository grounding';
  if (command === 'inputs') return 'Resolve the required inputs';
  if (command === 'prepare' || command === 'phase') return 'Produce the current phase artifact';
  if (command === 'submit') return 'Submit the current phase for review';
  if (command === 'approve') return 'Open the governed review decision';
  if (command === 'gate') return 'Run the completion gate';
  if (command === 'pr' && subcommand) return 'Prepare the pull request';
  if (command === 'progress' || command === 'report') return 'Review the completed work';
  if (command === 'start') return 'Start new governed work';
  return 'Continue with the next governed step';
}

function preflight(home, context, preview) {
  const local = home.data?.localChanges ?? null;
  return Object.freeze([
    Object.freeze({ id: 'workspace', state: home.data?.workspace ? 'ready' : 'needed',
      detail: home.data?.workspace?.name ?? 'Choose a governed workspace.' }),
    Object.freeze({ id: 'repository', state: context.repositoryId ? 'ready' : 'needed',
      detail: context.repositoryId ?? 'Choose or open a governed repository.' }),
    Object.freeze({ id: 'identity', state: context.actor?.email || context.actor?.login ? 'ready' : 'needed',
      detail: context.actor?.email ?? context.actor?.login ?? 'Configure a stable Git email or login.' }),
    Object.freeze({ id: 'worktree', state: local == null ? 'unknown' : local.dirty ? 'attention' : 'ready',
      detail: local == null ? 'The worktree was not read.' : local.dirty
        ? `${local.files} local path(s) are preserved and will be revalidated.` : 'The worktree is clean.' }),
    Object.freeze({ id: 'remote', state: preview?.effect?.externalSideEffect ? 'required-before-mutation' : 'not-required',
      detail: preview?.effect?.externalSideEffect
        ? 'Remote access is checked by the governed command before it mutates anything.'
        : 'This recommendation does not require a remote write.' })
  ]);
}

function recommendedAction(home, guidance, workId) {
  const homePrimary = primaryAction(home);
  if (!homePrimary) return { action: null, preview: null, source: null };
  const guidanceApplies = workId ? guidance?.workId === workId : !guidance?.workId;
  const suggested = guidanceApplies
    ? (guidance?.actions ?? []).find((entry) => entry.timing === 'now')
      ?? guidance?.actions?.[0] ?? null
    : null;
  let preview = null;
  try {
    preview = suggested ? previewAction(suggested) : previewAction({
      timing: 'now', command: homePrimary.fallback?.command, skill: homePrimary.fallback?.skill,
      reason: null
    });
  } catch {
    preview = null;
  }
  if (!preview) return { action: homePrimary, preview: null, source: suggested };
  const target = plannerNavigationTarget(homePrimary);
  if (!target) return { action: homePrimary, preview, source: suggested };
  return {
    action: plannerNavigation({
      ...homePrimary,
      id: 'developer:recommended',
      label: labelFor(preview),
      reasonCode: 'developer.recommended-next',
      emphasis: 'primary',
      fallback: {
        label: labelFor(preview),
        command: preview.command,
        skill: preview.skill
      },
      slots: {
        ...(homePrimary.slots ?? {}),
        command: preview.command,
        reason: preview.reason ?? ''
      },
      effect: {
        summaryMessageId: 'developer.recommended-next',
        target: preview.argv?.[0] ?? null
      }
    }, target.operationId, target.arguments),
    preview,
    source: suggested
  };
}

function secondary(action) {
  const target = plannerNavigationTarget(action);
  if (!target) return { ...action, emphasis: 'secondary' };
  return plannerNavigation({ ...action, emphasis: 'secondary' }, target.operationId, target.arguments);
}

export async function developerNext(input = {}) {
  const { root = null, context = {} } = input;
  const home = await homeOverview(input);
  const workId = home.data?.activeWork?.id
    ?? home.next.find((entry) => entry.slots?.work)?.slots?.work
    ?? null;
  let guidance = null;
  let guidanceError = null;
  if (root) {
    try {
      guidance = await resolveSnapshot(['nextsteps', workId].filter(Boolean), { root });
    } catch (error) {
      guidanceError = error?.message ?? String(error);
    }
  }
  const recommendation = recommendedAction(home, guidance, workId);
  const next = recommendation.action
    ? [recommendation.action, ...home.next.filter((entry) => entry.id !== primaryAction(home)?.id)
      .map(secondary)]
    : home.next;
  const hasWork = Boolean(workId);

  return sflowResult({
    kind: home.kind,
    operation: { id: 'developer.next', classification: 'read' },
    subject: home.subject,
    outcome: {
      status: home.outcome.status,
      messageId: 'gateway.developer-next',
      slots: { ...home.outcome.slots, work: workId ?? 'none' }
    },
    effects: noEffects(),
    why: [{
      code: recommendation.preview ? 'developer.recommended-next'
        : hasWork ? 'work.no-legal-action' : 'developer.start-with-intake',
      source: 'deterministic',
      reference: workId,
      slots: { work: workId ?? 'none' }
    }, ...home.why],
    warnings: home.warnings,
    preserved: home.preserved,
    checklist: home.checklist,
    next,
    restState: home.restState,
    data: {
      ...home.data,
      guidance: Object.freeze({
        schemaVersion: 1,
        stateSource: 'durable-records',
        state: guidance?.state ?? (root ? 'unavailable' : 'no_workspace'),
        workId,
        currentPhase: guidance?.currentPhase ?? home.data?.activeWork?.phase ?? null,
        recommendation: recommendation.preview ? Object.freeze({
          label: recommendation.action?.label ?? labelFor(recommendation.preview),
          command: recommendation.preview.command,
          skill: recommendation.preview.skill,
          reason: recommendation.preview.reason,
          confirmation: recommendation.preview.confirmation,
          effect: recommendation.preview.effect
        }) : null,
        actions: Object.freeze([...(guidance?.actions ?? [])]),
        evidence: guidance?.evidence ?? null,
        preflight: preflight(home, context, recommendation.preview),
        requiredInputs: hasWork ? [] : ['work description', 'definition of done', 'remote base branch'],
        unavailableReason: guidanceError
      })
    }
  });
}
