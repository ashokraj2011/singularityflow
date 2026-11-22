---
name: sflow-import
description: Import an agent skill, artifact template, agent, or generated-artifact source from a public link or a trusted marketplace after the person reviews its exact content, or make a workflow from a marketplace agent.
disable-model-invocation: true
agent: agent
argument-hint: "[preview LINK|market:ID/ENTRY --as skill|template|agent | add ... --sha256 HASH | list | check | remove IMPORT | from-agent MARKETPLACE/AGENT|FOLDER]"

---
# Import skills, templates and agents from a link

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Preview first: `singularity-flow import preview <LINK> --as skill|template|agent --json`. Show the
   source, size, warnings and the full `text`: this exact-bytes review is the one exception to
   the no-paste rule, because the person must see what will be vendored. Ask what it is for: which agent and steps for a
   skill, which steps for a template. Never supply these yourself.
2. Add only the reviewed bytes, with the person's words for agent, ID and steps:
   `singularity-flow import add <LINK> --as <KIND> [--agent AGENT] [--id ID] [--phases A,B] --sha256 <HASH> --propose --json`.
   Use `--replace` only when the person asks to update an existing import; `--without-defaults` only
   when they say the imported agent must not take over steps.
3. Generated sources are rows, not content: `singularity-flow import add --as generated --agent A --id ID --url-template URL --phase P --target artifacts/P/F.md --propose --json`.
4. `singularity-flow imports --json` lists imports; `singularity-flow imports check --json` re-reads sources
   and gives the exact update command; `singularity-flow imports remove <IMPORT> --propose --json` removes one.

Marketplaces: `singularity-flow marketplace browse <ID> --json` lists entries; preview and add
`market:<ID>/<ENTRY>` like a link. MCP: `singularity-flow mcp sources <SERVER> --json` refuses with what would
run; add `--launch` only after the person allows it, then preview `mcp:<SERVER>/prompt|resource|tool/<NAME>`. Trust a new one (`singularity-flow marketplace add <ID> --index <URL>` or `--repo <GIT-URL|FOLDER> [--ref BRANCH]`,
with `--propose --json`) only when the person asks.

Agent to workflow: an entry with `workflowCommand` (an agent of a Git repository marketplace), or an agent folder the
person names, becomes a workflow. Run `singularity-flow workflow from-agent <MARKETPLACE/AGENT|FOLDER> --json`, which
writes nothing, and show each step's `label`, `intent` and `why`. While `ready` is false, ask the first `open`
question with its `choices` in one `ask_user`, then run it again with every answer so far as `--answer <step>=<intent>`.
When `walk` lists where a Story would be held up, show each with its `fix` in one `ask_user` and run it again with the
answer the person changes. When ready, run the same
command with `--propose --json` and show what `importPlan` adds; after the person accepts, run
`singularity-flow workflow import <bundlePath> --confirm <importPlan.planSha256> --propose --json` once.

Never edit `singularity/imports.lock.yml`, `singularity/agents.lock.yml` or vendored files by hand, fetch the link
yourself, or add content the person has not seen. A refusal ends the turn: relay it.
