/** CLI presentation for native post-transition reports; never imported by the SDK or native port. */
import {redactDiagnosticText} from './git-remote-diagnostics.mjs';
import {printCommandRoutes} from './commands/shared/print-command-routes.mjs';
import {
  postPublicationStep as runPostPublicationStep,
  collectRequiredReceiptsAfterTransition,
  collectSpecUsageAfterTransition
} from './engine-compatibility/post-transition.mjs';

const message = error => redactDiagnosticText(error?.message ?? String(error));

export function presentPostPublicationNotice(event) {
  if (event.code !== 'transition.tail-failed') return false;
  console.warn(`Warning: publication succeeded, but ${event.task} could not be completed: ${message(event.error)}`);
  printCommandRoutes(`singularity-flow resume ${event.workId} --fetch`, {label: 'Refresh local phase/session state'});
  return true;
}

function presentRequiredReceiptNotice(event) {
  if (event.code !== 'transition.receipts-failed') return false;
  console.warn(`Warning: a required after-step action was delivered, but its receipt could not be recorded: ${message(event.error)} Run singularity-flow integrations record.`);
  return true;
}

async function presentSpecUsageNotice(event) {
  if (event.code === 'transition.usage-differs') {
    console.warn(`Warning: the state branch already holds different usage records at ${event.paths.join(', ')}; they were left as they are.`);
  } else if (event.code === 'transition.usage-failed') {
    const {repairCommand} = await import('./spec-library/usage.mjs');
    console.warn(`Warning: the approval landed, but this Story's specification usage could not be recorded: ${message(event.error)} Run ${event.specifications.map(slice => repairCommand(slice, event.workId)).join(' and ')}.`);
  } else return false;
  return true;
}

export function presentPostTransitionNotice(event) {
  return presentPostPublicationNotice(event) || presentRequiredReceiptNotice(event) || presentSpecUsageNotice(event);
}

export async function requiredReceiptsLine(report) {
  if (!report?.recorded?.written?.length) return null;
  const {recordedReceiptsLine} = await import('./step-action-recording.mjs');
  return recordedReceiptsLine(report.recorded);
}

export function specUsageLine(report) {
  if (!report?.result?.written?.length) return null;
  const {records, result} = report;
  return `Recorded this Story's use of ${[...new Set(records.map(entry => `${entry.record.specId}@${entry.record.revision}`))].join(', ')} on the state branch: ${[...new Set(records.filter(entry => result.written.includes(entry.path)).map(entry => entry.record.kind))].join(' and ')}.`;
}

/** Compatibility functions for existing CLI callers, including their exact warning behavior. */
export function postPublicationStep(task, workId, operation) {
  return runPostPublicationStep(task, workId, operation, {notice: presentPostPublicationNotice});
}

export async function recordRequiredReceiptsAfterTransition(root, workflow) {
  return requiredReceiptsLine(await collectRequiredReceiptsAfterTransition(root, workflow, {notice: presentRequiredReceiptNotice}));
}

export async function recordSpecUsageAfterTransition(root, config, workflow, options = {}) {
  return specUsageLine(await collectSpecUsageAfterTransition(root, config, workflow,
    {...options, notice: presentSpecUsageNotice}));
}
