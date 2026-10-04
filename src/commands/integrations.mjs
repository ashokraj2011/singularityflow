/**
 * `singularity-flow integrations`: the targets after-step actions deliver to, and their deliveries.
 *
 *   list    targets and which steps use them (or one Story's pinned actions with --work-id)
 *   status  deliveries in this repository's outbox: waiting, pending, failed (--all adds delivered)
 *   retry   deliver now: named delivery keys, or every pending and failed one with --all
 *   record  commit a receipt for each of this Story's delivered deliveries, as evidence everyone
 *           sees (refused while a step awaits approval; --dry-run shows what it would record)
 *   deliver in a pipeline: deliver what a pushed lifecycle commit calls for to targets marked
 *           deliverFrom: pipeline, only when the target matches the approved configuration on the
 *           trusted ref (--trusted-ref, default the remote's default branch); --record commits
 *           the receipts when the Story's branch is checked out
 *   test    the exact request a target would receive; --send-test sends one marked as a test
 *           (for a Jira target: the comment it would write; --send-test checks the connection and
 *           the issue without writing anything; for a Git target: the commit it would make;
 *           --send-test checks that the repository can be read; for Confluence: the page it would
 *           write; --send-test reads the parent page; for OneDrive: the file it would upload;
 *           --send-test reads the drive)
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../git.mjs';
import { loadConfig } from '../state-stores.mjs';
import {
  action, commandResult, effects, noEffects, succeeded
} from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import {
  deliverStepActions, deliveryRequest, listStepActionDeliveries, postDelivery
} from '../step-action-delivery.mjs';
import {
  INTEGRATION_TARGET_KINDS, STEP_ACTION_SENDS, STEP_ACTION_TRIGGERS, buildStepActionEvent, jiraTransitionFor, normalizeIntegrations,
  stepActionDeliveryKey
} from '../step-actions.mjs';
import { gitDeliveryHint, gitDeliveryMessage, jiraAttachmentName, jiraCommentText } from '../step-action-writers.mjs';
import { DEFAULT_GIT_DELIVERY_PATH, renderConfluenceTitle, renderGitDeliveryPath } from '../step-actions.mjs';
import { confluencePageBody } from '../step-action-confluence.mjs';
import { GRAPH_BASE, graphDrivePath, oneDriveItemPath } from '../step-action-onedrive.mjs';
import { pinnedHttpRequest } from '../pinned-http.mjs';
import { planStepActionReceipts, stepActionReceiptDirectory, stepAwaitingApproval } from '../step-action-receipts.mjs';
import { getCurrentUser, jiraConnectionFromEnv, listIssueTransitions } from '../jira.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const SECRET_HEADERS = new Set(['authorization', 'dd-api-key', 'x-sflow-signature']);

function result(operation, outcome, { data, changed = false, next = [] } = {}) {
  return commandResult({
    operation: { id: operation.id, classification: operation.classification },
    subject: null,
    outcome,
    effects: changed ? effects({ stateChanged: true, filesChanged: true }) : noEffects(),
    next,
    restState: 'informational',
    data
  });
}

/** Where each target is used, per workflow, from the repository's current configuration. */
function configuredUse(config) {
  const integrations = normalizeIntegrations(config.integrations);
  const uses = [];
  for (const [workflowId, workType] of Object.entries(config.workTypes ?? {})) {
    for (const phaseId of workType.phases ?? []) {
      const override = workType.phaseOverrides?.[phaseId];
      const actions = override && Object.hasOwn(override, 'afterStep') ? override.afterStep : config.phases?.[phaseId]?.afterStep;
      for (const entry of actions ?? []) {
        uses.push({ workflow: workflowId, step: phaseId, action: entry.id, on: entry.on, target: entry.target, send: entry.send ?? 'event', required: entry.required === true });
      }
    }
  }
  return { targets: Object.values(integrations.targets), uses };
}

function jiraConnected(env) {
  try { jiraConnectionFromEnv(env); return true; } catch { return false; }
}

/** Where a target delivers, in a few words. */
function targetAddress(target) {
  if (target.kind === 'jira') return target.issue ?? "each Story's Jira issue";
  if (target.kind === 'git') return `${target.repository} → ${target.branch}`;
  if (target.kind === 'confluence') return `${target.url} (under page ${target.parentPage})`;
  if (target.kind === 'onedrive') return `drive ${target.drive}${target.site ? ` on site ${target.site}` : ''}`;
  return target.url ?? `(address in ${target.urlSecret})`;
}

/** What a target needs on this machine: its secrets, or for Jira the Jira connection. */
function credentialSummary(target, env) {
  // A pipeline delivers it with its own credentials; this machine needs none of them.
  if (target.deliverFrom === 'pipeline') return 'the pipeline\'s credentials';
  if (target.kind === 'jira') return jiraConnected(env) ? 'Jira connection' : 'Jira connection (not connected here)';
  if (target.kind === 'git') return 'your Git credentials';
  return secretStatus(target, env).map((entry) => `${entry.name}${entry.set ? '' : ' (not set here)'}`).join(', ') || '—';
}

function secretStatus(target, env) {
  const names = [target.signingSecret, target.tokenSecret, target.urlSecret].filter(Boolean);
  return names.map((name) => ({ name, set: Boolean(env[name] && String(env[name]).trim()) }));
}

function line(columns, widths) { return columns.map((value, index) => String(value ?? '').padEnd(widths[index])).join('  ').trimEnd(); }

function table(rows, headers) {
  const widths = headers.map((header, index) => Math.min(40, Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length))));
  return [line(headers, widths), line(widths.map((width) => '-'.repeat(width)), widths), ...rows.map((row) => line(row, widths))].join('\n');
}

async function listCommand(root, config, options, operation, json) {
  const workId = optionString(options, 'work-id');
  if (workId) {
    const { loadWorkflow } = await import('../state.mjs');
    const workflow = await loadWorkflow(root, config, workId);
    const pinned = (workflow.resolution?.phases ?? []).flatMap((phase) => (phase.afterStep ?? []).map((entry) => ({
      step: phase.id, action: entry.id, on: entry.on, target: entry.target, kind: entry.targetSpec?.kind ?? null, send: entry.send, required: entry.required === true
    })));
    if (!json) {
      console.log(pinned.length
        ? table(pinned.map((entry) => [entry.step, `${entry.action}${entry.required ? ' (required)' : ''}`, entry.on.join(','), `${entry.target} (${entry.kind})`, entry.send]), ['STEP', 'ACTION', 'ON', 'TARGET', 'SENDS'])
        : `${workId} pinned no after-step actions when it started.`);
    }
    return emitCommandResult(result(operation, succeeded('integrations.listed', { targets: new Set(pinned.map((entry) => entry.target)).size, actions: pinned.length, scope: workId }),
      { data: { workId, actions: pinned } }), { json });
  }
  const { targets, uses } = configuredUse(config);
  const env = process.env;
  if (!json) {
    if (!targets.length) console.log('No integration targets are configured. Add them under integrations.targets in singularity/workflow.yml, or in Workflow Studio.');
    else {
      console.log(table(targets.map((target) => [target.id, target.kind, targetAddress(target), credentialSummary(target, env)]), ['TARGET', 'KIND', 'ADDRESS', 'NEEDS']));
      if (uses.length) {
        console.log('');
        console.log(table(uses.map((use) => [use.workflow, use.step, `${use.action}${use.required ? ' (required)' : ''}`, use.on.join(','), use.target, use.send]), ['WORKFLOW', 'STEP', 'ACTION', 'ON', 'TARGET', 'SENDS']));
      }
    }
  }
  return emitCommandResult(result(operation, succeeded('integrations.listed', { targets: targets.length, actions: uses.length, scope: 'repository' }), {
    data: { targets: targets.map((target) => ({ ...target, secrets: secretStatus(target, env), ...(target.kind === 'jira' ? { connection: { kind: 'jira', connected: jiraConnected(env) } } : {}) })), uses }
  }), { json });
}

/**
 * Whether each delivery's receipt is in this checkout: true or false for a Story this checkout
 * holds, null for one it does not (its receipts live on that Story's branch).
 */
async function withReceiptState(root, deliveries) {
  if (!deliveries.some((entry) => entry.workId)) return deliveries;
  const config = await loadConfig(root).catch(() => ({}));
  return deliveries.map((entry) => {
    if (!entry.workId) return entry;
    const directory = path.join(root, stepActionReceiptDirectory(config, entry.workId));
    const story = path.dirname(path.dirname(directory));
    return { ...entry, recorded: existsSync(story) ? existsSync(path.join(directory, `${entry.key}.json`)) : null };
  });
}

async function statusCommand(root, options, operation, json) {
  const deliveries = await withReceiptState(root, await listStepActionDeliveries(root, { workId: optionString(options, 'work-id'), includeDelivered: optionBoolean(options, 'all') }));
  const open = deliveries.filter((entry) => ['pending', 'waiting', 'failed', 'tampered'].includes(entry.status));
  if (!json) {
    if (deliveries.length) {
      console.log(table(deliveries.map((entry) => [entry.status === 'delivered' && entry.recorded ? 'recorded' : entry.status, entry.workId, entry.phaseId, entry.trigger, `${entry.action}${entry.required ? ' (required)' : ''} → ${entry.target}`, entry.attempts,
        entry.lastAttempt ? (entry.lastAttempt.status ? `HTTP ${entry.lastAttempt.status}` : entry.lastAttempt.code ?? entry.lastAttempt.outcome) : '', entry.key]),
      ['STATUS', 'STORY', 'STEP', 'ON', 'ACTION', 'TRIES', 'LAST', 'KEY']));
    }
  }
  const failed = open.filter((entry) => entry.status === 'failed').map((entry) => entry.key);
  return emitCommandResult(result(operation, succeeded('integrations.status', { count: deliveries.length, open: open.length, failed: failed.length }), {
    data: { deliveries },
    next: failed.length ? [action({ id: 'integrations-retry', label: 'Retry the failed deliveries', command: `singularity-flow integrations retry ${failed.join(' ')}`, kind: 'remediation' })] : []
  }), { json });
}

async function retryCommand(root, config, positionals, options, operation, json) {
  const keys = positionals.slice(2);
  const all = optionBoolean(options, 'all');
  if (!keys.length && !all) {
    throw new SingularityFlowError('integrations retry needs one or more delivery keys, or --all for every pending and failed delivery.', {
      code: 'STEP_ACTION_DELIVERY_REQUIRED'
    });
  }
  const { repositoryLogger } = await import('../logging.mjs');
  const knownBefore = new Set((await listStepActionDeliveries(root)).map(entry => entry.key));
  const { loadStoryAggregate } = await import('../state-stores.mjs');
  const { reconstructRequiredStepActions } = await import('../step-action-recovery.mjs');
  let reconstruction = { restored: [], unavailable: [] };
  try {
    const workflow = await loadStoryAggregate(root, config);
    reconstruction = await reconstructRequiredStepActions(root, config, workflow, { keys: keys.length ? keys : null });
  } catch (error) {
    // Existing outbox deliveries still work outside an active Story. Never infer a missing one.
    reconstruction.unavailable.push({ reason: `Could not reconstruct missing deliveries: ${error.message}` });
  }
  const restoredKeys = new Set(reconstruction.restored.map(entry => entry.key));
  const selected = keys.length ? keys : (await listStepActionDeliveries(root)).filter(entry =>
    entry.status === 'pending' || entry.status === 'failed').map(entry => entry.key);
  const report = await deliverStepActions(root, { keys: selected.filter(key => knownBefore.has(key) && !restoredKeys.has(key)), includeFailed: all, logger: repositoryLogger(root, config) });
  for (const key of keys.filter(key => !knownBefore.has(key) && !restoredKeys.has(key))) report.skipped.push({ key, reason: 'unknown; see reconstruction diagnostics' });
  let recorded = null;
  if (report.delivered.length) {
    const { recordRequiredReceiptsAfterDelivery } = await import('../step-action-recording.mjs');
    try { recorded = await recordRequiredReceiptsAfterDelivery(root); } catch (error) {
      if (!json) console.warn(`Warning: the delivery went out, but its required receipt could not be recorded: ${error.message} Run singularity-flow integrations record.`);
    }
  }
  if (!json) {
    for (const entry of reconstruction.restored) console.log(`${entry.key}: ${entry.message} Next: ${entry.command}`);
    for (const entry of reconstruction.unavailable) console.warn(entry.reason);
    for (const entry of [...report.delivered, ...report.retrying, ...report.unavailable, ...report.failed]) {
      const state = report.delivered.includes(entry) ? 'delivered' : report.failed.includes(entry) ? 'failed' : report.unavailable.includes(entry) ? 'unavailable here' : 'will retry';
      console.log(`${state.padEnd(16)} ${entry.action} → ${entry.target} (${entry.phaseId}, ${entry.trigger})${entry.detail ? `: ${entry.detail}` : ''}`);
    }
    for (const entry of report.skipped) console.log(`${'skipped'.padEnd(16)} ${entry.key}: ${entry.reason}`);
    if (recorded?.written?.length) console.log(`Recorded ${recorded.written.length} after-step receipt(s) in commit ${recorded.publication.sha.slice(0, 8)}${recorded.publication.pushed ? ' and pushed' : ''}, so the next step is not held.`);
  }
  return emitCommandResult(result(operation, succeeded('integrations.retried', {
    count: report.delivered.length + report.retrying.length + report.unavailable.length + report.failed.length,
    delivered: report.delivered.length, pending: report.retrying.length + report.unavailable.length, failed: report.failed.length
  }), { data: { report, reconstruction, receipts: recorded?.written?.length ? { count: recorded.written.length, commit: recorded.publication.sha, pushed: Boolean(recorded.publication.pushed) } : null }, changed: true,
    next: reconstruction.restored.map(entry => action({ id: `review-${entry.key}`, label: 'Review receiver outcome before retrying', command: entry.command, kind: 'remediation' }))
  }), { json });
}

/** One delivery as \`integrations record\` reports it. */
function receiptLine(record) {
  return {
    key: record.key, phaseId: record.phaseId, generation: record.generation, trigger: record.trigger,
    action: record.action.id, target: record.action.target, kind: record.action.targetSpec.kind, deliveredAt: record.deliveredAt ?? null
  };
}

async function recordCommand(root, config, options, operation, json) {
  const { loadStoryAggregate } = await import('../state-stores.mjs');
  const workflow = await loadStoryAggregate(root, config);
  const workId = workflow.workItem.id;
  const requested = optionString(options, 'work-id');
  if (requested && requested !== workId) {
    throw new SingularityFlowError(
      `--work-id ${requested} does not match the Story checked out here (${workId}). Receipts are committed on a Story's own branch: check out ${requested} first, or drop --work-id.`,
      { code: 'STEP_ACTION_WORK_ID_MISMATCH', details: { requested, checkedOut: workId } }
    );
  }
  const plan = await planStepActionReceipts(root, config, workflow);
  const awaitingApproval = stepAwaitingApproval(workflow);
  const dryRun = optionBoolean(options, 'dry-run');
  const pending = plan.pending.map(receiptLine);
  const report = (outcome, extra = {}) => emitCommandResult(result(operation, outcome, {
    data: { workId, receipts: [], pending, skipped: plan.skipped, recorded: plan.recorded, awaitingApproval, publication: null, ...extra },
    changed: Boolean(extra.publication)
  }), { json });
  if (!json) {
    for (const entry of plan.skipped) console.log(`${'not recorded'.padEnd(14)} ${entry.action ?? entry.key} (${entry.phaseId}, ${entry.trigger}): ${entry.reason}`);
  }
  if (dryRun || !pending.length) {
    if (!json) {
      for (const entry of pending) console.log(`${'would record'.padEnd(14)} ${entry.action} → ${entry.target} (${entry.phaseId}, ${entry.trigger})`);
      if (!pending.length) {
        if (plan.recorded) console.log(`Nothing to record: ${plan.recorded} ${plan.recorded === 1 ? 'delivery already has its receipt' : 'deliveries already have their receipts'}.`);
        else if (plan.skipped.length) console.log('Nothing to record.');
        else console.log(`Nothing to record: no after-step action of ${workId} has been delivered from this machine.`);
      } else if (awaitingApproval) {
        console.log(`${awaitingApproval} is awaiting approval, so recording would be refused now; record after it is approved or sent back.`);
      }
    }
    return report(succeeded('integrations.recorded', { count: 0, pending: pending.length, recorded: plan.recorded, skipped: plan.skipped.length, dryRun }));
  }
  const { commitStepActionReceipts } = await import('../step-action-recording.mjs');
  const { written, publication } = await commitStepActionReceipts(root, config, workflow);
  if (!json) {
    for (const { receipt } of written) console.log(`${'recorded'.padEnd(14)} ${receipt.action.id} → ${receipt.action.target} (${receipt.phaseId}, ${receipt.trigger})`);
    console.log(`Committed ${publication.sha.slice(0, 8)}${publication.pushed ? ' and pushed' : ''}.`);
  }
  return report(succeeded('integrations.recorded', { count: written.length, pending: 0, recorded: plan.recorded + written.length, skipped: plan.skipped.length, dryRun: false, commit: publication.sha }), {
    receipts: written.map(({ path, receipt }) => ({ path, ...receipt })),
    pending: [],
    publication: { sha: publication.sha, pushed: Boolean(publication.pushed) }
  });
}

/** A pipeline delivers what one pushed lifecycle commit calls for; a failed delivery fails the job. */
async function deliverCommand(root, config, options, operation, json) {
  const commit = optionString(options, 'commit');
  if (!commit) {
    throw new SingularityFlowError('integrations deliver needs --commit <SHA>: the pushed lifecycle commit to deliver for.', { code: 'STEP_ACTION_COMMIT_REQUIRED' });
  }
  const [{ deliverFromPipeline }, { repositoryLogger }] = await Promise.all([import('../step-action-pipeline.mjs'), import('../logging.mjs')]);
  const delivery = await deliverFromPipeline(root, {
    commit, trustedRef: optionString(options, 'trusted-ref'), record: optionBoolean(options, 'record'), logger: repositoryLogger(root, config)
  });
  const report = delivery.report ?? { delivered: [], retrying: [], failed: [], unavailable: [], skipped: [], notReached: [] };
  const untrusted = delivery.actions.filter((entry) => !entry.trusted);
  const open = report.failed.length + report.retrying.length + report.unavailable.length + (report.notReached?.length ?? 0);
  if (!json) {
    const short = String(delivery.commit).slice(0, 12);
    if (!delivery.lifecycle) console.log(`${short} is not a lifecycle commit of a Story; nothing to deliver.`);
    else if (!delivery.actions.length) console.log(`${short} (${delivery.workId} ${delivery.event.phaseId} generation ${delivery.event.generation}, ${delivery.event.type}) calls for no pipeline delivery.`);
    for (const entry of [...report.delivered, ...report.retrying, ...report.unavailable, ...report.failed]) {
      const state = report.delivered.includes(entry) ? 'delivered' : report.failed.includes(entry) ? 'failed' : report.unavailable.includes(entry) ? 'unavailable here' : 'not delivered';
      console.log(`${state.padEnd(16)} ${entry.action} → ${entry.target} (${entry.phaseId}, ${entry.trigger})${entry.detail ? `: ${entry.detail}` : ''}`);
    }
    for (const entry of untrusted) console.log(`${'not trusted'.padEnd(16)} ${entry.action} → ${entry.target} (${delivery.event.phaseId}, ${entry.trigger}): ${entry.reason}`);
    if (delivery.receipts?.recorded) console.log(`Recorded ${delivery.receipts.count} after-step receipt(s) in commit ${delivery.receipts.commit.slice(0, 8)}${delivery.receipts.pushed ? ' and pushed' : ''}.`);
    else if (delivery.receipts) console.log(`Receipts not recorded: ${delivery.receipts.reason}`);
  }
  // A pipeline job shows red when a delivery did not go out or was not trusted, so someone looks.
  if (open || untrusted.length) process.exitCode = 1;
  return emitCommandResult(result(operation, succeeded('integrations.pipeline-delivered', {
    lifecycle: delivery.lifecycle, count: delivery.actions.length, delivered: report.delivered.length, open, untrusted: untrusted.length,
    commit: String(delivery.commit).slice(0, 12)
  }), { data: { ...delivery }, changed: Boolean(report.delivered.length || delivery.receipts?.recorded) }), { json });
}

function redactedHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SECRET_HEADERS.has(name) ? '[redacted]' : value]));
}

async function testCommand(root, config, positionals, options, operation, json) {
  const targetId = positionals[2];
  const integrations = normalizeIntegrations(config.integrations);
  const target = targetId ? integrations.targets[targetId] : null;
  if (!target) {
    const known = Object.keys(integrations.targets);
    throw new SingularityFlowError(`integrations test needs a configured target.${known.length ? ` Configured: ${known.join(', ')}.` : ' None are configured.'}`, {
      code: 'STEP_ACTION_TARGET_UNKNOWN'
    });
  }
  const trigger = optionString(options, 'trigger') ?? 'approved';
  if (!STEP_ACTION_TRIGGERS.includes(trigger)) throw new SingularityFlowError(`--trigger must be one of: ${STEP_ACTION_TRIGGERS.join(', ')}.`, { code: 'STEP_ACTION_INVALID' });
  const send = optionString(options, 'send') ?? 'event';
  if (!STEP_ACTION_SENDS.includes(send) || !INTEGRATION_TARGET_KINDS[target.kind].sends.includes(send)) {
    throw new SingularityFlowError(`A ${target.kind} target accepts --send ${INTEGRATION_TARGET_KINDS[target.kind].sends.join(' or ')}.`, { code: 'STEP_ACTION_SEND_UNSUPPORTED' });
  }
  const phaseId = optionString(options, 'phase') ?? 'example-step';
  const actionEntry = { id: 'test', on: [trigger], target: target.id, send, targetSpec: target };
  const key = stepActionDeliveryKey({ workId: 'TEST', phaseId, generation: 0, trigger, actionId: `test-${Date.now()}` });
  const event = buildStepActionEvent({
    workflow: { workItem: { id: 'TEST', title: 'Test delivery from singularity-flow integrations test', branch: null }, phases: { [phaseId]: { status: trigger === 'approved' ? 'approved' : 'awaiting_approval', generation: 0, artifacts: [] } }, resolution: { phases: [] } },
    phaseId, trigger, action: actionEntry, deliveryKey: key, event: { createdAt: new Date().toISOString() }
  });
  event.test = true;
  if (send === 'summary') event.summary = { title: 'Example artifact title', acceptanceCriteria: ['Example acceptance criterion'] };
  const record = { key, trigger, action: actionEntry, event };
  if (target.kind === 'jira') return jiraTest(target, { ...record, workId: 'TEST', phaseId, generation: 0 }, { operation, json, sendIt: optionBoolean(options, 'send-test') });
  if (target.kind === 'git') return gitTest(target, { ...record, workId: 'TEST', phaseId, generation: 0 }, { operation, json, sendIt: optionBoolean(options, 'send-test') });
  if (target.kind === 'onedrive') return oneDriveTest(target, { ...record, workId: 'TEST', phaseId, generation: 0 }, { operation, json, sendIt: optionBoolean(options, 'send-test') });
  if (target.kind === 'confluence') return confluenceTest(target, { ...record, workId: 'TEST', phaseId, generation: 0 }, { operation, json, sendIt: optionBoolean(options, 'send-test') });
  const request = deliveryRequest(record, process.env);
  const preview = request.url ? { method: 'POST', url: request.url, headers: redactedHeaders(request.headers), body: JSON.parse(request.body) } : null;
  const sendIt = optionBoolean(options, 'send-test');
  let delivery = null;
  if (sendIt && request.url) {
    delivery = await postDelivery({ ...request, timeoutMs: (target.timeoutSeconds ?? 10) * 1000, network: target.network });
  }
  if (!json) {
    if (request.unavailable) console.log(`Cannot build the request on this machine: ${request.unavailable.detail}`);
    else if (request.failed) console.log(`Cannot build the request: ${request.failed.detail}`);
    else {
      console.log(`POST ${preview.url}`);
      for (const [name, value] of Object.entries(preview.headers)) console.log(`${name}: ${value}`);
      console.log('');
      console.log(JSON.stringify(preview.body, null, 2));
      if (delivery) console.log(`\n${delivery.outcome === 'delivered' ? 'Sent' : 'Not delivered'}${delivery.status ? ` (HTTP ${delivery.status})` : ''}${delivery.detail ? `: ${delivery.detail}` : ''}.`);
    }
  }
  return emitCommandResult(result(operation, succeeded('integrations.tested', {
    target: target.id, sent: Boolean(delivery), outcome: delivery?.outcome ?? (request.url ? 'previewed' : 'unavailable'), status: delivery?.status ?? null
  }), { data: { target: target.id, request: preview, unavailable: request.unavailable ?? null, failed: request.failed ?? null, delivery } }), { json });
}

/**
 * A Jira target's test: the comment, attachment and transition a delivery would make, and with
 * --send-test a check that this machine can sign in and see the issue. It never writes to Jira.
 */
async function jiraTest(target, record, { operation, json, sendIt }) {
  if (record.action.send === 'artifact') record.artifact = { path: 'artifacts/example-step/example-step.md', sha256: null, mediaType: 'text/markdown', base64: Buffer.from('# Example artifact\n').toString('base64') };
  const transition = jiraTransitionFor(target, record.trigger);
  const plan = {
    issue: target.issue ?? null,
    comment: jiraCommentText(record),
    attachment: record.action.send === 'artifact' ? jiraAttachmentName(record) : null,
    transition
  };
  const checks = [];
  if (sendIt) {
    let connection = null;
    try { connection = jiraConnectionFromEnv(process.env); }
    catch (error) { checks.push({ check: 'Jira connection on this machine', ok: false, detail: error.message }); }
    if (connection) {
      const options = { connection, maxRetries: 0, requestTimeoutMs: (target.timeoutSeconds ?? 10) * 1000 };
      try {
        const user = await getCurrentUser(options);
        checks.push({ check: 'Signed in to Jira', ok: true, detail: user?.displayName ?? user?.name ?? user?.accountId ?? connection.baseUrl });
      } catch (error) { checks.push({ check: 'Signed in to Jira', ok: false, detail: error.message }); }
      if (target.issue) {
        try {
          const transitions = await listIssueTransitions(target.issue, options);
          checks.push({ check: `Can see ${target.issue}`, ok: true, detail: null });
          const wanted = typeof target.transition === 'string' ? [target.transition] : Object.values(target.transition ?? {});
          for (const status of wanted) {
            const found = transitions.some((item) => item.id === status || item.name?.toLowerCase() === status.toLowerCase() || item.to?.toLowerCase() === status.toLowerCase());
            checks.push({ check: `Can move ${target.issue} to ${status} now`, ok: found, detail: found ? null : `Available now: ${transitions.map((item) => item.to ?? item.name).join(', ') || 'none'}` });
          }
        } catch (error) { checks.push({ check: `Can see ${target.issue}`, ok: false, detail: error.message }); }
      }
    }
  }
  if (!json) {
    console.log(`Issue: ${plan.issue ?? "the issue each Story was started from"}`);
    if (plan.attachment) console.log(`Attachment: ${plan.attachment}`);
    if (plan.transition) console.log(`Then moves it to: ${plan.transition}`);
    console.log('');
    console.log(plan.comment);
    if (checks.length) {
      console.log('');
      for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.check}${entry.detail ? `: ${entry.detail}` : ''}`);
    }
  }
  const ok = checks.every((entry) => entry.ok);
  return emitCommandResult(result(operation, succeeded('integrations.tested', {
    target: target.id, sent: false, outcome: checks.length ? (ok ? 'checked' : 'check-failed') : 'previewed', status: null
  }), { data: { target: target.id, request: null, plan, checks, unavailable: null, failed: null, delivery: null } }), { json });
}

/**
 * A Git target's test: the file and commit a delivery would make, and with --send-test a check that
 * this machine can read the repository and its branch. It never writes; write access is proven by
 * the first delivery.
 */
async function gitTest(target, record, { operation, json, sendIt }) {
  const relative = renderGitDeliveryPath(target.path ?? DEFAULT_GIT_DELIVERY_PATH, {
    workId: record.workId, phaseId: record.phaseId, generation: record.generation, trigger: record.trigger, artifactPath: 'artifacts/example-step/example-step.md'
  });
  const plan = { repository: target.repository, branch: target.branch, path: relative, message: gitDeliveryMessage({ ...record, artifact: null }, relative) };
  const checks = [];
  if (sendIt) {
    const git = await import('../git.mjs');
    try {
      const tip = await git.withIsolatedGitObjectRepository({ remote: target.repository }, (scratch) => git.isolatedRemoteBranchTip(scratch, { remote: target.repository, branch: target.branch }));
      checks.push({ check: `Can read ${target.repository}`, ok: true, detail: null });
      checks.push({ check: `Branch ${target.branch}`, ok: true, detail: tip ? `at ${tip.slice(0, 12)}; deliveries add commits on top` : 'does not exist yet; the first delivery starts it' });
    } catch (error) {
      const hint = gitDeliveryHint(error);
      checks.push({ check: `Can read ${target.repository}`, ok: false, detail: hint ? `${error.message} ${hint}` : error.message });
    }
  }
  if (!json) {
    console.log(`Repository: ${plan.repository}`);
    console.log(`Branch: ${plan.branch} (fast-forward only)`);
    console.log(`File: ${plan.path}`);
    console.log('');
    console.log(plan.message);
    if (checks.length) {
      console.log('');
      for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.check}${entry.detail ? `: ${entry.detail}` : ''}`);
    }
  }
  const ok = checks.every((entry) => entry.ok);
  return emitCommandResult(result(operation, succeeded('integrations.tested', {
    target: target.id, sent: false, outcome: checks.length ? (ok ? 'checked' : 'check-failed') : 'previewed', status: null
  }), { data: { target: target.id, request: null, plan, checks, unavailable: null, failed: null, delivery: null } }), { json });
}

/**
 * A OneDrive target's test: where the file would go, and with --send-test a read of the drive with
 * the token. It never uploads.
 */
async function oneDriveTest(target, record, { operation, json, sendIt }) {
  record.artifact = { path: 'artifacts/example-step/example-step.md', sha256: null, mediaType: 'text/markdown', base64: Buffer.from('# Example artifact\n').toString('base64') };
  const plan = { drive: target.drive, site: target.site ?? null, file: oneDriveItemPath(record), replaces: false };
  const checks = [];
  if (sendIt) {
    const token = String(process.env[target.tokenSecret] ?? '').trim();
    if (!token) checks.push({ check: `Secret ${target.tokenSecret}`, ok: false, detail: 'not set on this machine' });
    else {
      const answer = await pinnedHttpRequest({
        url: `${GRAPH_BASE}${graphDrivePath(target)}/root`, method: 'GET', timeoutMs: (target.timeoutSeconds ?? 10) * 1000,
        network: 'public', maxResponseBytes: 256 * 1024, headers: { accept: 'application/json', authorization: `Bearer ${token}` }
      });
      if (answer.transport) checks.push({ check: 'Can reach Microsoft Graph', ok: false, detail: answer.transport.detail });
      else {
        const ok = answer.status >= 200 && answer.status < 300;
        checks.push({ check: `Can see drive ${target.drive}`, ok, detail: ok ? null : `HTTP ${answer.status}${answer.status === 401 ? ' (the token has expired or lacks Files permissions)' : ''}` });
      }
    }
  }
  if (!json) {
    console.log(`Drive: ${plan.drive}${plan.site ? ` on site ${plan.site}` : ''}`);
    console.log(`File: ${plan.file} (never replaces a file already there)`);
    if (checks.length) {
      console.log('');
      for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.check}${entry.detail ? `: ${entry.detail}` : ''}`);
    }
  }
  const ok = checks.every((entry) => entry.ok);
  return emitCommandResult(result(operation, succeeded('integrations.tested', {
    target: target.id, sent: false, outcome: checks.length ? (ok ? 'checked' : 'check-failed') : 'previewed', status: null
  }), { data: { target: target.id, request: null, plan, checks, unavailable: null, failed: null, delivery: null } }), { json });
}

/**
 * A Confluence target's test: the page title and body a delivery would write, and with --send-test
 * a read of the parent page with the token. It never writes.
 */
async function confluenceTest(target, record, { operation, json, sendIt }) {
  if (record.action.send === 'artifact') record.artifact = { path: 'artifacts/example-step/example-step.md', sha256: null, mediaType: 'text/markdown', base64: Buffer.from('# Example artifact\n\nThe approved document appears here.\n').toString('base64') };
  const title = renderConfluenceTitle(target.title, { workId: record.workId, stepLabel: record.event?.step?.label ?? record.phaseId, storyTitle: record.event?.story?.title });
  const plan = { url: target.url, parentPage: target.parentPage, title, body: confluencePageBody(record) };
  const checks = [];
  if (sendIt) {
    const token = String(process.env[target.tokenSecret] ?? '').trim();
    if (!token) checks.push({ check: `Secret ${target.tokenSecret}`, ok: false, detail: 'not set on this machine' });
    else {
      const cloud = target.deployment !== 'data-center';
      const authorization = cloud ? `Basic ${Buffer.from(`${target.user}:${token}`).toString('base64')}` : `Bearer ${token}`;
      const route = cloud ? `/api/v2/pages/${encodeURIComponent(target.parentPage)}` : `/rest/api/content/${encodeURIComponent(target.parentPage)}`;
      const answer = await pinnedHttpRequest({
        url: `${String(target.url).replace(/\/+$/, '')}${route}`, method: 'GET', timeoutMs: (target.timeoutSeconds ?? 10) * 1000,
        network: target.network ?? 'public', maxResponseBytes: 256 * 1024, headers: { accept: 'application/json', authorization }
      });
      if (answer.transport) checks.push({ check: `Can reach ${target.url}`, ok: false, detail: answer.transport.detail });
      else {
        let page = null;
        try { page = JSON.parse(answer.text); } catch { page = null; }
        const ok = answer.status >= 200 && answer.status < 300;
        checks.push({ check: `Can see parent page ${target.parentPage}`, ok, detail: ok ? (page?.title ?? null) : `HTTP ${answer.status}` });
      }
    }
  }
  if (!json) {
    console.log(`Under page ${plan.parentPage} at ${plan.url}`);
    console.log(`Title: ${plan.title}`);
    console.log('');
    console.log(plan.body);
    if (checks.length) {
      console.log('');
      for (const entry of checks) console.log(`${entry.ok ? 'ok  ' : 'FAIL'} ${entry.check}${entry.detail ? `: ${entry.detail}` : ''}`);
    }
  }
  const ok = checks.every((entry) => entry.ok);
  return emitCommandResult(result(operation, succeeded('integrations.tested', {
    target: target.id, sent: false, outcome: checks.length ? (ok ? 'checked' : 'check-failed') : 'previewed', status: null
  }), { data: { target: target.id, request: null, plan, checks, unavailable: null, failed: null, delivery: null } }), { json });
}

export async function run(_argv, { positionals, options, operation: given = null }) {
  const subcommand = positionals[1] ?? 'status';
  const operation = given ?? { id: `integrations.${subcommand}`, classification: ['retry', 'record', 'deliver'].includes(subcommand) ? 'mutation' : 'read' };
  const json = optionBoolean(options, 'json');
  const root = repoRoot();
  if (subcommand === 'status') return statusCommand(root, options, operation, json);
  const config = await loadConfig(root);
  if (subcommand === 'list') return listCommand(root, config, options, operation, json);
  if (subcommand === 'retry') return retryCommand(root, config, positionals, options, operation, json);
  if (subcommand === 'test') return testCommand(root, config, positionals, options, operation, json);
  if (subcommand === 'record') return recordCommand(root, config, options, operation, json);
  if (subcommand === 'deliver') return deliverCommand(root, config, options, operation, json);
  throw new SingularityFlowError(`Unknown integrations subcommand '${subcommand}'. Available: list, status, retry, record, deliver, test.`, { code: 'UNKNOWN_SUBCOMMAND' });
}
