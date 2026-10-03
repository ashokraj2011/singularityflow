/**
 * Whether a Story that has just reached its end passed the whole-Story governance check.
 *
 * Every step being decided is a lifecycle fact, not evidence that the Story's obligations were met.
 * The terminal gate replays the committed and published Story, so it runs once the completing
 * transition (final approval, an `end` decision, an approval-free completion) has been committed and
 * pushed. Until it passes, nothing may call the Story complete.
 */
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { runGovernanceGate } from './governance.mjs';
import { action } from './narration/command-result.mjs';

/** Run the terminal gate over the Story as committed. Never throws: a check that cannot run fails. */
export async function completionVerdict(root, workId) {
  try {
    const accepted = await loadAcceptedStoryExecution(root, workId);
    const result = await runGovernanceGate(root, accepted.definition, accepted.workflow, { terminal: true });
    const workflow = accepted.workflow;
    const delivered = (workflow.phaseOrder ?? []).some((id) => phaseRequiresCodeDelivery(workflow.phases?.[id])
      && workflow.phases[id]?.status === 'approved');
    return Object.freeze({
      verified: result.errors.length === 0,
      assurance: delivered ? 'module-observed' : null,
      errors: Object.freeze([...result.errors]),
      warnings: Object.freeze([...result.warnings]),
      findings: Object.freeze([...(result.findings ?? [])])
    });
  } catch (error) {
    return Object.freeze({
      verified: false,
      assurance: null,
      errors: Object.freeze([`the final governance check could not run: ${error?.message ?? String(error)}`]),
      warnings: Object.freeze([]),
      findings: Object.freeze([])
    });
  }
}

/**
 * The final evaluation the ending transition recorded on the Story, as a verdict. Every ending now
 * passes the evaluation inside its own transaction, so a committed ending carries one; a Story
 * without it never finished that way.
 */
export function recordedCompletion(workflow) {
  const record = workflow?.status === 'closed' ? workflow.completion : null;
  if (!record?.evaluatedAt) return null;
  return Object.freeze({
    verified: true, label: record.label, kind: record.kind,
    assurance: record.assuranceFloor === 'none' ? null : record.assuranceFloor ?? null,
    errors: Object.freeze([]), warnings: Object.freeze([]), findings: Object.freeze([])
  });
}

/** What to do when the final check failed: each finding's own recovery, then the check itself. */
export function completionRecoveryActions(verdict) {
  if (verdict.verified) return [];
  const commands = [...new Set(verdict.findings.map((finding) => finding.recovery?.command).filter(Boolean))];
  const recoveries = commands.map((command, index) => action({
    id: `final-check-recovery-${index + 1}`, label: 'Fix what the final governance check found', command, kind: 'remediation'
  }));
  return [...recoveries, action({
    id: 'final-check-rerun', label: 'Re-run the final governance check', command: 'singularity-flow gate --terminal', kind: 'remediation'
  })];
}

/** Why finalize refused, with the same recoveries a completing transition offers. */
export function finalCheckRefusalMessage(workId, verdict) {
  const commands = completionRecoveryActions(verdict).map((entry) => entry.command);
  return `Story ${workId} cannot be finalized: the final governance check failed:\n- ${verdict.errors.join('\n- ')}`
    + (commands.length ? `\nRecover:\n  ${commands.join('\n  ')}` : '');
}

/** Print the verdict for terminal users; JSON callers read it from the command result instead. */
export function printCompletionVerdict(verdict, { write = console.log, warn = console.warn } = {}) {
  if (verdict.verified) {
    write(verdict.label ? `Final governance check passed: ${verdict.label}.` : 'Final governance check passed.');
    // The check proves the Story's records are consistent; the assurance says how each criterion was tested.
    if (verdict.assurance === 'module-observed') {
      write('Assurance: at least module-observed — the test commands covering the acceptance criteria passed; the evidence matrix shows which criteria were joined to their own test result.');
    } else if (verdict.assurance === 'exact-local-observed') {
      write('Assurance: exact-local-observed — each acceptance criterion\'s own test was found passing in a local run; no run was independently attested.');
    }
    verdict.warnings.forEach((message) => warn(`  warning: ${message}`));
    return;
  }
  warn('Final governance check failed, so the Story is not complete yet:');
  verdict.errors.forEach((message) => warn(`  - ${message}`));
}
