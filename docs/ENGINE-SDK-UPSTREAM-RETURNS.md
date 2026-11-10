# Authenticated upstream returns

`upstream.decide` now supports `outcome: 'return'` in the namespace composition. The operation
reads the actual issue, its original published producer and the pinned owner's human authority.
One accepted transaction records both the disposition and its change request. Repeating the same
operation under its original identity replays that receipt; a second operation cannot decide the
same issue again.

The return has an explicit `sflow-namespace-upstream-return/v1` identity. It can be recorded while
the current phase is still at generation zero, before it has a publication or submission packet.
Its `reviewPacketSha256` is null. The producer publication and issue-owner receipt supply its
actual provenance. Native Git rejection records and their reviewed-packet requirements keep their
existing meanings.

The kernel plans the transition, the SDK coordinates acceptance, SDA retains the conditional
receipt and SGOS retains each actual test execution. The operation reopens the affected range
while keeping earlier publication bytes, human records and private authored drafts. Continuing
a preserved draft uses the exact basis/rebase operation already issued by the runtime. The issue
is decided once; the resulting repair request remains open until its genuine replacement approval.

## Code continuation

The read-only return verifier authenticates the original `upstream.decide` transaction and compares
the repair request with its original accepted form. It does not trust a copied request or a
resolved status. There are three separately versioned histories:

- `sflow-namespace-code-history/v5`: direct return to an already published Code phase.
- `sflow-namespace-code-history/v6`: upstream return before the first Code generation, retaining
  the actual replacement input approvals.
- `sflow-namespace-code-history/v7`: successor Code after a return to an earlier input phase,
  binding both the previous Code publication and the real replacement approvals.

These histories use Code policy v8, or v9 when the plan also requires human visual/inspection
acceptance. Original history v1–v4 and Code policy v1–v7 retain their existing contracts. A return
can revalidate unchanged source or retain changed source; both require fresh pinned execution.
An old human witness remains historical evidence for its original candidate. It cannot approve
the successor, even when the retained image bytes are unchanged.

## Qualification and limits

Mac qualification exercises document returns before current publication, first Code, direct Code
returns and earlier-plan returns on filesystem, SQLite and application stores. It also exercises
fresh checks, independent replacement approval, release completion, exact permission failures,
copied-provenance refusal, preserved original publications and shared-only replay after deleting
the isolated source checkout. An offline-installed consumer resumes each operation in a separate
process with an empty PATH, including publication and review after the upstream return.

Qualification passes 247 distinct affected Mac checks, with zero failures, cancellations or skips.
That includes native CLI/SDK upstream parity, reviewer/configured-loop/choice returns, schema and
architecture guards, 56 offline-installed continuation checkpoints and the original unchanged
34-check package qualifier. The latter runs alone in 34.236 seconds under its original 120-second
parent and 60-second child bounds. Repeated test attempts are counted once.

Source validation, VS Code types, the unchanged 2,011-site Git ownership audit and all 13 runtime
bundle ceilings pass. The gateway stays at 852/852 modules and 6,910,371 bytes. No deadline or
module/byte limit was raised.

Forward amendments, person-presence and test-repair-budget owners remain separate requirements.
Configured requirements without those actual owners still report their explicit missing port.
This delivery closes upstream returns; the remaining Phase 5 and 7 owners stay in
[the completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md). No installed project, real Story,
Windows qualification, live provider or main merge is part of this delivery.
