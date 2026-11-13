---
name: sflow-reject
description: Propose or review an intent amendment in any workflow, request changes to a submitted or closed Story, or safely return/abandon rework. Records authority and invalidation without rewriting Git history.
disable-model-invocation: true
agent: agent
argument-hint: "[WORK-ID] [--fetch] --to PHASE --reason 'explanation' [--repair] | intent-amendment [status|draft|preview|propose] | roll-forward [CR-ID]"

---
# Request governed changes

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. View each `agentOutput.read` range and `need` text file in one response at its exact issued path in `.sflow/out/`, unless this chat already read that path (same path, same bytes); other `omittedFields` are optional. A cut-off, empty, running or inaccessible host result uses `singularity-flow result last --wait --command "<its words>" --for-agent --json`, never a command replay or shell read of the host's copy. Recover read-size/range failures with returned `readRequests`/`readRanges` in your file-view tool's parameters; finish all required ranges and continue this task. Use exact `pathCorrections`; never guess paths. Real missing-file/permission errors retain their path, native error and owner recovery route; never recreate inputs or retry unchanged access. Read `taskResume` on entry: keep its operation ID, spent budgets and exact next step across chats; obtain fresh context and local paths. Before ending, honor `taskCompletion`: input reads, preparation and diagnostic tests alone do not complete authoring or review. Preserve human decisions and explicit single-step boundaries.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

On `Out of sequence`, relay the refusal. On `Soft sequence warning`, leave continuation to the
human. Never edit managed state to bypass a gate.

## Intent changes

For `singularity-flow story intent-amendment`, use this route, not phase rejection:

1. Inspect `singularity-flow status --for-agent --json`. Confirm the human's changed intent and reason.
   Write only the changed clauses in the file `singularity-flow story intent-amendment draft` issues;
   never edit approved intent in place.
2. Show the `summary` of `singularity-flow story intent-amendment preview --work-id <WORK-ID> --file <FILE> --for-agent --json`, then run
   `singularity-flow story intent-amendment propose --work-id <WORK-ID> --file <FILE> --reason "<REASON>" --authored governed-agent --channel copilot-host --json`;
   do not invent an `update-intent` convergence finding or change YAML. Propose only when nextsteps returns the
   `singularity-flow story intent-amendment propose` action; otherwise record the change in clarification and revise the scope draft.
3. Show amendment ID, diff and blast radius. Only a human scope authority decides with exact confirmation,
   on the card `/sf-decide <WORK-ID>`; its step pauses until then. They may reject and replace stale proposals without changing approved intent.
4. The person acknowledges an approved one there; never decide or acknowledge here. Revalidate downstream inputs/grounding;
   waive no tests or approvals. Closed Stories need reviewed reopening. Stop after the action.

## Phase correction

1. Show status, targets, Git identity/authority and agent. Obtain the human's reason and target.
2. Awaiting approval: `singularity-flow reject <phase> --work-id <WORK-ID> --fetch --to <earlier-phase> --reason "..."`.
   Recovery's `return-current-phase-for-edits` uses its exact same-phase command, even if older
   `rejectTo` omits it. Show paths; preserve dirty files and prior approvals. Add no fetch, cleanup or
   selection receipt; never commit submitted edits by hand. Identity/authority checks still apply.
   For an in-progress review holding source/test edits, preview its exact `details.repairCommand`;
   never choose steps yourself. Show paths and obtain confirmation before `--confirm <sha256>`.
   Never fetch a dirty checkout. Retest and approve Code before review.
3. Closed Story: `singularity-flow reopen <WORK-ID> --fetch --to <phase> --reason "..."`.
4. Report decision, reason, identity/authority, agent, target, invalidations and commit/push.
   Relay refusals. Repair only when requested.

## Abandon rework

Preview `singularity-flow story rework roll-forward --work-id <WORK-ID> --change-request <CR-ID> --json`.
Show paths, phase and backup guarantee. After explicit confirmation repeat with
`--confirm <sha256>`. Report backup, commit/push and phase. Never reset Git or copy artifacts.
On checkpoint, digest, boundary or staged-path errors, preserve bytes and relay recovery.
