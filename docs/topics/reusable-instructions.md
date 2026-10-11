---
id: reusable-instructions
title: Reusable instructions referenced by skills
aliases:
  - instruction-library
  - instructions
commands:
  - instruction
related:
  - skill-master
  - workflow-authoring
  - importing-assets
version: 4
---

## Purpose and prerequisites

Reusable instructions are named Markdown definitions, separate from an agent's role and a skill's
procedure. Write guidance such as a coding convention once, and let several skills reference it.
Open Configuration → Instructions to create, edit or inspect reusable Markdown guidance.
Definitions are kept at `singularity/instruction-library/<id>/INSTRUCTIONS.md`. In Skills, select
the definitions that skill uses. Preview exact configuration changes and obtain human approval
before activation.

Work in a governed checkout; no Story is required. Definitions are configuration, so every change
uses the same exact preview, human review and activation path as workflow and agent changes.

A definition has front matter and a nonempty Markdown body:

```markdown
---
name: web-conventions
description: Conventions for accessible local web changes.
metadata:
  sflow-label: Web conventions
---

Use semantic controls with accessible names. Preserve keyboard interaction.
```

- `name` is the definition's lower-case kebab-case ID and must match its folder.
- `description` is required, at most 1024 characters.
- `metadata.sflow-label` is an optional display name; without it, the ID is shown as words. No
  other metadata is accepted: instruction references and loading policies belong to skills.

A catalog skill selects definitions by their exact IDs in its own front matter, under
`metadata.sflow-instructions` (a list such as `- web-conventions`).

## Place guidance at a procedure step

In Workflow Studio → Skill master → Edit, position the cursor at the desired step and choose
**Insert at cursor** beside a reusable instruction. This selects its ID and inserts a standalone
placement line. Write the condition immediately before the line; the condition belongs to the
skill procedure, not to the shared definition.

```markdown
---
name: team-web-check
description: Checks supplied UI sources, executes tests and proposes the reviewed route.
metadata:
  sflow-instructions: [demo-source-interpretation, demo-fresh-test-evidence, demo-reviewed-routing]
---

## Establish expected behavior from the supplied documents or screenshots
<!-- sflow-instruction: demo-source-interpretation -->

## Execute the approved tests; compare screenshots only when visual scenarios apply
<!-- sflow-instruction: demo-fresh-test-evidence -->

## Propose pass, repair or blocked from the actual observations
<!-- sflow-instruction: demo-reviewed-routing -->
```

The composer expands each line into the exact pinned definition body, labelled with its ID and
SHA-256. It sends the resulting procedure as part of the active agent's phase prompt; Copilot
does not need another catalog lookup. A shared definition appears once per prompt, with subsequent
placements referring to that retained definition. Selected definitions without placement lines
keep the existing appendix behavior. Placement examples inside fenced code blocks are inert.
Unselected, malformed or duplicate placements refuse configuration validation with
`SKILL_INSTRUCTION_PLACEMENT_INVALID` instead of silently dropping instructions.

`singularity-flow skill show <ID> --json` includes `skill.composedText` as a read-only catalog
preview. Story-bound on-demand retrieval also returns `composedText`, using only the accepted
snapshot, never a later library edit. The source SKILL.md and definition hashes remain separate;
composition does not overwrite either source file. Placed instructions pin the v4 **skill prompt
composer** interpretation; this is independent of the World Model format. Older unplaced snapshots
retain their existing v3 instruction interpretation.

## Seeded demonstration

Choose **Demo — Instruction-composed Test Loop** (`demo-instruction-test-loop`) from the workflow
catalog, or adopt it through `singularity-flow workflow create demo-instruction-test-loop` using
the normal reviewed configuration route. Duplicate the seed to customize its agents, skills or
instructions; seeded definitions remain read-only.

The sequence is Intake → Test → Repair → Test (bounded loop) → Close. A fresh initial pass can
skip Repair and go to Close; unavailable tools/evidence cannot produce pass. Its four custom
`demo-instruction-*` agents physically attach their custom skills. The checker skill composes
three reusable definitions at source interpretation, test execution and route proposal. The
repairer is a different agent, and every repaired revision returns to the independent checker.
Automatic route selection retains human approval checkpoints, including closure; closing reports
preserve repair history and residual risk. No browser service is mandatory: use approved existing
repository commands or an explicitly authorized Playwright/equivalent tool.

Adoption from either the canvas or CLI includes the agents' skills and referenced instructions in
the reviewed configuration change. Repository configuration refresh restores missing packaged
instructions without overwriting customized definitions. Merely updating the installed CLI does
not require an older repository to install this optional demo: new Story snapshots offer compatible
agents for that Story's phases, plus its configured independent reviewer, and retain only applicable
skills. A missing skill actually used by that Story still requires configuration repair.

## Use it from each surface

- **Shell:** `singularity-flow instruction list --json` and `singularity-flow instruction show <ID> --json`
  read the catalog. `instruction create`, `instruction edit` and `instruction remove` change it; each
  accepts `--dry-run` and `--propose`. `singularity-flow skill edit <SKILL-ID> --instruction-refs <ID,ID>`
  connects a skill. Run `singularity-flow instruction --help` for the exact forms in this build.
- **Copilot:** `/sf-instructions` lists or shows definitions and previews create, edit and remove.
  It shows the exact proposed bytes before using the returned configuration-proposal route, and it
  never approves configuration.
- **VS Code:** **Singularity Flow: Reusable Instructions** in the command palette, or
  **Configuration Center → Instructions**, opens Workflow Studio's Instructions view to create, edit,
  inspect usage or remove a definition. In **Skills**, select a skill's reusable instructions. In
  chat, `@sflow /instructions` lists the catalog and its skill references without calling a model;
  it is read-only, and authoring and approval remain separate reviewed actions.

## Scope and prompt injection

These are not global Copilot `applyTo` instructions: an active skill explicitly selects them.
Workflow skills remain workflow-local; agent skills follow their agent. Shared definitions render
once. On-demand skills retrieve their retained definitions only when explicitly expanded. Stories
retain exact accepted bytes, unaffected by later catalog changes.

## Guided workflow

1. Inspect the catalog with `singularity-flow instruction list --json`. It returns names, purposes,
   references and hashes, not every body. `singularity-flow instruction show <ID> --json` reads one
   definition and the skills that use it.
2. Propose a definition with `singularity-flow instruction create <ID> --description <TEXT> --from <FILE> --dry-run --json`.
   `--from` reads the body from an explicitly named regular local file; `--instructions <TEXT>`
   gives it inline instead. Use one or the other, not both.
3. Review the preview, then repeat the command with `--propose` instead of `--dry-run` to create a
   configuration proposal. Creation is not approval.
4. Connect it with `singularity-flow skill edit <SKILL-ID> --instruction-refs <ID,ID> --dry-run --json`,
   then follow that command's reviewed proposal route.
5. An authorized human reviews and approves the configuration proposal. New Stories use the reviewed
   configuration current when they start.

To retire a definition, first clear its references, for example with
`singularity-flow skill edit <SKILL-ID> --instruction-refs '' --dry-run --json`, then preview
`singularity-flow instruction remove <ID> --dry-run --json`.

## State and safety

- Workflow export/import and independent duplication carry and rename definitions with skill
  references. Linked copies share definitions.
- Missing definitions require configuration repair, not live replacement of Story snapshot bytes.
- Definitions cannot grant approvals or override workflow policy.
- Clear references before removal, or include the explicit skill reference edits in the same Studio
  proposal. Removal never silently detaches a definition from the skills that use it.
- Story intake pins the skill and its referenced definitions in the verified snapshot. A later edit
  or deletion cannot change a running Story, and retained execution never looks a definition up live.
- A definition is at most 64 KiB, and a skill may reference at most 32 unique IDs. IDs are not paths
  or URLs, and definitions cannot reference other definitions.

## Troubleshooting

- **`INSTRUCTION_UNKNOWN`** from `show`, or **`STUDIO_INSTRUCTION_ID_INVALID`** from `edit` or
  `remove` ("does not exist"): check the ID with `singularity-flow instruction list --json`. From
  `create`, the same code means the ID already exists or has a leftover file to repair.
- **`INSTRUCTION_REFERENCE_MISSING`**: a skill references a definition that is not in the catalog.
  Create it, or remove the reference through configuration review. Never edit generated snapshots.
- **`INSTRUCTION_REFERENCES_INVALID`**: a skill's `sflow-instructions` list has more than 32 IDs,
  duplicates, or entries that are not lower-case IDs (such as paths or URLs).
- **`INSTRUCTION_LIBRARY_INVALID`**: a definition's front matter is wrong, for example a `name` that
  does not match its folder, a missing description or extra metadata. `instruction list` reports
  definitions that fail to load under `problems`.
- **`INSTRUCTION_REQUEST_INVALID`**: the ID is not lower-case kebab-case, an option is not supported
  by that form, or both `--from` and `--instructions` were given.
- `--from` refuses symbolic links, non-regular files, files over 64 KiB and text that is not UTF-8.
- If a Copilot or VS Code action is unavailable, use the CLI form above; do not guess a command from
  the label.

## Related topics

Continue with `sflow explain skill-master`, `sflow explain workflow-authoring`, `sflow explain importing-assets`.
