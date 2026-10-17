/** Canonical in-memory Story hydration; no repository reads or lifecycle mutations. */
import { readRecord, currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';
import { normalizeSessionPolicy } from './session-policy.mjs';
import { normalizeContextPolicy } from './context-policy.mjs';
import { DEFAULT_APPROVAL_AUTHORITY } from './approval-authority.mjs';
import { pinCodeDeliveryTask } from './code-delivery-policy.mjs';
import { normalizeSourceBoundary } from './source-boundary.mjs';
export function normalizeCurrentWorkflow(workflow) {
  workflow = readRecord('story-workflow', workflow).record;
  const missing = [
    ['resolution', workflow.resolution],
    ['resolution.session', workflow.resolution?.session],
    ['resolution.contextPolicy', workflow.resolution?.contextPolicy],
    ['resolution.sequenceGates', workflow.resolution?.sequenceGates],
    ['lineage', workflow.lineage],
    ['usage', workflow.usage],
    ['telemetry', workflow.telemetry]
  ].filter(([, value]) => value == null).map(([name]) => name);
  if (missing.length) {
    throw new SingularityFlowError(
      `Story workflow schema ${currentSchemaVersion('story-workflow')} is incomplete (${missing.join(', ')}). Run singularity-flow factory-reset and recreate the Story.`
    );
  }
  workflow.resolution.session = normalizeSessionPolicy(workflow.resolution.session);
  workflow.resolution.contextPolicy = normalizeContextPolicy(workflow.resolution.contextPolicy);
  workflow.lineage.childBranches ??= [];
  workflow.documents ??= { count: 0, updatedAt: null };
  workflow.collaboration ??= { assignments: {}, notifications: [] };
  workflow.collaboration.assignments ??= {};
  workflow.collaboration.notifications ??= [];
  workflow.sequenceOverrides ??= [];
  workflow.changeRequests ??= [];
  workflow.repairBudgets ??= {};
  workflow.workIntervals ??= { schemaVersion: 1, current: null, history: [], escalations: [] };
  workflow.workIntervals.history ??= [];
  workflow.workIntervals.escalations ??= [];
  workflow.usage.exactRecords ??= 0; workflow.usage.unavailableRecords ??= 0;
  workflow.usage.byPhase ??= {}; workflow.usage.byAgent ??= {}; workflow.usage.byWorkType ??= {}; workflow.usage.byWorkItem ??= {};
  for (const id of workflow.phaseOrder) {
    const phase = workflow.phases[id];
    if (phase.owner != null || phase.suggestedAgents != null) throw new SingularityFlowError(`Workflow phase '${id}' contains removed role-selection state. Recreate this development work item with the current agent-only workflow.`);
    phase.defaultAgent ??= workflow.resolution.phases?.find((item) => item.id === id)?.defaultAgent ?? null;
    phase.approvalPolicy ??= { authorities: [DEFAULT_APPROVAL_AUTHORITY], minimum: 1, rejectTo: [id] };
    phase.approvalPolicy.mode ??= 'required';
    if (phase.approvalPolicy.mode !== 'none') phase.approvalPolicy.authorities ??= [DEFAULT_APPROVAL_AUTHORITY];
    phase.generationPolicy ??= workflow.resolution.phases?.find((item) => item.id === id)?.generation ?? { requirement: 'required', producer: 'agent' };
    phase.generationPolicy = pinCodeDeliveryTask(phase, 'generationPolicy');
    phase.mcp ??= structuredClone(workflow.resolution.phases?.find((item) => item.id === id)?.mcp ?? { requiredServers: [], requireSmoke: false, evidence: [] });
    phase.repairBudget ??= structuredClone(workflow.resolution.phases?.find((item) => item.id === id)?.repairBudget ?? null);
    delete phase.approvalPolicy.agents;
    phase.writeScope ??= 'source-and-artifact'; phase.comparison ??= {};
    phase.sourceBoundary ??= normalizeSourceBoundary(
      workflow.resolution.phases?.find((item) => item.id === id)?.sourceBoundary,
      id
    );
    phase.inputs ??= workflow.resolution.phases?.find((item) => item.id === id)?.inputs ?? [];
    phase.remoteOutputs ??= [];
    phase.generation ??= phase.artifacts?.length ? 1 : 0;
    phase.usage ??= [];
    phase.telemetry ??= [];
    phase.approvals ??= [];
    phase.generationPublications ??= [];
    phase.submissionArchitectureDecision ??= null;
    phase.artifactRegistrationRepairs ??= [];
  }
  return workflow;
}
