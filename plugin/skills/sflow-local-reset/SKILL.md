---
name: sflow-local-reset
description: Preview and deliberately forget machine-local Singularity state while preserving workspaces, or delete validated local workspaces in the explicit destructive mode.
disable-model-invocation: true
agent: agent
argument-hint: "[--forget-only] [--dry-run]"

---
# Reset this machine's local Singularity state

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). Every turn that no SFlow note carries on ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This is not a repository factory reset and not a product reinstall. Prefer
`--forget-only` when the contributor wants to remove this machine's registrations,
caches, credentials, sessions, onboarding and personalization without deleting any
workspace, clone, branch, worktree, dirty file, manifest, or repository-local
recovery record. With no mode flag, the compatibility mode physically deletes only
workspace directories whose registry entry and regular `workspace.json` manifest
prove that Singularity manages the exact path. It keeps every Story checkout: a
workspace that holds one stays whole and is only forgotten.

1. Establish the intended mode. Use `--forget-only` unless the contributor explicitly
   asks to delete physical workspace directories and their clones.
2. Run `singularity-flow local-reset [--forget-only] --dry-run --json` with the exact
   same mode that will be applied.
3. Show `mode`, every entry in `workspaces`, `missingRegistrations`, `remove`, and
   `preserve`. State the exact number of physical workspace directories scheduled
   for deletion or preservation.
4. The contributor must explicitly provide the exact `confirmation` value from
   the preview. Never generate or supply it yourself.
5. Only after that separate answer, run the same mode:

   ```bash
   singularity-flow local-reset [--forget-only] --confirm "<EXACT CONFIRMATION>" --json
   ```

   `FORGET LOCAL` authorizes only `--forget-only`; `RESET LOCAL` authorizes only
   physical workspace deletion. Never substitute one for the other.
6. Report that installed product surfaces remain available and the next action is
   to create or open a workspace.

Never delete an unregistered path, bypass a manifest mismatch, run from inside a
workspace being removed, uninstall product components, or convert the request into
`factory-reset`, `reset-all`, or `fresh-install`.
