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
import { repairContinuationForPinChange, repairContinuationForTestFailure } from './phase-finding-policy.mjs';
import { repairContinuationForFindings } from './findings/repair-continuation.mjs';
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
    // A capability proposal conflict: discard at the exact commit, make the change again, review (C4).
    details?.discardAction,
    details?.remapAction,
    details?.reviewAction,
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
    if (!value?.command && !Array.isArray(value?.argv)) return null;
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

const shellWord = (word) => (/^[A-Za-z0-9_./:@%+=,<>-]+$/u.test(word) ? word : `'${String(word).replaceAll("'", `'"'"'`)}'`);
const retriedCommand = (argv, extra = []) => ['singularity-flow', ...argv.filter((word) => word !== '--for-agent' && word !== '--json'), ...extra].map(shellWord).join(' ');

/** What an appeal still needs, from what was typed; a person's list where it holds the same question. */
function appealNeedsSteps(argv, error) {
  const details = error?.details ?? {};
  const needs = details.needs ?? [];
  const workId = safeWorkId(details.workId);
  const list = workId ? step('decide-unclaimed-paths', 'A person says where each changed path belongs on the decision list, with their reason; it records the plan amendment.',
    `singularity-flow decisions ${workId}`, 'remediation', '/sf-decide') : null;
  if (needs.includes('changes')) {
    const phase = lowerKebab(details.phase);
    const unclaimed = details.unclaimedPaths?.length > 0;
    return [unclaimed ? list : null, step('name-appeal-location', 'Name the clause a changed path serves, and why the plan changes. It only prepares a packet for review: nothing is recorded.',
      `singularity-flow appeal prepare${phase ? ` --phase ${phase}` : ''} --add-location <CLAUSE>=<PATH> --reason <REASON>`, 'remediation', '/sf-appeal'),
    unclaimed ? null : phase ? step('continue-the-step', 'Nothing here needs an appeal: carry on with the step and its own check.',
      `singularity-flow phase prepublish ${phase} --for-agent --json --publish-if-ready`, 'remediation', '/sf-code') : null];
  }
  if (needs.includes('supporting-reason')) {
    return [step('name-appeal-supporting-reason', 'The same command, with the reason each supporting path needs.', retriedCommand(argv, ['--supporting-reason', '<WHY>']), 'remediation', '/sf-appeal'), list];
  }
  return [];
}

/** A file an appeal names that is not there yet: a person's pin where that is what it is, else create it and run the same command. */
function appealMissingFileSteps(argv, error) {
  const details = error?.details ?? {};
  if (!details.missingPath) return [];
  const pin = details.nodePin;
  const workId = safeWorkId(details.workId);
  return [pin && workId ? step('pin-node-version', `A person chooses Pin Node ${pin.version}: it creates ${pin.file} and amends the plan in one step, with their reason. An agent cannot record it.`,
    `singularity-flow decisions ${workId}`, 'remediation', '/sf-decide') : null,
  step('rerun-appeal-once-created', `Create ${details.missingPath}, then run this again: an appeal accounts for a change, and that file is not one yet.`, retriedCommand(argv), 'remediation', '/sf-appeal'),
  // Who creates it: the turn that edits code.
  Object.freeze({ ...step('create-appealed-file', `Create ${details.missingPath} in this step's own code turn.`, null, 'remediation'), skill: '/sf-code', copilotCommand: '/sf-code' })];
}

/** `session current` with what it does not take: the selection it was reaching for is a command of its own, and the read needs nothing. */
function sessionOptionsSteps(argv) {
  const workspace = argv[argv.indexOf('--workspace') + 1];
  return [argv.includes('--workspace') && workspace && !workspace.startsWith('--') ? step('select-workspace', 'Select that workspace, then read the binding it gives.',
    `singularity-flow session workspace ${shellWord(workspace)}`, 'remediation', '/sf-session') : null,
  step('read-current-binding', 'Run it as it is: it reads the binding, and takes no other option.', 'singularity-flow session current --for-agent --json', 'remediation', '/sf-session')];
}

/** No repository is active: selecting one is the way through, and the list says which. */
const sessionRepositorySteps = () => [
  step('select-workspace', 'Select the workspace that holds this work; a person names it if there are several.', 'singularity-flow session workspace <WORKSPACE>', 'remediation', '/sf-session'),
  step('list-workspaces', 'The workspaces this machine knows.', 'singularity-flow workspace list --json', 'diagnostic', '/sf-workspaces')
];

/** A source-review step with a flag only its entry takes: the same command without it. */
const reviewSourceOptionSteps = (argv) => (['stage', 'submit', 'decide'].includes(argv[1]) ? [step('run-without-agent-flag', 'The same command without --for-agent: this one keeps its own authority boundary.',
  retriedCommand([...argv]), 'remediation', '/sf-review-source')] : []);

/** The plan's own correction and the upstream issue to its approvers, from a refusal's planCorrections. */
function planCorrectionSteps(corrections) {
  const list = Array.isArray(corrections) ? corrections : [];
  const correction = list.find((entry) => / decision plan /u.test(entry?.command ?? ''));
  const raise = list.find((entry) => / upstream-issue raise /u.test(entry?.command ?? ''));
  return [correction ? step('correct-plan-row', String(correction.label ?? '').slice(0, 2000), correction.command, 'remediation') : null,
    raise ? step('raise-upstream-issue', String(raise.label ?? '').slice(0, 2000), raise.command, 'remediation', '/sf-decide') : null].filter(Boolean);
}

const APPEAL_ROUTES = Object.freeze({ PHASE_APPEAL_INVALID: appealNeedsSteps, PHASE_APPEAL_PATH_UNSUPPORTED: appealMissingFileSteps,
  SESSION_AGENT_OPTIONS_INVALID: sessionOptionsSteps, SESSION_REPOSITORY_REQUIRED: sessionRepositorySteps, REVIEW_SOURCE_OPTIONS_INVALID: reviewSourceOptionSteps });

function requiredTestFailureSteps(argv, error) {
  const context = phaseRemediationContext(argv, error);
  const failure = requiredTestExecutionForRefusal(error)?.failure;
  const pin = error?.details?.nodePin;
  const other = error?.details?.otherNode;
  const tryNode = (version) => step('try-node-version',
    `Find out whether the tests pass on Node ${version}: it runs them once on a throwaway copy of this checkout and records nothing as evidence.`,
    `singularity-flow tests node --work-id ${context.workId} --phase ${context.phaseId} --node ${version}`, 'diagnostic');
  return [
    ...(pin && context?.workId ? [step('pin-node-version',
      `A person chooses ${pin.replaces ? `to change ${pin.file} to Node ${pin.version}` : `Pin Node ${pin.version}`}: ${pin.words} Node ${pin.node} is installed here. Choosing it ${pin.replaces ? 'changes' : 'creates'} ${pin.file} and amends the plan in one step, with their reason; an agent cannot record it. Show them this, then rerun the gate once it is recorded.`,
      `singularity-flow decisions ${context.workId}`, 'remediation', '/sf-decide'),
    tryNode(pin.version)] : []),
    // What clears a failed test is repairing it here and running the same gate, so that comes before any read.
    step('repair-required-test',
      failure?.guidance ?? 'Repair the reported test failure or runtime condition before retrying. Do not repeat an unchanged failing run.',
      context?.phaseId ? `singularity-flow phase prepublish ${context.phaseId} --for-agent --json --publish-if-ready` : null, 'remediation', context?.phaseId ? '/sf-code' : null),
    testRunRiskStep(error),
    ...(!pin && other && context?.workId ? [tryNode(other.version)] : []),
    baseComparisonStep(argv, error, context),
    step('recover-required-test',
      'Inspect the refused phase and its saved test evidence before changing or retrying it.',
      context?.recoveryCommand ?? 'singularity-flow recover --json',
      'diagnostic', '/sf-recover'),
    step('read-saved-test-log',
      'Read the saved error log for the exact failed execution; do not reconstruct a secret-bearing configured command.',
      'singularity-flow logs --level error --tail 20',
      'diagnostic', '/sf-logs')
  ].filter(Boolean);
}

/**
 * A failed run may have nothing to do with this change. The gate never starts a base run itself: it names
 * the read a person or agent can ask for, which runs the command once on the Story's base commit.
 */
function baseComparisonStep(argv, error, context) {
  if (error?.code !== 'CODE_TEST_FAILED' || !context?.workId) return null;
  const commandId = safeWorkId(requiredTestExecutionForRefusal(error)?.commandId);
  return step('compare-with-base',
    'If nothing here names a file this change touched, ask whether it also fails without the change. It runs the same command once on the Story\'s base commit, keeps the answer, records no evidence and refuses nothing. In VS Code it is a button on the Test summary page.',
    `singularity-flow tests base --work-id ${context.workId} --phase ${context.phaseId}${commandId ? ` --command ${commandId}` : ''}`, 'diagnostic');
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
    // The preview restores the most recent rebuild and names it by when it ran; a person never types its plan ID.
    const plan = /^grb-[0-9a-f]{24}$/u.test(String(error?.details?.plan ?? '')) ? error.details.plan : null;
    return [
      step('start-new-story', 'This Story was explicitly retired and stays read-only. Start a new Story with a new ID under the current Flow Policy.',
        'singularity-flow start <WORK-ID> --from-branch <BASE> --title <TITLE>', 'remediation'),
      ...(plan ? [step('preview-governance-restore',
        'Only if the rebuild itself was a mistake: preview restoring the Flow Policy it replaced, a reviewed change for the whole repository.',
        'singularity-flow governance restore --dry-run')] : [])
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
 * An approver must answer. They answer in their own clone, under their own Git identity, and the
 * author's checkout records it (clarification-remote.mjs); borrowing the author's checkout under a
 * swapped identity was the only way before 2026-10-28.
 */
function clarificationAuthoritySteps(argv, error) {
  const details = error?.details ?? {};
  const phase = lowerKebab(details.phase) ?? artifactAuthoringPhase(argv, error);
  const workId = safeWorkId(details.workId);
  return [
    step('answer-in-own-clone',
      `Only a member of ${eligibleDeciders(details)} can answer. They answer in their own clone, in their own terminal; the answer is sent as its own small commit, never on the Story branch.`,
      `singularity-flow clarification answer ${phase ?? '<PHASE>'} --question "<QUESTION>" --answer "<ANSWER>"`, 'remediation'),
    step('import-answers', `Then this checkout records the answers that bind this step${workId ? ` of ${workId}` : ''}, checking who sent each.`,
      `singularity-flow clarification import ${phase ?? '<PHASE>'}`, 'remediation'),
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

const AUTO_FLIGHT_ID = /^AFL-[A-F0-9]{26}$/u;
const AUTO_PLAN_ID = /^APL-[A-F0-9]{26}$/u;

/** The flight an Auto refusal is about: its details, `--flight`, or the flight a flight command names. */
function autoFlightId(argv, error) {
  const named = argv?.[0] === 'auto' && ['status', 'report', 'pause', 'stop', 'halt', 'takeover', 'resume', 'compare', 'repair'].includes(argv[1]) ? argv[2] : null;
  return [error?.details?.flightId, optionValueRaw(argv, 'flight'), named].find((value) => AUTO_FLIGHT_ID.test(String(value ?? ''))) ?? null;
}

/** The Story an Auto refusal is about: its details, or the Story `auto recover|continue` names. */
function autoStoryId(argv, error) {
  const named = argv?.[0] === 'auto' && ['recover', 'continue'].includes(argv[1]) ? argv[2] : null;
  return safeWorkId(error?.details?.workId) ?? safeWorkId(named);
}

/** A Plan that cannot start: read it, then plan again. */
function autoPlanAgainSteps(argv, why, workId = null) {
  const positional = argv?.[0] === 'auto' && argv[1] === 'start' ? argv[2] : null;
  const planId = [optionValueRaw(argv, 'plan'), positional].find((value) => AUTO_PLAN_ID.test(String(value ?? ''))) ?? null;
  return [
    planId && step('read-auto-plan', `Read the Plan. ${why}`, `singularity-flow auto show-plan ${planId}`, 'diagnostic'),
    step('plan-again', `${planId ? '' : `${why} `}Make a new Plan for the same requirement${workId ? ', naming its Work ID' : ''}, then start that one.`,
      `singularity-flow auto plan "<REQUIREMENT>"${workId ? ` --work-id ${workId}` : ''}`, 'remediation')
  ];
}

function localSyncSteps(argv, error) {
  const retry = safeCommandGuidance({ argv });
  return [step('preserve-local-story-work', error?.message ?? 'Preserve the local work yourself; nothing was changed.', null, 'remediation'),
    retry && step('retry-after-preserving', 'Then open the Story again.', retry.command, 'diagnostic')];
}

/**
 * A retained evidence file that is not the image its step published (a refused witness, or a later
 * step's commit that would change it): the person restores the published bytes with Git, or the step
 * that owns the evidence publishes a new image through the route the refusal computed. A refusal at
 * release named neither, and no command matched its advice (ws-graph AC-001, 2026-10-27).
 */
function retainedEvidenceSteps(error, retry) {
  const details = error?.details ?? {};
  const evidence = Array.isArray(details.retainedEvidence) ? details.retainedEvidence[0] : null;
  if (!evidence || typeof evidence.path !== 'string') return [];
  const route = (Array.isArray(details.routes) ? details.routes : [])
    .find((entry) => typeof entry?.command === 'string' && typeof entry?.label === 'string');
  const note = (Array.isArray(details.notes) ? details.notes : []).find((entry) => typeof entry === 'string');
  return [
    typeof evidence.restore === 'string' ? step('restore-published-evidence',
      `To keep the image ${evidence.publishedBy} published, restore it in your own terminal with ${evidence.restore}, then ${retry}.`.slice(0, 2000), null, 'remediation') : null,
    route ? step(route.kind === 'upstream-issue' ? 'raise-upstream-issue' : 'republish-evidence', route.label.slice(0, 2000), route.command, 'remediation')
      : note ? step('republish-evidence', note.slice(0, 2000), null, 'remediation') : null
  ];
}

/** The Story `decision witness-exception` named: its positional, else --work-id; never another command's word. */
function witnessExceptionWorkId(argv) {
  const positional = argv?.[0] === 'decision' && argv?.[1] === 'witness-exception' && !String(argv?.[2] ?? '').startsWith('-') ? argv[2] : null;
  return safeWorkId(positional) ?? safeWorkId(optionValueRaw(argv, 'work-id'));
}

// SDA and its sweep added refusal codes no plan read (sweep batch 5 coverage). A lock whose owner
// only a person can end is planned before KNOWN (reviewedLockReleasePlan); these name the read of a
// lock whose holder still runs here, or whose release needs the token that read prints.
const LOCK_KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const LOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function lockReadCommand(error, { file = false } = {}) {
  const details = error?.details ?? {};
  const subject = details.subject;
  if (!file && LOCK_KIND.test(subject?.kind ?? '') && LOCK_ID.test(subject?.id ?? '')) {
    return `singularity-flow lock show ${subject.kind} ${subject.id}`;
  }
  return file && typeof details.lock === 'string' && details.lock.length < 1024
    ? safeCommandGuidance({ argv: ['lock', 'show-file', details.lock] })?.command ?? null : null;
}
function heldLockSteps(label, options) {
  return (_argv, error) => [step('review-lock', label, lockReadCommand(error, options), 'diagnostic')];
}
const HELD_HERE = 'A process on this machine holds it and is still renewing it: it ends when that command finishes or is stopped, never by age. Read who holds it (PID, command, last heartbeat), then run the same command again.';
const REVIEW_AGAIN = 'Read the lock again: a release confirms exactly the token this read prints, for the owner it names.';
const DRAFTS_READ = 'singularity-flow configuration drafts';
const draftsStep = (label) => () => [step('read-drafts', label, DRAFTS_READ, 'diagnostic')];
/** A pre-commit publication another command here is still running: its holder, then the subject's own sync. */
function activePublicationSteps(_argv, error) {
  const subject = error?.details?.subject;
  const kind = { initiative: 'initiative sync', goal: 'goal sync', adhoc: 'adhoc sync', story: 'sync' }[subject?.kind];
  const retry = kind && LOCK_ID.test(subject?.id ?? '') ? `singularity-flow ${kind} ${subject.id}` : null;
  return [step('review-publication-holder', `Another command is publishing this right now${error?.details?.pid ? ` (PID ${error.details.pid})` : ''}. `
    + 'Return to that terminal and let it finish or interrupt it; recovery never rolls back a live owner. Read who holds it:', lockReadCommand(error), 'diagnostic'),
  retry && step('sync-again', 'Once it has ended, publish with the subject\'s own sync.', retry, 'remediation')];
}

/**
 * A published code step's own files changed after its publication (changes-after-publication.mjs): keep
 * them in the next draft (a rollover the person confirms, or an approver's return to the step itself once
 * submitted), or the person sets them aside in their own terminal. Never recovery first (N7).
 */
function changedAfterPublicationSteps(details) {
  const include = details?.include ?? details?.nextAction;
  if (!include?.command) return [];
  const keep = step('include-change-in-next-draft', include.label ?? 'Start the next draft that includes the change; the person confirms it.',
    include.command, 'remediation', include.skill ?? null);
  return [
    include.copilotCommand && keep.command ? Object.freeze({ ...keep, copilotCommand: include.copilotCommand }) : keep,
    ...(details.setAside?.command ? [step('set-change-aside', `${details.setAside.label ?? 'Or the person sets the change aside.'} An agent cannot run it.`,
      details.setAside.command, 'remediation')] : [])
  ];
}

const KNOWN = Object.freeze({
  // A documentation topic or question given to `explain --subject`. The refusal names the topic it
  // matches first; these stay for words that match none. Repository diagnostics cannot help here.
  XPL2_SUBJECT_UNKNOWN: () => [
    step('list-documentation-topics', 'List every documentation topic.', 'singularity-flow explain', 'help'),
    step('command-help', 'Review the supported explain forms before retrying.', 'singularity-flow help explain', 'help')
  ],
  // An upstream issue about a step with no approval group: never decidable there. Raise it, or a
  // superseding issue, at the nearest earlier step whose approvers can decide it.
  UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE: (argv, error) => {
    const details = error?.details ?? {};
    const instead = typeof details.decidableStep === 'string' ? lowerKebab(details.decidableStep) : null;
    if (!instead) return [];
    // With the Story it is for: a /sf-decide turn raises one only for its bound Story, so a refusal
    // that carried no workId (raise itself) takes the one the person named (2026-10-29).
    const workId = safeWorkId(details.workId) ?? safeWorkId(optionValueRaw(argv, 'work-id'));
    const about = typeof details.about === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,120}$/u.test(details.about)
      ? details.about : optionValueRaw(argv, 'about');
    const command = details.nextAction?.command ?? `singularity-flow upstream-issue raise${workId ? ` --work-id ${workId}` : ''} --phase ${instead} `
      + `--about ${about && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,120}$/u.test(about) ? about : '<ID|SECTION>'} --problem <TEXT>`;
    return [step(details.issue ? 'supersede-upstream-issue' : 'raise-at-decidable-step',
      `${details.issue ? `Raise the same problem against ${instead}, superseding ${details.issue}` : `Raise it against ${instead}`}: its approvers can decide it.`,
      command, 'remediation', null)].filter(Boolean);
  },
  // A rewritten Story history is put back by the person, with plain Git: never recover (which never
  // checks history) and never a resubmit on the rewritten commits. Its steps were label-only and the
  // three-step cap cut them behind the phase steps, so an approval turn looped on recover (2026-10-29).
  STORY_HISTORY_REWRITTEN: (argv, error) => explicitInstructions(error).slice(0, PLAN_STEP_LIMIT)
    .map((entry, index) => ({ ...entry, id: `restore-recorded-history-${index + 1}` })),
  // The approver refresh's refusals name their own way out; they had only story --help and doctor.
  APR_PUBLICATION_PENDING: (argv) => {
    const workId = safeWorkId(argv?.[0] === 'story' ? argv?.[3] : null) ?? safeWorkId(optionValueRaw(argv, 'work-id'));
    return [step('publish-waiting-commit', 'Publish the Story\'s waiting commit first; if sync says it can never be sent, preview setting it aside.',
      `singularity-flow sync${workId ? ` ${workId}` : ''}`, 'remediation')];
  },
  APR_NOTHING_TO_ADD: () => [step('join-approval-group',
    'The approved configuration adds nobody to this Story\'s groups yet. A person joins the group through approved configuration first; then preview the refresh again.',
    'singularity-flow configuration add-current-identity --target story:<GROUP>', 'remediation')],
  APR_CONFIRMATION_REQUIRED: () => [step('confirm-in-own-terminal',
    'A person in one of the refreshed groups confirms the refresh plan digest in their own terminal; an agent never confirms it.', null, 'remediation')],
  APR_REFRESH_BLOCKED: (argv, error) => (Array.isArray(error?.details?.blockers) ? error.details.blockers : []).slice(0, PLAN_STEP_LIMIT)
    .map((blocker, index) => step(`clear-refresh-blocker-${index + 1}`,
      String(blocker?.words ?? blocker?.label ?? 'Resolve this record before refreshing approvers.').slice(0, 2000),
      typeof blocker?.command === 'string' ? blocker.command : null, 'remediation')),
  // Rolling forward would undo a newer decision: finish the round, or send the Story back on purpose.
  REWORK_ROLL_FORWARD_SUPERSEDED: (argv, error) => {
    const workId = safeWorkId(optionValueRaw(argv, 'work-id')) ?? safeWorkId(error?.details?.workId);
    return [step('finish-rework-round', 'Finish the rework round from its step: the planner names the next legal action.',
      `singularity-flow nextsteps${workId ? ` ${workId}` : ''} --json`, 'remediation')];
  },
  // Another live command holds the Story while it publishes: wait for it, never recover.
  // Its result is read by this command's own words, never another command's [review-submit fix].
  STORY_PUBLICATION_IN_PROGRESS: (argv) => [step('wait-for-publication',
    'Another command is publishing this Story right now. Wait for it to finish, then run the same command once more.',
    `singularity-flow result last --wait${commandWords(argv) ? ` --command "${commandWords(argv)}"` : ''} --for-agent --json`, 'diagnostic')],
  // A waiting commit that cannot be set aside says why, with the person's exact Git step.
  PUBLICATION_SET_ASIDE_REFUSED: (argv, error) => {
    const reason = error?.details?.reason;
    const commit = /^[0-9a-f]{40,64}$/u.test(String(error?.details?.commit ?? '')) ? error.details.commit : null;
    // An Epic's or Initiative's waiting commit names its own branch and sync, never the Story's.
    const initiative = error?.details?.kind === 'initiative' ? safeWorkId(error?.details?.workId) : null;
    if (reason === 'commits-after-it') return [step('move-later-commits',
      `Commits were made on the branch after the waiting one${commit ? ` (${commit.slice(0, 12)})` : ''}. Move them off it first (for example git branch keep-later HEAD, then git reset --keep ${commit ?? '<WAITING-COMMIT>'}), preview the set-aside again, and bring them back with git cherry-pick once the branch is up to date.`, null, 'remediation')];
    if (reason === 'not-checked-out') return [initiative
      ? step('switch-to-initiative-branch', `Switch to the branch ${initiative} (git switch ${initiative}), then preview the set-aside again.`, null, 'remediation')
      : step('switch-to-story-branch', 'Switch to the Story\'s branch (git switch <BRANCH>), then preview the set-aside again.', null, 'remediation')];
    if (reason === 'already-published' || reason === 'no-pending-publication') return [step('sync-story',
      'Nothing is waiting that could be set aside; sync finishes whatever is left.',
      initiative ? `singularity-flow initiative sync ${initiative}` : 'singularity-flow sync', 'remediation')];
    return [];
  },
  RETAINED_EVIDENCE_CHANGED: (argv, error) => retainedEvidenceSteps(error, 'run the same command again'),
  WITNESS_EVIDENCE_UNPUBLISHED: (argv, error) => retainedEvidenceSteps(error, 'witness it again'),
  // A lapsed witness exception: the final check lists the step and the exact exception.
  WITNESS_EXCEPTION_RENEWAL_INVALID: (argv) => {
    const workId = witnessExceptionWorkId(argv);
    return [step('list-final-check', 'The final check names each lapsed exception with its step and mapping digest.',
      `singularity-flow decisions${workId ? ` ${workId}` : ' <WORK-ID>'}`, 'diagnostic', '/sf-decide')];
  },
  WITNESS_EXCEPTION_UNKNOWN: (argv) => {
    const workId = witnessExceptionWorkId(argv);
    return [step('list-final-check', 'Renew only an exception the step\'s current approval recorded; the final check lists them.',
      `singularity-flow decisions${workId ? ` ${workId}` : ' <WORK-ID>'}`, 'diagnostic', '/sf-decide')];
  },
  WITNESS_EXCEPTION_STORY_CLOSED: (argv) => {
    const workId = witnessExceptionWorkId(argv);
    return [step('reopen-final-step', 'Reopen the Story at its final step first; a closed Story renews nothing.',
      `singularity-flow reopen ${workId ?? '<WORK-ID>'} --to <FINAL-STEP> --reason "<why the exception is renewed>"`, 'remediation', '/sf-reject')];
  },
  // A draft citing a constitution article the Story's pin lacks: the author corrects the citation.
  CONSTITUTION_CITATION_INVALID: (argv, error) => {
    const phase = typeof error?.details?.phase === 'string' ? error.details.phase : null;
    return [phase ? step('correct-citation', `Correct or remove each citation the Story's pinned constitution does not contain (${(error.details.errors ?? []).length || 'see the refusal'}), then recheck. An article added since the Story started is not in its pin.`,
      `singularity-flow phase prepublish ${phase} --for-agent --json`, 'remediation', '/sf-phase') : null].filter(Boolean);
  },
  // A draft table or section refused at publish: the same correction prepublish names, as one step.
  // These had only the generic recover/doctor plan (2026-10-29).
  ...Object.fromEntries(['SPEC_PLANNED_TABLE_INVALID', 'SPEC_PLANNED_ROW_REQUIRED', 'SPEC_PLANNED_PATH_SENTINEL_INVALID',
    'SPEC_PLANNED_FULFILLMENT_INVALID', 'SPEC_PLANNED_OBSERVABLE_INVALID', 'SPEC_PLANNED_PATH_ROLE_INVALID',
    'SPEC_PLANNED_EVIDENCE_TYPE_INVALID', 'SPEC_PLANNED_ALLOCATION_INVALID', 'SPEC_VERIFICATION_CONTRACT_INVALID',
    'SPEC_VERIFICATION_INTENT_INVALID', 'SPEC_SUPPORTING_FILE_INVALID', 'SPEC_PUBLICATION_GATE_REFUSED'].map((code) => [code, (argv, error) => {
    const phase = artifactAuthoringPhase(argv, error);
    return [phase ? step('correct-draft', 'Correct what the refusal names in the step\'s draft (it quotes the cell or line and says what belongs there), then recheck; prepublish lists every remaining finding at once.',
      `singularity-flow phase prepublish ${phase} --for-agent --json`, 'remediation', '/sf-phase') : null].filter(Boolean);
  }])),
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
    // A row the plan put in the wrong place is the plan's to correct, never more code [PHR:REQ-003]: its
    // approvers' plan correction, and the upstream issue to them.
    return [list, author, risk, inspect, ...planCorrectionSteps(decision?.complete ? [] : details.planCorrections)].filter(Boolean);
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
  // Reconcile intended Story edits or preserve unrelated bytes before a code publication.
  GENERATION_EXCLUDED_CHANGES_UNRESOLVED: (argv, error) => [
    step('account-story-files', 'For intended Story edits, a plan approver adds the exact paths to existing clause rows with a narrow amendment. The current phase then rechecks and publishes them; earlier approved artifacts stay unchanged.',
      error?.details?.accountingCommand ?? null, 'remediation', '/sf-decide'),
    step('preserve-unrelated-files', 'For unrelated edits, inspect recovery and have the person confirm its exact set-aside-worktree action. It saves a private copy before restoring only those files; nothing is discarded automatically.',
      error?.details?.recoveryCommand ?? null, 'remediation', '/sf-recover')
  ],
  // A published code step's own files changed after publication: kept in its next draft, or set aside (N7).
  CODE_CHANGED_AFTER_PUBLICATION: (argv, error) => {
    const phase = lowerKebab(error?.details?.phase) ?? commandPhase(argv);
    return changedAfterPublicationSteps(error?.details?.nextAction || !phase ? error?.details : { ...error?.details,
      nextAction: { command: `singularity-flow phase rollover ${phase} --json`, skill: '/sf-recover', copilotCommand: `/sf-code ${phase}`,
        label: `To keep the change: start the next draft of ${phase} that includes it. Preview it, and the person confirms.` } });
  },
  // Unrelated changes must be preserved before the lifecycle decision can run.
  LIFECYCLE_WORKTREE_REVIEW_REQUIRED: (argv, error) => [
    // The step's own files changed after its publication: the same in-step repair as submission's (N7).
    ...changedAfterPublicationSteps(error?.details?.changedAfterPublication),
    // The person's way through, from this exact state: nothing else clears a held checkout.
    ...(error?.details?.setAside?.command && !error.details.changedAfterPublication?.setAside ? [step('set-aside-held-changes',
      `A person looks at ${(error.details.setAside.paths ?? []).slice(0, 5).join(', ')}, then runs this in their own terminal. It keeps a private recovery copy of every changed file, then returns exactly those paths to their committed bytes. An agent cannot run it.`,
      error.details.setAside.command, 'remediation')] : []),
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
  SPEC_CLAIM_MAP_UNKNOWN_CLAUSE: (argv, error) => [
    step('list-defined-clauses',
      'List the clauses the Story defines. Cite only those; the phase that defines a clause owns its wording and must not be edited from here.',
      'singularity-flow spec trace --format json'),
    // An approved plan's row for a clause an intent amendment removed: its approvers remove the row [PHR:REQ-002, finding 15].
    error?.details?.kind === 'planned' && /^[A-Z0-9][A-Z0-9._-]{0,63}:[A-Z]{2,4}-\d{3}$/u.test(String(error.details.clause ?? ''))
      ? step('correct-plan-row', `If an approved plan still has a row for ${error.details.clause}, which the specification no longer holds, an approver of that plan removes it in their own terminal.`,
        `singularity-flow decision plan --remove-row ${error.details.clause} --reason <why>`, 'remediation') : null
  ].filter(Boolean),
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
  // A missing or corrupt ledger entry had no route; it blocked Initiative lists, resume, goals and
  // Epic IDs (sweep B3). The ledger is append-only: read the damage, then restore it, never edit it.
  LEDGER_CHAIN_INVALID: () => [
    step('verify-ledger', 'Read every damaged or missing ledger entry and what it breaks; nothing changes.',
      'singularity-flow ledger verify', 'diagnostic'),
    step('restore-ledger-entry', 'With the repository owner, restore the damaged entry from a clone, or the remote state branch history, '
      + 'that still holds it intact. SFlow never rewrites the append-only ledger, and an entry is never edited by hand.', null, 'remediation')
  ],
  // A saved push record that fails its own checks had no route and no discard (sweep B4).
  TRANSPORT_INTENT_INTEGRITY_INVALID: (argv, error) => {
    const file = typeof error?.details?.file === 'string' ? redactDiagnosticText(error.details.file).slice(0, 1000) : null;
    return [
      step('set-aside-damaged-push', `${file ? `Read ${file}` : 'Read the damaged saved push record'}: it never authorizes a push. `
        + 'If its push is still wanted, run the command that saved it again. To stop it being listed, a person moves that file out of the '
        + 'transport outbox in their own terminal; SFlow never deletes it.', null, 'remediation'),
      step('list-saved-pushes', 'List the other saved pushes and every damaged record, with its file; nothing changes.',
        'singularity-flow push status --json', 'diagnostic')
    ];
  },
  // Auto's binding refusals rendered only the generic plan (sweep B7): each names its own recovery.
  AUTO_FLIGHT_BINDING_MISMATCH: (argv, error) => {
    const flight = autoFlightId(argv, error);
    const workId = autoStoryId(argv, error);
    return [
      flight && step('read-auto-flight', 'Read the flight: its Plan, its Story binding and where it stopped. Auto never runs on a binding that does not match its ratified Plan.',
        `singularity-flow auto status ${flight}`, 'diagnostic'),
      flight && step('stop-auto-flight', 'Stop the flight; the Story keeps everything it published.', `singularity-flow auto stop ${flight}`, 'remediation'),
      workId && step('continue-story-by-hand', 'Continue the Story by hand from its own next step.', `singularity-flow nextsteps ${workId}`, 'remediation')
    ];
  },
  AUTO_RECOVERY_CHECKOUT_FAILED: (argv, error) => {
    const workId = autoStoryId(argv, error);
    return workId ? [
      step('continue-story-by-hand', 'Continue the Story without Auto: resume fetches its recorded branch and attaches it here.',
        `singularity-flow resume ${workId} --fetch`, 'remediation'),
      step('retry-auto-recovery', 'Once origin is reachable and still holds the Story\'s recorded branch, recover the flight again.',
        `singularity-flow auto recover ${workId}`, 'diagnostic')
    ] : [step('check-auto-origin', 'Auto recovery could not materialize the Story\'s recorded branch: check that origin is reachable and still holds it.', null, 'remediation')];
  },
  AUTO_STORY_BRANCH_INVALID: (argv) => autoPlanAgainSteps(argv, 'The Plan records no Story branch Git accepts, so it never starts; nothing was started.'),
  AUTO_STORY_BRANCH_UNSUPPORTED: (argv, error) => {
    const workId = safeWorkId(error?.details?.workId);
    return [
      ...autoPlanAgainSteps(argv, 'The Plan records a Story branch that is not its Work ID, and Story start names a new branch by its Work ID; nothing was started.', workId),
      workId && step('start-story-by-hand', 'Or start the Story by hand; its branch is its Work ID.', `singularity-flow start ${workId}`, 'remediation')
    ];
  },
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
  // Findings on changed lines [CQF:REQ-043]: fixed in the code in this turn, then the same check again.
  CODE_QUALITY_FINDINGS: (_argv, error) => {
    const phase = lowerKebab(error?.details?.phase);
    return [step('repair-quality-findings',
      'Fix each finding in details.qualityFindings.findings at its file and line, in the code, without a suppression comment; then run the same check once.',
      phase ? `singularity-flow phase prepublish ${phase} --for-agent --json --publish-if-ready` : null, 'remediation', '/sf-code')];
  },
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
  // Sweep batch 5 coverage: SDA and sweep refusals a person reaches whose throw site may name no route.
  SUBJECT_LOCK_BUSY: heldLockSteps(HELD_HERE),
  WORKSPACE_REGISTRY_BUSY: heldLockSteps(HELD_HERE, { file: true }),
  ACTIVE_WORKSPACE_SELECTION_BUSY: heldLockSteps(HELD_HERE, { file: true }),
  SGOS_AUTHORITY_STORE_BUSY: heldLockSteps(HELD_HERE, { file: true }),
  SUBJECT_LOCK_RELEASE_REFUSED: heldLockSteps(HELD_HERE),
  WORKSPACE_REGISTRY_RELEASE_REFUSED: heldLockSteps(HELD_HERE, { file: true }),
  SGOS_AUTHORITY_LOCK_RELEASE_REFUSED: heldLockSteps(HELD_HERE, { file: true }),
  SUBJECT_LOCK_RELEASE_INVALID: heldLockSteps(REVIEW_AGAIN),
  SUBJECT_LOCK_RELEASE_MISMATCH: heldLockSteps(REVIEW_AGAIN),
  WORKSPACE_REGISTRY_RELEASE_INVALID: heldLockSteps(REVIEW_AGAIN, { file: true }),
  WORKSPACE_REGISTRY_RELEASE_MISMATCH: heldLockSteps(REVIEW_AGAIN, { file: true }),
  SGOS_AUTHORITY_LOCK_RELEASE_MISMATCH: heldLockSteps(REVIEW_AGAIN, { file: true }),
  SGOS_AUTHORITY_LOCK_CORRUPT: () => [step('inspect-authority-store', 'The Authority Store lock record cannot be read. Inspect the store; the lock is never taken over by age.',
    'singularity-flow authority-store status --json', 'diagnostic')],
  SGOS_AUTHORITY_PATH_UNSAFE: () => [step('inspect-authority-store', 'The Authority Store path must stay inside an ordinary Git common directory. Inspect where this store points.',
    'singularity-flow authority-store status --json', 'diagnostic')],
  FACTORY_RESET_IN_PROGRESS: () => [step('review-reset-barrier', 'A repository reinitialization is running. Read who holds it: it ends when that reset finishes, or by the reviewed release this read names when its owner runs elsewhere.',
    'singularity-flow lock show factory-reset-barrier repository', 'diagnostic')],
  FACTORY_RESET_ACTIVE_OPERATIONS: (_argv, error) => {
    const held = (error?.details?.locks ?? []).map((lock) => lock?.owner?.subject).find((subject) => LOCK_KIND.test(subject?.kind ?? '') && LOCK_ID.test(subject?.id ?? ''));
    return [step('review-active-operation', 'Reinitialization waits for every running operation. Read the first one\'s lock; let it finish, or stop it through its own recovery, then preview again.',
      held ? `singularity-flow lock show ${held.kind} ${held.id}` : null, 'diagnostic')];
  },
  TRANSPORT_INTENT_BUSY: (_argv, error) => {
    const intent = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(error?.details?.intentId ?? '') ? error.details.intentId : null;
    return [step('review-saved-push', 'Another command is changing this saved push right now. Read its state, then run its sync again once that command has ended.',
      intent ? `singularity-flow push status ${intent} --json` : 'singularity-flow push status --json', 'diagnostic')];
  },
  GOVERNED_GOAL_PUBLICATION_ACTIVE: activePublicationSteps,
  INITIATIVE_PUBLICATION_ACTIVE: activePublicationSteps,
  BACKUP_DESTINATION_INVALID: () => [step('choose-backup-directory', 'Choose a new or empty directory outside every checkout of this repository; nothing was written.',
    'singularity-flow backup create --out <NEW-OR-EMPTY-DIRECTORY>', 'remediation')],
  BACKUP_INSIDE_CHECKOUT: () => [step('choose-backup-directory', 'A backup holds documents that must never be committed: choose a directory outside this repository and its Story checkouts.',
    'singularity-flow backup create --out <DIRECTORY-OUTSIDE-THE-REPOSITORY>', 'remediation')],
  BACKUP_INVALID: () => [step('inspect-other-backup', 'Nothing was restored. Inspect another copy of the backup, or make a new one with backup create on the laptop it came from.',
    'singularity-flow backup inspect <ANOTHER-COPY>', 'diagnostic')],
  BACKUP_INTEGRITY_FAILED: () => [step('inspect-other-backup', 'Nothing was restored from this damaged copy. Inspect another copy, or make a new one with backup create on the laptop it came from.',
    'singularity-flow backup inspect <ANOTHER-COPY>', 'diagnostic')],
  BACKUP_REPOSITORY_MISMATCH: () => [step('inspect-in-its-repository', 'Run it inside a clone of the repository the backup came from; nothing was restored here.',
    'singularity-flow backup inspect <DIRECTORY>', 'diagnostic')],
  CONFIGURATION_APPROVE_NOTHING: draftsStep('See the drafts that are waiting; propose them before anything can be approved.'),
  CONFIGURATION_DRAFTS_EMPTY: draftsStep('See the drafts and the last proposal this clone holds.'),
  CONFIGURATION_DRAFTS_CHANGED: draftsStep('The drafts changed while this command ran; see them as they are now, then run it again.'),
  CONFIGURATION_DRAFT_UNKNOWN: draftsStep('See each waiting draft with its number and ID.'),
  CONFIGURATION_DRAFT_OPERATION_REUSED: draftsStep('See the draft that holds this operation ID; save a different change under a new --operation-id.'),
  CONFIGURATION_DRAFTS_INVALID: (_argv, error) => [
    step('set-aside-draft', `${typeof error?.details?.file === 'string' ? `Move ${redactDiagnosticText(error.details.file).slice(0, 500)}` : 'Move the unreadable draft file'} out of the drafts folder in your own terminal; nothing in it was proposed.`, null, 'remediation'),
    step('read-drafts', 'Then see the drafts that remain.', DRAFTS_READ, 'diagnostic')],
  CONFIGURATION_DRAFTS_LIMIT: () => [step('propose-drafts', 'Propose the waiting drafts as one review before saving more.', 'singularity-flow configuration propose', 'remediation')],
  STUDIO_NOTHING_TO_PROPOSE: draftsStep('Nothing is waiting: save a change first, then propose it.'),
  WORKFLOW_PROPOSAL_UNAVAILABLE: draftsStep('The proposal is no longer on the remote (merged and deleted, or closed). See what this clone recorded for it.'),
  STUDIO_CHANGES_INVALID: (argv) => {
    const preview = argv.includes('--change-set') && !argv.includes('--dry-run')
      ? safeCommandGuidance({ argv: [...argv.filter((word) => word !== '--propose'), '--dry-run'] })?.command ?? null : null;
    // The person previews their own change set; no Copilot skill runs an arbitrary Studio change set.
    const own = preview && step('preview-studio-changes', 'Preview the same change set: it lists every problem with its location, and nothing is written.', preview, 'diagnostic');
    return [own ? Object.freeze({ ...own, skill: null, copilotCommand: null })
      : step('read-drafts', 'See every draft and the ones that no longer apply.', DRAFTS_READ, 'diagnostic')];
  },
  CONFIGURATION_PROJECTION_BASE_UNAVAILABLE: () => [step('diagnose-network', 'The fetched configuration base could not be read. Check Git access and unfinished workspace setup, then run the command again.',
    'singularity-flow workspace doctor --network --json')],
  REMOTE_UNKNOWN: () => [step('diagnose-network', 'Git did not say why the remote could not be read. Check Git access, proxy and certificates, then run the command again.',
    'singularity-flow workspace doctor --network --json')],
  AUTO_PLAN_INVALID: () => [step('plan-again', 'Plan again with a non-empty requirement within the size limit; a malformed plan is never kept.',
    'singularity-flow auto plan <REQUIREMENT>', 'remediation')],
  SESSION_REPOSITORY_UNAVAILABLE: () => [
    step('list-workspaces', 'See the workspaces this machine knows and the state of each repository.', 'singularity-flow workspace list', 'diagnostic'),
    step('select-workspace', 'Select a workspace repository this machine can read.', 'singularity-flow workspace use <WORKSPACE>', 'remediation')],
  LOCAL_EPIC_RESERVATION_AMBIGUOUS: (_argv, error) => [step('remove-other-reservations',
    `Keep the reservation this branch is for and delete the other reservation files${Array.isArray(error?.details?.reservations)
      ? ` (${error.details.reservations.map((entry) => redactDiagnosticText(String(entry)).slice(0, 200)).join(', ')})` : ''} in your own terminal, then run the same command again.`,
    null, 'remediation')],
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
    // `help <command>` is a read every turn admits; `<command> --help` resolves to the command itself,
    // a mutation for sync, submit, approve and others, which approval, decide and read turns refuse.
    steps.push(step('command-help', `Review the supported ${command} forms before retrying.`,
      `singularity-flow help ${command}`, 'help'));
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
export const PLAN_RESERVED_STEP_IDS = Object.freeze(['open-decision-list', 'accept-test-run-risk', 'renew-test-run-risk', 'raise-upstream-issue', 'correct-plan-row',
  'decide-conformance-gap', 'return-conformance-gap', 'reuse-recorded-evidence', 'record-fresh-run']);

const CONFORMANCE_GAP_STEP_IDS = Object.freeze({ 'correct-report': 'correct-conformance-report', 'raise-upstream-issue': 'raise-upstream-issue', 'decide-upstream-issue': 'decide-conformance-gap',
  'repair-return': 'return-conformance-gap', 'evidence-reuse': 'reuse-recorded-evidence', 'fresh-recorded-run': 'record-fresh-run' });

/**
 * A scope step's statement with no disposition is its approvers' to decide [PHR:REQ-002]: the decision list first,
 * then the first statement's two exact routes (include it through its clauses, or exclude, defer or mark it
 * informative), so a script has them too.
 */
function scopeDispositionSteps(error) {
  const details = error?.details ?? {};
  const list = details.nextAction?.command?.startsWith('singularity-flow decisions ')
    ? step('open-decision-list', String(details.nextAction.label ?? 'Open the decision list.').slice(0, 2000),
      details.nextAction.command, 'remediation', '/sf-decide') : null;
  const ids = ['include-scope-statement', 'decide-scope-statement-otherwise'];
  const routes = (Array.isArray(details.recoveryCommands) ? details.recoveryCommands : []).slice(0, 2)
    .map((entry, index) => (typeof entry?.command === 'string'
      ? step(ids[index], String(entry.label ?? '').slice(0, 2000), entry.command, 'remediation', '/sf-decide') : null));
  return list ? [list, ...routes].filter(Boolean) : [];
}

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
// A return the refusal names to the earlier step that owns its cause, not to the refused step itself [PHR:REQ-004].
const ownerReturnRoute = (entry) => entry?.argv?.[0] === 'reject' && entry.argv.includes('--to')
  && entry.argv[entry.argv.indexOf('--to') + 1] !== entry.argv[1];

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

const RETAINED_RETRIES = Object.freeze([['push', 'retry'], ['sync'], ['initiative', 'sync'], ['goal', 'sync'], ['adhoc', 'sync'], ['story', 'branch', 'promote']]);
const retainedRetry = (entry) => RETAINED_RETRIES.some((form) => form.every((word, index) => entry?.argv?.[index] === word));
/** Refusals that only a retained publication's own sync clears, in any turn: an approval turn too (E10). */
const RETAINED_PUBLICATION_PENDING = new Set(['PUBLICATION_PENDING', 'STORY_PUBLICATION_PENDING', 'STORY_CAPABILITY_PUBLICATION_PENDING',
  'GOVERNED_GOAL_PUBLICATION_PENDING']);

/**
 * The plan for a retained commit: the subject's own sync (an Initiative's is `initiative sync <ID>`,
 * which this plan replaced with the Story's, E11), or, when another clone published first
 * (REVISION_CONFLICT), the set-aside preview: sync sends the same commit under the same lease and
 * never lands it, yet the plan said it "publishes that exact commit" (B2).
 */
function retainedPublicationPlan(error, argv, code, { committed }) {
  const context = phaseRemediationContext(argv, error);
  const routes = explicitCommands(error);
  const setAside = routes.find((entry) => retainedRetry(entry) && entry.argv.includes('--set-aside') && !entry.argv.includes('--confirm')) ?? null;
  const sync = routes.find((entry) => retainedRetry(entry) && !entry.argv.includes('--set-aside'))
    ?? (setAside ? safeCommandGuidance({ argv: setAside.argv.filter((word) => word !== '--set-aside') }) : null);
  const story = !sync || sync.argv[0] === 'sync';
  const workId = context?.workId ?? safeWorkId(error?.details?.workId)
    ?? (story && sync ? safeWorkId(sync.argv[1]) : null);
  const recover = story ? context?.recoveryCommand ?? `singularity-flow recover${workId ? ` ${workId}` : ''} --json` : null;
  const commit = /^[0-9a-f]{40,64}$/u.test(String(error?.publicationCommit ?? '')) ? error.publicationCommit.slice(0, 12) : null;
  const raceLost = committed && error?.outcomeClass === 'REVISION_CONFLICT' && setAside;
  const steps = raceLost ? [
    step('preview-set-aside',
      `Another clone published to this branch first, so the retained commit${commit ? ` (${commit})` : ''} can never be sent as it is, and sync cannot publish it. `
      + 'Preview setting it aside: it is kept, the branch moves to what was published, and the step\'s action is done again there if it still applies. '
      + 'The preview changes nothing; a person confirms the set-aside in their own terminal.', setAside.command, 'remediation', setAside.skill),
    recover && step('inspect-recovery', 'Inspect recovery for what else waits on the Story; nothing is pushed.', recover, 'diagnostic', '/sf-recover')
  ] : [
    step('finish-publication', committed
      ? `The publication was committed${commit ? ` (${commit})` : ''} and is retained. Finish it: sync publishes that exact commit and refreshes its files in Git's index. Nothing is authored again.`
      : 'A retained commit of this subject has not reached its remote yet, and every change waits for it. Publish it first: sync sends that exact commit, and says what to do if it cannot.',
    sync?.command ?? 'singularity-flow sync', 'remediation', sync?.skill),
    recover && step('inspect-recovery',
      'If sync is refused, inspect recovery and apply its safe actions (a stale index lock, index entries that lag the commit).',
      recover, 'remediation', '/sf-recover'),
    !story && setAside && step('preview-set-aside', 'If sync says the commit can never be sent, preview setting it aside; nothing changes.',
      setAside.command, 'diagnostic', setAside.skill)
  ];
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked', code,
    ...(context ? { context: Object.freeze({ ...context, strategy: raceLost ? 'set-aside-retained-commit' : 'roll-forward-exact-commit', retryCommand: null, retrySkill: null }) } : {}),
    steps: Object.freeze(steps.filter(Boolean)),
    retry: Object.freeze({ label: raceLost
      ? 'Do not repeat the original command or sync this commit: the remote moved past it. Once it is set aside, do the step\'s action again if it still applies.'
      : committed ? 'Do not repeat the original command; its commit already exists. Run sync instead.'
        : 'Run the original command again once sync has published the retained commit.', automatic: false })
  });
}

/**
 * A lock only a person can end names its reviewed release (`details.releaseCommand`, SDA M3): the
 * person reads the lock, then runs that exact release in their own terminal; then the command again.
 * Help, doctor or a phase recover met the same lock and looped, and age never ends it (E5/D2).
 */
function reviewedLockReleasePlan(error, code) {
  const release = typeof error?.details?.releaseCommand === 'string'
    ? safeCommandGuidance({ command: error.details.releaseCommand }) : null;
  const [command, form, ...rest] = release?.argv ?? [];
  const confirm = rest.indexOf('--confirm');
  if (command !== 'lock' || !['release', 'release-file'].includes(form) || release.skill || confirm < 1) return null;
  const show = safeCommandGuidance({ argv: ['lock', form === 'release' ? 'show' : 'show-file', ...rest.slice(0, confirm)] });
  const steps = [
    step('release-reviewed-lock', 'Only a person ends this lock: its owner runs on another machine, or here but stopped renewing it, '
      + 'so waiting never frees it. After checking that the process named above no longer works on it, the person runs this '
      + 'exact release in their own terminal; an agent never runs it.', release.command, 'remediation'),
    show && step('review-lock', 'Read the lock first: its owner, machine, last heartbeat and the release it needs.', show.command, 'diagnostic')
  ].filter(Boolean);
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked', code,
    steps: Object.freeze(steps),
    retry: Object.freeze({ label: 'Run the original command again once the lock is released.', automatic: false })
  });
}

export function refusalRemediationPlan(error, argv = []) {
  const code = String(error?.code ?? 'SINGULARITY_FLOW_ERROR');
  // A refusal that holds a step for its own output leads with the repair in that step, in this turn [PHR:REQ-006].
  const ownerStep = ownerStepRemediationPlan(error, stripGlobalModelOptions(argv), code);
  if (ownerStep) return ownerStep;
  const plan = remediationPlanFor(error, argv);
  // A criterion's own failing test is repaired in this step; no step sends its author to recover it [PHR:REQ-006].
  if (code === 'CODE_TEST_FAILED' && error?.details?.criteria?.length) {
    return Object.freeze({ ...plan, steps: Object.freeze(plan.steps.filter((entry) => !leavesTheStep(entry))) });
  }
  return plan;
}

function remediationPlanFor(error, argv = []) {
  // The CLI drops the global --no-model before dispatching; the phase this refusal belongs to is
  // read from the same command words, or a no-model run loses its phase scope.
  argv = stripGlobalModelOptions(argv);
  const code = String(error?.code ?? 'SINGULARITY_FLOW_ERROR');
  const lockRelease = reviewedLockReleasePlan(error, code);
  if (lockRelease) return lockRelease;
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
  const hookRetry = hookFailure ? explicitCommands(error).find(retainedRetry) ?? null : null;
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
        hookRetry?.command ?? 'singularity-flow doctor --json', hookRetry ? 'remediation' : 'diagnostic', hookRetry?.skill ?? null)
    ]),
    retry: Object.freeze({ label: 'Retry only after the hook, command or runtime has changed; preserve the existing Story and exact publication checkpoint.', automatic: false })
  });
  // The branch already holds the publication's exact commit; only finishing it remains (push, and
  // the index refresh that may be what failed). Repeating the phase command would author again on
  // top of a published generation, and generic diagnostics never named the way out.
  if (error?.publicationRefAdvanced === true && error?.publicationRefOutcomeUnknown !== true) {
    return retainedPublicationPlan(error, argv, code, { committed: true });
  }
  // A retained commit waits: its sync is the way on in every turn, never a reject (E10).
  if (RETAINED_PUBLICATION_PENDING.has(code) && explicitCommands(error).some(retainedRetry)) {
    return retainedPublicationPlan(error, argv, code, { committed: false });
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
    'CONFIGURATION_APPROVE_NOTHING', 'CONFIGURATION_DRAFTS_EMPTY', 'XPL2_SUBJECT_UNKNOWN'].includes(code);
  const unknownRecoveryPhase = code === 'RECOVERY_PHASE_UNKNOWN';
  const historyRewritten = code === 'STORY_HISTORY_REWRITTEN' && explicitInstructions(error).length > 0;
  // Refused for who decides, or for an answer the approver still owes: no phase repair, rejection or diagnostics.
  const identityBlocked = APPROVAL_IDENTITY_CODES.includes(code) || code === 'CLARIFICATION_AUTHORITY_REQUIRED'
    || code === 'APPROVAL_CHECKLIST_INCOMPLETE';
  const pinnedTestPolicyBlocked = ['CODE_TEST_RESULT_REQUIRED', 'CODE_TEST_SUPPRESSED'].includes(code)
    && error?.details?.configurationDependency === true;
  const requiredTestBlocked = /^CODE_TEST_[A-Z0-9_]+$/u.test(code)
    || code === 'QUALITY_COMMAND_SOURCE_MUTATION';
  const requiredTestFailure = requiredTestExecutionForRefusal(error)?.failure;
  // A code step's findings loop [CQF:REQ-043]; its held outcomes are a person's, through the refusal's own routes.
  const qualityFindingsBlocked = code === 'CODE_QUALITY_FINDINGS';
  const qualityFindingsHeld = code === 'CODE_QUALITY_FINDINGS_HELD';
  // The cause lives in an earlier phase's approved input: never "repair the current phase".
  const upstreamInputBlocked = UPSTREAM_INPUT_CODES.has(code);
  const gapSteps = code === 'CONFORMANCE_BLOCKING_VERDICTS' ? conformanceGapSteps(error) : [];
  // An intent amendment proposed after the submission waits for a person: decide it before the phase.
  const amendmentPending = ['STORY_REVIEW_INTERVENING_COMMIT', 'APPROVAL_INTENT_AMENDMENT_PENDING'].includes(code)
    && pendingAmendmentSteps(argv, error).length > 0;
  const conformanceGapBlocked = gapSteps.length > 0;
  // A source statement nobody dispositioned waits for the scope step's approvers, in this turn [PHR:REQ-002]: the
  // decision list and the statement's own routes, never "repair the phase" or a rejection.
  const scopeSteps = code === 'SCOPE_ITEMS_UNRESOLVED' ? scopeDispositionSteps(error) : [];
  const scopeDispositionBlocked = scopeSteps.length > 0;
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
    : scopeDispositionBlocked && rawPhaseContext
      ? Object.freeze({ ...rawPhaseContext, strategy: 'person-decides-scope', turn: 'current-turn', retryCommand: null, retrySkill: null })
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
  const known = (configurationProblemsBlocked ? configurationProblemSteps(error) : KNOWN[code]?.(argv, error) ?? APPEAL_ROUTES[code]?.(argv, error) ?? []).filter(Boolean);
  // A planned fulfillment the delivery cannot meet may be the plan's to correct: its approvers' correction and the
  // upstream issue go beside the delivery, never in its place [PHR:REQ-003, finding 14].
  if (['CODE_DELIVERY_EVIDENCE_REQUIRED', 'SPEC_PLANNED_CLAIM_MAP_REQUIRED'].includes(code)) known.push(...planCorrectionSteps(error?.details?.planCorrections));
  const sessionTransportBlocked = code === 'SESSION_STATE_REFRESH_UNAVAILABLE';
  const authoringIncomplete = code === 'ARTIFACT_AUTHORING_INCOMPLETE' && known.length > 0;
  // A published code step's own change after publication: its in-step repair leads any producer read (N7).
  const inStepFirst = authoringIncomplete || (code === 'CODE_CHANGED_AFTER_PUBLICATION' && known.length > 0);
  // A producer action that repeats a known step's exact command adds a second label, not a route.
  const nonDuplicateExplicit = explicit.filter((entry) => !entry?.command
    || !known.some((knownEntry) => knownEntry?.command === entry.command));
  // Phase failures stay inside the phase repair boundary. Exact producer guidance still wins, but
  // broad command help/doctor/recommend fallbacks are reserved for errors that carry no safe phase
  // identity. This makes future uncoded phase refusals recoverable without adding another code-keyed
  // entry here, and keeps approval repair outside the approval-only turn.
  const ordered = conformanceGapBlocked ? gapSteps
    : scopeDispositionBlocked ? scopeSteps
    : configurationProblemsBlocked ? [...known, ...nonDuplicateExplicit]
    : selfGuidedBlocked ? [...nonDuplicateExplicit, ...known]
    : sessionTransportBlocked ? [...known, ...nonDuplicateExplicit]
    // A soft gate's alternative to the override is the Story's own next step: name it first.
    : softGateBlocked ? [...nonDuplicateExplicit, ...known]
    : repositoryRunnerBlocked || pinnedTestPolicyBlocked || approvalTerminalBlocked || unknownRecoveryPhase || identityBlocked || historyRewritten ? known : skillHostBlocked ? skillHostPrerequisiteSteps(error, phaseContext) : phaseContext
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
        // The return to the step that owns the cause leads; recovering this step could not clear it.
        : nonDuplicateExplicit.some(ownerReturnRoute)
          ? [...nonDuplicateExplicit.filter(ownerReturnRoute), ...phaseSteps, ...known, ...nonDuplicateExplicit.filter(entry => !ownerReturnRoute(entry))]
          : [...phaseSteps, ...known, ...nonDuplicateExplicit]
      : upstreamInputBlocked
        ? [...known, ...nonDuplicateExplicit, ...phaseSteps]
      : requiredTestBlocked || qualityFindingsBlocked
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
      : qualityFindingsHeld
        ? [...nonDuplicateExplicit, ...phaseSteps]
      : inStepFirst
        ? [...known, ...phaseSteps, ...nonDuplicateExplicit]
        : [...nonDuplicateExplicit, ...known, ...phaseSteps]
    : requiredTestBlocked || upstreamInputBlocked
      ? [...known, ...nonDuplicateExplicit, ...genericSteps(argv)]
    : inStepFirst
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
    : qualityFindingsBlocked
    ? 'Retry once the listed findings are fixed in the code; the loop has the attempts the refusal names. Never retry unchanged code or add a suppression.'
    : qualityFindingsHeld
    ? 'Do not retry in this turn: a person decides each held finding or scanner (fix it later, or accept it with decision finding-risk). Nothing was published or accepted.'
    : code === 'CAPABILITY_PROPOSAL_VALUE_CONFLICT'
    ? 'Activating this proposal again is refused the same way. Discard it, and activate the new proposal once it is reviewed.'
    : code === 'CLARIFICATION_MODE_OFF'
    ? 'Do not retry clarification recording while the pinned mode is off; continue the phase instead.'
    : approvalTerminalBlocked
    ? 'Nothing was recorded. Run the same command again in an interactive terminal, or with --yes added by the person approving.'
    : softGateBlocked
    ? 'Run it again with the override added, or take the Story\'s next step; repeating it unchanged is refused the same way.'
    : configurationProblemsBlocked
      ? 'Retry the original command once the configuration check reports no problems.'
    : code === 'XPL2_SUBJECT_UNKNOWN'
      ? 'Nothing was changed. Running the same subject again is refused the same way.'
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
    ...(code === 'TEST_COMMAND_PIN_CHANGED' && phaseContext && error.details?.testCommandPin ? {
      repairContinuation: repairContinuationForPinChange(phaseContext, error.details.testCommandPin)
    } : {}),
    ...(requiredTestBlocked && phaseContext && requiredTestExecutionForRefusal(error) ? {
      repairContinuation: repairContinuationForTestFailure(phaseContext, requiredTestExecutionForRefusal(error))
    } : {}),
    ...(qualityFindingsBlocked && phaseContext && error.details?.qualityFindings ? {
      repairContinuation: repairContinuationForFindings(phaseContext, error.details.qualityFindings)
    } : {}),
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
  // A lock only a person can end: who holds it and the exact reviewed release (SDA M3), so every
  // surface can show that owner and that command, not only the message.
  if (text(details.releaseCommand)) {
    const owner = details.owner && typeof details.owner === 'object' ? details.owner : {};
    const liveness = details.liveness ?? owner.liveness;
    Object.assign(projected, compact({
      releaseCommand: text(details.releaseCommand), lock: text(details.lock),
      holder: compact({
        pid: Number.isSafeInteger(owner.pid) ? owner.pid : null, host: text(owner.host),
        machine: text(owner.machineId)?.slice(0, 8) ?? null, since: text(owner.acquiredAt ?? owner.createdAt),
        liveness: text(liveness?.state), reason: text(liveness?.reason), heartbeat: text(liveness?.heartbeat),
        lastHeartbeatAt: text(liveness?.lastHeartbeatAt)
      })
    }));
  }
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
  // A copied value's exact repair, or the values to choose from [agent input repairs]: plain IDs, paths,
  // hashes, numbers and booleans only, bounded, so nothing arbitrary crosses the boundary.
  const repairValue = (value) => ((typeof value === 'string' && value.length <= 512 && /^[\w.:/@+=, -]+$/u.test(value))
    || Number.isSafeInteger(value) || typeof value === 'boolean' ? value : null);
  const proposedEdit = (entry) => (field(entry?.proposedEdit?.field) && repairValue(entry.proposedEdit.value) !== null
    ? { field: field(entry.proposedEdit.field), value: entry.proposedEdit.value } : null);
  const allowedValues = (entry) => { const values = list(entry?.allowed, repairValue).slice(0, 12); return values.length ? values : null; };
  const findings = list(details.findings, (finding) => (finding && typeof finding === 'object' ? compact({
    code: text(finding.code), category: text(finding.category), phase: text(finding.phase), field: field(finding.field),
    path: text(finding.path), status: text(finding.status ?? finding.details?.status),
    upstreamPhase: text(finding.details?.upstreamPhase),
    message: text(finding.details?.message ?? finding.message), recovery: text(finding.recovery?.command),
    proposedEdit: proposedEdit(finding), allowed: allowedValues(finding)
  }) : null));
  if (findings.length) projected.findings = findings;
  const obligations = list(details.evaluation?.issues, (issue) => (issue && typeof issue === 'object' ? compact({
    obligation: text(issue.obligationId), category: text(issue.category), severity: text(issue.severity),
    riskEligible: typeof issue.riskEligible === 'boolean' ? issue.riskEligible : null, repairRoute: text(issue.repairRoute)
  }) : null));
  if (obligations.length) projected.obligations = obligations;
  const gate = projectGateRefusal(details.gate);
  if (gate) projected.gate = gate;
  // A code step's findings on changed lines [CQF:REQ-043]: each a tool's words, bounded and redacted as data.
  const quality = details.qualityFindings;
  if (quality && typeof quality === 'object') {
    const position = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
    projected.qualityFindings = compact({ mode: text(quality.mode), attempt: position(quality.attempt), maximumAttempts: position(quality.maximumAttempts),
      more: Number.isSafeInteger(quality.more) && quality.more > 0 ? quality.more : null,
      findings: list(quality.findings, (finding) => (finding && typeof finding === 'object' ? compact({ id: text(finding.id), tool: text(finding.tool),
        toolVersion: text(finding.toolVersion), rule: text(finding.rule), severity: text(finding.severity), kind: text(finding.kind), file: text(finding.file),
        line: position(finding.line), endLine: position(finding.endLine), message: text(finding.message), fingerprint: text(finding.fingerprint), url: text(finding.url) }) : null)).slice(0, 20),
      unavailable: list(quality.unavailable, (entry) => (entry && typeof entry === 'object' ? compact({ commandId: text(entry.commandId), reason: text(entry.reason) }) : null)).slice(0, 10),
      escalated: list(quality.escalated, text).slice(0, 20) });
  }
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
  // The other suites of the refused run that failed: the refusal's own diagnostic is the first's.
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const otherFailedTests = list(details.otherFailedTests, (entry) => (entry && typeof entry === 'object' && text(entry.commandId) ? compact({
    commandId: text(entry.commandId), attemptId: text(entry.attemptId), status: text(entry.status), exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
    tests: entry.tests && typeof entry.tests === 'object' ? compact({ discovered: count(entry.tests.discovered), passed: count(entry.tests.passed), failed: count(entry.tests.failed), skipped: count(entry.tests.skipped) }) : null,
    causeClass: text(entry.causeClass), cause: text(entry.cause), file: text(entry.file)
  }) : null));
  if (otherFailedTests.length) projected.otherFailedTests = otherFailedTests;
  if (runRisk?.eligible === true && text(runRisk.phase) && text(runRisk.commandId)) {
    projected.testRunRisk = compact({ eligible: true, phase: text(runRisk.phase), commandId: text(runRisk.commandId), causeClass: text(runRisk.causeClass),
      decision: text(runRisk.decision), lapsed: text(runRisk.lapsed), command: text(runRisk.command) });
  }
  // A pinned test command that changed, or a narrowed run [TCE:REQ-012, REQ-022]: why, and the route.
  for (const key of ['testCommandPin', 'testNarrowing']) {
    const entry = details[key];
    const words = (value) => (list(value, text).length ? list(value, text).slice(0, 20) : null);
    const some = (values) => (values.length ? values.slice(0, 20) : null);
    if (text(entry?.phase) && text(entry.commandId)) projected[key] = compact({ phase: text(entry.phase), commandId: text(entry.commandId),
      pin: text(entry.pin), changes: words(entry.changes), restorePaths: words(entry.restorePaths), reasons: words(entry.reasons), decision: text(entry.decision), command: text(entry.command),
      // A changed pin's before and after, and what it drops: already bounded and redacted where they were read.
      diff: some(list(entry.diff, (change) => (change && typeof change === 'object' ? compact({ field: text(change.field), path: text(change.path), selector: text(change.selector), change: text(change.change),
        known: typeof change.known === 'boolean' ? change.known : null, before: text(change.before), after: text(change.after) }) : null))),
      dropped: text(entry.dropped),
      pathNarrowing: some(list(entry.pathNarrowing, (path) => (path && typeof path === 'object' ? compact({ source: text(path.source), runner: text(path.runner), operands: words(path.operands),
        tests: count(path.tests), droppedCount: count(path.droppedCount), dropped: words(path.dropped) }) : null))) });
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
    // A source written as its path: the exact source ID to copy [Story anu-bin, 2026-11-11].
    sourceIds: ((edits) => (edits.length ? edits : null))(list(repair.sourceIds, entry => entry && typeof entry === 'object' && field(entry.proposedEdit?.field)
      && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(entry.proposedEdit?.value ?? '')
      ? { field: field(entry.proposedEdit.field), proposedEdit: { field: field(entry.proposedEdit.field), value: entry.proposedEdit.value } } : null).slice(0, 25)),
    // A mistyped binding's exact values: hashes, IDs, paths and numbers (a reordered list is repaired by
    // "binding": "from-context", which the instruction says) [Story anu-bin, 2026-11-11].
    binding: ((edits) => (edits.length ? edits : null))(list(repair.binding, entry => entry && typeof entry === 'object' && proposedEdit(entry)
      ? { field: field(entry.proposedEdit.field), proposedEdit: proposedEdit(entry) } : null).slice(0, 25)),
    // Every other field whose exact value or choices SFlow knows [agent input repairs].
    repairs: ((edits) => (edits.length ? edits : null))(list(repair.repairs, entry => entry && typeof entry === 'object' && field(entry.field)
      && (proposedEdit(entry) || allowedValues(entry)) ? compact({ field: field(entry.field), message: text(entry.message),
        proposedEdit: proposedEdit(entry), allowed: proposedEdit(entry) ? null : allowedValues(entry) }) : null).slice(0, 25)),
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
  // The criteria an owner-step check names: each clause, its own test and what the check found [PHR:REQ-002].
  const criteria = list(details.criteria, (entry) => (entry && typeof entry === 'object' && text(entry.clauseId) ? compact({
    clauseId: text(entry.clauseId), test: text(entry.test), testSource: text(entry.testSource), commandId: text(entry.commandId), status: text(entry.status),
    findings: Array.isArray(entry.findings) && entry.findings.length ? list(entry.findings, (finding) => (finding && typeof finding === 'object'
      ? compact({ code: text(finding.code), message: text(finding.message) }) : null)).slice(0, 5) : null }) : null)).slice(0, 20);
  if (criteria.length) projected.criteria = criteria;
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
  // A copied confirmation that is not the current one: the exact current value, and whether it was a
  // copying slip (nothing changed) or a real change [copied values]. Digests and plain IDs only.
  const confirmed = details.confirmation;
  if (confirmed && typeof confirmed === 'object' && repairValue(confirmed.expected) !== null && typeof confirmed.expected === 'string') {
    projected.confirmation = compact({ expected: confirmed.expected, given: typeof confirmed.given === 'string' ? text(confirmed.given)?.slice(0, 200) ?? null : null,
      slip: typeof confirmed.slip === 'boolean' ? confirmed.slip : null });
  }
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
  if (Array.isArray(details.needs)) projected.needs = details.needs.map(String).slice(0, 5);
  if (Array.isArray(details.unclaimedPaths)) projected.unclaimedPaths = details.unclaimedPaths.map(String).slice(0, 20);
  if (details.setAside?.command) projected.setAside = { command: details.setAside.command, paths: (details.setAside.paths ?? []).slice(0, 20) };
  if (details.otherNode?.version) projected.otherNode = { version: details.otherNode.version, node: details.otherNode.node };
  if (details.nodePin?.version) projected.nodePin = { file: details.nodePin.file, version: details.nodePin.version, node: details.nodePin.node, running: details.nodePin.running ?? null, ...(details.nodePin.replaces ? { replaces: details.nodePin.replaces } : {}) };
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
      ...(error?.outcomeClass ? { outcomeClass: error.outcomeClass } : {}),
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
  // An owner-step plan reads as the default phase plan, with its own scope line [PHR:REQ-006].
  const ownerScope = OWNER_STEP_SCOPES[plan?.context?.strategy];
  if (ownerScope) {
    return renderRefusalPlan({ ...plan, context: { ...plan.context, strategy: 'repair-current-phase' } }).split('\n')
      .map((line) => (line.startsWith('  Scope: phase ') ? `  Scope: phase ${plan.context.phaseId} — ${ownerScope}` : line)).join('\n');
  }
  const lines = ['Recovery plan:'];
  if (plan.context?.scope === 'phase') {
    lines.push(
      plan.context.strategy === 'external-host-prerequisite'
        ? `  Scope: phase ${plan.context.phaseId} — external host prerequisite; do not rewrite Story evidence or bypass the gate.`
        : plan.context.strategy === 'pinned-test-policy-prerequisite'
          ? `  Scope: phase ${plan.context.phaseId} — pinned test-policy prerequisite; preview a reviewed test-command amendment for the active phase, then follow its preparation or fresh-validation route.`
        : plan.context.strategy === 'escalate-repeated-finding'
          ? `  Scope: phase ${plan.context.phaseId} — the same finding keeps returning; stop repairing it and hand it to someone other than the author. Nothing was accepted or waived.`
        : plan.context.strategy === 'person-decides-scope'
          ? `  Scope: phase ${plan.context.phaseId} — its approvers decide each source statement in the decision list now, then approve; nothing about the work needs repairing.`
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

/**
 * The refusals that hold a step for its own output [PHR:REQ-006]: the one way out is the repair the refusal itself
 * names, in that step and in this turn. The author repairs (`author-repairs-in-step`), or a person who decides for
 * that step decides (`person-decides-in-step`). Never a recover, a return to another step, or the end of the turn,
 * unless the refusal names that as its own repair (a code step's author corrects it in a generation returned to
 * that same step).
 */
const OWNER_STEP_STRATEGIES = Object.freeze({
  CRITERION_TESTS_FAILED: 'author-repairs-in-step',
  CRITERION_TESTS_UNVERIFIED: 'author-repairs-in-step',
  EVIDENCE_STALE_AFTER_SCOPE_REVISION: 'author-repairs-in-step',
  SPEC_ACCEPTANCE_INCOMPLETE: 'author-repairs-in-step',
  INTENT_AMENDMENT_PLAN_UNCORRECTED: 'author-repairs-in-step',
  INTENT_AMENDMENT_PLAN_CORRECTION_INVALID: 'author-repairs-in-step',
  EVIDENCE_INSPECTION_MISSING: 'person-decides-in-step',
  VISUAL_THRESHOLD_EXCEEDED: 'person-decides-in-step',
  INTENT_AMENDMENT_PLAN_STALE: 'person-decides-in-step',
  WITNESS_DEFERRAL_INVALID: 'person-decides-in-step',
  VISUAL_RISK_INVALID: 'person-decides-in-step'
});

const OWNER_STEP_SCOPES = Object.freeze({
  'author-repairs-in-step': 'its own output; its author repairs it here, in this turn. Nothing earlier needs changing.',
  'person-decides-in-step': 'a person who decides for this step decides it here, in this turn; nothing about the work needs repairing first.'
});

/** A step that sends the reader out of the step: recover, a return, or the end of the turn. */
function leavesTheStep(entry) {
  return entry?.id === 'leave-approval-turn' || /^singularity-flow (?:recover|reject) /u.test(entry?.command ?? '')
    || ['/sf-recover', '/sf-reject'].includes(entry?.skill);
}

function ownerStepRemediationPlan(error, argv, code) {
  const strategy = OWNER_STEP_STRATEGIES[code];
  const commands = strategy ? explicitCommands(error) : [];
  if (!commands.length) return null;
  const base = phaseRemediationContext(argv, error);
  const context = base ? Object.freeze({ ...base, strategy, turn: 'current-turn', recoveryCommand: commands[0].command,
    retryCommand: null, retrySkill: null }) : null;
  // A return of this same step to its author is the repair a code step's own output needs once it is submitted.
  const returnsHere = (command) => base?.phaseId && command.command.startsWith(`singularity-flow reject ${base.phaseId} `);
  const steps = commands.map((command, index) => step(index === 0 ? 'repair-in-step' : `repair-in-step-${index + 1}`,
    command.label ?? (returnsHere(command) ? `Return ${base.phaseId} to its own author, who repairs it in a new generation of this same step.`
      : index === 0 ? 'Repair it in this step.' : 'Or this way, in this step.'), command.command, 'remediation', command.skill));
  return Object.freeze({
    schemaVersion: 1, // schema-transient: process-boundary guidance, never persisted
    status: 'blocked',
    code,
    ...(context ? { context } : {}),
    steps: Object.freeze(steps),
    retry: Object.freeze({
      label: strategy === 'person-decides-in-step'
        ? 'Run the same command again once the person has decided; nothing was recorded by the refusal.'
        : 'Run the same command again once the step\'s own output is repaired; nothing was recorded by the refusal.',
      automatic: false,
      ...(context ? { turn: 'current-turn', command: null, skill: null } : {})
    })
  });
}

/** A command's own words, before its first option: what `result last --command` matches. */
function commandWords(argv = []) {
  const end = argv.findIndex((value) => String(value).startsWith('-'));
  return (end < 0 ? argv : argv.slice(0, end)).filter((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(String(value))).slice(0, 4).join(' ');
}
