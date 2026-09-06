---
id: evidence-and-ledger
title: Evidence, the ledger, and traceability
version: 15
aliases:
  - ledger
  - worldline
  - trace
  - audit
commands:
  - ledger
  - receipt
  - spec
  - comprehension
  - change
  - proof
  - delivery
related:
  - approvals
  - impact-framework
---
Everything consequential is hash-linked: artifacts, inputs, approvals, checks, receipts. The append-only capability ledger mirrors lifecycle events as a tamper-evident chain; `sflow ledger verify` validates it from a bare clone, offline. `sflow spec index/coverage/trace` gives requirements stable clause identities and walks requirement → claim → commit → test evidence → approval. Mechanical coverage never claims semantic correctness — judgment and evidence are both retained and never confused. For auditors, fieldwork starts with `git clone`.

The first comprehension pilot is deliberately read-only. `sflow comprehension regions` derives conservative, material resource regions from the existing exact repository change set; `sflow comprehension check` evaluates bounded caller-supplied cause bindings and dispositions as untrusted diagnostics without writing, approving, publishing, or invoking a model. `sflow comprehension graph` includes only bindings that passed the same exact validation, and `sflow comprehension explain clause|file|change` traverses that graph in both directions. `sflow comprehension replay` projects the existing normalized Story lifecycle history with explicit attested-lifecycle versus operational-history provenance while excluding actors, operational detail, prompts, transcripts, model summaries, and SGOS Process state. Causal provenance, including post-hoc and reverse-converged labels, remains unavailable until a governed source records it; the replay never infers those labels from ordinary lifecycle events. It is not the mutating SGOS Process replay. Symbol, refusal, generation, and test queries report unavailable until their authoritative sources exist; missing AST is never a failure. The compatibility subject is not the universal Candidate, and this pilot cannot mint authority or authorize publication. A result at resource granularity is observational evidence, not semantic proof. Enforcement remains unavailable until ordinary Story delivery and SGOS share one universal Candidate authority.

`sflow comprehension walkthrough draft` emits a deterministic, model-free baseline containing one
exact `file-changed` claim per current change region. It does not write the draft or add semantic or
causal claims. `sflow comprehension walkthrough validate <REPOSITORY-FILE>` adds an observe-only
typed walkthrough check. Keep the untrusted draft in an ignored repository-local path: Flow refuses a draft that is
part of the Candidate it describes. The current deterministic validator can establish only exact
resource-level `file-changed` facts. Structural, evidence-supported, and human-judgment claims stay
`unavailable` until their authoritative validators exist, while model-authored advice remains
`model-advisory`. The validation report excludes narrative prose, separates narrative and
dependency hashes, invokes no model or AST, writes nothing, and cannot approve or block a phase.
`sflow comprehension walkthrough revalidate <DRAFT> <PREVIOUS-VALIDATION>` runs the current
validators again and reports narrative-only drift separately from Candidate, claim, and declared
dependency changes. A previous pass is never trusted or carried forward. Precise dependencies
invalidate only their claims; unavailable authority remains unavailable rather than being guessed.

GDP-M2 adds an equally bounded shadow view: `sflow change show <WORK-ID> --shadow`. It derives an in-memory Proof Subject and Change Passport only when an existing exact Candidate is available. The view shows legacy policy projections, evidence availability, World Model status, known gaps, provenance hashes, and a privacy-safe lifecycle comparison. It never writes the records or allows a gate, approval, publisher, or lifecycle decision to consume them. Missing World Model or AST remains visible and non-blocking.

GDP-M3 adds a deterministic proof observation over that Proof Subject. `sflow proof status <WORK-ID>` shows the complete bounded observation; `proof explain` explains one exact predicate; `proof gaps` and `proof signals` keep missing authority and non-authoritative observations visibly separate. Predicate results use the frozen total lattice `pass`, `fail`, `unavailable`, and `not-applicable`. Signals never satisfy a predicate or gate, and stale, missing, contradictory, malformed, timed-out, or oversized evidence cannot become pass. M3 is observe only: no result changes lifecycle, approval, publication, or Story duration.

GDP-M9 also provides a developer-local signed observation path. `sflow delivery local-runner-options --work-id <WORK-ID>` derives the exact current Candidate and Proof Subject and lists only configured shell-free, model-free quality commands. Planning binds that identity, the repository commit/tree, command, and local signer before execution. The signed receipt is useful for tamper detection and replay but permanently remains `gateEligible: false` and `consumedByLifecycle: false`; the same-user signer is not independent authority. VS Code exposes the same plan/review/run/verify journey through **Developer-local Signed Runner…**.

## Purpose and prerequisites

Use this topic when the current goal matches **evidence and ledger**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow ledger`, `sflow receipt show`, `sflow spec`, `sflow comprehension regions|check|graph`, `sflow comprehension explain clause AC-001`, `sflow comprehension replay --work-id <WORK-ID>`, `sflow comprehension walkthrough draft`, `sflow comprehension walkthrough validate review/walkthrough.json`, `sflow change show <WORK-ID> --shadow`, `sflow proof status <WORK-ID>`, or `sflow delivery local-runner-options --work-id <WORK-ID>`. Run the command with `--help` for the exact forms supported by this build.
- **Copilot:** `/sf-ledger` for durable evidence, `/sf-inspect comprehension` for the CMP pilot, `/sf-inspect <WORK-ID> passport` for M2, or `/sf-inspect <WORK-ID> proof` for M3. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Diagnostics and select the final **Shadow Passport** tab for M2/M3, or open **SGOS Command Center** and select **Local Runner…** for the non-gating M9 signed observation journey. Both remain secondary; existing Lifecycle views remain authoritative and unchanged.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

After a phase is submitted, `sflow receipt show --work-id <ID>` replays a compact receipt from
the durable review packet. `--markdown` is suitable for a handoff or pull-request description;
`--json` separates the deterministic receipt-core hash from a separately hashed observation block.
The core covers durable packet, work, source, checks, approvals, context, and next-action identity;
observations report clone-local facts such as publication visibility and local changes. Replaying
the same packet in a fresh clone must produce the same core hash without pretending that those
local observations are identical.

For a source-pin failure, begin with `sflow ledger repair --dry-run`. The preview
distinguishes local refspec/cache damage, a remote or credential outage, a Git host
that does not expose custom refs, a missing ref, and a conflicting ref. Run
`sflow ledger repair` only for safe local repair. An optional `--source-remote NAME`
must refer to a configured authoritative Git remote and is read-only unless a separate
remote restoration is explicitly authorized.

If and only if the publication remote has lost a ref and the exact recorded source is
provable, `sflow ledger repair --restore-remote --dry-run` prints every destination and
a `RESTORE LEDGER PINS <PLAN-SHA256>` phrase. Review it before applying the identical
plan. Flow dry-runs the explicit refspec, never force-pushes, and refuses an existing
mismatch. Moving future pins from `refs` to `branches` does not repair historical refs.

## State and safety

These commands can mutate governed or machine-local state: `ledger`, `spec`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a pin is missing only on this machine, run `sflow ledger repair`; workspace onboarding also attempts this safe local repair after installing the refspec.
- If the remote is unavailable or access is denied, restore connectivity or credentials and retry; Flow will not turn that uncertainty into a new remote ref.
- If the server rejects custom refs, configure `pinTransport: branches` for future publications and restore historical refs from an authoritative remote or archive.
- If the remote ref points at another commit, stop. The repair command will not overwrite it; an operator must investigate the ledger/remote conflict.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain approvals`, `sflow explain impact-framework`.
