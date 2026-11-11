---
id: quick-fix
title: The quick-fix rail
aliases:
  - proportional-ceremony
  - small-changes
commands:
  - start
related:
  - waivers
  - escalation
  - work-intervals
version: 7
---
`sflow start FIX-88 --work-type quick-fix` runs a three-step rail (scope and plan · implement · verify) with no generated design requirement and waiver eligibility below a deterministic risk threshold. Even a short fix states what it must do and where it lands before code changes: its intake lists the acceptance criteria and the planned paths and tests, and one engineer signs that scope and plan off. Implement must then meet exactly those claims. Ceremony still scales with stakes: a typo fix meets one short sign-off; the same quick fix touching a protected path loses its verify waiver and meets a human — and work that outgrows the rail escalates with everything preserved.

In **Implement**, `/sf-code` (or you) writes the planned code and tests in an open generation; rerunning `sflow prepare` for Implement then builds its implementation summary from what changed. The summary is never edited by hand, and publication runs the configured tests.

## A reviewer in every step

Every step of a new quick fix is reviewed before it is submitted, by an independent read-only reviewer (`sflow-source-reviewer`), code included. After `/sf-phase` or `/sf-code` publishes a step, it starts that reviewer as a sub-agent in the same chat (VS Code's sub-agent tool, or the Copilot CLI's task tool); the reviewer works under its own read-only rules, and its result comes back to the same chat. Without a sub-agent tool, run `/sf-review-source` in a new chat (Shell: `singularity-flow review-source context <step> --json`). Submission waits until the review is ready.

- **Scope and plan** is reviewed against the Story: each source has a cited row saying the document agrees with it, disagrees, or leaves a question.
- **Implement** gets a code review with four checks, each finding cited at file:line: (a) the code matches the approved plan: every changed path is in a plan row or reviewed as supporting, and each clause is implemented where its row says; (b) each clause has its own planned test that ran, passed and checks the behaviour; (c) every quality, security and secret-scan result is reviewed; (d) readability and design are advice, and block only for a named maintainability defect.
- When the code review asks for corrections, the next generation opens in the same step: `/sf-recover` previews `singularity-flow phase rollover implement --json` with the review as the reason, and you confirm it once. Correct the code, publish, review again, then submit.

Stories started before reviews covered every step keep the review they started with. A workflow can leave reviews out with `sourceReview: { mode: off }`, or skip a step with `sourceReview.skip`.

## Purpose and prerequisites

Use this topic when the current goal matches **quick fix**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow start`. Run `singularity-flow start --help` for the exact forms supported by this build.
- **Copilot:** `/sf-start`. The skill must preserve the CLI result and ask before it changes anything.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can change repository or machine-local state: `start`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain waivers`, `sflow explain escalation`, `sflow explain work-intervals`.
