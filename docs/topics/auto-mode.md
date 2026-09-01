---
id: auto-mode
title: Bounded Auto mode
aliases:
  - auto
  - autonomous-work
commands:
  - auto
related:
  - story-lifecycle
  - impact-framework
  - checkpoints-pause-continue
version: 4
---
Auto mode turns a plain-language requirement into a reviewable, exact-hash Plan and derived ratification packet and—only after the packet hash is confirmed—creates an ordinary governed Story in a managed isolated worktree. It is repository policy, not a way around lifecycle policy.

## Purpose and prerequisites

The shipped workflow keeps `auto.enabled: false`, and every work type defaults to `auto.eligibility: disabled`. An administrator must enable the repository root and mark each intended work type `plan-only` or `bounded`. Capability policy can only tighten that answer. `plan-only` permits reviewable Plans but not starts; `bounded` permits starts within the effective ceilings.

The thin pilot requires one repository, a published base branch, a configured allowed execution host, and a bounded quick-fix or chore workflow whose first phase can publish and submit normally. The public `/sf-auto` skill guides the same exact-hash protocol without changing its authority boundaries.

## Use it from each surface

**Shell:** Run `singularity-flow auto "<requirement>" --work-type <type> --from-branch <branch>` or the explicit `auto plan` form, review the complete card, then copy its exact `auto start --confirm` command. `auto --goal <GOL-ID|GEX-ID>` uses the Goal's exact current outcome and success criteria as source-bound Plan input; changing the Goal makes that Plan stale. The shorthand only builds a Plan; invoking it never confirms or starts work. `auto continue <STORY-ID>` returns a Story-revision and checkpoint-bound continuation proposal without resuming or approving it. `auto adopt --from-adhoc <AHS-ID>` verifies the confirmed effect set and renders an exact handoff, but remains explicitly non-startable until the Story profile can materialize those dirty bytes without relabelling their `pre-auto-adhoc` provenance. `auto takeover <FLIGHT-ID>` requests stop, proves quiescence, and preserves the exact managed worktree for manual control; an unproven stop becomes `recovery-required` rather than a false pause.

**Copilot:** Run `/sf-auto plan <requirement>`, review the complete card, then run `/sf-auto start <PLAN-ID>`. The skill requires you to type the complete ratification-packet hash and never extracts or pre-fills it. `/sf-auto needs-you <FLIGHT-ID>` shows typed human requests, and `/sf-start` remains the guided manual Story route.

**VS Code:** Open the integrated terminal in the governed repository and use the same explicit commands. Auto results use the shared command-result envelope, so result cards and errors remain structured. A dedicated Auto Plan/flight panel is a later V1 increment.

## Guided workflow

1. Enable root Auto policy and set one work type to `plan-only` or `bounded`.
2. Run `auto plan`. Plan synthesis may invoke the configured model with tools disabled; its response is an untrusted proposal.
3. Review the full Plan card: requirement, Work ID and branch, complete Story rail, exact bases, predicted scope, host, model assurance, tools, network policy, ceilings, human stops, expiry, and full SHA-256. Planning creates no Story or branch.
4. For a bounded Plan, run `auto start <PLAN-ID> --confirm <PACKET-SHA256>` or `auto start --plan <PLAN-ID> --confirm <PACKET-SHA256>`. Start rebuilds and verifies the packet, revalidates the Plan, and consumes the identity-bound authorization once. A pre-packet Plan cannot authorize execution; create and review a new Plan after upgrading.
5. If the first phase has no clarification boundary, Auto composes the normal governed prompt, consumes one authoring attempt before the host starts, recomputes actual scope, and calls the ordinary publication and submission operations.
6. Inspect `auto status <FLIGHT-ID>`, `auto report <FLIGHT-ID>`, or `auto needs-you <FLIGHT-ID>`. Clarification, credential, and architecture-choice requests are typed records; generic continue and resume cannot answer them. VS Code pause, stop, and takeover actions include the exact current checkpoint hash, so a card from another repository revision fails closed instead of controlling newer state.
7. A machine-actionable failure creates a structured refusal. `auto repair <FLIGHT-ID> --refusal <REFUSAL-ID>` previews one bounded Repair Plan without running it. Only the exact `--confirm <REPAIR-PLAN-SHA256>` authorizes one repair attempt; a second failure halts and preserves both failures.

8. Respond to a typed Human Request with `auto respond <FLIGHT-ID> --request <REQUEST-ID> --choice <ID>|--answer <TEXT>|--broker-reference <REFERENCE> --confirm <REQUEST-SHA256>`. Credential values themselves are never accepted; provide only an approved broker reference. Resume still requires the new exact checkpoint hash.
9. Between quiescent attempts, `auto switch-unit <FLIGHT-ID> --execution-unit <ID>` previews an exact switch. Confirming its plan creates a new lineage-linked attempt; it does not rewrite the prior attempt or broaden its Task Contract.

The kernel validates proposal vocabulary, work type, complete rail, base heads, capability policy, paths, pace, stop selector, host, ceilings, and expiration. The Change Flight Plan remains the scope authority, and AST is explicitly optional for this preview.

## State and safety

Plans, authorizations, flight checkpoints, and reports are private mode-0600 records under the repository Git common directory until governed records are pinned into the Story. The accepted Plan, non-secret ratification, and `executionOrigin` tuple are committed at Story birth. All execution occurs under `<git-common-dir>/singularity-flow/auto-worktrees/`; the caller's branch, index, staged bytes, and working tree remain unchanged.

Auto never approves or rejects, invents an answer to a Human Request, waives policy, changes sequence, expands scope, merges, or deploys. The authoring host receives only the closed, operation-exact file read/search/create/edit tool set—never a terminal or generic command tool—while tests and lifecycle mutations stay in registered kernel operations. Each phase gets one initial authoring attempt and, only when repository policy and an exact human-confirmed Repair Plan permit it, at most one bounded repair attempt. Protected-path contact, actual scope expansion, unavailable required token assurance, a stale base or policy, or a second failure halts and retains the managed worktree. Typed phase-run, attempt, refusal, Candidate, Human Request, token-economics, and execution-unit records preserve the lineage behind the report.

The pilot deliberately stops short of multi-repository flights, automatic Goal coordination, interval/background resume, and direct Ad Hoc byte adoption. Goal seeding is input only, and Ad Hoc promotion is a non-startable exact handoff until provenance-preserving materialization exists. The CLI shorthand is only a more natural spelling of `auto plan`; it adds no confirmation or autonomous authority. `/sf-auto` is a guarded Copilot guide over the same planning and exact `auto start --confirm` operations.

## Troubleshooting

- `AUTO_DISABLED`: enable repository Auto policy, then opt in a work type.
- `AUTO_WORK_TYPE_INELIGIBLE`: choose a `bounded` work type to start; `plan-only` cannot create a Story.
- `AUTO_PLAN_CONFIRMATION_REQUIRED`: copy the full hash from the newly rendered Plan card.
- `AUTO_PLAN_STALE` or `AUTO_PLAN_EXPIRED`: create and review a new Plan; authority never transfers to changed bytes.
- `AUTO_BRANCH_COLLISION`: allocate a different Work ID and create a new Plan.
- `AUTO_TOKEN_ASSURANCE_UNAVAILABLE`: use exact provider accounting or ratify a policy-approved `best-available` Plan.
- `AUTO_CHECKPOINT_STALE`: read status again and confirm the current checkpoint instead of reusing an old one.
- `AUTO_HUMAN_REQUEST_REQUIRED`: inspect `auto needs-you`; answer the exact typed request before resuming.
- `AUTO_REPAIR_CONFIRMATION_REQUIRED`: review the current Repair Plan and type its full hash; a refusal hash or stale Plan hash is not authority.
- A halted flight keeps its worktree. Inspect it and continue manually or replace the Plan; Auto does not silently retry.

## Related topics

Continue with `sflow explain story-lifecycle`, `sflow explain impact-framework`, or `sflow explain checkpoints-pause-continue`.
