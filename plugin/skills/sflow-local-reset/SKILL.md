---
name: sflow-local-reset
description: Preview and deliberately forget machine-local Singularity state while preserving workspaces, or delete validated local workspaces in the explicit destructive mode.
disable-model-invocation: true
argument-hint: "[--forget-only] [--dry-run]"

---
# Reset this machine's local Singularity state

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

This is not a repository factory reset and not a product reinstall. Prefer
`--forget-only` when the contributor wants to remove this machine's registrations,
caches, credentials, sessions, onboarding and personalization without deleting any
workspace, clone, branch, worktree, dirty file, manifest, or repository-local
recovery record. With no mode flag, the compatibility mode physically deletes only
workspace directories whose registry entry and regular `workspace.json` manifest
prove that Singularity manages the exact path.

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
