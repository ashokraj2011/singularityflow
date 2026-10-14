import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { contextXray } from '../context-xray.mjs';
import { repoRoot } from '../git.mjs';
import { commandResult, effects, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { SingularityFlowError, optionBoolean, optionNumber, optionString, optionStrings, requirePositional } from '../util.mjs';

function impactFilters(values) {
  const result = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator < 1 || separator === item.length - 1) throw new SingularityFlowError(`Impact filters must use DIMENSION=VALUE; got '${item}'.`);
    result[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return result;
}

async function xrayProjection(positionals, options, { defaultToCurrentPhase = true } = {}) {
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const root = repoRoot();
  const workId = optionString(options, 'work-id', positionals[2] ?? null);
  let workflow;
  try { workflow = (await loadAcceptedStoryExecution(root, workId)).workflow; }
  catch (error) {
    if (error?.code !== 'STORY_NOT_FOUND') throw error;
    throw new SingularityFlowError(
      workId
        ? `Context X-Ray could not resolve governed work '${workId}'.`
        : 'Context X-Ray requires active governed Story work or --work-id.',
      { code: 'CXR_NO_ACTIVE_WORK', cause: error }
    );
  }
  return contextXray(root, workflow, {
    phase: optionString(options, 'phase'),
    packetId: optionString(options, 'packet'),
    defaultToCurrentPhase
  });
}

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () =>
      positionals[0] === 'tokens'
        ? tokensCommand(positionals, options)
        : contextCommand(positionals, options)));
}

export async function contextCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'xray';
  if (subcommand === 'compile') {
    const { compileEvidencePacket } = await import('../evidence-packet.mjs');
    const root = repoRoot();
    const packet = await compileEvidencePacket(root, {
      workId: optionString(options, 'work-id', positionals[2] ?? null),
      flightPlanId: optionString(options, 'flight-plan'),
      phase: optionString(options, 'phase'),
      requestedSlices: optionStrings(options, 'slice'),
      maxOutputBytes: optionNumber(options, 'max-output-bytes')
    });
    return emitCommandResult(commandResult({
      operation: { id: 'context.compile', classification: 'mutation' },
      subject: packet.binding.workId ? { kind: 'story', id: packet.binding.workId } : null,
      outcome: succeeded('context.compiled', {
        packetId: packet.packetId, status: packet.status, items: packet.items.length
      }),
      effects: effects({ stateChanged: true }),
      restState: 'informational',
      data: { packet }
    }), { json: optionBoolean(options, 'json') });
  }
  if (subcommand === 'expand') {
    const { expandEvidencePacketHandle } = await import('../evidence-packet.mjs');
    const expansion = await expandEvidencePacketHandle(
      repoRoot(), requirePositional(positionals, 2, 'sealed expansion handle')
    );
    return emitCommandResult(commandResult({
      operation: { id: 'context.expand', classification: 'mutation' },
      subject: { kind: 'context-packet', id: expansion.packetId },
      outcome: succeeded('context.expanded', {
        packetId: expansion.packetId, representation: expansion.representation,
        bytes: expansion.accounting.includedContentBytes
      }),
      effects: effects({ stateChanged: true }),
      restState: 'informational',
      data: { expansion }
    }), { json: optionBoolean(options, 'json') });
  }
  if (subcommand === 'doctor') {
    const [
      { loadConfig },
      { normalizeTokenEconomy, selectedTokenEconomyProfile, tokenEconomyDigest }
    ] = await Promise.all([
      import('../state-stores.mjs'),
      import('../token-economy.mjs')
    ]);
    const config = await loadConfig(repoRoot());
    const policy = normalizeTokenEconomy(config.tokenEconomy ?? {});
    const profile = selectedTokenEconomyProfile(policy);
    const result = {
      schemaVersion: 1, // schema-transient: read-only diagnostic
      status: policy.enabled ? 'ready' : 'disabled', policy, profile,
      configurationDigest: tokenEconomyDigest(policy),
      modelInvoked: false
    };
    return emitCommandResult(commandResult({
      operation: { id: 'context.doctor', classification: 'read' },
      subject: null,
      outcome: succeeded('context.diagnosed', {
        status: result.status, mode: policy.mode, profile: profile.id
      }),
      effects: noEffects(), restState: 'informational', data: { diagnostic: result }
    }), { json: optionBoolean(options, 'json') });
  }
  if (subcommand !== 'xray') {
    throw new SingularityFlowError(`Unknown context command '${subcommand}'. Available: xray, compile, expand, doctor.`);
  }
  const projection = await xrayProjection(positionals, options);
  return emitCommandResult(commandResult({
    operation: { id: 'context', classification: 'read' },
    subject: { kind: 'story', id: projection.work.id },
    outcome: succeeded('context.reported', {
      workId: projection.work.id, phase: projection.work.phase ?? 'all phases'
    }),
    effects: noEffects(),
    restState: 'informational',
    data: { xray: projection }
  }), { json: optionBoolean(options, 'json') });
}

export async function tokensCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  if (!['status', 'report', 'compare'].includes(subcommand)) {
    throw new SingularityFlowError(
      `Unknown tokens command '${subcommand}'. Available: status, report, compare.`
    );
  }
  if (subcommand === 'compare') {
    const root = repoRoot();
    const studyId = optionString(options, 'study', positionals[2] ?? null);
    if (!studyId) throw new SingularityFlowError('tokens compare requires --study STUDY-ID.');
    const [
      { loadImpactDefinition },
      { compareImpactReceipts, listImpactReceipts },
      { loadConfig },
      { classifyTokenOptimization }
    ] = await Promise.all([
      import('../impact-config.mjs'),
      import('../impact.mjs'),
      import('../state-stores.mjs'),
      import('../token-economy.mjs')
    ]);
    const impact = await loadImpactDefinition(root, { required: true });
    const study = impact.studies.find((item) => item.id === studyId);
    if (!study) throw new SingularityFlowError(`Unknown impact study '${studyId}'.`);
    const comparison = compareImpactReceipts(
      await listImpactReceipts(root, await loadConfig(root), { studyId }), study,
      { filters: impactFilters(optionStrings(options, 'filter')) }
    );
    const classification = classifyTokenOptimization(comparison);
    const result = { schemaVersion: 1, studyId, classification, comparison };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Token optimization: ${classification.state}`);
    console.log(classification.reason);
    console.log(`Release claim: ${classification.releaseClaimAllowed ? 'allowed' : 'blocked'}`);
    return;
  }
  if (optionBoolean(options, 'today')) {
    const incompatible = [
      optionString(options, 'work-id'), optionString(options, 'phase'), optionString(options, 'packet'),
      positionals[2]
    ].filter((value) => value != null && String(value).trim());
    if (incompatible.length) {
      throw new SingularityFlowError(
        '--today is a repository-wide content-free aggregate and cannot be combined with a Story, phase, or packet selector.',
        { code: 'CXR_ARGUMENT_CONFLICT' }
      );
    }
    const [
      { contextPacketTelemetryRecords },
      { listModelInvocationAudits },
      { dailyTokenLedgerPeriod, dailyTokenLedgerProjection }
    ] = await Promise.all([
      import('../context-packet-telemetry.mjs'),
      import('../model-runner.mjs'),
      import('../token-ledger.mjs')
    ]);
    const root = repoRoot();
    const period = dailyTokenLedgerPeriod();
    const [models, packets] = await Promise.all([
      listModelInvocationAudits(root),
      contextPacketTelemetryRecords(root)
    ]);
    const ledger = dailyTokenLedgerProjection(models, packets, { period });
    return emitCommandResult(commandResult({
      operation: { id: 'tokens', classification: 'read' },
      subject: null,
      outcome: succeeded('tokens.daily-reported', {
        date: ledger.period.date,
        modelInvocations: ledger.activity.modelInvocations,
        contextPackets: ledger.activity.contextPackets
      }),
      effects: noEffects(),
      restState: 'informational',
      data: { ledger }
    }), { json: optionBoolean(options, 'json') });
  }
  const projection = await xrayProjection(positionals, options, { defaultToCurrentPhase: false });
  return emitCommandResult(commandResult({
    operation: { id: 'tokens', classification: 'read' },
    subject: { kind: 'story', id: projection.work.id },
    outcome: succeeded('tokens.reported', {
      workId: projection.work.id, phase: projection.ledger.phase ?? 'all phases'
    }),
    effects: noEffects(),
    restState: 'informational',
    data: { ledger: projection.ledger }
  }), { json: optionBoolean(options, 'json') });
}
