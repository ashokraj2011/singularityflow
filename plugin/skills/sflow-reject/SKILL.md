---
name: sflow-reject
description: Propose or review an intent amendment in any workflow, request changes to a submitted or closed Story, or safely return/abandon rework. Records authority and invalidation without rewriting Git history.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--fetch] --to PHASE --reason 'explanation' [--repair] | intent-amendment [status|propose|decide|acknowledge] | roll-forward [CR-ID]"

---
# Request governed changes

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

On `Out of sequence`, relay the refusal. On `Soft sequence warning`, leave continuation to the
human. Never edit managed state to bypass a gate.

## Intent changes

For `singularity-flow story intent-amendment`, use this route, not phase rejection:

1. Inspect `singularity-flow status --json`. Confirm the human's changed intent and reason.
   Draft separate amended scope Markdown;
   never edit approved intent in place.
2. Run `singularity-flow story intent-amendment propose --work-id <WORK-ID> --file <FILE> --reason "<REASON>" --authored governed-agent --channel copilot-host --json`.
   Every workflow supports it after scope approval; do not invent an `update-intent` convergence
   finding or change YAML. The CLI binds the phase and exact clause diff. Before scope approval,
   record the human change in clarification and revise/review the ordinary scope draft instead.
3. Show amendment ID, clause diff and blast radius.
   Only an authorized human scope reviewer may decide with exact confirmation; do not self-approve.
   A stale proposal can be rejected by that authority and replaced without changing approved intent.
4. Acknowledge only when asked, using the returned command. Revalidate downstream phases and
   grounding; never waive tests or approvals. Closed Stories use reviewed reopening. Stop after the requested action.

## Phase correction

1. Show status, hashes, `rejectTo` targets, Git identity/authority and agent.
   Require a specific rejection reason and target phase; do not invent either.
2. Awaiting approval: `singularity-flow reject <phase> --work-id <WORK-ID> --fetch --to <earlier-phase> --reason "..."`.
   For an in-progress review holding source/test edits, preserve them and preview the engine's
   return: `singularity-flow reject <review> --to <code> --repair --reason "..."`.
   Show paths/digest and request confirmation before repeating with `--confirm <sha256>`.
   Do not `--fetch` a dirty bound worktree. Retest and approve the new Code generation before review.
3. Closed Story: `singularity-flow reopen <WORK-ID> --fetch --to <phase> --reason "..."`.
4. Show invalidations. Relay identity, target, reopening, freshness or publication refusals;
   agent changes grant no authority. Report decision ID, comment, identity/authority, agent,
   target, invalidations and commit/push. Author repairs only when requested.

## Abandon rework

Preview `singularity-flow story rework roll-forward --work-id <WORK-ID> --change-request <CR-ID> --json`.
Show paths, phase, backup guarantee and digest. After explicit confirmation repeat with
`--confirm <sha256>`. Report backup, commit/push and phase. Never reset Git or copy artifacts.
On checkpoint, digest, boundary or staged-path errors, preserve bytes and relay recovery.
