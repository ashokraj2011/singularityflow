/**
 * Every limit SFlow has, and its exit [owner, 2026-11-20: "every limit has an exit"; limit audit §6]. A budget, cap, size,
 * expiry, timeout, lease or retry limit must leave the person a next step that changes something: never only the same
 * command on unchanged input, and never nothing. test/limit-exits.test.mjs reads this table:
 *
 *   - `LIMITS`: one row per limit a person or an agent meets on a Story's path, with where its count lives, what resets it,
 *     the exit it must name and the test that walks it. `surface` says how it reaches them: a refusal's plan, the kernel's
 *     route, a hook's answer (pre-tool, post-tool or the stop hook), a status a command returns, or a kept result.
 *   - every refusal code with its own route (refusal-remediation.mjs KNOWN, limit-remediation.mjs) is checked through its
 *     plan without a row: these rows add the limits a plan alone does not show.
 *   - `GROUPS` and `NOT_LIMITS`: the limit-like codes that are not on a Story's path (opt-in subsystems, internal bounds) or
 *     are not limits at all (a setting's own validation, an environment variable's name), each with its reason. A new code
 *     must land in one of them, or get its route.
 *
 * `todo` names what is still open for a row, with the reason: its check is reported as a todo until it passes, and then the
 * entry must go (as test/helpers/journey-scripts.mjs KNOWN_BAD).
 */

/** Rows: the limits on a Story's path, by surface. */
export const LIMITS = Object.freeze([
  // ---- task budgets (owner decision 2, 2026-11-20) ----
  { id: 'author-continuation', surface: 'stop-hook', code: 'SFLOW_TASK_CONTINUATION_SPENT',
    source: ['src/copilot-review-completion.mjs', 'function continuationSpent(value, operation)'], lives: 'turn', resetBy: ['new-request'],
    exit: { changes: 'a new request of the step\'s skill, which starts with its own continuations' }, reach: 'medium',
    coveredBy: ['test/workflow-task-completion.test.mjs', 'a request with no automatic continuation left is told so once'] },
  { id: 'reviewer-continuation', surface: 'stop-hook', code: 'SFLOW_SOURCE_REVIEW_INCOMPLETE',
    source: ['src/workflow-task-store.mjs', "maximumContinuations: role === 'source-reviewer' ? 2"], lives: 'turn', resetBy: ['new-request'],
    exit: { changes: 'a new request starts with the whole budget' }, reach: 'high',
    coveredBy: ['test/workflow-task-resume.test.mjs', 'continuations are its own: a new request starts with the whole budget'] },
  { id: 'kernel-repair-budget', surface: 'kernel', code: 'TASK_REPAIR_EXHAUSTED',
    source: ['src/workflow-task-outcome.mjs', 'budget: Number(record.maximumContinuations ?? 0)'], lives: 'story', resetBy: ['new-generation', 'person-decision'],
    exit: { changes: 'a person decides through the appeal' }, reach: 'low',
    coveredBy: ['test/limit-exits.test.mjs', 'repair budget is its own: a request'],
    todo: 'The kernel route is the appeal read (appeal preflight); it names no mutation for a spent budget yet. Owner decision 2 keeps this budget separate and unchanged.' },
  // ---- turns and kept results (hooks) ----
  { id: 'turn-window-pre-tool', surface: 'hook-pre', code: 'PHASE_MUTATION_TURN_EXPIRED',
    source: ['src/copilot-mutation-guard.mjs', 'function turnExpiredDenial(record, { renewalTried = false } = {})'], lives: 'turn', resetBy: ['new-request', 'person-answer'],
    exit: { changes: 'the skill invoked again, or the person\'s answer in the turn' }, reach: 'high',
    coveredBy: ['test/copilot-turn-renewal.test.mjs', 'the unchanged renewal is once per prompt'] },
  { id: 'turn-window-post-tool', surface: 'hook-post', code: 'PHASE_MUTATION_TURN_EXPIRED',
    source: ['src/copilot-mutation-guard.mjs', 'if (!record.corrupt && turnExpired(record)) return postFinding(turnExpiredDenial(record, { renewalTried: true }));'],
    lives: 'turn', resetBy: ['new-request'], exit: { changes: 'the skill invoked again; never `session current`, which came back to the same stop' }, reach: 'high',
    coveredBy: ['test/copilot-turn-renewal.test.mjs', 'never to run another read'] },
  { id: 'kept-result-freshness', surface: 'cache', code: 'sflow-kept-agent-result@1',
    source: ['src/agent-result-keeper.mjs', 'const current = (value) => since === null || Date.parse(value.startedAt) >= since;'], lives: 'machine', resetBy: ['new-call'],
    exit: { changes: 'only a result started since the call it answers is handed over' }, reach: 'high',
    coveredBy: ['test/limit-exits.test.mjs', 'a kept result older than the call it answers is never that call'] },
  { id: 'agent-loop-detector', surface: 'status', code: 'loop',
    source: ['src/agent-output.mjs', 'If act.do is that same command, never run it again'], lives: 'machine', resetBy: ['state-change'],
    exit: { changes: 'the person is told what is blocked; the repeated command is never named as the way on' }, reach: 'medium',
    coveredBy: ['test/agent-output.test.mjs', 'the loop never sends the agent round the same command again'] },
  // ---- Story limits a refusal's plan names ----
  { id: 'story-publication-in-progress', surface: 'refusal', code: 'STORY_PUBLICATION_IN_PROGRESS',
    source: ['src/refusal-remediation.mjs', 'STORY_PUBLICATION_IN_PROGRESS: (argv, error) => {'], lives: 'process', resetBy: ['lease-released'],
    argv: ['submit', 'build', '--work-id', 'W-1'], details: { subject: { kind: 'story', id: 'W-1' }, pid: 7 },
    exit: { step: 'run-again-once-published', changes: 'the publishing command has finished and released the Story' }, reach: 'medium' },
  { id: 'rework-budget', surface: 'refusal', code: 'REPAIR_BUDGET_EXHAUSTED',
    source: ['src/repair-budget.mjs', 'function oneMoreRoundCommand(workflow, sourcePhase, targetPhase)'], lives: 'story', resetBy: ['reset-phase-generation', 'person-decision'],
    argv: ['reject', 'test', '--work-id', 'W-1', '--to', 'impl', '--reason', 'Again.'],
    details: { phase: 'impl', currentPhase: 'test', workId: 'W-1', maximum: 1, consumed: 1,
      oneMoreRound: 'singularity-flow reject test --work-id W-1 --to impl --reason "<why one more round>" --beyond-budget' },
    exit: { step: 'grant-one-more-round', changes: 'a person grants one more round past the budget (--beyond-budget)' }, reach: 'low',
    coveredBy: ['test/repair-budget.test.mjs', 'a person grants one more rework round past a spent budget'] },
  { id: 'test-time-limit', surface: 'refusal', code: 'CODE_TEST_FAILED',
    source: ['src/refusal-remediation.mjs', 'function timeLimitStep(failure, context)'], lives: 'story', resetBy: ['test-policy-amendment'],
    argv: ['phase', 'prepublish', 'build', '--work-id', 'W-1'],
    details: { workId: 'W-1', phase: 'build', requiredTestExecution: { commandId: 'unit', cwd: '.', resultPath: 'r.json', provenance: 'configured', failure: { kind: 'timeout' } } },
    exit: { step: 'raise-test-time-limit', route: /^singularity-flow story test-policy amend --work-id W-1 --phase build --reason /u }, reach: 'medium' },
  { id: 'clarification-questions', surface: 'refusal', code: 'CLARIFICATION_QUESTION_LIMIT',
    source: ['src/clarifications.mjs', "code: 'CLARIFICATION_QUESTION_LIMIT'"], lives: 'story', resetBy: ['fewer-questions', 'policy-amendment'],
    argv: ['clarification', 'record', 'build', '--work-id', 'W-1', '--response-file', 'answers.json'], details: { workId: 'W-1', phase: 'build', maxQuestions: 3, given: 5 },
    exit: { step: 'record-fewer-questions', changes: 'the response file holds at most 3 questions' }, reach: 'medium' },
  { id: 'capability-token-budget', surface: 'refusal', code: 'CAPABILITY_TOKEN_BUDGET_EXCEEDED',
    source: ['src/state.mjs', "code: 'CAPABILITY_TOKEN_BUDGET_EXCEEDED'"], lives: 'story', resetBy: ['work-by-hand'],
    argv: ['phase', 'publish', 'build'], details: { capabilityId: 'web', used: 1200, budget: 1000 }, exit: { step: 'continue-without-model' }, reach: 'low' },
  { id: 'local-git-time', surface: 'refusal', code: 'SUBPROCESS_TIMEOUT',
    source: ['src/limit-remediation.mjs', 'SUBPROCESS_TIMEOUT: ({ details, retried }) => ['], lives: 'process', resetBy: ['setting-raised', 'machine-less-busy'],
    argv: ['session', 'open', 'W-1'], details: { command: 'git', timeoutMs: 30000 },
    exit: { step: 'run-again-with-more-time', changes: 'the machine is less busy, or Git\'s time limit is raised' }, reach: 'medium' },
  { id: 'application-review-repairs', surface: 'refusal', code: 'ARA_REPAIR_LIMIT_REACHED',
    source: ['src/application-review.mjs', "araFail('ARA_REPAIR_LIMIT_REACHED'"], lives: 'story', resetBy: ['manual-repair', 'person-recheck'],
    argv: ['app-review', 'repair', 'ARA-0123456789abcdef01234567', '--work-id', 'W-1'],
    details: { nextAction: { command: 'singularity-flow prepare implementation', label: 'Repair the finding by hand.' },
      recoveryCommands: [{ command: 'singularity-flow app-review inspect ARA-0123456789abcdef01234567 --work-id W-1', label: 'Recheck on the review page.' }] },
    exit: { route: /^singularity-flow prepare implementation$/u }, reach: 'low' },
  { id: 'ledger-behind', surface: 'refusal', code: 'LEDGER_BEHIND_BLOCKED',
    source: ['src/publication-unit-of-work.mjs', "code: 'LEDGER_BEHIND_BLOCKED'"], lives: 'machine', resetBy: ['ledger-reconciled'],
    argv: ['submit', 'build', '--work-id', 'W-1'], details: { subject: { kind: 'story', id: 'W-1' } },
    exit: { step: 'reconcile-ledger', route: /^singularity-flow ledger reconcile W-1$/u }, reach: 'low' },
  { id: 'choices-receipt', surface: 'refusal', code: 'CHOICE_RECEIPT_EXPIRED',
    source: ['src/choices.mjs', "code: 'CHOICE_RECEIPT_EXPIRED'"], lives: 'machine', resetBy: ['fresh-receipt'],
    argv: ['start', 'W-1'], details: { workId: 'W-1' }, exit: { step: 'change-what-the-limit-names' }, reach: 'low' },
  { id: 'auto-plan-expired', surface: 'refusal', code: 'AUTO_PLAN_EXPIRED',
    source: ['src/auto/auto-plan.mjs', "code: 'AUTO_PLAN_EXPIRED'"], lives: 'machine', resetBy: ['new-plan'],
    argv: ['auto', 'start', 'APL-0123456789ABCDEF0123456789'], details: {}, exit: { step: 'plan-again' }, reach: 'low' },
  // ---- Auto: a halted flight hands its work back to the Story (owner decision 4) ----
  { id: 'auto-ceilings', surface: 'status', code: 'halted',
    source: ['src/auto/auto-flight-store.mjs', 'export function handBackWords(flightId, workId)'], lives: 'story', resetBy: ['hand-back-to-story'],
    exit: { changes: 'auto takeover hands the worktree to the Story, which goes on as any other' }, reach: 'medium',
    coveredBy: ['test/auto-v2-controls.test.mjs', 'a halted flight is taken over into its Story and never resumes'] },
  // ---- caches ----
  { id: 'required-checks-cache', surface: 'cache', code: 'required-checks',
    source: ['src/findings/required-checks.mjs', 'const FAILED_FRESH_MS = 10 * 60 * 1000;'], lives: 'machine', resetBy: ['age'],
    exit: { changes: 'a failed check is read again after ten minutes' }, reach: 'medium',
    coveredBy: ['test/findings-required-checks.test.mjs', 'a failed check is asked again'] },
  { id: 'base-run-cache', surface: 'cache', code: 'test-base-runs',
    source: ['src/verification/base-run.mjs', 'export const BASE_RUN_FRESH_MS = 24 * 60 * 60 * 1000;'], lives: 'machine', resetBy: ['age', 'refresh'],
    exit: { changes: 'a day-old base run, or --refresh, runs again' }, reach: 'medium',
    coveredBy: ['test/test-base-run.test.mjs', 'a day-old answer runs again'] },
  { id: 'repository-check-cache', surface: 'cache', code: 'repository-checks',
    source: ['src/repository-check-cache.mjs', "freshness: settings.mode === 'manual' ? 'stale' : 'fresh'"], lives: 'machine', resetBy: ['interval', 'check'],
    exit: { changes: 'its own refresh route (`check`), with source "cache" and its age' }, reach: 'medium',
    todo: 'A hit within its interval is still labelled freshness "fresh": a new label changes the gateway consistency contract (CONSISTENCY_FRESHNESS) VS Code reads; its observation already carries source "cache", checkedAt and ageMs.' },
  // ---- saved pushes ----
  { id: 'saved-push-final-states', surface: 'status', code: 'outcome-unknown',
    source: ['src/commands/read-index.mjs', "const RETRYABLE = new Set(['pending', 'pushing', 'outcome-unknown', 'needs-user', 'attempt-budget-exhausted']);"],
    lives: 'machine', resetBy: ['person-sync'], exit: { changes: 'the person\'s sync <ID>, which reads the remote first' }, reach: 'low',
    coveredBy: ['plugin/skills/sflow-push/SKILL.md', 'which reads the remote first'] }
]);

/**
 * Limit-like codes off a Story's path, by family: each keeps the generic plan or its own words, and says why that is enough.
 * A new code in one of these families is covered; a new family is not.
 */
export const GROUPS = Object.freeze([
  { pattern: /^SGOS_/u, reason: 'SGOS ceilings are an opt-in orchestration runtime; no Story route points into them, and each refusal names its own program setting.' },
  { pattern: /^REV_/u, reason: 'The revision loop is opt-in and its execution is disabled in this build; its refusals carry their own words.' },
  { pattern: /^PFC_/u, reason: 'Proof-kernel limits are observe-only: the only caller cannot reach its caps.' },
  { pattern: /^TKR_/u, reason: 'Token-reduction composition runs shadow-only; a limit there never refuses a person.' },
  { pattern: /^CMP_/u, reason: 'Comprehension limits bound an opt-in explanation read; its message names the narrower request.' },
  { pattern: /^UI_/u, reason: 'Local page limits and expiries: the page itself re-reads and offers the save again (local-ui/server.mjs).' },
  { pattern: /^AST_/u, reason: 'Code-index (AST) budgets bound an advisory read; the read reports its gap and nothing is refused on a Story.' },
  { pattern: /^(?:MODEL|MCP)_/u, reason: 'Model and tool-server limits outside Auto: the model run reports them and the step is written by hand.' },
  { pattern: /^WCA_/u, reason: 'Workflow-authoring limits: the workflow author names its own smaller draft; drafts never block a Story.' },
  { pattern: /^SKP_/u, reason: 'Skill-package and Story-inventory read limits bound advisory inventories; the inventory says it was cut short.' },
  { pattern: /^FOS_|^FWM_|^EPC_|^WMP_|^WEL_|^JUNIT_/u, reason: 'Federated object, world-model and evidence-packet budgets bound advisory reads that say they were cut short.' },
  { pattern: /^REF_TREE_/u, reason: 'Ref-tree reads of shared state: their callers report the read as unavailable and keep the last known state.' },
  { pattern: /^REPOSITORY_ONBOARDING_|^CAPABILITY_(?:MAP|PROPOSAL|TEAM|ID)_/u, reason: 'Organisation and onboarding input bounds: the refusal names the field and its bound, before anything is written.' },
  { pattern: /^STORY_DESCRIPTION_/u, reason: 'Story-description enhancement is optional; over its input size it is skipped and the description is used as written.' },
  { pattern: /^AUTO_/u, reason: 'Auto limits beyond the ceilings: a halted flight hands its work back to the Story (auto-ceilings row); the rest name their own control.' },
  { pattern: /^GAL_/u, reason: 'Git reader limits reach a person only through the command that wraps them, which routes on details.gitAccessCode (limit-remediation.mjs gitAccessLimit).' },
  { pattern: /_INVALID$|_REQUIRED$|_TOO_SMALL$|_UNKNOWN$|_MISMATCH$|_UNPROVEN$|_MISSING$/u, reason: 'Validation of a limit setting itself (a bound out of range or missing): the message names the field and its range; nothing was reached.' }
]);

/** Codes the scan finds that are not limits a person meets, each with why. */
export const NOT_LIMITS = Object.freeze({
  GIT_CEILING_DIRECTORIES: 'A Git environment variable SFlow clears, not a limit.',
  MAXIMUM_AGE_MS: 'A constant name in a prefetch module, not a refusal code.',
  LIMIT_EXCEEDED: 'The federated object service\'s internal bound name, always rewrapped before it reaches a person.',
  LOCAL_READ_DEADLINE_EXCEEDED: 'Always rewrapped as an SKP read code, which reports the read as cut short.',
  ERR_STRING_TOO_LONG: 'Node\'s own error code, read to say the input was too large for text.',
  INPUT_TOO_LARGE_FOR_TEXT: 'The CLI\'s failure narration for an input too large to print; it names the file to read instead.',
  CLI_JSON_OUTPUT_TOO_LARGE: 'The CLI writes the full result to a file and names it; the agent reads it in ranges.',
  CLI_STEP_OUTPUT_TOO_LARGE: 'A composite step\'s output is kept in a file the result names.',
  FILE_READ_TOO_LONG: 'The edit guard\'s read cap names the exact smaller ranges to read (an internal correction, not a stop).',
  SESSION_ROSTER_OUTPUT_LIMIT: 'Its message names the JSON discovery result to read instead.',
  SCHEMA_CENSUS_FILE_TOO_LARGE: 'Recorded in the census, never refused.',
  WORKTREE_EXHAUSTIVE_CHANGE: 'A fingerprint marker for a change too large to list file by file; the change is still judged.',
  INSTANCES_EXCEED_DECLARATION: 'A verification join finding that names the declaration to correct.',
  PLAN_EFFECTS_EXCEEDED: 'A gateway plan bound: the action is recomputed when asked again.',
  RESOURCE_CEILING_EXCEEDED: 'A delivery-mode classification, recorded as the run\'s outcome.',
  RISK_ABOVE_OUTCOME_CEILING: 'A delivery-mode classification: the step needs a person\'s review, which the result names.',
  VISUAL_THRESHOLD_EXCEEDED: 'A finding with its own risk decision (decision visual-risk), renewed on the Decide card.',
  VISUAL_TOLERANCE_EXCEEDED: 'A revision browser-loop finding, recorded for the reviewer.',
  VISUAL_CAPTURE_LIMIT: 'A capture bound reported in the capture result; the capture names what it kept.',
  WORKFLOW_ROUTE_EXHAUSTION: 'An authoring finding: /sf-fix-workflow drafts the person group that ends the loop.',
  WORKFLOW_WALK_TIMEOUT: 'A workflow walk\'s dry-run bound, reported in the walk.',
  AGENT_BRIEF_MAXIMUM_BYTES_EXCEEDED: 'An agent brief over its byte budget is cut and says so; nothing is refused.',
  BISECT_RANGE_TOO_LONG: 'An investigation planner bound: it names a narrower good/bad range.',
  BOOTSTRAP_LEASE_EXPIRED: 'A healer state: the bootstrap healer takes the lease over.',
  BOOTSTRAP_REMOTE_TOO_LONG: 'A remote URL over its length, refused with the field named before anything runs.',
  BUILD_MOVES_LIMIT: 'Its message names the change to make (fewer moves in one build).',
  DOCUMENT_SET_RESOURCE_LIMIT: 'A document publication bound named with the set to split.',
  ENVIRONMENT_BINDING_INPUT_TOO_LARGE: 'An input size check that names the field, before anything is bound.',
  FAULT_EVIDENCE_TOO_LARGE: 'Fault repair (not on the Story path): the message names the smaller evidence.',
  FAULT_FIELD_TOO_LARGE: 'Fault repair (not on the Story path): the message names the field.',
  GDP_LOCAL_RUNNER_COMMAND_LIMIT: 'A signed local runner bound in an opt-in delivery mode.',
  GDP_LOCAL_RUNNER_TIMEOUT: 'A signed local runner time limit in an opt-in delivery mode.',
  GIT_COMMITTED_FILE_LIMIT: 'A committed-file listing bound; the caller reports the listing as partial.',
  GIT_OBJECT_REPOSITORY_LIMIT: 'An object-repository bound the caller reports as unavailable.',
  JAVASCRIPT_SOURCE_LIMIT_EXCEEDED: 'A declaration scan gap recorded in the evidence, never a refusal.',
  LOCAL_RESOURCE_LIMIT: 'Local-mode service bound: its message names the resource.',
  PNG_LIMIT: 'An image decode bound for screenshots; the capture says it was not read.',
  PROVENANCE_EXPIRED: 'A delivery provenance record past its validity: the delivery is recorded again.',
  REFERENCE_REPOSITORY_PATH_TOO_LONG: 'A path length check that names the path.',
  REMOTE_OUTPUT_LIMIT: 'A remote Git read bound the caller reports as unavailable, with workspace doctor --network.',
  REPAIR_LEASE_EXPIRED: 'Fault repair lease (not on the Story path).',
  SPEC_ORIGIN_LIMIT: 'A Spec Studio origin bound named in its own words.',
  WFA_LIMIT_REACHED: 'A workflow amendment snapshot bound, named in its own words.',
  BOOTSTRAP_BUDGET_UNKNOWN: 'An internal guard against an unknown budget name.',
  SESSION_REMOTE_DISCOVERY_LIMIT: 'A session discovery bound: the candidate listing names the remotes it did not read, and its own --refresh reads them again.'
});

/** The test files whose names a row's `coveredBy` cites must still say it: a row that walks nothing is a list, not a check. */
export const COVERAGE_REACH = Object.freeze(['high', 'medium']);
