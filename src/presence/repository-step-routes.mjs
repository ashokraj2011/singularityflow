/**
 * The repository-level person steps SF Guard signs (SPEC-PSS-v1 §10.6), by command line: the same
 * steps the Copilot guard refuses for agents (person-step-catalog.mjs PERSON_DECISIONS) that have
 * no Story to pin SF Guard's policy. Import-free, so the CLI entry asks it before loading anything.
 *
 * Telemetry consent is not one of them: it is this machine's preference, not a governance decision.
 */
const EPIC_COMMANDS = new Set(['initiative', 'epic']);
const HOST_POLICY_ASSERTIONS = ['confirm-protected', 'confirm-push-policy', 'confirm-pin-retention'];
const COMMANDS = new Set(['configuration', 'initiative', 'epic', 'goal', 'intent', 'program', 'capabilities', 'ledger', 'agents', 'repair']);

/**
 * The repository-level person step `positionals` and `options` name, as `{ action, label, inRecord }`,
 * or null. Every one of them now signs where it records, over the exact record, and keeps the seal with
 * it (SPEC-PSS-v1 §10.9, §10.10), so the dispatch gate asks no touch of its own (`inRecord`).
 */
export function repositoryPersonStep(positionals, options = {}) {
  const step = namedStep(positionals, options);
  return step ? { ...step, inRecord: true } : null;
}

function namedStep(positionals, options) {
  const [command, sub, verb] = positionals ?? [];
  if (!COMMANDS.has(command) || options['dry-run'] === true) return null;
  if (command === 'configuration' && sub === 'approve') return { action: 'configuration.approve', label: 'approve a configuration change' };
  if (EPIC_COMMANDS.has(command) && (sub === 'approve' || (['requirements', 'planning'].includes(sub) && verb === 'approve'))) return { action: 'epic.approve', label: 'approve an Epic phase' };
  if (EPIC_COMMANDS.has(command) && sub === 'review' && ['approve', 'reject'].includes(verb)) return { action: `epic.review-${verb}`, label: `${verb} an Epic Story draft` };
  if (EPIC_COMMANDS.has(command) && sub === 'complete') return { action: 'epic.complete', label: 'complete an Epic' };
  if (command === 'goal' && sub === 'plan' && verb === 'approve') return { action: 'goal.plan-approve', label: 'approve a goal plan' };
  if (command === 'intent' && ['ratify', 'confirm'].includes(sub)) return { action: `intent.${sub}`, label: `${sub} an intent` };
  if (command === 'program' && sub === 'approve' && options.confirm !== undefined) return { action: 'program.approve', label: 'approve a program' };
  if (command === 'capabilities' && sub === 'lease') return { action: 'capability.lease', label: 'take a capability break-glass lease' };
  if (command === 'ledger' && sub === 'deployment-check' && HOST_POLICY_ASSERTIONS.some((flag) => options[flag] === true)) {
    return { action: 'ledger.host-policy', label: 'assert the host policy for a deployment check' };
  }
  if (command === 'agents' && sub === 'lock') return { action: 'agents.lock', label: 'lock the trusted agents' };
  if (command === 'repair' && sub === 'authorize') return { action: 'repair.authorize', label: 'authorize a repair' };
  return null;
}
