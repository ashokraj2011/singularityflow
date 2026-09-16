/**
 * Deterministic recovery guidance for errors that predate the structured narration contract.
 *
 * A refusal is not a useful product outcome unless it says how to make progress. Rewriting every
 * historical throw site at once would create hundreds of subtly different recovery paths, so the
 * process boundary gives every otherwise-unstructured error one bounded plan. Explicit producer
 * guidance still wins; this module fills only the gap and never executes an action.
 */

import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import {
  safeCommandGuidance, validateSafeSflowCommand
} from './safe-command-guidance.mjs';

const safeCommand = validateSafeSflowCommand;

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
  const guidance = command == null ? null : safeCommandGuidance(command);
  if (command != null && !guidance) return null;
  return Object.freeze({
    id, label, command: guidance?.command ?? null,
    skill: guidance?.skill ?? null,
    copilotCommand: guidance?.copilotCommand ?? null,
    argv: guidance?.argv ?? null,
    copyable: guidance?.copyable ?? false,
    platformCommands: guidance?.platformCommands ?? null,
    kind, execution: 'user-reviewed'
  });
}

function optionValue(argv, name) {
  const index = argv.findIndex((value) => value === `--${name}`);
  const value = index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
  return /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : null;
}

function lowerKebab(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate) ? candidate : null;
}

function artifactAuthoringPhase(argv, error) {
  const details = error?.details ?? {};
  for (const candidate of [details.phase, details.phaseId, details.currentPhase]) {
    const phase = lowerKebab(candidate);
    if (phase) return phase;
  }

  const selected = optionValue(argv, 'phase');
  if (selected) return selected;
  if (argv[0] === 'phase' && ['publish', 'approve', 'submit'].includes(argv[1])) {
    return lowerKebab(argv[2]);
  }
  if (argv[0] === 'initiative' && argv[1] === 'phase'
      && ['publish', 'approve', 'submit'].includes(argv[2])) {
    return lowerKebab(argv[3]);
  }
  if (['approve', 'submit'].includes(argv[0])) return lowerKebab(argv[1]);
  return null;
}

function artifactAuthoringSubject(argv, error) {
  const phase = artifactAuthoringPhase(argv, error);
  if (!phase) return null;
  const initiative = error?.details?.subjectKind === 'initiative' || argv[0] === 'initiative';
  return { phase, kind: initiative ? 'initiative' : 'story' };
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
  ],
  AGENT_PHASE_UNKNOWN: () => [
    step('preview-configuration-refresh',
      'Open VS Code → Workspaces → Fast onboarding & Git → Safely reinitialize capabilities & workspaces, preview the selected workspace, then use Repair missing or outdated agents when offered.',
      'singularity-flow workspace refresh-configuration --dry-run', 'configuration'),
    step('preview-repository-factory-reset',
      'If this repository\'s old Singularity Flow data may be discarded, preview the guarded factory reset and review its exact remove and preserve scope before confirming anything.',
      'singularity-flow factory-reset --dry-run --json', 'remediation'),
    step('verify-agent-phase-contract',
      'After applying one reviewed repair, verify the current workflow and governed-agent contract before retrying the original command.',
      'singularity-flow init --check --json')
  ],
  MCP_AGENT_TOOLS_MISMATCH: () => [
    step('preview-packaged-configuration-repair',
      'Preview the approved configuration refresh; exact historical packaged agents can be upgraded while repository customizations remain preserved.',
      'singularity-flow workspace refresh-configuration --dry-run --json', 'configuration'),
    step('verify-capability-authority',
      'Verify the capability authority, proposal branches, and state projection before retrying review.',
      'singularity-flow capability fsck --json', 'diagnostic')
  ],
  CAPABILITY_PROPOSAL_PACKAGED_COMPATIBILITY_REQUIRED: () => [
    step('inspect-capability-proposal',
      'Keep the proposal and approved authority unchanged while reviewing the exact packaged compatibility repair named by the refusal.',
      'singularity-flow capability proposals --json', 'remediation')
  ],
  CONFIGURATION_BOOTSTRAP_INVALID: () => [
    step('diagnose-configuration-bootstrap',
      'Inspect the source repository configuration; no invalid sflow/config branch was published.',
      'singularity-flow capability fsck --json', 'diagnostic')
  ],
  CONFIGURATION_BOOTSTRAP_CAPABILITY_REVIEW_REQUIRED: () => [
    step('map-with-review',
      'Preserve the imported organisation map, establish its authority, and add the new capability through a separate reviewed proposal.',
      'singularity-flow capability map <CAPABILITY-ID> --lead <LEAD-URL> --json', 'remediation')
  ],
  CODE_DELIVERY_TEST_COMMAND_REQUIRED: () => [
    step('review-approved-test-policy',
      'Do not add a test wrapper or edit protected workflow files in the active Story. Review the approved workflow test policy and use Configuration Center outside the Story if a native runner is not yet supported.',
      'singularity-flow workflow validate --json', 'configuration'),
    step('review-workflow-authoring',
      'Review how governed workflow configuration is proposed for future Stories without changing a pinned Story snapshot.',
      'singularity-flow explain workflow-authoring', 'help')
  ],
  CHANGE_SET_POLICY_VIOLATION: (_argv, error) => error?.details?.violationKind === 'protected-process-path'
    ? [
        step('restore-protected-story-paths',
          'Restore every listed protected path to the generation baseline while preserving application and test changes; do not hand-edit the pinned Story snapshot.',
          'singularity-flow explain workflow-authoring', 'remediation'),
        step('validate-approved-configuration',
          'If the process configuration genuinely needs to change, make that a separately reviewed configuration proposal outside the active Story.',
          'singularity-flow configuration validate --json', 'configuration')
      ]
    : [],
  ARTIFACT_AUTHORING_INCOMPLETE: (argv, error) => {
    const subject = artifactAuthoringSubject(argv, error);
    if (!subject) return [];
    const command = subject.kind === 'initiative'
      ? `singularity-flow initiative phase draft-check ${subject.phase} --json`
      : `singularity-flow phase draft-check ${subject.phase} --json`;
    return [
      step('inspect-authored-draft',
        `Inspect every reviewable '${subject.phase}' draft artifact and its exact authoring findings without changing repository or lifecycle state.`,
        command, 'diagnostic'),
      step('correct-authored-draft',
        'Have the current author correct every reported finding in the draft, then rerun the same read-only draft check. Do not delete markers blindly, invent missing facts, invoke another model, publish, submit, or approve from recovery guidance.',
        null, 'remediation')
    ];
  },
  CLARIFICATION_MODE_OFF: (_argv, error) => {
    const phase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error?.details?.phase ?? '')
      ? error.details.phase : null;
    return [step(
      'continue-phase-without-clarification',
      'Skip clarification questions and recording; continue the phase from approved sources and governed repository evidence.',
      phase ? `singularity-flow prepare ${phase}` : null,
      'remediation'
    )];
  }
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
  const known = KNOWN[code]?.(argv, error) ?? [];
  const authoringIncomplete = code === 'ARTIFACT_AUTHORING_INCOMPLETE' && known.length > 0;
  const nonDuplicateExplicit = authoringIncomplete
    ? explicit.filter((entry) => !known.some((knownEntry) => knownEntry?.command === entry?.command))
    : explicit;
  const ordered = authoringIncomplete
    ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
    : [...nonDuplicateExplicit, ...known, ...genericSteps(argv)];
  const steps = deduplicate(ordered);
  const retryLabel = code === 'CLARIFICATION_MODE_OFF'
    ? 'Do not retry clarification recording while the pinned mode is off; continue the phase instead.'
    : authoringIncomplete
      ? 'Retry the original command only after the author has corrected every finding and the same read-only draft check reports ready.'
      : 'Retry the original command only after the blocking condition is resolved.';
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked',
    code,
    steps: Object.freeze(steps),
    retry: Object.freeze({
      label: retryLabel,
      automatic: false
    })
  });
}

export function refusalEnvelope(error, argv = []) {
  const diagnosticAction = error?.details?.diagnosticAction;
  const diagnostic = diagnosticAction?.command ? safeCommandGuidance(diagnosticAction) : null;
  const remoteFailure = error?.details?.remoteFailure;
  return {
    schemaVersion: 1, // schema-transient: process-boundary result, never persisted
    resultType: 'sflow-refusal-plan',
    status: 'failed',
    error: {
      code: error?.code ?? 'SINGULARITY_FLOW_ERROR',
      message: redactDiagnosticText(error?.message ?? String(error)),
      ...(diagnostic ? { diagnosticAction: {
        command: diagnostic.command,
        skill: diagnostic.skill,
        copilotCommand: diagnostic.copilotCommand
      } } : {}),
      ...(remoteFailure ? { remoteFailure } : {})
    },
    remediationPlan: refusalRemediationPlan(error, argv)
  };
}

export function renderRefusalPlan(plan) {
  const lines = ['Recovery plan:'];
  for (const [index, entry] of plan.steps.entries()) {
    lines.push(`  ${index + 1}. ${entry.label}`);
    if (entry.command) {
      lines.push(`     Shell: ${entry.command}`);
      lines.push(`     Copilot: ${entry.copilotCommand}`);
    }
  }
  lines.push(`  Then: ${plan.retry.label}`);
  return lines.join('\n');
}
