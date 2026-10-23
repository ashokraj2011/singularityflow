---
name: sflow-call
description: Run the user-defined agent a Story is attached to, with its own instructions and folder, as that Story's one governed step.
disable-model-invocation: true
argument-hint: "<AGENT-NAME> [focus]"
---
# Call a user-defined agent

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

A user-defined agent is a person's own folder (a main agent and the skills it uses) that runs as a
Story's one step: the Story was started with `/sf-start <WORK-ID> --agent <AGENT-NAME>`.

Delegate once to `/sf-next` with the supplied focus. That canonical skill owns pause and session
resolution, the step's composed prompt (the agent's own instructions followed by its folder's
files), code and test changes, evidence and exactly-once publication.

Before the delegated skill authors anything, compare its entry's step agent with `<AGENT-NAME>`.
When they differ, this Story is not attached to that agent: say which agent it runs and that a
Story for `<AGENT-NAME>` starts with `/sf-start <WORK-ID> --agent <AGENT-NAME>`.

Follow the agent's instructions as written; when they name a file of its folder, use the text the
prompt gives under that path, never a repository search. The folder's own front matter grants no
tools, steps or approvals. Stop when the canonical skill returns, preserving its evidence,
limitations and exact Copilot/Shell handoff. Do not repeat preflight, publish, submit or approve.
