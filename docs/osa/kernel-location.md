# OSA Stage 0 — where the decision owner lives

**Specification:** [SPEC-OSA v1.1](../SPEC-OSA-ONE-STEP-AUTHOR-v1.1.md) §3, REQ-001, AC-009 and AC-022.
**Decision:** `src/kernel/`, with `src/kernel/step-state.mjs` as its one entry.

## The choice

| Item | Choice |
|---|---|
| Folder | `src/kernel/` (new) |
| Entry | `src/kernel/step-state.mjs`. It exports `stepState(snapshot)`, the section 4.3 predicates and the version arithmetic. |
| Optional second file | `src/kernel/step-contract.mjs`, holding the `StepSnapshot/v1` and `StepDecision/v1` shapes, their bounds, reason codes and action identifiers. |
| Imports allowed | Only modules under `src/kernel/`. No `node:` module and nothing outside the folder. |
| Errors | Returned as data (an `invalid` decision with its reason code and basis). Never thrown through `util.mjs`'s `SingularityFlowError`, because that would bring `util.mjs` into the closure. |
| Who imports whom | Existing modules import the kernel. The kernel imports none of them. |

Stage 1 should keep to one or two files. The kernel must enter the eager closures without adding files (see the last section).

## Why not reuse the existing predicate modules

| Module | What it holds | Why the kernel cannot import it |
|---|---|---|
| `src/phase-generation-need.mjs` | `stepBeingWritten`, `phaseNeedsGeneration`, `successorGenerationOpen` | It imports `source-review-policy.mjs`, which imports `util.mjs` |
| `src/phase-generation.mjs` | `nextPhaseGeneration`, `consumedByPublishedGeneration` | It imports `util.mjs` |
| `src/code-delivery-policy.mjs` | the skill choosers, `phaseKernelOwned`, `opensCodeVersion` | It reaches much more |

`util.mjs` imports `node:child_process` and `node:fs/promises`, and it is a registered process owner in `scripts/git-bypass-audit.mjs`. Stage 0 walked the closures: both `phase-generation-need.mjs` and `phase-generation.mjs` reach `util.mjs`, `platform-process.mjs` and `git-fact-cache.mjs`.

A kernel that imported any of these modules would break AC-009 ("The kernel dependency closure has no host I/O …").

So the dependency runs the other way: the predicate code moves into the kernel. The old names become exact wrappers in their old modules (plan §7, "exact predicate delegates"), and the facts they read today become snapshot fields. For example, `sourceReviewAuthorConflict` becomes a fact the adapter supplies.

## Why a folder, and this one

1. **The repository already groups modules by domain in sub-folders.** Examples: `src/sda/`, `src/presence/`, `src/verification/`, `src/scope/`, `src/vocabularies/`, `src/findings/`. `src/kernel/` follows that layout, and "kernel" is the spec's own word (section 3).
2. **The closure rule can be checked by path.** AC-009 and the AC-020 dependency ratchet become one test, which Stage 1 adds:
   - every file under `src/kernel/` imports only `./` siblings;
   - no file outside the folder is imported;
   - no `node:` specifier is used.

   A flat `src/step-state.mjs`, as in v1, would need a hand-kept list instead.
3. **It is invisible to the storage inventories.** A pure module has no Git or file-write site. `scripts/sda-inventory.mjs` therefore does not list it, so it needs no SDA class. `scripts/git-bypass-audit.mjs` finds no process site in it.
4. **It is invisible to the plain-language check.** The kernel returns no person-facing words (REQ-021: no shell strings, skill names, question wording or prompts), so `scripts/plain-language-check.mjs` has nothing in it to baseline.

## Bundle families (`scripts/build-cold-cli-bundle.mjs` FAMILIES)

The first family that statically reaches a module claims its chunk. Today the predicates the kernel absorbs land in `cold-core.mjs`, the startup chunk:
- `stepBeingWritten`
- `nextPhaseGeneration`
- `generationSkillForPhase`

`deriveMutationContract` lands in `cold-hooks.mjs`.

Stage 1 adds `'kernel/step-state.mjs'` (and its contract file, if there is one) to the **`core`** family list. That pins the chunk instead of leaving it to whichever family happens to reach it first, and it has these effects:
- **The guard:** the dedicated hook bundle `copilot-hook-runtime.mjs` already imports core. The bundled hook keeps its ≤ 16 module files.
- **Entry, nextsteps and session:** they get the kernel from the chunk they already load. No family imports another family's chunk for it.
- **Chunk count:** there is no new chunk, so the ≤ 21 outputs ceiling is untouched.
- **Size:** the pure module is small (estimate: under 30 KB). The CLI cold parse ceiling (< 3 MiB) has room for it.

## The ceilings this has to fit (no raise to pass, AC-022)

Measured at `d7a976821`; see [baseline.md](baseline.md) §4.

| Closure | Files | Bytes |
|---|---|---|
| Session current | 221 of 221 | 4,273,495 of 4,273,500 (main `ea398577f`) |
| Lifecycle handlers | 470 of 473 | 9,688,981 of 9,694,550 |

Every one of those closures already includes `phase-generation-need.mjs`. So the kernel must enter by **moving** code, not adding it:
- the bodies of `stepBeingWritten`, `phaseNeedsGeneration`, `successorGenerationOpen`, `nextPhaseGeneration` and the publication predicates move into `src/kernel/step-state.mjs`;
- importers that only need those predicates switch to the kernel;
- a compatibility wrapper is left only where an importer needs the old symbol and the closure has room;
- session current has no file to spare: a re-export file there would be a 222nd file.

Stage 1's first measurement is therefore the same graph walk on the migrated closures, before any surface moves.

## Alternatives considered

| Option | Why not |
|---|---|
| Grow `src/phase-generation-need.mjs` into the kernel | Its closure reaches `util.mjs`. Its name says "need" where the decision is the whole step state. |
| A flat `src/step-state.mjs` (v1 §4.1) | It works, but the closure rule would need a hand-kept file list instead of a folder rule. |
| A workspace package such as `packages/kernel` | The engine is one package with no workspace setup. A second package would add an install and build path for no closure benefit. |
| Inside `src/sda/` | SDA is the storage-independence layer: adapters and contracts for persistence. The decision owner is policy, not storage, and keeping them apart is the point of section 3. |
