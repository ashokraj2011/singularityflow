/**
 * Deterministic recovery guidance for errors that predate the structured narration contract.
 *
 * A refusal is not a useful product outcome unless it says how to make progress. Rewriting every
 * historical throw site at once would create hundreds of subtly different recovery paths, so the
 * process boundary gives every otherwise-unstructured error one bounded plan. Explicit producer
 * guidance still wins; this module fills only the gap and never executes an action.
 */

import { commandDefinition } from './command-registry.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

const SAFE_COMMAND = /^(?:singularity-flow|sflow)(?:\s|$)/;
const SECRET_SHAPE = /(?:--(?:token|secret|password|credential|authorization|cookie|api[-_]?key|private[-_]?key|selection[-_]?receipt)\b|:\/\/[^\s/@:]+:[^\s/@]+@)/i;

function tokenizeCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    // Angle-bracket placeholders are documentation syntax and make the step non-copyable below.
    // Shell operators remain forbidden even inside a producer-supplied recovery string.
    if (';&|`$'.includes(character)) return null;
    current += character;
  }
  if (escaped || quote) return null;
  if (current) tokens.push(current);
  return tokens;
}

function quoteToken(value, platform) {
  return platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function safeCommand(value) {
  const command = typeof value === 'string' ? value.trim() : '';
  if (!command || command.length > 2_000 || /[\r\n\u0000-\u001f\u007f]/.test(command)
      || !SAFE_COMMAND.test(command) || SECRET_SHAPE.test(command)) return null;
  const tokens = tokenizeCommand(command);
  if (!tokens?.length || !['singularity-flow', 'sflow'].includes(tokens[0])) return null;
  const executable = tokens[0] === 'sflow' ? ['singularity-flow', ...tokens.slice(1)] : tokens;
  const top = executable[1];
  if (!top || (top.startsWith('-') && !['--help', '--version'].includes(top))) return null;
  if (!top.startsWith('-')) {
    try { commandDefinition(top); } catch { return null; }
  }
  const copyable = !executable.some((token) => /<[^>]+>/.test(token));
  return Object.freeze({
    command: executable.join(' '),
    argv: Object.freeze(executable.slice(1)),
    copyable,
    platformCommands: copyable ? Object.freeze({
      darwin: executable.map((token) => quoteToken(token, 'darwin')).join(' '),
      linux: executable.map((token) => quoteToken(token, 'linux')).join(' '),
      win32: `& ${executable.map((token) => quoteToken(token, 'win32')).join(' ')}`
    }) : null
  });
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
  const safe = command == null ? null : safeCommand(command);
  if (command != null && !safe) return null;
  return Object.freeze({
    id, label, command: safe?.command ?? null,
    argv: safe?.argv ?? null,
    copyable: safe?.copyable ?? false,
    platformCommands: safe?.platformCommands ?? null,
    kind, execution: 'user-reviewed'
  });
}

function optionValue(argv, name) {
  const index = argv.findIndex((value) => value === `--${name}`);
  const value = index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
  return /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : null;
}

const KNOWN = Object.freeze({
  AUTO_DISABLED: (argv) => [
    step('review-auto-policy',
      'Open VS Code → Singularity Flow → Configuration Center → Auto mode; enable the repository and one work type, then review capability limits.',
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
  ],
  AUTHORITY_ROUTE_REQUIRED: () => [
    step('review-onboarding', 'Choose a configured authority remote, or explicitly select an existing reviewed local authority.',
      'singularity-flow onboard --help', 'help')
  ],
  AUTHORITY_ROUTE_AMBIGUOUS: () => [
    step('choose-authority-remote', 'Review the configured remotes and rerun onboarding with one explicit remote name.',
      'singularity-flow onboard <LOCAL-PATH> --remote <NAME>')
  ],
  AUTHORITY_REBIND_REQUIRED: () => [
    step('review-rebind', 'Use the reviewed configuration-authority process; onboarding cannot replace an existing binding.',
      'singularity-flow explain fast-onboarding', 'configuration')
  ],
  AUTHORITY_CONFLICT: () => [
    step('inspect-authority-conflict', 'Inspect the bound authority and repository state before deciding whether to restore or rebind it.',
      'singularity-flow doctor --json')
  ],
  AUTHORITY_NOT_CONFIGURED: () => [
    step('inspect-authority', 'Verify whether the selected route publishes reviewed configuration or a verified state projection.',
      'singularity-flow workspace doctor --network --json')
  ],
  AUTHORITY_PIN_MISSING: () => [
    step('attach-authority', 'Attach the checkout before attempting to refresh its authority pin.',
      'singularity-flow onboard <LOCAL-PATH>')
  ],
  AUTHORITY_PIN_INVALID: () => [
    step('diagnose-pin', 'Diagnose the attachment record; do not hand-edit its descriptor or receipt.',
      'singularity-flow doctor --json')
  ],
  BOOTSTRAP_REMOTE_CONTAINS_CREDENTIAL: () => [
    step('remove-url-credential', 'Configure an approved Git credential helper and replace the remote with a credential-free URL.',
      'singularity-flow workspace doctor --network --json')
  ],
  FOS_BOOTSTRAP_UNSUPPORTED: () => [
    step('use-reviewed-configuration', 'Create or publish configuration through the existing reviewed configuration-authority workflow.',
      'singularity-flow explain configuration', 'configuration')
  ],
  FOS_FEATURE_DISABLED: () => [
    step('review-feature', 'Review the feature prerequisites and enable only that feature through approved repository policy.',
      'singularity-flow explain fast-onboarding', 'configuration')
  ],
  FOS_CACHE_PATH_INVALID: () => [
    step('diagnose-cache-path', 'Inspect the repository and derived-cache boundary; no unsafe cleanup was attempted.',
      'singularity-flow doctor --json')
  ],
  OBJECT_SERVICE_UNAVAILABLE: () => [
    step('continue-without-object-service', 'Retry the read through the ordinary uncached Git path and inspect Git if it also fails.',
      'singularity-flow doctor --git-speed --json')
  ],
  WORK_PRESERVATION_FAILED: () => [
    step('inspect-story-worktrees', 'Keep the recovery checkpoint and inspect the available workspace and Story worktrees.',
      'singularity-flow workspace list --json')
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
  return steps.filter(Boolean).filter((entry) => {
    const identity = `${entry.label}\u0000${entry.command ?? ''}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, 3);
}

export function refusalRemediationPlan(error, argv = []) {
  const code = String(error?.code ?? 'SINGULARITY_FLOW_ERROR');
  const explicit = explicitCommands(error).map((command, index) => step(
    `producer-${index + 1}`, 'Follow the recovery action supplied by the refusing operation.', command.command,
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
      message: redactDiagnosticText(error?.message ?? String(error)),
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
