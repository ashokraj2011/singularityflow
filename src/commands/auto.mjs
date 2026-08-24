/** `singularity-flow auto` — bounded, exact-hash-ratified Story automation. */
import { repoRoot } from '../git.mjs';
import { fileURLToPath } from 'node:url';
import { loadDefinition } from '../config.mjs';
import {
  createAutoPlan, readAutoPlan, synthesizeAutoPlanProposal
} from '../auto/auto-plan.mjs';
import { startAutoFlight } from '../auto/auto-flight.mjs';
import { executeAutoFlightStep } from '../auto/auto-executor.mjs';
import {
  discardAutoFlight, haltAutoFlight, pauseAutoFlight, readAutoFlightState,
  buildAutoFlightReport, readAutoFlightReport, renderAutoFlightReport, resumeAutoFlight
} from '../auto/auto-flight-store.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString, run as runProcess, SingularityFlowError } from '../util.mjs';

const SUBCOMMANDS = new Set(['plan', 'show-plan', 'start', 'status', 'report', 'pause', 'resume', 'halt', 'discard', 'flight-step']);
const BIN = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

function emitAuto(value, {
  operation, classification = 'read', state = null, card, json, changed = false,
  filesChanged = false, publicationCreated = false
}) {
  const result = commandResult({
    operation: { id: operation, classification },
    subject: state?.story?.workId ? { kind: 'story', id: state.story.workId } : null,
    outcome: succeeded(
      ['auto.plan', 'auto.show-plan'].includes(operation)
        ? 'auto.plan-ready'
        : operation === 'auto.report' ? 'auto.report-ready' : 'auto.flight-reported',
      state ? { flightId: state.flightId, status: state.status } : { planId: value.planId ?? value.plan?.planId }
    ),
    effects: changed ? effects({ stateChanged: true, filesChanged, publicationCreated }) : noEffects(),
    restState: 'informational',
    data: { card, value }
  });
  emitCommandResult(result, { json });
  return value;
}

function planCard(plan) {
  const lines = [
    `Auto Plan ${plan.planId}`,
    `Plan hash: ${plan.planSha256}`,
    '', `Requirement: ${plan.requirement.text}`,
    `Workspace: ${plan.bindings.repository}`,
    `Capability: ${plan.capability?.id ?? 'repository-only'}`,
    `Work: ${plan.story.workId} · ${plan.story.workType} · branch ${plan.story.branch}`,
    `Complete Story rail: ${plan.story.phaseRail.join(' → ')}`,
    `Authorized flight window: ${plan.execution.until.source}`,
    `Repositories: ${plan.repositories.map((repository) => (
      `${repository.id} · ${repository.remote} (${repository.remoteUrl ?? 'configured remote'}) · ${repository.baseBranch}@${repository.baseCommit}`
    )).join('; ')}`,
    `Scope: predicted · ${plan.proposal.predictedPaths.length} path(s) · protected intersection ${plan.scope.protectedPaths.length ? plan.scope.protectedPaths.join(', ') : 'none'}`,
    `Host: ${plan.executionHost.id} · task ${plan.executionHost.modelTask} · model assurance ${plan.executionHost.modelAssurance}`,
    `Host boundary: writable ${plan.executionHost.writableRoots.join(', ')} · tools ${plan.executionHost.availableTools.join(', ')} · network ${plan.executionHost.containment.networkPolicy} · cancellation ${plan.executionHost.cancellation ? 'yes' : 'no'}`,
    `Accounting: tokens ${plan.accounting.tokens} · cost ${plan.accounting.cost}`,
    `Pace: ${plan.execution.pace.source}`,
    `Ceilings: ${Object.entries(plan.execution.ceilings).map(([key, value]) => (
      key === 'tokenBudget' ? `tokens ${value.maximum} (${value.assurance})` : `${key} ${value}`
    )).join(' · ')}`,
    `Human stops: ${plan.humanBoundaries.stopPoints.length ? plan.humanBoundaries.stopPoints.map((stop) => (
      `${stop.phase}:${stop.kind} [${stop.authorities.join(', ')}]${stop.minimum ? ` minimum ${stop.minimum}` : ''}`
    )).join('; ') : 'none in pinned rail'}`,
    `Eligibility: ${plan.execution.eligibility}`,
    `Startable: ${plan.safety.startable ? 'yes' : 'no'}`,
    `Expires: ${plan.expiresAt}`
  ];
  if (plan.proposal.assumptions.length) lines.push(`Assumptions: ${plan.proposal.assumptions.join('; ')}`);
  if (plan.proposal.unresolvedDecisions.length) lines.push(`Unresolved decisions: ${plan.proposal.unresolvedDecisions.join('; ')}`);
  if (plan.proposal.predictedPaths.length) lines.push(`Predicted paths: ${plan.proposal.predictedPaths.join(', ')}`);
  if (plan.safety.reasons.length) lines.push(`Cannot start because: ${plan.safety.reasons.join('; ')}`);
  lines.push('', 'No Story or branch has been created.', '', `To start exactly this Plan:`, `singularity-flow auto start ${plan.planId} --confirm ${plan.planSha256}`);
  return lines.join('\n');
}

function statusCard(state) {
  return [
    `Auto flight ${state.flightId} · ${state.status}`,
    `Story: ${state.story.workId} · phase ${state.story.phase ?? 'unknown'}`,
    `Plan: ${state.planId}`,
    `Checkpoint: ${state.checkpointSha256}`,
    `Stopped because: ${state.stopReason}`,
    `Next: ${state.nextAction}`
  ].join('\n');
}

function required(positionals, index, label) {
  const value = String(positionals[index] ?? '').trim();
  if (!value) throw new SingularityFlowError(`Auto ${positionals[1] ?? 'command'} requires ${label}.`, { code: 'AUTO_ARGUMENT_REQUIRED' });
  return value;
}

function executeInRegisteredChild(root, state) {
  const result = runProcess(process.execPath, [
    BIN, 'auto', 'flight-step', state.flightId, '--confirm', state.checkpointSha256, '--json'
  ], { cwd: root, allowFailure: true, timeoutMs: 45 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new SingularityFlowError((result.stderr || result.stdout).trim() || 'Auto step process failed.', {
    code: 'AUTO_EXECUTION_HOST_UNAVAILABLE', details: { flightId: state.flightId, status: result.status }
  });
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new SingularityFlowError(`Auto step returned invalid JSON: ${error.message}`, { code: 'AUTO_EXECUTION_HOST_UNAVAILABLE' }); }
}

export async function run(_argv, { positionals, options }) {
  const root = repoRoot();
  const json = optionBoolean(options, 'json');
  const token = positionals[1] ?? 'status';
  const subcommand = SUBCOMMANDS.has(token) ? token : 'plan';

  if (!SUBCOMMANDS.has(token)) {
    throw new SingularityFlowError(
      'The interactive Auto shorthand is intentionally gated in the thin pilot. Use `singularity-flow auto plan "<requirement>"`, review the complete card, then run the exact `auto start --confirm` command it prints.',
      { code: 'AUTO_PILOT_SCOPE' }
    );
  }

  if (subcommand === 'plan') {
    if (options.goal != null) throw new SingularityFlowError('Goal-linked and multi-repository Auto execution is not enabled in the thin pilot.', {
      code: 'AUTO_PILOT_SCOPE', details: { supported: 'single-repository Story rail' }
    });
    const requirement = required(positionals, 2, 'a quoted requirement');
    const definition = await loadDefinition(root);
    const synthesized = await synthesizeAutoPlanProposal(root, requirement, { definition });
    const plan = await createAutoPlan(root, requirement, synthesized.proposal, {
      definition,
      workType: optionString(options, 'work-type'), capabilityId: optionString(options, 'capability'),
      workId: optionString(options, 'work-id'), fromBranch: optionString(options, 'from-branch'),
      pace: optionString(options, 'pace'), until: optionString(options, 'until'),
      synthesis: {
        invocationId: synthesized.invocation?.id ?? null,
        provider: synthesized.invocation?.provider ?? null,
        model: synthesized.invocation?.model ?? null,
        usage: synthesized.usage ?? { status: 'unavailable' }
      }
    });
    return emitAuto(plan, { operation: 'auto.plan', card: planCard(plan), json });
  }

  if (subcommand === 'show-plan') {
    const plan = await readAutoPlan(root, required(positionals, 2, 'a Plan ID'));
    return emitAuto(plan, { operation: 'auto.show-plan', card: planCard(plan), json });
  }

  if (subcommand === 'start') {
    const result = await startAutoFlight(
      root, required(positionals, 2, 'a Plan ID'), optionString(options, 'confirm')
    );
    if (result.flight.status === 'running') {
      const child = executeInRegisteredChild(root, result.flight);
      result.flight = child.data?.value ?? child;
    }
    return emitAuto(result, {
      operation: 'auto.start', classification: 'mutation', state: result.flight,
      card: statusCard(result.flight), json, changed: true, filesChanged: true,
      publicationCreated: Boolean(result.story.publication)
    });
  }

  const id = required(positionals, 2, 'a flight ID');
  if (subcommand === 'flight-step') {
    const state = await executeAutoFlightStep(root, id, optionString(options, 'confirm'));
    return emitAuto(state, {
      operation: 'auto.flight-step', classification: 'mutation', state,
      card: statusCard(state), json, changed: true, filesChanged: true,
      publicationCreated: ['published', 'submitted'].includes(state.position)
    });
  }
  if (subcommand === 'status') {
    const state = await readAutoFlightState(root, id);
    return emitAuto(state, { operation: 'auto.status', state, card: statusCard(state), json });
  }
  if (subcommand === 'report') {
    const state = await readAutoFlightState(root, id);
    const record = state.finalReportSha256
      ? await readAutoFlightReport(root, id)
      : buildAutoFlightReport(state);
    const report = renderAutoFlightReport(state, record);
    return emitAuto({ flight: state, report: record }, {
      operation: 'auto.report', state, card: report, json
    });
  }
  let state;
  if (subcommand === 'pause') state = await pauseAutoFlight(root, id);
  else if (subcommand === 'resume') {
    state = await resumeAutoFlight(root, id, optionString(options, 'confirm'));
    const child = executeInRegisteredChild(root, state);
    state = child.data?.value ?? child;
  }
  else if (subcommand === 'halt') state = await haltAutoFlight(root, id);
  else if (subcommand === 'discard') state = await discardAutoFlight(root, id, optionString(options, 'confirm'));
  return emitAuto(state, {
    operation: `auto.${subcommand}`, classification: 'mutation', state,
    card: statusCard(state), json, changed: true
  });
}
