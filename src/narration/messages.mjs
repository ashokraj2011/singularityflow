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

export const MESSAGES = Object.freeze({
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
    headline: (s) => `Completed ${slot(s.phase)} with ${slot(s.documents, '0')} generated document(s); its approval policy required no review.`,
    preserves: false
  },
  'submit.noop': {
    headline: (s) => `${slot(s.phase)} is already awaiting approval.`,
    preserves: true
  },
  'approve.succeeded': {
    headline: (s) => (s.next
      ? `Approved ${slot(s.phase)}. The Story is now at ${slot(s.next)}.`
      : `Approved ${slot(s.phase)}. The Story is complete.`),
    preserves: false
  },
  'approve.refused': {
    headline: (s) => `Cannot approve ${slot(s.phase, 'this phase')}.`,
    preserves: true
  },
  'reject.succeeded': {
    headline: (s) => `Requested changes to ${slot(s.phase)}; the Story is back at ${slot(s.target)}.`,
    preserves: false
  },
  'status.reported': {
    headline: (s) => `${slot(s.workId)} is at ${slot(s.phase)}.`,
    preserves: true
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
  'approvals.reported': {
    headline: (s) => `${slot(s.workId)} has ${slot(s.received)}/${slot(s.required)} required approval(s) across ${slot(s.phases)} phase(s).`,
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
