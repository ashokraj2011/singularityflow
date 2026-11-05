# Spec Studio implementation and qualification

This branch implements the core **Write together** experience described in [SPEC-SPA v1.4](SPEC-SPA-v1.4-SPEC-STUDIO.md). The [user guide](SPEC-STUDIO.md) describes its supported operations. This is a working vertical slice, not a claim that every v1.4 acceptance criterion or the product’s 1.0 release gate is complete.

## Delivered

- Continuous rich-text/Markdown editing, optional title and generated identity, business/technical classification, local autosave, keyboard saving and earlier wording restoration.
- Unreviewed shared checkpoints on the selected state branch, quiet-period scheduling, per-library throttling, explicit refresh and sync, lost-acknowledgement reconciliation and concurrent-writer recovery.
- Local files and images, links, selected code and exact reviewed specification sources. Shared records carry descriptors and hashes. Another laptop can restore matching originals without recreating the specification or changing its reviewed version.
- Focused Copilot proposals that preserve unrelated edits, explicit person acceptance, parent decisions and source readers with bounded line/character continuation. The native image-part integration is conditional on the host API.
- Derivation from one or more exact reviewed parents, explicit business coverage, Story intake handoff and relevant inherited business constraints/acceptance. Existing allocation, split, usage, signing and current-phase repair services remain in use.
- Exact-sequence review, saving during review/publication, and publication acknowledgement that leaves newer writing as unpublished draft changes. Existing v1 draft and reviewed revision bytes are retained.
- A private, rebuildable snapshot index for current-draft reads and autosave. Operation retries verify their original snapshot; missing, torn or stale indices fall back to immutable history. Explicit history and backup readers still inspect saved versions.

## macOS qualification

Qualification uses isolated repositories, local bare remotes and mocked VS Code/Copilot hosts. It does not spend model quota or change real Stories. Final results are combined by test name across the consolidated run and affected-file follow-up; repeated tests count once.

| Area | Cases |
| --- | ---: |
| Snapshot index, crash recovery and original save evidence | 5 |
| Write together services, sources, derivation, takeover, phase delivery and publication concurrency | 18 |
| VS Code Studio, saving, human review, repository binding and recovery | 19 |
| Bounded source/prose/metadata readers | 3 |
| Shared CLI read scheduling and nonblocking draft sync | 6 |
| Existing specification library | 11 |
| Existing proposal validation and acceptance | 6 |
| Story slices, prompts and retained coverage | 10 |
| Existing split/allocation and backup journeys | 10 |
| VS Code split integration | 2 |
| Workspace schema audit | 7 |

The document-source test exercises specification, planning, implementation, convergence, verification, release and a custom phase through the common document reader and phase-offering rule. This is reader-contract coverage, not seven live model-driven Story journeys.

Additional document/local-handoff regressions recorded 48 passes and one Windows-only skip on macOS. That skip is disclosed; these results do not satisfy a release policy requiring zero skipped tests.

The explicit browser check passes rich/Markdown round trips, escaping, editing metadata, save acknowledgements, sharing error/retry display, creation routing and light/dark/320 px layouts. VS Code typechecking, VS Code compilation, the CLI bundle build and repository checks also pass.

The refresh from main through `d30c79f59` additionally qualified 119 distinct macOS integration cases across the Studio, workspace intake, compact agent output and skill contracts. Two stale upstream skill assertions were updated to the current single-packet approval flow and reduced token count. The two agent-output slow-lane cases were explicitly run and passed; the final combined integration results have no failed or skipped cases. This is targeted integration qualification, not the full release suite.

Reproduce the principal suite:

```sh
node --test --test-concurrency=2 \
  test/spec-studio-draft-index.test.mjs \
  test/spec-studio-write-together.test.mjs \
  test/spec-studio-reader.test.mjs \
  test/vscode-spec-studio.test.mjs \
  test/vscode-shared-reads.test.mjs \
  test/spec-library.test.mjs \
  test/spec-proposals.test.mjs \
  test/spec-slices.test.mjs \
  test/spec-split.test.mjs \
  test/vscode-spec-studio-split.test.mjs \
  test/schema-upgrade-all.test.mjs
```

## Local storage measurement

On macOS with Node 26.12.0, 100 saved versions of a 104,000-byte document were read 12 times through each API after setup. Median full-history reading took **34.20 ms**; indexed current-snapshot reading took **0.71 ms**. The index removes historical document reads from the ordinary save/status path. This is a local storage measurement, not cold-machine, installed CLI, Windows or end-to-end Copilot latency.

## Remaining qualification and v1.4 scope

Native Windows and paid/live Copilot runs were not requested and were not run. Native host attachment delivery, accessibility and cold/warm end-to-end latency still need host qualification.

After integrating main through `d30c79f59`, all configured VS Code bundle budgets pass. Main contains the gateway dependency changes and its documented 826-module ceiling; the merged build contains 826 gateway modules. The Studio and native tool bundles remain within their existing limits. The earlier 817-module budget failure is resolved by those upstream changes.

Broader v1.4 work remains: provisional derivation from an unreviewed parent, semantic parent-change impact across descendants, the five-stage evidence rollup, Goal/Initiative linking, and cross-repository shared-contract/overall-outcome authoring. Existing split and usage coverage is retained, but does not establish those broader acceptance criteria.
