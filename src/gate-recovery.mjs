import { createHash } from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { run } from './util.mjs';

/**
 * Deterministic gate-to-recovery classification.
 *
 * A gate is read-only: every finding therefore names `unchanged` as its stable state. Recovery can
 * reopen or regenerate governed work, but it must never pretend the failing gate partially applied
 * a lifecycle decision. Keep this module free of model and AST dependencies so diagnostics remain
 * available on the least capable host.
 */

function firstPhase(workflow, candidates) {
  return candidates.find((id) => workflow.phases?.[id]) ?? null;
}

function phaseFromMessage(workflow, message) {
  const escaped = workflow.phaseOrder
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((left, right) => right.length - left.length);
  if (!escaped.length) return null;
  const match = String(message).match(new RegExp(`(?:^|phase\\s+|^STALE\\s+)(${escaped.join('|')})(?:\\s|:|$)`, 'i'));
  return match ? workflow.phaseOrder.find((id) => id.toLowerCase() === match[1].toLowerCase()) ?? null : null;
}

function pathFromMessage(message) {
  const protectedPath = String(message).match(/protected process path changed on work branch:\s+([^\s]+)\s+\(/i);
  if (protectedPath) return protectedPath[1];
  const stalePath = String(message).match(/STALE\s+[^:]+:\s+(.+?)\s+changed after approval$/i);
  if (stalePath) return stalePath[1];
  const ordinary = String(message).match(/(?:missing|failed|stale|unavailable):\s+([^\s]+\.(?:md|json|ya?ml|txt|csv))/i);
  return ordinary?.[1] ?? null;
}

function storyOwner(workflow, message) {
  const explicit = phaseFromMessage(workflow, message);
  if (explicit) return explicit;
  if (/\bconformance\b/i.test(message)) return firstPhase(workflow, ['conformance', 'release']);
  // A planned-test binding is authored before implementation. Routing it to implementation makes
  // a completed Story reopen at the wrong lifecycle boundary and cannot repair the missing claim
  // record. Prefer the workflow's planning owner, including feature profiles that call that phase
  // `implementation-spec`; implementation is only a compatibility fallback for shorter profiles.
  if (/\b(?:has no planned test|missing planned test(?: evidence)?)\b/i.test(message)) {
    return firstPhase(workflow, ['planning', 'implementation-spec', 'implementation', 'verification', 'test', 'testing']);
  }
  if (/\b(?:has no observed test result|missing observed test(?: result| evidence)?)\b/i.test(message)) {
    return firstPhase(workflow, ['verification', 'test', 'testing', 'implementation', 'conformance']);
  }
  if (/\b(?:allowlisted acceptance command failed|acceptance command .*failed)\b/i.test(message)) {
    return firstPhase(workflow, ['verification', 'test', 'testing', 'implementation', 'conformance']);
  }
  if (/\b(?:AC coverage|acceptance coverage)\b/i.test(message)) {
    return firstPhase(workflow, ['implementation', 'verification', 'test', 'testing', 'conformance']);
  }
  if (/\b(?:specification index|clause coverage|specification acceptance)\b/i.test(message)) {
    return firstPhase(workflow, ['specification', 'implementation-spec', 'requirements', 'conformance']);
  }
  if (/\b(?:remote|published|publication)\b/i.test(message)) {
    return workflow.currentPhase ?? workflow.phaseOrder.at(-1) ?? null;
  }
  return workflow.currentPhase
    ?? workflow.phaseOrder.find((id) => workflow.phases?.[id]?.status !== 'approved')
    ?? workflow.phaseOrder.at(-1)
    ?? null;
}

function storyCode(message) {
  if (/protected process path changed/i.test(message)) return 'gate.protected-path.changed';
  if (/workflow\.yml differs|immutable work-item configuration snapshot/i.test(message)) return 'gate.configuration.snapshot-drift';
  if (/template snapshot changed/i.test(message)) return 'gate.template.snapshot-drift';
  if (/\b(?:has no planned test|missing planned test(?: evidence)?)\b/i.test(message)) return 'gate.acceptance.planned-test-missing';
  if (/\b(?:has no observed test result|missing observed test(?: result| evidence)?)\b/i.test(message)) return 'gate.acceptance.observed-test-missing';
  if (/\b(?:allowlisted acceptance command failed|acceptance command .*failed)\b/i.test(message)) return 'gate.acceptance.command-failed';
  if (/AC coverage:/i.test(message)) return 'gate.acceptance-criteria.unbound';
  if (/conformance report is stale/i.test(message)) return 'gate.conformance.stale';
  if (/conformance report has no row/i.test(message)) return 'gate.conformance.missing-row';
  if (/conformance report has no recognized verdict/i.test(message)) return 'gate.conformance.verdict-missing';
  if (/conformance .* remains /i.test(message)) return 'gate.conformance.blocking-verdict';
  if (/specification index is stale|specification index does not match/i.test(message)) return 'gate.specification-index.stale';
  if (/STALE .* approval:/i.test(message)) return 'gate.approval.stale';
  if (/has no required Git commit/i.test(message)) return 'gate.generation.commit-missing';
  if (/not present on the remote branch|local HEAD is not published/i.test(message)) return 'gate.publication.remote-missing';
  if (/terminal: phase .* is not approved/i.test(message)) return 'gate.terminal.phase-unapproved';
  if (/terminal: workflow is not complete/i.test(message)) return 'gate.terminal.workflow-incomplete';
  return 'gate.validation.failed';
}

function categoryForCode(code) {
  if (code.includes('publication')) return 'transport';
  if (code.includes('protected-path') || code.includes('configuration') || code.includes('template')) return 'configuration';
  if (code.includes('approval') || code.includes('terminal')) return 'lifecycle';
  if (code.includes('conformance') || code.includes('acceptance') || code.includes('specification')) return 'verification';
  return 'governance';
}

function storyRecovery(workflow, code, ownerPhase, path) {
  const workId = workflow.workItem.id;
  if (code === 'gate.publication.remote-missing') return {
    mode: 'automatic', ownerPhase, requiresReopen: false,
    command: 'singularity-flow sync', detail: 'Retry the already-created commit; lifecycle state remains unchanged.'
  };
  if (code === 'gate.protected-path.changed') return {
    mode: 'manual', ownerPhase: null, requiresReopen: false,
    command: path ? `git diff -- ${path}` : 'git diff -- singularity/workflow.yml',
    detail: 'Inspect and preserve the configuration edit, then move it through the configuration authority/state-branch refresh workflow. The gate will not discard it.'
  };
  if (code === 'gate.configuration.snapshot-drift' || code === 'gate.template.snapshot-drift') return {
    mode: 'guided', ownerPhase: null, requiresReopen: false,
    command: 'singularity-flow workspace refresh-configuration --dry-run',
    detail: 'Review the approved configuration refresh. An in-flight Story keeps its immutable snapshot; do not rewrite it silently.'
  };

  const complete = workflow.status === 'complete' && workflow.currentPhase == null;
  if (complete && ownerPhase) {
    const completion = workflow.phases?.[workflow.phaseOrder.at(-1)];
    const allowed = completion?.approvalPolicy?.rejectTo ?? [completion?.id].filter(Boolean);
    if (allowed.includes(ownerPhase) && completion?.approvalPolicy?.changeRequests?.reopenCompleted !== false) {
      return {
        mode: 'guided', ownerPhase, requiresReopen: true,
        command: `singularity-flow reopen ${workId} --to ${ownerPhase} --reason "Governance recovery: ${code}"`,
        detail: `Reopen the completed workflow at the phase that owns this evidence. Existing approved generations remain in history.`
      };
    }
    return {
      mode: 'guided', ownerPhase, requiresReopen: true,
      command: `singularity-flow reopen ${workId} --to ${ownerPhase} --reason "Governance gate recovery" --gate-recovery`,
      detail: `The ordinary completion policy does not target ${ownerPhase}. Preview the content-bound final-gate recovery plan, then repeat the command with its exact --confirm digest. No state changes during preview.`
    };
  }
  if (code === 'gate.terminal.workflow-incomplete' || code === 'gate.terminal.phase-unapproved') return {
    mode: 'guided', ownerPhase, requiresReopen: false,
    command: `singularity-flow next ${workId}`,
    detail: `Resume the current lifecycle and complete ${ownerPhase ?? 'the outstanding phase'} before rerunning the terminal gate.`
  };
  return {
    mode: 'guided', ownerPhase, requiresReopen: false,
    command: ownerPhase ? `singularity-flow recover ${workId} --phase ${ownerPhase}` : `singularity-flow recover ${workId}`,
    detail: ownerPhase
      ? `Repair or regenerate the evidence owned by ${ownerPhase}; approvals and published generations are not edited in place.`
      : 'Inspect the governed recovery plan before changing lifecycle state.'
  };
}

function planCore(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    workId: plan.workId,
    head: plan.head,
    workflowSha256: plan.workflowSha256,
    workflowStatus: plan.workflowStatus,
    currentPhase: plan.currentPhase,
    targetPhase: plan.targetPhase,
    findings: plan.findings
  };
}

function workflowSha256(workflow) {
  return `sha256:${createHash('sha256').update(canonicalJson(workflow)).digest('hex')}`;
}

function planConfirmation(plan) {
  return `sha256:${createHash('sha256').update(canonicalJson(planCore(plan))).digest('hex')}`;
}

/** Build the exact preview for a final-gate-owned reopen outside ordinary rejectTo policy. */
export function gateRecoveryReopenPlan(root, workflow, findings, targetPhase) {
  const target = String(targetPhase ?? '');
  const relevant = (findings ?? []).filter((finding) => finding?.blocking === true
    && finding.phase === target && finding.recovery?.requiresReopen === true);
  const plan = {
    schemaVersion: 1,
    kind: 'gate-recovery-reopen-plan',
    workId: workflow?.workItem?.id ?? null,
    head: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
    workflowSha256: workflowSha256(workflow),
    workflowStatus: workflow?.status ?? null,
    currentPhase: workflow?.currentPhase ?? null,
    targetPhase: target || null,
    findings: relevant.map((finding) => ({
      code: finding.code,
      phase: finding.phase,
      generation: finding.generation ?? null,
      message: finding.details?.message ?? null
    })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  };
  return {
    ...plan,
    allowed: workflow?.status === 'complete'
      && workflow?.currentPhase == null
      && Boolean(workflow?.phases?.[target])
      && relevant.length > 0,
    confirmation: planConfirmation(plan)
  };
}

export function verifyGateRecoveryReopenPlan(root, workflow, plan) {
  return Boolean(plan?.allowed === true
    && plan.kind === 'gate-recovery-reopen-plan'
    && plan.workId === workflow?.workItem?.id
    && plan.workflowStatus === 'complete'
    && plan.currentPhase == null
    && plan.targetPhase
    && workflow?.phases?.[plan.targetPhase]
    && plan.head === run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim()
    && plan.workflowSha256 === workflowSha256(workflow)
    && (plan.findings ?? []).length > 0
    && plan.findings.every((finding) => finding.phase === plan.targetPhase && finding.message)
    && plan.confirmation === planConfirmation(plan));
}

export function classifyStoryGateFailures(workflow, messages) {
  return [...new Set(messages)].map((message) => {
    const code = storyCode(message);
    const phase = storyOwner(workflow, message);
    const path = pathFromMessage(message);
    return {
      code,
      category: categoryForCode(code),
      blocking: true,
      phase,
      generation: phase ? workflow.phases?.[phase]?.generation ?? null : null,
      path,
      line: null,
      value: null,
      stableState: 'unchanged',
      details: { message },
      recovery: storyRecovery(workflow, code, phase, path)
    };
  });
}

function initiativePhase(initiative, message) {
  const explicit = initiative.phaseOrder.find((id) => String(message).startsWith(`${id}:`)
    || String(message).includes(`phase ${id} `));
  return explicit
    ?? initiative.currentPhase
    ?? initiative.phaseOrder.find((id) => initiative.phases?.[id]?.status !== 'approved')
    ?? initiative.phaseOrder.at(-1)
    ?? null;
}

export function classifyInitiativeGateFailures(initiative, messages) {
  return [...new Set(messages)].map((message) => {
    const phase = initiativePhase(initiative, message);
    const transport = /not published to/i.test(message);
    const terminal = /^terminal:/i.test(message);
    const complete = initiative.status === 'complete' && initiative.currentPhase == null;
    const code = transport
      ? 'gate.publication.remote-missing'
      : terminal ? 'gate.terminal.phase-incomplete' : 'gate.initiative.validation-failed';
    return {
      code,
      category: transport ? 'transport' : terminal ? 'lifecycle' : 'governance',
      blocking: true,
      phase,
      generation: phase ? initiative.phases?.[phase]?.generation ?? null : null,
      path: pathFromMessage(message),
      line: null,
      value: null,
      stableState: 'unchanged',
      details: { message },
      recovery: {
        mode: transport ? 'automatic' : complete ? 'manual' : 'guided',
        ownerPhase: phase,
        requiresReopen: complete,
        command: transport
          ? `singularity-flow initiative sync ${initiative.initiative.id}`
          : complete ? null : `singularity-flow initiative next ${initiative.initiative.id}`,
        detail: transport
          ? 'Retry the retained Initiative commit without replaying the phase transition.'
          : complete
            ? `The completed Initiative must return to ${phase ?? 'the phase reported by the gate'}, but Initiative lifecycle policy has no automatic reopen route. Obtain explicit human authority; no state was changed.`
          : `Return to the Initiative lifecycle owner ${phase ?? 'reported by the gate'}; the failing gate made no state change.`
      }
    };
  });
}

export function recoveryActionsForFindings(findings) {
  const actions = findings.map((finding, index) => ({
    id: `${finding.code}:${finding.phase ?? 'workflow'}:${index + 1}`,
    safe: finding.recovery.mode !== 'manual',
    automatic: finding.recovery.mode === 'automatic',
    mode: finding.recovery.mode,
    confirmation: finding.recovery.mode === 'automatic' ? 'plan-hash' : finding.recovery.mode === 'manual' ? 'human-authority' : 'none',
    command: finding.recovery.command,
    detail: finding.recovery.detail,
    ownerPhase: finding.recovery.ownerPhase,
    stableState: finding.stableState
  }));
  return [...new Map(actions.map((entry) => [`${entry.id.split(':').slice(0, -1).join(':')}:${entry.command ?? ''}`, entry])).values()];
}
