/**
 * Every limit has an exit [owner, 2026-11-20; limit audit]: when a budget, cap, size, expiry or time limit refuses a command,
 * its plan names what changes it, never only help, doctor and next steps, and never the same command on unchanged input.
 *
 * About sixty limit codes fell to that generic plan (refusal-remediation.mjs genericSteps), and a limit's own words, which
 * often said what to change, never reached it. Each code here has its way on:
 *   - the person's change, in their words, when only they can make it (a file split, a setting raised, a policy approved):
 *     a step with no command, so an agent shows it and runs nothing (agent-output.mjs: every step is the person's);
 *   - a command that changes something (`ledger reconcile`, the step's own work, a policy amendment), filled in;
 *   - the same command again only with `changes`, the change it waits for.
 * A wait is not a limit (WAITS): a timeout of the machine or a remote, or a run that holds what the command needs. Its way
 * on is the same command again once that answers, and its plan never says that unchanged input meets it again.
 *
 * Pure: the plan builder passes its own step builders (`helpers`), so this module imports nothing and adds no load to a
 * refusal. test/limit-exits.test.mjs builds every code's plan and checks that each has an exit; test/helpers/limit-table.mjs
 * lists every limit SFlow has, where its count lives and what resets it.
 */

const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const optionValue = (argv, name) => {
  const index = (argv ?? []).indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? null : (argv ?? []).find((word) => String(word).startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
};
const workIdOf = (argv, details = {}) => [details.workId, details.storyId, details.subject?.kind === 'story' ? details.subject.id : null, optionValue(argv, 'work-id')]
  .find((value) => WORK_ID.test(String(value ?? ''))) ?? null;
const phaseOf = (argv, details = {}) => [details.phase, details.phaseId, optionValue(argv, 'phase')].find((value) => STEP_ID.test(String(value ?? ''))) ?? null;
const words = (value, limit = 600) => (typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/gu, ' ').slice(0, limit) : null);

/**
 * The person's change for a limit whose only way on is theirs: what they change, and that the same command then runs again.
 * One step with no command: an agent shows it and runs nothing.
 */
const PERSON_CHANGES = Object.freeze({
  // Sizes and counts a person reduces.
  STORY_DOCUMENT_LIMIT_EXCEEDED: 'Attach fewer or smaller documents to the Story (the refusal names the limit it met), then run the same command again.',
  DOCUMENT_TOO_LARGE: 'Use a smaller document, or split it into parts, then run the same command again.',
  BACKUP_TOO_LARGE: 'Keep the larger documents in Git instead of the local backup (documents store … --store git), then run the same command again.',
  CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE: 'Split the change, or the file the refusal names, so each bound source is within the limit; then run the same check again.',
  CODE_DELIVERY_EVIDENCE_TOO_LARGE: 'Keep fewer or smaller evidence files for this step (the refusal names the limit), then run the same check again.',
  TEST_SOURCE_LIMIT_EXCEEDED: 'Split the test file the refusal names into smaller files (a tag on the line above a test does not change the file size), then run the same check again.',
  SPEC_SOURCE_FILE_TOO_LARGE: 'Select a smaller source file, or split this one, then run the same command again.',
  SPEC_SOURCE_LIMIT: 'Select fewer source files for this specification, then run the same command again.',
  SPEC_DRAFT_TOO_LARGE: 'Shorten the draft or split it into sections, then run the same command again.',
  SPEC_PROPOSAL_TOO_LARGE: 'Propose a smaller change, in parts, then run the same command again.',
  SPEC_SLICE_TOO_LARGE: 'Ask for a narrower slice of the specification, then run the same command again.',
  UPSTREAM_ISSUE_PROBLEM_TOO_LONG: 'Shorten the problem statement to the limit the refusal names; attach the detail as a file instead, then raise it again.',
  DEPARTURE_TOO_LARGE: 'Shorten the departure, or record it as several smaller ones, then run the same command again.',
  SOURCE_REVIEW_INPUT_TOO_LARGE: 'The review input is over its limit: a person decides the source it names as unreadable on the review, or the step is split into smaller sources.',
  REVIEW_ARTIFACT_TOO_LARGE: 'Split the document under review into smaller documents, then review it again.',
  USER_AGENT_FOLDER_TOO_LARGE: 'Remove files the agent does not need from its folder, or split it into two agents, then run the same command again.',
  USER_AGENT_MAIN_TOO_LARGE: 'Shorten the agent\'s main instructions, moving detail into files beside it, then run the same command again.',
  APPROVED_CONFIGURATION_TOO_LARGE: 'The approved configuration is over its size limit: a configuration approver removes what is no longer used, then run the same command again.',
  WORKFLOW_BUNDLE_LIMIT_EXCEEDED: 'Export fewer workflows in one bundle, then run the same command again.',
  // A file at a link or a marketplace is over the size SFlow reads: only its publisher makes it smaller.
  REMOTE_CONTENT_TOO_LARGE: 'The file at that link is over the size SFlow reads: ask its publisher for a smaller one, then run the same command again.',
  MARKETPLACE_WORKFLOW_TOO_LARGE: 'The marketplace\'s workflow bundle is over the size SFlow reads: ask its maintainers to publish it with fewer workflows, then install it again.',
  WORKFLOW_INTENT_LIMIT: 'Name fewer intents for this workflow, then run the same command again.',
  WORKFLOW_BUILD_SOURCE_TOO_LARGE: 'Build from a smaller source, or split it, then run the same command again.',
  WORKFLOW_BUILD_TRANSFER_TOO_LARGE: 'Build fewer steps in one transfer, then run the same command again.',
  WORKFLOW_MARKUP_LIMIT: 'Split the workflow markup into smaller parts, then run the same command again.',
  WCA_DRAFT_LIMIT: 'The workflow draft is over its size limit: make a smaller change in this draft, or split it into two drafts.',
  WCA_INPUT_LIMIT: 'Give the workflow author a shorter request, or split it into two, then run the same command again.',
  WCA_CHANGE_LIMIT: 'Make fewer workflow changes in this draft, and the rest in a second one.',
  WCA_SUBMISSION_LIMIT: 'Submit fewer workflow changes at once, and the rest in a second submission.',
  WCA_COMPILER_LIMIT: 'The workflow is too large to check at once: split it into smaller workflows, then run the same command again.',
  WCA_SKP_FINALIZATION_LIMIT: 'Finalize fewer skill packages at once, then run the same command again.',
  TEAM_IMPORT_CANDIDATE_LIMIT: 'The team is over an import limit the finding names (steps, agents, skills or text length): split it into two teams, or trim or drop the agent it names, then import again.',
  KNOWLEDGE_SCOPE_TOO_LARGE: 'Choose a narrower knowledge scope, then run the same command again.',
  INSTRUCTION_LIBRARY_LIMIT: 'Keep fewer instructions in the library (remove ones no longer used), then run the same command again.',
  SKILL_LIBRARY_LIMIT: 'Keep fewer skills in the library (remove ones no longer used), then run the same command again.',
  REFERENCE_REPOSITORY_LIMIT: 'Register fewer reference repositories, then run the same command again.',
  CHECKOUT_INVENTORY_LIMIT: 'Remove checkouts this machine no longer uses (workspace list shows them), then run the same command again.',
  GOAL_SUCCESS_CRITERIA_LIMIT: 'Give the goal fewer success criteria, then run the same command again.',
  GOAL_VALUE_TOO_LONG: 'Shorten the value the refusal names, then run the same command again.',
  GOAL_ID_EXHAUSTED: 'Every goal ID of this pattern is used: close or archive goals no longer needed, then add the goal again.',
  PRIVATE_RECORD_SIZE_LIMIT: 'A private record SFlow keeps here is over its size limit: keep the larger content in a file and name it, then run the same command again.',
  PUBLICATION_PREIMAGE_QUOTA_EXCEEDED: 'This publication changes more files than SFlow can keep a recovery copy of: publish the change in smaller parts, then run the same command again.',
  PUBLICATION_RESCUE_QUOTA_EXCEEDED: 'This recovery covers more files than SFlow can keep: recover the files in smaller groups, then run the same command again.',
  REF_TREE_OBJECT_TOO_LARGE: 'A file SFlow reads from the shared branch is over its size limit: keep large files out of SFlow\'s records, then run the same command again.',
  GIT_DIFF_NAME_STATUS_LIMIT_EXCEEDED: 'The change touches more files than SFlow reads at once: split it into smaller Stories or commits, then run the same command again.',
  STATE_CONFIGURATION_MIRROR_LIMIT_EXCEEDED: 'The configuration to mirror is over its size limit: a configuration approver removes what is no longer used, then run the same command again.',
  FINDINGS_REGISTER_TOO_LARGE: 'Settle or remove findings no longer open, then run the same command again.',
  MCP_EVIDENCE_LIMIT: 'Keep fewer or smaller tool results as evidence for this step, then run the same command again.',
  MCP_RESPONSE_TOO_LARGE: 'Ask the tool for a smaller answer (a narrower query), then run the same command again.',
  UI_REQUEST_TOO_LARGE: 'Send a smaller change from the page (fewer items at once), then save again.',
  REV_LOOP_LIMIT: 'This revision loop reached its round limit: a person decides the remaining feedback (accept it as it is, or start a new revision), never another round of the same.',
  REV_FEEDBACK_TOO_LARGE: 'Shorten the feedback, or attach the detail as a file, then send it again.',
  // Time limits on the person's own application: they are set in its run configuration, and the application's own fault
  // (a crash, a port in use, a failing build) meets them again. A wait for the machine or a remote is in WAITS below.
  APP_READY_TIMEOUT: 'The application did not answer before its start-up time limit: check its log (app status), fix what stops it, or raise its ready timeoutMs in the run configuration; then start it again.',
  APP_BEFORE_LAUNCH_TIMEOUT: 'The step before launch did not finish in time: check its output, fix it or raise its timeoutMs in the run configuration, then start the application again.',
  // A model's budgets for one command.
  MODEL_TURN_LIMIT: 'The model used every turn this command allows: narrow the request, or do the rest by hand, then run the same command again.',
  MODEL_TOOL_CALL_LIMIT: 'The model used every tool call this command allows: narrow the request, or do the rest by hand, then run the same command again.',
  MODEL_TOKEN_BUDGET_EXCEEDED: 'The model used this command\'s whole token budget: narrow the request, then run the same command again.',
  MODEL_SESSION_TURN_LIMIT: 'The model session used every turn it allows: start a new session for the rest of the work.',
  // A page's save that ran out of time may still have been written: it is checked before it is sent again, never only
  // retried (local-ui/cli-recovery.mjs: an uncertain write must not be repeated), so it is not a wait.
  UI_OPERATION_TIMEOUT: 'The page\'s request did not finish in time: check the previous save on the page, then save again.',
  // Expiries a person renews.
  VERSION_CONSENT_EXPIRED: 'The person\'s yes to the next version expired: ask them again, and record their new answer.',
  CHOICE_RECEIPT_EXPIRED: 'The choices expired before they were used: make the choices again (the step that offered them issues a fresh receipt), then use them within its time.',
  RECEIPT_EXPIRED: 'The receipt expired: ask for the action again; SFlow issues a fresh one.',
  HANDLE_EXPIRED: 'That action expired: ask again and it will be recomputed.',
  UI_SESSION_EXPIRED: 'The page\'s session expired: open the page again from SFlow.',
  UI_RECEIPT_EXPIRED: 'The page\'s receipt expired: check the previous save on the page, then save again.',
  UI_TICKET_EXPIRED: 'The page\'s ticket expired: open the page again from SFlow.',
  PSS_KEY_EXPIRED: 'Your SF Guard key expired: create a new identity and switch to it (guard rotate --key, as the refusal says), or have another approver decide.',
  EVIDENCE_WITNESS_EXCEPTION_EXPIRED: 'The witness exception expired: a person who approves the step renews it on the Decide card, or the witness is recorded.',
  FOS_APPROVAL_EXPIRED: 'The approval expired: the person approves the current version again.',
  ANALYSIS_LIMIT_EXCEEDED: 'The document is larger than the analysis reads: split it into smaller documents, or, if this is genuinely the size of the work, a configuration approver raises the analysisLimits setting the refusal names; then run the same command again.',
  WORK_INTERVAL_EXCEEDED: 'The step\'s change is larger than its work interval allows: escalate the Story to the larger interval the refusal names (story interval escalate), or make the change smaller, then submit again.'
});

/** A route that changes something, by code. Each returns plain step entries; the plan builder fills and checks commands. */
const ROUTES = Object.freeze({
  SUBPROCESS_OUTPUT_TOO_LARGE: ({ retried }) => [
    { id: 'raise-output-limit', label: 'A local command printed more than SFlow reads (64 MiB by default). Narrow what it reads, or raise SINGULARITY_FLOW_SUBPROCESS_MAX_BUFFER_BYTES, then run the same command again.', kind: 'remediation' },
    retried && { id: 'run-again-with-larger-limit', label: 'Then run the same command again.', command: retried, kind: 'remediation', changes: 'the output limit is raised or the read is narrower' }],
  // A capability's token budget is its reviewers' to raise; until then every publication of it is refused.
  CAPABILITY_TOKEN_BUDGET_EXCEEDED: ({ details }) => [
    { id: 'continue-without-model', label: words(`Capability ${details.capabilityId ?? ''} would use ${details.used ?? 'more than'} of its ${details.budget ?? ''} model tokens. `
      + 'Go on with this step by hand, without a model (--no-model): a publication that adds no model tokens is not held to the budget. '
      + 'For later Stories, its reviewers can raise policy.tokenBudget in a capability proposal.', 2000), kind: 'remediation' }],
  // More questions than the step allows: fewer in this record, the rest open for a person, or a policy that allows more.
  CLARIFICATION_QUESTION_LIMIT: ({ argv, details, retried, decideCard }) => {
    const workId = workIdOf(argv, details);
    // `clarification record … --replace` records exactly the questions in the response file; any other command has no such option.
    const replace = retried && argv[0] === 'clarification' && argv[1] === 'record' && !argv.includes('--replace') ? `${retried} --replace` : null;
    return [
      { id: 'record-fewer-questions', label: words(`This step allows ${details.maxQuestions ?? 'a fixed number of'} clarification questions and this record would hold ${details.given ?? 'more'}. `
        + 'Merge related questions, and keep in the response file only the ones this step needs; --replace records exactly those.', 2000), kind: 'remediation',
      ...(replace ? { command: replace, changes: `the response file holds at most ${details.maxQuestions ?? 'the allowed number of'} questions` } : {}) },
      { id: 'raise-question-limit', label: 'Or, if the step really needs more, a configuration approver raises clarification.maxQuestions in the approved configuration; never answer the rest for the person.', kind: 'remediation' },
      workId ? decideCard('open-decision-list', 'Open decisions on this Story are on the Decide card.', workId) : null];
  },
  LEDGER_BEHIND_BLOCKED: ({ argv, details, retried }) => {
    const workId = workIdOf(argv, details);
    return [{ id: 'reconcile-ledger', label: 'Publish the records waiting on this machine first.', command: `singularity-flow ledger reconcile${workId ? ` ${workId}` : ''}`, kind: 'remediation' },
      retried && { id: 'run-again-after-reconcile', label: 'Then run the same command again.', command: retried, kind: 'remediation', changes: 'the ledger is reconciled' }];
  },
  // Detection read past its bound: initialize without it, and fill in the commands by hand.
  INI_DETECTION_BOUND_EXCEEDED: ({ argv, details }) => [
    { id: 'narrow-detection', label: words(`Detection stopped at its ${details.bound ?? 'size'} limit (${details.observed ?? 'over'}${details.path ? `, at ${details.path}` : ''}). `
      + 'Initialize without detection and name the build and test commands yourself, or run it on a smaller folder of the repository.', 2000), kind: 'remediation' },
    argv[0] === 'init' && argv.includes('--smart-detect') ? { id: 'init-without-detection', label: 'Initialize with the standard configuration, without detection.', command: 'singularity-flow init', kind: 'remediation' } : null],
  // An appeal over its size: split the review; a single large file is raised as an issue that names it.
  PHASE_APPEAL_TOO_LARGE: ({ argv, details }) => {
    const workId = workIdOf(argv, details);
    return [{ id: 'split-appeal', label: 'Split the appeal into smaller ones, each naming fewer files. A single generated or lock file over the limit is never truncated: raise an upstream issue that names it instead.', kind: 'remediation' },
      workId ? { id: 'raise-upstream-issue', label: 'Raise an issue for the file; its approvers decide it.', command: `singularity-flow upstream-issue raise --work-id ${workId}`, kind: 'remediation' } : null];
  },
  // A continuation or a repair that cannot start: the step's own work by hand, or a person's decision on the card.
  PHASE_CONTINUATION_NOT_ADMITTED: (context) => stepWorkOrCard(context, 'No automatic continuation is admitted for this step (its budget is spent, or a person\'s decision is open).'),
  PHASE_CONTINUATION_BUDGET_EXHAUSTED: (context) => stepWorkOrCard(context, 'The automatic continuations of this step are used.'),
  PHASE_REPAIR_ADMISSION_REFUSED: (context) => stepWorkOrCard(context, 'No new automatic repair can start: its budget is used, or its record was set aside. The repair goes on by hand.'),
  RCP_NORMALIZATION_BUDGET_EXHAUSTED: (context) => stepWorkOrCard(context, 'The formatter changed the code on every allowed attempt. Fix the formatter or its configuration, or format the code by hand so it no longer changes it; a new version of the step starts a new budget.'),
  // An Auto Plan expired before it started: plan again (refusal-remediation.mjs autoPlanAgainSteps gives the filled command).
  AUTO_PLAN_EXPIRED: ({ autoPlanAgain }) => autoPlanAgain('The Auto Plan expired before it started; nothing ran. Create and review a new one.'),
  // A person's risk packet changed while they reviewed it: prepare the current one again and review that.
  PHASE_QUALITY_RISK_STALE: () => [
    { id: 'prepare-risk-again', label: 'The risk changed while it was reviewed, or this exact one is already recorded. Prepare the current packet again with appeal risk-prepare and the same options, review it, and accept that one; nothing was recorded.', kind: 'remediation' }],
  REPOSITORY_CATALOG_LIMIT_REACHED: () => [
    { id: 'narrow-repository-list', label: 'Ask for fewer repositories at once: a smaller --limit, a narrower --scope or a search, then the next page with the cursor it returns. Clearing the cache does not raise this limit.', kind: 'remediation' }],
  // The Git reader SFlow uses stopped at a limit; the command that wraps it names its own retry.
  AUTHORITY_UNAVAILABLE: ({ details, retried }) => gitAccessLimit(details, retried),
  CONFIGURATION_PROPOSAL_RETENTION_FAILED: ({ details, retried }) => gitAccessLimit(details, retried),
  // Application review: its automatic repairs are used. The refusal names the step's own work and the review page after this.
  ARA_REPAIR_LIMIT_REACHED: () => [{ id: 'repair-by-hand', label: 'The automatic repairs this review allows are used. Repair the finding by hand in the step\'s own work, then the person checks it again on the review page, or accepts or defers it there.', kind: 'remediation' }],
  ARA_FINDING_LIMIT: () => [{ id: 'settle-findings', label: 'This review keeps at most 200 findings: settle existing ones on the review page (accept, defer or recheck) before adding more; nothing was discarded.', kind: 'remediation' }],
  ARA_SESSION_LIMIT: () => [{ id: 'close-review-sessions', label: 'Close review sessions no longer used on the review page (app-review close), then start the review again.', kind: 'remediation' }],
  ARA_EVENT_LIMIT: () => [{ id: 'start-new-review-session', label: 'This review session is full: close it and start a new one for the remaining checks; what it recorded is kept.', kind: 'remediation' }],
  // The bootstrap's attempts are used: the person fixes what the preflight reported, then retries with their own reason.
  BOOTSTRAP_ATTEMPT_BUDGET_EXHAUSTED: () => [
    { id: 'fix-bootstrap-blocker', label: 'The setup attempts are used. Fix what the last preflight reported (it is named in the refusal), then retry with your own --reason saying what you changed; an unchanged retry meets the same blocker.', kind: 'remediation' }]
});

/** The codes that wrap the Git reader's own (`details.gitAccessCode`). */
const GIT_ACCESS_WRAPPERS = new Set(['AUTHORITY_UNAVAILABLE', 'CONFIGURATION_PROPOSAL_RETENTION_FAILED']);

/** The Git reader's limits, through a command that wraps them (`details.gitAccessCode`); null for any other cause. */
function gitAccessLimit(details, retried) {
  // A Git reader that ran out of time waited for the machine: its route is the wait's (WAITS).
  if (details.gitAccessCode === 'GAL_TIMEOUT') return waitSteps({ retried }, GIT_READ_WAIT);
  const label = details.gitAccessCode === 'GAL_OUTPUT_LIMIT' ? 'Git printed more than SFlow reads: narrow what it reads (fewer refs or files), then run it again.'
    : details.gitAccessCode === 'GAL_LIMIT_EXCEEDED' ? 'Git listed more entries than SFlow reads: remove refs or files no longer used, then run it again.' : null;
  if (!label) return null;
  return [{ id: 'clear-git-limit', label, kind: 'remediation' },
    retried && { id: 'run-again-after-git-limit', label: 'Then run the same command again.', command: retried, kind: 'remediation', changes: 'Git reads less' }];
}

/**
 * Waits, not limits [owner, 2026-11-21]: the machine was busy, a remote, a model or a tool server did not answer in time,
 * or another running process holds what this command needs. Nothing about the input needs changing, and the same command
 * again, once the machine or the remote answers, is the way on. A `git did not respond within 15000ms.` was shown the
 * limit words (LIMIT_RETRY_LABEL: "unchanged input meets it again"), which told the person not to do the one thing that works.
 *
 * Each code gives what it waits for and why. A timeout's route is the same command again first, labelled as that retry
 * (`changes`: what it waits for), then a read that shows what is slow or unreachable when one exists, then the person's
 * way to give it more time. A run that holds what this command needs is read first (`readFirst`), as every held lock is
 * (refusal-remediation.mjs STORY_PUBLICATION_IN_PROGRESS): the same command first only met the same hold. A wait's plan
 * retries with waitRetryLabel; a real limit (a budget, a count, a size, an expiry) keeps LIMIT_RETRY_LABEL.
 */
const LOCAL_READ = Object.freeze({ label: 'If it times out again, read this repository\'s diagnostics.', command: 'singularity-flow doctor --json' });
const NETWORK_READ = Object.freeze({ label: 'If it times out again, check the network, VPN and Git access.', command: 'singularity-flow workspace doctor --network --json' });
const GIT_MORE_TIME = 'If Git keeps running out of time on this machine, give its default limits more time: SINGULARITY_FLOW_GIT_LOCAL_TIMEOUT_MS for reads '
  + '(default 30000) or SINGULARITY_FLOW_GIT_MUTATION_TIMEOUT_MS for changes (default 180000), in milliseconds.';
const GIT_READ_WAIT = Object.freeze({ why: 'Git did not answer in time; a busy machine, a cloud-synced folder or a virus scan slows it.',
  waitsFor: 'the machine is less busy', read: LOCAL_READ, more: GIT_MORE_TIME });
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const SETTING = /^SINGULARITY_FLOW_[A-Z0-9_]{1,80}$/u;
const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/u;
const seconds = (timeoutMs) => (Number(timeoutMs) > 0 ? `${Math.max(1, Math.round(Number(timeoutMs) / 1000))} seconds` : 'its time limit');

const WAITS = Object.freeze({
  // A local program (mostly Git, util.mjs run) did not answer within its limit.
  SUBPROCESS_TIMEOUT: ({ details }) => {
    const program = PROGRAM.test(String(details.command ?? '')) ? details.command : null;
    const git = !program || program === 'git';
    return { why: `${program ?? 'A local command'} did not answer within ${seconds(details.timeoutMs)}; a busy machine, a cloud-synced folder or a virus scan slows it.`,
      waitsFor: 'the machine is less busy', read: LOCAL_READ, more: git ? GIT_MORE_TIME : null };
  },
  PRODUCT_COMMAND_TIMEOUT: ({ details }) => ({ why: 'The install step did not finish in time; a busy machine or a slow network slows it.',
    waitsFor: 'the machine and the network are less busy',
    more: `If it keeps running out of time, give it more time with ${SETTING.test(String(details.setting ?? '')) ? details.setting : 'SINGULARITY_FLOW_PRODUCT_MUTATION_TIMEOUT_MS'} (milliseconds).` }),
  CLI_STEP_TIMEOUT: () => ({ why: 'A step of this command did not finish in time; the steps already done are kept.', waitsFor: 'the machine is less busy', read: LOCAL_READ }),
  AST_WARM_TIMEOUT: () => ({ why: 'Indexing the code took longer than its limit.', waitsFor: 'the machine is less busy',
    more: 'If it keeps running out of time, narrow the source roots it indexes.' }),
  // A remote, a model, a tool server or a service did not answer in time.
  REMOTE_TIMEOUT: () => ({ why: 'The remote did not answer in time; existing work was kept.', waitsFor: 'the remote answers', read: NETWORK_READ }),
  OBJECT_REQUEST_TIMEOUT: () => ({ why: 'A Git object request did not finish in time.', waitsFor: 'the remote answers', read: NETWORK_READ }),
  REPOSITORY_PROVIDER_TIMEOUT: () => ({ why: 'GitHub did not answer in time.', waitsFor: 'GitHub answers',
    more: 'If it does not answer again, check the network or VPN, or read the list SFlow kept with --offline.' }),
  REPOSITORY_PROVIDER_RATE_LIMITED: () => ({ why: 'GitHub rate-limited this read; its limit resets within the hour.', waitsFor: 'GitHub\'s rate limit has reset',
    more: 'Until then, read the list SFlow kept with --offline.' }),
  MODEL_TIMEOUT: () => ({ why: 'The model did not answer in time.', waitsFor: 'the model provider answers', more: 'If it keeps running out of time, use a faster model.' }),
  MCP_TIMEOUT: () => ({ why: 'The tool server did not answer in time.', waitsFor: 'its server answers',
    read: { label: 'If it does not answer again, see each tool server\'s state.', command: 'singularity-flow mcp doctor --json' } }),
  STEP_ACTION_TIMEOUT: () => ({ why: 'The step\'s integration did not answer in time; its delivery is kept, and integrations retry sends it again.', waitsFor: 'the service it calls answers' }),
  // Another running process holds what this command needs: read it first, then the same command once it has ended.
  AUTO_FLIGHT_BUSY: ({ details }) => {
    const active = (Array.isArray(details.active) ? details.active : []).filter((id) => FLIGHT_ID.test(String(id)));
    return { readFirst: true, waitsFor: 'the other Auto run has ended',
      why: `Another Auto run is active${active.length ? ` (${active.slice(0, 3).join(', ')})` : ''}: it ends when it finishes, or when a person pauses or stops it.`,
      read: active.length ? { label: 'Wait: this shows that run and how far it is.', command: `singularity-flow auto status ${active[0]}` } : null };
  }
});

/** A wait's steps (WAITS): the same command again once it answers, a read of what is slow, and the person's way to give it more time. */
function waitSteps({ retried }, { why, waitsFor, read = null, more = null, readFirst = false }) {
  const waitRead = readFirst && read?.command;
  const retry = { id: 'run-again-once-answered', kind: 'remediation', ...(retried ? { command: retried, changes: waitsFor } : {}),
    label: words(waitRead ? `Once ${waitsFor}, run the same command again.` : `${why} Run the same command again once ${waitsFor}.`, 2000) };
  const see = read?.command ? { id: waitRead ? 'see-what-holds-it' : 'see-what-is-slow', kind: 'diagnostic', command: read.command,
    label: words(waitRead ? `${why} ${read.label}` : read.label, 2000), ...(waitRead ? { wait: true } : {}) } : null;
  const time = more ? { id: 'give-it-more-time', label: words(more, 2000), kind: 'remediation' } : null;
  return waitRead ? [see, retry, time] : [retry, see, time];
}

/** A step's own work by hand, then the person's decision on the Decide card when it is theirs. */
function stepWorkOrCard({ argv, details, authorRoute, decideCard }, why) {
  const workId = workIdOf(argv, details);
  const phase = phaseOf(argv, details);
  const author = phase ? authorRoute(phase) : null;
  return [{ id: 'continue-by-hand', label: `${why} Go on with the step's own work by hand, in a new request of its work command; what is already written is kept.`, kind: 'remediation',
    ...(author?.command ? { command: author.command, skill: author.skill ?? null } : {}) },
  workId ? decideCard('open-decision-list', 'If a decision is the person\'s, it is on the Decide card.', workId) : null];
}

/** Every code with its own limit route, waits included. */
export const LIMIT_ROUTE_CODES = Object.freeze([...Object.keys(ROUTES), ...Object.keys(PERSON_CHANGES), ...Object.keys(WAITS)]);
/** The codes that are waits, not limits: their plan retries the same command once the machine or the remote answers. */
export const WAIT_ROUTE_CODES = Object.freeze(Object.keys(WAITS));

/**
 * The steps of `code`'s limit route, or null for a code without one. `helpers`: the plan builder's own `decideCard(id,
 * label, workId)`, `authorRoute(phase)` and `autoPlanAgain(why)`; `retried` is the refused command's own line.
 */
export function limitRouteSteps(code, { argv = [], error = null, retried = null, ...helpers } = {}) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  if (Object.hasOwn(WAITS, code)) return waitSteps({ retried }, WAITS[code]({ argv, details })).filter(Boolean);
  if (Object.hasOwn(ROUTES, code)) {
    const steps = ROUTES[code]({ argv, details, retried, ...helpers });
    return steps ? steps.filter(Boolean) : null;
  }
  if (Object.hasOwn(PERSON_CHANGES, code)) return [{ id: 'change-what-the-limit-names', label: PERSON_CHANGES[code], kind: 'remediation' }];
  return null;
}

/** The plan's retry words for a limit: the same command only after the change. */
export const LIMIT_RETRY_LABEL = 'A limit refused this, and running the same command on unchanged input meets it again. Run it again only after the change the steps name.';
/** The plan's retry words for a wait: the same command again, once what it waits for answers. */
export const waitRetryLabel = (waitsFor) => `This was a wait, not a limit: nothing about the input needs changing. Run the same command again once ${waitsFor}.`;

/** What `code`'s refusal waits for (WAITS, or a wrapped Git reader that ran out of time); null for a limit. */
function waitsForOf(code, error) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  if (Object.hasOwn(WAITS, code)) return WAITS[code]({ details }).waitsFor;
  return GIT_ACCESS_WRAPPERS.has(code) && details.gitAccessCode === 'GAL_TIMEOUT' ? GIT_READ_WAIT.waitsFor : null;
}

/** The retry words for `code`'s limit plan: a wait's retry once it answers, or a limit's "only after the change". */
export function limitRetryLabel(code, error = null) {
  const waitsFor = waitsForOf(code, error);
  return waitsFor ? waitRetryLabel(waitsFor) : LIMIT_RETRY_LABEL;
}
