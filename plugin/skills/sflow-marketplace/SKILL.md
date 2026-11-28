---
name: sflow-marketplace
description: See every item of the trusted marketplaces and what is installed here, and install, update or remove one after the person says yes.
disable-model-invocation: true
agent: agent
argument-hint: "[WORDS | skills|agents|workflows|templates|mcp servers|generated | newer versions]"

---
# The marketplace: what is there and what is installed here

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with "/sf-next carries it on" (or press Continue). Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow marketplace catalog --json` once. Add `--kind <KIND>` only when the person names one kind (skill, agent, workflow, template, mcp-server, generated), `--search "<their words>"` only for words that name items, and `--newest` only when they ask about versions newer than the ones trusted.
2. Say `summary` in one line, then one table: name, marketplace (`marketplaceLabel`, or "here"), owner (`owner.name`), `version`, lifecycle (`lifecycleRecord.words`, else `lifecycle`), `channel`, `status` in words, and `statusWords` unless installed; add `newer.words` and `deprecatedInUse.words` when there. At most 20 rows; say how many more. Relay `warnings` and each source's `notApproved` and `newest.words` as given.
3. To install, update, remove, get newer or replace one item, find it by the person's words; when several match, `ask_user` with those items as choices. Show its `actions.preview.command` when it has one, and that action's `label` (`actions.trust` for get newer, `actions.replace` for a deprecated one's replacement). Then `ask_user` "Propose this change for review?" with Yes and No.
4. Only on the person's own Yes, run that action's `command` exactly, with `--json`, and relay its result and next action. Never show its `--sha256` value. On No, change nothing.
5. An item with no such action: relay its `statusWords`. An MCP server is added through `/sf-import` from its preview, with the agents the person names.
6. Never edit configuration files yourself or run a command the catalog did not return.
