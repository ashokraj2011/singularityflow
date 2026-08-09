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
  'quickstart.completed': {
    headline: (s) => `Walked one work item through ${slot(s.steps, 'every')} governed ${Number(s.steps) === 1 ? 'step' : 'steps'} in a throwaway repository.`,
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
  }
});

export function messageIds() { return Object.keys(MESSAGES); }
export function reasonCodes() { return Object.keys(REASONS); }

/** Messages whose wording promises that nothing changed. */
export function preservingMessageIds() {
  return messageIds().filter((id) => MESSAGES[id].preserves);
}
