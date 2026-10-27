---
name: sflow-inputs
description: Inspect and render the approved phase-artifact inputs configured for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[phase]"

---
# Inspect phase inputs

<!-- sflow-copilot-pause -->
Reuse the input preview from a verified current-invocation `/sf-next` packet when present; otherwise first run `singularity-flow inputs --dry-run --for-agent --json`. Both check pause before Git or Story discovery. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result names `agentOutput.read` ranges and `omittedFields` text files; read all in one response with your file tool, at the exact paths in the checkout's `.sflow/out/`. If a result comes back cut off, empty, still running or saved where you cannot open it, run `singularity-flow result last --wait --for-agent --json` and act on it; never rerun the command or point back to this skill, and never read the host's copy with shell tools. If a path SFlow returned fails to open, copy it again exactly from the result and open it once more; only then report it unopened, with the path and error.
<!-- sflow-execution-boundary -->
**Boundary:** reuse this invocation's entry: require `ready`/`workId`, valid `phaseAgent` for active phases; cwd=`repositoryPath`, or as is from a non-Git (chat) folder: SFlow finds the bound checkout; never refuse or wrap for it. Use returned `workItemRoot`/artifact paths; never `$HOME`. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `--dry-run` only for read-only inspection and never edit managed input records to bypass a gate.

1. Use only the active phase in the verified entry/preview. A delegated `/sf-next` preview is reusable only in this invocation, before another mutation; never use an earlier chat's binding. No separate pause/session/status, repository search or artifact inspection.
2. Inspect preview `records`, `errors` and `warnings`; never infer truncation from a smaller byte count or `representation.complete: false`.
3. Explain every missing, unapproved, truncated, hash-mismatched, missing-brief, stale-brief, or
   missing-expansion condition before continuing. When the record reports `approved-summary`, name
   the brief hash and source-bound expansion handle. Expand an exact source section only when the
   task requires its wording; never replace the governed brief by an agent-authored summary.
4. Run `singularity-flow inputs <phase> --for-agent --json` once to write the next-generation audit record and render the managed input block. The command revalidates the current binding and approved inputs; never self-confirm a sequence warning.
5. Use returned `audit` and `artifact.managedBlock` metadata; preserve the marker-delimited managed block. `matchesRendered: false`: stop and relay the mismatch. Do not reread the audit, brief or artifact merely to locate markers. Read an exact returned path only when source wording is needed. Input `generation` is the preparation generation, not a published `phaseGeneration`.
6. Relay returned `continuation.actions` on all three surfaces per the Output contract. Never replace a compose action with bare `/sf-worldmodel`, or guess a next step. Do not submit, approve, or reject automatically.
