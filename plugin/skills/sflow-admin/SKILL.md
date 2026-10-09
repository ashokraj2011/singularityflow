---
name: sflow-admin
description: Diagnose and administer Singularity Flow configuration, workspace upgrades, agents, Jira, state planes, and recovery.
disable-model-invocation: true
argument-hint: "[doctor|configuration|migrate-schemas|reinitialize [WORKSPACE]|agents|jira|state|recovery]"
---
# Administer Singularity Flow

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

1. Route configuration to `singularity-flow configuration`, workspace selection to `/sf-workspace`, agents to `singularity-flow agents status`, and Jira to `singularity-flow jira doctor`.
2. For schema migration or compatibility, run `singularity-flow workspace migrate-schemas --json` once. It checks every active registered workspace repository and migrates supported records in memory. Show coverage, migrations, skips, and blockers. State that stored records remain unchanged; machine-local, workspace-private, content-addressed, and unmapped records are excluded.
3. For post-install upgrades, read `singularity-flow workspace list --json`. Ask for all registered workspaces, one returned workspace ID, or repository IDs; never infer scope from cwd or Story.
4. Build the preview from that exact selection and run it once:

   `singularity-flow workspace reinitialize [WORKSPACE-ID] [--repository REPOSITORY-ID]... --dry-run --json`

   Only for an explicit pilot hard cutover, include `--hard-cutover` in both commands. Review every retiring Story ID: those Stories become read-only; historical bytes remain unchanged and do not require migration. New Stories need new IDs. VS Code After install → Hard cutover provides the same exact-plan confirmation.

5. Show scope, plan, changes, preserved customizations, schema findings and next action. Preview changes nothing; custom assets and history are preserved. Never offer `--resolve ...=bundled` or `--accept-bundled-conflicts`; ownership transfer requires a separate `/sf-refresh-configuration` preview.
6. Apply only after human review, explicit authorization and the exact current plan ID. Rerun the same scope/flags once, replacing `--dry-run` with `--confirm-plan <EXACT-PLAN-ID> --json`. Reject abbreviated, stale, different-scope or ownership-transfer IDs.
7. On stale plan or partial publication, relay CLI remediation. Never blindly retry, widen scope, override conflicts, reset or hand-edit authority.
8. Otherwise read `singularity-flow workspace current --json`; require its `repositoryPath` as cwd for `singularity-flow doctor --json` and `singularity-flow state planes --json`. Refuse without selection; no home/parent fallback. Show authority, revision, pending publication, ledger/outbox and affected paths.
9. Start read-only. For approved repair, run the narrowest deterministic command. Factory reset requires its own preview and exact confirmation.
