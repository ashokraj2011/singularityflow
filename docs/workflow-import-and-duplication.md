# Importing and duplicating workflows

In VS Code, open **Configuration → Workflow Studio**. Use **Import** to select a workflow bundle, or **Duplicate** on an existing Story or Epic workflow.

The review screen shows:

1. Every included agent, its attached skills and remote resources.
2. Library skills, agent-scoped remote skills and compiled skill packages.
3. Source and destination identities for workflows, agents, skills and other editable configuration objects.
4. The exact proposed operations, changed paths and confirmation digest.

Existing identities receive unused suggestions. Edit the destination IDs, then choose **Validate names and preview**. Collisions and invalid names prevent applying the plan. Editing a name invalidates the previous preview. Confirmation applies only the exact reviewed plan; a changed destination requires another preview.

Import does not automatically overwrite existing objects. Workflow references, agent attachments, native Copilot names, dependency locks and import provenance follow the renamed identities. Selected integration target declarations travel in the bundle; credentials do not.

**New workflow** starts a blank workflow. It does not select or customize an existing one. Framework-seeded workflows and their shared dependencies are read-only in the authoring UI and APIs. Use **Duplicate** to customize a copy; people in approval groups remain configurable.

Duplication creates independent editable dependencies. Agent-scoped remote skill identities follow their renamed parent agent; the identity table shows the resulting scope. Canonical Epic step IDs and compiled skill contracts cannot be renamed. The screen labels them read-only. Canonical Epic copies use workflow-local agent and output overrides, leaving the original step and workflow untouched. Their output identities remain fixed. Compiled skill packages retain their verified package identity and execution restrictions.

CLI equivalents:

```sh
singularity-flow workflow export --workflow story:feature --out workflows.json
singularity-flow workflow import workflows.json --resolve-all suggested --dry-run --json
singularity-flow workflow duplicate story:feature my-feature --label 'My feature' --dry-run --json
```

Use repeatable `--resolve agent:OLD=rename:NEW` or `--resolve skill:OLD=rename:NEW` options for explicit identities. Apply with the same choices and `--confirm PLAN-SHA256`; use `--propose` when changing the shared configuration authority. `workflow copy` remains the explicitly linked-copy operation; it is not the Studio's independent Duplicate action.
