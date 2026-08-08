import { commandExists } from './util.mjs';
import { operationCatalog } from './command-registry.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';

function producerSummary(phase) {
  const policy = phase?.generationPolicy ?? { requirement: 'required', allowedProducers: ['governed-agent', 'human'], defaultProducer: 'governed-agent' };
  return {
    requirement: policy.requirement ?? 'required',
    allowedProducers: policy.allowedProducers ?? ['governed-agent', 'human'],
    defaultProducer: policy.defaultProducer ?? 'governed-agent'
  };
}

export function modelFreedomSnapshot({ definition = null, workflow = null, modelMode = { enabled: true, source: 'default' } } = {}) {
  const catalog = operationCatalog();
  const operationCounts = Object.fromEntries(['never', 'optional', 'required'].map((policy) => [policy, catalog.filter((item) => item.modelPolicy === policy).length]));
  const phase = workflow?.currentPhase ? workflow.phases?.[workflow.currentPhase] : null;
  const generation = phase ? producerSummary(phase) : null;
  const modelFreeProducer = generation?.allowedProducers.some((producer) => ['human', 'deterministic', 'external-tool'].includes(producer)) ?? true;
  const remainingPhaseIds = workflow?.phaseOrder?.length
    ? workflow.phaseOrder.slice(Math.max(0, workflow.phaseOrder.indexOf(workflow.currentPhase)))
    : null;
  const relevantPhases = remainingPhaseIds
    ? remainingPhaseIds.map((id) => workflow.phases?.[id]).filter(Boolean)
    : Object.values(definition?.phases ?? {});
  const qualityCommands = relevantPhases.flatMap((item) => item.qualityCommands ?? [])
    .map((item, index) => normalizeExternalCommand(item, index));
  const externalCounts = Object.fromEntries(['never', 'required', 'unknown']
    .map((policy) => [policy, qualityCommands.filter((item) => item.modelPolicy === policy).length]));
  const unknownStrictness = definition?.noModel?.unknownExternalCommands ?? 'warn';
  const blockers = [];
  const warnings = [];
  if (phase && generation.requirement !== 'none' && !modelFreeProducer) blockers.push(`Phase '${phase.id}' permits only governed-agent generation.`);
  if (externalCounts.required) blockers.push(`${externalCounts.required} quality command(s) require an external model.`);
  if (externalCounts.unknown && unknownStrictness === 'block') blockers.push(`${externalCounts.unknown} quality command(s) have unknown model behavior and strict no-model policy blocks them.`);
  if (externalCounts.unknown && unknownStrictness !== 'block') warnings.push(`${externalCounts.unknown} quality command(s) have unknown model behavior and will be skipped in model-disabled mode.`);
  const lifecycleStatus = blockers.length ? 'blocked' : warnings.length ? 'partial' : 'complete';
  const providerAvailable = commandExists(process.platform === 'win32' ? 'copilot.cmd' : 'copilot');
  return {
    schemaVersion: 2,
    runtime: { mode: modelMode.enabled ? 'enabled' : 'disabled', source: modelMode.source ?? 'default' },
    mode: modelMode.enabled ? 'auto' : 'disabled',
    modeSource: modelMode.source ?? 'default',
    provider: { id: 'copilot-cli', available: providerAvailable },
    operations: { total: catalog.length, ...operationCounts, unclassified: 0 },
    currentPhase: phase ? { id: phase.id, generation, modelFreeProducer } : null,
    qualityCommands: { total: qualityCommands.length, ...externalCounts, unknownStrictness },
    modelFreeLifecycleReady: blockers.length === 0,
    blockers,
    warnings,
    kernel: {
      status: catalog.some((item) => !['never', 'optional', 'required'].includes(item.modelPolicy)) ? 'blocked' : 'complete',
      registeredOperations: catalog.length,
      unclassifiedOperations: 0,
      directInvocationViolations: 0,
      classifiedOperations: catalog.length,
      modelInvocationBoundary: 'kernel-owned'
    },
    currentWorkflow: {
      status: lifecycleStatus,
      phase: phase?.id ?? null,
      generation,
      externalCommands: { total: qualityCommands.length, ...externalCounts, unknownStrictness }
    },
    surfaces: {
      cliCore: 'complete',
      vscodeCli: 'complete',
      copilotPlugin: 'outside-guarantee',
      advisoryOperations: operationCounts.required ? 'partial' : 'complete',
      cli: { status: 'complete', control: '--no-model or SINGULARITY_FLOW_NO_MODEL=1' },
      vscode: { status: 'complete', control: 'singularityFlow.modelMode' },
      externalHosts: { status: 'outside-guarantee', reason: 'Host-side extensions and MCP servers remain governed by their owning host.' }
    },
    summary: { status: lifecycleStatus, modelFreeLifecycleReady: blockers.length === 0, blockers, warnings }
  };
}

export function modelFreedomText(report) {
  const provider = report.provider.available ? 'available' : 'not found';
  const readiness = report.modelFreeLifecycleReady ? 'ready' : 'blocked';
  return [
    `Model mode: ${report.mode} (${report.modeSource})`,
    `Copilot provider: ${provider}`,
    `Operation policy: ${report.operations.never} never · ${report.operations.optional} optional · ${report.operations.required} required · ${report.operations.unclassified} unclassified`,
    `Model-free lifecycle: ${readiness}`,
    ...report.blockers.map((item) => `  - BLOCKED: ${item}`),
    ...(report.warnings ?? []).map((item) => `  - WARNING: ${item}`),
    'External hosts: outside guarantee (their owning host controls invocation)'
  ].join('\n');
}
