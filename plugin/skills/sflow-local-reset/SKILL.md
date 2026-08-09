---
name: sflow-local-reset
description: Preview and deliberately remove all validated local Singularity workspaces and machine state while keeping the installed CLI, VS Code extension, Copilot plugin, and skills.
disable-model-invocation: true
argument-hint: "[--dry-run]"

---
# Reset this machine's local Singularity state

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

This is not a repository factory reset and not a product reinstall. It deletes
only workspace directories whose registry entry and regular `workspace.json`
manifest prove that Singularity manages the exact path. It also clears local
sessions, caches, telemetry configuration, recovery state, and Singularity-named
Copilot sessions. It preserves the installed CLI, VS Code extension, Copilot
plugin, `/sf-*` skills, unregistered repositories, and personal skills.

1. Run `singularity-flow local-reset --dry-run --json`.
2. Show every entry in `workspaces`, `missingRegistrations`, `remove`, and
   `preserve`. State the exact number of physical workspace directories scheduled
   for deletion.
3. The contributor must explicitly provide the exact `confirmation` value from
   the preview. Never generate or supply it yourself.
4. Only after that separate answer, run:

   ```bash
   singularity-flow local-reset --confirm "<EXACT CONFIRMATION>" --json
   ```

5. Report that installed product surfaces remain available and the next action is
   to create or open a workspace.

Never delete an unregistered path, bypass a manifest mismatch, run from inside a
workspace being removed, uninstall product components, or convert the request into
`factory-reset`, `reset-all`, or `fresh-install`.
