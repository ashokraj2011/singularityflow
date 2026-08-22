---
name: sflow-admin
description: Diagnose and administer Singularity Flow configuration, workspaces, agents, Jira, state planes, and recovery.
disable-model-invocation: true
argument-hint: "[doctor|configuration|workspace|agents|jira|state|recovery]"
---
# Administer Singularity Flow

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.

1. Run `singularity-flow doctor --json` and `singularity-flow state planes --json` before proposing a repair.
2. Route configuration questions to `configuration`, workspace questions to `workspace`, remote Markdown to `agents status`, and Jira connectivity to `jira doctor`.
3. Show which state plane is authoritative, its revision, pending publication, ledger/outbox status, and the exact affected files.
4. Use read-only or dry-run commands first. Never initialize, repair, reset, publish, unlock remote dependencies, or overwrite configuration merely because this skill was opened.
5. For an approved repair, present and run the narrowest deterministic CLI command. Factory reset always requires its own preview and exact confirmation.

