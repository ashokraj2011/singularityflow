---
name: sflow-inputs
description: Inspect and render the approved phase-artifact inputs configured for the active Singularity Flow phase.
disable-model-invocation: true
argument-hint: "[phase]"

---
# Inspect phase inputs

<!-- sflow-copilot-pause -->
Reuse the input preview from a verified current-invocation `/sf-next` packet when present; otherwise first run `singularity-flow inputs --dry-run --for-agent --json`. Both check pause before Git or Story discovery. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity. Run the lookup from the current cwd, even a non-Git chat folder; it resolves selection. Never locate a repository by searching `/Users`, `$HOME` or parents. Use only the returned `ready`/`workId`/`repositoryPath`; unavailable selection: `/sf-session` or `/sf-workspaces`, stop.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse this invocation's entry: require `ready`/`workId`, valid `phaseAgent` for active phases; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact paths; never `$HOME`.

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `--dry-run` only for read-only inspection and never edit managed input records to bypass a gate.

1. Use only the active phase in the verified entry/preview. A delegated `/sf-next` preview is reusable only in this invocation, before another mutation; never use an earlier chat's binding. No separate pause/session/status, repository search or artifact inspection.
2. Inspect preview `records`, `errors` and `warnings`; never infer truncation from a smaller byte count or `representation.complete: false`.
3. Explain every missing, unapproved, truncated, hash-mismatched, missing-brief, stale-brief, or
   missing-expansion condition before continuing. When the record reports `approved-summary`, name
   the brief hash and source-bound expansion handle. Expand an exact source section only when the
   task requires its wording; never replace the governed brief by an agent-authored summary.
4. Run `singularity-flow inputs <phase> --for-agent --json` once to write the next-generation audit record and render the managed input block. The command revalidates the current binding and approved inputs; never self-confirm a sequence warning.
5. Use returned `audit` and `artifact.managedBlock` metadata; preserve the marker-delimited managed block. `matchesRendered: false`: stop and relay the mismatch. Do not reread the audit, brief or artifact merely to locate markers. Read an exact returned path only when source wording is needed. Input `generation` is the preparation generation, not a published `phaseGeneration`.
6. Relay returned `continuation.actions` as exact Shell/Copilot pairs. Never replace a compose action with bare `/sf-worldmodel`, or guess a next step. Do not submit, approve, or reject automatically.
