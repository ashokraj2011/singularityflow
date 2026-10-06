import path from 'node:path';
import { verifyClarificationRecord } from './clarifications.mjs';
import { collectInputs } from './inputs.mjs';
import { effectivePhasePublicationProducer } from './manual-authorship.mjs';
import { verifyPhaseMcpRequirements } from './mcp-evidence.mjs';
import { assertMcpPhaseReadiness } from './mcp-readiness.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { phaseGroundingPreflight } from './phase-grounding-preflight.mjs';
import { requiredStepActionHold } from './step-action-receipts.mjs';
import { SingularityFlowError } from './util.mjs';

/**
 * Local, read-only publication dependencies shared by preview, recovery and the transaction.
 * Never compose prompts, answer questions, deliver integrations, or run/warm an MCP host here.
 * A successful preview is not a receipt: publication re-reads these checks before writing.
 */
export async function inspectPhasePublicationReadiness(root, config, workflow, phase, {
  modelEnabled = true, producer = effectivePhasePublicationProducer(phase, { modelEnabled }),
  generation = phase.status === 'in_progress' ? nextPhaseGeneration(phase) : Number(phase.generation ?? 0),
  agent = null
} = {}) {
  const itemRelative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const itemDirectory = path.join(root, itemRelative);
  const blockers = [];
  const actions = [];
  const warnings = [];
  const failures = [];
  const add = (id, category, errors, route, { code = null, file = null, message = null } = {}) => {
    if (!errors.length) return;
    blockers.push(...errors.map((error) => ({
      code: `phase.${id}.not-ready`, category, path: file, line: null, message: error,
      details: { sourceCode: code }
    })));
    actions.push({
      id: `resolve-${id}:${phase.id}`, safe: true, automatic: false, mode: 'guided',
      confirmation: 'none', skill: null, ...route
    });
    failures.push({ code, message: message ?? `Phase ${phase.id} ${id} is not ready:\n- ${errors.join('\n- ')}` });
  };
  const capture = async (read) => {
    try { return await read(); }
    catch (error) { return { errors: [error.message], warnings: [], sourceCode: error.code ?? null,
      state: error.details?.repairLoop ?? null }; }
  };
  const repair = await capture(async () => {
    const { assertPhaseRepairSettled } = await import('./phase-repair-journal.mjs');
    return { errors: [], state: await assertPhaseRepairSettled(root, workflow, phase) };
  });
  add('repair-loop', 'repair-coordination', repair.errors, {
    command: repair.sourceCode === 'PHASE_REPAIR_JOURNAL_INVALID' ? 'singularity-flow doctor --json'
      : `singularity-flow appeal repair-resume --phase ${phase.id} --json`,
    skill: repair.sourceCode === 'PHASE_REPAIR_JOURNAL_INVALID' ? '/sf-doctor' : '/sf-appeal',
    detail: 'Resume and recheck the recorded attempt. No new budget, passing test or approval is inferred from an interrupted repair.'
  }, { code: repair.sourceCode ?? 'PHASE_REPAIR_RECHECK_REQUIRED' });
  if (workflow.phaseAppeals !== undefined || workflow.phaseAppealDecisions !== undefined) {
    const appeals = await capture(async () => {
      const { assertPhaseAppealsResolved } = await import('./phase-appeals.mjs');
      await assertPhaseAppealsResolved(root, config, workflow, phase);
      return { errors: [] };
    });
    add('appeal', 'appeal', appeals.errors, {
      command: `singularity-flow appeal list --phase ${phase.id} --json`, skill: '/sf-appeal',
      detail: 'Review the exact retained appeal. Scope accounting is separate from intent amendment, risk acceptance, tests and phase approval.'
    }, { code: appeals.sourceCode ?? 'PHASE_APPEAL_REVIEW_REQUIRED' });
  }

  const integration = await capture(async () => {
    const hold = await requiredStepActionHold(root, config, workflow);
    return { hold, errors: hold ? [`${hold.what}. ${hold.because}.`] : [] };
  });
  add('integration', 'integration', integration.errors, {
    command: integration.hold?.nextAction ?? 'singularity-flow integrations status --json',
    detail: 'Inspect the required delivery and record its verified receipt. Review an unknown prior outcome before retrying; do not send or acknowledge it automatically.'
  }, { code: integration.sourceCode ?? 'STEP_ACTION_REQUIRED_UNRECORDED' });

  const inputs = await capture(() => collectInputs(root, workflow, phase, {
    definition: config, itemDirectory, itemRelative, generation
  }));
  warnings.push(...(inputs.warnings ?? []));
  add('inputs', 'inputs', inputs.errors, {
    command: `singularity-flow inputs ${phase.id} --dry-run --json`, skill: '/sf-inputs',
    detail: 'Inspect the approved input bindings. Restore the exact approved bytes, or request governed rework of the producer phase; do not edit approved hashes or approve replacement evidence automatically.'
  }, { code: inputs.sourceCode ?? 'PHASE_INPUTS_NOT_READY' });

  const mcpHost = await capture(async () => ({
    ...(await assertMcpPhaseReadiness(root, workflow, phase)), errors: []
  }));
  add('mcp-host', 'host', mcpHost.errors, {
    command: 'singularity-flow mcp doctor --json', skill: '/sf-mcp',
    detail: 'Inspect the pinned MCP host, warm proof and smoke receipt. Follow its explicit setup or authorization route before collecting evidence; no host was started by this check.'
  }, { code: mcpHost.sourceCode ?? 'MCP_PHASE_NOT_READY', message: mcpHost.errors.join('\n') });

  const grounding = await phaseGroundingPreflight(root, config, workflow, phase, {
    configuredProducer: producer, generation, ownership: { proven: Boolean(agent), agent }
  });
  blockers.push(...grounding.blockers);
  actions.push(...grounding.actions.map((route) => ({
    id: `resolve-grounding:${phase.id}`, safe: true, automatic: false, mode: 'guided',
    confirmation: 'none', ...route
  })));
  warnings.push(...grounding.check.warnings);
  if (grounding.blockers.length) failures.push({ code: 'PHASE_GROUNDING_NOT_READY',
    message: `Phase ${phase.id} grounding is not ready:\n- ${grounding.check.errors.join('\n- ')}` });

  const clarification = producer === 'governed-agent'
    ? await capture(() => verifyClarificationRecord(root, config, workflow, phase, {
        generation, groundingRecord: grounding.check.record
      }))
    : { errors: [], warnings: [], record: null, path: null, sha256: null };
  warnings.push(...clarification.warnings);
  add('clarification', 'clarification', clarification.errors, {
    command: `singularity-flow clarification status ${phase.id} --json`,
    detail: 'Ask the human checkpoint questions and record the actual answers against this generation. If a saved answer is stale, inspect its binding before obtaining a new response; never fabricate or copy an approval.'
  }, { code: clarification.sourceCode ?? 'PHASE_CLARIFICATION_NOT_READY', file: clarification.path });

  const mcpEvidence = await capture(() => verifyPhaseMcpRequirements(root, workflow, phase, {
    itemDirectory, targetGeneration: generation
  }));
  add('mcp-evidence', 'external-evidence', mcpEvidence.errors, {
    command: `singularity-flow phase show ${phase.id} --json`,
    detail: 'Collect the exact required tools and durable outputs for this phase generation using the authorized MCP host. A missing or invalid receipt cannot be replaced by a prose claim or another generation\'s evidence.'
  }, { code: mcpEvidence.sourceCode ?? 'MCP_EVIDENCE_REQUIRED' });

  return { blockers, actions, failures, warnings,
    repairLoop: repair.state ?? { status: 'needs-owner', code: repair.sourceCode, automaticReset: false },
    grounding: grounding.projection, clarification, inputs, mcpHost, mcpEvidence };
}

/** Transaction guard over the same checks; never accept a caller-supplied preview as authority. */
export async function assertPhasePublicationReadiness(root, config, workflow, phase, options = {}) {
  const result = await inspectPhasePublicationReadiness(root, config, workflow, phase, options);
  if (result.failures.length) throw new SingularityFlowError(result.failures[0].message, {
    code: result.failures[0].code,
    details: { workId: workflow.workItem.id, phase: phase.id,
      findings: result.blockers, actions: result.actions, recoveryCommands: result.actions }
  });
  return result;
}
