# Reusable instructions

Instructions are named, reusable Markdown definitions, separate from an agent's role and a skill's procedure. Open **Configuration → Instructions** in VS Code to create, edit, inspect usage or remove a definition. In **Skills**, select its reusable instructions. Changes use the same exact configuration preview, human review and activation path as workflow and agent changes.

Each definition lives at `singularity/instruction-library/<id>/INSTRUCTIONS.md`:

```markdown
---
name: web-conventions
description: Conventions for accessible local web changes.
metadata:
  sflow-label: Web conventions
---

Use semantic controls with accessible names. Preserve keyboard interaction.
Keep network and persistence changes explicit in the implementation summary.
```

A catalog skill references definitions by their exact lower-case IDs:

```markdown
---
name: web-review
description: Review a web change before publication.
metadata:
  sflow-instructions:
    - web-conventions
---

Review the changed controls against the referenced conventions. Report findings.
```

## Scope and prompt injection

A definition is **not** automatically applied globally and is not a VS Code `applyTo` instruction. Only an active attached skill selects it. Workflow attachments apply only to the selected workflow's declared phases; agent attachments follow that agent in their declared phases. Instructions shared by active skills are rendered once, with their identity, exact hash and owning skills. The skill retains its use condition; instructions cannot override workflow policy, permissions, tests or human approval.

Eager skills include their definitions in the prompt. Explicitly on-demand skills retain them in the Story snapshot and return them with verified skill expansion, rather than loading them eagerly. Do not defer mandatory safety or policy guidance.

Story intake pins both the skill and referenced definitions in the verified snapshot. Later catalog edits or deletion cannot silently change a running Story. No live lookup or network substitution is permitted during retained execution. New Stories use the reviewed configuration current when they start.

## Commands

```sh
singularity-flow instruction list --json
singularity-flow instruction show web-conventions --json
singularity-flow instruction create web-conventions --description 'Accessible web conventions' --from ./web-conventions.md --dry-run --json
singularity-flow skill edit web-review --instruction-refs web-conventions --dry-run --json
```

`--from` imports the body from an explicitly named regular local file. Use `--propose` after reviewing the preview to create a configuration proposal; creation is not approval. `/sf-instructions` provides the guided Copilot route. Clear references with `singularity-flow skill edit web-review --instruction-refs '' --dry-run --json` before removing a definition. The Studio permits an explicit reference edit and removal in one atomic proposal.

`@sflow /instructions` lists the catalog in VS Code without calling a model. It is read-only; authoring and approval remain separate reviewed actions.

Catalog listing returns names, purposes, references and hashes, not every definition's body. Use `instruction show <ID>` to read one definition when needed.

## Transfer and validation

Workflow v8 export carries only the exact instruction definitions referenced by included catalog skills. Import and independent duplication show instruction identities alongside agents and skills, validate collisions and rewrite skill references when definitions are renamed. Linked copies intentionally share definitions. Missing, extra, malformed, conflicting or tampered definitions are refused with a named finding; repair configuration or references, never generated snapshots. Historical bundles without references remain readable.

Definitions are bounded to 64 KiB; each skill may reference up to 32 unique IDs. IDs are not paths or URLs. Definitions cannot recursively reference other definitions. A remote catalog `SKILL.md` may carry these references, but the definitions must also exist in approved configuration (or arrive in its workflow bundle). Arbitrary remote agent Markdown dependencies do not gain implicit catalog references.
