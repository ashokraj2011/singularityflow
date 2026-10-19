---
name: sflow-initiative-start
description: Start a multi-repository Singularity Flow initiative by selecting its immutable profile and automatically activating the first phase agent.
disable-model-invocation: true
argument-hint: "<INIT-ID> [--jira] [--title TEXT] [--description TEXT]"

---
# Start an initiative

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Keep every choice and confirmation inside GitHub Copilot.

1. Require an initiative or Jira ID; the next command checks the portfolio and returns its profiles.
2. Run `singularity-flow initiative choices begin start <INIT-ID> --json`.
3. Present the returned initiative-profile choice with Copilot's `ask_user`. Never infer or silently default the profile. The selected profile's first phase activates its governed agent automatically.
4. Record each exact answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
5. After the receipt reports `ready: true`, run `singularity-flow initiative start <INIT-ID> --selection-receipt <TOKEN>` with the user's Jira, title, and description arguments.
6. The CLI creates the exact initiative branch, snapshots the portfolio/profile, commits, and pushes. Do not create or switch branches manually.
7. Show the complete phase flow, profile, current phase, commit, publication result, and the next action it returned (or `singularity-flow initiative next --for-agent --json`). Recommend `/sf-initiative-documents` after phase preparation.

If `ask_user` is unavailable or disabled, stop without mutation. Never substitute public `--profile` or `--agent` flags; they intentionally do not exist.
