/** `singularity-flow auto` — bounded, exact-hash-ratified Story automation. */
import { repoRoot } from '../git.mjs';
import { fileURLToPath } from 'node:url';
import { loadDefinition } from '../config.mjs';
import {
  createAutoPlan, readAutoPlan, synthesizeAutoPlanProposal
} from '../auto/auto-plan.mjs';
import { buildAutoPlanPacket, buildAutoPlanValidation } from '../auto/auto-plan-packet.mjs';
import { startAutoFlight } from '../auto/auto-flight.mjs';
import { executeAutoFlightStep } from '../auto/auto-executor.mjs';
import { rebuildAutoFlightState } from '../auto/auto-checkpoint.mjs';
import {
  authorizeAutoRepair, autoFlightProductProjection, confirmAutoExecutionUnitSwitch,
  planAutoExecutionUnitSwitch, planAutoRepair,
  respondAutoHumanRequest
} from '../auto/auto-p1-control.mjs';
import {
  discardAutoFlight, haltAutoFlight, pauseAutoFlight, readAutoFlightState,
  listAutoFlights, projectAutoFlightReport, readAutoFlightReport, renderAutoFlightReport,
  resumeAutoFlight, takeoverAutoFlight
} from '../auto/auto-flight-store.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  didYouMean, nearestNames, optionBoolean, optionString,
  run as runProcess, SingularityFlowError
} from '../util.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import {
  buildAdhocAutoHandoff, buildAutoContinuationProposal, resolveAutoGoalSeed
} from '../auto/auto-entry-modes.mjs';

const SUBCOMMANDS = new Set([
  'plan', 'show-plan', 'start', 'list', 'status', 'report',
  'pause', 'resume', 'stop', 'halt', 'takeover', 'discard', 'flight-step',
  'continue', 'adopt', 'recover', 'repair', 'needs-you', 'respond', 'switch-unit'
]);
const BIN = fileURLToPath(new URL('../../bin/singularity-flow.mjs', import.meta.url));

function emitAuto(value, {
  operation, classification = 'read', state = null, card, json, changed = false,
  filesChanged = false, publicationCreated = false
}) {
  const result = commandResult({
    operation: { id: operation, classification },
    subject: state?.story?.workId ? { kind: 'story', id: state.story.workId } : null,
    outcome: succeeded(
      ['auto.plan', 'auto.plan.story', 'auto.show-plan'].includes(operation)
        ? 'auto.plan-ready'
        : operation === 'auto.list' ? 'auto.flight-list-ready'
        : operation === 'auto.report' ? 'auto.report-ready' : 'auto.flight-reported',
      operation === 'auto.continue'
        ? { proposalSha256: value.proposal?.proposalSha256, flightId: state?.flightId ?? null }
        : operation === 'auto.adopt'
          ? { proposalSha256: value.handoff?.proposalSha256 }
          : state
            ? { flightId: state.flightId, status: state.status }
            : operation === 'auto.list'
          ? { count: String(value.flights?.length ?? 0) }
              : { planId: value.planId ?? value.plan?.planId }
    ),
    effects: changed ? effects({ stateChanged: true, filesChanged, publicationCreated }) : noEffects(),
    restState: 'informational',
    data: { card, value }
  });
  emitCommandResult(result, { json });
  return value;
}

function planCard(plan) {
  const packet = buildAutoPlanPacket(plan);
  const lines = [
    `Auto Plan ${plan.planId}`,
    `Plan hash: ${plan.planSha256}`,
    `Ratification packet: ${packet.packetSha256}`,
    '', `Requirement: ${plan.requirement.text}`,
    ...(plan.requirement.source?.kind === 'goal'
      ? [`Goal source: ${plan.requirement.source.goalId} · ${plan.requirement.source.authority} · ${plan.requirement.source.goalSha256}`]
      : []),
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
    `Profile: ${plan.execution.profile?.resolved ?? 'story'}${plan.execution.profile?.requested === 'auto-select' ? ' (auto-selected)' : ''}`,
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
  lines.push('', 'No Story or branch has been created.', '', `To start exactly this Plan:`, `singularity-flow auto start --plan ${plan.planId} --confirm ${packet.packetSha256}`);
  return lines.join('\n');
}

function planPresentation(plan) {
  const validation = buildAutoPlanValidation(plan);
  return { ...plan, validation, ratificationPacket: buildAutoPlanPacket(plan, validation) };
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

function productCard(projection) {
  const { flight, current } = projection;
  const lines = [statusCard(flight)];
  if (current.phaseRun) lines.push('', `Phase run: ${current.phaseRun.phaseRunId} · ${current.phaseRun.status}`);
  if (current.attempt) lines.push(`Attempt: ${current.attempt.attemptId} · ${current.attempt.attemptKind} · ${current.attempt.status}`);
  if (current.refusal) lines.push(
    '', `Refusal: ${current.refusal.refusalId} · ${current.refusal.gate}/${current.refusal.code}`,
    `Repair: ${current.refusal.repair.eligibility}`
  );
  if (current.humanRequest) lines.push(
    '', `Needs you: ${current.humanRequest.requestType} · ${current.humanRequest.title}`,
    `Request: ${current.humanRequest.requestId}`
  );
  return lines.join('\n');
}

function continuationCard(value) {
  const proposal = value.proposal;
  return [
    `Auto continuation proposal ${proposal.proposalSha256}`,
    `Story: ${proposal.story.workId} · ${proposal.story.status} · phase ${proposal.story.currentPhase ?? 'complete'}`,
    `Workflow: ${proposal.story.workflowSha256}`,
    `Flight: ${proposal.flight?.flightId ?? 'none'}${proposal.flight ? ` · checkpoint ${proposal.flight.checkpointSha256}` : ''}`,
    `Status: ${proposal.proposal.status}`,
    `Reason: ${proposal.proposal.reason}`,
    proposal.proposal.command ? `Review next action: ${proposal.proposal.command}` : 'No executable continuation is authorized.',
    '', 'This command did not resume, approve, publish, or mutate the Story.'
  ].join('\n');
}

function adoptionCard(value) {
  const handoff = value.handoff;
  return [
    `Auto Ad Hoc handoff ${handoff.proposalSha256}`,
    `Session: ${handoff.source.sessionId}`,
    `Origin: ${handoff.source.origin} · intent ${handoff.source.intentProvenance}`,
    `Effect set: ${handoff.source.changeSetSha256}`,
    `Resources: ${handoff.preserved.resources.length}`,
    `Startable: ${handoff.safety.startable ? 'yes' : 'no'}`,
    ...handoff.safety.reasons.map((reason) => `- ${reason}`),
    '', `Reviewed handoff action: ${handoff.nextAction}`,
    'No effects were relabelled, copied, committed, or started.'
  ].join('\n');
}

function repairCard(value) {
  const { repairPlan } = value;
  return [
    `Auto Repair Plan ${repairPlan.repairPlanId}`,
    `Flight: ${repairPlan.flightId}`,
    `Refusal: ${repairPlan.refusalSha256}`,
    `Objective: ${repairPlan.objective}`,
    `Write scope: ${repairPlan.writeScope.join(', ') || 'none'}`,
    `Required evidence: ${repairPlan.requiredEvidence.join('; ') || 'none'}`,
    `Budget: exactly ${repairPlan.attemptNumber} repair attempt`,
    `Plan hash: ${repairPlan.repairPlanSha256}`,
    '', 'No repair has run.', '',
    `To run exactly this repair: singularity-flow auto repair ${repairPlan.flightId} --refusal ${value.refusal?.refusalId ?? '<REFUSAL-ID>'} --confirm ${repairPlan.repairPlanSha256}`
  ].join('\n');
}

function switchCard(value) {
  const plan = value.switchPlan;
  return [
    `Auto Execution Unit Switch ${plan.switchPlanId}`,
    `Flight: ${plan.flightId}`,
    `Route: ${plan.fromExecutionUnit} → ${plan.toExecutionUnit}`,
    `Parent attempt: ${plan.parentAttemptId}`,
    `Task Contract: ${plan.taskContractSha256}`,
    `Reason: ${plan.reason}`,
    `Plan hash: ${plan.switchPlanSha256}`,
    '', 'The current Execution Unit has not changed.', '',
    `To apply exactly this switch: singularity-flow auto switch-unit ${plan.flightId} --execution-unit ${plan.toExecutionUnit} --confirm ${plan.switchPlanSha256}`
  ].join('\n');
}

function listCard(states) {
  if (!states.length) return 'Auto flights\n\nNo Auto flights are recorded in this repository.';
  return [
    `Auto flights · ${states.length}`,
    '',
    ...states.map((state) => [
      `${state.flightId} · ${state.status}`,
      `  Story ${state.story?.workId ?? 'unavailable'} · phase ${state.story?.phase ?? 'unknown'} · checkpoint ${state.checkpointSha256}`,
      `  Next: ${state.nextAction}`
    ].join('\n'))
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
  const goalId = optionString(options, 'goal');
  const storyId = optionString(options, 'story');
  const token = positionals[1] ?? (goalId || storyId ? 'plan' : 'status');
  const shorthand = !SUBCOMMANDS.has(token);
  const nearest = nearestNames(token, [...SUBCOMMANDS], { limit: 1 })[0] ?? null;
  if (shorthand && nearest && Math.abs(String(token).length - nearest.length) <= 2) {
    throw new SingularityFlowError(
      `'auto' has no subcommand '${token}'.${didYouMean(token, [...SUBCOMMANDS])} `
      + 'For an intentional requirement, use `singularity-flow auto plan "<requirement>"`.',
      { code: 'UNKNOWN_SUBCOMMAND' }
    );
  }
  const subcommand = shorthand ? 'plan' : token;
  if (goalId && subcommand !== 'plan') throw new SingularityFlowError(
    '--goal is valid only for Auto Plan creation.', { code: 'AUTO_ARGUMENT_CONFLICT' }
  );
  if (storyId && subcommand !== 'plan') throw new SingularityFlowError(
    '--story is valid only with auto plan.', { code: 'AUTO_ARGUMENT_CONFLICT' }
  );
  if (goalId && storyId) throw new SingularityFlowError(
    'Choose either --goal <GOAL-ID> or --story <STORY-ID>; they are different intake authorities.',
    { code: 'AUTO_ARGUMENT_CONFLICT' }
  );
  if (options['from-adhoc'] != null && subcommand !== 'adopt') throw new SingularityFlowError(
    '--from-adhoc is valid only with auto adopt.', { code: 'AUTO_ARGUMENT_CONFLICT' }
  );

  if (subcommand === 'plan') {
    // The shorthand is planning only. It deliberately reaches the same exact Plan path and never
    // treats invoking `auto` as confirmation to create a Story or start a flight.
    return withApprovedConfigurationRead(root, async (authority) => {
      if (!authority) throw new SingularityFlowError('Auto Plan requires approved Singularity Flow configuration.', {
        code: 'APPROVED_CONFIGURATION_UNAVAILABLE'
      });
      const definition = await loadDefinition(root);
      if (storyId) {
        const suppliedRequirement = String(positionals[shorthand ? 1 : 2] ?? '').trim();
        const conflictingOptions = [
          'capability', 'work-type', 'work-id', 'from-branch', 'profile', 'pace', 'until'
        ].filter((name) => optionString(options, name) != null);
        if (suppliedRequirement || conflictingOptions.length) {
          throw new SingularityFlowError(
            '--story reads the exact next segment of an existing Story and cannot be combined with a new requirement or new-Story options.',
            {
              code: 'AUTO_ARGUMENT_CONFLICT',
              details: { storyId, conflictingOptions }
            }
          );
        }
        const result = await buildAutoContinuationProposal(root, definition, storyId);
        return emitAuto(result, {
          operation: 'auto.plan.story', state: result.flight,
          card: continuationCard(result), json
        });
      }
      const goalSeed = goalId ? await resolveAutoGoalSeed(root, goalId, { definition }) : null;
      const suppliedRequirement = String(positionals[shorthand ? 1 : 2] ?? '').trim();
      if (goalSeed && suppliedRequirement) throw new SingularityFlowError(
        'Choose either a quoted requirement or --goal <GOAL-ID>; combining them would create ambiguous intake authority.',
        { code: 'AUTO_ARGUMENT_CONFLICT' }
      );
      const requirement = goalSeed?.requirement
        ?? required(positionals, shorthand ? 1 : 2, 'a quoted requirement');
      const synthesized = await synthesizeAutoPlanProposal(root, requirement, { definition });
      const proposal = goalSeed ? {
        ...synthesized.proposal,
        acceptanceCriteria: [...goalSeed.acceptanceCriteria],
        assumptions: [...new Set([
          ...synthesized.proposal.assumptions,
          `Goal ${goalSeed.goalId} seeds outcome direction only; this Auto Plan remains separately ratified.`
        ])]
      } : synthesized.proposal;
      const plan = await createAutoPlan(root, requirement, proposal, {
        definition,
        workType: optionString(options, 'work-type'), capabilityId: optionString(options, 'capability'),
        workId: optionString(options, 'work-id'), fromBranch: optionString(options, 'from-branch'),
        profile: optionString(options, 'profile'), pace: optionString(options, 'pace'),
        until: optionString(options, 'until'),
        requirementSource: goalSeed?.source ?? null,
        synthesis: {
          invocationId: synthesized.invocation?.id ?? null,
          provider: synthesized.invocation?.provider ?? null,
          model: synthesized.invocation?.model ?? null,
          usage: synthesized.usage ?? { status: 'unavailable' }
        }
      });
      return emitAuto(planPresentation(plan), { operation: 'auto.plan', card: planCard(plan), json });
    }, { preferAuthority: true });
  }

  if (subcommand === 'show-plan') {
    const plan = await readAutoPlan(root, required(positionals, 2, 'a Plan ID'));
    return emitAuto(planPresentation(plan), { operation: 'auto.show-plan', card: planCard(plan), json });
  }

  if (subcommand === 'start') {
    const positionalPlanId = String(positionals[2] ?? '').trim() || null;
    const optionPlanId = optionString(options, 'plan')?.trim() || null;
    if (positionalPlanId && optionPlanId && positionalPlanId !== optionPlanId) {
      throw new SingularityFlowError(
        `Auto start received different Plan IDs positionally and through --plan.`,
        { code: 'AUTO_ARGUMENT_CONFLICT', details: { positionalPlanId, optionPlanId } }
      );
    }
    const planId = optionPlanId ?? positionalPlanId;
    if (!planId) throw new SingularityFlowError('Auto start requires a Plan ID or --plan <PLAN-ID>.', {
      code: 'AUTO_ARGUMENT_REQUIRED'
    });
    const result = await startAutoFlight(
      root, planId, optionString(options, 'confirm')
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

  if (subcommand === 'list') {
    const flights = await listAutoFlights(root);
    return emitAuto({ flights }, {
      operation: 'auto.list', card: listCard(flights), json
    });
  }

  if (subcommand === 'continue') {
    const definition = await loadDefinition(root);
    const result = await buildAutoContinuationProposal(
      root, definition, required(positionals, 2, 'a Story ID')
    );
    return emitAuto(result, {
      operation: 'auto.continue', state: result.flight,
      card: continuationCard(result), json
    });
  }

  if (subcommand === 'adopt') {
    const sessionId = optionString(options, 'from-adhoc');
    if (!sessionId) throw new SingularityFlowError(
      'Auto adopt requires --from-adhoc <AHS-ID>.', { code: 'AUTO_ARGUMENT_REQUIRED' }
    );
    const result = await buildAdhocAutoHandoff(root, sessionId);
    return emitAuto(result, {
      operation: 'auto.adopt', card: adoptionCard(result), json
    });
  }

  if (subcommand === 'recover') {
    const workId = required(positionals, 2, 'a Story ID');
    const definition = await loadDefinition(root);
    const { loadStoryAggregate } = await import('../state-stores.mjs');
    let workflow = null;
    try { workflow = await loadStoryAggregate(root, definition, workId); }
    catch (localError) {
      // A recovery command is specifically required to work after clone/crash, where main need
      // not contain the Story. Read only the named remote Story workflow to discover its committed
      // execution origin; rebuildAutoFlightState then clones and verifies the complete authority.
      const checked = runProcess('git', ['check-ref-format', '--branch', workId], {
        cwd: root, allowFailure: true
      });
      if (checked.status !== 0) throw localError;
      const fetched = runProcess('git', [
        'fetch', '--no-tags', 'origin',
        `refs/heads/${workId}:refs/remotes/origin/${workId}`
      ], { cwd: root, allowFailure: true, timeoutMs: 120_000 });
      const relative = `${definition.workItemRoot ?? 'singularity/work-items'}/${workId}/workflow.json`;
      const shown = fetched.status === 0 ? runProcess('git', [
        'show', `refs/remotes/origin/${workId}:${relative}`
      ], { cwd: root, allowFailure: true }) : fetched;
      if (shown.status !== 0) throw new SingularityFlowError(
        `Story '${workId}' is not available locally or on origin for Auto recovery.`, {
          code: 'AUTO_CHECKPOINT_NOT_FOUND', cause: localError,
          details: { diagnostic: (shown.stderr || shown.stdout).trim() }
        }
      );
      try { workflow = JSON.parse(shown.stdout); }
      catch (error) { throw new SingularityFlowError(
        `Story '${workId}' has an invalid remote workflow record.`, {
          code: 'AUTO_CHECKPOINT_INVALID', cause: error
        }
      ); }
      if (workflow.workItem?.id !== workId) throw new SingularityFlowError(
        `Remote Story workflow identity does not match '${workId}'.`, {
          code: 'AUTO_CHECKPOINT_INVALID'
        }
      );
    }
    const requestedFlight = optionString(options, 'flight');
    const flightId = requestedFlight ?? workflow.executionOrigin?.flightId;
    if (!flightId) throw new SingularityFlowError(
      `Story '${workId}' does not declare an Auto execution origin.`, {
        code: 'AUTO_CHECKPOINT_NOT_FOUND'
      }
    );
    if (requestedFlight && requestedFlight !== workflow.executionOrigin?.flightId) {
      throw new SingularityFlowError(
        `Flight '${requestedFlight}' does not match Story '${workId}'.`, {
          code: 'AUTO_FLIGHT_BINDING_MISMATCH'
        }
      );
    }
    const state = await rebuildAutoFlightState(root, {
      storyRoot: root, workId, flightId
    });
    return emitAuto(state, {
      operation: 'auto.recover', classification: 'mutation', state,
      card: statusCard(state), json, changed: true
    });
  }

  if (subcommand === 'repair') {
    const flightId = required(positionals, 2, 'a flight ID');
    const refusalId = optionString(options, 'refusal');
    if (!refusalId) throw new SingularityFlowError('Auto repair requires --refusal <REFUSAL-ID>.', {
      code: 'AUTO_ARGUMENT_REQUIRED'
    });
    const confirmation = optionString(options, 'confirm');
    if (!confirmation) {
      const planned = await planAutoRepair(root, flightId, refusalId);
      return emitAuto(planned, {
        operation: 'auto.repair.plan', state: planned.flight, card: repairCard(planned), json
      });
    }
    const preview = await planAutoRepair(root, flightId, refusalId);
    const authorized = await authorizeAutoRepair(
      root, flightId, preview.repairPlan.repairPlanId, confirmation
    );
    let state = authorized.flight;
    if (state.status === 'running') {
      const child = executeInRegisteredChild(root, state);
      state = child.data?.value ?? child;
    }
    return emitAuto({ ...authorized, flight: state }, {
      operation: 'auto.repair', classification: 'mutation', state,
      card: statusCard(state), json, changed: true, filesChanged: true
    });
  }

  if (subcommand === 'needs-you') {
    const flightId = required(positionals, 2, 'a flight ID');
    const projection = await autoFlightProductProjection(root, flightId);
    return emitAuto({ flight: projection.flight, requests: projection.humanRequests }, {
      operation: 'auto.needs-you', state: projection.flight,
      card: productCard(projection), json
    });
  }

  if (subcommand === 'respond') {
    const flightId = required(positionals, 2, 'a flight ID');
    const requestId = optionString(options, 'request');
    if (!requestId) throw new SingularityFlowError('Auto respond requires --request <REQUEST-ID>.', {
      code: 'AUTO_ARGUMENT_REQUIRED'
    });
    const brokerReference = optionString(options, 'broker-reference');
    const answer = optionString(options, 'answer');
    const choice = optionString(options, 'choice');
    const supplied = [brokerReference, answer, choice].filter((value) => value != null);
    if (supplied.length !== 1) throw new SingularityFlowError(
      'Auto respond requires exactly one of --choice, --answer, or --broker-reference.',
      { code: 'AUTO_ARGUMENT_CONFLICT' }
    );
    const response = brokerReference != null
      ? { brokerReference, status: 'available' }
      : choice != null ? { choice } : { answer };
    const responded = await respondAutoHumanRequest(
      root, flightId, requestId, response, optionString(options, 'confirm')
    );
    return emitAuto(responded, {
      operation: 'auto.respond', classification: 'mutation', state: responded.flight,
      card: statusCard(responded.flight), json, changed: true
    });
  }

  if (subcommand === 'switch-unit') {
    const flightId = required(positionals, 2, 'a flight ID');
    const executionUnit = optionString(options, 'execution-unit');
    if (!executionUnit) throw new SingularityFlowError('Auto switch-unit requires --execution-unit <ID>.', {
      code: 'AUTO_ARGUMENT_REQUIRED'
    });
    const planned = await planAutoExecutionUnitSwitch(
      root, flightId, executionUnit, optionString(options, 'reason')
    );
    const confirmation = optionString(options, 'confirm');
    if (!confirmation) return emitAuto(planned, {
      operation: 'auto.switch-unit.plan', state: planned.flight, card: switchCard(planned), json
    });
    const applied = await confirmAutoExecutionUnitSwitch(
      root, flightId, planned.switchPlan.switchPlanId, confirmation
    );
    return emitAuto(applied, {
      operation: 'auto.switch-unit', classification: 'mutation', state: applied.flight,
      card: statusCard(applied.flight), json, changed: true
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
      : await projectAutoFlightReport(root, state);
    const report = renderAutoFlightReport(state, record);
    return emitAuto({ flight: state, report: record }, {
      operation: 'auto.report', state, card: report, json
    });
  }
  let state;
  const expectedCheckpoint = optionString(options, 'confirm');
  if (subcommand === 'pause') state = await pauseAutoFlight(root, id, { expectedCheckpoint });
  else if (subcommand === 'resume') {
    state = await resumeAutoFlight(root, id, optionString(options, 'confirm'));
    // Resume may itself reconcile an externally approved phase boundary. Phase pacing rests at
    // that boundary, and a terminal transition is already complete; neither authorizes another
    // executor process.
    if (state.status === 'running') {
      const child = executeInRegisteredChild(root, state);
      state = child.data?.value ?? child;
    }
  }
  else if (subcommand === 'stop' || subcommand === 'halt') {
    state = await haltAutoFlight(root, id, 'human-halted', { expectedCheckpoint });
  }
  else if (subcommand === 'takeover') {
    state = await takeoverAutoFlight(root, id, { expectedCheckpoint });
  }
  else if (subcommand === 'discard') state = await discardAutoFlight(root, id, optionString(options, 'confirm'));
  return emitAuto(state, {
    operation: `auto.${subcommand}`, classification: 'mutation', state,
    card: statusCard(state), json, changed: true
  });
}
