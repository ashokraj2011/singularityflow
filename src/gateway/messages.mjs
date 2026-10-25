/**
 * What each catalog code says to a person. `[UXH:REQ-061]`
 *
 * In core rather than in the editor, because both surfaces render these. It lived in
 * `apps/vscode/` first, and the CLI's home immediately printed `home.stable-choice` where a
 * sentence belonged — a second vocabulary opening up in the exact place this file exists to
 * prevent one. A catalog that only one of two readers can reach is half a catalog.
 *
 * The gateway's contract deliberately refuses prose and carries codes instead, which is only useful
 * if exactly one place turns a code into a sentence. This is that place. A view that writes its own
 * wording for `readiness.blocked` has forked the vocabulary, and the fork is invisible until two
 * surfaces describe the same state differently in the same screenshot.
 *
 * `src/gateway/catalog.mjs` is the authority on which codes exist; a test holds this file level with
 * it, so a code added there without a sentence here fails the build rather than rendering as a
 * dotted identifier to a user.
 *
 * ## Voice
 *
 * Second person, present tense, and never a verdict. "Waiting for a reviewer" is a fact about the
 * world; "you should chase the reviewer" is advice this product is not entitled to give
 * `[INT:CON-180]`. Slots are interpolated, never concatenated into the template by the caller —
 * `{gate}` stays a value the message owns, so a translation can put it somewhere else in the
 * sentence.
 */

const M = (label, detail) => Object.freeze({ label, detail });

export const RESULT_MESSAGES = Object.freeze({
  /**
   * Narration IDs — `outcome.messageId`, the card's headline.
   *
   * Separate from the reason codes below and held to the same rule: `KERNEL_MESSAGES` and
   * `RESOLUTION_MESSAGES` enumerate them, and the test holds this file level with both. A headline
   * is the one string a user always reads, so it is the last place a missing entry should surface
   * as a dotted identifier.
   */
  'gateway.read': M('Here is what SFlow found'),
  'gateway.home': M('Your work'),
  'gateway.developer-next': M('Your recommended next step'),
  'gateway.next': M('What you can do now'),
  'gateway.explained': M('Here is the explanation'),
  'gateway.explained-work': M('Where {work} stands', 'Read from its own record: {phase}, {status}.'),
  'gateway.refused': M('Not ready'),
  'gateway.not-ready': M('Not ready to submit'),
  'gateway.returned': M('Where you left this'),
  'gateway.completed': M('Completed exactly as confirmed'),
  'gateway.resolved': M('Ready to go'),
  'gateway.candidates': M('More than one thing matches'),
  'gateway.clarification': M('One more thing needed'),
  'gateway.ceremony': M('A decision is waiting', 'Decide it in the review, where the exact record is shown.'),

  // ---- Resolution
  'resolution.selection-handle.invalid': M('That choice is no longer current', 'The world moved since it was offered. Ask again and it will be recomputed.'),
  'resolution.subject.unknown-kind': M('That is not something SFlow tracks'),
  'resolution.goal.unknown': M('No such goal'),
  'resolution.no-match': M('Nothing matched that', 'Pick one of the goals below, or ask what SFlow can do.'),
  'resolution.not-legal-now': M('Not available in this state'),
  'resolution.arguments.invalid': M('One of the values is not valid'),
  'resolution.arguments.missing': M('Something is missing', 'Supply {labels} and this can be resolved.'),
  'resolution.denied-by-policy': M('Policy does not allow this'),
  'resolution.goal-alone-cannot-write': M('A goal alone cannot change anything', 'One candidate is still a candidate. Choose it and it will be resolved.'),
  'resolution.ambiguous': M('More than one thing matches'),
  'resolution.matched.selection-handle': M('Resolved from your choice'),
  'resolution.matched.phrase': M('Resolved from what you typed'),
  'resolution.matched.conversation': M('Understood as a developer request'),
  'resolution.matched.goal': M('Resolved from the goal'),
  'resolution.nothing-was-carried-out': M('Nothing was carried out', 'Your work is untouched.'),

  // ---- Kernel
  'gateway.planner-unavailable': M('This build cannot answer that yet', 'The operation is declared but has no implementation here.'),
  'gateway.plan-invalid': M('That Plan cannot be prepared from the current state', 'Nothing was carried out.'),
  'gateway.denied-by-policy': M('Policy does not allow this'),
  'gateway.not-a-read': M('That is not a read'),
  'gateway.not-a-mutation': M('That Plan is not an executable mutation'),
  'gateway.read-only': M('This session cannot change anything', 'The gateway is read-only.'),
  'gateway.copilot-paused': M('SFlow guidance is paused', 'Nothing was read or changed. Answer as native Copilot; /sf-pause off turns SFlow guidance back on.'),
  'gateway.answer-too-long': M('That answer is too long for a tool result', 'It is {bytes} bytes and a tool answer holds {limit}; the command {command} serves it whole.'),
  'gateway.tool-answer-too-long': M('That answer is too long for a tool result', 'It is {bytes} bytes and a tool answer holds {limit}; run this step\'s CLI command, which serves it whole.'),
  'gateway.confirmation-channel-unavailable': M('This host cannot ask you to confirm', 'Nothing ran. Use the explicit command in a terminal instead.'),
  'gateway.confirmation-declined': M('Not confirmed', 'Nothing ran.'),
  'gateway.run-in-progress': M('That is already running', 'The first request is still in progress. Nothing was started twice.'),
  'gateway.run-outcome-unknown': M('The earlier run did not report how it ended', 'It is not run again from here. Check the work, then plan again.'),
  'gateway.result-replayed': M('This is the recorded result', 'Nothing ran again; this is what the first run reported.'),
  'gateway.executor-unavailable': M('This build cannot carry out that Plan'),
  'gateway.confirmation-required': M('Confirm the exact reviewed Plan first'),
  'gateway.confirmation-invalid': M('That confirmation is invalid or already used'),
  'gateway.legal-now': M('Available now'),
  'gateway.next-current-work': M('{work} is the work in front of you'),
  'gateway.next-only-open-work': M('{work} is the only open work here'),
  'gateway.next-several-open-work': M('{count} open work items', 'None is selected here, so each is listed with its next action.'),
  'gateway.next-no-open-work': M('No open work here'),
  'gateway.next-work-unread': M('Open work could not be read', 'Only the actions available now are listed.'),
  'gateway.nothing-was-carried-out': M('Nothing was carried out', 'Your work is untouched.'),
  'gateway.handle-unknown': M('That action is no longer available', 'It was offered in a different session. Ask again from here.'),
  'gateway.handle-kind-mismatch': M('That action does not fit here'),
  'gateway.handle-kind-invalid': M('That action is malformed'),
  'gateway.handle-tampered': M('That action does not match its signature', 'Nothing was carried out. This is not something retrying will fix.'),
  'gateway.handle-expired': M('That action expired', 'Ask again and it will be recomputed against the current state.'),
  'gateway.handle-consumed': M('That action was already used', 'A confirmation is for one act.'),
  'gateway.handle-drifted': M('The world moved under that action', '{drifted} changed since it was offered. Ask again and it will be recomputed.'),
  'gateway.handle-binding-invalid': M('That action was not bound to anything checkable'),
  'gateway.handle-invalid': M('That action is not valid'),
  'gateway.fingerprint-algorithm-stale': M('That action used an older worktree fingerprint', 'Refresh the view before continuing.'),
  'gateway.handle-unrecognised': M('That action failed for a reason this build has no name for'),
  'gateway.host-action-dropped': M('A view link was left out', '{action} was not offered here ({reason}). The rest of this answer is complete.'),
  'gateway.host-action-refused': M('That view was not opened', '{action} was refused ({reason}). Nothing was opened or changed.'),
  'gateway.host-action-fallback': M('Do it from a terminal instead'),

  // ---- Home
  'home.active-work-leads': M('You have work in progress'),
  'home.governed-goal-active': M('Repository Goal {goal} is {status}'),
  'home.auto-unavailable': M('Some Auto status could not be read',
    'Home did not treat unreadable private Auto records as an empty flight list. Run the displayed diagnostic command.'),
  'home.briefing-unavailable': M('The cross-workspace briefing is unavailable', 'Only this workspace was read.'),
  'home.default-order': M('Shown in the standard order'),
  'home.no-workspace-selected': M('No workspace or repository is selected. Choose a workspace or open a repository.'),
  'home.select-a-workspace-first': M('Choose a workspace'),
  'home.continue-active-work': M('Continue where you left off'),
  'home.local-work-unreconciled': M('{files} local change(s) not yet compared against the plan'),
  'home.recovery-required': M('A publication was interrupted',
    'Finish it before starting anything else — this is the one state where doing something else first can lose work.'),
  'home.needs-your-decision': M('{count} decision(s) are waiting on you'),
  'home.nothing-waiting': M('Nothing is waiting on you in {workspace}'),
  'home.prompt-placeholder': M('What is on your mind today?'),
  'home.work-summary': M('{active} active, {decisions} needing you'),
  'home.stable-choice': M('Always available'),
  'home.selection-stale': M('The selected work changed while this answer was being prepared', 'Refresh Home and choose the current subject again.'),

  // ---- Rootless workspace recovery
  'workspace.bootstrap-available': M('A workspace setup can be continued', 'Review its preserved state before retrying the next operation.'),
  'workspace.prepare-available': M('Create a workspace', 'Choose its capabilities, location, and identity in the guided setup.'),
  'workspace.open-available': M('Use an existing repository clone', 'Inspect it first; Git state and working-tree bytes are preserved.'),
  'workspace.doctor-available': M('Run workspace diagnostics', 'Inspect machine, network, Git, and preserved setup evidence without changing state.'),
  'workspace.explore-available': M('Explore saved workspaces', 'Choose only from workspaces registered on this machine.'),

  // ---- Fault intake and governed repair
  'fault.unresolved': M('{severity} fault {fault} needs attention', '{type}: {summary}'),
  'fault.repair-guided': M('Prepare a repair', 'Diagnosis and the exact mutation scope are reviewed before an isolated worktree is changed.'),
  'fault.diagnose-first': M('Diagnose without changing files', 'Produces deterministic facts and hypotheses only; no repair worktree is created.'),
  'fault.open-evidence': M('Open the redacted fault record', 'Shows retained evidence and integrity metadata without exposing absolute paths.'),
  'fault.records-unavailable': M('Fault records could not be read', 'Home continued without treating an unread fault store as an empty one.'),

  // ---- Developer recommendation
  'developer.recommended-next': M('Recommended from the current state',
    'Review what it will change before selecting it.'),
  'developer.start-with-intake': M('Start by describing the work',
    'SFlow will ask only for the consequential choices it cannot derive.'),
  'developer.no-current-work': M('No current work is selected',
    'Start new work, resume an existing Story, or switch workspace.'),

  // ---- Work
  'work.from-governed-records': M('From records'),
  'work.reconstructed-from-records': M('Reconstructed from records', 'Phase {phase}, generation {generation}.'),
  'work.local-changes-present': M('You have uncommitted changes', '{files} file(s) changed locally. They are preserved and were not used.'),
  'work.single-repository-scope': M('Only {repository} was read'),
  'work.not-in-this-repository': M('That work is not in this repository'),
  'work.revision-unavailable': M('The exact repository revision could not be read',
    'A handoff was not produced because it could not be bound to a commit.'),
  'work.nothing-was-carried-out': M('Nothing was carried out', 'Your work is untouched.'),
  'work.legal-now': M('Available now'),
  'work.no-legal-action': M('Nothing is available to do here'),
  'work.check-readiness': M('Check whether this is ready'),
  'work.resume-phase': M('Resume this phase'),
  'work.open-handoff-view': M('Open the handoff packet view'),
  'work.open-progress-view': M('Open the progress view'),
  'work.all-phases-complete': M('Every step is decided'),
  'work.no-current-phase': M('No phase is current'),
  'work.final-phase-approved': M('The final phase was approved'),
  'work.in-progress': M('In progress'),
  'work.blocked.publication-pending': M('A publication is unfinished'),
  'work.blocked.publication-marker-unreadable': M('The publication recovery marker cannot be read', 'Repair the marker before attempting lifecycle changes.'),
  'work.blocked.approvals-outstanding': M('Approvals are outstanding'),
  'work.blocked.required-artifact-missing': M('A required artifact is missing'),
  'work.blocked.unrecognised': M('Blocked by {blocker}', 'This build has no name for that blocker.'),

  // ---- Readiness gates. The label is the gate as a reader meets it, not the internal name.
  'readiness.no-blockers-found': M('Nothing is blocking you'),
  'readiness.blocked': M('{count} thing(s) are blocking this'),
  'readiness.partial-inputs': M('This answer does not cover everything', 'Not evaluated: {missing}.'),
  /**
   * Gate names are neutral, and that is not a style choice.
   *
   * The first draft wrote them in the satisfied voice — "Approvals recorded", "Publication
   * complete" — which reads correctly beside a checkmark and is a flat contradiction beside a
   * warning icon: "⚠ Approvals recorded" on the row that is the reason nothing can be submitted.
   * The row's state is carried by its icon and its `aria-label`; the label names the *gate*, so the
   * same string is true whether it passed, failed or was never looked at.
   */
  'readiness.publication-pending': M('Publication'),
  'readiness.publication-marker-unreadable': M('Publication recovery record'),
  'readiness.approvals-outstanding': M('Approvals'),
  'readiness.required-artifact-missing': M('Required artifact'),
  'readiness.published-artifacts': M('Published artifact bytes'),
  'readiness.tests': M('Tests'),
  'readiness.stale-approvals': M('Approval freshness'),
  'readiness.clarifications': M('Clarifications'),
  'readiness.unclaimed-changes': M('Local changes'),
  'readiness.reconciliation': M('Implementation reconciliation'),
  'readiness.ast': M('Structural predicates'),
  'readiness.visual': M('Visual assurance'),
  'readiness.external-build': M('External build status'),
  'readiness.unrecognised-gate': M('{gate}', 'This build has no name for that gate.'),
  'readiness.resume-publication': M('Finish publishing'),
  'readiness.repair-publication-marker': M('Repair the publication recovery record'),
  'readiness.awaiting-a-human-decision': M('Waiting for a reviewer'),
  'readiness.produce-the-artifact': M('Produce the artifact'),
  'readiness.publish-artifacts': M('Publish the current required artifacts'),
  'readiness.run-missing-checks': M('Run the missing or stale checks'),
  'readiness.revalidate-approvals': M('Revalidate approvals against the current artifact bytes'),
  'readiness.resolve-clarifications': M('Resolve the recorded clarification markers'),
  'readiness.claim-changes': M('Record trace claims for the unclaimed changes'),
  'readiness.reconcile-changes': M('Reconcile changed paths against the approved plan'),
  'readiness.inspect-ast': M('Inspect the required structural predicates'),
  'readiness.capture-visuals': M('Capture required visual evidence'),
  'readiness.record-external-build': M('Record the required external build checks'),
  'readiness.no-known-step': M('No step is known for this'),

  /**
   * The return briefing `[DHR:REQ-040]`–`[DHR:REQ-046]`.
   *
   * `current-state` carries its own explanation because the *absence* of a delta is the fact: a
   * reader who is not told this is everything will read it as everything-that-changed.
   */
  'return.current-state': M('Current state', 'This covers the work interval rather than claiming an acknowledgement-relative delta.'),
  'return.since-you-were-here': M('Since you were here'),
  'return.reconciled': M('{changed} path(s) changed, {unplanned} outside the plan'),
  'return.no-open-interval': M('No work interval is open', 'Your local work is untouched; it is simply not attached to a work interval.'),
  'return.planned': M('Changes match the plan', '{planned} of {changed} changed path(s) were planned.'),
  'return.unplanned': M('Changes outside the plan'),
  'return.protected': M('Protected paths untouched', '{count} protected path(s) changed.'),
  'return.unrecognised-verdict': M('A verdict this build has no name for'),
  'return.clean-worktree': M('Application tree committed', '{uncommitted} uncommitted application path(s).'),
  'return.local-changes-unread': M('Local changes were not read'),
  'return.reconciliation-unavailable': M('No reconciliation for {work}', 'Nothing was compared, so nothing here is a verdict on your work.'),
  'return.acknowledgement-boundary-unavailable': M('Showing the full interval', 'The acknowledgement is recorded, but it is not a Git baseline for this reconciliation.'),
  'return.reconcile-before-submitting': M('Reconcile before submitting'),
  'return.nothing-was-carried-out': M('Nothing was carried out', 'This is a read. Your work is untouched.'),

  // ---- Workspaces, impact, documentation, decisions
  'workspace.from-registry': M('From the workspace registry'),
  'workspace.evidence-gap': M('{field} was not read'),
  'workspace.selectable': M('Switch to this workspace'),
  'impact.from-changed-paths': M('From the paths you changed'),
  'impact.from-committed-evidence': M('From source at the pinned commit'),
  'impact.evidence-gap': M('{field} was not read'),
  'impact.tests-by-path-convention': M('{matched} test(s) matched by path convention', 'Matched by naming, not by running anything.'),
  'impact.work-in-the-same-area': M('Other work touches this area'),
  'impact.start-reviewed-plan': M('Accept this exact plan in a guarded start ceremony'),
  'impact.open-impact-view': M('Open the Impact Analysis view'),
  'context.bounded-brief': M(
    'Bounded {slice} context from records',
    '{bytes} content byte(s) were included; deeper material remains behind a newly sealed read action.'
  ),
  'context.expand-slice': M('Expand only this context slice'),
  'context.open-receipt-view': M('Open the context receipt view', 'What this packet included, left out and estimated, from its recorded receipt.'),
  'context.coverage-limited': M(
    'Some context was not included',
    '{omission} was unavailable or outside this page\'s explicit byte budget.'
  ),
  'repository.explore.bounded-facts': M(
    'Repository shape from {files} tracked file(s)',
    'Only bounded structural facts were returned for {path}; source bodies were not included.'
  ),
  'repository.explore.empty-scope': M('No tracked source was found under {path}'),
  'repository.explore.wrong-repository': M('That repository is not the active repository'),
  'repository.explore.nothing-was-carried-out': M('Nothing was carried out', 'Repository exploration is read-only.'),
  'intent.trace.resource-observation': M(
    'Observed {regions} exact changed resource region(s) for {path}',
    'This resource-level observation is not a cause or semantic explanation.'
  ),
  'intent.trace.cause-unavailable': M(
    'Cause authority is unavailable for {path}',
    'The read does not infer intent from proximity, commit prose, or a model summary.'
  ),
  'intent.trace.path-not-changed': M(
    '{path} is not present in the exact current change set',
    'No cause relationship was inferred.'
  ),
  'intent.trace.wrong-repository': M('That repository is not the active repository'),
  'intent.trace.nothing-was-carried-out': M('Nothing was carried out', 'Intent trace is read-only.'),
  'investigation.deterministic-triage': M(
    'Deterministic bug triage found {matches} bounded text match(es)',
    'The observations narrow investigation; they do not claim a cause.'
  ),
  'investigation.assistance-not-invoked': M(
    'Assisted explanation was not invoked',
    'This host returned the complete deterministic investigation instead.'
  ),
  'investigation.wrong-repository': M('That repository is not the active repository'),
  'investigation.boundary-verified': M('Verified boundary', 'Reproduced twice under {command}; this identifies the introducing change. It does not record a fix or create work.'),
  'investigation.boundary-candidate': M('Candidate boundary', 'Not reproduced as a boundary under {command}; treat it as a candidate.'),
  'investigation.boundary-unknown': M('No boundary established', 'The endpoints did not behave as claimed, or the run stopped.'),
  'investigation.evidence-sequence': M('Evidence read in order', '{completed} of {total} steps completed.'),
  'investigation.step-incomplete': M('A step did not complete: {step}', 'Its evidence is missing from this report, not empty.'),
  'investigation.unknown-input': M('Not given: {field}', 'It stays unknown; nothing was assumed in its place.'),
  'investigation.record.observation': M('Observed', 'A deterministic fact read from the repository or a record.'),
  'investigation.record.reproduction': M('Reproduced', 'A result of running the configured test.'),
  'investigation.record.correlation': M('Correlated in time', 'Near the problem in time or range; not shown to cause it.'),
  'investigation.record.hypothesis': M('Hypothesis', 'Model-assisted and unverified; the cited facts are what it rests on.'),
  'investigation.record.conclusion': M('Concluded by a person'),
  'investigation.record.contradiction': M('Contradicting evidence'),
  'investigation.record.unknown': M('Unknown'),
  'investigation.bisect-available': M('Find the introducing commit', 'A confirmed bisection in disposable worktrees, with the configured test.'),
  'investigation.start-from-finding': M('Start a Story from this finding'),
  'investigation.open-view': M('Open the Investigation view'),
  'investigation.nothing-was-carried-out': M('Nothing was carried out', 'Investigation is read-only.'),
  'explain.cited': M('Answered from the compiled documentation'),
  'explain.ambiguous': M('More than one topic matches'),
  'explain.no-match': M('No topic matches that'),
  'explain.index': M('{count} documentation topic(s)', 'Every topic ships with this build and carries its own version.'),
  'explain.situation-from-state': M('Your situation in {subject}', 'Read from the work item\'s own record at the cited revision, not from the documentation.'),
  'explain.subject-unresolved': M('Only the concept is shown', 'No work item could be read here ({reason}).'),
  'explain.nothing-was-carried-out': M('Nothing was carried out', 'Explaining never changes anything.'),
  'explain.unstamped-docs': M('The documentation is not stamped', 'It may be older than this build.'),
  'approval.open-the-packet': M('Open the review packet'),
  'approval.waiting': M('Waiting on a decision'),
  'approval.you-submitted-it': M('You submitted this'),
  'approval.awaiting-a-reviewer': M('Waiting for a reviewer'),
  'approval.you-are-authorized': M('Your approval decision is needed'),
  'approval.requires-an-authorized-reviewer': M('Waiting for an authorized reviewer'),
  'recovery.resume-publication': M('Finish the interrupted publication'),
  'publication.pending': M('A publication is unfinished'),
  'publication.marker-unreadable': M('A publication recovery marker cannot be read'),
  'mcp.evidence-observation-required': M(
    'This snapshot is retained for audit only',
    'It was supplied by an agent rather than captured by the MCP host, so it does not satisfy host-observed evidence gates.'
  ),
  'ast.bounded-structural-evidence': M(
    'Bounded structural evidence',
    'This read reports structural facts from the selected repository cone without returning source bodies or changing repository state.'
  ),
  'goal.durable-execution': M(
    'From the repository Goal lifecycle branch',
    'The contract, plan, approval, and state were reconstructed from the exact GEX revision.'
  ),

  // ---- Comparison, watches, ceremonies and confirmed local records
  'compare.exact-revisions': M('Compared {left} with {right}', '{paths} path(s) differ between the two exact revisions.'),
  'compare.side-unresolved': M('The {side} side does not resolve', '\'{value}\' is not a revision this repository has. Nothing was guessed in its place.'),
  'compare.subject-unavailable': M('This build cannot compare {subjectKind}s', 'Comparing that kind needs an evidence source this build does not read.'),
  'compare.paths-truncated': M('Showing {shown} of {total} paths'),
  'compare.untracked-not-compared': M('Untracked files are not compared', 'Only tracked files are in either side of this comparison.'),
  'compare.impact-of-this-range': M('See what this range affects'),
  'compare.nothing-was-carried-out': M('Nothing was carried out', 'Comparison is read-only.'),
  'watch.from-local-store': M('{count} watch(es) on this machine', 'Watches are local to you and checked against the records now.'),
  'watch.subject-not-visible': M('{count} watched item(s) are not visible here', 'Their state is unknown from this repository, not unchanged.'),
  'watch.fired': M('This moved since you started watching'),
  'watch.revocable': M('You can stop watching this'),
  'watch.no-actor': M('SFlow cannot tell who you are', 'Configure your Git identity so watches can be kept for you.'),
  'watch.local-store-changed': M('Your watches were updated'),
  'watch.governed-state-untouched': M('No work, approval or branch changed'),
  'watch.nothing-was-carried-out': M('Nothing was carried out'),
  'review.ceremony-destination': M('Open the review to decide', 'The decision is recorded only there, with your identity on it.'),
  'review.nothing-awaiting-decision': M('Nothing is waiting for a decision', '{workId} is {group}.'),
  'review.no-decision-was-recorded': M('No decision was recorded'),
  'work.draft-saved-locally': M('Saved as a local draft', 'A draft is a proposal. Starting from it asks you to confirm again.'),
  'work.no-governed-record-created': M('No work was created'),
  'work.started': M('{work} was started', 'Its branch, lifecycle and pinned configuration were created and published.'),
  'work.start-refused': M('Starting did not go ahead ({code})', 'Nothing was created.'),
  'work.start-outcome-unknown': M('Starting {work} stopped before it reported', 'Its branch, work record or publication may exist. Check with sflow status --work-id {work}; sflow sync {work} finishes a publication.'),
  'work.tracker-only-read': M('The tracker was only read'),
  'work.start-recovery-record-kept': M('The publication record is kept', 'Your work is committed locally; finishing the publication completes it.'),
  'work.intake-recorded': M('Ready to review exactly what will be created', 'Nothing is created until you confirm the exact record.'),
  'workspace.selection-changed': M('You are now in {workspace}'),
  'workspace.governed-state-untouched': M('No work, approval or branch changed'),
  'impact.revision-unresolved': M('The {side} revision does not resolve', '\'{revision}\' is not a revision this repository has.'),
  'impact.assistance-not-invoked': M('No interpretation was produced', 'These are the deterministic facts only.'),
  'build.from-provider': M('{count} build(s) from the configured provider', 'Related to HEAD only through each build\'s exact commit.'),
  'repository.query.typed-read': M('Read {query} at {commit}', 'From the {tree}, with nothing checked out or changed.'),
  'repository.query.revision-unresolved': M('\'{revision}\' is not a revision here', 'Nothing was guessed in its place.'),
  'repository.query.needs': M('This question needs a {field}'),
  'repository.query.version-unmapped': M('No tag names version {version}', 'A version maps to a commit only through a tag that names it exactly.'),
  'repository.query.switch-to-repository': M('{repository} is in this workspace but not this session', 'Switch to it to read it; on this machine: {onThisMachine}.'),
  'repository.query.not-registered': M('{repository} is not a registered repository', 'Only repositories the workspace registers can be read.'),
  'repository.query.build-provider-unavailable': M('No build provider is configured', 'Mapping a build to a commit needs a configured read-only provider.'),
  'repository.query.build-unmapped': M('Build {buildId} has no exact commit', 'Mapping unavailable: the provider did not report one for it.'),
  'repository.query.truncated': M('Showing the first {shown}'),
  'repository.query.submodules-not-descended': M('{count} submodule(s) were not read'),
  'repository.query.large-files-skipped': M('{count} large file(s) were skipped'),
  'repository.query.no-workspace-selected': M('No workspace is selected', 'Only this repository is known.')
});

/**
 * Fill a message's slots.
 *
 * An unfilled slot renders as its own name in braces rather than as an empty string. Silence would
 * make "3 file(s) changed" become " file(s) changed", which reads as a rendering bug in the best
 * case and as "zero" in the worst.
 */
export function fill(template, slots = {}) {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, key) =>
    (key in slots ? String(slots[key]) : whole));
}

/**
 * The sentence for a code, or an honest placeholder.
 *
 * A code with no message is a defect the test catches before release. At runtime it renders as the
 * code itself, because showing `readiness.something-new` tells a user and a support engineer what
 * happened, and showing nothing tells them the product is broken.
 */
export function message(code, slots = {}) {
  const found = RESULT_MESSAGES[code];
  if (!found) return { label: code, detail: 'This build has no wording for that code.' };
  return { label: fill(found.label, slots), detail: found.detail ? fill(found.detail, slots) : undefined };
}
