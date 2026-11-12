---
name: sflow-governance-rebuild
description: Preview and deliberately rebuild this repository's governance onto the current Singularity Flow model.
disable-model-invocation: true
agent: agent
argument-hint: "[--dry-run]"

---
# Rebuild this repository's governance

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

A rebuild replaces every framework-owned workflow, template and agent with the
installed package, keeps every repository-owned definition byte-identical,
recompiles every workflow under the current rules, and archives every existing
Story. It never touches application code, tests or documents.

1. Run `singularity-flow governance rebuild --dry-run --json` first.
2. Show the complete plan: the configuration source, every
   `replaced` file, `removed`, `kept`, every
   workflow with its owner and status, every failing workflow's findings and
   repair action, every Story with its branches, and every blocker. Do not
   summarize away files, workflows or Stories.
3. If `blockers` is not empty, stop: the plan cannot be confirmed. Relay each
   blocker and its repair, then preview again after the contributor repairs it.
4. Otherwise ask the contributor whether to proceed. A failing repository
   workflow listed in `inactive` stays byte-identical and unstartable until it
   is repaired; the confirmation must name it with `--accept-inactive`.
5. Only after the contributor explicitly confirms that plan, run the returned
   `next` command with `--json` and show `receipt`, `archived`,
   `backup` and `invariants`. Tell them to push the branch for teammates.
6. To undo a rebuild, run `singularity-flow governance restore --plan <PLAN>
   --dry-run --json`, show every file, and confirm only with their consent.

Never supply a confirmation yourself, infer consent from the original request,
edit a workflow to make it pass, commit, push, or delete a branch. If the CLI
refuses, relay its code and repair and stop.
