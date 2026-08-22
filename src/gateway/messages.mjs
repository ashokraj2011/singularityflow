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
  'gateway.refused': M('Not ready'),
  'gateway.not-ready': M('Not ready to submit'),
  'gateway.returned': M('Where you left this'),
  'gateway.resolved': M('Ready to go'),
  'gateway.candidates': M('More than one thing matches'),
  'gateway.clarification': M('One more thing needed'),

  // ---- Resolution
  'resolution.selection-handle.invalid': M('That choice is no longer current', 'The world moved since it was offered. Ask again and it will be recomputed.'),
  'resolution.subject.unknown-kind': M('That is not something SFlow tracks'),
  'resolution.goal.unknown': M('No such goal'),
  'resolution.no-match': M('Nothing matched that', 'Pick one of the goals below, or ask what SFlow can do.'),
  'resolution.not-legal-now': M('Not available in this state'),
  'resolution.arguments.invalid': M('One of the values is not valid'),
  'resolution.arguments.missing': M('Something is missing', 'Supply {fields} and this can be resolved.'),
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
  'gateway.denied-by-policy': M('Policy does not allow this'),
  'gateway.not-a-read': M('That is not a read'),
  'gateway.read-only': M('This session cannot change anything', 'The gateway is read-only.'),
  'gateway.not-implemented': M('Not implemented yet'),
  'gateway.legal-now': M('Available now'),
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

  // ---- Home
  'home.active-work-leads': M('You have work in progress'),
  'home.governed-goal-active': M('Governed Goal {goal} is {status}'),
  'home.briefing-unavailable': M('The cross-workspace briefing is unavailable', 'Only this workspace was read.'),
  'home.default-order': M('Shown in the standard order'),
  'home.no-workspace-selected': M('No governed workspace or repository is selected. Choose a workspace or open a governed repository.'),
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
  'workspace.prepare-available': M('Create a governed workspace', 'Choose its capabilities, location, and identity in the guided setup.'),
  'workspace.open-available': M('Use an existing repository clone', 'Inspect it first; Git state and working-tree bytes are preserved.'),
  'workspace.doctor-available': M('Run workspace diagnostics', 'Inspect machine, network, Git, and preserved setup evidence without changing state.'),
  'workspace.explore-available': M('Explore saved workspaces', 'Choose only from workspaces registered on this machine.'),

  // ---- Fault intake and governed repair
  'fault.unresolved': M('{severity} fault {fault} needs attention', '{type}: {summary}'),
  'fault.repair-guided': M('Prepare a governed repair', 'Diagnosis and the exact mutation scope are reviewed before an isolated worktree is changed.'),
  'fault.diagnose-first': M('Diagnose without changing files', 'Produces deterministic facts and hypotheses only; no repair worktree is created.'),
  'fault.open-evidence': M('Open the redacted fault record', 'Shows retained evidence and integrity metadata without exposing absolute paths.'),
  'fault.records-unavailable': M('Fault records could not be read', 'Home continued without treating an unread fault store as an empty one.'),

  // ---- Developer recommendation
  'developer.recommended-next': M('Recommended from the current governed state',
    'Review what it will change before selecting it.'),
  'developer.start-with-intake': M('Start by describing the work',
    'SFlow will ask only for the consequential choices it cannot derive.'),
  'developer.no-current-work': M('No current work is selected',
    'Start new work, resume an existing Story, or switch workspace.'),

  // ---- Work
  'work.from-governed-records': M('From governed records'),
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
  'work.all-phases-complete': M('Every phase is complete'),
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
  'readiness.reconcile-changes': M('Reconcile changed paths against the governed plan'),
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
  'return.current-state': M('Current state', 'This covers the governed interval rather than claiming an acknowledgement-relative delta.'),
  'return.since-you-were-here': M('Since you were here'),
  'return.reconciled': M('{changed} path(s) changed, {unplanned} outside the plan'),
  'return.no-open-interval': M('No governed work interval is open', 'Your local work is untouched; it is simply not attached to a governed interval.'),
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
  'context.bounded-brief': M(
    'Bounded {slice} context from governed records',
    '{bytes} content byte(s) were included; deeper material remains behind a newly sealed read action.'
  ),
  'context.expand-slice': M('Expand only this context slice'),
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
  'investigation.deterministic-triage': M(
    'Deterministic bug triage found {matches} bounded text match(es)',
    'The observations narrow investigation; they do not claim a cause.'
  ),
  'investigation.assistance-not-invoked': M(
    'Assisted explanation was not invoked',
    'This host returned the complete deterministic investigation instead.'
  ),
  'investigation.wrong-repository': M('That repository is not the active repository'),
  'investigation.nothing-was-carried-out': M('Nothing was carried out', 'Investigation is read-only.'),
  'explain.cited': M('Answered from the compiled documentation'),
  'explain.ambiguous': M('More than one topic matches'),
  'explain.no-match': M('No topic matches that'),
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
    'From the governed Goal lifecycle branch',
    'The contract, plan, approval, and state were reconstructed from the exact GEX revision.'
  )
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
