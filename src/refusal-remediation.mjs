/**
 * Deterministic recovery guidance for errors that predate the structured narration contract.
 *
 * A refusal is not a useful product outcome unless it says how to make progress. Rewriting every
 * historical throw site at once would create hundreds of subtly different recovery paths, so the
 * process boundary gives every otherwise-unstructured error one bounded plan. Explicit producer
 * guidance still wins; this module fills only the gap and never executes an action.
 */

import { localGitHookFailure, redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { requiredTestExecutionForRefusal } from './test-execution-diagnostics.mjs';
import {
  safeCommandGuidance, validateSafeSflowCommand
} from './safe-command-guidance.mjs';
import { projectGateRefusal } from './evidence/gate-refusal.mjs';

const safeCommand = validateSafeSflowCommand;

function explicitCommands(error) {
  const details = error?.details ?? {};
  const values = [
    details?.diagnosticAction,
    typeof details?.nextAction === 'string' ? { command: details.nextAction } : details?.nextAction,
    details?.recoveryCommand,
    details?.retry,
    ...(Array.isArray(details?.recoveryCommands) ? details.recoveryCommands : []),
    ...(Array.isArray(details?.actions) ? details.actions : []),
    // A gate refusal's own actions, so the recovery plan every surface renders is the gate's
    // [E2G-024, criterion 16].
    ...(Array.isArray(details?.gate?.actions) ? details.gate.actions.map((entry) => entry?.command) : [])
  ];
  const seen = new Set();
  return values.map((value) => {
    if (typeof value === 'string') return safeCommandGuidance({ command: value });
    if (!value?.command) return null;
    const guidance = safeCommandGuidance(value);
    const label = value.label ?? value.detail;
    return guidance ? { ...guidance, ...(typeof label === 'string' && label.trim()
      ? { label: redactDiagnosticText(label).slice(0, 2000) } : {}) } : null;
  }).filter((guidance) => guidance && !seen.has(guidance.command) && seen.add(guidance.command));
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

function explicitInstructions(error) {
  // Some real repairs require ownership/authority review rather than an executable command.
  // Keep those instructions; diagnostics alone must not masquerade as the way out of the block.
  return (Array.isArray(error?.details?.actions) ? error.details.actions : []).slice(0, 20)
    .filter(entry => entry && !entry.command && typeof (entry.label ?? entry.detail) === 'string')
    .map((entry, index) => step(`producer-review-${index + 1}`,
      redactDiagnosticText(entry.label ?? entry.detail).slice(0, 2000), null, 'remediation'));
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
  // A fast-path verb such as `converge` names no step: its profile routes a step of any name.
  if (argv[0] === 'phase' && [
    'begin', 'rollover', 'draft-check', 'prepublish', 'show', 'publish', 'approve', 'submit'
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
  // If inspection itself failed, sending the reader to the identical recover command is a loop,
  // not a repair. Diagnose its prerequisite without replaying the failed inspection.
  if (context.operation === 'recover') return [
    step('diagnose-recovery-prerequisite',
      'Recovery inspection could not complete. Inspect the reported repository or configuration prerequisite before retrying recovery.',
      'singularity-flow doctor --json', 'diagnostic'),
    step('repair-recovery-prerequisite',
      'Keep authored work and retained evidence. Have the responsible repository or configuration owner repair the reported prerequisite; do not repeat an unchanged recovery command or discard work.',
      null, 'remediation')
  ];
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

function requiredTestFailureSteps(argv, error) {
  const context = phaseRemediationContext(argv, error);
  const failure = requiredTestExecutionForRefusal(error)?.failure;
  return [
    step('recover-required-test',
      'Inspect the refused phase and its saved test evidence before changing or retrying it.',
      context?.recoveryCommand ?? 'singularity-flow recover --json',
      'diagnostic', '/sf-recover'),
    step('read-saved-test-log',
      'Read the saved error log for the exact failed execution; do not reconstruct a secret-bearing configured command.',
      'singularity-flow logs --level error --tail 20',
      'diagnostic', '/sf-logs'),
    step('repair-required-test',
      failure?.guidance ?? 'Repair the reported test failure or runtime condition before retrying. Do not repeat an unchanged failing run.',
      null, 'remediation')
  ];
}

function skillHostPrerequisiteSteps(error, context) {
  const skillId = lowerKebab(error?.details?.skillId);
  const workId = safeWorkId(error?.details?.workId);
  const phase = lowerKebab(error?.details?.phase);
  const diagnostic = skillId && workId && phase
    ? `singularity-flow skill doctor ${skillId} --story ${workId} --phase ${phase} --json`
    : 'singularity-flow skill --help';
  return [
    step('inspect-retained-skill-host',
      'Inspect the retained skill and missing host controls read-only; intact package bytes are not execution permission.',
      diagnostic, 'diagnostic', '/sf-skill'),
    step('provide-qualified-skill-host',
      'An approved isolated host with pre-effect enforcement, authenticated mediated confirmation and exact package delivery acknowledgement is required. No current Shell or Copilot command can install or enable those controls; keep the Story pin and authored work unchanged.',
      null, 'external-prerequisite'),
    ...(context?.turn === 'new-turn' ? [step('leave-skill-approval-turn',
      'End this approval-only turn without recording approval. Installing or qualifying a host is a separate operation; do not rewrite or reject intact Story evidence to bypass this gate.',
      null, 'remediation')] : [])
  ].filter(Boolean);
}

function artifactAuthoringSubject(argv, error) {
  const phase = artifactAuthoringPhase(argv, error);
  if (!phase) return null;
  const initiative = error?.details?.subjectKind === 'initiative' || argv[0] === 'initiative';
  return { phase, kind: initiative ? 'initiative' : 'story' };
}

const productAlignmentSteps = (label) => [
  step('inspect-product-builds', label, 'singularity-flow product status', 'diagnostic', '/sf-product'),
  step('align-product', 'Bring every surface to the installed build from the bytes this machine retains.',
    'singularity-flow product align', 'remediation', '/sf-product')
];

/**
 * Refusals an upgrade can reach. Each is guided to one exact next step; the contract in
 * src/upgrade-contract.mjs keeps this list and the version-sensitive codes identical.
 */
const UPGRADE_KNOWN = Object.freeze({
  SCHEMA_VERSION_FUTURE: () => [
    ...productAlignmentSteps('A newer Singularity Flow build wrote this record. Check which build each surface runs.'),
    // Alignment only reproduces builds this machine retains. A teammate's newer release is not one.
    step('install-newer-release',
      'When every surface already runs the installed build, a newer release wrote this record: install that release with its own install wrapper. A repository whose approved singularity/product.yml requires it installs it automatically.',
      null, 'remediation')
  ],
  DOCS_MANIFEST_MISMATCH: () => productAlignmentSteps(
    'The installed help catalog does not match its package. Check which build each surface runs.'),
  SCHEMA_VERSION_ARCHIVED: () => [
    step('diagnose-archived-record',
      'The record predates every schema this build reads. Inspect it; read it with the archival reader of its release.',
      'singularity-flow doctor --json')
  ],
  WMB_EARLIER_BUILD_MODEL_INCOMPATIBLE: () => [
    step('rebuild-world-model',
      'The World Model was published by an earlier build this build cannot verify. Rebuild it; grounding continues without it until then.',
      'singularity-flow world-model build', 'remediation')
  ],
  WMB_MIGRATION_REQUIRED: () => [
    step('inspect-legacy-world-model', 'Inspect the legacy projection before replacing it.',
      'singularity-flow wm doctor --format registered-v4'),
    step('rebuild-registered-world-model', 'Build the registered model; it replaces the legacy projection without trusting it.',
      'singularity-flow wm build --format registered-v4', 'remediation')
  ],
  WMB_VIEW_VERSION_UNSUPPORTED: () => [
    step('review-registered-views', 'Compare the requested view version with the installed registered views.',
      'singularity-flow wm views')
  ],
  WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED: (argv, error) => {
    const workType = lowerKebab(error?.details?.workType) ?? '<WORK-TYPE>';
    return [
      step('validate-workflow', 'Review the work type\'s planned-claim contract. Existing Stories keep their pinned policy.',
        'singularity-flow workflow validate'),
      step('record-planned-claims', 'Record the reviewed planned-claim policy for new Stories.',
        `singularity-flow workflow edit ${workType} --planned-claims required --clause-phases <PHASES> --claim-owners <CODE=OWNER>`,
        'remediation')
    ];
  },
  CONVERGENCE_LEGACY_MIGRATION_REQUIRED: (argv, error) => [
    step('confirm-convergence-migration',
      'Review the v1 convergence record, then confirm its exact migration. The original bytes are archived, never overwritten.',
      typeof error?.details?.command === 'string' ? error.details.command : null, 'remediation')
  ],
  GENERATION_PUBLICATION_MIGRATION_REQUIRED: (argv) => [
    step('diagnose-generation-publication',
      'The generation has a legacy candidate but no immutable publication record. Inspect the Story before beginning another generation.',
      safeWorkId(argv[1]) ? `singularity-flow recover ${safeWorkId(argv[1])} --json` : 'singularity-flow doctor --json')
  ],
  LEGACY_PERSONA_MIGRATION_UNSAFE: () => [
    step('review-governed-agents',
      'Convert the repository-owned role to governed Agent Markdown and review its phase routing, then reinitialize.',
      'singularity-flow agents list --json')
  ],
  REPOSITORY_ONBOARDING_MIGRATION_SOURCE_MISSING: () => [
    step('inspect-onboarding-source', 'Migration needs current supported configuration or a verified state mirror. Inspect what the repository has.',
      'singularity-flow workspace doctor --json')
  ],
  PRODUCT_ALIGNMENT_INSTALL_ACTIVE: () => [
    step('inspect-product-builds', 'Another install owns the product surfaces. Let it finish, then check the surfaces again.',
      'singularity-flow product status', 'diagnostic', '/sf-product')
  ],
  PRODUCT_ALIGNMENT_INSTALL_RECOVERY_PENDING: () => [
    step('finish-install-recovery',
      'An interrupted install still owns the product surfaces. Run that installer once more to finish its recovery.',
      null, 'remediation')
  ],
  PRODUCT_ALIGNMENT_STEP_FAILED: () => productAlignmentSteps('A surface could not be aligned. Check which build each surface runs.'),
  PRODUCT_ALIGNMENT_VERIFICATION_FAILED: () => productAlignmentSteps(
    'A surface did not verify after alignment. Check which build each surface runs.'),
  STORY_ARCHIVED_BY_REBUILD: (argv, error) => {
    const plan = /^grb-[0-9a-f]{24}$/u.test(String(error?.details?.plan ?? '')) ? error.details.plan : null;
    return [
      step('start-new-story', 'A governance rebuild archived this Story, so it stays read-only. Start a new Story under the current governance.',
        'singularity-flow start <WORK-ID> --from-branch <BASE> --title <TITLE>', 'remediation'),
      ...(plan ? [step('preview-governance-restore',
        'Only if the rebuild itself was a mistake: preview restoring the governance it replaced, a reviewed change for the whole repository.',
        `singularity-flow governance restore --plan ${plan} --dry-run`)] : [])
    ];
  }
});

export const UPGRADE_GUIDED_CODES = Object.freeze(Object.keys(UPGRADE_KNOWN));

const KNOWN = Object.freeze({
  ...UPGRADE_KNOWN,
  RECOVERY_PHASE_UNKNOWN: () => [
    step('inspect-available-phases', 'Read the current Story and its actual phase IDs; do not guess a packaged phase name.',
      'singularity-flow status --json'),
    step('select-recovery-phase', 'Run recovery without --phase to inspect the active phase, or select an exact phase ID returned by status. No Story state needs rewriting.',
      null, 'remediation')
  ],
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
  // A confirmed import with conflicts nobody chose for: the preview lists each with its choices.
  WORKFLOW_IMPORT_CONFLICT: (argv) => {
    const at = argv.findIndex((value, index) => value === 'workflow' && argv[index + 1] === 'import');
    const file = at >= 0 && /^[A-Za-z0-9_./@+,%-]+$/.test(argv[at + 2] ?? '') ? argv[at + 2] : '<BUNDLE-FILE>';
    return [step('preview-import-choices',
      'Preview the import again. It lists each conflict with its choices: keep yours, replace yours with theirs, or import theirs under a new name.',
      `singularity-flow workflow import ${file} --dry-run`)];
  },
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
  CODE_DELIVERY_TEST_COMMAND_REQUIRED: (argv, error) => [
    step('inspect-current-phase',
      'Inspect the current phase and approved source scope before repairing a repository-owned test runner declaration.',
      `singularity-flow phase show${artifactAuthoringPhase(argv, error) ? ` ${artifactAuthoringPhase(argv, error)}` : ''} --json`, 'diagnostic', '/sf-phase-documents'),
    step('repair-in-scope-repository-runner',
      'If the affected module has an in-scope test script or runner declaration, repair it without changing the pinned workflow or suppressing tests. Otherwise, an authorized reviewer can preview story test-policy amend --reason TEXT after the configuration authority approves an explicit runner. The engine determines current-Story eligibility; refresh alone does not change its pin. A newer runtime may also add native support.',
      null, 'remediation'),
    step('recheck-structured-test-contract',
      'After a real repository/runtime repair or accepted command amendment, follow its returned preparation or fresh-validation route. This read-only check does not republish unchanged code. Do not retry publication against unchanged inputs.',
      `singularity-flow phase prepublish${artifactAuthoringPhase(argv, error) ? ` ${artifactAuthoringPhase(argv, error)}` : ''} --json`, 'diagnostic', '/sf-code')
  ],
  CODE_TEST_FAILED: (argv, error) => requiredTestFailureSteps(argv, error),
  TRP_PHASE_GATE_BLOCKED: (_argv, error) => {
    const workId = safeWorkId(error?.details?.workId);
    const phase = safeWorkId(error?.details?.phase);
    const operation = ['publish', 'submit', 'approve', 'downstream', 'replay'].includes(error?.details?.operation)
      ? error.details.operation : 'publish';
    return [step('inspect-exact-phase-risks',
      'Inspect the exact failed or unavailable observation. Repair the check, or let a delegated human review only an eligible current issue; no failed test becomes passed.',
      `singularity-flow story test-policy risks${workId ? ` --work-id ${workId}` : ''}${phase ? ` --phase ${phase}` : ''} --operation ${operation} --json`, 'diagnostic'),
    step('review-risk-boundaries',
      'Agreement authorization, decision durability, expiry and normal phase approval remain separate. Do not retry unchanged publication or hand-edit the Story policy.',
      'singularity-flow explain test-recovery', 'diagnostic')];
  },
  TRP_RISK_REVIEW_STALE: () => [step('refresh-risk-review',
    'Candidate, environment, observation or authority changed. Preview the exact risk again; old confirmation is not consent for the new candidate.',
    'singularity-flow story test-policy risks --json', 'diagnostic')],
  TRP_PUBLICATION_PENDING: () => [step('resume-exact-risk-publication',
    'Resume the existing pending Story publication. A local decision that has not reached its required remote cannot authorize advancement.',
    'singularity-flow recover --json', 'diagnostic', '/sf-recover')],
  TRP_RISK_ADAPTER_UNAVAILABLE: () => [step('inspect-risk-adapter-limit',
    'This case has no qualified risk adapter. Preserve work and inspect the supported runner-repair or reviewed command-amendment route; do not reinterpret a failed test as unavailable.',
    'singularity-flow explain test-recovery', 'diagnostic')],
  TRP_AUTHORITY_REQUIRED: () => [step('inspect-risk-authority',
    'Use the risk-review authority already pinned in the Story. A copied receipt, Git name, exhausted retry budget or ordinary phase approval cannot grant an exception.',
    'singularity-flow explain test-recovery', 'diagnostic')],
  CODE_TEST_SKIPPED: (argv, error) => requiredTestFailureSteps(argv, error),
  CODE_TEST_ZERO_DISCOVERED: (argv, error) => requiredTestFailureSteps(argv, error),
  CODE_TEST_TIMEOUT: (argv, error) => requiredTestFailureSteps(argv, error),
  QUALITY_COMMAND_SOURCE_MUTATION: (argv, error) => requiredTestFailureSteps(argv, error),
  CODE_TEST_RESULT_REQUIRED: (argv, error) => error?.details?.configurationDependency !== true
    ? requiredTestFailureSteps(argv, error) : [
    step('inspect-pinned-test-command',
      'Inspect the malformed configured test-command contract; do not print argv containing potential secrets.',
      'singularity-flow recover --json', 'diagnostic', '/sf-recover'),
    step('stop-unchanged-pinned-command',
      'The current Story command is sealed in its accepted policy. An authorized reviewer can preview story test-policy amend --reason TEXT to adopt a corrected structured test command from the original approved configuration authority. An active published phase retains its publication and requires fresh epoch validation and submission. Completed Stories, legacy string runners and unrelated policy changes are not supported. Do not edit the Story pin or retry unchanged policy.',
      'singularity-flow explain test-recovery', 'diagnostic')
  ],
  CODE_TEST_SUPPRESSED: (argv, error) => KNOWN.CODE_TEST_RESULT_REQUIRED(argv, error),
  TCA_AUTHORITY_ORIGIN_UNAVAILABLE: () => [
    step('inspect-test-command-review-origin',
      'Inspect the immutable accepted test-command review. In a new checkout, its original reviewer can explicitly restore local review origin; no Story policy or Git record is rewritten.',
      'singularity-flow story test-policy attest --json', 'diagnostic'),
    step('review-test-command-recovery-boundary',
      'Use the returned exact review digest in a direct terminal as the retained reviewer. Copied review JSON or a different Git identity cannot substitute for this confirmation.',
      'singularity-flow explain test-recovery', 'diagnostic')
  ],
  TCA_PUBLICATION_PENDING: () => [
    step('recover-test-command-publication',
      'Recover the exact pending Story publication before requesting another amendment. Do not create duplicate review records.',
      'singularity-flow recover --json', 'diagnostic', '/sf-recover')
  ],
  TCA_SOURCE_DRAFT_UNCOMMITTED: () => [
    step('review-source-before-command-amendment',
      'Review and commit only intended application source and tests, then preview the amendment again. Preserve unrelated edits and the phase artifact draft; do not reset, clean or blanket-stage the checkout.',
      'singularity-flow explain test-recovery', 'diagnostic')
  ],
  TCA_PRIOR_PUBLICATION_UNSUPPORTED: () => [
    step('preserve-published-test-evidence',
      'Only the current active code phase can adopt a command-only repair; completed Stories and other phases cannot be reopened by this operation. Preserve their publications and approvals, and use the normal reviewed request-changes route before previewing again. Never clear generations or historical evidence.',
      'singularity-flow explain test-recovery', 'diagnostic')
  ],
  TCA_EPOCH_VALIDATION_REQUIRED: (argv, error) => [
    step('inspect-amended-validation-epoch',
      'The old publication is preserved, but its test results do not validate the new command. Inspect the current phase and submit again to run fresh tests under the amended policy; do not republish unchanged code or reuse the old approval packet.',
      `singularity-flow phase show${artifactAuthoringPhase(argv, error) ? ` ${artifactAuthoringPhase(argv, error)}` : ''} --json`, 'diagnostic'),
    step('inspect-test-command-epoch-recovery',
      'Keep the exact new validation evidence and normal phase approval separate from the retained historical publication.',
      'singularity-flow explain test-recovery', 'diagnostic')
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
      : `singularity-flow phase prepublish ${subject.phase} --json`;
    const correctionSkill = subject.kind === 'story' ? error?.details?.retry?.skill ?? null : null;
    return [
      step('inspect-authored-draft',
        `Inspect '${subject.phase}' authoring and known phase-scoped recovery blockers without changing repository or lifecycle state.`,
        command, 'diagnostic', correctionSkill),
      step('correct-authored-draft',
        'Have the current author correct every reported finding in this phase, then rerun the same read-only prepublish check. Do not delete markers blindly, invent missing facts, invoke another model, publish, submit, or approve from recovery guidance.',
        null, 'remediation')
    ];
  },
  SEQUENCE_CONFIRMATION_REQUIRED: (_argv, error) => {
    const gate = /^[A-Za-z]+$/.test(error?.details?.gate ?? '') ? error.details.gate : null;
    return [step(
      'confirm-soft-gate',
      gate
        ? `To continue past this soft gate, run the same command again with --confirm-override continue:${gate} added; the override is recorded. Otherwise take the Story's next step instead.`
        : 'To continue past this soft gate, run the same command again in an interactive terminal and confirm; the override is recorded.',
      null,
      'remediation'
    )];
  },
  CLARIFICATION_MODE_OFF: (_argv, error) => {
    const phase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error?.details?.phase ?? '')
      ? error.details.phase : null;
    const label = 'Skip clarification questions and recording; continue the phase from approved sources and governed repository evidence.';
    const command = phase ? `singularity-flow prepare ${phase}` : null;
    // The refusal names the step's own drafting skill; the generic one for `prepare` is the fallback.
    const skill = /^\/sf-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error?.details?.remediation?.skill ?? '')
      ? error.details.remediation.skill : null;
    return [(skill && step('continue-phase-without-clarification', label, command, 'remediation', skill))
      ?? step('continue-phase-without-clarification', label, command, 'remediation')];
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
  const hookFailure = error?.details?.remoteFailure?.hook ?? localGitHookFailure({ stderr: error?.message });
  if (hookFailure) return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked', code,
    steps: Object.freeze([
      step('repair-local-push-hook',
        `The local pre-push hook${hookFailure.line ? ` at line ${hookFailure.line}` : ''}${hookFailure.tool ? ` cannot find '${redactDiagnosticText(hookFailure.tool)}'` : ' failed'}. Review its exact output and repair the command or failed check; do not change Git credentials for a local hook failure.`, null, 'remediation'),
      step('repair-hook-environment',
        hookFailure.runtimeFamily === 'node-package-manager'
          ? 'Make the required Node/package-manager runtime available to the IDE-launched Git environment. If a version manager works only in terminals, configure Husky user initialization for GUI launches and restart the IDE. Do not install tools or disable hooks automatically.'
          : 'Verify the named command and its runtime in the calling IDE or terminal environment. Correct a typo or restore the approved tool/PATH. Do not install tools or disable hooks automatically.', null, 'remediation'),
      step('preserve-and-retry-hook',
        'Inspect local changes and preserve hook-generated files and authored work. Retry the retained publication after repair; if remote publication may have completed, reconcile the exact pending operation instead of recreating the Story.',
        'singularity-flow doctor --json', 'diagnostic')
    ]),
    retry: Object.freeze({ label: 'Retry only after the hook, command or runtime has changed; preserve the existing Story and exact publication checkpoint.', automatic: false })
  });
  const skillHostBlocked = ['SKP_HOST_ENFORCEMENT_UNAVAILABLE', 'SKP_HOST_DELIVERY_UNCONFIRMED'].includes(code);
  const repositoryRunnerBlocked = code === 'CODE_DELIVERY_TEST_COMMAND_REQUIRED';
  const riskReviewBlocked = ['TRP_PHASE_GATE_BLOCKED', 'TRP_RISK_REVIEW_STALE',
    'TRP_PUBLICATION_PENDING', 'TRP_RISK_ADAPTER_UNAVAILABLE', 'TRP_AUTHORITY_REQUIRED'].includes(code);
  // A soft gate names its own way through; generic help and diagnostics only bury it.
  const softGateBlocked = code === 'SEQUENCE_CONFIRMATION_REQUIRED';
  const unknownRecoveryPhase = code === 'RECOVERY_PHASE_UNKNOWN';
  const pinnedTestPolicyBlocked = ['CODE_TEST_RESULT_REQUIRED', 'CODE_TEST_SUPPRESSED'].includes(code)
    && error?.details?.configurationDependency === true;
  const requiredTestBlocked = /^CODE_TEST_[A-Z0-9_]+$/u.test(code)
    || code === 'QUALITY_COMMAND_SOURCE_MUTATION';
  const requiredTestFailure = requiredTestExecutionForRefusal(error)?.failure;
  const rawPhaseContext = phaseRemediationContext(argv, error);
  const phaseContext = pinnedTestPolicyBlocked && rawPhaseContext
    ? Object.freeze({ ...rawPhaseContext, strategy: 'pinned-test-policy-prerequisite',
      retryCommand: null, retrySkill: null })
    : rawPhaseContext;
  const phaseSteps = phaseContainmentSteps(phaseContext);
  let explicit = explicitCommands(error).map((command, index) => step(
    `producer-${index + 1}`, command.label ?? 'Follow the recovery action supplied by the refusing operation.', command.command,
    index === 0 ? 'remediation' : 'diagnostic', command.skill
  ));
  // Reserve a place for the actual human repair, even when several diagnostics precede it.
  // The bounded presentation must not reduce "needs ownership review" to three read-only reads.
  const instructions = explicitInstructions(error);
  explicit = [...explicit.slice(0, 1), ...instructions.slice(0, 1), ...explicit.slice(1), ...instructions.slice(1)];
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
  const ordered = repositoryRunnerBlocked || pinnedTestPolicyBlocked || softGateBlocked || unknownRecoveryPhase ? known : skillHostBlocked ? skillHostPrerequisiteSteps(error, phaseContext) : phaseContext
    ? phaseContext.turn === 'new-turn'
      // Reserve the bounded recovery/new-turn steps before the global three-step presentation cap;
      // arbitrary producer diagnostics must never displace the instruction that ends approval.
      ? riskReviewBlocked
        ? [known[0], ...phaseSteps.filter(entry => entry.id === 'leave-approval-turn'), ...known.slice(1)]
        : [...phaseSteps, ...known, ...nonDuplicateExplicit]
      : requiredTestBlocked
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
      : authoringIncomplete
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
        : [...nonDuplicateExplicit, ...known, ...phaseSteps]
    : requiredTestBlocked
      ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
    : authoringIncomplete
      ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
      : [...nonDuplicateExplicit, ...known, ...genericSteps(argv)];
  const steps = deduplicate(ordered);
  const retryLabel = skillHostBlocked
    ? 'Do not retry generation, publication, submission or approval until the approved live host controls and exact delivery owner are implemented and qualified. Diagnostics cannot enable execution.'
    : repositoryRunnerBlocked
    ? 'Do not retry unchanged publication. An in-scope repository runner repair, updated runtime or reviewed command amendment must establish the structured contract; then follow the returned preparation or fresh-validation route.'
    : pinnedTestPolicyBlocked
    ? 'Do not retry unchanged publication. Preview a reviewed test-command amendment from corrected approved configuration for the active current code phase. Retain any existing publication and follow the returned preparation or fresh-validation route.'
    : riskReviewBlocked
    ? 'Inspect the exact risk or repair prerequisite. Only a delegated human can record an eligible exception; normal phase approval stays separate. End an approval-only turn before any review mutation, then re-evaluate in a fresh turn.'
    : phaseContext?.turn === 'new-turn'
    ? 'Do not retry approval in this turn. Repair and resubmit through governed phase actions, then begin a fresh approval turn.'
    : requiredTestBlocked && requiredTestFailure?.retryCondition === 'runtime-changed'
    ? 'Retry after the test runtime or dependency has actually changed; the same source may then be rechecked. Do not loop against an unchanged environment.'
    : requiredTestBlocked
    ? 'Retry only after the identified test, report, or source-mutation condition is repaired and the current phase is rechecked. Do not repeat an unchanged failing run.'
    : code === 'CLARIFICATION_MODE_OFF'
    ? 'Do not retry clarification recording while the pinned mode is off; continue the phase instead.'
    : softGateBlocked
    ? 'Run it again with the override added, or take the Story\'s next step; repeating it unchanged is refused the same way.'
    : authoringIncomplete
      ? 'Retry the original command only after the author has corrected every finding and the same read-only prepublish check reports ready.'
      : 'Retry the original command only after the blocking condition is resolved.';
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked',
    code,
    ...(phaseContext ? { context: skillHostBlocked
      ? Object.freeze({ ...phaseContext, strategy: 'external-host-prerequisite', recoveryCommand: null, retryCommand: null, retrySkill: null })
      : phaseContext } : {}),
    steps: Object.freeze(steps),
    retry: Object.freeze({
      label: retryLabel,
      automatic: false,
      ...(phaseContext ? {
        turn: phaseContext.turn,
        command: skillHostBlocked || repositoryRunnerBlocked || pinnedTestPolicyBlocked
          ? null : phaseContext.retryCommand,
        skill: skillHostBlocked || repositoryRunnerBlocked || pinnedTestPolicyBlocked
          ? null : phaseContext.retrySkill
      } : {})
    })
  });
}

/**
 * The structured facts a refusal carries that its code alone cannot convey — the gate findings,
 * test obligations, coverage gaps, paths and authorities behind it — projected for the process
 * boundary. A closed list, bounded and redacted: arbitrary detail fields never cross. JSON callers
 * (VS Code, Copilot, automation) used to receive only the code and message, so every surface
 * re-derived or lost what the engine already knew.
 */
export function refusalDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const text = (value) => (typeof value === 'string' && value.trim() ? redactDiagnosticText(value).slice(0, 2000) : null);
  const list = (value, project) => (Array.isArray(value) ? value.slice(0, 50).map(project).filter((entry) => entry != null) : []);
  const compact = (value) => {
    const kept = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
    return Object.keys(kept).length ? kept : null;
  };
  const projected = {};
  for (const key of ['workId', 'phase', 'operation']) if (text(details[key])) projected[key] = text(details[key]);
  const paths = list(details.paths, text);
  if (paths.length) projected.paths = paths;
  const authorities = list(details.authorities, text);
  if (authorities.length) projected.authorities = authorities;
  const findings = list(details.findings, (finding) => (finding && typeof finding === 'object' ? compact({
    code: text(finding.code), category: text(finding.category), phase: text(finding.phase),
    message: text(finding.details?.message ?? finding.message), recovery: text(finding.recovery?.command)
  }) : null));
  if (findings.length) projected.findings = findings;
  const obligations = list(details.evaluation?.issues, (issue) => (issue && typeof issue === 'object' ? compact({
    obligation: text(issue.obligationId), category: text(issue.category), severity: text(issue.severity),
    riskEligible: typeof issue.riskEligible === 'boolean' ? issue.riskEligible : null, repairRoute: text(issue.repairRoute)
  }) : null));
  if (obligations.length) projected.obligations = obligations;
  const gate = projectGateRefusal(details.gate);
  if (gate) projected.gate = gate;
  if (details.coverage && typeof details.coverage === 'object') {
    const coverage = compact(Object.fromEntries(['unimplemented', 'testPresenceOnly', 'unclaimedChangedPaths', 'withdrawnButClaimed']
      .map((key) => [key, list(details.coverage[key], text)]).filter(([, entries]) => entries.length)));
    if (coverage) projected.coverage = coverage;
  }
  if (details.publicationPreflight?.scope === 'transport-only') projected.publicationPreflight = {
    scope: 'transport-only', localHooks: 'not-run', remoteStoryBranch: 'not-updated',
    applicationFiles: 'not-modified-by-probe', index: 'not-modified-by-probe',
    localRefs: 'may-have-refreshed', remotePolicyVerified: false
  };
  return Object.keys(projected).length ? projected : null;
}

export function refusalEnvelope(error, argv = []) {
  const diagnosticAction = error?.details?.diagnosticAction;
  const diagnostic = diagnosticAction?.command ? safeCommandGuidance(diagnosticAction) : null;
  const remoteFailure = error?.details?.remoteFailure;
  const requiredTestExecution = requiredTestExecutionForRefusal(error);
  const details = refusalDetails(error?.details);
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
      ...(remoteFailure ? { remoteFailure } : {}),
      ...(requiredTestExecution ? { requiredTestExecution } : {}),
      ...(details ? { details } : {})
    },
    remediationPlan: refusalRemediationPlan(error, argv)
  };
}

export function renderRefusalPlan(plan) {
  const lines = ['Recovery plan:'];
  if (plan.context?.scope === 'phase') {
    lines.push(
      plan.context.strategy === 'external-host-prerequisite'
        ? `  Scope: phase ${plan.context.phaseId} — external host prerequisite; do not rewrite Story evidence or bypass the gate.`
        : plan.context.strategy === 'pinned-test-policy-prerequisite'
          ? `  Scope: phase ${plan.context.phaseId} — pinned test-policy prerequisite; preview a reviewed test-command amendment for the active phase, then follow its preparation or fresh-validation route.`
        : `  Scope: phase ${plan.context.phaseId} — repair in place; no automatic advance or history rewrite.`
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
