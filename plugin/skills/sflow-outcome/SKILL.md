---
name: sflow-outcome
description: Show what a Story delivered - the app to try, each criterion's tests and checks, and what is still open - without changing anything.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--capability ID]"

---
# Check the outcome

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Use the Boundary repository. With an explicit Work ID, do not require or change the active Story. Without an ID, run `singularity-flow session current --json` and require its `ready` Story; use its exact `repositoryPath` as cwd.
2. Run `singularity-flow outcome <WORK-ID> --for-agent --json`, adding `--capability` only when the person named one.
3. From `data.outcome`, show `lifecycle` and `completion`. Under "Try it", list each `application.entries` item with its `url`, whether it is `started`, and the route it carries to start it or shut it down; when `portTaken` is true, say another process already listens at that address. If `application.status` is not `declared`, show its `message` or `setup` route.
4. For each `criteria` item show its `id`, `text`, `result` and `methods`; each test with its `outcome`; and each check with its `method`, `status`, `reference`, `suggestedFile` and `signOff` command.
5. List `open.scopeItems` with both commands and `open.blocking` messages, then `routes.tests` as the way to run the tests again.
6. Only relay. Never start the application or shut it down, run tests, take a screenshot, sign off or record a decision here: those are the person's routes, run when they ask. A screenshot or a passing test is not a sign-off.
