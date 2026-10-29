/**
 * Deterministic recovery guidance for errors that predate the structured narration contract.
 *
 * A refusal is not a useful product outcome unless it says how to make progress. Rewriting every
 * historical throw site at once would create hundreds of subtly different recovery paths, so the
 * process boundary gives every otherwise-unstructured error one bounded plan. Explicit producer
 * guidance still wins; this module fills only the gap and never executes an action.
 */

import { specificFindingDocumentation } from './finding-catalog.mjs';
import { localGitHookFailure, redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { stripGlobalModelOptions } from './model-mode.mjs';
import { requiredTestExecutionForRefusal } from './test-execution-diagnostics.mjs';
import {
  commandRouteLines, safeCommandGuidance, validateSafeSflowCommand
} from './safe-command-guidance.mjs';
import { projectGateRefusal } from './evidence/gate-refusal.mjs';
import { parseArgs } from './util.mjs';

const safeCommand = validateSafeSflowCommand;

/** The recovery each listed finding names for itself (a gate or final-check refusal), bounded. */
function findingRecoveries(details) {
  return (Array.isArray(details?.findings) ? details.findings.slice(0, 20) : []).map((finding) => {
    const recovery = finding?.recovery;
    return typeof recovery?.command === 'string'
      ? { command: recovery.command, label: recovery.label ?? recovery.detail } : null;
  });
}

function explicitCommands(error) {
  const details = error?.details ?? {};
  const values = [
    details?.diagnosticAction,
    typeof details?.nextAction === 'string' ? { command: details.nextAction } : details?.nextAction,
    // Some producers name their way out as `nextCommand` (session attach, workspace selection).
    typeof details?.nextCommand === 'string' ? details.nextCommand : details?.nextCommand,
    details?.recoveryCommand,
    // A throw site that names its own way out: the exact repair, or the command to run instead.
    details?.repairCommand,
    typeof details?.command === 'string' ? details.command : null,
    details?.retry,
    // A throw site that names its retry under this name (a pending sync or proposal upload).
    typeof details?.retryCommand === 'string' ? details.retryCommand : null,
    ...(Array.isArray(details?.recoveryCommands) ? details.recoveryCommands : []),
    ...(Array.isArray(details?.actions) ? details.actions : []),
    // A gate refusal's own actions, so the recovery plan every surface renders is the gate's
    // [E2G-024, criterion 16].
    ...(Array.isArray(details?.gate?.actions) ? details.gate.actions.map((entry) => entry?.command) : []),
    ...findingRecoveries(details)
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

function agentMappingSteps() {
  return [step('validate-workflows', 'See which step has no agent to draft it, the agent files that fix it, and anything else the workflows need.',
    'singularity-flow workflow validate', 'diagnostic', '/sf-fix-workflow')];
}

function step(id, label, command = null, kind = 'diagnostic', skill = null) {
  const guidance = command == null ? null : safeCommandGuidance({ command, ...(skill ? { skill } : {}) });
  // A command the route filter refuses is never shown, but its step stays, marked: dropping the step
  // whole hid the include route for a source statement from every plan (2026-10-27). A test builds
  // every known code's plan and fails on any mark, so a broken route is caught, not lost.
  if (command != null && !guidance) return Object.freeze({
    id, label, command: null, executable: null, skill: null, copilotCommand: null, argv: null,
    copyable: false, platformCommands: null, kind, execution: 'user-reviewed', commandRejected: true
  });
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

/** Earlier phases a refusal names as the owner of its cause; never the scope of a repair here. */
function upstreamPhaseIds(details = {}) {
  return new Set([
    ...(Array.isArray(details.upstreamPhases) ? details.upstreamPhases : []),
    details.upstreamPhase, details.producerPhase
  ].map(lowerKebab).filter(Boolean));
}

function artifactAuthoringPhase(argv, error) {
  const details = error?.details ?? {};
  // The phase the command operates on is the containment scope. A refusal may name the earlier
  // phase that owns its cause in `phase`; repairing there would mean editing approved evidence.
  const current = lowerKebab(details.currentPhase);
  if (current) return current;
  const commanded = commandPhase(argv);
  if (commanded) return commanded;
  const upstream = upstreamPhaseIds(details);
  for (const candidate of [details.phase, details.phaseId]) {
    const phase = lowerKebab(candidate);
    if (phase && !upstream.has(phase)) return phase;
  }
  return null;
}

function commandPhase(argv) {
  const selected = optionValue(argv, 'phase');
  if (selected) return selected;
  if (argv[0] === 'inputs' && argv[1] === 'restore') return lowerKebab(argv[2]);
  if (['prepare', 'inputs', 'submit', 'approve', 'reject'].includes(argv[0])) {
    return lowerKebab(argv[1]);
  }
  if (argv[0] === 'clarification' && ['status', 'record'].includes(argv[1])) {
    return lowerKebab(argv[2]);
  }
  // A fast-path verb such as `converge` names no step: its profile routes a step of any name.
  if (argv[0] === 'phase' && [
    'begin', 'enter', 'rollover', 'draft-check', 'prepublish', 'show', 'publish', 'approve', 'submit'
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
  // A configuration refusal names a step of the workflow definition, not a Story phase to repair.
  if (argv[0] === 'initiative' || ['initiative', 'configuration'].includes(error?.details?.subjectKind)) return null;
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
      null, 'remediation'),
    testRunRiskStep(error)
  ].filter(Boolean);
}

/**
 * A run whose classified cause is the environment. Only a person who approves the step can accept
 * that risk, in their own terminal; the agent is refused, so it shows the command.
 */
function testRunRiskStep(error) {
  const route = error?.details?.testRunRisk;
  const phase = lowerKebab(route?.phase);
  if (!route?.eligible || !phase || typeof route.command !== 'string') return null;
  return step('accept-test-run-risk',
    `If the environment stopped this run, a person who approves ${phase} can accept the risk in their own terminal; an agent cannot. `
      + `They name the cause, why it is acceptable and an expiry; the tests still run every time and only a run with the same environment cause is let through: ${redactDiagnosticText(route.command).slice(0, 600)}`,
    null, 'remediation');
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
  // The registered (v4) and legacy-v3 World Models were removed; their commands and settings say so.
  WMB_REMOVED: () => [
    step('read-repository-brief', 'Phase prompts get the Repository brief read from the source; see what a phase receives.',
      'singularity-flow wm brief --phase <PHASE>'),
    step('read-repository-knowledge', 'Read the repository itself: rules, contracts, flows and risks, with no model.',
      'singularity-flow wm knowledge brief')
  ],
  COMMAND_REMOVED: () => [
    step('read-repository-brief', 'Phase prompts get the Repository brief read from the source; see what a phase receives.',
      'singularity-flow wm brief --phase <PHASE>'),
    step('read-repository-contracts', 'Read the endpoints, seams and storage the code declares, with no model.',
      'singularity-flow wm knowledge show contracts')
  ],
  WFA_RUNTIME_INCOMPATIBLE: () => [
    step('inspect-snapshot-runtime',
      'This runtime cannot interpret the pinned Story snapshot. Inspect its exact policy; do not rewrite the snapshot or guess an older interpretation.',
      'singularity-flow doctor --json', 'diagnostic', '/sf-doctor'),
    step('inspect-compatible-build',
      'Check the installed build. Install the compatible package, or explicitly retire pilot Stories through After install hard cutover and start new IDs.',
      'singularity-flow product status --json', 'diagnostic', '/sf-product')
  ],
  WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED: (argv, error) => {
    const workType = lowerKebab(error?.details?.workType) ?? '<WORK-TYPE>';
    return [
      step('validate-workflow', 'Review the work type\'s planned-claim contract. Existing Stories keep their pinned policy.',
        'singularity-flow workflow validate'),
      step('record-planned-claims', 'Record the reviewed planned-claim policy for new Stories.',
        `singularity-flow workflow edit ${workType} --planned-claims required --clause-phases <PHASES> --claim-owners <CODE>=<OWNER>`,
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
      'Convert the repository-owned role to Agent Markdown and review its phase routing, then reinitialize.',
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
  INSTALL_RECEIPT_UPGRADE_NOT_ADMITTED: () => [
    step('rerun-full-source-install',
      'A legacy installation receipt is upgraded only by a full source install, after any interrupted install has finished its recovery. Run the full installer again from your Singularity Flow checkout (not CLI-only); existing bytes and lineage are kept.',
      null, 'remediation')
  ],
  PRODUCT_ALIGNMENT_STEP_FAILED: () => productAlignmentSteps('A surface could not be aligned. Check which build each surface runs.'),
  PRODUCT_ALIGNMENT_VERIFICATION_FAILED: () => productAlignmentSteps(
    'A surface did not verify after alignment. Check which build each surface runs.'),
  STORY_ARCHIVED_BY_REBUILD: (argv, error) => {
    const plan = /^grb-[0-9a-f]{24}$/u.test(String(error?.details?.plan ?? '')) ? error.details.plan : null;
    return [
      step('start-new-story', 'This Story was explicitly retired and stays read-only. Start a new Story with a new ID under the current Flow Policy.',
        'singularity-flow start <WORK-ID> --from-branch <BASE> --title <TITLE>', 'remediation'),
      ...(plan ? [step('preview-governance-restore',
        'Only if the rebuild itself was a mistake: preview restoring the Flow Policy it replaced, a reviewed change for the whole repository.',
        `singularity-flow governance restore --plan ${plan} --dry-run`)] : [])
    ];
  }
});

export const UPGRADE_GUIDED_CODES = Object.freeze(Object.keys(UPGRADE_KNOWN));

/** A broken workflow.yml: fix the first located problem, then check the whole file again. */
function configurationProblemSteps(error) {
  const problems = error.details.configurationProblems;
  const [first] = problems;
  const where = [first.file, first.line != null ? `line ${first.line}` : null].filter(Boolean).join(', ');
  const others = problems.length - 1;
  return [
    step('fix-configuration-problem',
      `Fix ${where || 'the configuration'}: ${first.fix ?? first.message}${others === 1 ? ' Then fix the other problem listed above.' : others ? ` Then fix the other ${others} problems listed above.` : ''}`,
      null, 'remediation'),
    step('check-configuration', 'Check the configuration again; every remaining problem is listed with its line.',
      'singularity-flow configuration validate', 'diagnostic')
  ];
}

/** No sflow/config yet: refresh in case it exists remotely, otherwise set it up once. */
function missingAuthoritySteps() {
  return [
    step('preview-configuration-refresh',
      'If this repository already has an approved configuration branch (sflow/config) on its remote, preview refreshing the workspace configuration so this checkout can see it.',
      'singularity-flow workspace refresh-configuration --dry-run', 'configuration'),
    step('set-up-configuration-authority',
      'If it has none yet, set it up once: in VS Code use Map a capability → Check repository → Set up, or run singularity-flow bootstrap <REPOSITORY-URL> --capability <ID>. It creates sflow/config and the state branch without touching your default branch; then retry.',
      null, 'remediation')
  ];
}

function missingConfigurationSteps() {
  return [
    step('diagnose-story-configuration',
      'Automatic loading found no approved workflow configuration. Check Git access and the workspace authority; this is not a test-baseline failure.',
      'singularity-flow workspace doctor --network --json'),
    step('preview-safe-story-upgrade',
      'After installing matching current CLI and VS Code builds, preview Upgrade / migrate SFlow. Review its exact plan before applying; do not recreate policy or erase Story history automatically.',
      'singularity-flow workspace reinitialize --dry-run --json', 'configuration'),
    step('restore-approved-story-configuration',
      'If the authority has never been set up, use Map a capability → Check repository → Set up. Otherwise repair the approved authority or workspace attachment, then refresh intake and retry the same Story ID. Do not hand-edit schema versions or bypass policy.',
      null, 'remediation')
  ];
}

/** Refusals whose cause is an earlier phase's approved input, never the phase being worked on. */
const UPSTREAM_INPUT_CODES = new Set([
  'PHASE_INPUTS_NOT_READY', 'SPECIFICATION_INDEX_UNTRUSTED', 'CONVERGENCE_UPSTREAM_ARTIFACT_STALE',
  'INPUT_RESTORE_COMMITTED_DRIFT', 'INPUT_RESTORE_STAGED_DRIFT', 'INPUT_RESTORE_NOT_APPROVED_BYTES'
]);

function upstreamInputContext(argv, error) {
  const details = error?.details ?? {};
  const phase = artifactAuthoringPhase(argv, error);
  const findings = Array.isArray(details.findings) ? details.findings : [];
  const producers = [...new Set([
    ...upstreamPhaseIds(details),
    ...findings.map((finding) => lowerKebab(finding?.details?.upstreamPhase)),
    // A producer-owned refusal (index, convergence binding) names its producer in `phase`.
    ...(phase && lowerKebab(details.phase) !== phase ? [lowerKebab(details.phase)] : [])
  ].filter((id) => id && id !== phase))];
  const restorable = details.restorable === true
    || findings.some((finding) => finding?.restorable === true || finding?.details?.restorable === true);
  const routes = (Array.isArray(details.routes) ? details.routes : [])
    .filter((route) => typeof route?.command === 'string' && typeof route?.label === 'string');
  const notes = (Array.isArray(details.notes) ? details.notes : []).filter((note) => typeof note === 'string');
  return { phase, producers, restorable, routes, notes };
}

/**
 * Inspect read-only, restore the exact approved bytes when that can work, or take the producer's
 * return/amendment route. Every label says whose input it is and that this phase must not edit it.
 */
function upstreamInputSteps(argv, error) {
  const { phase, producers, restorable, routes, notes } = upstreamInputContext(argv, error);
  const owner = producers.length ? producers.join(', ') : 'an earlier phase';
  const here = phase ?? 'this phase';
  const route = routes[0];
  const raise = routes.find((entry) => entry.kind === 'upstream-issue');
  return [
    step('inspect-upstream-inputs',
      `Inspect the approved inputs ${here} reads, without changing anything. They come from ${owner} and must not be edited by ${here}.`,
      phase ? `singularity-flow inputs ${phase} --dry-run --json` : 'singularity-flow inputs --dry-run --json'),
    restorable && phase ? step('restore-approved-inputs',
      `Preview restoring the exact approved bytes of the changed input. It comes from ${owner} and must not be edited by ${here}; nothing changes until the plan digest is confirmed, and a private checkpoint keeps the edited copy.`,
      `singularity-flow inputs restore ${phase}`, 'remediation') : null,
    route
      ? step('return-or-amend-upstream', `If the approved ${owner} content itself must change: ${route.label} The input comes from ${owner}; ${here} must not edit it.`,
        route.command, 'remediation')
      : step('return-or-amend-upstream', `${notes[0] ?? `If the approved ${owner} content itself must change, only an authorized return or amendment of ${owner} changes it.`} The input comes from ${owner}; ${here} must not edit it.`,
        null, 'remediation'),
    // Always open, whatever the current status: record it for the owner and keep working [UIF-M4].
    raise && raise !== route ? step('raise-upstream-issue', `${raise.label} The input comes from ${owner}; ${here} must not edit it.`,
      raise.command, 'remediation') : null
  ].filter(Boolean);
}

function initiativeDraftSteps(error, label) {
  const phase = lowerKebab(error?.details?.phase);
  return [step('inspect-initiative-draft', label,
    phase ? `singularity-flow initiative phase draft-check ${phase} --json` : 'singularity-flow initiative --help', 'diagnostic')];
}

/** A repair budget is spent: reset it the way its policy allows, or ask a person for direction. */
function repairBudgetSteps(_argv, error) {
  const details = error?.details ?? {};
  const reset = typeof details.resetCommand === 'string' ? details.resetCommand : null;
  const current = lowerKebab(details.currentPhase);
  return [
    reset ? step('reset-repair-budget',
      `Return ${current ?? 'the submitted phase'} to ${lowerKebab(details.resetPhase) ?? 'the reset phase'} instead. Its policy resets the ${lowerKebab(details.phase) ?? 'exhausted'} repair budget once an approved new generation of that phase exists.`,
      reset, 'remediation') : null,
    step('request-human-direction',
      reset
        ? 'Or ask the approvers for direction: further rework of the same phase needs their decision, not another unchanged rejection.'
        : `No allowed return resets the ${lowerKebab(details.phase) ?? 'exhausted'} repair budget from here. Ask the approvers for direction: approve the submission as it stands, or have a workflow maintainer change the budget for new Stories.`,
      null, 'remediation'),
    current ? step('inspect-submitted-phase', `Review the submitted ${current} evidence before deciding.`,
      `singularity-flow phase show ${current} --json`, 'diagnostic') : null
  ].filter(Boolean);
}

/** The groups (and listed members) who may make a decision a refused identity cannot. */
function eligibleDeciders(details = {}) {
  const groups = (Array.isArray(details.authorities) ? details.authorities : []).map(lowerKebab).filter(Boolean);
  const members = (Array.isArray(details.eligibleApprovers) ? details.eligibleApprovers : [])
    .filter((entry) => typeof entry === 'string' && /^[^\s<>"'`]{1,254}$/u.test(entry)).slice(0, 10);
  return `${groups.length ? groups.join(', ') : 'its approval groups'}${members.length ? ` (${members.join(', ')})` : ''}`;
}

const IDENTITY_CHECK = 'check the Git identity this checkout uses with git config user.email (a GitHub login comes from gh auth status)';
const NOTHING_TO_REJECT = 'Nothing was recorded and the work under review needs no change; do not reject or resubmit it to get past this.';

/**
 * A decision refused for who is making it, never for what is under review. The way forward is the
 * right identity or another eligible person, so these plans name both and offer no reject route.
 */
function approvalIdentitySteps(_argv, error) {
  const details = error?.details ?? {};
  const deciders = eligibleDeciders(details);
  const phase = lowerKebab(details.phase);
  const identity = typeof details.identity === 'string' && details.identity.trim()
    ? `'${redactDiagnosticText(details.identity).slice(0, 254)}'` : 'This identity';
  const ask = step('ask-eligible-member',
    `Ask a member of ${deciders} to make this decision from their own checkout, under their own identity. ${NOTHING_TO_REJECT}`,
    null, 'remediation');
  if (error?.code === 'APPROVAL_IDENTITY_MISSING') return [
    step('set-approval-identity',
      `This checkout has no Git email or GitHub login to decide with: ${IDENTITY_CHECK}. Set user.email to the address you are listed under, then run the same command again.`,
      null, 'remediation'),
    ask
  ];
  // Nobody else is pinned for this Story and the step forbids self-approval: no one can approve it
  // here, and asking "another member" named nobody. Say so, and name the way to a Story that can finish.
  if (error?.code === 'APPROVAL_SELF_APPROVAL_PROHIBITED' && !details.anyIdentity
      && Array.isArray(details.eligibleApprovers) && !details.eligibleApprovers.length) {
    const workId = typeof details.workId === 'string' ? details.workId : null;
    const group = (Array.isArray(details.authorities) ? details.authorities : []).map(lowerKebab).filter(Boolean)[0] ?? null;
    // Another person added through the configuration reaches this Story by an approver refresh;
    // allowing self-approval is a policy change, which applies only to Stories started after it.
    return [
      step('no-other-approver', `Nobody else is listed in ${deciders} for this Story, and ${phase ?? 'this step'} forbids self-approval, so it cannot be approved in this Story as its approval groups stand. Have another person added to ${deciders} through the configuration, then refresh this Story's approvers; allowing self-approval instead applies only to a new Story.`,
        null, 'remediation'),
      workId ? step('refresh-approvers', `Once that person is in the approved configuration, someone in one of this Story's groups previews the refresh, then records it in their own terminal.`,
        `singularity-flow story approvers refresh ${workId} --reason <REASON>`, 'remediation') : null,
      group ? step('allow-self-approval', `Or propose allowing self-approval for ${group}: a configuration change its reviewers approve. It applies to Stories started after it is activated.`,
        `singularity-flow configuration add-current-identity --target story:${group} --self-approval on --json`, 'remediation') : null
    ].filter(Boolean);
  }
  // Nobody at all is pinned in the group (empty from the start, or its only member left): "ask a
  // member" named nobody, and a running Story's groups cannot change (2026-10-28).
  if (error?.code === 'APPROVAL_IDENTITY_NOT_AUTHORIZED' && !details.anyIdentity
      && Array.isArray(details.eligibleApprovers) && !details.eligibleApprovers.length) {
    const workId = typeof details.workId === 'string' ? details.workId : null;
    const group = (Array.isArray(details.authorities) ? details.authorities : []).map(lowerKebab).filter(Boolean)[0] ?? null;
    return [
      step('no-approver-listed', `Nobody is listed in ${deciders} for this Story, so ${phase ?? 'this step'} cannot be approved in it yet. Have people added to ${deciders} through the configuration, then refresh this Story's approvers to bring them in.`,
        null, 'remediation'),
      group ? step('propose-joining-group', `If you should decide it, propose adding yourself to ${group}: a configuration change its reviewers approve.`,
        `singularity-flow configuration add-current-identity --target story:${group} --json`, 'remediation') : null,
      workId ? step('refresh-approvers', `Once the addition is approved, someone in one of this Story's groups (the new member, say) previews the refresh, then records it in their own terminal.`,
        `singularity-flow story approvers refresh ${workId} --reason <REASON>`, 'remediation') : null
    ].filter(Boolean);
  }
  if (error?.code === 'APPROVAL_SELF_APPROVAL_PROHIBITED') return [
    step('ask-other-approver',
      `Policy does not let the author of this generation approve ${phase ?? 'it'}. Ask another member of ${deciders} to approve it from their own checkout. ${NOTHING_TO_REJECT}`,
      null, 'remediation'),
    step('check-approval-identity',
      `If you did not author it, this checkout is deciding as its author: ${IDENTITY_CHECK}, then run the same command again.`,
      null, 'remediation')
  ];
  if (error?.code === 'APPROVAL_IDENTITY_ALREADY_RECORDED') return [
    step('ask-next-approver',
      `This identity's approval of ${phase ?? 'the step'} is already recorded, and each approval needs a different person. Another member of ${deciders} records the next one from their own checkout. ${NOTHING_TO_REJECT}`,
      null, 'remediation'),
    step('check-approval-identity',
      `If you have not approved it, this checkout is deciding as another reviewer: ${IDENTITY_CHECK}, then run the same command again.`,
      null, 'remediation')
  ];
  return [
    step('check-approval-identity',
      `${identity} is not a member of ${deciders}. If you are listed under another address, ${IDENTITY_CHECK}, set it to your listed address, and run the same command again (resume the Story first if its session still shows the old identity).`,
      null, 'remediation'),
    ask
  ];
}

const APPROVAL_IDENTITY_CODES = Object.freeze(['APPROVAL_IDENTITY_NOT_AUTHORIZED', 'APPROVAL_IDENTITY_MISSING',
  'APPROVAL_SELF_APPROVAL_PROHIBITED', 'APPROVAL_IDENTITY_ALREADY_RECORDED']);

/**
 * An approver must answer, and the answer must land in the author's checkout: it binds that
 * checkout's composed prompt and reaches the Story only with that checkout's phase publication.
 */
function clarificationAuthoritySteps(argv, error) {
  const details = error?.details ?? {};
  const phase = lowerKebab(details.phase) ?? artifactAuthoringPhase(argv, error);
  const workId = safeWorkId(details.workId);
  return [
    step('record-answer-in-author-checkout',
      `Only a member of ${eligibleDeciders(details)} can answer. The answer must be recorded in this checkout: it is bound to this checkout's composed prompt and reaches the Story only with this checkout's publication, so a record made in another clone is never seen. `
        + `The member records it here as themselves: with this checkout's git config user.email set to their listed address, they run singularity-flow resume ${workId ?? '<WORK-ID>'} and then the same clarification record command. The author then restores their own identity and resumes again. Never record the answer under the author's identity.`,
      null, 'remediation'),
    phase ? step('inspect-clarification-checkpoint', 'See which questions still need an answer.',
      `singularity-flow clarification status ${phase} --json`, 'diagnostic') : null
  ].filter(Boolean);
}

/**
 * An intent amendment proposed after the phase was submitted and still undecided. Its decision
 * comes first: approving it changes the clauses the submission cited. Rejecting it keeps the
 * submission when the proposal holds the approval (APPROVAL_INTENT_AMENDMENT_PENDING, SPEC-OAP M2);
 * when its commits record more than the amendment (STORY_REVIEW_INTERVENING_COMMIT), the phase
 * still needs a fresh submission. A person who approves the scope decides it; an agent's decision
 * turn is refused it, so the route shows the command rather than doing it.
 */
function pendingAmendmentSteps(_argv, error) {
  const details = error?.details ?? {};
  const workId = safeWorkId(details.workId);
  const phase = lowerKebab(details.phase);
  const amendment = (Array.isArray(details.pendingIntentAmendments) ? details.pendingIntentAmendments : [])
    .find((entry) => /^AMD-\d{3,}$/u.test(entry?.id ?? ''));
  if (!workId || !phase || !amendment) return [];
  const clauses = (Array.isArray(amendment.changedClauses) ? amendment.changedClauses : [])
    .filter((clause) => typeof clause === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(clause)).slice(0, 5);
  const commit = /^[0-9a-f]{7,64}$/u.test(amendment.commit ?? '') ? amendment.commit : null;
  const scope = lowerKebab(details.scopePhase) ?? 'the scope';
  const keepsSubmission = error?.code === 'APPROVAL_INTENT_AMENDMENT_PENDING';
  return [
    step('inspect-intent-amendment',
      `See intent amendment ${amendment.id}, proposed${commit ? ` in ${commit}` : ''} after ${phase} was submitted`
        + `${clauses.length ? `; it changes ${clauses.join(', ')}` : ''}. It is still waiting for a decision, and ${phase} cannot be approved until it has one.`,
      `singularity-flow story intent-amendment status --work-id ${workId} --json`, 'remediation'),
    personTerminalStep(step('decide-intent-amendment',
      `A person who approves ${scope} decides ${amendment.id} in their own terminal; an agent cannot. `
        + `Approving it changes ${clauses.length ? 'those clauses' : 'the approved clauses'}, so ${phase} reopens to be revised and submitted again. `
        + (keepsSubmission ? `Rejecting it keeps the approved clauses, and ${phase} can then be approved as submitted, with no fresh submission. `
          : `Rejecting it keeps the approved clauses, but these commits record more than its proposal and rejection, so ${phase} still needs a fresh submission. `)
        + `Returning ${phase} instead (a person, with /sf-reject in a new turn) does not decide ${amendment.id}.`,
      `singularity-flow story intent-amendment decide ${amendment.id} --decision <approve|reject> --confirm ${amendment.id} --work-id ${workId}`,
      'remediation'))
  ];
}

/**
 * An approval checklist left unanswered: the approver answers each article and approves again. The
 * work is fine as submitted, so nothing is recovered or rejected.
 */
function approvalChecklistSteps(argv, error) {
  const details = error?.details ?? {};
  const phase = lowerKebab(details.phase) ?? artifactAuthoringPhase(argv, error);
  const articles = (Array.isArray(details.articles) ? details.articles : []).map(lowerKebab).filter(Boolean).slice(0, 20);
  if (details.mode === 'off') return [step('remove-checklist-answers',
    `${phase ?? 'This phase'} records no checklist: approve again without --article or --checklist.`, null, 'remediation')];
  return [
    step('answer-approval-checklist',
      `Answer each checklist article${articles.length ? ` (${articles.join(', ')})` : ''}: satisfied, exception or not-applicable, with a reason for the last two. `
        + `Then approve again with them (/sf-approve${phase ? ` ${phase}` : ''} asks for them; in a terminal, --article <id>=<decision>). Nothing about the work needs repairing.`,
      null, 'remediation'),
    phase ? step('read-approval-checklist', 'Read the articles and their questions.', `singularity-flow phase show ${phase} --json`, 'diagnostic') : null
  ].filter(Boolean);
}

/** A person's own decision: no skill carries it out, so its Copilot line says to decide it in a terminal. */
function personTerminalStep(entry) {
  return entry && !entry.copilotCommand
    ? Object.freeze({ ...entry, copilotReason: 'no verified equivalent: decide it in your terminal' }) : entry;
}

function localSyncSteps(argv, error) {
  const retry = safeCommandGuidance({ argv });
  return [step('preserve-local-story-work', error?.message ?? 'Preserve the local work yourself; nothing was changed.', null, 'remediation'),
    retry && step('retry-after-preserving', 'Then open the Story again.', retry.command, 'diagnostic')];
}

const KNOWN = Object.freeze({
  // An upstream issue about a step with no approval group: never decidable there. Raise it, or a
  // superseding issue, at the nearest earlier step whose approvers can decide it.
  UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE: (argv, error) => {
    const details = error?.details ?? {};
    const instead = typeof details.decidableStep === 'string' ? lowerKebab(details.decidableStep) : null;
    if (!instead) return [];
    // With the Story it is for: a /sf-decide turn raises one only for its bound Story.
    const command = details.nextAction?.command ?? `singularity-flow upstream-issue raise${typeof details.workId === 'string'
      ? ` --work-id ${details.workId}` : ''} --phase ${instead} --about <ID|SECTION> --problem <TEXT>`;
    return [step(details.issue ? 'supersede-upstream-issue' : 'raise-at-decidable-step',
      `${details.issue ? `Raise the same problem against ${instead}, superseding ${details.issue}` : `Raise it against ${instead}`}: its approvers can decide it.`,
      command, 'remediation', null)].filter(Boolean);
  },
  // A draft citing a constitution article the Story's pin lacks: the author corrects the citation.
  CONSTITUTION_CITATION_INVALID: (argv, error) => {
    const phase = typeof error?.details?.phase === 'string' ? error.details.phase : null;
    return [phase ? step('correct-citation', `Correct or remove each citation the Story's pinned constitution does not contain (${(error.details.errors ?? []).length || 'see the refusal'}), then recheck. An article added since the Story started is not in its pin.`,
      `singularity-flow phase prepublish ${phase} --for-agent --json`, 'remediation', '/sf-phase') : null].filter(Boolean);
  },
  // Refused at Story start: a step nobody could approve. Its fix is in the approved configuration.
  APPROVAL_POLICY_UNATTAINABLE: (argv, error) => {
    const details = error?.details ?? {};
    const groups = (Array.isArray(details.authorities) ? details.authorities : []).map(lowerKebab).filter(Boolean);
    const group = groups[0] ?? null;
    return [
      step('add-approver', `Add ${details.selfApprovalExcluded ? 'another person' : 'enough reviewers'} to ${groups.join(', ') || 'the step\'s approval groups'} in the approved configuration (Workflow Studio: People & approvals), then start the Story again.`,
        null, 'remediation'),
      group ? step(details.selfApprovalExcluded ? 'allow-self-approval' : 'add-current-identity',
        details.selfApprovalExcluded ? `Or propose allowing self-approval for ${group}: a configuration change its reviewers approve.`
          : `Or propose adding yourself to ${group}: a configuration change its reviewers approve.`,
        `singularity-flow configuration add-current-identity --target story:${group}${details.selfApprovalExcluded ? ' --self-approval on' : ''} --json`, 'remediation') : null
    ].filter(Boolean);
  },
  // Planned delivery incomplete at publication. The generic recovery led back to /sf-code even when
  // the gap waits on an earlier step's decision (office, 2026-10-27): every clause an open upstream
  // issue names goes to the decision list; the author's recheck, a pilot risk the step's approvers
  // may accept, and the read-only recovery inspection follow, as each applies.
  SPEC_COVERAGE_INCOMPLETE: (argv, error) => {
    const details = error?.details ?? {};
    const phase = typeof details.phase === 'string' ? details.phase : null;
    const decision = details.upstreamDecision ?? null;
    const list = details.nextAction?.command?.startsWith('singularity-flow decisions ')
      ? step('open-decision-list', String(details.nextAction.label ?? 'Open the decision list.').slice(0, 2000), details.nextAction.command, 'remediation', '/sf-decide')
      : null;
    const author = phase && !decision?.complete
      ? step('deliver-missing-clauses', `Deliver the clauses this refusal lists (source, tests and their tags) in ${phase}'s open generation, then recheck.${decision ? ` Leave ${decision.issues.flatMap((entry) => entry.clauses).join(', ')} to the open upstream issue's decision.` : ''}`,
        `singularity-flow phase prepublish ${phase} --for-agent --json`, 'remediation', '/sf-code')
      : null;
    const risk = phase && (details.qualityRisk?.eligible === true || details.riskEligible === true)
      ? step('accept-quality-risk', `An approver of ${phase} may accept the remaining coverage gap for this pilot step, with an expiry; tests, review and integrity stay enforced.`,
        `singularity-flow appeal risk-prepare --phase ${phase} --gate-mode soft --expires <YYYY-MM-DD> --reason <why> --json`, 'remediation', '/sf-appeal')
      : null;
    const inspect = typeof details.diagnosticCommand === 'string'
      ? step('inspect-coverage', 'Inspect the exact source and test obligations still open.', details.diagnosticCommand, 'diagnostic', '/sf-recover') : null;
    return [list, author, risk, inspect].filter(Boolean);
  },
  // A folder of several agents is a workflow: team import builds one from the same reading of its
  // files and links. Adding one of its agents alone stays possible with --main.
  USER_AGENT_FOLDER_IS_WORKFLOW: (argv, error) => {
    const folder = typeof error?.details?.folder === 'string' ? error.details.folder : null;
    const build = folder ? safeCommandGuidance({ argv: ['workflow', 'import-team', 'inspect', folder] }) : null;
    const single = folder ? safeCommandGuidance({ argv: ['call', 'add', folder, '--main', '<FILE>'] }) : null;
    return [build && step('build-workflow-from-folder', 'Build a workflow from this folder: SFlow reads every file and how they link, '
      + 'Copilot proposes the steps, and SFlow validates every route before you review the proposal.', build.command, 'remediation', '/sf-import-team'),
    single && step('add-one-agent', 'Or add one of its agents as a single step.', single.command, 'remediation', '/sf-call-add')].filter(Boolean);
  },
  // The main agent file of `call add`: what is wrong is in that file, never the repository, so the
  // repository-health route a refusal falls back to sent people to the wrong place (office, 2026-10-26).
  USER_AGENT_MAIN_INVALID: (argv, error) => {
    const retry = argv.length ? safeCommandGuidance({ argv }) : null;
    return [step('edit-main-agent-file', `${error?.message ?? 'The main agent file cannot be read.'} Edit that file: SFlow uses its name, `
      + 'its description and the instructions after its front matter. Or name another file of the folder with --main.', null, 'remediation'),
    retry && step('preview-again', 'Then preview adding the folder again.', retry.command, 'diagnostic')].filter(Boolean);
  },
  // Commits after a submission: an undecided intent amendment among them is decided first.
  STORY_REVIEW_INTERVENING_COMMIT: pendingAmendmentSteps,
  // An amendment proposed after the submission holds the approval until a person decides it [SPEC-OAP M2].
  APPROVAL_INTENT_AMENDMENT_PENDING: pendingAmendmentSteps,
  APPROVAL_CHECKLIST_INCOMPLETE: approvalChecklistSteps,
  SESSION_STATE_REFRESH_UNAVAILABLE: (argv, error) => {
    const { options } = parseArgs(argv);
    const selectors = ['workspace', 'repository', 'repository-url', 'configuration-url']
      .flatMap(name => typeof options[name] === 'string' ? [`--${name}`, options[name]] : []);
    const refresh = safeCommandGuidance({ argv: ['session', 'candidates', ...selectors, '--refresh', '--diagnostics', '--json'] });
    return [step('inspect-state-transport',
      error.details?.remoteFailure?.failure?.advice ?? 'Inspect the state-index Git error and deadline evidence. A timeout alone does not establish a DNS failure.',
      null, 'diagnostic'), refresh && step('refresh-session-listing',
      'After resolving the reported transport condition, explicitly refresh the same Story listing. A cached listing is advisory; do not scan application branches or weaken attachment checks.',
      refresh.command, 'diagnostic')];
  },
  // Git would wait with no limit on the repository's undownloaded files; the message names them.
  GIT_STORAGE_UNAVAILABLE: (argv, error) => {
    const retry = safeCommandGuidance({ argv });
    const relocation = error?.details?.relocation;
    const duplicate = relocation?.requiresConfirmation === true ? safeCommandGuidance({ argv: relocation.argv }) : null;
    const use = duplicate ? safeCommandGuidance({ argv: relocation.useArgv }) : null;
    return [step('download-repository-files', error?.message
      ?? 'Download the repository folder and keep it downloaded, or move the workspace out of the synced folder.', null, 'remediation'),
    retry && step('retry-after-download', 'Once the folder is downloaded, run the same command again.', retry.command, 'diagnostic'),
    // Never run unasked: a second copy of the workspace, cloned fresh outside the synced folder.
    duplicate && step('clone-workspace-outside-synced-folder', `Only if the person confirms: clone the workspace again at ${relocation.path}; the offloaded copy is left as it is.`, duplicate.command, 'remediation'),
    use && step('use-cloned-workspace', 'Then switch to that copy and run /sf-session again.', use.command, 'remediation')];
  },
  // A new workspace would keep Git in a cloud-synced folder: the same command under the local base.
  WORKSPACE_SYNCED_FOLDER: (argv, error) => {
    const base = error?.details?.suggestedBase;
    const index = argv.indexOf('--base');
    const clone = (error?.details?.locations ?? []).some((entry) => entry.subject === 'repository');
    const local = base && !clone ? safeCommandGuidance({
      argv: index >= 0 ? argv.map((entry, at) => (at === index + 1 ? base : entry)) : [...argv, '--base', base]
    }) : null;
    return [clone ? step('clone-outside-synced-folder', `Clone the repository again under ${base}, which is not synced, and adopt that clone.`, null, 'remediation')
      : local && step('create-outside-synced-folder', `Create it under ${base}, which is not synced.`, local.command, 'remediation'),
    step('allow-synced-folder', `Or keep the synced folder: run the same command with ${error?.details?.override ?? '--allow-synced-folder'}.`, null, 'remediation')];
  },
  // The Story's own checkout could not be fast-forwarded without touching local work (session-open-local.mjs).
  SESSION_LOCAL_SYNC_DIRTY: localSyncSteps,
  SESSION_LOCAL_SYNC_DIVERGED: localSyncSteps,
  WORKFLOW_CONFIGURATION_MISSING: missingConfigurationSteps,
  PHASE_INPUTS_NOT_READY: upstreamInputSteps,
  SPECIFICATION_INDEX_UNTRUSTED: upstreamInputSteps,
  CONVERGENCE_UPSTREAM_ARTIFACT_STALE: upstreamInputSteps,
  INPUT_RESTORE_COMMITTED_DRIFT: (argv, error) => upstreamInputSteps(argv, {
    ...error, details: { ...(error?.details ?? {}), restorable: false }
  }),
  // Code changed before generation begin, which this Story's policy does not adopt. The policy's remedy
  // (preserve, return to the baseline, begin, reapply) as commands.
  GENERATION_DIRTY_START: (argv, error) => {
    const details = error?.details ?? {};
    const workId = safeWorkId(details.workId);
    const phase = lowerKebab(details.phase) ?? commandPhase(argv);
    const classification = details.classification ?? {};
    // Policy permits adopting a bounded change set (after a published generation, or by explicit
    // Story policy), unless it reaches protected or out-of-boundary paths. Only `phase begin`
    // adopts; `prepare` meets the same boundary but takes no adoption flags.
    const adoptable = /^sha256:[a-f0-9]{64}$/u.test(details.changeSetDigest ?? '') && phase
      && (details.boundary === 'since-previous-generation' || details.dirtyStartPolicy === 'allow-explicit-adoption')
      && !classification.protectedPaths?.length && !classification.outsideSourceBoundaryPaths?.length;
    const review = `singularity-flow recover${workId ? ` ${workId}` : ''} --json`;
    if (adoptable) return [
      step('review-before-adoption',
        'A person reviews the listed changes (details.changedPaths) and the recovery plan before anything is adopted; nothing is adopted automatically.',
        review, 'remediation', '/sf-recover'),
      step('adopt-reviewed-changes',
        'Then adopt exactly this reviewed change set into the new generation; the digest refuses if anything changed since.',
        `singularity-flow phase begin ${phase} --adopt-existing --confirm ${details.changeSetDigest}`, 'remediation')
    ];
    return [
      step('set-aside-before-begin',
        'A person reviews the listed changes (details.changedPaths), then sets them aside with the set-aside-worktree command recovery returns: it keeps every byte in a private recovery copy (appeal checkpoint-show lists it) and returns the checkout to its baseline.',
        review, 'remediation', '/sf-recover'),
      step('begin-then-reapply',
        'Begin the generation, then reapply the reviewed changes from the recovery copy; they become part of this generation and its review.',
        phase ? `singularity-flow phase begin ${phase} --json` : null, 'remediation')
    ];
  },
  // Changes nobody can attribute to the decision. A person keeps them (commits them) or sets them aside
  // through recovery's confirmed route; rejecting the submission is not the remedy.
  LIFECYCLE_WORKTREE_REVIEW_REQUIRED: (argv, error) => [
    step('review-held-changes',
      'The checkout has changes that are not part of this decision (details.paths). A person looks at them and sets them aside with the set-aside-worktree command recovery returns (it keeps a private recovery copy), or moves them out of the checkout. Committing them by hand is not a way through: approval then refuses until the step is returned and resubmitted. Then run the decision again; nothing needs rejecting.',
      error?.details?.recoveryCommand ?? null, 'remediation', '/sf-recover')
  ],
  INPUT_RESTORE_STAGED_DRIFT: (argv, error) => [
    step('unstage-upstream-input',
      'The changed bytes of the earlier phase\'s input are staged. Unstage that file with Git (its committed copy is the approved one), then preview the restore again. This phase must not edit it.',
      null, 'remediation'),
    ...upstreamInputSteps(argv, { ...error, details: { ...(error?.details ?? {}), restorable: true } })
  ],
  INPUT_RESTORE_NOT_APPROVED_BYTES: (argv, error) => upstreamInputSteps(argv, {
    ...error, details: { ...(error?.details ?? {}), restorable: false }
  }),
  INPUT_RESTORE_PLAN_CHANGED: (argv, error) => [
    step('preview-input-restore-again',
      'The inputs changed after the preview. Preview the restore again and confirm its new plan digest.',
      artifactAuthoringPhase(argv, error) ? `singularity-flow inputs restore ${artifactAuthoringPhase(argv, error)} --json`
        : 'singularity-flow inputs restore --json')
  ],
  REPAIR_BUDGET_EXHAUSTED: repairBudgetSteps,
  STORY_STATE_INVALID: (argv) => [
    argv[0] === 'validate' ? null : step('inspect-story-state',
      'Nothing was published. Read every reported Story-state problem; most name the phase that owns it.',
      'singularity-flow validate'),
    step('recover-story-state', 'Inspect the Story\'s recovery plan for the current phase before retrying.',
      'singularity-flow recover --json')
  ].filter(Boolean),
  SPEC_CLAIM_MAP_UNKNOWN_CLAUSE: () => [
    step('list-defined-clauses',
      'List the clauses the Story defines. Cite only those; the phase that defines a clause owns its wording and must not be edited from here.',
      'singularity-flow spec trace --format json')
  ],
  SPEC_CLAUSE_DEPENDENCY_MISSING: () => [
    step('list-defined-clauses',
      'List the clauses the Story defines. A clause may depend only on a defined clause; an earlier phase\'s clause changes only by its own return or amendment.',
      'singularity-flow spec trace --format json')
  ],
  EPIC_TRACEABILITY_INCOMPLETE: (_argv, error) => initiativeDraftSteps(error,
    'Each listed traceability gap names the requirement or Story row to correct in this phase\'s draft; approved earlier phases are not edited from here.'),
  EPIC_PLANNING_PACKAGE_INVALID: (_argv, error) => initiativeDraftSteps(error,
    'Correct each listed planning-package problem in this phase\'s draft, then check it again.'),
  INITIATIVE_STORY_PLAN_INVALID: (_argv, error) => initiativeDraftSteps(error,
    'Correct each listed Story-plan problem in this phase\'s draft, then check it again.'),
  INITIATIVE_IMPACT_MAP_UNGROUNDED: (_argv, error) => initiativeDraftSteps(error,
    'Ground each listed impact-map entry in a repository the Initiative names, then check the draft again.'),
  INITIATIVE_OUTPUTS_MISSING: (_argv, error) => initiativeDraftSteps(error,
    'Write each listed required output of this phase, then check the draft again.'),
  // The chosen file is not the original. Choose it again; when the original is gone, detaching is
  // the person's decision, and its preview shows the steps it would reopen.
  DOCUMENT_RESTORE_HASH_MISMATCH: (argv, error) => {
    const id = safeWorkId(error?.details?.documentId);
    const workId = safeWorkId(optionValueRaw(argv, 'work-id'));
    if (!id) return [];
    const scope = workId ? ` --work-id ${workId}` : '';
    return [
      step('choose-original-again', `Choose the original file for ${id} again; only its exact bytes restore it.`,
        `singularity-flow documents restore ${id}${scope} --file <LOCAL-FILE> --json`, 'remediation', '/sf-documents'),
      step('preview-detach', `If the original is gone, preview detaching ${id}: it reopens the steps that used it. The person detaches it with --reason.`,
        `singularity-flow documents detach ${id}${scope} --dry-run --json`, 'diagnostic', '/sf-documents')
    ];
  },
  DOCUMENT_HASH_MISMATCH: () => [
    step('inspect-story-documents',
      'A supporting document no longer matches the bytes its catalog committed. Restore the committed copy (or re-add the changed document as a new one); this phase must not use the changed bytes.',
      'singularity-flow documents list --json')
  ],
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
      'singularity-flow help', 'help'),
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
  STORY_CONFIGURATION_AUTHORITY_MISSING: missingConfigurationSteps,
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
  CONFIGURATION_PROPOSAL_AUTHORITY_MISSING: () => missingAuthoritySteps(),
  WORKFLOW_PROPOSAL_AUTHORITY_MISSING: () => missingAuthoritySteps(),
  // A near-miss phase ID in a repository agent is a typo in that file, not outdated configuration.
  AGENT_PHASE_UNKNOWN: (argv, error) => typeof error?.details?.suggestion === 'string' ? [
    step('fix-agent-phase',
      `Edit ${typeof error.details.source === 'string' ? redactDiagnosticText(error.details.source).slice(0, 300) : 'the agent file'}: change '${redactDiagnosticText(String(error.details.phaseId ?? '')).slice(0, 120)}' to '${redactDiagnosticText(error.details.suggestion).slice(0, 120)}', or add that phase to singularity/workflow.yml.`,
      null, 'remediation'),
    step('check-configuration', 'Check the configuration again.', 'singularity-flow configuration validate', 'diagnostic')
  ] : [
    step('preview-configuration-refresh',
      'Open VS Code → Workspaces → Fast onboarding & Git → Safely reinitialize capabilities & workspaces, preview the selected workspace, then use Repair missing or outdated agents when offered.',
      'singularity-flow workspace refresh-configuration --dry-run', 'configuration'),
    step('preview-repository-factory-reset',
      'If this repository\'s old Singularity Flow data may be discarded, preview the guarded factory reset and review its exact remove and preserve scope before confirming anything.',
      'singularity-flow factory-reset --dry-run --json', 'remediation'),
    step('verify-agent-phase-contract',
      'After applying one reviewed repair, verify the current workflow and agent contract before retrying the original command.',
      'singularity-flow init --check --json')
  ],
  // A step no agent drafts stops every command from reading the configuration. Validate names the
  // step, the agent files that would fix it, and what else the workflows need.
  AGENT_PHASE_UNMAPPED: () => agentMappingSteps(),
  AGENT_PHASE_DEFAULT_MISSING: () => agentMappingSteps(),
  AGENT_PHASE_DEFAULT_AMBIGUOUS: () => agentMappingSteps(),
  WORKFLOW_UNKNOWN: () => [
    step('list-workflows', 'See the workflows this repository has, then name one of them.', 'singularity-flow workflow list', 'diagnostic')
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
  // Within the three-step cap: what SFlow suggests (and the repository routes from there), the
  // A proposed test command that is not the shape publication runs: name the field (the refusal does)
  // and the inspection, which lists commands that are; it had only the generic recover/doctor plan.
  TEST_SETUP_COMMAND_INVALID: () => [
    step('inspect-test-setup',
      'The refusal names what is wrong with the command. See the runners SFlow suggests for this repository (add --source-root <DIRECTORY> for one below the root); inspection runs nothing. Then propose one with --use <SUGGESTION-ID>, or the corrected command in full.',
      'singularity-flow capability test-setup --json', 'diagnostic', '/sf-test-setup')
  ],
  // Story-only command a step approver accepts, and the recheck after either.
  CODE_DELIVERY_TEST_COMMAND_REQUIRED: (argv, error) => {
    const phase = artifactAuthoringPhase(argv, error);
    const workId = safeWorkId(error?.details?.workId) ?? safeWorkId(optionValueRaw(argv, 'work-id'));
    return [
      step('inspect-test-setup',
        'See which runner SFlow suggests for the changed modules (add --source-root <DIRECTORY> for one below the repository root); inspection runs nothing. '
        + `/sf-test-setup then proposes it for every later Story with capability test-setup --step ${phase ?? '<STEP>'}: a configuration approver activates it, and a person who approves this step adopts it here with story test-policy amend --reason TEXT, because refresh alone does not change its pin. `
        + 'If the affected module has an in-scope test script or runner declaration, repairing it within this step\'s scope works too; never suppress tests. A newer runtime may also add native support.',
        'singularity-flow capability test-setup --json', 'diagnostic', '/sf-test-setup'),
      step('request-story-test-command',
        'Or request the exact command that runs this step\'s tests, for this Story only: --use a suggestion, or give --id, --argv \'<JSON ARRAY>\', --working-directory, --affected-root, --adapter and --report. A person who approves the step accepts it from the decision list (/sf-decide); an agent never accepts it.',
        `singularity-flow decision test-command ${workId ?? '<WORK-ID>'} --phase ${phase ?? '<PHASE>'} --use <SUGGESTION-ID> --reason "<why this command tests the step>"`, 'remediation'),
      step('recheck-structured-test-contract',
        'After an accepted Story-only command, an adopted amendment or a real repository/runtime repair, recheck: this read-only check names the resolved runner and does not republish unchanged code. Do not retry publication against unchanged inputs.',
        `singularity-flow phase prepublish${phase ? ` ${phase}` : ''} --json`, 'diagnostic', '/sf-code')
    ];
  },
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
  // Feature coding waits for a passing baseline. The bounded repair runs only the exact reviewed
  // plan and records only a complete pass, so its returned run step is an automatic action.
  TRP_FEATURE_ADMISSION_BLOCKED: (_argv, error) => {
    const workId = safeWorkId(error?.details?.workId);
    return [step('preview-readiness-repair',
      'Preview the bounded readiness repair. It runs nothing and returns the exact plan with its confirmation digest. Repair only dependencies, lockfiles or new tests in scope; existing tests and product code stay unchanged.',
      `singularity-flow story test-policy repair${workId ? ` --work-id ${workId}` : ''} --json`, 'diagnostic'),
    step('run-readiness-repair',
      'Run its returned automatic execute-readiness-repair action once. The kernel runs the reviewed plan at the exact commit and records a checkpoint only when every result passes; it accepts no failure. A failing or changed plan needs repair, not a retry.',
      null, 'remediation')];
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
  SEQUENCE_CONFIRMATION_REQUIRED: (argv, error) => {
    const gate = /^[A-Za-z]+$/.test(error?.details?.gate ?? '') ? error.details.gate : null;
    // The exact command to run: the refused command's own words with this gate's override added,
    // so the text plan shows it as a Shell line, not only a sentence. A command that cannot be
    // shown safely (or a refusal with no command words) keeps the sentence alone.
    const override = gate && argv.length && !argv.includes(`continue:${gate}`)
      ? safeCommandGuidance({ argv: [...argv, '--confirm-override', `continue:${gate}`] })?.command ?? null : null;
    const label = gate
      ? `To continue past this soft gate, run the same command again with --confirm-override continue:${gate} added; the override is recorded. Otherwise take the Story's next step instead.`
      : 'To continue past this soft gate, run the same command again in an interactive terminal and confirm; the override is recorded.';
    return [(override && step('confirm-soft-gate', label, override, 'remediation'))
      ?? step('confirm-soft-gate', label, null, 'remediation')];
  },
  // A live-terminal review (action-authorization.mjs) refused where no terminal is attached: the person
  // runs the same command in their own terminal; recover and doctor could not help (2026-10-28).
  ACTION_TERMINAL_PRESENTATION_REQUIRED: (argv) => {
    const own = argv.length ? step('run-in-own-terminal',
      'This command shows its exact review in a terminal and waits for the person to type the confirmation there. The person runs this same command in their own terminal; an agent never answers it.',
      safeCommandGuidance({ argv: [...argv] })?.command ?? null, 'remediation') : null;
    return own?.command ? [Object.freeze({ ...own, skill: null, copilotCommand: null })] : [];
  },
  APPROVAL_CONFIRMATION_REQUIRED: (argv) => {
    // Without a terminal the person approving adds --yes after reading the review above; the
    // refused command's own words keep its phase and Story. A receipt route never takes --yes.
    const yes = argv.length && !argv.includes('--yes') && !argv.includes('--selection-receipt')
      ? safeCommandGuidance({ argv: [...argv, '--yes'] })?.command ?? null : null;
    const label = 'Without an interactive terminal, the person approving reviews the summary above and runs the same command with --yes added. An agent never adds it for them.';
    // The person's own terminal step: a Copilot route back to /sf-approve re-entered the turn that refused.
    const own = yes && step('approve-with-yes', label, yes, 'remediation');
    return [own?.command ? Object.freeze({ ...own, skill: null, copilotCommand: null }) : own
      ?? step('approve-with-yes', label, null, 'remediation')];
  },
  ...Object.fromEntries(APPROVAL_IDENTITY_CODES.map((code) => [code, approvalIdentitySteps])),
  CLARIFICATION_AUTHORITY_REQUIRED: clarificationAuthoritySteps,
  CLARIFICATION_MODE_OFF: (_argv, error) => {
    const phase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error?.details?.phase ?? '')
      ? error.details.phase : null;
    const label = 'Skip clarification questions and recording; continue the phase from approved sources and repository evidence.';
    const command = phase ? `singularity-flow prepare ${phase}` : null;
    // The refusal names the step's own drafting skill; the generic one for `prepare` is the fallback.
    const skill = /^\/sf-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(error?.details?.remediation?.skill ?? '')
      ? error.details.remediation.skill : null;
    return [(skill && step('continue-phase-without-clarification', label, command, 'remediation', skill))
      ?? step('continue-phase-without-clarification', label, command, 'remediation')];
  }
});
/** Every refusal code with its own recovery steps: a test builds each one's plan [no dead-ends]. */
export const KNOWN_REFUSAL_CODES = Object.freeze(Object.keys(KNOWN));


/** Every refusal code with its own registered route (the dead-end audit checks each one). */
export const REMEDIATION_GUIDED_CODES = Object.freeze(Object.keys(KNOWN));

function genericSteps(argv) {
  const command = String(argv?.[0] ?? '').trim();
  const steps = [];
  if (/^[a-z0-9-]+$/.test(command) && !['help', 'about'].includes(command)) {
    steps.push(step('command-help', `Review the supported ${command} forms before retrying.`,
      `singularity-flow ${command} --help`, 'help'));
  }
  steps.push(step('diagnose-repository', 'Run read-only diagnostics for repository, policy, and recovery state.',
    'singularity-flow doctor --json'));
  // The repository's own planner: it answers in any repository (initialized or not, with or without
  // a Story) and from an active workspace. `recommend` needs an active workspace and refuses in a
  // plain `sflow init` repository, so a fallback naming it could only fail there.
  if (!['nextsteps', 'next'].includes(command)) {
    steps.push(step('recommended-next', 'Ask the deterministic planner for the next currently legal action.',
      'singularity-flow nextsteps --json'));
  }
  return steps;
}

/**
 * A plan shows its first three steps. The routes to someone other than the author are never cut
 * to fit: a step approver accepting a run in which no test executed, and raising the issue for an
 * earlier step's owners. One that falls after the first three is kept after them.
 */
export const PLAN_STEP_LIMIT = 3;
export const PLAN_RESERVED_STEP_IDS = Object.freeze(['open-decision-list', 'accept-test-run-risk', 'renew-test-run-risk', 'raise-upstream-issue',
  'decide-conformance-gap', 'return-conformance-gap', 'reuse-recorded-evidence', 'record-fresh-run']);

const CONFORMANCE_GAP_STEP_IDS = Object.freeze({ 'raise-upstream-issue': 'raise-upstream-issue', 'decide-upstream-issue': 'decide-conformance-gap',
  'repair-return': 'return-conformance-gap', 'evidence-reuse': 'reuse-recorded-evidence', 'fresh-recorded-run': 'record-fresh-run' });

/**
 * An honest partial or missing verdict waits for a person, never for a repair of the report: the
 * decision list first (every decision in plain words, as choices), then the first clause's every
 * route and each other clause's decision for scripts, in place of the phase-repair steps.
 */
function conformanceGapSteps(error) {
  const gaps = Array.isArray(error?.details?.conformanceGaps) ? error.details.conformanceGaps.slice(0, 5) : [];
  const list = error?.details?.nextAction?.command?.startsWith('singularity-flow decisions ')
    ? step('open-decision-list', String(error.details.nextAction.label ?? 'Open the decision list.').slice(0, 2000),
      error.details.nextAction.command, 'remediation', '/sf-decide') : null;
  return [list, ...gaps.flatMap((gap, index) => (Array.isArray(gap?.choices) ? gap.choices : []).slice(0, index === 0 ? 4 : 1)
    .map((choice) => (typeof choice?.command === 'string' && CONFORMANCE_GAP_STEP_IDS[choice.kind]
      ? step(CONFORMANCE_GAP_STEP_IDS[choice.kind], String(choice.detail ?? '').slice(0, 2000), choice.command, 'remediation', choice.skill ?? null)
      : null)))].filter(Boolean);
}
// A producer's own `decision test-risk` route: the step approvers renew or record it, so no cap drops it.
const testRunRiskRoute = (entry) => entry?.argv?.[0] === 'decision' && entry?.argv?.[1] === 'test-risk';

function deduplicate(steps) {
  const seen = new Set();
  return steps.filter(Boolean).filter((entry) => {
    const identity = `${entry.label}\u0000${entry.command ?? ''}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).filter((entry, index) => index < PLAN_STEP_LIMIT || PLAN_RESERVED_STEP_IDS.includes(entry.id)
    // The decision list is where a person ends a held Story: a producer's route to it came fourth and
    // was cut, leaving recover and a new-turn reject (route closure, 2026-10-28).
    || /^singularity-flow decisions\s/u.test(entry.command ?? ''));
}

const RETAINED_RETRIES = Object.freeze([['push', 'retry'], ['sync'], ['initiative', 'sync'], ['goal', 'sync'], ['story', 'branch', 'promote']]);

export function refusalRemediationPlan(error, argv = []) {
  // The CLI drops the global --no-model before dispatching; the phase this refusal belongs to is
  // read from the same command words, or a no-model run loses its phase scope.
  argv = stripGlobalModelOptions(argv);
  const code = String(error?.code ?? 'SINGULARITY_FLOW_ERROR');
  if (code === 'WORKFLOW_MARKUP_COMPILER_FAILED') return Object.freeze({
    schemaVersion: 1,
    status: 'blocked', code,
    steps: Object.freeze([
      step('inspect-workflow-compiler-build', 'Inspect the installed SFlow build; this is an internal compiler failure, not a workflow markup or approval-group correction.',
        'singularity-flow about --json', 'diagnostic'),
      step('preserve-workflow-candidate', 'Preserve the unchecked candidate. Repair or align the CLI and VS Code extension, then reopen Create workflow with Copilot for a fresh catalog-bound handoff. Do not import, activate, weaken approval policy or ask the model to rewrite this unchanged failure.', null, 'remediation')
    ]),
    retry: Object.freeze({ label: 'Do not retry until the compiler/build has been repaired or aligned and a fresh designer handoff is available.', automatic: false })
  });
  const hookFailure = error?.details?.remoteFailure?.hook ?? localGitHookFailure({ stderr: error?.message });
  // A refusal that retained its publication names the exact retry (sync, a saved push's
  // `sync <INTENT-ID>` or its older push-subcommand alias, initiative or goal sync, a branch
  // promotion); after the repair that is the way out, where a diagnosis would only describe the hook again.
  const retainedRetry = hookFailure
    ? explicitCommands(error).find((entry) => RETAINED_RETRIES.some((form) => form.every((word, index) => entry.argv?.[index] === word))) ?? null
    : null;
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
        retainedRetry?.command ?? 'singularity-flow doctor --json', retainedRetry ? 'remediation' : 'diagnostic', retainedRetry?.skill ?? null)
    ]),
    retry: Object.freeze({ label: 'Retry only after the hook, command or runtime has changed; preserve the existing Story and exact publication checkpoint.', automatic: false })
  });
  // The branch already holds the publication's exact commit; only finishing it remains (push, and
  // the index refresh that may be what failed). Repeating the phase command would author again on
  // top of a published generation, and generic diagnostics never named the way out.
  if (error?.publicationRefAdvanced === true && error?.publicationRefOutcomeUnknown !== true) {
    const context = phaseRemediationContext(argv, error);
    const workId = context?.workId ?? safeWorkId(error?.details?.workId);
    const commit = /^[0-9a-f]{40,64}$/u.test(String(error.publicationCommit ?? '')) ? error.publicationCommit.slice(0, 12) : null;
    return Object.freeze({
      schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
      status: 'blocked', code,
      ...(context ? { context: Object.freeze({ ...context, strategy: 'roll-forward-exact-commit', retryCommand: null, retrySkill: null }) } : {}),
      steps: Object.freeze([
        step('finish-publication',
          `The publication was committed${commit ? ` (${commit})` : ''} and is retained. Finish it: sync publishes that exact commit and refreshes its files in Git's index. Nothing is authored again.`,
          'singularity-flow sync', 'remediation'),
        step('inspect-recovery',
          'If sync is refused, inspect recovery and apply its safe actions (a stale index lock, index entries that lag the commit).',
          context?.recoveryCommand ?? `singularity-flow recover${workId ? ` ${workId}` : ''} --json`, 'remediation', '/sf-recover')
      ].filter(Boolean)),
      retry: Object.freeze({ label: 'Do not repeat the original command; its commit already exists. Run sync instead.', automatic: false })
    });
  }
  const skillHostBlocked = ['SKP_HOST_ENFORCEMENT_UNAVAILABLE', 'SKP_HOST_DELIVERY_UNCONFIRMED'].includes(code);
  const repositoryRunnerBlocked = code === 'CODE_DELIVERY_TEST_COMMAND_REQUIRED';
  const riskReviewBlocked = ['TRP_PHASE_GATE_BLOCKED', 'TRP_RISK_REVIEW_STALE',
    'TRP_PUBLICATION_PENDING', 'TRP_RISK_ADAPTER_UNAVAILABLE', 'TRP_AUTHORITY_REQUIRED'].includes(code);
  const worktreeHeld = code === 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED';
  // A soft gate names its own way through; generic help and diagnostics only bury it.
  const softGateBlocked = code === 'SEQUENCE_CONFIRMATION_REQUIRED';
  // Approval refused only for want of a terminal: the same command with --yes is the whole answer.
  const approvalTerminalBlocked = code === 'APPROVAL_CONFIRMATION_REQUIRED';
  // Configuration drafts and approval name their own next step; generic help would only bury it.
  const selfGuidedBlocked = ['CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED', 'CONFIGURATION_APPROVE_PROPOSAL_REQUIRED',
    'CONFIGURATION_APPROVE_NOTHING', 'CONFIGURATION_DRAFTS_EMPTY'].includes(code);
  const unknownRecoveryPhase = code === 'RECOVERY_PHASE_UNKNOWN';
  // Refused for who decides, or for an answer the approver still owes: no phase repair, rejection or diagnostics.
  const identityBlocked = APPROVAL_IDENTITY_CODES.includes(code) || code === 'CLARIFICATION_AUTHORITY_REQUIRED'
    || code === 'APPROVAL_CHECKLIST_INCOMPLETE';
  const pinnedTestPolicyBlocked = ['CODE_TEST_RESULT_REQUIRED', 'CODE_TEST_SUPPRESSED'].includes(code)
    && error?.details?.configurationDependency === true;
  const requiredTestBlocked = /^CODE_TEST_[A-Z0-9_]+$/u.test(code)
    || code === 'QUALITY_COMMAND_SOURCE_MUTATION';
  const requiredTestFailure = requiredTestExecutionForRefusal(error)?.failure;
  // The cause lives in an earlier phase's approved input: never "repair the current phase".
  const upstreamInputBlocked = UPSTREAM_INPUT_CODES.has(code);
  const gapSteps = code === 'CONFORMANCE_BLOCKING_VERDICTS' ? conformanceGapSteps(error) : [];
  // An intent amendment proposed after the submission waits for a person: decide it before the phase.
  const amendmentPending = ['STORY_REVIEW_INTERVENING_COMMIT', 'APPROVAL_INTENT_AMENDMENT_PENDING'].includes(code)
    && pendingAmendmentSteps(argv, error).length > 0;
  const conformanceGapBlocked = gapSteps.length > 0;
  const rawPhaseContext = phaseRemediationContext(argv, error);
  const phaseContext = pinnedTestPolicyBlocked && rawPhaseContext
    ? Object.freeze({ ...rawPhaseContext, strategy: 'pinned-test-policy-prerequisite',
      retryCommand: null, retrySkill: null })
    : identityBlocked && rawPhaseContext
      ? Object.freeze({ ...rawPhaseContext, strategy: 'approval-identity', turn: 'current-turn',
        retryCommand: null, retrySkill: null })
    : upstreamInputBlocked && rawPhaseContext
      ? Object.freeze({ ...rawPhaseContext, strategy: 'upstream-input',
        upstreamPhases: upstreamInputContext(argv, error).producers, retryCommand: null, retrySkill: null })
    : conformanceGapBlocked && rawPhaseContext
      // People decide; the decision list opens in this same turn, nothing about the report is repaired.
      ? Object.freeze({ ...rawPhaseContext, strategy: 'person-decides-conformance-gap', turn: 'current-turn', retryCommand: null, retrySkill: null })
    : amendmentPending && rawPhaseContext
      ? Object.freeze({ ...rawPhaseContext, strategy: 'person-decides-intent-amendment', retryCommand: null, retrySkill: null })
      : rawPhaseContext;
  const phaseSteps = phaseContainmentSteps(phaseContext);
  let explicit = explicitCommands(error).map((command, index) => step(
    testRunRiskRoute(command) ? 'renew-test-run-risk' : `producer-${index + 1}`,
    command.label ?? 'Follow the recovery action supplied by the refusing operation.', command.command,
    index === 0 || testRunRiskRoute(command) ? 'remediation' : 'diagnostic', command.skill
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
  const configurationProblemsBlocked = Array.isArray(error?.details?.configurationProblems)
    && error.details.configurationProblems.length > 0;
  const known = (configurationProblemsBlocked ? configurationProblemSteps(error) : KNOWN[code]?.(argv, error) ?? []).filter(Boolean);
  const sessionTransportBlocked = code === 'SESSION_STATE_REFRESH_UNAVAILABLE';
  const authoringIncomplete = code === 'ARTIFACT_AUTHORING_INCOMPLETE' && known.length > 0;
  // A producer action that repeats a known step's exact command adds a second label, not a route.
  const nonDuplicateExplicit = explicit.filter((entry) => !entry?.command
    || !known.some((knownEntry) => knownEntry?.command === entry.command));
  // Phase failures stay inside the phase repair boundary. Exact producer guidance still wins, but
  // broad command help/doctor/recommend fallbacks are reserved for errors that carry no safe phase
  // identity. This makes future uncoded phase refusals recoverable without adding another code-keyed
  // entry here, and keeps approval repair outside the approval-only turn.
  const ordered = conformanceGapBlocked ? gapSteps
    : configurationProblemsBlocked ? [...known, ...nonDuplicateExplicit]
    : selfGuidedBlocked ? [...nonDuplicateExplicit, ...known]
    : sessionTransportBlocked ? [...known, ...nonDuplicateExplicit]
    // A soft gate's alternative to the override is the Story's own next step: name it first.
    : softGateBlocked ? [...nonDuplicateExplicit, ...known]
    : repositoryRunnerBlocked || pinnedTestPolicyBlocked || approvalTerminalBlocked || unknownRecoveryPhase || identityBlocked ? known : skillHostBlocked ? skillHostPrerequisiteSteps(error, phaseContext) : phaseContext
    ? amendmentPending
      // The amendment's decision first, then the instruction that ends an approval turn.
      ? [...known, ...phaseSteps.filter(entry => entry.id === 'leave-approval-turn'),
        ...phaseSteps.filter(entry => entry.id !== 'leave-approval-turn'), ...nonDuplicateExplicit]
    : phaseContext.turn === 'new-turn'
      // Reserve the bounded recovery/new-turn steps before the global three-step presentation cap;
      // arbitrary producer diagnostics must never displace the instruction that ends approval.
      ? riskReviewBlocked || upstreamInputBlocked || worktreeHeld
        ? [known[0], ...phaseSteps.filter(entry => entry.id === 'leave-approval-turn'), ...known.slice(1)]
        // A lapsed test-run risk is renewed by the step's approvers, not rejected: name that first.
        : nonDuplicateExplicit.some(testRunRiskRoute)
          ? [...nonDuplicateExplicit.filter(testRunRiskRoute), ...phaseSteps, ...known, ...nonDuplicateExplicit.filter(entry => !testRunRiskRoute(entry))]
          : [...phaseSteps, ...known, ...nonDuplicateExplicit]
      : upstreamInputBlocked
        ? [...known, ...nonDuplicateExplicit, ...phaseSteps]
      : requiredTestBlocked
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
      : authoringIncomplete
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
        : [...nonDuplicateExplicit, ...known, ...phaseSteps]
    : requiredTestBlocked || upstreamInputBlocked
      ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
    : authoringIncomplete
      ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
      : [...nonDuplicateExplicit, ...known, ...genericSteps(argv)];
  const steps = deduplicate(ordered);
  const retryLabel = skillHostBlocked
    ? 'Do not retry generation, publication, submission or approval until the approved live host controls and exact delivery owner are implemented and qualified. Diagnostics cannot enable execution.'
    : repositoryRunnerBlocked
    ? 'Do not retry unchanged publication. An accepted Story-only command, an in-scope repository runner repair, an updated runtime or a reviewed command amendment must establish the structured contract; then follow the returned preparation or fresh-validation route.'
    : pinnedTestPolicyBlocked
    ? 'Do not retry unchanged publication. Preview a reviewed test-command amendment from corrected approved configuration for the active current code phase. Retain any existing publication and follow the returned preparation or fresh-validation route.'
    : code === 'CLARIFICATION_AUTHORITY_REQUIRED'
    ? 'Record the answer only in this checkout, as a listed member; the author never records it for them.'
    : code === 'APPROVAL_CHECKLIST_INCOMPLETE'
    ? 'Approve again with one answer for every checklist article. Nothing was recorded, and nothing needs rejecting.'
    : identityBlocked
    ? 'Run the same command again only when this checkout decides as a listed member, or let another listed member decide. Nothing was recorded, and nothing needs rejecting.'
    : conformanceGapBlocked
    ? 'Never edit the verdict to clear this check. Approve again once a person has decided each gap on its upstream issue (an accepted risk with an expiry, or a dismissal); a return sends the work back instead. Accepting existing evidence never certifies a run that was not recorded.'
    : amendmentPending && code === 'APPROVAL_INTENT_AMENDMENT_PENDING'
    ? 'Do not retry approval in this turn. Approve once the amendment is decided: this submission as it is once the amendment is rejected, or a revised submission once it is approved.'
    : amendmentPending
    ? 'Do not retry approval in this turn. Approval needs a submission made after the amendment is decided: a revised one once it is approved, or a fresh one once it is rejected.'
    : riskReviewBlocked
    ? 'Inspect the exact risk or repair prerequisite. Only a delegated human can record an eligible exception; normal phase approval stays separate. End an approval-only turn before any review mutation, then re-evaluate in a fresh turn.'
    : phaseContext?.turn === 'new-turn'
    ? 'Do not retry approval in this turn. Repair and resubmit through phase actions, then begin a fresh approval turn.'
    : upstreamInputBlocked
    ? 'Retry only after the approved inputs read ready again: restored to their approved bytes, or replaced by an approved new generation of the earlier phase. Never edit them from this phase.'
    : requiredTestBlocked && requiredTestFailure?.retryCondition === 'runtime-changed'
    ? 'Retry after the test runtime or dependency has actually changed; the same source may then be rechecked. Do not loop against an unchanged environment.'
    : requiredTestBlocked
    ? 'Retry only after the identified test, report, or source-mutation condition is repaired and the current phase is rechecked. Do not repeat an unchanged failing run.'
    : code === 'CLARIFICATION_MODE_OFF'
    ? 'Do not retry clarification recording while the pinned mode is off; continue the phase instead.'
    : approvalTerminalBlocked
    ? 'Nothing was recorded. Run the same command again in an interactive terminal, or with --yes added by the person approving.'
    : softGateBlocked
    ? 'Run it again with the override added, or take the Story\'s next step; repeating it unchanged is refused the same way.'
    : configurationProblemsBlocked
      ? 'Retry the original command once the configuration check reports no problems.'
    : selfGuidedBlocked
      ? 'Nothing was changed. Follow the step above when you are ready.'
    : authoringIncomplete
      ? 'Retry the original command only after the author has corrected every finding and the same read-only prepublish check reports ready.'
      : 'Retry the original command only after the blocking condition is resolved.';
  // A finding the catalog documents names its entry: what it means, its causes and who can act.
  const documentation = specificFindingDocumentation(code);
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked',
    code,
    ...(documentation ? { documentation } : {}),
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
  // A JSON field selector is actionable contract information, not an arbitrary filesystem path.
  const field = (value) => typeof value === 'string' && value.length <= 256
    && /^(?:\$|[a-zA-Z_$][a-zA-Z0-9_$]*(?:\[\d+\]|\.[a-zA-Z_$][a-zA-Z0-9_$]*)*)$/u.test(value) ? value : null;
  const projected = {};
  if (details.execution && typeof details.execution === 'object') projected.execution = compact({
    step: text(details.execution.step), processCode: text(details.execution.processCode), signal: text(details.execution.signal),
    timedOut: typeof details.execution.timedOut === 'boolean' ? details.execution.timedOut : null,
    exitCode: Number.isInteger(details.execution.exitCode) ? details.execution.exitCode : null
  });
  for (const key of ['workId', 'phase', 'currentPhase', 'operation', 'repositoryPath', 'preservation']) if (text(details[key])) projected[key] = text(details[key]);
  // Where a Story's one checkout is on this computer (story-index.mjs), so a surface can go there.
  const checkout = details.storyCheckout;
  if (checkout && typeof checkout === 'object') projected.storyCheckout = compact({
    workId: text(checkout.workId), checkoutPath: text(checkout.checkoutPath), branch: text(checkout.branch),
    sameWorkspace: typeof checkout.sameWorkspace === 'boolean' ? checkout.sameWorkspace : null,
    checkoutPaths: list(checkout.checkoutPaths, text).length ? list(checkout.checkoutPaths, text) : null,
    workspace: checkout.workspace && typeof checkout.workspace === 'object'
      ? compact({ id: text(checkout.workspace.id), name: text(checkout.workspace.name), path: text(checkout.workspace.path) }) : null
  });
  const completed = list(details.completedRepositoryPaths, text);
  if (completed.length) projected.completedRepositoryPaths = completed;
  const retired = list(details.retired, item => item && typeof item === 'object' ? compact({
    from: text(item.from), to: text(item.to), recovery: text(item.recovery),
    removed: typeof item.removed === 'boolean' ? item.removed : null
  }) : null);
  if (retired.length) projected.retired = retired;
  const unavailableDocuments = list(details.unavailableDocuments, item => item && typeof item === 'object'
    ? compact({ id: text(item.id), name: text(item.name) }) : null);
  if (unavailableDocuments.length) projected.unavailableDocuments = unavailableDocuments;
  if (details.cause && typeof details.cause === 'object') projected.cause = compact({
    code: text(details.cause.code), message: text(details.cause.message),
    execution: refusalDetails({ execution: details.cause.details?.execution })?.execution ?? null
  });
  const paths = list(details.paths, text);
  if (paths.length) projected.paths = paths;
  // What a person may pick from (USER_AGENT_MAIN_*: the main agent file).
  const candidates = list(details.candidates, text);
  if (candidates.length) projected.candidates = candidates;
  // Code changed before a generation began: the paths a person reviews, the digest an adoption
  // confirms and the policy that decides between adopting and setting aside (GENERATION_DIRTY_START).
  const changedPaths = list(details.changedPaths, text);
  if (changedPaths.length) {
    projected.changedPaths = changedPaths;
    if (/^sha256:[a-f0-9]{64}$/u.test(details.changeSetDigest ?? '')) projected.changeSetDigest = details.changeSetDigest;
    for (const key of ['dirtyStartPolicy', 'boundary']) if (text(details[key])) projected[key] = text(details[key]);
  }
  // A missing environment file: its environment, path, template and both fixes, so an editor can offer them [ENVF].
  if (text(details.environment) && Array.isArray(details.commands)) {
    const file = (entry) => (entry && typeof entry === 'object' && text(entry.path)
      ? { path: text(entry.path), template: text(entry.template), commands: list(entry.commands, text) } : null);
    Object.assign(projected, { environment: text(details.environment), ...file(details) });
    const files = list(details.files, file);
    if (files.length) projected.files = files;
  }
  // The earlier phases that own the cause, so no surface mistakes them for the phase to repair.
  const upstreamPhases = list(details.upstreamPhases, text);
  if (upstreamPhases.length) projected.upstreamPhases = upstreamPhases;
  const authorities = list(details.authorities, text);
  if (authorities.length) projected.authorities = authorities;
  // The approval checklist articles the approver has not answered yet.
  const articles = list(details.articles, (value) => (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) ? value : null));
  if (articles.length) projected.articles = articles;
  // Retiring a workflow: the live workflows a new default may be, and the Stories that block a delete.
  const workflowId = (value) => (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value) ? value : null);
  const live = list(details.live, workflowId);
  if (live.length) projected.live = live;
  const stories = list(details.stories, (story) => (story && typeof story === 'object' && text(story.id)
    ? compact({ id: text(story.id), status: text(story.status), branch: text(story.branch) }) : null));
  if (stories.length) projected.stories = stories;
  const findings = list(details.findings, (finding) => (finding && typeof finding === 'object' ? compact({
    code: text(finding.code), category: text(finding.category), phase: text(finding.phase), field: field(finding.field),
    path: text(finding.path), status: text(finding.status ?? finding.details?.status),
    upstreamPhase: text(finding.details?.upstreamPhase),
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
  // A run in which no test executed: the step approvers' risk route, so every surface can name it.
  const runRisk = details.testRunRisk;
  // The refusing operation's own next command, when it is a safe Singularity Flow command.
  const next = safeCommandGuidance(typeof details.nextAction === 'string' ? { command: details.nextAction } : details.nextAction ?? {});
  if (next?.command) projected.nextAction = next.command;
  // The commits after a submission that stop its approval, and an undecided amendment among them.
  const shortCommit = (value) => (typeof value === 'string' && /^[0-9a-f]{7,64}$/u.test(value) ? value : null);
  const blockingCommits = list(details.blockingCommits, (entry) => (entry && typeof entry === 'object' && shortCommit(entry.commit) ? compact({
    commit: entry.commit, subject: text(entry.subject), kind: text(entry.kind),
    amendment: entry.amendment && typeof entry.amendment === 'object' ? compact({ id: text(entry.amendment.id),
      action: text(entry.amendment.action), status: text(entry.amendment.status) }) : null
  }) : null)).slice(0, 10);
  if (blockingCommits.length) {
    projected.blockingCommits = blockingCommits;
    if (Number.isSafeInteger(details.blockingCommitCount)) projected.blockingCommitCount = details.blockingCommitCount;
  }
  const pendingIntentAmendments = list(details.pendingIntentAmendments, (entry) => (entry && typeof entry === 'object'
    && /^AMD-\d{3,}$/u.test(entry.id ?? '') ? compact({ id: entry.id, commit: shortCommit(entry.commit),
      changedClauses: list(entry.changedClauses, text).slice(0, 20) }) : null));
  if (pendingIntentAmendments.length) projected.pendingIntentAmendments = pendingIntentAmendments;
  // Each undecided partial or missing clause with its routes, so every surface names the decision.
  const conformanceGaps = list(details.conformanceGaps, (gap) => (gap && typeof gap === 'object' && text(gap.clauseId) ? compact({
    clauseId: text(gap.clauseId), verdict: text(gap.verdict), owner: text(gap.owner), status: text(gap.status), issue: text(gap.issue),
    choices: list(gap.choices, (choice) => (choice && typeof choice === 'object' ? compact({
      kind: text(choice.kind), command: safeCommandGuidance(text(choice.command) ?? {})?.command ?? null, detail: text(choice.detail)
    }) : null))
  }) : null));
  if (conformanceGaps.length) projected.conformanceGaps = conformanceGaps;
  if (runRisk?.eligible === true && text(runRisk.phase) && text(runRisk.commandId)) {
    projected.testRunRisk = compact({ eligible: true, phase: text(runRisk.phase), commandId: text(runRisk.commandId), causeClass: text(runRisk.causeClass),
      decision: text(runRisk.decision), lapsed: text(runRisk.lapsed), command: text(runRisk.command) });
  }
  // A pinned test command that changed, or a narrowed run [TCE:REQ-012, REQ-022]: why, and the route.
  for (const key of ['testCommandPin', 'testNarrowing']) {
    const entry = details[key];
    const words = (value) => (list(value, text).length ? list(value, text).slice(0, 20) : null);
    if (text(entry?.phase) && text(entry.commandId)) projected[key] = compact({ phase: text(entry.phase), commandId: text(entry.commandId),
      pin: text(entry.pin), changes: words(entry.changes), reasons: words(entry.reasons), decision: text(entry.decision), command: text(entry.command) });
  }
  // Located workflow.yml problems, so every surface can point at the exact line and its fix.
  const position = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
  // Stage/retain refuses the same invalid packet that check explains. Do not discard its precise
  // repair fields at the process boundary and send the reviewer back to generic diagnostics.
  const repair = details.repair;
  if (repair && ['repair-packet', 'reload-context'].includes(repair.status)) projected.repair = compact({
    status: repair.status, instruction: text(repair.instruction), reportSha256: text(repair.reportSha256),
    citations: list(repair.citations, entry => entry && typeof entry === 'object' ? compact({
      field: field(entry.field), sourceId: text(entry.sourceId), textSha256: text(entry.textSha256),
      instruction: text(entry.instruction), matchCount: Number.isSafeInteger(entry.matchCount) && entry.matchCount >= 0 ? entry.matchCount : null,
      matchingLines: list(entry.matchingLines, position).slice(0, 10),
      proposedEdit: field(entry.proposedEdit?.field) && position(entry.proposedEdit?.value)
        ? { field: field(entry.proposedEdit.field), value: entry.proposedEdit.value } : null
    }) : null).slice(0, 25),
    mappingTasks: list(repair.mappingTasks, entry => entry && typeof entry === 'object' ? compact({
      code: text(entry.code), sourceId: text(entry.sourceId), scenarioId: text(entry.scenarioId),
      clauseId: text(entry.clauseId), line: position(entry.line), message: text(entry.message)
    }) : null).slice(0, 25)
  });
  const configurationProblems = list(details.configurationProblems, (problem) => (problem && typeof problem === 'object' ? compact({
    code: text(problem.code), file: text(problem.file), line: position(problem.line), column: position(problem.column),
    path: Array.isArray(problem.path) ? problem.path.slice(0, 32).map((part) => (typeof part === 'number' ? part : text(String(part)))) : null,
    message: text(problem.message), fix: text(problem.fix), source: text(problem.source), suggestion: text(problem.suggestion),
    choices: Array.isArray(problem.choices) ? list(problem.choices, text).slice(0, 20) : null
  }) : null));
  if (configurationProblems.length) projected.configurationProblems = configurationProblems;
  // Every located error of a capability application block (start[1].vmOptions …), so an editor can mark each field.
  const applicationErrors = list(details.errors, (entry) => (entry && typeof entry === 'object' && typeof entry.path === 'string'
    && /^(?:(?:start|tests)(?:\[\d+\](?:\.[\w.[\]-]+)?)?)?$/u.test(entry.path) && text(entry.message)
    ? { path: entry.path, message: text(entry.message) } : null));
  if (applicationErrors.length) projected.errors = applicationErrors;
  if (details.modelBudget && typeof details.modelBudget === 'object') {
    const budget = {};
    if (text(details.modelBudget.viewId)) budget.viewId = text(details.modelBudget.viewId);
    for (const key of ['logicalPromptTokensEstimate', 'maximumPromptTokensEstimate', 'maximumOutputBytes',
      'maximumTotalTokens', 'observedTotalTokens', 'providerInputTokens', 'providerOutputTokens']) {
      const value = details.modelBudget[key];
      if (Number.isSafeInteger(value) && value >= 0) budget[key] = value;
    }
    if (Object.keys(budget).length) projected.modelBudget = budget;
  }
  // A visual capture at the wrong size, or profiles still missing evidence, so every surface names them.
  const size = (value) => (Number.isSafeInteger(value?.width) && Number.isSafeInteger(value?.height) ? { width: value.width, height: value.height } : null);
  if (text(details.profileId) && size(details.expected) && size(details.actual)) {
    projected.capture = { profileId: text(details.profileId), expected: size(details.expected), actual: size(details.actual) };
  }
  const uncoveredProfiles = Array.isArray(details.covered) ? list(details.uncovered, text) : [];
  if (uncoveredProfiles.length) projected.uncoveredProfiles = uncoveredProfiles;
  if (details.coverage && typeof details.coverage === 'object') {
    const coverage = compact(Object.fromEntries(['unimplemented', 'testPresenceOnly', 'unclaimedChangedPaths', 'withdrawnButClaimed']
      .map((key) => [key, list(details.coverage[key], text)]).filter(([, entries]) => entries.length)));
    if (coverage) projected.coverage = coverage;
  }
  // An offloaded workspace repository: the confirm-first fresh clone elsewhere (session-storage-refusal.mjs).
  const relocation = details.relocation;
  if (details.offloaded === true && relocation?.requiresConfirmation === true && Array.isArray(relocation.argv)
      && Array.isArray(relocation.useArgv)) {
    projected.offloaded = true;
    projected.relocation = { requiresConfirmation: true, argv: list(relocation.argv, text).slice(0, 16),
      useArgv: list(relocation.useArgv, text).slice(0, 8), path: text(relocation.path) };
  }
  // The decision list: the current list and digest a stale confirmation must be replaced with, the
  // summary and exact record command an unconfirmed choice needs, who decides a refused item, and
  // what a part-way failure recorded and left. Plain words and commands only.
  const digest = (value) => (/^sha256:[a-f0-9]{64}$/u.test(value ?? '') ? value : null);
  const packet = details.packet;
  if (packet?.resultType === 'sflow-decisions' && digest(packet.packetSha256)) {
    projected.packet = compact({ resultType: packet.resultType, packetSha256: packet.packetSha256, headline: text(packet.headline),
      status: text(packet.status), record: compact({ recommended: text(packet.record?.recommended), interactive: text(packet.record?.interactive),
        share: text(packet.record?.share) }),
      items: list(packet.items, (item) => (item && typeof item === 'object' ? compact({ id: text(item.id), kind: text(item.kind), title: text(item.title),
        why: text(item.why), decidedBy: text(item.decidedBy?.words),
        options: list(item.options, (option) => (option && typeof option === 'object' ? compact({ id: text(option.id), label: text(option.label),
          recommended: option.recommended === true }) : null)) }) : null)).slice(0, 20) });
  }
  if (digest(details.packetSha256)) projected.packetSha256 = details.packetSha256;
  const summary = list(details.summary, text);
  if (summary.length) projected.summary = summary;
  if (details.record && typeof details.record === 'object' && text(details.record.command)) {
    projected.record = compact({ command: safeCommandGuidance({ command: details.record.command })?.command ?? null,
      recordInChat: typeof details.record.recordInChat === 'boolean' ? details.record.recordInChat : null });
  }
  const decisionItems = (value) => list(value, (entry) => (entry && typeof entry === 'object' ? compact({ item: text(entry.item), kind: text(entry.kind),
    title: text(entry.title), record: text(entry.record), words: text(entry.words), share: text(entry.share) }) : null));
  for (const key of ['refused', 'recorded', 'remaining']) {
    const entries = decisionItems(details[key]);
    if (entries.length) projected[key] = entries;
  }
  if (details.decisions && typeof details.decisions === 'object' && text(details.decisions.headline)) {
    projected.decisions = compact({ headline: text(details.decisions.headline),
      count: Number.isSafeInteger(details.decisions.count) ? details.decisions.count : null });
  }
  // A stale or unconfirmed recreate-sync apply: the current list and digest a person must review.
  const recreate = details.preview;
  if (recreate?.resultType === 'sflow-configuration-recreate-sync' && /^sha256:[a-f0-9]{64}$/u.test(recreate.confirmation ?? '')) {
    projected.preview = compact({ resultType: recreate.resultType, confirmation: recreate.confirmation, baseCommit: text(recreate.baseCommit),
      proposalCount: Array.isArray(recreate.proposals) ? recreate.proposals.length : null,
      proposals: list(recreate.proposals, item => item && typeof item === 'object' ? compact({ branch: text(item.branch),
        commit: text(item.commit), merged: typeof item.merged === 'boolean' ? item.merged : null, author: text(item.author),
        summary: text(item.summary), files: list(item.files, text) }) : null), files: list(recreate.files, text) });
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
        : plan.context.strategy === 'escalate-repeated-finding'
          ? `  Scope: phase ${plan.context.phaseId} — the same finding keeps returning; stop repairing it and hand it to someone other than the author. Nothing was accepted or waived.`
        : plan.context.strategy === 'person-decides-conformance-gap'
          ? `  Scope: phase ${plan.context.phaseId} — people decide what is open; nothing about the report needs repairing. Open the decision list now.`
        : plan.context.strategy === 'person-decides-intent-amendment'
          ? `  Scope: phase ${plan.context.phaseId} — an intent amendment proposed after its submission waits for a person's decision; rejecting it lets this phase be approved as submitted, approving it reopens the phase.`
        : plan.context.strategy === 'approval-identity'
          ? `  Scope: phase ${plan.context.phaseId} — who decides, not what is decided; nothing about the work needs repairing.`
        : plan.context.strategy === 'upstream-input'
          ? `  Scope: phase ${plan.context.phaseId} — the cause is an approved input from ${plan.context.upstreamPhases?.join(', ') || 'an earlier phase'}; do not edit it here. Restore its approved bytes or use that phase's return or amendment route.`
        : `  Scope: phase ${plan.context.phaseId} — repair in place; no automatic advance or history rewrite.`
    );
    if (plan.context.turn === 'new-turn') {
      lines.push('  Turn boundary: end the current approval turn; remediation starts in a new turn.');
    }
  }
  for (const [index, entry] of plan.steps.entries()) {
    lines.push(`  ${index + 1}. ${entry.label}`);
    if (entry.command) {
      const modelFreeCommand = safeCommandGuidance(entry)?.modelFreeCommand ?? null;
      lines.push(...commandRouteLines({ ...entry, modelFreeCommand }, '     '));
    }
  }
  if (plan.escalation) for (const route of plan.escalation.routes) {
    lines.push(`  ${route.kind === 'dispute' ? 'Dispute' : route.kind === 'documentation' ? 'Read' : 'Inspect'} (${route.owner}): ${route.command}`);
  }
  if (plan.documentation) lines.push(`  Documentation: ${plan.documentation.command}`);
  lines.push(`  Then: ${plan.retry.label}`);
  return lines.join('\n');
}
