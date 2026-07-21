# Migrating to Singularity Flow 0.5.0

## From 0.4.0

Run `singularity-flow wm init` on the base branch and commit `.sdlc/worldmodel.json` plus `.sdlc/prompts/worldmodel-builder.md`. Version 0.5 adds `wm build`, `wm context`, `wm prompt`, and `wm check`; existing work-item state remains compatible. Phase skills now require their routed grounding context before producing artifacts.

## From 0.3.0

Repository work-item data remains compatible. Version 0.4 adds an optional `governance` object to `.sdlc/config.json`, the `singularity-flow gate` command, authenticated GitHub approval provenance, approval-cascade hashes, and example approval/validation workflows. Existing local approvals remain valid when `requireGithubApprovals` is false. Enable governed mode only after configuring role-to-GitHub-username mappings and installing both example workflows.

The product, npm package, executable, Copilot plugin, skill namespace, environment variables, and examples have been renamed consistently.

## Replace the global package

```bash
npm uninstall --global @your-company/flowpilot
npm install --global ./your-company-singularity-flow-0.5.0.tgz
```

## Replace the personal Copilot plugin

```bash
copilot plugin uninstall flowpilot
singularity-flow plugin install --force
```

## Command changes

```text
flowpilot ...                 -> singularity-flow ...
                              -> sflow ...        (short alias)
/flowpilot:start              -> /singularity-flow:start
/flowpilot:approve            -> /singularity-flow:approve
```

## Environment-variable changes

```text
FLOWPILOT_DEBUG                         -> SINGULARITY_FLOW_DEBUG
FLOWPILOT_JIRA_ACCEPTANCE_FIELD         -> SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD
FLOWPILOT_JIRA_STORY_POINTS_FIELD       -> SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD
FLOWPILOT_JIRA_SPRINT_FIELD             -> SINGULARITY_FLOW_JIRA_SPRINT_FIELD
FLOWPILOT_JIRA_EXTRA_FIELDS             -> SINGULARITY_FLOW_JIRA_EXTRA_FIELDS
```

The repository workflow format remains under `.sdlc/`, so existing work-item state and artifacts do not require migration.
