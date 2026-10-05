/**
 * The narration catalog: wording for outcome message IDs and reason codes.
 *
 * This is a renderer over the command-result contract, not the contract itself. Handlers emit
 * codes; the words live here. That is what keeps the language consistent, the slots testable, the
 * JSON stable when the English improves, and localisation possible later without touching a single
 * handler.
 *
 * `preserves` is deliberately NOT the guarantee. The guarantee is `result.effects`, which is
 * machine-readable; this line is only permitted on messages whose results declare every effect
 * false, and the conformance test enforces that. Reassurance is derived from the truth, never
 * written beside it.
 */

function slot(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

/**
 * What a Story that reached its end may claim. Every step being decided is not completion: only the
 * final evaluation its ending passed may name a completion label, and the sentence names that label.
 */
function finalCheckSentence(s) {
  if (s.finalCheck === 'passed') return ` Every step is decided and the final evaluation passed: ${slot(s.completionLabel, 'Complete')}.`;
  if (s.finalCheck === 'failed') return ' Every step is decided, but the final evaluation has not passed.';
  return '';
}

export const MESSAGES = Object.freeze({
  'copilot.mode-reported': {
    headline: (s) => `SFlow Copilot guidance is ${slot(s.mode)}. Story state, approvals, branches and checkouts are unchanged.${s.stateAvailable === false ? ' The local preference is unreadable; guidance remains paused until explicitly repaired with pause off.' : ''}`,
    preserves: false
  },
  'story.test-policy.risk-inspected': {
    headline: (s) => `Story risk review is ${slot(s.status)}. This command made no changes and ran no tests. Use --json for exact blockers and eligible decisions.`,
    preserves: true
  },
  'story.test-policy.risk-recorded': {
    headline: (s) => `Story risk review is ${slot(s.status)}. Failed or unavailable validation remains failed or unavailable; phase advancement is evaluated separately.`,
    preserves: false
  },
  'story.test-policy.origin-inspected': {
    headline: (s) => `Local test-command review origin is ${slot(s.status)}. No Story policy changed and no test ran. Use --json for the exact immutable reviews.`,
    preserves: true
  },
  'story.test-policy.origin-restored': {
    headline: (s) => `Local test-command review origin is ${slot(s.status)}. Only local review evidence changed; Story policy, source and Git history remain unchanged.`,
    preserves: false
  },
  'story.test-policy.amendment-planned': {
    headline: (s) => `Story test-command amendment is ${slot(s.status)}. No Story policy changed and no test ran. Use --json for the reviewed candidate.`,
    preserves: true
  },
  'story.test-policy.amendment-recorded': {
    headline: (s) => `Story test-command amendment is ${slot(s.status)}. Fresh test evidence is still required before phase publication; no test failure was accepted.`,
    preserves: false
  },
  'story.test-policy.amendment-unchanged': {
    headline: (s) => `Story test-command amendment is ${slot(s.status)}. No Story policy changed and no test ran.`,
    preserves: true
  },
  'story.test-policy.selection-planned': {
    headline: (s) => `Story test selection is ${slot(s.status)}. No test ran or scope was confirmed. Use --json for the exact cohort and legal actions.`,
    preserves: true
  },
  'story.test-policy.selection-confirmed': {
    headline: (s) => `Story test-scope confirmation is ${slot(s.status)}. No test ran and no test failure was accepted.`,
    preserves: false
  },
  'story.test-policy.selection-unchanged': {
    headline: (s) => `Story test-scope confirmation is ${slot(s.status)}. No Story evidence changed and no test ran.`,
    preserves: true
  },
  'story.test-policy.repair-reported': {
    headline: (s) => `Story readiness repair is ${slot(s.status)}. No readiness command ran or Story evidence changed. Use --json for the exact plan and legal actions.`,
    preserves: true
  },
  'story.test-policy.repair-recorded': {
    headline: (s) => `Story readiness repair is ${slot(s.status)}. Its passing baseline-admission evidence remains separate from feature-candidate test evidence.`,
    preserves: false
  },
  'skill.recipe-previewed': {
    headline: (s) => `Previewed candidate skill workflow ${slot(s.workflowId)}. No configuration was changed, approved, or activated; no skill ran.`,
    preserves: true
  },
  'skill.diagnosed': {
    headline: (s) => `Retained Story skill ${slot(s.skillId)} is intact; original source: ${slot(s.sourceStatus)}. No skill ran or version changed. Host execution remains unavailable.`,
    preserves: true
  },
  'skill.inspected': {
    headline: (s) => `Inspected candidate skill ${slot(s.skillId)} (${slot(s.files)} files, ${slot(s.proposedFields)} proposed fields, ${slot(s.findings)} findings). Inspection did not approve or execute the package. Use --json for exact candidates and package identity.`,
    preserves: true
  },
  'skill.approved-inspected': {
    headline: (s) => `Inspected approved-configuration skill ${slot(s.skillId)} (${slot(s.files)} files, ${slot(s.proposedFields)} proposed fields, ${slot(s.findings)} findings). Inspection did not make the package executable. Use --json for the source commit and exact package identity.`,
    preserves: true
  },
  'fos.repository-attached': {
    headline: (s) => `Repository authority attachment is ${slot(s.status)}${s.authority ? ` (${slot(s.authority)})` : ''}.`,
    preserves: false
  },
  'fos.authority-refreshed': {
    headline: (s) => `Repository authority pin was refreshed to ${slot(s.authority)}.`,
    preserves: false
  },
  'fos.authority-current': {
    headline: (s) => `Repository authority pin is already current at ${slot(s.authority)}.`,
    preserves: true
  },
  'fos.cache-cleared': {
    headline: (s) => `Cleared ${slot(s.removedEntries, '0')} disposable FOS cache entr${Number(s.removedEntries) === 1 ? 'y' : 'ies'}.`,
    preserves: false
  },
  'delivery.recommendation-created': {
    headline: (s) => `Delivery recommendation: ${slot(s.recommendation)} (${slot(s.reasons, '0')} reason(s)).`,
    preserves: true
  },
  'delivery.outcome-started': {
    headline: (s) => `Outcome work ${slot(s.workId)} started in Ad Hoc session ${slot(s.sessionId)}.`,
    preserves: false
  },
  'delivery.workflow-reported': {
    headline: (s) => `Workflow delivery view for ${slot(s.workId)} (${slot(s.profile)}; ${slot(s.checkpoints, '0')} checkpoint(s)).`,
    preserves: true
  },
  'delivery.execution-reported': {
    headline: (s) => `GDP execution view for ${slot(s.processId)} is ${slot(s.status)} (quiescent: ${slot(s.quiescent)}).`,
    preserves: true
  },
  'delivery.promotion-previewed': {
    headline: (s) => `Promotion plan for ${slot(s.workId)} to ${slot(s.workflow)} is ready for exact review.`,
    preserves: true
  },
  'delivery.promotion-applied': {
    headline: (s) => `Outcome work is ready to hand off to ${slot(s.workflow)} Story ${slot(s.workId)}.`,
    preserves: false
  },
  'delivery.promotion-reported': {
    headline: (s) => `Promotion for ${slot(s.sessionId)} is ${slot(s.status)}.`,
    preserves: true
  },
  'delivery.assurance-reported': {
    headline: (s) => `Local assurance observation for ${slot(s.workId)} is ${slot(s.verdict)} (coverage: ${slot(s.coverage)}).`,
    preserves: true
  },
  'delivery.provenance-reported': {
    headline: (s) => `GDP provenance is ${slot(s.status)} (configured: ${slot(s.configured)}, verifier: ${slot(s.verifier)}).`,
    preserves: true
  },
  'delivery.authenticated-runner-reported': {
    headline: (s) => `CAB authenticated runner is ${slot(s.status)} `
      + `(configured: ${slot(s.configured)}, integration: ${slot(s.integration)}, `
      + `authority: ${slot(s.authority)}).`,
    preserves: true
  },
  'delivery.wel-readiness-reported': {
    headline: (s) => `WEL ${slot(s.readinessScope)} is ${slot(s.status)} `
      + `(lifecycle verification: ${slot(s.lifecycleVerification)}, `
      + `joined: ${slot(s.lifecycleJoined)}, enforcement available: ${slot(s.enforcementAvailable)}).`,
    preserves: true
  },
  'delivery.readiness-reported': {
    headline: (s) => `GDP GA readiness is ${slot(s.status)} with ${slot(s.blockers, '0')} blocker(s) (ready: ${slot(s.gaReady)}).`,
    preserves: true
  },
  'delivery.local-runner-created': {
    headline: (s) => `Developer-local signer ${slot(s.signer)} is ready (created: ${slot(s.created)}).`,
    preserves: false
  },
  'delivery.local-runner-reported': {
    headline: (s) => `Developer-local runner is ${slot(s.status)} (${slot(s.assurance)}).`,
    preserves: true
  },
  'delivery.local-runner-options-reported': {
    headline: (s) => `Developer-local runner offers ${slot(s.eligible, '0')} eligible command(s) and ${slot(s.excluded, '0')} excluded command(s) (Candidate: ${slot(s.identity)}).`,
    preserves: true
  },
  'delivery.local-runner-plan-ready': {
    headline: (s) => `Local runner plan for ${slot(s.workId)} / ${slot(s.phase)} / ${slot(s.command)} is ready for review.`,
    preserves: true
  },
  'delivery.local-runner-completed': {
    headline: (s) => `Developer-local signed runner completed with ${slot(s.outcome)} (repository changed: ${slot(s.changed)}).`,
    preserves: false
  },
  'delivery.local-runner-verified': {
    headline: (s) => `Developer-local runner receipt is cryptographically verified (${slot(s.outcome)}; ${slot(s.assurance)}).`,
    preserves: true
  },
  'evidence.scope.reported': {
    headline: (s) => `${slot(s.workId)}: ${slot(s.items, '0')} requirement statement(s) from ${slot(s.sources, '0')} source(s); ${slot(s.unresolved, '0')} without a disposition.`,
    preserves: true
  },
  'decision.completeness.succeeded': {
    headline: (s) => `Recorded a completeness review of scope inventory ${slot(s.inventory)}; a person reviewed it, which never says it is correct.`,
    preserves: false
  },
  'decision.witness.succeeded': {
    headline: (s) => `Recorded witness ${slot(s.record)} for ${slot(s.criterion)}; it counts only while the file keeps the bytes that were inspected.`,
    preserves: false
  },
  'decision.risk.succeeded': {
    headline: (s) => `Recorded ${slot(s.record)}; the observation stays visible, and the decision counts only until it expires or is revoked.`,
    preserves: false
  },
  'decision.plan.succeeded': {
    headline: (s) => `Amended the plan with ${slot(s.amendment)}: ${slot(s.changes)} change(s) recorded.`,
    preserves: false
  },
  'decision.scope.succeeded': {
    headline: (s) => `Recorded that ${slot(s.item)} is ${slot(s.disposition)}.`,
    preserves: false
  },
  'governance.rebuild-planned': {
    headline: (s) => `Governance rebuild ${slot(s.plan)} would replace ${slot(s.replaced, '0')} framework file(s) and archive ${slot(s.stories, '0')} ${Number(s.stories) === 1 ? 'Story' : 'Stories'}; nothing changed.`,
    preserves: true
  },
  'governance.rebuild-blocked': {
    headline: (s) => `Governance rebuild is blocked by ${slot(s.blockers, '0')} issue(s); nothing changed.`,
    preserves: true
  },
  'governance.rebuild-activated': {
    headline: (s) => `Governance rebuild ${slot(s.plan)} is committed on ${slot(s.branch)} as ${slot(s.commit)}; ${slot(s.archived, '0')} ${Number(s.archived) === 1 ? 'Story is' : 'Stories are'} archived and read-only.`,
    preserves: false
  },
  'governance.restore-previewed': {
    headline: (s) => `Restoring governance rebuild ${slot(s.plan)} would put back ${slot(s.files, '0')} file(s); nothing changed.`,
    preserves: true
  },
  'governance.restore-completed': {
    headline: (s) => `Governance rebuild ${slot(s.plan)} is restored: ${slot(s.files, '0')} file(s) put back in commit ${slot(s.commit)}.`,
    preserves: false
  },
  'precheck.reported': {
    headline: (s) => `Singularity Flow quick precheck is ${slot(s.status)} across ${slot(s.checks, '0')} check(s).`,
    preserves: true
  },
  'precheck.run-planned': {
    headline: (s) => `Repository readiness has ${slot(s.commands, '0')} command(s) ready for exact review.`,
    preserves: true
  },
  'precheck.run-blocked': {
    headline: (s) => `Repository readiness plan is blocked by ${slot(s.blockers, '0')} setup issue(s); no command ran.`,
    preserves: true
  },
  'precheck.run-completed': {
    headline: (s) => `Repository readiness passed ${slot(s.commands, '0')} command(s) for ${slot(s.commit)}.`,
    preserves: false
  },
  'precheck.risk-reported': {
    headline: (s) => `Local pre-Story test risk status: ${slot(s.status)}. No test or publication gate changed.`,
    preserves: true
  },
  'precheck.risk-recorded': {
    headline: (s) => `Recorded ${slot(s.status)} locally as ${slot(s.acceptanceSha256)}; Story start must verify it, and publication still requires passing tests.`,
    preserves: false
  },
  'sgos.reported': {
    headline: (s) => slot(s.summary, 'Singularity Flow governed execution result is ready.'),
    preserves: true
  },
  'auto.plan-ready': {
    headline: (s) => `Auto Plan ${slot(s.planId)} is ready for exact review.`,
    preserves: true
  },
  'auto.flight-list-ready': {
    headline: (s) => `${slot(s.count, '0')} Auto flight(s) are recorded in this repository.`,
    preserves: true
  },
  'auto.flight-reported': {
    headline: (s) => `Auto flight ${slot(s.flightId)} is ${slot(s.status)}.`,
    preserves: false
  },
  'auto.report-ready': {
    headline: (s) => `Auto flight ${slot(s.flightId)} report is ready.`,
    preserves: true
  },
  /**
   * Secret scanning. The headline carries counts, never a value — the whole point of the check is
   * that the credential does not get repeated anywhere, and a narration layer is a place text goes
   * to be logged.
   */
  'secrets.clean': {
    headline: (s) => `No secrets found in ${slot(s.scanned)} ${slot(s.scope)} file(s).`,
    preserves: true
  },
  'secrets.detected': {
    headline: (s) => `${slot(s.blocking)} possible secret(s) found in ${slot(s.scanned)} ${slot(s.scope)} file(s).`,
    preserves: true
  },
  'secrets.protected': {
    headline: (s) => `Installed the pre-commit secret check at ${slot(s.hook)}.`,
    preserves: true
  },
  /**
   * Product surfaces. The headline is the machine's verdict; the builds themselves are printed per
   * surface, because a build line is long and a headline is read at a glance.
   */
  'product.aligned': {
    headline: () => 'Every Singularity Flow surface on this machine runs the installed build.',
    preserves: true
  },
  'product.repairable': {
    headline: (s) => `${slot(s.count)} surface(s) run a different build than the installed one; \`singularity-flow product align\` brings them to it from the build retained on this machine.`,
    preserves: true
  },
  'product.split': {
    headline: () => 'VS Code and the terminal are on different installed builds. A full install puts one build on every surface.',
    preserves: true
  },
  'product.no-receipt': {
    headline: () => 'No installer has recorded a build on this machine, so there is nothing to align.',
    preserves: true
  },
  'product.receipt-invalid': {
    headline: () => 'The installation receipt could not be read, so no surface was compared. Run `singularity-flow doctor`.',
    preserves: true
  },
  'product.align-completed': {
    headline: (s) => `Aligned ${slot(s.count)} surface(s) to the installed build.`,
    preserves: false
  },
  'product.align-failed': {
    headline: (s) => `Alignment stopped at the ${slot(s.surface)} surface: ${slot(s.reason)}`,
    preserves: false
  },
  'product.reviews-opened': {
    headline: (s) => `Opened ${slot(s.count)} configuration review(s) for this build. Nothing changes until each is merged.`,
    preserves: false
  },
  'product.reviews-recorded': {
    headline: (s) => `This build already proposed its configuration: ${slot(s.count)} review(s).`,
    preserves: true
  },
  'product.reviews-current': {
    headline: () => "Every registered repository's approved configuration matches this build.",
    preserves: true
  },
  'product.reviews-running': {
    headline: () => "This build's configuration reviews are being opened in the background; `singularity-flow product status` shows them.",
    preserves: true
  },
  'product.reviews-incomplete': {
    headline: (s) => `The repositories this build could check match its configuration; ${slot(s.count)} could not be checked and are tried again after an hour.`,
    preserves: true
  },
  'product.reviews-unavailable': {
    headline: (s) => `Configuration reviews could not check ${slot(s.count)} registered repository(ies) yet; they are tried again after an hour.`,
    preserves: true
  },
  'product.reviews-development': {
    headline: () => 'A development checkout proposes no configuration reviews of its own.',
    preserves: true
  },
  'product.reviews-failed': {
    headline: (s) => `Configuration reviews could not be opened: ${slot(s.reason)}`,
    preserves: true
  },
  'fastpath.milestone': {
    headline: (s) => `${slot(s.verb)} reached ${slot(s.milestone)}.`,
    preserves: true
  },
  'fastpath.checkpoint': {
    headline: (s) => `${slot(s.verb)} stopped at a ${slot(s.checkpoint)} checkpoint.`,
    preserves: true
  },
  'fastpath.blocked': {
    headline: (s) => `${slot(s.verb)} cannot continue: ${slot(s.checkpoint)}.`,
    preserves: true
  },
  'docs.served': {
    headline: (s) => `${slot(s.title)} — topic ${slot(s.topic)} v${slot(s.version)}.`,
    preserves: true
  },
  'docs.served-with-state': {
    headline: (s) => `${slot(s.title)} — topic ${slot(s.topic)} v${slot(s.version)}, alongside ${slot(s.subject, 'this repository')}.`,
    preserves: true
  },
  'docs.topic-not-found': {
    headline: (s) => `No topic matches '${slot(s.query)}'.`,
    preserves: true
  },
  'docs.topic-ambiguous': {
    headline: (s) => `'${slot(s.query)}' matches ${slot(s.count)} topics.`,
    preserves: true
  },
  'help-metrics.reported': {
    headline: (s) => `Help metrics are ${slot(s.enabled)} with ${slot(s.count, '0')} local record(s).`,
    preserves: true
  },
  'help-metrics.updated': {
    headline: (s) => `Help metrics are now ${slot(s.enabled)}.`,
    preserves: false
  },
  'help-metrics.cleared': {
    headline: (s) => `Cleared ${slot(s.removed, '0')} local help-metrics record(s).`,
    preserves: false
  },
  'revision.capabilities-reported': {
    headline: (s) => `REV activation profile: ${slot(s.activationProfile)}.`,
    preserves: true
  },
  'revision.activation-reported': {
    headline: (s) => `REV activation profile: ${slot(s.activationProfile)}; ${slot(s.blockerCount, '0')} prerequisite(s) remain.`,
    preserves: true
  },
  'revision.status-reported': {
    headline: (s) => `REV loop is ${slot(s.state)} after ${slot(s.intervalSequence, '0')} completed interval(s).`,
    preserves: true
  },
  'revision.card-reported': {
    headline: (s) => `REV Candidate ${slot(s.candidateId, 'none')} is ${s.publicationEligible ? '' : 'not '}publication-eligible.`,
    preserves: true
  },
  'revision.interval-reported': {
    headline: (s) => `REV interval ${slot(s.intervalId)} is recorded in loop state ${slot(s.state)}.`,
    preserves: true
  },
  'revision.checks-capabilities-reported': {
    headline: (s) => `Browser revision checks are ${slot(s.profile)}; executor: ${slot(s.executor)}.`,
    preserves: true
  },
  'revision.checks-plan-reported': {
    headline: (s) => `Browser-check plan ${slot(s.planSha256)} is ${slot(s.status)} (${slot(s.reasonCode)}).`,
    preserves: true
  },
  'revision.checks-status-reported': {
    headline: (s) => `Browser-check run ${slot(s.runId, 'none')} is ${slot(s.state)} (${slot(s.reasonCode)}).`,
    preserves: true
  },
  'revision.checks-result-reported': {
    headline: (s) => `Browser-check result ${slot(s.runId)} is ${slot(s.status)} (${slot(s.reasonCode)}).`,
    preserves: true
  },
  'revision.resume-completed': {
    headline: (s) => `Recovered the exact durable state for REV interval ${slot(s.intervalId)}; state is ${slot(s.state)}.`,
    preserves: false
  },
  'revision.resume-already-completed': {
    headline: (s) => `REV interval ${slot(s.intervalId)} was already recovered in state ${slot(s.state)}.`,
    preserves: true
  },
  'revision.resume-recovery-required': {
    headline: (s) => `REV interval ${slot(s.intervalId)} could not be reconciled automatically; state is ${slot(s.state)}.`,
    preserves: false
  },
  'revision.capture-previewed': {
    headline: (s) => `REV capture plan ${slot(s.planSha256)} is ready for exact review.`,
    preserves: true
  },
  'revision.capture-completed': {
    headline: (s) => `Captured REV Candidate ${slot(s.candidateId)}; publication eligible: ${slot(s.publicationEligible)}.`,
    preserves: false
  },
  'revision.capture-already-completed': {
    headline: (s) => `REV Candidate ${slot(s.candidateId)} was already captured; the exact retry made no change.`,
    preserves: true
  },
  'revision.abandon-previewed': {
    headline: (s) => `Abandonment plan ${slot(s.planSha256)} for ${slot(s.targetKind)} target ${slot(s.targetId)} is ready for exact review.`,
    preserves: true
  },
  'revision.abandoned': {
    headline: (s) => s.targetKind === 'interval'
      ? `Abandoned REV loop ${slot(s.loopId)} from selected interval ${slot(s.targetId)}.`
      : `Abandoned REV loop ${slot(s.loopId)}.`,
    preserves: false
  },
  'revision.abandon-already-completed': {
    headline: (s) => s.targetKind === 'interval'
      ? `REV loop ${slot(s.loopId)} selected by interval ${slot(s.targetId)} was already abandoned.`
      : `REV loop ${slot(s.loopId)} was already abandoned.`,
    preserves: true
  },
  'revise.previewed': {
    headline: (s) => `REV plan ${slot(s.planSha256)} classified the feedback as ${slot(s.disposition)}.`,
    preserves: true
  },
  'revise.opened': {
    headline: (s) => `Opened REV loop ${slot(s.loopId)} in ${slot(s.status)} state.`,
    preserves: false
  },
  'revise.already-opened': {
    headline: (s) => `REV loop ${slot(s.loopId)} was already ${slot(s.status)}; the exact retry made no change.`,
    preserves: true
  },
  'revise.confirmation-recovered': {
    headline: (s) => `Recovered the immutable confirmation receipt for REV loop ${slot(s.loopId)} in ${slot(s.status)} state.`,
    preserves: false
  },
  'revision.attachments-capabilities-reported': {
    headline: () => 'Opaque Copilot uploads have no verifiable bytes; genuine local file references can use the guarded registration bridge.',
    preserves: true
  },
  'revision.attachments-listed': {
    headline: (s) => `${slot(s.count, '0')} feedback attachment set(s) registered for ${slot(s.phaseId)}.`,
    preserves: true
  },
  'revision.attachments-preview-staged': {
    headline: (s) => `Previewed ${slot(s.name)} and staged private plan ${slot(s.planId)} for confirmation. No feedback evidence or revision was registered.`,
    preserves: false
  },
  'revision.attachments-registered': {
    headline: (s) => `Registered feedback attachment set ${slot(s.attachmentSetSha256)} (${slot(s.count, '0')} file(s)). No revision or approval was started.`,
    preserves: false
  },
  'revision.attachments-already-registered': {
    headline: (s) => `Feedback attachment set ${slot(s.attachmentSetSha256)} was already registered; the exact retry made no change.`,
    preserves: true
  },
  'revision.attachments-status-reported': {
    headline: (s) => `${slot(s.count, '0')} feedback attachment set status record(s) for ${slot(s.phaseId)}.`,
    preserves: true
  },
  'revision.attachments-removal-preview-staged': {
    headline: (s) => `Staged removal plan ${slot(s.planId)}. Registered evidence is unchanged until confirmation.`,
    preserves: false
  },
  'revision.attachments-removed': {
    headline: (s) => `Excluded attachment set ${slot(s.attachmentSetSha256)} from future routing. Original local proof remains auditable.`,
    preserves: false
  },
  'revision.attachments-already-removed': {
    headline: (s) => `Attachment set ${slot(s.attachmentSetSha256)} was already excluded; the exact retry made no change.`,
    preserves: true
  },
  'sequence.refused': {
    headline: (s) => `Cannot ${slot(s.action, 'do that')}${s.phase ? ` for ${slot(s.phase)}` : ''} yet.`,
    preserves: true
  },
  'submit.refused': {
    headline: (s) => `Cannot submit ${slot(s.phase, 'this phase')} for approval.`,
    preserves: true
  },
  'submit.succeeded': {
    headline: (s) => `Submitted ${slot(s.phase)} for approval with ${slot(s.documents, '0')} generated document(s).`,
    preserves: false
  },
  'submit.completed': {
    headline: (s) => `Completed ${slot(s.phase)} with ${slot(s.documents, '0')} generated document(s); its approval policy required no review.${finalCheckSentence(s)}`,
    preserves: false
  },
  'submit.noop': {
    headline: (s) => `${slot(s.phase)} is already awaiting approval.`,
    preserves: true
  },
  'approve.succeeded': {
    // A vote that does not reach the phase's threshold leaves the Story where it was.
    headline: (s) => (s.reached === false
      ? `Recorded an approval for ${slot(s.phase)}; it still needs more approvals before the Story moves on.`
      : s.next
        ? `Approved ${slot(s.phase)}. The Story is now at ${slot(s.next)}.`
        : `Approved ${slot(s.phase)}.${finalCheckSentence(s)}`),
    preserves: false
  },
  'approve.refused': {
    headline: (s) => `Cannot approve ${slot(s.phase, 'this phase')}.`,
    preserves: true
  },
  'import.added': {
    headline: (s) => (s.proposed
      ? `Import of ${slot(s.kind)} ${slot(s.id)} published for review on ${slot(s.branch)}.`
      : `Imported ${slot(s.kind)} ${slot(s.id)}: ${slot(s.files)} file change(s) written for review.`),
    preserves: false
  },
  'import.removed': {
    headline: (s) => (s.proposed
      ? `Removal of import ${slot(s.key)} published for review on ${slot(s.branch)}.`
      : `Removed import ${slot(s.key)}: ${slot(s.files)} file change(s) written for review.`),
    preserves: false
  },
  'marketplace.added': {
    headline: (s) => (s.proposed
      ? `Trusting marketplace ${slot(s.id)} published for review on ${slot(s.branch)}.`
      : `Marketplace ${slot(s.id)} is trusted: ${slot(s.files)} file change(s) written for review.`),
    preserves: false
  },
  'marketplace.removed': {
    headline: (s) => (s.proposed
      ? `No longer trusting marketplace ${slot(s.id)}: published for review on ${slot(s.branch)}.`
      : `Marketplace ${slot(s.id)} is no longer trusted: ${slot(s.files)} file change(s) written for review.`),
    preserves: false
  },
  'decision.choose.succeeded': {
    headline: (s) => (s.kind === 'loop'
      ? `Decision ${slot(s.decision)} chose ${slot(s.route)}; the Story goes back to ${slot(s.target)}.`
      : s.target
        ? `Decision ${slot(s.decision)} chose ${slot(s.route)}; the Story is now at ${slot(s.target)}.`
        : `Decision ${slot(s.decision)} chose ${slot(s.route)}.${finalCheckSentence(s)}`),
    preserves: false
  },
  'decision.applicability.succeeded': {
    headline: (s) => `Recorded that ${slot(s.responsibility)} does not apply to this Story.`,
    preserves: false
  },
  'reject.succeeded': {
    headline: (s) => `Requested changes to ${slot(s.phase)}; the Story is back at ${slot(s.target)}.`,
    preserves: false
  },
  'status.reported': {
    headline: (s) => `${slot(s.workId)} is at ${slot(s.phase)}.`,
    preserves: true
  },
  'source-review.context-reported': {
    headline: (s) => `Pinned source review context for ${slot(s.workId)} / ${slot(s.phase)} generation ${slot(s.generation)} is ready.`,
    preserves: true
  },
  'source-review.status-reported': {
    headline: (s) => `Source review for ${slot(s.workId)} / ${slot(s.phase)} is ${slot(s.status)}.`,
    preserves: true
  },
  'source-review.submitted': {
    headline: (s) => `Retained independent source review ${slot(s.reportSha256)} for ${slot(s.workId)} / ${slot(s.phase)}.`,
    preserves: false
  },
  'source-review.decided': {
    headline: (s) => `Recorded human source review decision ${slot(s.findingId)} for ${slot(s.workId)} / ${slot(s.phase)}.`,
    preserves: false
  },
  'context.reported': {
    headline: (s) => `Context X-Ray for ${slot(s.workId)} covers ${slot(s.phase)}.`,
    preserves: true
  },
  'context.compiled': {
    headline: (s) => `Compiled ${slot(s.packetId)} with ${slot(s.items)} item(s); status ${slot(s.status)}.`,
    preserves: false
  },
  'context.expanded': {
    headline: (s) => `Expanded ${slot(s.packetId)} as ${slot(s.representation)} (${slot(s.bytes)} bytes).`,
    preserves: false
  },
  'context.diagnosed': {
    headline: (s) => `Token economy is ${slot(s.status)} in ${slot(s.mode)} mode with profile ${slot(s.profile)}.`,
    preserves: true
  },
  'tokens.reported': {
    headline: (s) => `Token Ledger for ${slot(s.workId)} covers ${slot(s.phase)}.`,
    preserves: true
  },
  'tokens.daily-reported': {
    headline: (s) => `Token Ledger for ${slot(s.date)} covers ${slot(s.modelInvocations, '0')} model invocation(s) and ${slot(s.contextPackets, '0')} context packet(s).`,
    preserves: true
  },
  'evidence.matrix.reported': {
    headline: (s) => `${slot(s.workId)}: ${slot(s.satisfied, '0')} of ${slot(s.rows, '0')} requirement and criterion row(s) satisfied; ${slot(s.label)}.`,
    preserves: true
  },
  'approvals.reported': {
    headline: (s) => `${slot(s.workId)} has ${slot(s.received)}/${slot(s.required)} required approval(s) across ${slot(s.phases)} phase(s).`,
    preserves: true
  },
  'comprehension.regions-reported': {
    headline: (s) => `Observed ${slot(s.regions, '0')} conservative change region(s) at ${slot(s.granularity, 'resource')} granularity.`,
    preserves: true
  },
  'comprehension.source-expanded': {
    headline: (s) => `Expanded ${slot(s.bytes, '0')}/${slot(s.totalBytes, '0')} exact byte(s) from the ${slot(s.side)} side of ${slot(s.path)}${s.complete ? '' : ' (more available)'}.`,
    preserves: true
  },
  'comprehension.brownfield-reported': {
    headline: (s) => `Brownfield touched-area assessment covers ${slot(s.regions, '0')} changed region(s): ${slot(s.newRegions, '0')} new, ${slot(s.touchedLegacy, '0')} legacy touched, and ${slot(s.mechanicalMoves, '0')} mechanical-move candidate(s).`,
    preserves: true
  },
  'comprehension.backfill-validated': {
    headline: (s) => `Historical backfill proposal is ${slot(s.status)} across ${slot(s.entries, '0')} entry(ies): ${slot(s.confirmed, '0')} confirmed-proposed, ${slot(s.inferred, '0')} inferred, and ${slot(s.unknown, '0')} unknown.`,
    preserves: true
  },
  'comprehension.coverage-reported': {
    headline: (s) => `Comprehension assessment: ${slot(s.verdict)} with ${slot(s.unresolved, '0')} unresolved material region(s).`,
    preserves: true
  },
  'comprehension.graph-reported': {
    headline: (s) => `Comprehension graph contains ${slot(s.nodes, '0')} node(s) and ${slot(s.edges, '0')} validated edge(s).`,
    preserves: true
  },
  'comprehension.explanation-reported': {
    headline: (s) => `Comprehension explanation for ${slot(s.type)} '${slot(s.subject)}' is ${slot(s.status)} with ${slot(s.nodes, '0')} related node(s).`,
    preserves: true
  },
  'code-explanation.reported': {
    headline: (s) => `Code explanation projected ${slot(s.units, '0')} change unit(s); ${slot(s.unexplained, '0')} remain unexplained.`,
    preserves: true
  },
  'explanation.subject-reported': {
    headline: (s) => `Explained the ${slot(s.subject, 'change')} subject (${slot(s.status, 'available')}) with ${slot(s.statements, '0')} cited statement(s); nothing was changed.`,
    preserves: true
  },
  'comprehension.replay-reported': {
    headline: (s) => `Projected ${slot(s.events, '0')} comprehension replay event(s) for ${slot(s.workId)}${s.truncated ? ' (truncated)' : ''}.`,
    preserves: true
  },
  'comprehension.walkthrough-validated': {
    headline: (s) => `Walkthrough validation is ${slot(s.status)} across ${slot(s.claims, '0')} typed claim(s), with ${slot(s.unavailable, '0')} unavailable.`,
    preserves: true
  },
  'comprehension.walkthrough-drafted': {
    headline: (s) => `Drafted ${slot(s.claims, '0')} deterministic resource-level walkthrough claim(s); no model, authority, or repository write was used.`,
    preserves: true
  },
  'comprehension.walkthrough-revalidated': {
    headline: (s) => `Walkthrough revalidation is ${slot(s.status)} across ${slot(s.claims, '0')} current claim(s): ${slot(s.revalidated, '0')} revalidated and ${slot(s.invalidated, '0')} invalidated.`,
    preserves: true
  },
  'comprehension.record-preview-created': {
    headline: (s) => `Experimental comprehension record preview is ${slot(s.verdict)} across ${slot(s.regions, '0')} region(s), with ${slot(s.unresolved, '0')} unresolved.`,
    preserves: true
  },
  'comprehension.record-preview-migrated': {
    headline: (s) => `Experimental comprehension preview migrated from schema ${slot(s.storedSchemaVersion)} to ${slot(s.currentSchemaVersion)} in ${slot(s.steps, '0')} step(s).`,
    preserves: true
  },
  'change.shadow-reported': {
    headline: (s) => `Shadow Change Passport for ${slot(s.workId)} is ${slot(s.status)} with ${slot(s.gaps, '0')} explicit gap(s).`,
    preserves: true
  },
  'proof.observation-reported': {
    headline: (s) => `Proof ${slot(s.action, 'status')} for ${slot(s.workId)} is ${slot(s.status)}.`,
    preserves: true
  },
  'resume.succeeded': {
    headline: (s) => `Resumed ${slot(s.workId)} on ${slot(s.branch)}.`,
    preserves: false
  },
  'agent.selected': {
    headline: (s) => `Selected ${slot(s.agent)} for ${slot(s.workId)}.`,
    preserves: false
  },
  'constitution.reported': {
    headline: (s) => `Checked the constitution at ${slot(s.path)}: ${slot(s.articles)} article(s), ${slot(s.findings)} integrity finding(s).`,
    preserves: true
  },
  'constitution.shown': {
    headline: (s) => `Listed ${slot(s.articles)} constitution article(s) from ${slot(s.path)}.`,
    preserves: true
  },
  'constitution.generated': {
    headline: (s) => `Regenerated ${slot(s.regenerated)} enforced constitution article(s); judged articles were preserved.`
  },
  'constitution.excepted': {
    headline: (s) => `Recorded an exception to ${slot(s.article)} for ${slot(s.scope)}.`
  },
  'clarification.reported': {
    headline: (s) => `Checked clarification readiness for ${slot(s.phase)} generation ${slot(s.generation)}.`,
    preserves: true
  },
  'clarification.recorded': {
    headline: (s) => `Recorded ${slot(s.responses, '0')} clarification response(s) for ${slot(s.phase)} generation ${slot(s.generation)}.`,
    preserves: false
  },
  'start.succeeded': {
    // The branch is usually named after the work ID, so naming both says the same thing twice.
    headline: (s) => `Started ${slot(s.workId)}${s.branch && s.branch !== s.workId ? ` on ${slot(s.branch)}` : ''}. Its first phase is ${slot(s.phase)}.`,
    preserves: false
  },
  'prepare.succeeded': {
    headline: (s) => `${slot(s.phase)} is ready to author in ${slot(s.path)}.`,
    preserves: false
  },
  'prepare.noop': {
    headline: (s) => `${slot(s.phase)} was already prepared; your work is untouched.`,
    preserves: true
  },
  'local-reset.previewed': {
    headline: (s) => `Previewed local reset for ${slot(s.workspaces, '0')} registered workspace(s).`,
    preserves: true
  },
  'local-reset.completed': {
    headline: (s) => `Removed ${slot(s.workspaces, '0')} registered workspace(s) and reset local Singularity state.`,
    preserves: false
  },
  'quickstart.completed': {
    headline: (s) => `Walked one Story through ${slot(s.steps, 'every')} governed ${Number(s.steps) === 1 ? 'step' : 'steps'} in a throwaway repository.`,
    // The sandbox is created and removed inside the command. The repository the reader is standing
    // in is untouched, which is the whole reason this is safe to run first.
    preserves: true
  },
  'recommend.ready': {
    headline: (s) => `${s.name ? `${slot(s.name)}, ` : ''}${slot(s.workId)} is at ${slot(s.phase)}. Next: ${slot(s.action)}.`,
    preserves: true
  },
  'recommend.no-current-work': {
    headline: (s) => `${s.name ? `${slot(s.name)}, ` : ''}no governed work is currently selected.`,
    preserves: true
  },
  'goal.created': {
    headline: (s) => `Created ${slot(s.goalId)} — ${slot(s.statement)}.`
  },
  'transport.reported': {
    headline: (s) => s.intentId
      ? `Transport ${slot(s.intentId)} is ${slot(s.status)}; commit ${slot(s.commit)} remains addressable.`
      : `Found ${slot(s.count, '0')} pending transport intent(s).`,
    preserves: true
  },
  'integrations.listed': {
    headline: (s) => s.scope && s.scope !== 'repository'
      ? `${slot(s.scope)} pinned ${slot(s.actions, '0')} after-step action(s) to ${slot(s.targets, '0')} target(s).`
      : `${slot(s.targets, '0')} integration target(s); ${slot(s.actions, '0')} after-step action(s) configured.`,
    preserves: true
  },
  'integrations.status': {
    headline: (s) => `Found ${slot(s.count, '0')} after-step deliver${s.count === 1 ? 'y' : 'ies'}${s.open ? `; ${slot(s.open)} not delivered yet${s.failed ? `, ${slot(s.failed)} failed` : ''}` : ''}.`,
    preserves: true
  },
  'integrations.retried': {
    headline: (s) => `Tried ${slot(s.count, '0')} deliver${s.count === 1 ? 'y' : 'ies'}: ${slot(s.delivered, '0')} delivered, ${slot(s.pending, '0')} still pending, ${slot(s.failed, '0')} failed.`
  },
  'integrations.recorded': {
    headline: (s) => s.dryRun
      ? `Would record ${slot(s.pending, '0')} after-step receipt(s); nothing was committed.`
      : s.count
        ? `Recorded ${slot(s.count)} after-step receipt(s) in commit ${slot(String(s.commit ?? '').slice(0, 8))}.`
        : `Nothing to record; ${slot(s.recorded, '0')} after-step receipt(s) already recorded.`
  },
  'integrations.pipeline-delivered': {
    headline: (s) => !s.lifecycle
      ? `${slot(s.commit)} is not a lifecycle commit; nothing was delivered.`
      : s.count
        ? `Delivered ${slot(s.delivered, '0')} of ${slot(s.count)} pipeline deliver${s.count === 1 ? 'y' : 'ies'} for ${slot(s.commit)}${s.open ? `; ${slot(s.open)} did not go out` : ''}${s.untrusted ? `; ${slot(s.untrusted)} not trusted` : ''}.`
        : `${slot(s.commit)} calls for no pipeline delivery.`
  },
  'integrations.tested': {
    headline: (s) => s.sent
      ? `Sent a test delivery to ${slot(s.target)}: ${slot(s.outcome)}${s.status ? ` (HTTP ${slot(s.status)})` : ''}.`
      : `Showed the request ${slot(s.target)} would receive; nothing was sent.`,
    preserves: true
  },
  'transport.retry-completed': {
    headline: (s) => `Transport ${slot(s.intentId)} is ${slot(s.status)} after the authorized retry.`
  },
  'goal.listed': {
    headline: (s) => `Found ${slot(s.count, '0')} Goal(s) in ${slot(s.workspace)}.`,
    preserves: true
  },
  'goal.shown': {
    headline: (s) => `${slot(s.goalId)} is ${slot(s.status)}.`,
    preserves: true
  },
  'goal.next': {
    headline: (s) => `${slot(s.goalId)} — next: ${slot(s.action)}.`,
    preserves: true
  },
  'goal.selected': {
    headline: (s) => `Selected ${slot(s.goalId)} as the active Goal.`
  },
  'goal.already-selected': {
    headline: (s) => `${slot(s.goalId)} is already the active Goal.`,
    preserves: true
  },
  'goal.linked': {
    headline: (s) => `Linked ${slot(s.workId)} to ${slot(s.goalId)}.`
  },
  'goal.already-linked': {
    headline: (s) => `${slot(s.workId)} is already linked to ${slot(s.goalId)}.`,
    preserves: true
  },
  'goal.unlinked': {
    headline: (s) => `Unlinked ${slot(s.workId)} from ${slot(s.goalId)}.`
  },
  'goal.completed': {
    headline: (s) => `Recorded ${slot(s.goalId)} as achieved.`
  },
  'goal.abandoned': {
    headline: (s) => `Abandoned ${slot(s.goalId)} and preserved its history.`
  },
  'goal.proposed': {
    headline: (s) => `Prepared a read-only governed Goal proposal for ${slot(s.workspace)}.`,
    preserves: true
  },
  'goal.governed': {
    headline: (s) => `Promoted ${slot(s.personalGoalId)} into governed Goal ${slot(s.goalId)}.`
  },
  'goal.governed-listed': {
    headline: (s) => `Found ${slot(s.count, '0')} governed Goal(s) in ${slot(s.workspace)}.`,
    preserves: true
  },
  'goal.plan-compiled': {
    headline: (s) => `Compiled ${slot(s.goalId)} plan generation ${slot(s.generation)} (${slot(s.planSha256)}).`
  },
  'goal.plan-approved': {
    headline: (s) => `Approved ${slot(s.goalId)} plan generation ${slot(s.generation)} by exact hash ${slot(s.planSha256)}.`
  },
  'goal.step-evaluated': {
    headline: (s) => `${slot(s.goalId)} evaluated approved step ${slot(s.stepId)}.`
  },
  'goal.verified': {
    headline: (s) => `${slot(s.goalId)} oracle evaluation is ${slot(s.assurance)}.`
  },
  'goal.impact-reported': {
    headline: (s) => `Reported the bounded impact of ${slot(s.goalId)}.`,
    preserves: true
  },
  'goal.change-proposed': {
    headline: (s) => `Prepared a read-only change impact proposal for ${slot(s.goalId)}.`,
    preserves: true
  },
  'goal.trace-reported': {
    headline: (s) => `Traced contract, plan, approval, and oracle bindings for ${slot(s.goalId)}.`,
    preserves: true
  },
  'goal.paused': {
    headline: (s) => `Paused governed Goal ${slot(s.goalId)}.`
  },
  'goal.resumed': {
    headline: (s) => `Resumed governed Goal ${slot(s.goalId)}.`
  },
  'goal.synced': {
    headline: (s) => `Published governed Goal ${slot(s.goalId)} at ${slot(s.commit)}.`
  },
  'goal.precommit-recovered': {
    headline: (s) => `Restored interrupted governed Goal creation ${slot(s.goalId)} before publication.`
  },
  'goal.already-synced': {
    headline: (s) => `Governed Goal ${slot(s.goalId)} is already published.`,
    preserves: true
  },
  'journal.today-reported': {
    headline: (s) => `Local journal for ${slot(s.date)} — ${slot(s.events, '0')} bounded event(s).`,
    preserves: true
  },
  'journal.settings-reported': {
    headline: (s) => `Local journal capture is ${slot(s.paused) === 'true' ? 'paused' : slot(s.mode)} with ${slot(s.retentionDays)}-day retention.`,
    preserves: true
  },
  'journal.doctor-reported': {
    headline: (s) => `Local journal doctor — ${slot(s.status)}.`,
    preserves: true
  },
  'journal.refreshed': {
    headline: (s) => s.stored === true
      ? 'Recorded a fresh local repository observation.'
      : 'The current local repository observation was already recorded.'
  },
  'journal.settings-updated': {
    headline: (s) => `Updated local journal capture to ${slot(s.paused) === 'true' ? 'paused' : slot(s.mode)}.`
  },
  'journal.deleted': {
    headline: (s) => `Deleted ${slot(s.scope)} from the machine-local journal.`
  },
  'journal.export-previewed': {
    headline: (s) => `Previewed the ${slot(s.format)} local journal export for ${slot(s.date)}.`,
    preserves: true
  },
  'journal.exported': {
    headline: (s) => `Exported the reviewed ${slot(s.format)} local journal summary for ${slot(s.date)}.`
  },
  'fault.recorded': {
    headline: (s) => `Recorded fault ${slot(s.faultId)} (${slot(s.type)}, ${slot(s.severity)}).`
  },
  'fault.returned': {
    headline: (s) => `Fault ${slot(s.faultId)} is ${slot(s.disposition, 'recorded')}.`,
    preserves: true
  },
  'fault.listed': {
    headline: (s) => `Found ${slot(s.count, '0')} local fault record(s).`,
    preserves: true
  },
  'repair.diagnosed': {
    headline: (s) => `Diagnosed ${slot(s.faultId)}: ${slot(s.disposition)}.`
  },
  'repair.planned': {
    headline: (s) => `${s.preview ? 'Previewed' : 'Created'} repair ${slot(s.repairId)} in ${slot(s.status)} state.`
  },
  'repair.listed': {
    headline: (s) => `Found ${slot(s.count, '0')} local repair run(s).`,
    preserves: true
  },
  'repair.returned': {
    headline: (s) => `Repair ${slot(s.repairId)} is ${slot(s.status)}.`,
    preserves: true
  },
  'repair.authorized': {
    headline: (s) => `Authorized repair ${slot(s.repairId)} for its exact plan.`
  },
  'repair.attempted': {
    headline: (s) => `Repair ${slot(s.repairId)} attempt finished as ${slot(s.status)}.`
  },
  'repair.cancelled': {
    headline: (s) => `Cancelled repair ${slot(s.repairId)} and preserved its history.`
  }
});

/**
 * Reason codes. Each renders one WHY line from its slots.
 *
 * A reason explains a decision. "The phase is requirements" is state; "requirements is phase 1 of
 * the rail this Story pinned at start" is a reason.
 */
export const REASONS = Object.freeze({
  'evidence.from-committed-records': {
    render: () => "each row was evaluated from the Story's committed plan, delivery receipts, test receipts and approvals; no test or network call ran"
  },
  'scope.from-pinned-sources': {
    render: () => 'the statements were read from the pinned Story source, its active documents and its answered clarifications; nothing ran and nothing changed'
  },
  'governance.rebuild-invariants': {
    render: (s) => `the commit changed only the rebuilt framework files, the archive registry and the receipt ${slot(s.receipt)}; every other ref and every repository-owned definition is unchanged`
  },
  'governance.from-approved-configuration': {
    render: (s) => `the plan was built from the ${slot(s.mode)} configuration at ${slot(s.commit)}, exported into a scratch directory; the checkout and its branches were not touched`
  },
  'approvals.from-pinned-state': {
    render: () => 'the phase order, documents, authority groups, and decisions came from the pinned Story aggregate'
  },
  'fastpath.phase-not-owned': {
    render: (s) => `this Story is at a phase this verb does not route${s.phase ? ` (${slot(s.phase)})` : ''}`
  },
  'phase.selected-by-pinned-rail': {
    render: (s) => `${slot(s.phase)} is phase ${slot(s.position)} of the rail this Story pinned when it started`
  },
  'sequence.gate-failed': {
    render: (s) => `${slot(s.failed)} of ${slot(s.total)} sequence gates have not passed`
  },
  'artifact.missing': {
    render: (s) => `the phase requires ${slot(s.path)}, which is not present`
  },
  'generation.not-published': {
    render: (s) => `no generation of ${slot(s.phase)} has been published yet`
  },
  'approval.authority-required': {
    render: (s) => `approval needs ${slot(s.authority)}, and your identity is not in it`
  },
  'approval.threshold-unmet': {
    render: (s) => `${slot(s.have)} of ${slot(s.need)} required approvals have been recorded`
  },
  'publication.pending': {
    render: () => 'a previous publication committed but did not push, so the Story is mid-transition'
  },
  'ledger.behind': {
    render: (s) => `the capability ledger has ${slot(s.pending)} unpublished intent(s)`
  },
  'grounding.not-ready': {
    render: (s) => `the world-model grounding policy is '${slot(s.mode)}' and no composition exists for this generation`
  },
  'docs.no-such-topic': {
    render: (s) => `'${slot(s.query)}' is not a topic id, an alias, or the prefix of one`
  },
  'docs.prefix-ambiguous': {
    render: (s) => `'${slot(s.query)}' is the prefix of ${slot(s.count)} topics, and choosing one would be a guess`
  },
  'docs.subject-unresolved': {
    render: () => 'no work item resolves here, so only the concept could be served'
  },
  'recommend.from-durable-state': {
    render: () => 'the recommendation was reconstructed from durable workspace, repository, lifecycle, and evidence records'
  },
  'goal.from-workspace-state': {
    render: (s) => `the Goal came from the personal durable record for workspace ${slot(s.workspace)}`
  },
  'goal.from-governed-repository': {
    render: (s) => `governed Goal ${slot(s.goalId)} was reconstructed from its repository lifecycle branch`
  }
});

export function messageIds() { return Object.keys(MESSAGES); }
export function reasonCodes() { return Object.keys(REASONS); }

/** Messages whose wording promises that nothing changed. */
export function preservingMessageIds() {
  return messageIds().filter((id) => MESSAGES[id].preserves);
}
