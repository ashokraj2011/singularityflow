/**
 * Deterministic recovery guidance for errors that predate the structured narration contract.
 *
 * A refusal is not a useful product outcome unless it says how to make progress. Rewriting every
 * historical throw site at once would create hundreds of subtly different recovery paths, so the
 * process boundary gives every otherwise-unstructured error one bounded plan. Explicit producer
 * guidance still wins; this module fills only the gap and never executes an action.
 */

const SAFE_COMMAND = /^(?:singularity-flow|sflow)(?:\s|$)/;
const SECRET_SHAPE = /(?:--(?:token|secret|password|credential|authorization|cookie|api[-_]?key|private[-_]?key|selection[-_]?receipt)\b|:\/\/[^\s/@:]+:[^\s/@]+@)/i;

function safeCommand(value) {
  const command = typeof value === 'string' ? value.trim() : '';
  if (!command || command.length > 2_000 || /[\r\n\u0000-\u001f\u007f]/.test(command)
      || !SAFE_COMMAND.test(command) || SECRET_SHAPE.test(command)) return null;
  return command;
}

function explicitCommands(error) {
  const details = error?.details ?? {};
  const values = [
    details?.diagnosticAction?.command,
    typeof details?.nextAction === 'string' ? details.nextAction : details?.nextAction?.command,
    details?.recoveryCommand,
    ...(Array.isArray(details?.recoveryCommands) ? details.recoveryCommands : [])
  ];
  return values.map(safeCommand).filter(Boolean);
}

function step(id, label, command = null, kind = 'diagnostic') {
  return Object.freeze({ id, label, command, kind, execution: 'user-reviewed' });
}

function optionValue(argv, name) {
  const index = argv.findIndex((value) => value === `--${name}`);
  const value = index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
  return /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : null;
}

const KNOWN = Object.freeze({
  AUTO_DISABLED: (argv) => [
    step('review-auto-policy',
      'Open VS Code → Singularity Flow → Capabilities → Auto policy; repository and work-type Auto must also be enabled.',
      'singularity-flow explain auto-mode', 'configuration'),
    step('inspect-repository-auto', 'Inspect the approved repository Auto policy.',
      'singularity-flow configuration explain --pointer /auto --json'),
    optionValue(argv, 'capability')
      ? step('inspect-capability-policy', 'Inspect the selected capability policy before changing it.',
        `singularity-flow capability show ${optionValue(argv, 'capability')} --verbose --json`)
      : step('inspect-capability-policy', 'Inspect the capability map and choose which policy to change.',
        'singularity-flow capability tree --json')
  ],
  AUTO_WORK_TYPE_INELIGIBLE: () => [
    step('inspect-start-workflows', 'List work types and review which one is eligible for new work.',
      'singularity-flow workflow list --for-start'),
    step('review-auto-policy', 'Review how repository, work-type, and capability Auto policy fold together.',
      'singularity-flow explain auto-mode', 'configuration')
  ],
  UNKNOWN_COMMAND: () => [
    step('list-commands', 'Find the supported command and its exact spelling.',
      'singularity-flow --help', 'help'),
    step('guided-start', 'Use the guided entry point if the intended command is unclear.',
      'singularity-flow quickstart', 'help')
  ],
  SINGULARITY_FLOW_UNINITIALIZED_REPOSITORY: () => [
    step('resolve-workspace', 'Verify which workspace repository is selected.',
      'singularity-flow workspace current --json'),
    step('inspect-authority', 'Check for approved remote configuration before initializing anything.',
      'singularity-flow workspace doctor --json')
  ],
  SINGULARITY_FLOW_AUTHORITY_UNAVAILABLE: () => [
    step('diagnose-network', 'Check Git access, proxy, certificates, and unfinished workspace setup.',
      'singularity-flow workspace doctor --network --json')
  ]
});

function genericSteps(argv) {
  const command = String(argv?.[0] ?? '').trim();
  const steps = [];
  if (/^[a-z0-9-]+$/.test(command) && !['help', 'about'].includes(command)) {
    steps.push(step('command-help', `Review the supported ${command} forms before retrying.`,
      `singularity-flow ${command} --help`, 'help'));
  }
  steps.push(step('diagnose-repository', 'Run read-only diagnostics for repository, policy, and recovery state.',
    'singularity-flow doctor --json'));
  if (!['recommend', 'home', 'nextsteps'].includes(command)) {
    steps.push(step('recommended-next', 'Ask the deterministic planner for the next currently legal action.',
      'singularity-flow recommend --json'));
  }
  return steps;
}

function deduplicate(steps) {
  const seen = new Set();
  return steps.filter((entry) => {
    const identity = `${entry.label}\u0000${entry.command ?? ''}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 3);
}

export function refusalRemediationPlan(error, argv = []) {
  const code = String(error?.code ?? 'SINGULARITY_FLOW_ERROR');
  const explicit = explicitCommands(error).map((command, index) => step(
    `producer-${index + 1}`, 'Follow the recovery action supplied by the refusing operation.', command,
    index === 0 ? 'remediation' : 'diagnostic'
  ));
  const known = KNOWN[code]?.(argv) ?? [];
  const steps = deduplicate([...explicit, ...known, ...genericSteps(argv)]);
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked',
    code,
    steps: Object.freeze(steps),
    retry: Object.freeze({
      label: 'Retry the original command only after the blocking condition is resolved.',
      automatic: false
    })
  });
}

export function refusalEnvelope(error, argv = []) {
  const diagnosticAction = error?.details?.diagnosticAction;
  const remoteFailure = error?.details?.remoteFailure;
  return {
    schemaVersion: 1, // schema-transient: process-boundary result, never persisted
    resultType: 'sflow-refusal-plan',
    status: 'failed',
    error: {
      code: error?.code ?? 'SINGULARITY_FLOW_ERROR',
      message: error?.message ?? String(error),
      ...(diagnosticAction?.command ? { diagnosticAction: {
        command: diagnosticAction.command,
        skill: diagnosticAction.skill ?? null
      } } : {}),
      ...(remoteFailure ? { remoteFailure } : {})
    },
    remediationPlan: refusalRemediationPlan(error, argv)
  };
}

export function renderRefusalPlan(plan) {
  const lines = ['Recovery plan:'];
  for (const [index, entry] of plan.steps.entries()) {
    lines.push(`  ${index + 1}. ${entry.label}${entry.command ? ` — ${entry.command}` : ''}`);
  }
  lines.push(`  Then: ${plan.retry.label}`);
  return lines.join('\n');
}
