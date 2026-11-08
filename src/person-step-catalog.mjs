/**
 * One catalog of a person's steps on a Story [study 6.3]: which turn may run each, which record SF
 * Guard signs, what it does to a review, what an approval may carry. These answers once lived in
 * seven tables that tests kept in step; each table is now a read of this file.
 *
 * Pure data: nothing here decides anything. The guard enforces (copilot-mutation-guard.mjs), SF Guard
 * signs and counts (presence/person-steps.mjs), the review rules verify (state.mjs). Leaf module, read on
 * every hook, so it imports nothing. test/person-step-golden.test.mjs pins every command form against
 * every turn, the signed families and the review effects: this file must leave that unchanged.
 */

/**
 * The decision-list options a /sf-decide turn may record, after the person's explicit yes: they
 * write only upstream-issue records (copilot-mutation-guard.mjs). Every other choice is recorded in
 * the person's own terminal.
 */
export const DECISION_LIST_CHAT_OPTIONS = Object.freeze(['accept-risk', 'dismiss', 'return']);
const CHAT_CHOICE = new RegExp(`^d\\d{1,3}=(?:${DECISION_LIST_CHAT_OPTIONS.join('|')})$`, 'u');

/**
 * `decision plan` flags that correct an approved plan's rows. A correction is recorded only after a
 * person who approves the plan reviews the exact rows in a live terminal, so outside a preview it is
 * their own terminal step; a narrow amendment (`--add-location`) is not.
 */
export const PLAN_CORRECTION_FLAGS = Object.freeze(['add-row', 'set-fulfillment', 'add-test', 'remove-test', 'replace-test', 'remove-location', 'replace-location']);
export function planRowCorrectionStep([command, sub], options) {
  return command === 'decision' && sub === 'plan' && options['dry-run'] !== true
    && PLAN_CORRECTION_FLAGS.some((flag) => options[flag] !== undefined);
}

/**
 * Decisions recorded only after the person reviews their exact card in a live terminal
 * (captureTerminalActionAuthorization): an appeal's decision, attestation or risk, a Story test-policy
 * risk, amendment, baseline admission or attestation applied, and a test-scope confirmation. A Copilot
 * turn admitted them, then the terminal review refused the agent's shell, or a pty let an agent type
 * the person's confirmation (2026-10-28). Their previews stay open; `evidence-accept --review-ui`
 * is the browser review /sf-appeal opens for the person. A confirmed approver refresh is one too.
 */
const APPEAL_TERMINAL_REVIEWS = new Set(['decide', 'attest', 'risk-accept', 'risk-attest', 'risk-revoke', 'evidence-accept']);
const TEST_POLICY_TERMINAL_REVIEWS = new Set(['accept-risk', 'revoke-risk', 'attest-risk', 'amend', 'baseline-admission', 'attest']);
export function liveTerminalReviewStep([command, sub, verb], options) {
  if (command === 'appeal') return APPEAL_TERMINAL_REVIEWS.has(sub) && !(sub === 'evidence-accept' && options['review-ui'] === true);
  if (command === 'story' && sub === 'approvers') return verb === 'refresh' && options.confirm !== undefined;
  return command === 'story' && sub === 'test-policy'
    && ((TEST_POLICY_TERMINAL_REVIEWS.has(verb) && options.apply === true) || (verb === 'confirm' && options.confirm !== undefined));
}

/** `story adjudicate` with nothing named: the table in a person's own terminal. */
export function adjudicationTableStep([command, sub, item], options) {
  return command === 'story' && sub === 'adjudicate' && !item && options.answers === undefined && options.item === undefined && options.disposition === undefined;
}

/**
 * Steps only a person takes, in their own terminal. copilot-mutation-guard.mjs refuses each in every
 * turn, so a skill route to one only showed it again and pointed back to that skill: /sf-decide for
 * a witness (2026-10-26), then for an accepted test command and its decision-list record
 * (2026-10-27). No surface routes them to a skill. test/phase-mutation-contract.test.mjs holds the
 * guard's refusals and the routes to this list.
 */
export const OWN_TERMINAL_STEPS = Object.freeze([
  ['witness', ([command, sub]) => command === 'decision' && sub === 'witness'],
  // A card records a person's answers from outside chat; no chat writes the file for them.
  ['adjudication-answers', ([command, sub], options) => command === 'story' && sub === 'adjudicate' && options.answers !== undefined],
  // The whole table asks a person at their own terminal, and no turn answers it. Naming an item stays /sf-converge's.
  ['adjudication-table', adjudicationTableStep],
  ['risk', ([command, sub]) => command === 'decision' && sub === 'risk'],
  ['witness-exception-renewal', ([command, sub]) => command === 'decision' && sub === 'witness-exception'],
  ['test-run-risk', ([command, sub]) => command === 'decision' && ['test-risk', 'test-narrowing', 'evidence-reuse', 'visual-profile'].includes(sub)],
  ['test-command-decision', ([command, sub], options) => command === 'decision' && sub === 'test-command'
    && (options.accept !== undefined || options.revoke !== undefined)],
  // A /sf-decide turn records only chat options; any other choice, an answers file or the
  // interactive form is the person's.
  ['decision-list-record', ([command, sub], options) => command === 'decisions' && sub === 'record'
    && !(options.choose !== undefined && options.answers === undefined
      && [options.choose].flat().every((entry) => typeof entry === 'string' && CHAT_CHOICE.test(entry)))],
  ['set-aside', ([command], options) => command === 'recover' && options['set-aside'] === true],
  // Without --confirm it is a preview anyone may run.
  ['publication-set-aside', ([command, sub], options) => (command === 'sync' || (command === 'initiative' && sub === 'sync'))
    && options['set-aside'] === true && options.confirm !== undefined],
  ['workflow-delete', ([command, sub], options) => command === 'workflow' && sub === 'delete' && options.confirm !== undefined],
  ['target-origin-pin', ([command, sub], options) => command === 'story' && sub === 'target-origin' && options.confirm !== undefined],
  ['intent-amendment-decision', ([command, sub, verb]) => command === 'story' && sub === 'intent-amendment' && verb === 'decide'],
  ['knowledge-confirmation', ([command, sub, verb]) => command === 'wm'
    && ((sub === 'rules' && verb === 'confirm') || (sub === 'knowledge' && ['confirm', 'correct', 'reject'].includes(verb)))],
  ['spec-drift-decision', ([command, sub, verb]) => command === 'spec' && sub === 'drift' && verb === 'decide'],
  // Taking or turning down Copilot's proposals, a specification's gap decisions, checklist and finding
  // settlement, publication and discard (SPEC-SPA v1.3 §4.1).
  ['spec-library-decision', ([command, sub, verb]) => command === 'spec' && sub === 'author'
    && ['accept', 'reject', 'decide', 'settle', 'publish', 'discard'].includes(verb)],
  // Dropping a clause of a Story's specification slice changes its requested outcome (SPEC-SPA v1.3 §6.3).
  ['spec-slice-change', ([command, sub]) => command === 'spec' && sub === 'attach'],
  // Publishing a split creates child drafts and lists Story start commands for every taker (SPEC-SPA v1.3 §7).
  ['spec-split-publication', ([command, sub], options) => command === 'spec' && sub === 'split' && options.publish === true],
  // An approver's answer from their own clone, under their own Git identity (2026-10-28).
  ['clarification-answer', ([command, sub]) => command === 'clarification' && sub === 'answer'],
  // The /sf-decide turn admitted it, then its live-terminal review refused the agent's shell (2026-10-28).
  ['plan-correction', planRowCorrectionStep],
  ['live-terminal-review', liveTerminalReviewStep],
  // Approving with --confirm-evidence also records the step's planned screenshots and inspections as
  // witnessed: a sign-off on evidence, like decision witness. A chat approval's receipt never bound
  // that list, and its Copilot route dropped the flag and looped (2026-10-29).
  ['approval-evidence-confirmation', ([command], options) => command === 'approve' && options['confirm-evidence'] === true],
  // `upstream-issue decide` for the bound Story is a /sf-decide turn's own; an amendment is not.
  ['upstream-amendment-decision', ([command, sub]) => command === 'upstream-issue' && ['decide-amendment', 'revalidate'].includes(sub)],
  ['environment-binding', ([command, sub]) => command === 'env' && ['bind', 'unbind'].includes(sub)],
  // Which agents a repository runs; APM's own --dry-run preview stays open to a turn [APM A2].
  ['apm-install', ([command, sub], options) => command === 'apm' && ['install', 'update'].includes(sub) && options['dry-run'] !== true],
  // What the organisation's marketplace offers every team, and what its policy allows; each --dry-run
  // preview stays open [APM A4-A5].
  ['apm-organisation', ([command, sub], options) => command === 'apm' && ['publish', 'marketplace', 'policy'].includes(sub) && options['dry-run'] !== true],
  // Ending a lease another process holds: only a person who checked that process is gone (SDA M3).
  ['lock-release', ([command, sub]) => command === 'lock' && ['release', 'release-file'].includes(sub)],
  // Activating approved configuration is the reviewer's decision; every skill already told the
  // person to run it in their own terminal, while /sf-configuration was named as its route (sweep E7).
  ['configuration-approve', ([command, sub]) => command === 'configuration' && sub === 'approve'],
  // SF Guard: registering, rotating, recovering or revoking a presence key, turning the policy on or
  // off and per-person exceptions each take the person's Touch ID (SPEC-PSS-v1); only status reads.
  ['sf-guard-person-step', ([command, sub]) => command === 'guard' && sub !== undefined && !['status', 'reconcile', 'report', 'remote-check'].includes(sub)]
].map(([id, matches]) => Object.freeze({ id, matches })));

/**
 * What a /sf-decide turn may run itself, after asking the person. The same six are a person's
 * decision everywhere else.
 */
export const DECIDE_SKILL_MUTATIONS = Object.freeze(['choose', 'applicability', 'scope', 'completeness', 'plan', 'departure']);
/** Options that write only upstream-issue records (a raise needs no authority; a decision needs its step's approvers). */
export const ISSUE_ONLY_OPTIONS = DECISION_LIST_CHAT_OPTIONS;
/** The turns whose decision commands are held to what the person answered, and the steps it holds (copilot-answer-binding.mjs); approvals keep their own typed confirmation. */
export const ANSWER_BOUND_TURNS = Object.freeze(['decide', 'converge']);
export const ANSWER_BOUND_STEPS = Object.freeze(['story-decision', 'convergence-adjudication', 'upstream-issue-decision', 'decision-list-record']);

const EPIC_COMMANDS = new Set(['initiative', 'epic']);
const HOST_POLICY_ASSERTIONS = ['confirm-protected', 'confirm-push-policy', 'confirm-pin-retention'];
/**
 * A person's decision, recorded under an approval group, that only the skill turn the person starts
 * for it may run after asking them (`owners`, skill names without `sf-`); with no owner, only their
 * own terminal. Inside /sf-phase, /sf-recover and /sf-next every one of these passed the hook, since
 * a turn admits standalone SFlow commands and the CLI's authority check reads the Git identity the
 * agent runs under (2026-11-01).
 */
export const PERSON_DECISIONS = Object.freeze([
  ['story-decision', ([command, sub]) => command === 'decision' && DECIDE_SKILL_MUTATIONS.includes(sub), ['decide']],
  ['story-reopen', ([command]) => command === 'reopen', ['reject']],
  ['convergence-adjudication', ([command, sub]) => command === 'story' && sub === 'adjudicate', ['converge']],
  ['source-review-decision', ([command, sub]) => command === 'review-source' && sub === 'decide', ['review-decide']],
  ['constitution-exception', ([command, sub]) => command === 'constitution' && sub === 'except', ['constitution']],
  ['repair-authorization', ([command, sub]) => command === 'repair' && sub === 'authorize', ['fix']],
  ['telemetry-consent', ([command, sub]) => command === 'telemetry' && sub === 'enable', ['telemetry']],
  ['epic-approval', ([command, sub]) => EPIC_COMMANDS.has(command) && sub === 'approve', ['initiative-approve']],
  ['epic-story-decision', ([command, sub, verb]) => EPIC_COMMANDS.has(command) && sub === 'review' && ['approve', 'reject'].includes(verb), ['epic-review-decision']],
  ['epic-completion', ([command, sub]) => EPIC_COMMANDS.has(command) && sub === 'complete', ['epic-complete']],
  ['goal-plan-approval', ([command, sub, verb]) => command === 'goal' && sub === 'plan' && verb === 'approve', []],
  ['sgos-ratification', ([command, sub], options) => (command === 'intent' && ['ratify', 'confirm'].includes(sub))
    || (command === 'program' && sub === 'approve' && options.confirm !== undefined), []],
  ['capability-break-glass', ([command, sub]) => command === 'capabilities' && sub === 'lease', []],
  ['host-policy-assertion', ([command, sub], options) => command === 'ledger' && sub === 'deployment-check'
    && HOST_POLICY_ASSERTIONS.some((flag) => options[flag] === true), []],
  ['agent-trust', ([command, sub]) => command === 'agents' && sub === 'lock', []]
].map(([id, matches, owners]) => Object.freeze({ id, matches, owners: Object.freeze(owners) })));

const always = () => true;
/** What a review reads of a kind: an effect, and for a review-safe one each list and its history event. */
const safe = (lists) => ({ effect: 'review-safe', lists });

/**
 * One row per decision a person records on a Story:
 *   guard    the entry above that refuses it outside its turn: `own:<id>`, `decision:<id>`, or `turn:<word>` for one the guard names itself
 *   family   where its records live and which are a person's, so SF Guard signs and counts them. A
 *            record's `id`, else what it revokes or accepts, names it on the card. Entries that are not a
 *            person's (a test command request, which anyone may make) are never signed and always count.
 *   review   its kind on a commit (`decision-made:<kind>`) and what it does to a submitted review
 *   effect   the list option's record kind, with `inApproval` when an approval commit may carry it
 */
export const PERSON_STEPS = Object.freeze([
  { id: 'risk', guard: 'own:risk', effect: 'obligation-risk', review: { kind: 'risk', entry: safe({ riskDecisions: 'risk_decided' }) },
    family: { list: 'riskDecisions', action: 'decision.risk', label: 'Risk decision', isPerson: always } },
  { id: 'test-command', guard: 'own:test-command-decision', effect: 'test-command',
    // It changes what the submitted review ran (TEST_COMMAND_DECISION_DURING_REVIEW names returning the step).
    review: { kind: 'test-command', entry: 'refused-during-review' },
    family: { list: 'testCommandDecisions', action: 'decision.test-command', label: 'Test command decision', isPerson: (entry) => Boolean(entry?.accepts || entry?.revokes) } },
  { id: 'test-narrowing', guard: 'own:test-run-risk', effect: 'test-narrowing',
    // A step approver's acceptance of a narrowed test run, or its revocation (`decision test-narrowing`).
    review: { kind: 'test-narrowing', entry: safe({ testNarrowings: 'narrowing_decided' }) },
    family: { list: 'testNarrowings', action: 'decision.test-narrowing', label: 'Test narrowing decision', isPerson: always } },
  { id: 'test-run-risk', guard: 'own:test-run-risk', effect: 'test-run-risk', inApproval: true,
    // A step approver's test-run risk decision, revocation or renewal (`decision test-risk`).
    review: { kind: 'test-risk', entry: safe({ testRunRisks: 'risk_decided' }) },
    family: { list: 'testRunRisks', action: 'decision.test-risk', label: 'Test-run risk decision', isPerson: always } },
  { id: 'evidence-reuse', guard: 'own:test-run-risk', effect: 'evidence-reuse', inApproval: true,
    // A step approver's reuse of an earlier step's recorded test run, or its revocation (`decision evidence-reuse`).
    review: { kind: 'evidence-reuse', entry: safe({ evidenceReuses: 'evidence_reuse_decided' }) },
    family: { list: 'evidenceReuses', action: 'decision.evidence-reuse', label: 'Evidence reuse decision', isPerson: always } },
  { id: 'visual-profile', guard: 'own:test-run-risk', effect: 'visual-profile', inApproval: true,
    // A visual step approver's decision that one of its screen sizes does not apply, or its revocation (`decision visual-profile`).
    review: { kind: 'visual-profile', entry: safe({ visualProfileDecisions: 'visual_profile_decided' }) },
    family: { list: 'visualProfileDecisions', action: 'decision.visual-profile', label: 'Visual profile decision', isPerson: always } },
  { id: 'witness', guard: 'own:witness', review: { kind: 'witness', entry: safe({ witnessRecords: 'witness_recorded' }) },
    family: { list: 'witnessRecords', action: 'decision.witness', label: 'Witness review', isPerson: always } },
  { id: 'witness-exception', guard: 'own:witness-exception-renewal', review: { kind: 'witness-exception', entry: safe({ witnessExceptionRenewals: 'witness_exception_renewed' }) },
    family: { list: 'witnessExceptionRenewals', action: 'decision.witness-exception', label: 'Witness exception renewal', isPerson: always } },
  { id: 'scope', guard: 'decision:story-decision', effect: 'scope-disposition', review: { kind: 'scope', entry: safe({ scopeDispositions: 'scope_decided' }) },
    family: { list: 'scopeDispositions', action: 'decision.scope', label: 'Scope disposition', isPerson: always } },
  { id: 'completeness', guard: 'decision:story-decision', effect: 'completeness-review', review: { kind: 'completeness', entry: safe({ completenessReviews: 'completeness_reviewed' }) },
    family: { list: 'completenessReviews', action: 'decision.completeness', label: 'Completeness review', isPerson: always } },
  { id: 'applicability', guard: 'decision:story-decision', effect: 'applicability', review: { kind: 'applicability', entry: safe({ applicability: 'applicability_decided' }) },
    family: { list: 'applicability', action: 'decision.applicability', label: 'Applicability decision', isPerson: always } },
  { id: 'upstream-issue', guard: 'turn:upstream-issue-decision', effect: ['upstream-issue', 'upstream-issue-decision'], inApproval: true,
    review: { kind: 'upstream-issue', entry: safe({ upstreamIssues: 'upstream_issue_raised', upstreamIssueDecisions: 'upstream_issue_decided' }) },
    family: { list: 'upstreamIssueDecisions', action: 'decision.upstream-issue', label: 'Upstream issue decision', isPerson: always } },
  { id: 'forward-amendment', guard: 'own:upstream-amendment-decision',
    family: { list: 'forwardAmendmentDecisions', action: 'decision.forward-amendment', label: 'Forward amendment decision', isPerson: always } },
  { id: 'plan-amendment', guard: 'decision:story-decision', effect: ['plan-amendment', 'node-pin'], review: { kind: 'plan', entry: safe({ planAmendments: 'plan_amended' }) },
    family: { list: 'planAmendments', action: 'decision.plan', label: 'Plan amendment', isPerson: always } },
  // A code step's departures [CQF:REQ-021]: the model records them (`departure record`), and a person's
  // rejection is its own record (`decision departure`); an acceptance is the record its kind already has.
  { id: 'departure', guard: 'decision:story-decision', effect: 'departure', review: { kind: 'departure', entry: safe({ departures: 'departure_recorded', departureDecisions: 'departure_decided' }) },
    family: { list: 'departureDecisions', action: 'decision.departure', label: 'Departure decision', isPerson: always } },
  { id: 'amendment-revalidation', guard: 'own:upstream-amendment-decision', review: { kind: 'forward-amendment', entry: safe({ amendmentRevalidations: 'amendment_revalidated' }) },
    family: { list: 'amendmentRevalidations', action: 'decision.revalidate', label: 'Amendment revalidation', isPerson: always } },
  // SPEC-PSS-v1 §10.12: an intent amendment's or a skill version's decision sits inside its summary. The
  // command signs it before it is written; here it is read so every check counts it like the rest.
  { id: 'intent-amendment', guard: 'own:intent-amendment-decision',
    family: { list: 'intentAmendments', action: 'decision.intent-amendment', label: 'Intent amendment decision', isPerson: always,
      records: (container) => (container?.intentAmendments ?? []).map((entry) => entry?.decision).filter(Boolean) } },
  { id: 'skill-version', guard: 'turn:sf-story-skill-version',
    family: { list: 'skillVersionAmendments', action: 'decision.skill-version', label: 'Skill version decision', isPerson: always,
      records: (container) => (container?.skillVersionAmendments ?? []).flatMap((entry) => [...(entry?.approvals ?? []), ...(entry?.rejection ? [entry.rejection] : [])]) } },
  // SPEC-PSS-v1 §10.6: a constitution exception waives an article for the Story; a person's choice at a
  // workflow decision routes it (a rule's routing is never a person's and is never signed).
  { id: 'constitution-exception', guard: 'decision:constitution-exception',
    family: { list: 'constitutionExceptions', action: 'decision.constitution-exception', label: 'Constitution exception', isPerson: always } },
  { id: 'decision-choice', guard: 'decision:story-decision', effect: 'routing', review: { kind: 'workflow', entry: 'refused-during-review' },
    family: { list: 'decisionLog', action: 'decision.choose', label: 'Decision', isPerson: (entry) => entry?.by === 'person' } },
  // SPEC-PSS-v1 §10.7: a live terminal review's decision keeps its signature in the record it writes. A
  // quality risk, artifact risk or disputed finding (and its revocation) waives or restores a gate; an
  // appeal decision accounts for scope. Each is signed in its own transaction, before its retained copy.
  { id: 'quality-risk', guard: 'own:live-terminal-review', review: { kind: 'quality-risk', entry: safe({ qualityRiskDecisions: 'quality_risk_decided' }) },
    family: { list: 'qualityRiskDecisions', action: 'decision.quality-risk', label: 'Quality risk decision', isPerson: always } },
  { id: 'appeal-decision', guard: 'own:live-terminal-review', review: { kind: 'phase-appeal', entry: 'stales-submission' },
    family: { list: 'phaseAppealDecisions', action: 'decision.appeal', label: 'Appeal decision', isPerson: always } },
  // SPEC-PSS-v1 §10.8: a test-policy amendment changes which tests a step runs, an approver refresh who may
  // approve it. Their summaries are immutable, exact-key families, so each signature is kept beside the
  // summary as a seal (`personSeals`) rather than inside it. A test selection and a test-run risk review
  // (acceptance, re-attestation, revocation, a baseline re-review) keep theirs on the entry itself.
  { id: 'test-command-amendment', guard: 'own:live-terminal-review',
    family: { list: 'testCommandAmendments', action: 'story.test-policy-apply', label: 'Test command amendment', sealed: true, isPerson: (entry) => entry?.kind === 'test-command-adoption-summary' } },
  // Members the approved configuration added to the Story's own groups (approval-check.mjs verifies the commit).
  { id: 'approver-refresh', guard: 'own:live-terminal-review', review: { kind: 'approver-refresh', entry: safe({ approverRefreshes: 'approvers_refreshed' }) },
    family: { list: 'approverRefreshes', action: 'story.approvers-refresh', label: 'Approver refresh', sealed: true, isPerson: (entry) => entry?.kind === 'approver-refresh-summary' } },
  { id: 'test-selection', guard: 'own:live-terminal-review',
    family: { list: 'testRecovery.selectionConfirmations', path: ['testRecovery', 'selectionConfirmations'], action: 'story.test-selection', label: 'Test selection confirmation', isPerson: always } },
  { id: 'test-risk-review', guard: 'own:live-terminal-review',
    family: { list: 'testRecovery.riskReviews', path: ['testRecovery', 'riskReviews'], action: 'story.test-risk', label: 'Test risk review', isPerson: always } },
  // Recorded on a commit, and signed by nothing yet.
  // A change of which tests the Story's gates run (`story test-policy scope`): what was recorded stays as it was.
  { id: 'test-scope', guard: null, review: { kind: 'test-scope', entry: safe({ testScopeChanges: 'test_scope_changed' }) } },
  { id: 'evidence-contract-correction', guard: 'turn:action-authorization', review: { kind: 'evidence-contract-correction', entry: 'stales-submission' } },
  { id: 'target-origin', guard: 'own:target-origin-pin', review: { kind: 'target-origin', entry: 'stales-submission' } }
].map((row) => Object.freeze(row)));

/** Where SF Guard reads each person's records from (presence/person-steps.mjs), a row's id naming its family. */
export const PERSON_STEP_FAMILIES = Object.freeze(PERSON_STEPS.filter((row) => row.family).map((row) => Object.freeze({ id: row.id, ...row.family })));

// The order a commit's lists are read in (REVIEW_SAFE_DECISION_LISTS).
const REVIEW_KIND_ORDER = Object.freeze(['applicability', 'scope', 'completeness', 'plan', 'departure', 'risk', 'test-risk', 'test-narrowing', 'evidence-reuse', 'test-scope', 'visual-profile',
  'witness-exception', 'approver-refresh', 'quality-risk', 'witness', 'upstream-issue', 'forward-amendment', 'test-command', 'phase-appeal', 'evidence-contract-correction', 'target-origin', 'workflow']);
/** What each decision kind does to a submitted review: REVIEW_EFFECTS's `decision-made:*` (state.mjs). */
export const PERSON_STEP_REVIEW_EFFECTS = Object.freeze(Object.fromEntries(REVIEW_KIND_ORDER.map((kind) =>
  [`decision-made:${kind}`, PERSON_STEPS.find((row) => row.review?.kind === kind).review.entry])));

/** What an approval can write: records that only add to the Story, never a return or a test command. */
export const IN_APPROVAL_EFFECTS = Object.freeze(PERSON_STEPS.filter((row) => row.inApproval).flatMap((row) => row.effect));
