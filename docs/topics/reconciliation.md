---
id: reconciliation
title: Reconciliation and dispositions
aliases:
  - reconcile
  - dispositions
  - update-intent
  - spec-drift
commands:
  - story
  - spec
related:
  - work-intervals
  - escalation
  - sequence-gates
version: 10
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
4. For intent that must change, draft it with `sflow story intent-amendment draft`: it copies the approved scope and marks a `sflow-draft` slot in the row of each clause dispositioned `update-intent` (and any `--clause` you name), and adds a clause for each closed Story's clause this Story takes over (`--adopt CLAUSE-ID`, or one recorded with `spec drift decide --adopt --story`), with its planned-evidence row. The draft is written beside the checkout's Git data, never into the Story. Write the wording in every slot; `propose` refuses a draft with a slot left. Then prepare the amended scope/specification Markdown and run `sflow story intent-amendment propose --file AMENDED-SPEC.md --reason TEXT`. This is available by default in every existing or future workflow from an active phase after scope approval: no convergence phase, `update-intent` finding, rework-loop setting, YAML change, or Story migration is required. The CLI binds the current phase and derives every exact changed clause from the reviewed bytes. Optional `--source-phase` must equal the current phase; an optional `--clause` list must name every and only changed clause. This publishes a proposal; it does not edit approved intent. Before scope approval, record the human change in clarification and revise/review its draft normally. Closed Stories use their ordinary reviewed reopen route.
5. An authorized specification reviewer runs `sflow story intent-amendment decide AMD-NNN --decision approve|reject --confirm AMD-NNN`. Approval creates a new specification generation and a new scope revision, invalidates downstream approvals, and labels existing evidence as affected when it cites a changed clause by its exact ID. Approved steps right after the scope that cite none of the changed, removed or now-stale clauses keep their approval (rule E8), as long as nothing else they decided over had changed and every step before them kept theirs too; code and convergence steps, steps tied to a decision or a skill, and a planning step when the amendment adds a clause, always run again. When the amendment removes a clause, a code step's prepublish names every tag that still claims it. In the evidence matrix only the clauses the revision added or revised, and the clauses depending on them, are stale; every other clause keeps its evidence.
6. The developer reads the recorded clause and blast-radius summary, then runs `sflow story intent-amendment acknowledge AMD-NNN`. Submission remains blocked until this acknowledgement.
7. Replay the downstream phases. Existing unaffected evidence remains in place; affected evidence must be regenerated or revalidated through the normal publication and approval gates.

## After a Story closes: spec drift

Reconciliation stops when a Story closes, but its code keeps changing. `sflow spec drift` checks every closed Story recorded in this checkout: for each approved clause it compares the source lines tagged `@clause`, the hunks the delivery changed and the acceptance test that witnessed it, from the generation commit the approval bound, to the working tree (or `--ref REV`).

- **in sync:** the tags are there and the bound lines and tests are unchanged.
- **drifted:** a bound line, the acceptance test or a planned deletion changed since approval. The report names the lines and the commits that changed them.
- **orphaned:** every tag, or every acceptance test, of the clause is gone.
- **unverifiable:** the approved commit is not in this clone (fetch the Story branch) or the receipt cannot be read.

It also says when an approved specification or plan document changed after approval. Use `--work-id ID` for one Story, `--all` to list in-sync clauses too, and `--json` for the full report. A Story whose code step changes code another closed Story's clause is bound to gets an advisory at prepublish naming that clause; if this Story's specification should take the behaviour over, `sflow story intent-amendment draft --adopt CLAUSE-ID` drafts that clause for it.

Drift is advice. Nothing refuses because of it, and the report is computed each time. A person who approves the step that delivered a drifted clause (or, for a step nobody approves, the next step that has approvers) records how it is resolved:

- `sflow spec drift decide CLAUSE-ID --adopt --story ID --reason TEXT`: the specification follows the code, through Story ID (new or reopened) that amends the clause.
- `sflow spec drift decide CLAUSE-ID --restore --story ID --reason TEXT`: the code follows the specification, through fix Story ID.
- `sflow spec drift decide CLAUSE-ID --accept --reason TEXT`: the drift is acceptable as it stands.
- `sflow spec drift decide --revoke DRD-NNN --work-id ID --reason TEXT` withdraws a decision; the record stays.

The clause then reads **resolving** until the named Story closes and **adopted** or **restored** once it has, while the code still matches what that Story approved. An accepted clause reads **drift accepted** while its bound code and tests keep the bytes that were accepted. Any later change shows the drift again. Decisions are kept in `singularity/spec-drift/<WORK-ID>.json`, beside the closed Story's records and never inside them, and committed on the current branch with only that file; push it or open a pull request to share it. Record them on the default branch or a branch of their own, not on an open Story's branch. An agent is refused: it shows the command and stops.

## State and safety

These commands can mutate governed or machine-local state: `story`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a pending amendment's source changed, an authorized scope reviewer can reject it with `sflow story intent-amendment decide AMD-NNN --decision reject --confirm AMD-NNN`, then propose fresh bytes. Stale evidence blocks approval, not rejection; rejection preserves approved intent, code, and evidence.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain work-intervals`, `sflow explain escalation`, `sflow explain sequence-gates`.
