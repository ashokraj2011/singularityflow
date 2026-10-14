import { existsSync } from 'node:fs';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { copilotTelemetryStatus } from '../telemetry.mjs';
import {
  explainTelemetryStatus, probeTelemetry, setTelemetryCapture,
  TELEMETRY_DISCLOSURE, TELEMETRY_DISCLOSURE_CONFIRMATION
} from '../telemetry-provision.mjs';
import { SingularityFlowError, optionBoolean, optionString } from '../util.mjs';
import { copilotActivityLine } from './shared/copilot-activity-line.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';

const WORKFLOW_PATH = 'singularity/workflow.yml';

async function confirmExact(prompt, expected) {
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_AGENT_CONFIRM === expected) return true;
    throw new SingularityFlowError(`Confirming '${expected}' requires an interactive terminal; use the command's explicit non-interactive confirmation flag when available.`);
  }
  const io = readline.createInterface({ input, output });
  try { return (await io.question(`${prompt}\nType ${expected} to continue: `)).trim() === expected; }
  finally { io.close(); }
}

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => telemetryCommand(positionals, options)));
}

export async function telemetryCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  let root = null;
  try { root = repoRoot(); } catch { /* Machine-local telemetry controls are intentionally rootless. */ }
  const status = await copilotTelemetryStatus(root);
  if (subcommand === 'status') {
    let workflow = null;
    // Pending phase telemetry enriches repository status, but it is not a prerequisite for the
    // machine-level capture preference. A plain Git directory or a rootless invocation therefore
    // never attempts to parse singularity/workflow.yml. In a governed checkout, keep the strict
    // accepted-closure validation so damaged Story authority is still reported rather than hidden.
    if (root && existsSync(path.join(root, WORKFLOW_PATH))) {
      try {
        const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
        workflow = (await loadAcceptedStoryExecution(root)).workflow;
      } catch (error) {
        if (error?.code !== 'STORY_NOT_FOUND') throw error;
      }
    }
    const pending = workflow
      ? workflow.phaseOrder.flatMap((phaseId) => (workflow.phases[phaseId].telemetry ?? []).filter((item) => item.status === 'pending').map((item) => ({ phase: phaseId, generation: item.generation, path: item.path })))
      : [];
    const launches = await explainTelemetryStatus({
      root,
      story: optionString(options, 'story', workflow?.workItem?.id ?? null)
    });
    const result = {
      schemaVersion: 2,
      capture: launches,
      // Preserve the path-free v1 readiness fields for scripts while the qualified launch
      // partition becomes the authoritative v2 view.
      exists: status.exists,
      ready: status.ready,
      completedChatSpans: status.completedChatSpans,
      legacyExporter: {
        enabled: status.enabled,
        fileConfigured: status.fileConfigured,
        externalEndpoint: status.externalEndpoint,
        explicitlyEnabled: status.explicitlyEnabled,
        exists: status.exists,
        bytes: status.bytes,
        completedChatSpans: status.completedChatSpans,
        ready: status.ready,
        setup: { installed: status.setup.installed, current: status.setup.current },
        warnings: status.warnings
      },
      pending
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Copilot usage — ${launches.status}`);
    console.log(`SFlow-owned launches: ${launches.launches.length} | Captured: ${launches.counts.captured} | Partial: ${launches.counts.partial}`);
    console.log(`Local capture: ${launches.preference.enabled ? 'enabled' : 'disabled'} | Disclosure: ${launches.preference.disclosureAccepted ? 'accepted' : 'required'}`);
    console.log(`Pending generations: ${pending.length ? pending.map((item) => `${item.phase}@${item.generation}`).join(', ') : 'none'}`);
    if (!launches.launches.length && status.ready) console.log(`Legacy repository stream: ${status.completedChatSpans} completed chat span(s).`);
    if (launches.status === 'unavailable') console.log('Usage unavailable for this session. Your work can continue.');
    if (!launches.preference.enabled) {
      printCommandRoutes('singularity-flow telemetry enable', { label: 'Enable future SFlow-owned launches' });
    } else if (!launches.preference.disclosureAccepted) {
      printCommandRoutes('singularity-flow telemetry enable', { label: 'Review and accept the local collection disclosure' });
    }
    return;
  }
  if (subcommand === 'probe') {
    const probes = await Promise.all([
      ['copilot-cli', 'cli'], ['copilot-cli', 'vscode-terminal'], ['copilot-cli', 'intellij-terminal'],
      ['copilot-native', 'vscode-native'], ['copilot-native', 'intellij-native']
    ].map(([runtime, host]) => probeTelemetry({ root, provider: 'github-copilot', runtime, host })));
    const result = { schemaVersion: 1, probes };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    for (const probe of probes) console.log(`${probe.host}: ${probe.mode} · ${probe.available ? 'available' : 'usage unavailable'}`);
    return;
  }
  if (subcommand === 'disable') {
    const preference = await setTelemetryCapture(false);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ schemaVersion: 1, status: 'disabled', preference }, null, 2));
    console.log('Local usage capture is disabled for future SFlow-owned launches. Governed work is unchanged.');
    return;
  }
  if (subcommand === 'enable') {
    if (!optionBoolean(options, 'json')) console.log(TELEMETRY_DISCLOSURE);
    const explicit = optionString(options, 'confirm');
    const accepted = explicit != null
      ? explicit === TELEMETRY_DISCLOSURE_CONFIRMATION
      : await confirmExact('Enable metadata-only local usage capture?', TELEMETRY_DISCLOSURE_CONFIRMATION);
    if (!accepted) throw new SingularityFlowError(`Telemetry enable requires exact confirmation '${TELEMETRY_DISCLOSURE_CONFIRMATION}'.`, { code: 'TELEMETRY_DISCLOSURE_REQUIRED' });
    const preference = await setTelemetryCapture(true, { acceptDisclosure: true });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({
      schemaVersion: 1, status: 'enabled', disclosure: TELEMETRY_DISCLOSURE, preference
    }, null, 2));
    console.log('Local metadata-only usage capture is enabled for future SFlow-owned launches.');
    return;
  }
  if (subcommand !== 'reconcile') throw new SingularityFlowError(`Unknown telemetry subcommand: ${subcommand}`);
  if (!root) {
    throw new SingularityFlowError('Telemetry reconciliation requires an active governed repository.', {
      code: 'TELEMETRY_ROOT_REQUIRED'
    });
  }
  const [
    { commitAndPublish, loadConfig, loadStoryAggregate, reconcilePhaseTelemetry },
    { storyDraftTransaction }
  ] = await Promise.all([
    import('../state-stores.mjs'),
    import('./shared/story-draft-transaction.mjs')
  ]);
  const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  let result;
  await storyDraftTransaction(root, config, workflow, `telemetry-reconcile:${positionals[2] ?? workflow.currentPhase}`, async (recoveryPreimage) => {
    result = await reconcilePhaseTelemetry(root, config, workflow, { phaseId: positionals[2] });
    if (result.updated) {
      const publication = await commitAndPublish(
        root,
        config,
        workflow,
        { type: LIFECYCLE_EVENT.TELEMETRY_RECORDED, phaseId: result.phase, generation: result.generation },
        `[${workflow.workItem.id}][phase:${result.phase}][telemetry:${result.generation}] reconcile Copilot usage`,
        [],
        { recoveryPreimage }
      );
      Object.assign(result, { commit: publication.sha, pushed: publication.pushed });
    }
    return result;
  });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ exporter: status, reconciliation: result }, null, 2));
  if (!result.updated) {
    console.log(`Telemetry was not changed: ${result.reason}`);
    status.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    return;
  }
  console.log(`Reconciled ${result.phase} generation ${result.generation}: ${result.status}.`);
  console.log(`Models: ${result.models.join(', ') || 'unavailable'} | Tokens: ${result.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) || 'unavailable'} | Provider cost: ${result.providerCost == null ? 'unavailable' : `$${result.providerCost.toFixed(6)}`}`);
  const reconciledActivity = copilotActivityLine(result.activity);
  if (reconciledActivity) console.log(reconciledActivity);
  console.log(`Commit: ${result.commit.slice(0, 8)}${result.pushed ? ' and pushed' : ''}`);
}
