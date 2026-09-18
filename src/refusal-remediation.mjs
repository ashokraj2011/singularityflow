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
    details?.diagnosticAction,
    typeof details?.nextAction === 'string' ? { command: details.nextAction } : details?.nextAction,
    details?.recoveryCommand,
    details?.retry,
    ...(Array.isArray(details?.recoveryCommands) ? details.recoveryCommands : [])
  ];
  return values.map((value) => {
    if (typeof value === 'string') return safeCommandGuidance({ command: value });
    if (!value?.command) return null;
    return safeCommandGuidance(value);
  }).filter(Boolean);
}

function step(id, label, command = null, kind = 'diagnostic', skill = null) {
  const guidance = command == null ? null : safeCommandGuidance({ command, ...(skill ? { skill } : {}) });
  if (command != null && !guidance) return null;
  return Object.freeze({
    id, label, command: guidance?.command ?? null,
    executable: guidance?.executable ?? null,
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

function safeWorkId(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(candidate) ? candidate : null;
}

function phaseOperation(argv) {
  if (argv[0] === 'phase') return argv[1] ?? 'phase';
  if (argv[0] === 'initiative' && argv[1] === 'phase') return argv[2] ?? 'phase';
  return argv[0] ?? null;
}

function artifactAuthoringPhase(argv, error) {
  const details = error?.details ?? {};
  for (const candidate of [details.phase, details.phaseId, details.currentPhase]) {
    const phase = lowerKebab(candidate);
    if (phase) return phase;
  }

  const selected = optionValue(argv, 'phase');
  if (selected) return selected;
  if (['prepare', 'inputs', 'submit', 'approve', 'reject'].includes(argv[0])) {
    return lowerKebab(argv[1]);
  }
  if (argv[0] === 'clarification' && ['status', 'record'].includes(argv[1])) {
    return lowerKebab(argv[2]);
  }
  if (argv[0] === 'converge') return 'convergence';
  if (argv[0] === 'phase' && [
    'begin', 'rollover', 'draft-check', 'show', 'publish', 'approve', 'submit'
  ].includes(argv[1])) {
    return lowerKebab(argv[2]);
  }
  if (argv[0] === 'initiative' && argv[1] === 'phase'
      && ['publish', 'approve', 'submit'].includes(argv[2])) {
    return lowerKebab(argv[3]);
  }
  if (['approve', 'submit'].includes(argv[0])) return lowerKebab(argv[1]);
  return null;
}

function phaseRemediationContext(argv, error) {
  if (argv[0] === 'initiative' || error?.details?.subjectKind === 'initiative') return null;
  const phaseId = artifactAuthoringPhase(argv, error);
  if (!phaseId) return null;
  const details = error?.details ?? {};
  const workId = safeWorkId(details.workId)
    ?? safeWorkId(optionValueRaw(argv, 'work-id'));
  const operation = phaseOperation(argv);
  const approvalTurn = operation === 'approve';
  const recoveryCommand = `singularity-flow recover${workId ? ` ${workId}` : ''} --phase ${phaseId} --json`;
  const retry = !approvalTurn && details?.retry?.command
    ? safeCommandGuidance({
        command: details.retry.command,
        ...(details.retry.skill ? { skill: details.retry.skill } : {})
      })
    : null;
  return Object.freeze({
    scope: 'phase',
    workId,
    phaseId,
    operation,
    strategy: approvalTurn ? 'new-turn-repair' : 'repair-current-phase',
    automaticAdvance: false,
    historyRewrite: false,
    recoveryCommand,
    retryCommand: retry?.command ?? null,
    retrySkill: retry?.skill ?? null,
    turn: approvalTurn ? 'new-turn' : 'current-turn'
  });
}

function optionValueRaw(argv, name) {
  const index = argv.findIndex((value) => value === `--${name}`);
  return index >= 0 ? String(argv[index + 1] ?? '').trim() : '';
}

function phaseContainmentSteps(context) {
  if (!context) return [];
  const recover = step(
    'inspect-current-phase',
    `Inspect and repair only phase '${context.phaseId}'; prior publications and authored work remain preserved.`,
    context.recoveryCommand,
    'remediation',
    '/sf-recover'
  );
  const show = step(
    'inspect-current-phase-evidence',
    `Review the bounded '${context.phaseId}' evidence before changing or retrying it.`,
    `singularity-flow phase show ${context.phaseId} --json`,
    'diagnostic'
  );
  if (context.turn === 'new-turn') {
    return [
      recover ? Object.freeze({ ...recover, turn: 'new-turn' }) : null,
      step(
        'leave-approval-turn',
        'End this approval-only turn. If submitted evidence must change, use /sf-reject in a new turn to choose an allowed repair target and provide the human reason; author, submit, and approve again from fresh evidence.',
        null,
        'remediation'
      ),
      show ? Object.freeze({ ...show, turn: 'new-turn' }) : null
    ].filter(Boolean);
  }
  return [recover, show].filter(Boolean);
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
  GIT_ENTERPRISE_CONFIG_UNAVAILABLE: () => [
    step('diagnose-git-configuration',
      'Inspect the local Git configuration snapshot. Singularity Flow did not probe the remote or discard the configured credential helper.',
      'singularity-flow workspace doctor --network --json'),
    step('repair-approved-git',
      'Repair the approved system or global Git configuration or its helper outside Singularity Flow; do not put credentials in a repository URL or disable TLS.',
      null, 'remediation')
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
    // Approval is an evidence-only turn. Once the submitted bytes are incomplete or stale, the
    // reviewer must leave that turn and use the governed rejection/repair path; suggesting an edit
    // and an approval retry here would make the approval surface violate its own boundary.
    if (phaseOperation(argv) === 'approve') return [];
    const subject = artifactAuthoringSubject(argv, error);
    if (!subject) return [];
    const command = subject.kind === 'initiative'
      ? `singularity-flow initiative phase draft-check ${subject.phase} --json`
      : `singularity-flow phase draft-check ${subject.phase} --json`;
    const correctionSkill = subject.kind === 'story' ? error?.details?.retry?.skill ?? null : null;
    return [
      step('inspect-authored-draft',
        `Inspect every reviewable '${subject.phase}' draft artifact and its exact authoring findings without changing repository or lifecycle state.`,
        command, 'diagnostic', correctionSkill),
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
  const phaseContext = phaseRemediationContext(argv, error);
  const phaseSteps = phaseContainmentSteps(phaseContext);
  let explicit = explicitCommands(error).map((command, index) => step(
    `producer-${index + 1}`, 'Follow the recovery action supplied by the refusing operation.', command.command,
    index === 0 ? 'remediation' : 'diagnostic', command.skill
  ));
  if (phaseContext?.turn === 'new-turn') {
    // The approval surface is evidence-only. A producer emitted by an older refusal may still name
    // `approve` as its retry, but following it would contradict the new-turn boundary and can loop
    // forever against stale reviewed bytes. Keep the phase containment plan authoritative and let a
    // later authoring/submission turn mint the next approval action from fresh state.
    explicit = explicit.filter((entry) => !(
      entry?.argv?.[0] === 'approve'
      || (entry?.argv?.[0] === 'phase' && entry?.argv?.[1] === 'approve')
    ));
  }
  const known = KNOWN[code]?.(argv, error) ?? [];
  const authoringIncomplete = code === 'ARTIFACT_AUTHORING_INCOMPLETE' && known.length > 0;
  const nonDuplicateExplicit = authoringIncomplete
    ? explicit.filter((entry) => !known.some((knownEntry) => knownEntry?.command === entry?.command))
    : explicit;
  // Phase failures stay inside the phase repair boundary. Exact producer guidance still wins, but
  // broad command help/doctor/recommend fallbacks are reserved for errors that carry no safe phase
  // identity. This makes future uncoded phase refusals recoverable without adding another code-keyed
  // entry here, and keeps approval repair outside the approval-only turn.
  const ordered = phaseContext
    ? phaseContext.turn === 'new-turn'
      // Reserve the bounded recovery/new-turn steps before the global three-step presentation cap;
      // arbitrary producer diagnostics must never displace the instruction that ends approval.
      ? [...phaseSteps, ...known, ...nonDuplicateExplicit]
      : authoringIncomplete
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
        : [...nonDuplicateExplicit, ...known, ...phaseSteps]
    : authoringIncomplete
      ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
      : [...nonDuplicateExplicit, ...known, ...genericSteps(argv)];
  const steps = deduplicate(ordered);
  const retryLabel = phaseContext?.turn === 'new-turn'
    ? 'Do not retry approval in this turn. Repair and resubmit through governed phase actions, then begin a fresh approval turn.'
    : code === 'CLARIFICATION_MODE_OFF'
    ? 'Do not retry clarification recording while the pinned mode is off; continue the phase instead.'
    : authoringIncomplete
      ? 'Retry the original command only after the author has corrected every finding and the same read-only draft check reports ready.'
      : 'Retry the original command only after the blocking condition is resolved.';
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked',
    code,
    ...(phaseContext ? { context: phaseContext } : {}),
    steps: Object.freeze(steps),
    retry: Object.freeze({
      label: retryLabel,
      automatic: false,
      ...(phaseContext ? {
        turn: phaseContext.turn,
        command: phaseContext.retryCommand,
        skill: phaseContext.retrySkill
      } : {})
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
        executable: diagnostic.executable,
        argv: diagnostic.argv,
        skill: diagnostic.skill,
        copilotCommand: diagnostic.copilotCommand,
        copyable: diagnostic.copyable,
        platformCommands: diagnostic.platformCommands
      } } : {}),
      ...(remoteFailure ? { remoteFailure } : {})
    },
    remediationPlan: refusalRemediationPlan(error, argv)
  };
}

export function renderRefusalPlan(plan) {
  const lines = ['Recovery plan:'];
  if (plan.context?.scope === 'phase') {
    lines.push(
      `  Scope: phase ${plan.context.phaseId} — repair in place; no automatic advance or history rewrite.`
    );
    if (plan.context.turn === 'new-turn') {
      lines.push('  Turn boundary: end the current approval turn; remediation starts in a new turn.');
    }
  }
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
