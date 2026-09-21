---
name: sflow-workflows
description: List, compare, simulate, install, export, import, or duplicate governed Singularity Flow workflows.
disable-model-invocation: true
argument-hint: "[list|simulate ID|diff ID|export --workflow ID... --out FILE|import FILE|copy SOURCE TARGET --label TEXT]"

---
# Workflow catalog, transfer, and duplication

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Run `singularity-flow workflow $ARGUMENTS`. Default to `list` when no action is supplied.

For packaged installation, run simulation, diff, and `--dry-run`; show affected YAML/Markdown.
Never use `--replace` without explicit confirmation or commit configuration automatically.

For portable workflow bundles:

1. Export only explicitly named workflows. Use one `--workflow <ID>` for each selection and require
   a new output path: `singularity-flow workflow export --workflow <ID> [--workflow <ID>...] --out <FILE> --json`.
   Report the selected workflows and complete dependency closure returned by the CLI, including
   exact remote-agent locks. Repository policy and installed World Model contracts are validated
   prerequisites, not imported objects. Never hand-edit the bundle.
2. Import is a two-step governed mutation. First run exactly
   `singularity-flow workflow import <FILE> --dry-run --propose --json`. Show the plan SHA-256,
   dependencies, changed paths, reuse, and collisions. A skill invocation is not confirmation.
3. After the user explicitly accepts that exact plan, run
   `singularity-flow workflow import <FILE> --confirm <PLAN-SHA256> --propose --json` once. Never
   substitute a digest, overwrite a collision, or retry a stale plan without a new preview. Preserve
   whether the CLI created a proposal or a local authority edit.

For duplication:

1. `singularity-flow workflow duplicate` is an alias of `singularity-flow workflow copy`. Copy
   requires a distinct lower-kebab target ID and explicit display label. Preview with
   `singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label <TEXT> --dry-run --propose --json`.
   Use a qualified source whenever Story and Initiative catalogs share the same ID.
2. This release makes a **linked copy**: it preserves the complete workflow record under the new ID
   while reusing all dependencies. State that later shared-dependency edits can affect both workflows.
   Do not claim dependencies were isolated.
3. Show the exact copy plan and collisions and wait for explicit confirmation. Then run
   `singularity-flow workflow copy <[story|initiative:]SOURCE> <TARGET> --label <TEXT> --confirm <PLAN-SHA256> --propose --json`
   once. Never overwrite an existing target, bypass review, commit, activate, merge, or refresh the
   workspace automatically.

For every action, relay the CLI's exact validation result, proposal branch or local-authority
status, changed files, warnings, and next commands. Stop on any missing dependency, collision,
stale plan, invalid bundle, or configuration-authority refusal.
