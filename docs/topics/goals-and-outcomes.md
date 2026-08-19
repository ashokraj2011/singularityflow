---
id: goals-and-outcomes
title: Goals, outcomes, and governed work
aliases:
  - goals
  - goal
  - outcome-goals
commands:
  - goal
related:
  - developer-home
  - workspaces-and-sessions
  - story-lifecycle
  - initiative-lifecycle
version: 2
---
A Goal has two explicit modes. A `GOL-*` Goal is a personal, workspace-scoped outcome and remains local advisory state. A `GEX-*` Goal Execution is a repository-owned contract with typed success oracles, a deterministic plan, exact-hash plan approval, guided attempts, and durable evidence on its own lifecycle branch. In both modes, linked Stories and Initiatives keep their own workflows, authorities, branches, artifacts, confirmations, and approvals.

## Purpose and prerequisites

Use a Goal when the desired outcome is broader than one bounded task or may span multiple work items or sessions. Select a workspace first. Creating a Goal requires an outcome statement and at least one observable success criterion. Linking requires the Story or Initiative to exist in a materialized workspace repository or its local remote-tracking state.

## Use it from each surface

- **Shell:** use `sflow goal list`, `sflow goal create "<outcome>" --success "<criterion>"`, and `sflow goal next` for personal Goals. Use `goal propose`, `goal govern`, and `goal inspect <GEX-ID>` to enter governed execution. Run `singularity-flow goal --help` for every supported form.
- **Copilot:** invoke `/sf-goal`. The skill distinguishes IDs before acting, reconstructs `GEX-*` state from Git, shows the exact plan hash, and asks before promotion, plan approval, or another mutation.
- **VS Code:** open Lifecycle → Goals. The panel shows personal outcomes and governed executions from the same active workspace. Editor state is only a view cache; local Goal records and Git lifecycle branches remain authoritative.

## Guided workflow

1. Select the intended workspace with `sflow workspace use <WORKSPACE>` and inspect current work with `sflow home`.
2. Create an outcome with one or more observable success criteria. A criterion should describe what a person can verify, not an implementation activity such as “write code.”
3. Optionally link an existing Story or Initiative. Linking validates the subject and records its repository, canonical branch, title, and identity; it does not check out, start, advance, or publish that subject.
4. Use `sflow goal next` to obtain one grounded navigation action. The action may attach a linked Story, open Initiative next steps, repair a missing link, or offer Goal completion after all links are terminal.
5. Use `sflow goal show` to review criteria and live linked-work states. Switch between active Goals with `sflow goal use <GOAL-ID>`.
6. Complete with the exact Goal-ID confirmation only after the outcome is achieved. Abandoning also requires the exact ID and a reason, and preserves the Goal history.

For a governed execution:

1. Start with the read-only `sflow goal propose "<outcome>" --success "<criterion>"`. The proposal reports scope and unresolved decisions but creates no branch or work item.
2. Create or select a personal Goal, link the existing Stories or Initiatives it should coordinate, and run `sflow goal govern <GOL-ID>`. Promotion creates a new `GEX-*` identity and copies only the displayed outcome, criteria, and links; the personal Goal is unchanged.
3. Inspect with `sflow goal inspect <GEX-ID>` and preview cross-repository scope with `sflow goal impact <GEX-ID>`.
4. Compile a model-free closed plan with `sflow goal plan <GEX-ID>`. Review its generation, exact subjects, ordered steps, write set, budgets, stopping points, and `planSha256`.
5. Approve only that plan with `sflow goal plan approve <GEX-ID> --generation <N> --confirm <PLAN-HASH>`. Changing plan bytes invalidates execution instead of inheriting the approval.
6. Use `sflow goal run-next <GEX-ID>` for one guided delegation. It may navigate to a Story or Initiative, but that subject still enforces its own confirmations and approvals. Bounded automatic looping is deliberately unavailable.
7. Evaluate typed oracles with `sflow goal verify <GEX-ID>`. `verified` requires fresh non-human oracle results; human judgments remain `mixed` or `acknowledged`.

## State and safety

Personal Goal state is stored under the selected workspace's local `.singularity-flow` directory with authority `personal-advisory`. CLI, Copilot, and VS Code read the same record. The store uses atomic writes and a workspace lead-repository mutation lock. Symbolic-link escapes and state belonging to a different workspace copy are refused.

Personal Goal operations never grant approval authority, alter a phase, move a Git ref, push a branch, or call an external system. Completing a personal Goal is human acknowledgement, not proof.

Governed records live below `singularity/goals/<GEX-ID>/` on branch `<GEX-ID>` in the workspace lead repository. Updates are prepared in detached temporary worktrees so the current Story checkout is not switched or dirtied. Contract, state, immutable plan generations, exact approvals, runs, evidence, and append-only event records are schema-registered and content-bound. Required publication performs a remote dry-run before local mutation and uses an explicit Goal-branch destination. A Goal approval authorizes only the plan envelope; it never supplies authority to an underlying operation.

## Troubleshooting

- If no workspace is selected, run `sflow workspace list` and `sflow workspace use <WORKSPACE>` before retrying.
- If linked work cannot be found, confirm its repository and kind, then fetch or attach it through `/sf-session`; Goal linking does not fetch implicitly.
- If a Goal cannot complete, inspect every linked subject. Active or unavailable work must be completed, abandoned, repaired, or explicitly unlinked first.
- If the store is invalid or belongs to another workspace copy, preserve it for diagnosis and repair the workspace selection. Do not copy Goal bytes over a different workspace.
- If a returned action would mutate governed state, follow its named `/sf-*` skill and confirmation flow. Goal selection itself is not mutation consent for the linked work.
- If a governed Goal is missing on a new machine, fetch its `GEX-*` lifecycle branch or run `goal inspect`; inspection refreshes that exact branch and does not require the original Copilot transcript.
- If plan execution reports drift, compile and approve a new generation. Never edit an approved plan in place or reuse its old confirmation hash.
- If publication preflight fails, restore remote access and retry; no Goal files were written. If a commit was retained after a push race, run `sflow goal sync <GEX-ID>`; the recovery marker binds the exact local branch and commit so the contract is not regenerated.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain workspaces-and-sessions`, `sflow explain story-lifecycle`, or `sflow explain initiative-lifecycle`.
