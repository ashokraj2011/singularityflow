# Exact human plan corrections through namespace storage

`plan.correction.context` reads the original independently approved plan and every accepted
correction in order. Its versioned manifest contains the exact before/after rows, verification
contracts, original plan proof, review authorities and prerequisites for recording. It changes
no Story, approval or private draft.

`plan.correction.record` requires the human's exact preview digest and an explicit operation ID.
The namespace writer authenticates that human against the actual owner plan, rechecks the current
Story and identity, and accepts one conditional receipt. Lost responses resume the original
candidate; reusing an ID with another request is refused. A later device can verify or replay
that decision with shared records alone, without the original checkout or private draft.

## Separate contracts and unchanged native meaning

The new `sflow-namespace-plan-row-correction/v1` binds the exact authenticated review context.
It does not claim the native terminal's `live-terminal-exact-plan-review` assurance or invent a
terminal authorization UUID. Native records, wire schemas, confirmations, errors and hashes
keep their meanings. Pure normalization and correction rules are shared by both adapters.

The original plan artifact, planned-map pointer and human approvals remain immutable. Exact
readers apply the verified replacement rows only to the original owner's approved generation.
The current author can explicitly rebase the same private draft, read the actual correction
through `phase.context.read`, retain current sources, execute fresh pinned tests and publish
against the corrected proof. Additive plan decisions remain distinct from replacements.

A new correction cannot silently reinterpret an existing accepted Code publication. The context
names `namespace-plan-revalidation` when that owner is required; configured person-presence also
keeps its explicit requirement. Those remaining owners are not satisfied by a request flag.

## Qualification boundary

The affected Mac qualification covers filesystem, SQLite and application storage, exact human
authority, stale previews, unchanged plan approvals, actual Code delivery and independent approval,
shared-only historical replay, future wire versions, original permission errors and interrupted
conditional writes. The actual offline-installed SDK is also exercised without Git or a checkout.
On macOS arm64 with Node 26.12.0, 258 distinct affected checks pass without failures, skips or
cancellations. The unchanged original installed qualifier passes all 34 checks alone in
35 seconds, within its existing 120-second parent and 60-second child bounds. The new installed
plan-correction journey passes in 15 seconds and its NodeNext/API qualification also passes.
Source validation passes 4,153 checks, architecture and schema checks pass, VS Code types and
the unchanged 2,011-site Git audit pass. All 13 original bundle ceilings pass; the gateway is
850/852 modules and 6,898,949 bytes. No Windows CI, live model, real Story, installed authority
or main merge was used.

This delivery does not complete namespace evidence correction, late-publication revalidation,
person-presence, remaining decision profiles or the Phase 5/7 completion ledger. It changes no
installed project authority and does not merge the branch.
