# Importing and duplicating workflows

In VS Code, open **Configuration → Workflow Studio**. Use **Import** to select a workflow bundle, or **Duplicate** on an existing Story or Epic workflow.

The review screen shows:

1. Every included agent, its attached skills and remote resources.
2. Library skills, agent-scoped remote skills and compiled skill packages.
3. Source and destination identities for workflows, agents, skills and other editable configuration objects.
4. The exact proposed operations, changed paths and confirmation digest.

Existing identities receive unused suggestions. Edit the destination IDs, then choose **Validate names and preview**. Collisions and invalid names prevent applying the plan. Editing a name invalidates the previous preview. Confirmation applies only the exact reviewed plan; a changed destination requires another preview.

Import does not automatically overwrite existing objects. An agent or MCP server that differs from this repository's own only by steps the import adds (for a server, also agents it adds) is reused, and those are added to it, as Workflow Studio does when a new step is assigned to it: the preview says "Reuses agent qa and adds testing-report, test-gaps to it". The agent keeps every step it has here, so a shipped agent can draft a new step imported from another repository. Workflow references, agent attachments, native Copilot names, dependency locks and import provenance follow the renamed identities. Selected integration target declarations travel in the bundle; credentials do not.

**New workflow** starts a blank workflow. It does not select or customize an existing one. Framework-seeded workflows and their shared dependencies are read-only in the authoring UI and APIs. Use **Duplicate** to customize a copy; people in approval groups remain configurable.

Duplication creates independent editable dependencies. Agent-scoped remote skill identities follow their renamed parent agent; the identity table shows the resulting scope. Canonical Epic step IDs and compiled skill contracts cannot be renamed. The screen labels them read-only. Canonical Epic copies use workflow-local agent and output overrides, leaving the original step and workflow untouched. Their output identities remain fixed. Compiled skill packages retain their verified package identity and execution restrictions.

CLI equivalents:

```sh
singularity-flow workflow export --workflow story:feature --out workflows.json
singularity-flow workflow import workflows.json --resolve-all suggested --dry-run --json
singularity-flow workflow duplicate story:feature my-feature --label 'My feature' --dry-run --json
```

Use repeatable `--resolve agent:OLD=rename:NEW` or `--resolve skill:OLD=rename:NEW` options for explicit identities. Apply with the same choices and `--confirm PLAN-SHA256`; use `--propose` when changing the shared configuration authority. `workflow copy` remains the explicitly linked-copy operation; it is not the Studio's independent Duplicate action.

## Archiving and deleting workflows

A workflow nobody uses any more can be archived or deleted. Both are configuration proposals that
the configuration reviewers activate, like any other workflow change.

**Archive** keeps the workflow and everything it uses, unchanged. New Stories are no longer offered
it: it is left out of intake, the workflow catalog and favourites, and Workflow Studio shows it under
**Archived**. Stories already using it keep running. Seeded workflows can be archived.

```bash
singularity-flow workflow archive <ID> --reason "Replaced by the release workflow" --propose
singularity-flow workflow restore <ID> --propose
```

**Delete** removes the workflow and each dependency that no other workflow uses, archived ones
included: its own steps, agents, skills, instructions, templates, MCP servers, integration targets
and imported copies. An agent shared with another workflow keeps its other steps. Settings that name
a removed step are cleaned. Seeded workflows, built-in agents, canonical Epic steps, approval groups
and anything another workflow still uses are never removed.

```bash
singularity-flow workflow delete <ID> --dry-run --json
singularity-flow workflow delete <ID> --confirm <PLAN-SHA256> --propose
```

The preview lists what is removed, what is kept and which workflow still uses it, and the Stories
that use the workflow. A Story with a pinned workflow copy keeps running. An unfinished Story without
one blocks the delete; finish or cancel it, or archive the workflow instead. Before the proposal is
made, a complete export bundle of the workflow is saved on this machine and its path is shown;
`singularity-flow workflow import <BUNDLE> --dry-run` brings it back. If the repository's default
workflow is archived or deleted, `--new-default <ID>` names its replacement.

In VS Code, each workflow card in Workflow Studio has **Archive** or **Restore**, and **Delete…** on
workflows that are not seeded. **Delete…** opens the same preview as a review page. Copilot may
archive, restore and preview a delete; confirming a delete is always the person's own step.
