---
name: sflow-push
description: Inspect or safely retry a preserved pre-Story transport intent without force-pushing or guessing remote state.
disable-model-invocation: true
agent: agent
argument-hint: "[status [INTENT-ID] | retry <INTENT-ID>]"
---

# Transport recovery

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Use this skill when a workspace, capability, configuration, or initialization push was interrupted before a Story publication journal existed.

1. Run `singularity-flow push status --json`, or `singularity-flow push status <INTENT-ID> --json` when the user supplied an ID.
2. Explain the preserved local commit, exact target ref, attempt budget, and classified fault. Never request a token, disable TLS, bypass hooks, or suggest force.
3. Ask before mutation. When the user selects retry, run `singularity-flow sync <INTENT-ID> --json` exactly once.
4. Report the returned status and its next action. `outcome-unknown`: the remote could not be read and nothing more was pushed; once the network or sign-in works, the person runs `singularity-flow sync <INTENT-ID> --json` again, which reads the remote first. `needs-user`: the same, once the person fixed the cause it names. `remote-diverged`: the branch moved; the operation that made the commit is repeated.

Story publication remains owned by `singularity-flow sync` without an intent ID; do not substitute this outbox for a Story pending-publication record.
