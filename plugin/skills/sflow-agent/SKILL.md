---
name: sflow-agent
description: Choose or inspect the governed Agent Markdown used for the current phase; agent selection never changes human identity or approval authority.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---

# Select the governed agent

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. View each `agentOutput.read` range and `need` text file in one response at its exact issued path in `.sflow/out/`, unless this chat already read that path (same path, same bytes); other `omittedFields` are optional. A cut-off, empty, running or inaccessible host result uses `singularity-flow result last --wait --for-agent --json`, never a command replay or shell read of the host's copy. Recover read-size/range failures with returned `readRequests`/`readRanges` in your file-view tool's parameters; finish all required ranges and continue this task. Use exact `pathCorrections`; never guess paths. Real missing-file/permission errors retain their path, native error and owner recovery route; never recreate inputs or retry unchanged access. Read `taskResume` on entry: keep its operation ID, spent budgets and exact next step across chats; obtain fresh context and local paths. Before ending, honor `taskCompletion`: input reads, preparation and diagnostic tests alone do not complete authoring or review. Preserve human decisions and explicit single-step boundaries.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow agent <WORK-ID>` with the entry's `workId`; add `--agent <ID>` only for a change the contributor asked for.
2. The phase default is automatic. A `SELECTION_REQUIRED` refusal lists `details.choices`: present every label, ID and description, then rerun with `--agent <ID>`.
3. Never pick for the contributor. Never infer human identity or approval authority from the agent.
4. Run `singularity-flow session status --json`, then report the agent, source hash, phase compatibility, work-item scope, and Copilot-session binding.
5. Agent Markdown controls prompt instructions and world-model views. Git/Jira identity and configured approval groups control human decisions.
