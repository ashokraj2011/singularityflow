---
id: phase-appeals
version: 2
title: Phase appeals and recoverable blockers
summary: Preserve and review exact extra work without silently bypassing tests, intent or configuration authority.
audience: [developer, approver, administrator]
commands: [appeal]
skills: [sf-appeal, sf-recover]
---

# Phase appeals and recovery

Every phase prepublish projection now names a resolution owner and choices. An unsupported check has an explicit maintainer/external-prerequisite route, not a fabricated pass. These previews never run tests, invoke models, install tools, discard changes, accept risk or advance the Story.

The installed finding policy separates author-owned correction, current-phase preparation, worktree review, operational prerequisites, and integrity/authority. Error text and repository hints cannot register an executable repair or broaden risk eligibility. This contract applies by phase responsibility to packaged and user-created workflows, not a list of built-in phase IDs. It does not promise progress while a runner, authorized reviewer or remote is unavailable: it promises preserved work and an honest next route.

## Preserve before repair

`singularity-flow appeal checkpoint --phase PHASE --json` makes content-addressed private recovery copies of dirty files, the primary phase draft, deletion markers and the exact Git index. It does not stage, commit, stash, push, restore files or advance the phase. Owned-producer `repair-run` captures a checkpoint before reserving its repair; the journal retains its ID so interruption does not lose the recovery route. `repair-status` shows retained checkpoint commands.

Inspect a returned ID with `singularity-flow appeal checkpoint-show PCP-ID --phase PHASE --json`. Compare verified recovery copies before a human-reviewed restoration of selected authored files. Never automatically overwrite a current draft, approved record or index. The copies live privately in the Git common directory, scoped to the checkout, Story and phase; Git does not share them. Bounds are 512 paths, 16 MiB per file, 128 MiB total dirty-file bytes and a 64 MiB index. Links, hard links, non-files and larger changes keep their originals and require owner-reviewed backup. No retention pruning or automatic deletion is performed.

## Exact review-document risk

Every authored phase can preview an explicitly scoped pilot exception for observed unresolved placeholders, empty headings or minimum-length shortfalls:

```sh
singularity-flow appeal risk-prepare --phase PHASE --gate-mode soft \
  --finding artifact.placeholder.unresolved --expires YYYY-MM-DD \
  --reason "The exact explanatory shortfall is deferred; tests and review remain required." --json
```

Use only returned finding codes. Review the packet, then an authorized human runs `appeal risk-accept` with identical options and the returned `--confirm PACKET_SHA256` in a live terminal. Copilot's `/sf-appeal` and VS Code's **Resolve phase issues** prepare this review; neither answers the human confirmation.

These version-two packets are a distinct closed document-quality variant, not a migration or blanket expansion of old coverage decisions. They bind the complete authored review-document set, generation, prior phase records and pinned policy. By default they cover publication, submission, approval checks, consumption and terminal quality checks for those unchanged bytes; `--transition` narrows that scope. Engine metadata/publication bookkeeping does not demand repeated acceptance. An authored edit, changed upstream approval or policy, successor generation, expiry, revocation or missing local human-review witness invalidates the decision. A new machine requires `risk-attest` with the exact retained decision hash and live review.

Expired or out-of-scope document decisions cannot silently satisfy downstream or terminal checks. The returned correction/risk route names the approved input's owning phase, not permission for the consuming phase to edit it. A closed Story's historical terminal audit judges expiry at its recorded closing moment; an unfinished Story must still have a currently valid decision.

Readiness displays **accepted-risk**, not a passing quality proof. Missing artifacts or required headings, malformed metadata/contracts, unsafe paths, deterministic Convergence projections and integrity/authority failures cannot use this exception. Tests, source/claim evidence, independent reviews and ordinary human phase approval remain required. Existing exact coverage/test exceptions retain their separate eligibility and transitions; selecting soft mode alone waives nothing.

In VS Code, use **Resolve phase issues** beneath the current phase, or **Reviews → Appeals and phase issues**. `/sf-appeal` provides the same guided journey in Copilot. Human decisions open a prefilled terminal command; they are not executed by the webview or agent.

## Extra work within an existing requirement

1. Explain each exact extra path and the approved clause it serves. Supporting documents/build files use the existing closed supporting classes. New behaviour is an intent amendment, not a supporting change.
2. Preview `singularity-flow appeal prepare --add-location STORY:AC-001=src/helper.mjs --reason "The helper implements the already approved behaviour." --json`.
3. Inspect the full bounded before/after bytes and packet hash. Run `singularity-flow appeal submit` with those same selectors and `--confirm <packet hash>` to retain the packet. This commits only the appeal plus its Story state/status, not application edits or unfinished phase drafts.
4. Inspect `singularity-flow appeal list --json` and `singularity-flow appeal show <APL-ID> --json`. An authorized plan reviewer runs `singularity-flow appeal decide <APL-ID> --decision account-scope --reason "Reviewed the exact helper diff and its existing clause binding." --confirm <packet hash>` in a live terminal and types the displayed review label. The plan receives a narrow amendment; the phase is not approved.
5. Recheck the returned phase route. Required tests, evidence freshness, traceability and configured independent reviews still run on the exact selected candidate. An appeal never labels failures as passes.

Packets and decisions are immutable, Git-backed and transactionally published. Source, test inputs, plan, policy or results changing before review makes accounting stale. Request changes, repair and prepare a successor packet; do not overwrite history. The request-changes disposition does not permit publishing the unchanged rejected diff.

On a new checkout, Git carries the decision but not the local live-review witness. When status says `needs-reattestation`, an authorized reviewer uses `singularity-flow appeal attest <APL-ID> --confirm <decision hash from appeal show>` and reviews it again in a live terminal. This restores local review proof without rewriting history or waiving current tests. The reviewer need not be the original author of the decision, but must satisfy the decision's pinned approval authority.

## Different kinds of issue

| Situation | Resolution |
|---|---|
| Extra location/supporting work for existing intent | Exact-diff scope appeal |
| New requirements or changed acceptance criteria | Existing Story intent-amendment and affected-phase acknowledgement/revalidation |
| Eligible observed test shortfall | Existing `story test-policy risks` preview and exact authorized risk decision, with scope/expiry/remediation |
| Eligible authored-document quality shortfall | `appeal risk-prepare --finding EXACT-CODE`; exact human review, transitions and expiry |
| Runner configuration error | Approved configuration proposal and bounded Story test-command adoption |
| Protected paths, changed source boundary, identity or provenance | Original configuration/integrity authority; no ordinary waiver |
| Changes after publication or while awaiting approval | Authorized successor/return through recovery; old packets remain immutable |
| Unknown/unsupported runner, unavailable remote or integration | Named owner, retained diagnostics and explicit prerequisite |

The initial automated scope-accounting adapter supports added/modified regular UTF-8 application files, at most 50 paths, 256 KiB per file and 2 MiB total. Links, binary files, renames/deletions and protected boundary edits have separate owner routes. A configured Git identity is recorded; it is not proof that Copilot authored the change, nor proof of independent review.

## Repair loops and honest outcomes

Repair attempts are now durable, not remembered only within a Copilot turn. The shared prepublish output includes `repairLoop.protocol` and its exact plan/resume routes. This applies to custom Story phase IDs as well as packaged workflows. Scope accounting, risk acceptance and phase approval remain distinct decisions.

1. Inspect `singularity-flow appeal repair-plan --phase PHASE --json`. A plan is read-only; inspect its owned findings, admission, action and remaining budget.
2. Within the user's authorized repair work, reserve exactly that plan with `singularity-flow appeal repair-run --phase PHASE --confirm PLAN_SHA256 --json`. Changed source, draft, policy, producer or journal makes the confirmation stale. Reservation is persisted before any repair begins.
3. For `owned-producer-repair`, the existing bound producer corrects only those owned findings. No nested model is launched. Run `singularity-flow appeal repair-resume --phase PHASE --json` afterward to rerun the gates and close the same attempt. After interruption, resume the recorded attempt; never reserve a replacement.
4. Unchanged findings, oscillation or three consumed attempts stop automatic repair. Cosmetic edits and moved line numbers are not progress. A stricter pinned phase budget is honored. Manual correction, eligible exact human risk review, and authorized successor/return routes remain available; exhausted attempts do not waive or permanently freeze the ordinary gates.

`repair-status` is read-only. The hash-chained, bounded journal is stored in the Git common directory, outside application files, scoped to this checkout, Story, phase, generation and intent. It is machine-local coordination—not Git-shared approval, passing test evidence or authorship proof. Ordinary reads do not create it. Concurrent mutations use the Story lock. Corrupt journals have a maintainer route; deleting or resetting a journal is not recovery.

The only automatic operation registered initially is **sync of an exact retained lifecycle publication**. It cannot create a fresh publication, execute arbitrary commands, fetch/fast-forward, invoke test tools, deliver integrations or grant approvals. Stories with after-step actions or an enabled ledger stay on explicit owner-guided synchronization because their sync can also deliver external work. After a crash it inspects first: a cleared marker is never replayed; only the same idempotent pending record and repository revision may be synchronized again within the existing reservation. Unknown or changed outcomes stay on the owner route. An attempted transport is reported conservatively as possibly changing external state; `transportOutcome: not-verified` is not a success claim.

Every recorded repair is rechecked before publish, submit or approve. `ready-for-next-check` means the local gates were inspected, not that required tests passed or the phase advanced. Normal publication still independently runs its required checks. Protected configuration, unowned output, unknown blockers and semantic scope changes retain explicit human or owner routes.

Tests for scope appeals exercise real Git transactions and live terminal review in disposable fixtures. Native Windows and installed-extension qualification are separate from portable tests; no platform qualification is implied by a macOS test run.
