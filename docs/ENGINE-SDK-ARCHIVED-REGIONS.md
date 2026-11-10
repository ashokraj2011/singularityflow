# Implementation regions from accepted source archives

The optional namespace engine can reconstruct exact changed-line regions without a Git checkout.
It combines an independently approved plan with accepted original and generation source archives,
then drives the existing shared implementation-binding rules. Native Git execution keeps its
original patch reader, binding results and authority.

## Explicit query contract

```js
await engine.run('phase.delivery.inspect', {
  workId: 'example-story',
  phaseId: 'build',
  includeImplementation: true,
  maximumEntries: 100
});
```

The optional boolean requests `sflow-delivery-evidence-inspection/v5`. Its implementation section
uses `sflow-implementation-region-observations/v1`. The registry remains the only operation entry;
the source inventory query cannot silently acquire this capability. An older port returns an
explicit missing-reader error. Omitting the flag preserves the existing v1–v4 profiles and avoids
the additional source comparison.

Each observed repository reports a digest of the complete shared binding result, complete binding,
region, hunk, symbol and problem counts, and a bounded metadata preview. Previews include the
clause explanation and region path, change type, hunk count and symbol assurance. They contain no
source body. Display limits do not reduce complete counts or turn incomplete evidence into success.

Missing explanations produce a registered author-repair action that preserves the current draft.
Missing original bytes retain the existing baseline-retention action. Missing line-origin proof,
repository ownership, unsupported binary text and exhausted comparison bounds remain explicit
required owners. Permission, missing-content and timeout errors propagate from their actual reader.

## Ownership and proof

- The kernel owns the bounded Myers line comparison over explicit text. The public `changes`
  package exports `sourceTextHunks`, its versioned profile and fixed maximum limits. Limits may
  be lowered, not raised. Line endings, final-newline differences and Unicode remain exact.
- The namespace source-patch reader authenticates original accepted baseline and generation
  records, verifies original/current manifests and content chunks, and reconstructs text from
  the retained bytes. Its issued context is private to one invocation. Final index checks reject
  moved evidence. It does not read a working checkout or invoke Git.
- The implementation-region reader supplies exact diff and source facts to the existing shared
  implementation-binding generator. It does not redefine explanation, symbol or binding rules.
- The SDK validates the versioned manifest and returns registered actions with arguments and
  prerequisites. Presentation and command rendering stay with the host.

Canonical source snapshots describe additions, modifications and deletions. This contract does
not infer renames or claim Git's choice of alignment for ambiguous repeated lines. The bounded
text comparison gives a deterministic minimum-edit alignment; native Git patch semantics remain
unchanged. Exceeding a comparison bound never falls back to treating the entire file as changed.

## Qualification and remaining work

The focused Mac fixtures exercise actual filesystem, SQLite and application stores, original
independent plan approval, retained bytes, replay after checkout removal, private-context rejection,
fresh index checks, unchanged default manifests, real permission/deadline errors and explicit
repair owners. An independent minimum-edit oracle covers 800 repeated-line cases; local Git
zero-context patches provide a separate coordinate check for unambiguous edits. Installed SDK
consumers cover pure imports with infrastructure blocked, NodeNext typing and repository-qualified
region inspection after moving to another checkout.

Mac qualification covers 209 distinct affected tests: 173 core/namespace/native cases, 33 installed
SDK checks and three installed source-portability checks. After correcting pending-owner validation,
all five region tests and four bounded-comparison tests passed again; repeated cases count once.
The source validator, VS Code types, Git ownership audit and all 13 existing bundle ceilings passed.
The SDK retains 61 operations across 224 owned modules; gateway remains within 852/852 modules.
Windows, live providers, production installation and installed-project cutover were not exercised.

These are source observations. They do not authorize publication, establish acceptance, execute
tests or record human approval. Full namespace application publication and its remaining policy
owners, complete cross-agent application Stories, native rule/query extraction, installed-project
migration/cutover and final performance/distribution qualification remain open in Phases 5, 7, 8
and 9 of the migration plan.
