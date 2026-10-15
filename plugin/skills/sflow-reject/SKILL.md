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
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
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
   finding or change YAML. The CLI binds the phase and exact clause diff. Propose only when nextsteps returns the
   `singularity-flow story intent-amendment propose` action; otherwise record the change in clarification and revise the scope draft.
3. Show amendment ID, clause diff and blast radius.
   Only an authorized human scope reviewer may decide with exact confirmation; do not self-approve.
   A stale proposal can be rejected by that authority and replaced without changing approved intent.
4. Acknowledge only when asked, using the returned command. Revalidate downstream phases and
   grounding; never waive tests or approvals. Closed Stories use reviewed reopening. Stop after the requested action.

## Phase correction

1. Show status, hashes, `rejectTo` targets, Git identity/authority and agent.
   Require a specific rejection reason and target phase; do not invent either.
2. Awaiting approval: `singularity-flow reject <phase> --work-id <WORK-ID> --fetch --to <earlier-phase> --reason "..."`.
   For an in-progress review holding source/test edits, preserve them and preview only the returned
   `details.repairCommand` (it names both steps); never choose the steps yourself.
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
