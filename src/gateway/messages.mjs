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
  'gateway.next': M('What you can do now'),
  'gateway.explained': M('Here is the explanation'),
  'gateway.refused': M('Not ready'),
  'gateway.not-ready': M('Not ready to submit'),
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
  'gateway.handle-unrecognised': M('That action failed for a reason this build has no name for'),

  // ---- Home
  'home.active-work-leads': M('You have work in progress'),
  'home.briefing-unavailable': M('The cross-workspace briefing is unavailable', 'Only this workspace was read.'),
  'home.default-order': M('Shown in the standard order'),
  'home.no-workspace-selected': M('No workspace is selected'),
  'home.select-a-workspace-first': M('Choose a workspace'),
  'home.continue-active-work': M('Continue where you left off'),
  'home.work-summary': M('{active} active, {decisions} needing you'),
  'home.stable-choice': M('Always available'),

  // ---- Work
  'work.from-governed-records': M('From governed records'),
  'work.reconstructed-from-records': M('Reconstructed from records', 'Phase {phase}, generation {generation}.'),
  'work.local-changes-present': M('You have uncommitted changes', '{files} file(s) changed locally. They are preserved and were not used.'),
  'work.single-repository-scope': M('Only {repository} was read'),
  'work.not-in-this-repository': M('That work is not in this repository'),
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
  'readiness.approvals-outstanding': M('Approvals'),
  'readiness.required-artifact-missing': M('Required artifact'),
  'readiness.tests': M('Tests'),
  'readiness.stale-approvals': M('Approval freshness'),
  'readiness.clarifications': M('Clarifications'),
  'readiness.unclaimed-changes': M('Local changes'),
  'readiness.unrecognised-gate': M('{gate}', 'This build has no name for that gate.'),
  'readiness.resume-publication': M('Finish publishing'),
  'readiness.awaiting-a-human-decision': M('Waiting for a reviewer'),
  'readiness.produce-the-artifact': M('Produce the artifact'),
  'readiness.no-known-step': M('No step is known for this'),

  // ---- Workspaces, impact, documentation, decisions
  'workspace.from-registry': M('From the workspace registry'),
  'workspace.evidence-gap': M('{field} was not read'),
  'workspace.selectable': M('Switch to this workspace'),
  'impact.from-changed-paths': M('From the paths you changed'),
  'impact.evidence-gap': M('{field} was not read'),
  'impact.tests-by-path-convention': M('{matched} test(s) matched by path convention', 'Matched by naming, not by running anything.'),
  'impact.work-in-the-same-area': M('Other work touches this area'),
  'explain.cited': M('Answered from the compiled documentation'),
  'explain.ambiguous': M('More than one topic matches'),
  'explain.no-match': M('No topic matches that'),
  'explain.unstamped-docs': M('The documentation is not stamped', 'It may be older than this build.'),
  'approval.open-the-packet': M('Open the review packet'),
  'approval.waiting': M('Waiting on a decision'),
  'approval.you-submitted-it': M('You submitted this'),
  'approval.awaiting-a-reviewer': M('Waiting for a reviewer'),
  'recovery.resume-publication': M('Finish the interrupted publication'),
  'publication.pending': M('A publication is unfinished')
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
