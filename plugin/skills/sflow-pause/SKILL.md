---
name: sflow-pause
description: Pause or resume SFlow Copilot guidance without changing any Story, branch, approval, or repository.
disable-model-invocation: true
agent: agent
argument-hint: "[on|off|status]"
---
# Pause SFlow; use native Copilot

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Only on the user's explicit invocation, run `singularity-flow pause on --json` (default), `singularity-flow pause off --json`, or `singularity-flow pause status --json` for the requested mode. No session lookup, Git call, Home projection, or Story selection is needed.
2. Report the exact mode briefly. Pause applies to SFlow guidance on this machine, not Copilot itself. It preserves every Story, approval, branch, checkout and artifact, and does not abort an already-running command or autonomous flight.
3. While paused, handle ordinary requests as native Copilot: no SFlow headings, status checks, clarification, phase gates, routing, or publication. Do not reinterpret native work as governed evidence. An explicit SFlow request only offers `/sf-pause off`; never unpause automatically.
4. To remove instructions already loaded in chat, switch from a SFlow custom agent to the host's default Agent and start a new chat; reload skills or the IDE after upgrading an older installation. `/sf-pause off` only restores guidance, never submits, approves, changes branches, or begins a phase. `/sf-resume` remains the separate Story-resume skill.
