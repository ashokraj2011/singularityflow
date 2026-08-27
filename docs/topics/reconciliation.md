---
id: reconciliation
title: Reconciliation and dispositions
aliases:
  - reconcile
  - dispositions
  - update-intent
commands:
  - story
related:
  - work-intervals
  - escalation
  - sequence-gates
version: 4
---
`sflow story interval reconcile` deterministically compares reality against the starting contract: claimed vs. changed paths, protected paths, required checks bound to the exact commit, and clause coverage. Verdicts are clear · attention · blocked · incomplete, and `clear` explicitly does not claim semantic correctness. Convergence findings are facts; a human dispositions each one as `rework`, `update-intent`, `accepted-deviation`, `dismissed`, or `deferred`. Final submission requires a clean reconciliation bound to the submitted commit.

## Purpose and prerequisites

Use this topic when the current goal matches **reconciliation**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow story`. Run `singularity-flow story --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Reconcile the active work interval, then run `sflow story converge`.
2. Record each human disposition with `sflow story adjudicate`. An `update-intent` decision must name the clause with `--clause` and blocks advancement just like rework.
3. For code that must change, use the separately offered `sflow story rework --confirm` transition.
   If that return was a mistake, run `sflow story rework roll-forward --work-id <ID> --change-request <CR-ID> --json` first. Review the exact path list, then repeat it with the emitted `--confirm sha256:...`. Flow backs up the current rework bytes locally and creates a new governed restoration commit; it never resets or rewrites the rejection history.
4. For intent that must change, prepare amended specification Markdown and run `sflow story intent-amendment propose --file AMENDED-SPEC.md --reason TEXT`. This publishes a proposal; it does not edit the approved specification.
5. An authorized specification reviewer runs `sflow story intent-amendment decide AMD-NNN --decision approve|reject --confirm AMD-NNN`. Approval creates a new specification generation, invalidates downstream approvals, and labels existing evidence as affected or preserved.
6. The developer reads the recorded clause and blast-radius summary, then runs `sflow story intent-amendment acknowledge AMD-NNN`. Submission remains blocked until this acknowledgement.
7. Replay the downstream phases. Existing unaffected evidence remains in place; affected evidence must be regenerated or revalidated through the normal publication and approval gates.

## State and safety

These commands can mutate governed or machine-local state: `story`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain work-intervals`, `sflow explain escalation`, `sflow explain sequence-gates`.
