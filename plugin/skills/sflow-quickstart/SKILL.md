---
name: sflow-quickstart
description: See a complete governed change in a throwaway repository.
disable-model-invocation: true
agent: agent

---
# See a governed change, end to end

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use this when someone is new, asks how Singularity Flow works, or wants to try it
without committing a real repository to it. It runs in a sandbox the command
creates and removes: their own repository is never touched, there is no network
access, and no model is invoked.

1. Run `singularity-flow quickstart`. Add `--keep` only if the user asks to inspect
   the resulting repository afterwards.
2. Report each completed step in order. Each line is one real governed transition,
   not a simulation — that is the point of showing them.
3. State the two facts the summary reports and people most often doubt: zero model
   invocations and no network access.
4. Then offer the next step for their own work: `/sf-init` for a repository they
   already have (Shell: `singularity-flow init`), or
   `singularity-flow bootstrap <REPOSITORY-URL> --capability <ID>` to set up a new
   capability with its configuration branch and ledger.
5. Keep this read-only with respect to the user's repository. The sandbox is
   created and removed inside the command.
