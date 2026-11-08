# Specification semantics in the engine

Specification configuration and phase-role rules now have pure kernel owners. The workflow
compiler binds them directly instead of accepting native callbacks, reducing its explicit
composition from fourteen entries to nine. This continues portable configuration admission;
it does not create, approve or migrate a namespace-backed workflow or Story.

## Ownership

`kernel/specification-policy.mjs` owns quality-policy normalization, witnessed-clause settings
and whether an already-admitted phase defines requirements. Its primary-output rule uses the
same binding header, exact artifact path/kind, required flag and declared role as before.
Missing historical artifact kinds remain readable as requirement producers; evidence/findings
outputs do not silently become normative requirements.

`kernel/skill-binding-header.mjs` owns the closed header shape, parser/compiler versions and
digest syntax. Both native skill compilation and the kernel phase-role reader use these exact
functions. A supported header is not proof of a correct compilation, retained package, catalog
provenance or human authority. The complete configured-phase reader still checks those compiled
policy/reference hashes and bindings through its existing native owner. WCA/package admission
and lifecycle approval remain separate.

The two existing phase-semantics profiles belong to `kernel/phase-policy.mjs`. Their values and
all reader meanings are unchanged. Existing native modules reexport the same function and
constant identities; production callers can use the pure owner without document/package I/O.

The default checklist ID has one policy owner. Its six questions remain with the existing
checklist/content owner, so kernel validation does not depend on human or model prompt prose.
The complete checklist, normalized policy bytes and their existing hashes remain unchanged.

## Compatibility and remaining work

Before production edits, the baseline at `5234c0edd` captures 74 outcomes, including 29 refusals,
eleven function bodies, fifteen constant initializers, public module exports, checklist content
and normalized policy hashes. Exact body/initializer and outcome checks preserve legacy roles,
unknown-field behavior, enforced witness limits, error identity and version refusals.

The remaining composition entries are the host authoring-ID/catalog data, obligation compiler,
application-review schema reader, runtime commit-policy loader, marketplace normalizer, complete
compiled-skill reader, existing source-control authority lookup and explicit path-syntax port.
They are not readiness flags; their actual admission and integrity rules remain required before
namespace configuration and complete portable lifecycle execution can be implemented.

Build identity, VSIX source admission and both workflow-intent interpretation hashes include the
new pure owners. Installed Git authority, persisted records, approvals and source publication
continue to use their existing execution and persistence paths.

## Mac qualification

Node 26.12.0 passes 312 checks across 31 files with no failures, cancellations or skips. The
suite includes the exact 74-case specification baseline, eleven preserved rule bodies and
fifteen constant definitions, all 43 original compiler cases across 18 workflows, both path-value
grammars, native skill capture/compilation/bindings, WCA finalization/submission, obligation
graphs, witnessed-clause policy, workflow intent and real CLI/SDK publication parity. The packed
SDK consumer and VSIX source/archive checks also pass. The focused five-file run passes 70 checks.

Source validation passes 3,749 checks. VS Code typechecking, the unchanged 2,011-site Git audit
and all thirteen existing bundle budgets pass. The gateway is 851 modules / 6,805,226 bytes,
within its unchanged 852-module limit. No budget or record format was changed.

Machine registries, Story repositories, Git remotes and package consumers are isolated fixtures.
No Windows, hosted CI, live provider, product installation, merge, push or real-project authority
migration ran. Portable configuration admission, complete headless Story execution, verified
cutover and final removal/distribution/performance qualification remain required milestones.
