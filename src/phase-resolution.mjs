/** Shared, read-only recovery choices. A route is not authority or a successful check. */
import { createHash } from 'node:crypto';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { submitRoute } from './submit-route.mjs';
import { canonicalJson } from './records.mjs';
import { renderPlatformCommand, safeCommandGuidance } from './safe-command-guidance.mjs';
import { repairContinuationForIssues, phaseFindingPolicy, phaseFindingCode, phaseFindingIdentity, isArtifactQualityFinding, activeRepairPhase, openScopeAppeal, phaseCorrectionTargets, phaseRepairActionAdmission } from './phase-finding-policy.mjs';
import { findingDocumentation } from './finding-catalog.mjs';
import { DISPUTABLE_GATES } from './phase-finding-dispute-schema.mjs';
import { CONFORMANCE_GAP_RULE, conformanceGapDecisions, upstreamChangeRoutes, upstreamRouteSummary } from './upstream-routes.mjs';
import { latestStepBefore } from './phase-roles.mjs';

const UPSTREAM_INPUT_CODES = new Set(['phase_inputs_not_ready', 'phase.inputs.not-ready',
  'specification_index_untrusted', 'convergence_upstream_artifact_stale']);
// The Agent brief projection could not read the author's brief: fixed in the draft, never escalated.
const AGENT_BRIEF_CODES = new Set(['agent_brief_summary_required', 'agent_brief_preserved_section_required',
  'agent_brief_maximum_bytes_exceeded', 'agent_brief_heading_ambiguous', 'artifact_comment_unclosed']);

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const route = (kind, owner, argv, detail, skill = '/sf-recover') => {
  // Guidance consumes a registered command line, not a platform-executable string with a
  // quoted executable (or PowerShell '&'). Quote only literal values that need it; placeholders
  // remain display-only and safeCommandGuidance supplies platform forms for copyable actions.
  const command = ['singularity-flow', ...argv].map(value =>
    /^[A-Za-z0-9._:/-]+$/u.test(value) || /^<[A-Za-z][A-Za-z0-9._/|-]*>$/u.test(value)
      ? value : renderPlatformCommand([value], 'darwin')).join(' ');
  // A supplied skill that is not the command's own gives way to the canonical one: the mismatch used to
  // null the guidance, and the route lost its Copilot line (route closure, 2026-10-28).
  const commandGuidance = safeCommandGuidance({ command, skill }) ?? safeCommandGuidance({ command });
  return { kind, owner, argv, command, skill: commandGuidance ? commandGuidance.skill ?? null : skill, detail, automatic: false,
    commandGuidance, copilotCommand: commandGuidance?.copilotCommand ?? null };
};

// Test findings an approved test command fixes: the runner cannot be inferred or would be a guess.
const TEST_CONFIGURATION_CODES = new Set(['test_module_ambiguous', 'test_module_uncovered', 'gradle_test_target_required',
  'xcode_test_target_required', 'rust_test_adapter_required']);
// A configured command's own result or suppression problem, when the refusal says configuration owns it.
const TEST_POLICY_CODES = new Set(['code_test_result_required', 'code_test_suppressed']);
const SAFE_ARGUMENT = /^[A-Za-z0-9._:/-]+$/u;

/**
 * Where a test finding goes. Observed-risk inspection exists only under a test-recovery agreement;
 * elsewhere a run in which no test executed goes to the step approvers' test-run risk decision, a
 * runner that cannot be inferred to test setup and a reviewed policy amendment, and a test that ran
 * and failed back to its author. No route marks a test passed.
 */
function testFindingRoute(workflow, phase, finding, code) {
  const workId = workflow.workItem.id;
  const diagnosedFailure = finding.details?.requiredTestExecution?.failure?.kind;
  const repairableFailure = ['failed-tests', 'missing-launcher', 'missing-dependency', 'timeout',
    'suite-failed', 'no-tests', 'invalid-or-missing-report', 'process-failed-with-passing-report'].includes(diagnosedFailure);
  if (!repairableFailure && (workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true)) {
    return route('risk-inspection', 'validation-approval-authority',
      ['story', 'test-policy', 'risks', '--phase', phase.id, '--operation', 'publish', '--json'],
      'Inspect eligible, exact observed risks and runner repair. Unsupported or stale evidence is not a pass.', '/sf-recover');
  }
  const runRisk = finding.details?.testRunRisk;
  const renewal = (finding.details?.testRunRiskRenewals ?? [])[0];
  const decided = runRisk?.eligible === true ? runRisk : renewal;
  const argvSha256 = String(decided?.command ?? '').match(/--argv-sha256 ([a-f0-9]{64})/u)?.[1] ?? null;
  const causeClass = String(decided?.command ?? '').match(/--cause-class ([a-z+-]+)/u)?.[1] ?? null;
  if (decided && SAFE_ARGUMENT.test(String(decided.phase ?? '')) && SAFE_ARGUMENT.test(String(decided.commandId ?? ''))) {
    return route('test-run-risk', 'phase-approval-authority',
      ['decision', 'test-risk', workId, '--phase', decided.phase, '--command', decided.commandId, ...(causeClass ? ['--cause-class', causeClass] : []),
        '--cause', '<cause>', '--reason', '<reason>', '--expires', '<YYYY-MM-DD>', ...(argvSha256 ? ['--argv-sha256', argvSha256] : [])],
      `The environment may be what stopped this run${renewal && decided === renewal ? ', and the decision that let it through lapsed' : ''}. `
      + `Fix the environment and run it again, or a person who approves ${decided.phase} names the cause, why the risk is acceptable and an expiry in their own terminal (an agent cannot). `
      + 'The tests still run every time; only a run with the same environment cause is covered.', null);
  }
  if (TEST_CONFIGURATION_CODES.has(code) || (TEST_POLICY_CODES.has(code) && finding.details?.configurationDependency === true)) {
    return route('runner-setup', phase.id, ['capability', 'test-setup', '--json'],
      'No supported test command covers these paths without a guess. Read the suggestions; an approved test command '
      + '(kind: test, argv, workingDirectory, affectedRoots and a result adapter) is adopted for this Story through a reviewed '
      + '`story test-policy amend --reason <why>`. Tests still run; nothing is marked passed.', '/sf-test-setup');
  }
  if (finding.details?.requiredTestExecution?.failure?.kind === 'model-policy-skipped') {
    return route('test-rerun', phase.id, ['recover', workId, '--phase', phase.id, '--json'],
      'A required test command was not run. When it declares no modelPolicy it is skipped while models are disabled: rerun with the model enabled, '
      + 'or have approved configuration declare modelPolicy: never for it and adopt it with story test-policy amend --reason <why>.');
  }
  return route('test-repair', phase.id, ['recover', workId, '--phase', phase.id, '--json'],
    'Read the saved test output (singularity-flow logs --level error --tail 20), repair the failing test, the implementation or the repository-owned test reporter within this step, then recheck. '
    + 'A test that ran and failed is fixed, never accepted.');
}

/** Closed dispositions, including an honest owner route for an unknown/unsupported blocker. */
export function phaseResolutionChoices(workflow, phase, finding) {
  // The affected input's owner is not the phase executing this repair. Preservation, input
  // restoration and continuation stay on the active consumer, even for older pinned Stories.
  const activePhase = workflow.phases?.[workflow.currentPhase];
  // A finding that names the earlier step owning its cause (details.upstreamPhase) is that step's
  // to correct, as its input is [PHR:REQ-001, REQ-003].
  const named = finding.details?.upstreamPhase;
  const upstreamPhase = named && named !== phase.id && named !== activePhase?.id ? workflow.phases?.[named] ?? null : null;
  const affectedPhase = workflow.phases?.[finding.phaseId ?? finding.phase] ?? upstreamPhase
    ?? (activePhase?.id !== phase.id && phase.status === 'approved' ? phase : null);
  if (activeRepairPhase(workflow, activePhase)) phase = activePhase;
  const workId = workflow.workItem.id;
  const code = phaseFindingCode(finding).toLowerCase();
  const category = String(finding.category ?? '').toLowerCase();
  const recovery = route('inspect', phase.id, ['recover', workId, '--phase', phase.id, '--json'],
    'Inspect the exact preserved state. No automatic commit, discard, approval or retry.');
  const basePolicy = phaseFindingPolicy(finding);
  const foreignApproved = affectedPhase && affectedPhase.id !== phase.id && affectedPhase.status === 'approved';
  const policy = foreignApproved && basePolicy.repairableByProducer
    ? Object.freeze({ ...basePolicy, classification: 'upstream-owner', repair: 'review-approved-input', repairableByProducer: false })
    : basePolicy;
  const preserve = route('preserve-checkpoint', phase.id,
    ['appeal', 'checkpoint', '--work-id', workId, '--phase', phase.id, '--json'],
    'Save private recovery copies of dirty files and the index. No commit, discard, publication or phase advance.', '/sf-appeal');
  let resolution;
  let upstreamReturn = null;
  let gapRoutes = [];
  if (foreignApproved && isArtifactQualityFinding(finding)) {
    resolution = route('pilot-risk-review', `${affectedPhase.id}-approval-authority`,
      ['appeal', 'risk-prepare', '--work-id', workId, '--phase', affectedPhase.id, '--finding', phaseFindingCode(finding),
        '--gate-mode', 'soft', '--expires', '<YYYY-MM-DD>', '--reason', '<why>', '--json'],
      'The approved input stays immutable. Its authority may review this exact retained quality exception; the current phase keeps its work and rechecks. This does not waive tests or change the input.', '/sf-appeal');
  } else if (UPSTREAM_INPUT_CODES.has(code) || category === 'inputs') {
    // The bytes belong to the earlier phase that produced them. Name it, and offer only the routes
    // that can work from here: restore its approved bytes, or its return/amendment route.
    const producer = finding.details?.upstreamPhase ?? finding.details?.phase ?? affectedPhase?.id ?? null;
    const owner = producer && producer !== phase.id ? producer : 'an earlier phase';
    const upstream = producer && producer !== phase.id
      ? upstreamChangeRoutes(workflow, producer, { currentPhaseId: phase.id }) : null;
    const restorable = finding.details?.restorable === true;
    resolution = route(restorable ? 'restore-upstream-input' : 'inspect-upstream-input', restorable ? phase.id : producer ?? phase.id,
      restorable ? ['inputs', 'restore', phase.id] : ['inputs', phase.id, '--dry-run', '--json'],
      `This input comes from ${owner} and must not be edited by ${phase.id}. `
      + (restorable ? 'Preview restoring its exact approved bytes; nothing changes until the plan digest is confirmed. ' : '')
      + `If the approved ${owner} content itself must change: ${upstreamRouteSummary(upstream)}`, '/sf-inputs');
    const legal = upstream?.routes?.[0];
    if (legal) upstreamReturn = { ...route(legal.kind === 'return' ? 'upstream-return' : 'upstream-amendment', producer,
      legal.command.split(' ').slice(1), `${legal.label} The input comes from ${owner}; ${phase.id} must not edit it.`,
      legal.skill ?? '/sf-reject'), command: legal.command };
  } else if (foreignApproved && basePolicy.repairableByProducer) {
    const upstream = upstreamChangeRoutes(workflow, affectedPhase.id, { currentPhaseId: phase.id });
    const legal = upstream.routes.find(choice => choice.kind === 'upstream-issue') ?? upstream.routes[0];
    resolution = legal ? route('upstream-owner', `${affectedPhase.id}-approval-authority`,
      legal.command.split(' ').slice(1), legal.label, legal.skill)
      : route('owner-escalation', `${affectedPhase.id}-approval-authority`,
        ['recover', workId, '--phase', phase.id, '--json'], 'Preserve the current phase. The approved input owner must provide an authenticated correction or reviewed amendment.');
  } else if (code === 'conformance.verdict-incomplete') {
    // Keep the honest verdict. Resolve the issue's actual owner, including evidence/plan/scope
    // defects, rather than assigning every partial clause to its code-producing step.
    const clauseId = finding.details?.clauseId ?? finding.value ?? finding.clauseId ?? '<CLAUSE-ID>';
    const [gap] = conformanceGapDecisions(workflow, phase.id, [{ clauseId, verdict: finding.details?.verdict ?? 'partial', line: finding.line ?? null,
      ...(finding.details?.issueRefs ? { issueRefs: finding.details.issueRefs } : {}) }]);
    const owner = gap.owner ?? latestStepBefore(workflow, phase.id, (candidate) => phaseRequiresCodeDelivery(candidate))?.id ?? '<EARLIER-STEP>';
    if (gap.status === 'decided') {
      resolution = route('upstream-issue-decided', owner, ['upstream-issue', 'list', '--work-id', workId, '--json'],
        `Keep the honest verdict. ${gap.issue} (${gap.outcome}) decides ${clauseId}, so this step can be approved as written.`, '/sf-decide');
    } else {
      const [primary, ...others] = gap.choices.filter((choice) => choice.argv);
      resolution = route(primary.kind === 'raise-upstream-issue' ? 'upstream-issue' : primary.kind, owner, primary.argv,
        `Keep the honest verdict; it publishes. ${owner} owns the gap: ${primary.detail} ${CONFORMANCE_GAP_RULE}`, primary.skill);
      gapRoutes = others.map((choice) => route(choice.kind, choice.owner, choice.argv, choice.detail, choice.skill));
    }
  } else if (code === 'plan_evidence_correction_review_required') {
    resolution = route('human-review', 'plan-approval-authority',
      ['appeal', 'evidence-prepare', '--phase', phase.id, '--path', finding.path ?? '<EVIDENCE-PATH>',
        '--clause', '<CLAUSE-ID>', '--method', 'visual', '--reason', '<reason>', '--json'],
      'Preserve the exact pending evidence. Continue only admitted draft repairs; the plan authority must review its contract before publication. The preview offers a guided local browser review or human terminal. No visual pass or test waiver is implied.', '/sf-appeal');
  } else if (code.startsWith('generation_publication')) {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Inspect the exact retained publication and its authored bytes. Restore authenticated evidence or use a reviewed successor/return; configuration refresh and risk acceptance cannot authenticate a changed publication.', '/sf-doctor');
  } else if (code === 'phase_quality_risk_pending_tests') {
    resolution = route('submission-evidence', phase.id, submitRoute(workflow, phase).command.replace(/^singularity-flow /u, '').split(' '),
      'Collect this published generation\'s fresh tests and observed claims before reviewing quality risk. No tests or evidence are waived.', '/sf-submit');
  } else if (code === 'generation.document.published-changed') {
    resolution = phase.status === 'awaiting_approval'
      ? route('published-document-return', 'phase-approval-authority',
        ['reject', phase.id, '--work-id', workId, '--to', phase.id, '--reason', '<reason>'],
        'Request an authorized return before changing submitted evidence. Preserve both the retained publication and the new draft.', '/sf-reject')
      : route('published-document-restore', phase.id, ['phase', 'show', phase.id, '--show-artifact'],
        'Preserve the new draft separately and restore exact reviewed bytes from the authenticated publication. Submit the restored publication for authorized return if its content needs rework.', '/sf-phase-documents');
  } else if (code === 'specification_claim_map_binding_stale'
      || code === 'specification_claim_map_binding_required') {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Inspect this phase\'s exact published claim binding. Current-generation corruption requires restoration of authenticated bytes or reviewed rework; refreshing configuration or risk acceptance cannot repair it.', '/sf-doctor');
  } else if (code === 'phase_repair_recheck_required') {
    resolution = route('repair-resume', phase.id, ['appeal', 'repair-resume', '--phase', phase.id, '--json'],
      'Resume the same durable attempt and rerun its gates. Do not start a new budget or blindly repeat the interrupted operation.', '/sf-appeal');
  } else if (code.startsWith('phase_repair_journal')) {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Preserve the private repair journal for diagnosis. Never delete or reset it to obtain a new budget.', '/sf-doctor');
  } else if (policy.classification === 'integrity-or-authority'
      || /protected|authority|identity|provenance|snapshot|configuration|integrity|source.boundary/u.test(code)
      || ['configuration', 'integrity'].includes(category)) {
    resolution = route('configuration-owner', 'configuration-authority',
      ['workspace', 'refresh-configuration', '--dry-run'],
      'Preserve the edit. Use the original configuration authority or restore reviewed bytes; an ordinary appeal cannot waive integrity.', '/sf-workspace');
  } else if (/appeal.*(?:path.unsupported|too.large)/u.test(code)) {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'Preserve the exact file. Split an oversized review, or use a qualified owner review for binary, rename, deletion or link changes; ordinary scope accounting cannot approve it.', '/sf-doctor');
  } else if (/appeal.*lifecycle/u.test(code)) {
    resolution = recovery;
  } else if (category === 'appeal' || code.includes('appeal')) {
    resolution = route('human-review', 'plan-approval-authority', ['appeal', 'list', '--phase', phase.id, '--json'],
      'Review the exact retained appeal or request corrections and prepare a successor. This is not phase approval or a risk waiver.', '/sf-appeal');
  } else if (/dirty|worktree|working.tree|staged|index.conflict/u.test(code) || category === 'worktree'
      // Files outside this step's documents: a person's set-aside or move, never a draft edit.
      || code === 'phase_artifact_only_changes' || code === 'phase_source_change_ungoverned') {
    resolution = route('worktree-review', 'human-reviewer', ['recover', workId, '--phase', phase.id, '--json'],
      'Review exact current bytes. Recovery can offer a hash-confirmed scoped commit and revalidation; unrelated edits and the index are preserved. Published work needs an authorized successor.');
  } else if (code === 'generation_excluded_changes_unresolved') {
    resolution = route('plan-amendment', 'plan-approval-authority',
      ['decision', 'plan', workId, '--add-location', `<CLAUSE>=${finding.details?.paths?.[0] ?? '<path>'}`, '--reason', '<why>'],
      'Include each Story edit through a narrow amendment to an existing approved clause, then recheck this phase. Preserve unrelated edits through the hash-confirmed recovery copy. Do not return to Planning, discard bytes or silently publish without these files.', '/sf-decide');
  } else if (code === 'spec_coverage_incomplete' && finding.details?.upstreamDecision?.complete === true) {
    // Every clause still without delivery waits on an open upstream issue: its step's approvers decide.
    const decision = finding.details.upstreamDecision;
    resolution = route('upstream-decision', `${[...new Set(decision.issues.map((entry) => entry.phase))].join('+')}-approval-authority`,
      ['decisions', workId, '--json'],
      `${decision.issues.map((entry) => `${entry.id} (raised against ${entry.phase}) names ${entry.clauses.join(', ')}`).join('; ')}. Its approvers decide it in the decision list: return, plan correction, accepted risk or dismissal. More code from ${phase.id} cannot clear it.`,
      '/sf-decide');
  } else if (code === 'spec_coverage_incomplete' && finding.details?.coverage?.unclaimedChangedPaths?.length) {
    // A scope appeal needs the current open code generation (preparePhaseAppeal's own checks);
    // anywhere else the plan's approvers account for the path with a plan decision instead of a
    // route that would refuse.
    const openCode = openScopeAppeal(workflow, phase, phaseRequiresCodeDelivery(phase));
    resolution = openCode
      ? route('scope-appeal', 'plan-approval-authority', ['appeal', 'prepare', '--phase', phase.id, '--json'],
        'Account for exact unplanned paths through a reviewed scope appeal first. Recheck afterward; only the remaining missing coverage is eligible for pilot risk.', '/sf-appeal')
      : route('plan-amendment', 'plan-approval-authority', ['decision', 'plan', workId, '--add-location', '<clause>=<path>', '--reason', '<why>'],
        'An approver of the plan accounts for each unplanned path under its row. No phase is reset.', '/sf-decide');
  } else if ((category === 'quality-coverage' || code === 'spec_coverage_incomplete')
      && (finding.details?.riskEligible === true || finding.details?.qualityRisk?.eligible === true)) {
    resolution = route('pilot-risk-review', 'phase-approval-authority',
      ['appeal', 'risk-prepare', '--phase', phase.id, '--gate-mode', 'soft', '--expires', '<YYYY-MM-DD>', '--reason', '<why>', '--json'],
      'Preview exact missing coverage. An authorized human may accept it for this pilot phase with an expiry; soft mode alone is no waiver. Tests, review and integrity stay enforced.', '/sf-appeal');
  } else if (category === 'quality-coverage' || code === 'spec_coverage_incomplete') {
    resolution = route('author-correction', phase.id, ['recover', workId, '--phase', phase.id, '--json'],
      'Repair unaccounted scope or invalid evidence through a reviewed successor or plan amendment. Pilot risk cannot waive integrity.');
  } else if (code === 'code_delivery_retained_evidence_missing') {
    // A planned evidence file is this step's deliverable. Say how to make it from this checkout.
    resolution = route('capture-retained-evidence', phase.id, ['phase', 'prepublish', phase.id, '--for-agent', '--json'],
      `Produce ${finding.path ?? 'the planned evidence file'} from this checkout with the tool the plan names (a browser on a loopback port you confirmed free, a simulator or emulator, or a command-line run), bring it to the planned state, save the file at exactly that path, then recheck. A test that captures it saves under its runner's output (for example test-results/) and the file is copied to that path once: a test that saves straight to the path replaces the published file on every later run. Never use a server or device session another checkout runs and never fabricate evidence; the file is not a visual pass, and a person witnesses it after submission.`,
      generationSkillForPhase(phase, workflow));
  } else if (code === 'code_delivery_evidence_required') {
    resolution = route('author-correction', phase.id, ['phase', 'prepublish', phase.id, '--for-agent', '--json'],
      'Finish the delivery this finding lists in the open generation (source, tests, clause tags or planned evidence), then recheck. The test runner is resolved from the change set: no test configuration, amendment or risk review is needed for it.',
      generationSkillForPhase(phase, workflow));
  } else if (code === 'code_delivery_test_command_required') {
    resolution = route('runner-setup', phase.id, ['capability', 'test-setup', '--json'],
      'No supported structured test command can be inferred. Read the suggestions, repair the repository-owned test script within this step\'s approved scope, then recheck; an explicit command needs a reviewed policy amendment.', '/sf-test-setup');
  } else if (AGENT_BRIEF_CODES.has(code)) {
    resolution = route('author-correction', phase.id, ['phase', 'prepublish', phase.id, '--for-agent', '--json'],
      'Write the Agent brief (or summary) as visible text under its heading, outside any <!-- --> template comment, close every comment, then recheck.',
      generationSkillForPhase(phase, workflow));
  } else if (/unclaimed|outside.*scope/u.test(code) || category === 'coverage') {
    resolution = openScopeAppeal(workflow, phase, phaseRequiresCodeDelivery(phase))
      ? route('scope-appeal', 'plan-approval-authority', ['appeal', 'prepare', '--phase', phase.id, '--json'],
        'Explain each exact extra path and its approved clause or supporting class. Review the diff before accounting for it; tests still have to run.', '/sf-appeal')
      : route('plan-amendment', 'plan-approval-authority', ['decision', 'plan', workId, '--add-location', '<clause>=<path>', '--reason', '<why>'],
        'The plan approver accounts for the exact supporting path without resetting an approved phase. Recheck this phase afterward.', '/sf-decide');
  } else if (/test|validation|coverage/u.test(code) || ['test', 'tests', 'validation'].includes(category)) {
    resolution = testFindingRoute(workflow, phase, finding, code);
  } else if (/host|remote|transport|integration|dependency/u.test(code)
      || ['host', 'integration', 'transport', 'external-evidence'].includes(category)) {
    resolution = route('external-owner', 'repository-or-integration-owner',
      ['doctor', '--json'], 'Preserve the retained outcome; resolve access or the external prerequisite before retrying.', '/sf-doctor');
  } else if (code === 'phase.grounding.required' || code === 'phase.grounding.not-ready') {
    resolution = route('prepare-current-generation', phase.id,
      ['wm', 'compose', '--phase', phase.id, '--work-id', workId],
      'Refresh the current pending composition from trusted inputs; retain the prior context and review the existing draft. Authenticated-record tampering still requires restoration.', '/sf-worldmodel');
  } else if (code === 'phase.generation-intent.required' || code === 'generation_intent_required') {
    resolution = phase.status === 'in_progress' && phase.generationIntent?.status !== 'consumed'
      ? route('prepare-current-generation', phase.id,
        ['phase', 'begin', phase.id, '--work-id', workId, '--json'],
        'Open the current generation without discarding its work. Honor the returned adoption preview and exact human confirmation; never fabricate an intent or overwrite published evidence.', '/sf-code')
      : recovery;
  } else if (code === 'generation_intent_already_consumed' || code === 'generation.intent.consumed-changed') {
    resolution = recovery;
  } else if (policy.repairableByProducer) {
    resolution = route('author-correction', phase.id,
      ['appeal', 'repair-plan', '--work-id', workId, '--phase', phase.id, '--json'],
      'Save a recovery checkpoint, then repair the current owned draft from its existing work. A bounded automatic budget never prevents a reviewed manual correction; published content requires a successor.', '/sf-appeal');
  } else if (/artifact|placeholder|document|grounding|clarification|traceability/u.test(code)) {
    resolution = route('author-correction', phase.id, ['phase', 'show', phase.id, '--show-artifact'],
      'Repair only the current owned draft and recheck. Approved/published bytes require a successor or authorized return.', '/sf-phase-documents');
  } else {
    resolution = route('owner-escalation', 'workflow-maintainer', ['doctor', '--json'],
      'No automatic repair or waiver is registered for this finding. Give the maintainer this exact finding and preserved-state diagnostics.', '/sf-doctor');
  }
  // Coverage the code step did not deliver where the plan put it may be the plan's fault: its own
  // corrections and the upstream issue go with the route, never in its place [PHR:REQ-003].
  if (code === 'spec_coverage_incomplete' && resolution.kind !== 'upstream-decision') {
    const corrections = (finding.details?.planCorrections ?? []).filter((entry) => typeof entry?.command === 'string');
    const owner = `${finding.details?.planningOwner ?? 'plan'}-approval-authority`;
    gapRoutes.push(...[corrections.find((entry) => / decision plan /u.test(entry.command)), corrections.find((entry) => / upstream-issue raise /u.test(entry.command))]
      .filter(Boolean).map((entry) => ({ ...route(/ upstream-issue raise /u.test(entry.command) ? 'upstream-issue' : 'plan-correction', owner,
        entry.command.split(' ').slice(1), entry.label ?? '', entry.skill ?? null), command: entry.command })));
  }
  // A route its own command refuses for this Story is no way out: inspect instead, and let the
  // check below name someone other than the author.
  if (routeRefusedForStory(workflow, resolution, phase)) resolution = recovery;
  if (phase.status === 'awaiting_approval' && policy.repairableByProducer
      && phaseCorrectionTargets(phase).includes(phase.id)) {
    resolution = route('current-phase-correction', 'phase-approval-authority',
      ['reject', phase.id, '--work-id', workId, '--to', phase.id, '--reason', '<reason>'],
      'An authorized reviewer requests correction within this phase. Preserve the submitted packet; its author repairs and tests a successor generation. Earlier approvals remain unchanged.', '/sf-reject');
  }
  // When the author has delivered everything and the check still misreads it, the step's approvers
  // can accept the exact finding as an exception on evidence [recoverable-findings M2].
  const disputedGate = DISPUTABLE_GATES.find((gate) => gate === phaseFindingCode(finding).toUpperCase()) ?? null;
  const dispute = disputedGate ? route('dispute', 'phase-approval-authority',
    ['appeal', 'risk-prepare', '--work-id', workId, '--phase', phase.id, '--finding', disputedGate,
      '--evidence-file', '<PATH>', '--expires', '<YYYY-MM-DD>', '--reason', '<why>', '--json'],
    'When every listed item is delivered and the finding still returns unchanged, the check is misreading the work: stop repairing and prepare a dispute with the evidence (test output, the test file). One of the step\'s approvers reviews it live and may accept it as an exception for this exact candidate; it is recorded as an exception, never a pass, and tests still run.',
    '/sf-appeal') : null;
  const choices = [resolution, ...gapRoutes, ...(dispute ? [dispute] : []), ...(upstreamReturn ? [upstreamReturn] : []), recovery];
  if (!foreignApproved && isArtifactQualityFinding(finding)) choices.splice(1, 0, route('pilot-risk-review', 'phase-approval-authority',
    ['appeal', 'risk-prepare', '--work-id', workId, '--phase', phase.id, '--finding', phaseFindingCode(finding),
      '--gate-mode', 'soft', '--expires', '<YYYY-MM-DD>', '--reason', '<why>', '--json'],
    'An authorized human may carry this exact document-quality shortfall through the selected transitions. It remains unmet, not passed; tests, trust and phase approval remain required.', '/sf-appeal'));
  // No finding may route only back to its own author [recoverable-findings M4]: when the author
  // cannot fix it because the check misreads correct work, someone else must be named.
  if (!choices.some((choice) => choice.owner !== phase.id)) choices.push(route('maintainer-escalation', 'workflow-maintainer',
    ['doctor', '--json'],
    `If the author cannot fix this because the check misreads correct work, give the workflow maintainer the exact finding, its entry (${findingDocumentation(finding).command}) and this output; the check is then the defect. Nothing is waived and the work is preserved.`,
    '/sf-doctor'));
  if (activeRepairPhase(workflow, phase)) choices.push(preserve);
  // A gap's return routes run once this step is submitted. They say so, and their admission says not yet.
  const admitted = choices.filter(choice => gapRoutes.includes(choice) || !routeRefusedForStory(workflow, choice, phase))
    .map(choice => ({ ...choice, admission: phaseRepairActionAdmission(workflow, phase, choice,
      { codeDelivery: phaseRequiresCodeDelivery(phase) }) }));
  return { code: finding.code ?? 'unknown', canonicalCode: phaseFindingCode(finding), findingIdentity: phaseFindingIdentity(finding), path: finding.path ?? null, policy,
    detectedPhase: phase.id, affectedPhase: affectedPhase?.id ?? finding.details?.upstreamPhase ?? phase.id,
    // What the finding means, its usual causes, the fix, and who else can act.
    documentation: findingDocumentation(finding),
    status: resolution.kind.endsWith('owner') || resolution.kind === 'owner-escalation'
      ? 'needs-owner' : resolution.kind.includes('risk') || resolution.kind.includes('appeal') || ['human-review', 'worktree-review', 'plan-amendment', 'current-phase-correction', 'decide-upstream-issue'].includes(resolution.kind) ? 'needs-human' : 'needs-correction',
    choices: admitted, preserved: ['working-tree bytes', 'Git index', 'published evidence', 'approval history'] };
}

/**
 * Whether a route's own command refuses this Story before doing anything. Observed-risk review
 * (story test-policy risks, accept-risk, revoke-risk, attest-risk) needs the test-recovery
 * delegation the Story pinned; without it the command refuses (TRP_NOT_ENABLED,
 * TRP_AUTHORITY_REQUIRED), so offering it would send the reader into a second refusal. Only a
 * known pin decides: a projection that carries no resolution keeps the route.
 */
export function routeRefusedForStory(workflow, choice, phase = workflow.phases?.[workflow.currentPhase]) {
  return !phaseRepairActionAdmission(workflow, phase, choice,
    { codeDelivery: phaseRequiresCodeDelivery(phase) }).allowed;
}

// Advisories a person must settle before approval, with what each one says, and how many of its
// routes to show: an honest partial or missing verdict offers its decision and every repair route.
const REQUIRED_BEFORE_APPROVE = new Map([
  ['spec.coverage.unclaimed-path', { routes: 1,
    detail: 'This is not a publication blocker. Account for the exact changed path before approval; publication and tests do not grant scope approval.' }],
  ['conformance.verdict-incomplete', { routes: 4,
    detail: 'This is not a publication blocker. Keep the honest verdict and use the linked upstream issue and its owning step. Do not raise a duplicate or assume the code-producing step owns missing evidence. Its approvers decide it before this step is approved. Never upgrade the verdict to clear a check.' }]
]);
const INFORMATION_DETAILS = new Map([
  ['conformance.verdict-contradicted', 'The table says matched, the discrepancy text says partial or missing: use the honest verdict in the table. Information for the author and the reviewer, not a publication blocker.'],
  ['conformance.verdict-summary-stale', 'The engine-written Verdict summary is older than the clause table or its upstream issues. Prepare the step again to refresh it; the table alone states verdicts. Not a publication blocker.']
]);

/** Advice belongs to a separate lane. It cannot reserve repairs or manufacture a human hold. */
function advisoryProjection(workflow, phase, advisory) {
  // A decided gap is settled: still shown, no longer required before approval.
  const required = advisory.code === 'conformance.verdict-incomplete' && advisory.details?.status === 'decided'
    ? null : REQUIRED_BEFORE_APPROVE.get(advisory.code) ?? null;
  const requiredBefore = required ? 'approve' : null;
  return {
    code: advisory.code, path: advisory.path ?? null, message: advisory.message ?? advisory.code,
    status: 'advisory', blocking: false, requiredBefore,
    detail: required?.detail ?? INFORMATION_DETAILS.get(advisory.code)
      ?? 'Optional improvement, not a publication blocker or a required human decision. Repair only owned editable work; never change approved evidence.',
    choices: requiredBefore
      ? phaseResolutionChoices(workflow, phase, advisory).choices.slice(0, required.routes)
        .map(choice => ({ ...choice, blocking: false, requiredBefore }))
      : []
  };
}

export function phaseResolutionProjection(workflow, phase, findings = [], { advisories = [], transition = null } = {}) {
  const active = workflow.phases?.[workflow.currentPhase];
  if (activeRepairPhase(workflow, active) && active.id !== phase.id) {
    const affected = phase.id;
    const bindAffected = finding => finding.phaseId || finding.phase ? finding : { ...finding, phaseId: affected };
    findings = findings.map(bindAffected); advisories = advisories.map(bindAffected); phase = active;
  }
  const issues = findings.map(finding => ({ ...phaseResolutionChoices(workflow, phase, finding), blocking: true }));
  return { status: findings.length ? 'resolution-required' : 'ready',
    transition,
    contract: { preserveWork: true, automaticDiscard: false, automaticRiskAcceptance: false,
      priorApprovalsImmutable: true, exhaustedAutomationBlocksManualRepair: false,
      advisoriesBlockCurrentTransition: false },
    // Only the caller's actual gate findings belong here. Never suppress an integrity/unknown
    // finding because repository-controlled error hints say blocking:false.
    issues,
    repairContinuation: repairContinuationForIssues({ workId: workflow.workItem.id, phaseId: phase.id, phaseStatus: phase.status,
      generation: phase.generationIntent?.status === 'open' ? phase.generationIntent.generation : phase.generation,
      intentId: phase.generationIntent?.id ?? null, issues, transition }),
    advisories: advisories.map(advisory => advisoryProjection(workflow, phase, advisory)),
    retry: { maximumAttempts: 3, requiresChangedCondition: true, autoAcceptRisk: false,
      fingerprint: digest(findings.map(phaseFindingIdentity).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))) } };
}

/** A deterministic repair budget: no unchanged retry or A→B→A oscillation. */
export function repairLoopAdmission(previous = [], next, { maximumAttempts = 3 } = {}) {
  if (!Array.isArray(previous) || !Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3) return { allowed: false, reason: 'invalid-repair-budget' };
  if (!next?.conditionHash || !next?.actionId) return { allowed: false, reason: 'missing-exact-condition' };
  if (previous.length >= maximumAttempts) return { allowed: false, reason: 'budget-exhausted' };
  if (previous.some(entry => entry.conditionHash === next.conditionHash)) return { allowed: false, reason: 'unchanged-or-oscillating-condition' };
  return { allowed: true, reason: 'changed-condition', attemptsRemaining: maximumAttempts - previous.length - 1 };
}
