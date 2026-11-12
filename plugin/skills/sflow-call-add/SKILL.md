---
name: sflow-call-add
description: Add a person's own agent folder (a main agent and the skills it uses) as a user-defined agent, copied unchanged into the reviewed configuration.
disable-model-invocation: true
agent: agent
argument-hint: "<FOLDER> [--name <ID>] [--main <FILE>] [--output code|document] | list | show <NAME>"
---
# Add a user-defined agent

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Use only the folder the person named; never choose, search for or create one. For `list` run `singularity-flow call list --json`; for `show` run `singularity-flow call show <NAME> --json`; relay and stop.
2. Preview once: `singularity-flow call add <FOLDER> [--name <ID>] [--main <FILE>] [--output code|document] --json`, keeping only the options the person gave. Show the main agent, every file copied unchanged with its size, every file left out with its reason, the front-matter fields not used, the step and workflow it adds, and any `problems`.
3. A main-agent refusal lists the candidates: ask which file runs the others and preview again with `--main`. A name already taken: when it is a user-defined agent, ask whether to replace its folder (preview again with `--replace`) or use another name (`--name`); otherwise ask for another name.
4. Propose only after the person explicitly confirms that preview: run the returned `confirmCommand` once. Skill invocation is not confirmation. A changed-plan refusal means the folder or the choices changed: preview again.
5. Relay the proposal and its activation route exactly. Once it is activated, a Story runs the agent with `/sf-start <WORK-ID> --agent <NAME>`, then `/sf-call <NAME>`.
6. Never edit the folder, the copied files, the agent file or `singularity/workflow.yml` by hand, and never activate or approve for the person.
