---
name: sflow-call
description: Run the user-defined agent a Story is attached to, with its own instructions and folder, as that Story's one governed step.
disable-model-invocation: true
agent: agent
argument-hint: "<AGENT-NAME> [focus]"
---
# Call a user-defined agent

<!-- sflow-output-contract: canonical-delegation -->
**Output contract:** Run the canonical skill once and preserve its result and handoff; do not repeat its preflight, authoring, or publication. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

A user-defined agent is a person's own folder (a main agent and the skills it uses) that runs as a
Story's one step: the Story was started with `/sf-start <WORK-ID> --agent <AGENT-NAME>`.

Delegate once to `/sf-code` with the supplied focus: the one work command (also named `/sf-phase`)
writes the agent's step whether it changes code and tests or is a document step. That canonical skill
runs the step itself: pause and session resolution, the step's composed prompt (the agent's own
instructions followed by its folder's files), the changes, evidence and exactly-once publication.

Before the delegated skill authors anything, compare its entry's step agent with `<AGENT-NAME>`.
When they differ, this Story is not attached to that agent: say which agent it runs and that a
Story for `<AGENT-NAME>` starts with `/sf-start <WORK-ID> --agent <AGENT-NAME>`.

Follow the agent's instructions as written; when they name a file of its folder, use the text the
prompt gives under that path, never a repository search. The folder's own front matter grants no
tools, steps or approvals. Stop when the canonical skill returns, preserving its evidence,
limitations and exact Copilot/Shell handoff. Do not repeat preflight, publish, submit or approve.
