/** Shared Change Flight Plan projection for the generic MCP/gateway surface. */
import { previewChangeFlightPlan } from '../../change-flight-plan.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { noEffects, preservedAll, sflowResult } from '../result.mjs';

export async function impactWhatIf({ operation = null, arguments: args = {}, subject = null, root = null } = {}) {
  if (!root) throw new SingularityFlowError('impact.what-if requires the repository root it should read.', { code: 'CFP_TARGET_NOT_FOUND' });
  const proposal = String(args.proposal ?? '').trim();
  if (!proposal) throw new SingularityFlowError('Describe the hypothetical change to preview.', { code: 'CFP_TARGET_NOT_FOUND' });
  const plan = await previewChangeFlightPlan(root, {
    intent: proposal,
    ...(args.scope ? { file: String(args.scope) } : {}),
    source: 'gateway',
    // Machine-local disposable persistence lets the exact-confirm terminal ceremony accept this
    // same plan. It is not governed lifecycle state and does not touch Git refs or tracked files.
    persist: true,
    ast: args.ast !== false
  });
  return sflowResult({
    kind: 'read',
    operation: { id: operation?.id ?? 'impact.what-if', classification: 'read' },
    subject,
    outcome: {
      status: 'succeeded', messageId: 'gateway.read',
      slots: {
        findings: String(plan.findings.length), unknowns: String(plan.unknowns.length),
        status: plan.status
      }
    },
    effects: noEffects(),
    why: [{
      code: 'impact.from-committed-evidence', source: 'deterministic',
      reference: plan.baseline.revision,
      slots: { planId: plan.planId, findings: String(plan.findings.length) }
    }],
    warnings: plan.unknowns.map((finding) => ({
      code: 'impact.evidence-gap', source: 'unavailable',
      slots: { field: finding.subject, findingId: finding.findingId }
    })),
    preserved: preservedAll('gateway.nothing-was-carried-out', { reference: plan.planId }),
    next: [{
      handle: `ceremony:impact-start:${plan.planId}`,
      id: `impact:start:${plan.planId}`,
      label: 'Start this change safely',
      rank: 0,
      kind: 'ceremony',
      reasonCode: 'impact.start-reviewed-plan',
      confirmation: 'ceremony',
      interaction: 'ceremony',
      emphasis: 'primary',
      executable: false,
      fallback: {
        label: 'Start in the terminal',
        command: `sflow impact start ${plan.planId} --work-id WORK-ID --work-type TYPE --confirm ${plan.planId}`
      }
    }],
    restState: null,
    data: { changeFlightPlan: plan }
  });
}

export async function impactWhatIfAssisted(input = {}) {
  // The assisted operation's deterministic fallback is deliberately the identical fact set. A
  // model interpretation may add inferred candidates elsewhere, but cannot upgrade these facts.
  return impactWhatIf(input);
}
