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
  }
});

/**
 * Reason codes. Each renders one WHY line from its slots.
 *
 * A reason explains a decision. "The phase is requirements" is state; "requirements is phase 1 of
 * the rail this Story pinned at start" is a reason.
 */
export const REASONS = Object.freeze({
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
  }
});

export function messageIds() { return Object.keys(MESSAGES); }
export function reasonCodes() { return Object.keys(REASONS); }

/** Messages whose wording promises that nothing changed. */
export function preservingMessageIds() {
  return messageIds().filter((id) => MESSAGES[id].preserves);
}
