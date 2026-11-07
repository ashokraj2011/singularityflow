# Standalone decision records through the engine

Five existing CLI decision routes now enter the SDK registry: `decision.scope`,
`decision.completeness`, `decision.applicability`, `decision.risk` and `decision.choose`.
These are individual human requests. The existing `decisions.record` operation remains the
separate, digest-confirmed protocol for recording selections from a pending-decision list.
The test/evidence extension below adds six entries, separating agent command requests from
human acceptance and retaining the original CLI syntax.

Both protocols use the same installed native record writers. No second authority evaluator,
serializer, event format or publication transaction is introduced.

## Versioned vocabulary

All five operations accept `workId` and the optional existing source-checkout `fetch` request.
Each has a closed set of domain fields:

| Operation | Request fields | Record kind |
|---|---|---|
| `decision.scope` | `item`, `disposition`, `clauseIds`, `reason` | `scope-disposition` |
| `decision.completeness` | `confirm`, `checklist`, `reason` | `completeness-review` |
| `decision.applicability` | `responsibility`, `reason` | `applicability` |
| `decision.risk` | `obligationId`, `revoke`, `category`, `transitions`, `expires`, `reason` | `obligation-risk` |
| `decision.choose` | `option`, `to`, `expected`, `reason` | `routing` |

`engine.run(operation, inputs)` and the existing Node API's `run` expose the same entries. Public
inputs contain no actor, authority, configuration, root, executable callback or caller-supplied
record. The native Git composition resolves identity and any matching session context itself.

The recorded receipt identifies the Story, originating phase, actual revision, push outcome,
record kind, detached record, verified actor/group and resulting current phase. Its effect flags
describe that actual publication. Recording scope or completeness does not author, submit or
approve an artifact. Routing can change the current phase only through the existing choice and
terminal gates; it does not manufacture passing evidence.

## Ownership

The kernel owns closed-Story and pending-route admission and request normalization. The SDK owns
the registered operation sequence, bounded JSON input, captured binding, result validation and
effect/error preservation. A shared trusted `decisionRecord` port implements `load`, `prepare`,
`commit` and `finish`; the operation descriptor comes from the registry, never from request data.

The native Git port loads accepted execution, retains the existing branch selection/fetch
behavior, resolves the native actor/session and calls the original writers. Their authority,
presence, inventory/observation digest, expiry, stale-route, transaction, history and recovery
checks remain unchanged. The writers still serve the combined decision operation and legacy
helper exports as well.

The CLI owns flag spelling, comma-separated clauses, repeated transitions, checklist file reads,
warnings and output. Its trusted preparation callback runs after Story admission, so closed-Story
and missing-route errors still precede argument preparation. Public SDK calls instead supply
plain domain data directly. A prepared callback cannot redirect the Story or supply authority.
The SDK captures the originating Story/phase before that callback can await human input.

`src/commands/decision-record.mjs` contains the five CLI adapters; their old dispatcher functions
only forward to it. The host projects the actual SDK record and publication into its existing
text/JSON envelope. It does not perform record writes or duplicate Story admission.

## Compatibility and failure handling

Native errors keep their identity, cause, code, retained publication and recovery details. A
failed result projection after commit carries the actual `enginePublication`, rather than
claiming that nothing happened. Cancellation can stop the next effect but cannot undo an
accepted publication. Routing's post-publication session failure remains an advisory local
diagnostic; an observer failure cannot erase the committed route or justify another write.

Completeness still binds the exact scope inventory and the existing article checklist. A risk
acceptance or revocation still uses the obligation owner's authority and retained observation.
Applicability still applies only to an omission declared by the accepted workflow. Routing
retains the existing pending-key behavior, including refusal of an explicitly stale key.

The native compatibility boundary retains legacy diagnostic wording where it refers to CLI
flags. It does not introduce model prompts or command rendering into the SDK. Installed Git
authority and namespace layouts remain unchanged; this delivery does not activate an alternate
backend or migrate an existing project.

## Qualification and remaining work

Focused tests cover all five registry entries, immutable bindings and records, invalid authority
fields, cancellation, native errors and accepted-effect retention. Native tests compare actual
CLI/SDK receipts, reject an unauthorized caller, exercise a second seeded workflow and retain
routing when local session refresh and its observer fail. Broader scope, risk and branching
journeys verify the original record writers and legacy command forms.

All qualification for this slice is on Mac with isolated machine state and fixture Git remotes.
Windows, hosted CI, live providers, real Story migration, merge and push are excluded. Package
and runtime gates continue to enforce their existing ceilings.

Other standalone decision families, plan corrections, amendment orchestration, phase manifests,
queries and admission helpers remain Phase 5 work. The remaining storage, embedding, migration
and distribution phases retain their scope in [the migration plan](ENGINE-SDK-MIGRATION.md).

## Test and evidence decisions

Six additional entries reuse the same coordinator through a separate `testDecisionRecord` port.
Its `resolve` stage reads retained native records and repository facts between `prepare` and
`commit`. The existing four-stage port and its five operations are unchanged.

| Operation | Request fields in addition to `workId` / `fetch` | Authority |
|---|---|---|
| `decision.evidence-reuse` | `phaseId`, `attemptId`, `revoke`, `reason`, `expires` | Consuming phase's existing approvers |
| `decision.visual-profile` | `phaseId`, `profileId`, `notApplicable`, `revoke`, `reason` | Visual phase's existing approvers |
| `decision.test-narrowing` | `phaseId`, `commandId`, `revoke`, `reason`, `expires` | Test phase's existing approvers |
| `decision.test-risk` | `phaseId`, `commandId`, `argvSha256`, `causeClass`, `cause`, `revoke`, `reason`, `expires` | Test phase's existing approvers |
| `test-command.request` | `phaseId`, exactly one of `command` / `suggestionId` / `repinId`, `sourceRoots`, `reason` | Existing requester identity; no human approval is claimed |
| `test-command.decide` | Exactly one of `accept` / `revoke`, `reason` | Requested phase's existing human approvers |

`sourceRoots` scopes suggestion inspection; it cannot accompany a repin. A request never executes
the command. Accepting a request also executes no test and activates no phase. Later publication
and submission retain their required test execution. Self-acceptance, submitted-review holds,
presence and target-phase authority remain enforced by the installed native writer.

The resolver derives a revocation's original phase from retained records; a caller cannot supply
the original record or a private repin description. A repin is inspected from the current native
gate resolution. Explicit commands keep the existing structured-command, environment and language
checks. Configuration proposal and Story suggestion selection share one repository inspection
helper, while flag parsing remains in the CLI.

Receipts distinguish the target `phase` from `currentPhase`. A test/evidence decision cannot claim
to advance the current phase. The SDK checks the resolved target against any requested phase and
the accepted workflow. The record's phase must agree. A repeated pending test-command request has
status `retained`, revision `null` and both effect flags false; it retains the original requester.
All other operations in this family require an actual publication revision and human authority
group. A command request's authority group is always `null`.

The CLI retains `decision test-command` and its existing JSON operation name for both requesting
and deciding. This is a host projection of the two separate SDK operations. Existing helper
exports and combined decision recording continue to call the exact same native writers.
