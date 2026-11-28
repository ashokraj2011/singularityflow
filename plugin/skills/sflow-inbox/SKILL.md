---
name: sflow-inbox
description: Show everything waiting on you across the workspace's repositories, and take the first.
disable-model-invocation: true
agent: agent

---
# Open what needs you

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with "/sf-next carries it on" (or press Continue). Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow needs-you --json`. It reads every repository of the active workspace (one not cloned yet from its remote), judges each with the identity SFlow records with there, and checks nothing out.
2. If `items` is empty, say nothing waits on you in the repositories of `scope.repositories`, by name. Do not infer that uncommitted or unpublished work is ready for review.
3. Show the items in their order (Holds work, then Reviews, then Later), the first `shown` of them, then "Show <more> more" when `more` is not 0. For each: its `question`; its `story.id`, `story.title` and `repository.name`; `recommended.words`, else `recommendation`; and "SFlow could not tell whether this one is yours" when `couldNotTell`. Then repeat each line of `lines` as it is.
4. Use Copilot's `ask_user` facility to offer the first item, and the others by their question. Never infer or preselect an item.
5. Run `singularity-flow needs-you show <KEY> --json` once with the chosen item's `key`, and show its card: `card.question`, `card.why`, `card.about.lines`, `card.checked`, `card.recommendation.words`, `card.place.words`, then each of `card.choices` by its `label`, with its routes (Copilot: `copilotCommand`, Shell: `command`).
6. When `item.route.here` is true, its choices go on in this chat with their Copilot routes (`/sf-approve …`, `/sf-decide …`). Otherwise give `item.route.elsewhere.commands` and `item.route.elsewhere.copilotCommand`, which open the item's own repository. A choice's Shell route is the person's own terminal command with every value filled in but their own words (`<REASON>`): give it as it is where this chat cannot record their choice.
7. Stop. Never approve, decide or record anything automatically.
