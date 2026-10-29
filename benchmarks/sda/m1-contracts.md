# SDA M1: contracts over existing behavior

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§4, §7.1, §7.2, §20 M1).
Engine: `main@2f2069e83` plus this change.

M1 asks for six deliverables and a consistency block in the result contract. The six are done; the
consistency block waits for the contract review (Appendix A, question 2).

Its exit conditions:

- existing behavior is wrapped with no lifecycle change;
- the test adapter is proven non-authoritative;
- SDA-AC-005, 017 and 025 hold.

## What landed

| Deliverable | Where | Checked by |
|---|---|---|
| Outcome classes over existing codes | `src/outcome-classes.mjs`; `SingularityFlowError.outcomeClass`; `error.outcomeClass` in the CLI refusal envelope | `test/ledger.test.mjs`, `test/transport-intents.test.mjs`, the conformance suite |
| Ledger payload digest (§7.2 item 1) | `ledgerPayloadDigest` and the duplicate check in `src/ledger.mjs`; activation recovery in `src/organisation.mjs` | `test/ledger.test.mjs` |
| Operation-matched reconciliation (§7.2 item 3) | `operation: { id, payloadDigest }` on transport intents, `src/transport-intents.mjs` | `test/transport-intents.test.mjs` |
| Leased governed pushes (§7.2 item 2) | `branchPushLease` in `src/git.mjs`; create-only leases on immutable refs | `test/governed-push-lease.test.mjs` |
| Snapshot-bound pages (§7.2 item 4) | `ledgerPage` in `src/ledger-pages.mjs`, outside the lifecycle commands' closure | the conformance suite |
| Source inspection facade | `src/source-inspection.mjs`; `localReads` per module in `inventory.json` | `test/source-inspection.test.mjs` |
| Conformance harness | `src/sda/shared-state-contract.mjs`, `src/sda/git-ledger-adapter.mjs`, `test/helpers/sda-conformance.mjs`, `test/helpers/sda-memory-adapter.mjs` | `test/sda-conformance.test.mjs` |

## Behavior that changed

M1 changes no lifecycle transition, but four write-side behaviors are stricter.

1. **A ledger append that repeats a key with different content is refused** with
   `LEDGER_EVENT_PAYLOAD_CONFLICT` (`OPERATION_ID_REUSE`). It used to be reported as recorded.
   - The digest covers the event type, capability, subject, actor, agent, authority group and
     payload. It leaves out the per-attempt event ID and creation time.
   - A Story's intent travels in its own commit, so a retry replays the same bytes.
   - Capability-activation recovery recomputed parts of its audit (the approver, the unprotected
     acknowledgement, the policy commit). It now replays the recorded audit byte for byte.
   - Entries recorded before this change compare by key only, and the outcome says
     `idempotency: 'key-only'`.
2. **The branch push helper refuses to run unleased** unless its caller states why (`unleased`).
   Every live caller already passed a lease. The two Story recovery paths pass `unleased` only for
   a pending record saved before exact leases existed, which keeps their old behavior.
3. **Immutable refs are pushed create-only**: ledger pins, pin restoration, Auto Candidate refs and
   recovery journals, and the configuration bootstrap push. Each was already probed absent first.
   A concurrent writer's different commit now refuses instead of fast-forwarding the ref.
4. **A lifecycle publication must name the remote revision it replaces.** The publication unit of
   work refuses with `PUSH_EXPECTED_REVISION_REQUIRED`, before writing anything, when a publishing
   mode names none and states no `unleased` reason. The combined branch-and-ledger push needs one
   too.
   - Every production caller already names one, and no source states a reason for the unit of work.
   - The fault tests that published unleased only for convenience now name origin's current main.
   - The fixture that makes legacy Initiative markers states its reason: it reproduces what an older
     client saved.

## The push ratchet (SDA-AC-025)

`test/governed-push-lease.test.mjs` reads `src/` as syntax trees.

- **Raw push argument lists.** Every array whose Git verb is `push` must carry a
  `--force-with-lease` or be a `--dry-run`.
- **Branch push helper calls.** Every call must name `expectedRemoteSha`.
- **Stated reasons.** Every `unleased` reason in `src/`, to the helper or to the unit of work, must
  be listed. Forwarding a caller's own reason states none.
- **The three exceptions**, each listed with its reason (the list may only shrink):
  - the isolated source-delivery push;
  - the two Story recoveries of pre-lease pending records.

## The read ratchet (SDA-AC-001)

`benchmarks/sda/inventory.json` now records `localReads` per module: Git reads a module starts
itself, rather than through a registered query or the facade.

- `test/source-inspection.test.mjs` fails when a module's count rises, and when it falls without the
  inventory being regenerated, so a fall cannot be undone later.
- Three reads moved to the facade in M1:
  - the configuration-at-ref read in `repository-subject-index.mjs`;
  - the receipt and derivation reads in `ast-lifecycle.mjs`.
- Local Git sites outside the Git boundary went from 976 to 974. Local reads outside it are 617.
- The rest move as M2 rebuilds the advisory reads.

## The conformance harness (SDA-AC-017)

One suite runs against the Git ledger and a deterministic in-memory adapter.

| Property | What the suite does |
|---|---|
| Conditional acceptance | Another clone's entry lands between this writer's observation and its push. A Git wrapper moves the remote state ref first. The write never lands on the moved revision: it lands once, after the other entry, and the chain verifies. |
| Idempotency | A repeat returns the first outcome; the same key with other bytes is refused as `OPERATION_ID_REUSE`. |
| Snapshot pagination | A listing started before a new append reads its snapshot to the end, with no repeat and no newcomer. A continuation from another namespace, or one this adapter did not issue, is refused. |
| Integrity | A forged payload digest fails verification, and a page refuses it as `corrupt`. |
| Boundedness | A page limit of 0, above the declared maximum, or fractional is refused. |
| Cancellation | An operation cancelled before it starts writes nothing and reports `cancelled`. |
| Non-authority | `selectSharedStateAuthority` refuses the `test-only` adapter. That adapter lives under `test/`, which the package never ships. |

**Cancellation is checked before an operation starts.** Once a push may have reached the remote,
the outcome is the push's, never a false `cancelled`. Carrying the signal into the ledger's own Git
calls is still to do.

## New names (SDA-AC-023)

None of these existed on `main` before this change:

- `LEDGER_EVENT_PAYLOAD_CONFLICT`
- `TRANSPORT_OPERATION_ID_REUSED`, `TRANSPORT_OPERATION_ID_INVALID`
- `PUSH_EXPECTED_REVISION_REQUIRED`
- `LEDGER_PAGE_LIMIT_INVALID`, `LEDGER_CONTINUATION_INVALID`, `LEDGER_CONTINUATION_UNAVAILABLE`
- `SDA_OPERATION_CANCELLED`
- `SDA_ADAPTER_NOT_PRODUCTION`, `SDA_ADAPTER_CONTRACT_MISMATCH`, `SDA_ADAPTER_CAPABILITY_UNSUPPORTED`
- the field `outcomeClass`

The class names `REVISION_CONFLICT`, `OPERATION_ID_REUSE` and `OUTCOME_UNKNOWN` were used only in the
SDA specification.

## Open after M1

- **The consistency block** in `sflow-result` (Appendix A, question 2). No result field changed.
- **The versioned contract review** of adapter names and schemas. The contract is
  `sda-shared-state/draft-1`.
- **Projections from existing accepted records, with shadow comparisons** (§15 Stage 1). Not
  started; this is the first M2 step.
- **Transport operation IDs from callers.** Today's callers have no durable operation ID, so each
  intent is its own operation. A caller that gains one passes it as `operationId`.
- **Cancellation inside an operation**, as noted above.
- **M0's open items** (Windows baselines, the CI-established DX baseline) are unchanged.
