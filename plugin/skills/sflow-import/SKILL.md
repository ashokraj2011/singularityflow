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

1. Preview first: `singularity-flow import preview <LINK> --as skill|template|agent --json`. Show source, size,
   warnings and the full `text`, the one exception to the no-paste rule. Ask what it is for: which agent and steps for a skill, which steps for a template. Never supply these yourself.
2. Add only those bytes, with the person's agent, ID and steps:
   `singularity-flow import add <LINK> --as <KIND> [--agent AGENT] [--id ID] [--phases A,B] --sha256 <HASH> --propose --json`.
   `--replace` only when the person asks to update an import; `--without-defaults` only when they say it must not take over steps.
3. Generated sources are rows: `singularity-flow import add --as generated --agent A --id ID --url-template URL --phase P --target artifacts/P/F.md --propose --json`.
4. `singularity-flow imports --json` lists imports; `singularity-flow imports check --json` re-reads sources with each
   update command; `singularity-flow imports remove <IMPORT> --propose --json` removes one.

Marketplaces: `singularity-flow marketplace browse <ID> --json` lists entries; preview and add `market:<ID>/<ENTRY>`
like a link. MCP: `singularity-flow mcp sources <SERVER> --json` refuses with what would run; add `--launch` only after
the person allows it, then preview `mcp:<SERVER>/prompt|resource|tool/<NAME>`. Trust one (`singularity-flow marketplace add <ID> --index <URL>`
or `--repo <GIT-URL|FOLDER> [--ref BRANCH]`, with `--propose --json`) only when the person asks.

Agent to workflow: a `workflowCommand` entry, or an agent folder the person names. `singularity-flow workflow from-agent
<MARKETPLACE/AGENT|FOLDER> --json` writes nothing; show `review.markdown` whole, like step 1's bytes. While `ready` is
false, ask the first `open` question with its `choices` in one `ask_user` and run it again with every answer as
`--answer <step>=<intent>`; ask about each `walk` hold-up with its `fix` the same way. To send the marketplace its
findings, run it with `--feedback` and `review.feedbackDocument.name`, then give `review.feedbackDocument.issue.url`;
the person submits that issue, never you. When ready, run it with `--propose --json`, show what `importPlan` adds, and
once the person accepts run `singularity-flow workflow import <bundlePath> --confirm <importPlan.planSha256> --propose --json`.
A step 4 check row `changed at its source` gives its `updateCommand`: run it with `--json` and go on the same way; its
import updates the workflow in place. A row `removed at its source` keeps its workflow.

Never edit `singularity/imports.lock.yml`, `singularity/agents.lock.yml` or vendored files by hand, fetch the link
yourself, or add content the person has not seen. A refusal ends the turn: relay it.
