---
name: sflow-admin
description: Diagnose and administer Singularity Flow configuration, workspace upgrades, agents, Jira, state planes, and recovery.
disable-model-invocation: true
argument-hint: "[doctor|configuration|reinitialize [WORKSPACE]|agents|jira|state|recovery]"
---
# Administer Singularity Flow

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

1. Route configuration to `configuration`, workspace selection to `/sf-workspace`, remote Markdown to `agents status`, and Jira connectivity to `jira doctor`.
2. For **reinitialize**, **upgrade existing workspaces**, **migrate workspace schema**, or **refresh capabilities after install**, run `singularity-flow workspace list --json` and `singularity-flow workspace current --json`. Ask for exactly one scope: all registered workspaces, one returned workspace ID, or returned repository IDs. Never infer the scope from the current directory, active Story, chat history, or similar names.
3. Build the preview from that exact selection and run it once:

   `singularity-flow workspace reinitialize [WORKSPACE-ID] [--repository REPOSITORY-ID]... [--resolve PATH=local|bundled|merge]... --dry-run --json`

4. Show the scope, plan ID, changes, conflicts, locators, schema census, migrations, blockers, warnings, and next action. State that preview changed nothing and historical durable records are never rewritten. For a conflict, ask for its path and an offered resolution, then create a fresh preview with those `--resolve` values and discard the earlier plan ID.
5. Apply only when the contributor asks after reviewing the preview and supplies its exact plan ID. Run the same scope and resolutions once, replacing `--dry-run` with `--confirm-plan <EXACT-PLAN-ID> --json`. Reject abbreviated, old, or different-scope plan IDs.
6. On stale plan, refusal, partial publication, or any changed authority, stop and relay the CLI's exact remediation. Never retry an apply, widen its scope, substitute `--accept-bundled-conflicts`, invoke factory reset, or hand-edit configuration/state files.
7. Otherwise run `singularity-flow workspace current --json`, require its exact `repositoryPath`, and use it as cwd for `doctor --json` and `state planes --json`. Refuse without a selection; never fall back to the home directory or parent search. Show authority, revision, pending publication, ledger/outbox status, and affected files.
8. Start read-only. Never mutate merely because this skill opened. For an approved other repair, run the narrowest deterministic command. Factory reset requires its own preview and exact confirmation.
