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
version: 3
---
Auto mode turns a plain-language requirement into a reviewable, exact-hash Plan and derived ratification packet and—only after the packet hash is confirmed—creates an ordinary governed Story in a managed isolated worktree. It is repository policy, not a way around lifecycle policy.

## Purpose and prerequisites

The shipped workflow keeps `auto.enabled: false`, and every work type defaults to `auto.eligibility: disabled`. An administrator must enable the repository root and mark each intended work type `plan-only` or `bounded`. Capability policy can only tighten that answer. `plan-only` permits reviewable Plans but not starts; `bounded` permits starts within the effective ceilings.

The thin pilot requires one repository, a published base branch, a configured allowed execution host, and a bounded quick-fix or chore workflow whose first phase can publish and submit normally. The public `/sf-auto` skill guides the same exact-hash protocol without changing its authority boundaries.

## Use it from each surface

**Shell:** Run `singularity-flow auto "<requirement>" --work-type <type> --from-branch <branch>` or the explicit `auto plan` form, review the complete card, then copy its exact `auto start --confirm` command. The shorthand only builds a Plan; invoking it never confirms or starts work. Use `auto list` to find recorded flights. `auto takeover <FLIGHT-ID>` requests stop, proves quiescence, and preserves the exact managed worktree for manual control; an unproven stop becomes `recovery-required` rather than a false pause.

**Copilot:** Run `/sf-auto plan <requirement>`, review the complete card, then run `/sf-auto start <PLAN-ID>`. The skill requires you to type the complete ratification-packet hash and never extracts or pre-fills it. `/sf-start` remains the guided manual Story route.

**VS Code:** Open the integrated terminal in the governed repository and use the same explicit commands. Auto results use the shared command-result envelope, so result cards and errors remain structured. A dedicated Auto Plan/flight panel is a later V1 increment.

## Guided workflow

1. Enable root Auto policy and set one work type to `plan-only` or `bounded`.
2. Run `auto plan`. Plan synthesis may invoke the configured model with tools disabled; its response is an untrusted proposal.
3. Review the full Plan card: requirement, Work ID and branch, complete Story rail, exact bases, predicted scope, host, model assurance, tools, network policy, ceilings, human stops, expiry, and full SHA-256. Planning creates no Story or branch.
4. For a bounded Plan, run `auto start <PLAN-ID> --confirm <PACKET-SHA256>` or `auto start --plan <PLAN-ID> --confirm <PACKET-SHA256>`. Start rebuilds and verifies the packet, revalidates the Plan, and consumes the identity-bound authorization once. A pre-packet Plan cannot authorize execution; create and review a new Plan after upgrading.
5. If the first phase has no clarification boundary, Auto composes the normal governed prompt, consumes one authoring attempt before the host starts, recomputes actual scope, and calls the ordinary publication and submission operations.
6. Inspect `auto status <FLIGHT-ID>` or `auto report <FLIGHT-ID>`. The flight stops at approval or the requested first-phase boundary. Resume requires the exact current checkpoint hash.

The kernel validates proposal vocabulary, work type, complete rail, base heads, capability policy, paths, pace, stop selector, host, ceilings, and expiration. The Change Flight Plan remains the scope authority, and AST is explicitly optional for this preview.

## State and safety

Plans, authorizations, flight checkpoints, and reports are private mode-0600 records under the repository Git common directory until governed records are pinned into the Story. The accepted Plan, non-secret ratification, and `executionOrigin` tuple are committed at Story birth. All execution occurs under `<git-common-dir>/singularity-flow/auto-worktrees/`; the caller's branch, index, staged bytes, and working tree remain unchanged.

Auto never approves or rejects, answers clarification, waives policy, changes sequence, expands scope, merges, deploys, or retries a failed authoring attempt. The authoring host receives only the closed file read/search/edit/create tool set—never a terminal or generic command tool—while tests and lifecycle mutations stay in registered kernel operations. Each phase gets at most one autonomous authoring attempt. Protected-path contact, actual scope expansion, unavailable required token assurance, a stale base or policy, host failure, gate failure, or publication failure halts and retains the managed worktree. The deterministic report distinguishes predicted and observed scope and marks token/cost assurance as exact or unavailable.

The pilot deliberately stops short of multi-repository flights, Goal coordination, interval/background resume, and a dedicated VS Code panel. The CLI shorthand is only a more natural spelling of `auto plan`; it adds no confirmation or autonomous authority. `/sf-auto` is a guarded Copilot guide over the same planning and exact `auto start --confirm` operations.

## Troubleshooting

- `AUTO_DISABLED`: enable repository Auto policy, then opt in a work type.
- `AUTO_WORK_TYPE_INELIGIBLE`: choose a `bounded` work type to start; `plan-only` cannot create a Story.
- `AUTO_PLAN_CONFIRMATION_REQUIRED`: copy the full hash from the newly rendered Plan card.
- `AUTO_PLAN_STALE` or `AUTO_PLAN_EXPIRED`: create and review a new Plan; authority never transfers to changed bytes.
- `AUTO_BRANCH_COLLISION`: allocate a different Work ID and create a new Plan.
- `AUTO_TOKEN_ASSURANCE_UNAVAILABLE`: use exact provider accounting or ratify a policy-approved `best-available` Plan.
- `AUTO_CHECKPOINT_STALE`: read status again and confirm the current checkpoint instead of reusing an old one.
- A halted flight keeps its worktree. Inspect it and continue manually or replace the Plan; Auto does not silently retry.

## Related topics

Continue with `sflow explain story-lifecycle`, `sflow explain impact-framework`, or `sflow explain checkpoints-pause-continue`.
