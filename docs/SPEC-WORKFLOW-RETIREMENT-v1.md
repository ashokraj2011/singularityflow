# Archiving and deleting workflows (WRT) — v1

Status: owner request 2026-10-21 ("a way to delete a workflow and its dependencies if they are not
referred to in other workflows", "and archive also"). The recommended answers below are the defaults
being built.

A repository gathers workflows nobody uses any more: experiments, team imports that were replaced,
and seeded workflows a team never runs. Today a workflow can be created, edited, copied, duplicated,
exported and imported, but not retired. Workflow Studio offers only Edit and Duplicate for a
published workflow.

## Two ways to retire a workflow

| | Archive | Delete |
|---|---|---|
| The workflow's definition | kept, unchanged | removed |
| Its dependencies | kept | removed when no other workflow uses them |
| New Stories | cannot choose it | cannot choose it |
| Stories already using it | keep running | keep running from their pinned workflow copy |
| Seeded workflows | allowed | refused (`SEEDED_WORKFLOW_READ_ONLY`) |
| Undo | `workflow restore` | `workflow import` of the backup bundle saved before the delete |
| How it lands | a reviewed configuration proposal | a reviewed configuration proposal |

Archiving is the usual first step: archive now, and delete later once nothing needs it.

## Archive

- **Commands.**
  - `singularity-flow workflow archive <[story|initiative:]ID> [--reason TEXT] [--propose] [--json]`
  - `singularity-flow workflow restore <[story|initiative:]ID> [--propose] [--json]`
- **Storage: a new file, `singularity/workflow-archive.yml`.**
  - Shape: `{ version: 1, archived: { story: { <id>: { reason } }, initiative: { … } } }`.
  - `workflow.yml` is not changed, because older engines refuse unknown keys there. An engine that
    does not know this file keeps working and still offers the workflow.
  - The file is configuration: it is reviewed, activated and read from the approved configuration
    like `workflow.yml`.
- **What archiving changes.**
  - Story creation (`createWorkflow`) refuses an archived workflow for a new Story with
    `WORKFLOW_ARCHIVED`, naming `workflow restore`. This is the only check; a running Story never
    passes through it again.
  - Workflow lists mark it `archived` and leave it out of new-Story choices: `workflow list`, the
    start and intake choices, the catalog, Workflow Studio, VS Code intake favourites and Copilot
    listings.
  - Nothing else changes. Its dependencies stay, and it still counts as a user of them, so a delete
    elsewhere never removes something an archived workflow needs.
- **Refusals.**
  - Archiving the repository's default workflow (`delivery.defaultWorkflowProfile`) is refused
    unless `--new-default <ID>` names a live replacement.
  - Archiving the last live Story workflow is refused.

## Delete

- **Commands.**
  - Preview: `singularity-flow workflow delete <[story|initiative:]ID> --dry-run [--new-default ID] [--json]`
  - Confirm: `singularity-flow workflow delete <ID> --confirm <PLAN-SHA256> [--new-default ID] [--propose] [--json]`
  - This follows `workflow copy`/`duplicate`. The preview's digest binds the exact removal; a changed
    configuration needs a new preview.

### What is removed

Let `T` be the dependency closure of the workflow being deleted, and `K` the union of the closures
of every other Story and Epic workflow, archived ones included. Both use export's closure
(`buildBundle`): steps, Epic steps, artifact sets, approval groups, MCP servers, templates and
template files, integration targets, applicability policies, agents, skills, instructions,
vendored imports, MCP descriptors, compiled skill packages and lock rows.

1. **The workflow itself**, with its overrides and its own `attachments.yml` rows.
2. **Each object in `T` that is not in `K`.** It is removed unless one of these keeps it:
   - it is seeded-protected (`seededWorkflowProtection`);
   - it is a canonical Epic step or a compiled skill step;
   - it is a built-in or plugin agent (not a repository file);
   - it is the shared default constitution (`singularity/constitution.md`).
3. **References outside workflows to removed steps:**
   - `mcpServers[].phases` and `documents.allowedPhases` entries;
   - `contextPolicy.phaseOverrides` keys;
   - `attachments.yml` rows;
   - agent step lists and attached-skill rows, trimmed with the same logic export uses
     (`phaseScopedAgentText`). An agent still used elsewhere is trimmed, never deleted.
4. **References to the workflow itself:** impact `eligibility.workTypes` entries and its archive entry.
   If it is the default workflow, `--new-default <ID>` must name a live replacement; otherwise the
   delete is refused.

If another workflow's closure cannot be read (a broken workflow), the delete still removes the
workflow, but keeps all of its dependencies. The preview names the workflow that could not be read.

### Never deleted

- seeded workflows and their shared dependencies;
- canonical Epic steps;
- built-in and plugin agents;
- the last Story workflow;
- anything another workflow, archived or not, still uses.

### Stories

- Stories that use the workflow and carry a pinned workflow copy (`workflowSnapshot`) keep running.
  The preview lists them as information.
- An unfinished Story with no pinned copy still runs from the live configuration, so the delete is
  refused while one uses the workflow (`WORKFLOW_DELETE_STORIES_UNPINNED`). The refusal lists those
  Stories; finishing or cancelling them clears it.
- Stories are found from the ledger's Story index (`workType` and `status`). A Story's pinned copy is
  read from its `workflow.json` at its recorded commit.

### Before anything changes

- **Backup.** A complete export bundle of the workflow (`exportWorkflowBundle`) is written to
  machine-local state, and its path is shown. `workflow import <bundle>` brings it back.
- **Validation.** The proposal is validated with the deletions applied
  (`validateEditorConfiguration` on the proposal's own tree), so a dangling reference fails before
  review.
- **The preview shows:** removed objects by kind and path; kept objects and which workflow still uses
  each; trimmed agents and the steps they lose; cleaned references; affected Stories; the backup path;
  and the plan digest.

## Surfaces

- **CLI:** the three commands above.
- **VS Code, Workflow Studio:**
  - each workflow card gets **Archive** or **Restore**, and, on workflows that are not seeded,
    **Delete…**;
  - **Delete…** opens a review page with the preview above and one **Propose deletion** button;
  - an **Archived** filter shows archived workflows;
  - intake and favourites hide them.
- **Copilot (`/sf-workflows`):** may archive or restore (a reviewed proposal), and may preview a
  delete. Confirming a delete is the person's own step, in VS Code or their terminal; the guard
  refuses `workflow delete --confirm` in any agent turn.

## Acceptance tests

1. **Shared dependencies.**
   - Delete removes a workflow's own steps, agents, skills, instructions and templates.
   - It keeps those another workflow uses, and the preview names that workflow.
2. **Archived workflows count as users.** A dependency used only by an archived workflow is kept.
3. **Seeded and protected objects.**
   - Deleting a seeded workflow is refused.
   - Deleting a duplicate of one keeps every seeded dependency.
   - Canonical Epic steps and built-in agents are never removed.
4. **Shared agents are trimmed.** An agent shared with another workflow loses only the removed steps,
   and its attached-skill rows for them.
5. **Outside references are cleaned:** MCP server steps, document `allowedPhases`, context overrides,
   attachment rows and impact eligibility. The result passes `validateEditorConfiguration`.
6. **Default and last workflow.**
   - The default workflow needs `--new-default`.
   - The last Story workflow is refused.
7. **Stories.**
   - A pinned Story is listed and keeps running after the delete is activated.
   - An unfinished unpinned Story blocks the delete.
8. **The digest binds the plan.** A changed configuration after the preview refuses `--confirm` with
   the stale digest.
9. **The backup round-trips.** The bundle exists before the proposal, and importing it into the
   deleted state restores the workflow.
10. **Archive.**
    - New Stories cannot choose an archived workflow; a running Story still advances.
    - `restore` brings it back.
    - An older engine reading the configuration is unaffected.
11. **Copilot.** `/sf-workflows` may preview a delete; `workflow delete --confirm` is refused in an
    agent turn.
12. **Real VS Code.** Archive, restore and Delete… on a Workflow Studio card, with the review page.
