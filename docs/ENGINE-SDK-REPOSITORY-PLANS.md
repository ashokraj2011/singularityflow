# Reviewed repository plans in the SDK preview

One approved implementation plan can describe several repositories without treating identical
relative filenames as the same file. This is an opt-in namespace SDK contract. Native Git
workflows, installed CLI outputs and existing unqualified plan records keep their current behavior.
It does not migrate installed projects or complete application publication.

Repository-qualified admission applies when the pinned workflow requires planned claims
(`plannedClaims.mode: required`). Other modes retain their existing policy; a declaration alone
does not strengthen or loosen the workflow's authority.

## Declare the repositories in the reviewed plan

Add this section to the implementation-plan Markdown before publication and independent approval:

```markdown
## Repository roots

| Repository | Plan root |
| --- | --- |
| app | `frontend` |
| service | `backend` |

## Planned changes

| Clause | Expected paths | Planned tests |
| --- | --- | --- |
| STORY:REQ-001 | `frontend/src/converter.js`, `backend/src/converter.js` | `frontend/test/converter.test.js`, `backend/test/converter.test.js` |
```

Repository IDs must match the explicit SGOS source units. Roots are logical prefixes in the plan,
not laptop paths or checkout folder names. Each source unit still observes its own repository root.
For example, `backend/src/converter.js` projects to `src/converter.js` in repository `service`.
There is no implicit repository selection based on directory names.

Declare at most 32 repositories. IDs must be distinct, and prefixes must not overlap, including
on case-insensitive hosts. A plan for one explicitly named repository may use `.` as its root.
Every declared repository must have planned files. Malformed declarations fail explicitly rather
than falling back to an unqualified plan. Fenced examples and managed/comment content do not opt in.

All application and executable-test paths must resolve to a declared repository. Supporting files
are classified again after their prefix is removed; configuration and documentation do not become
product source. A repository containing only supporting files still belongs to code-generation
scope. Global Story evidence and documents retain their original namespace and obligations. A
repository prefix cannot turn private Story inputs or transient output into application scope.

## Retained proof and admission

The kernel derives `sflow-repository-plan/v1` from the reviewed artifact and its normalized claims.
The record contains roots and repository-local path projections. It has no physical paths, approval
flags, execution results or inferred acceptance verdicts. The existing claim-map record stays v2;
its global verification contracts and combinations are not replaced with smaller local contracts.

Namespace specification evidence v2 adds the repository-plan content reference. Existing v1
records remain v1 when there is no declaration. Reading a new plan replays its original bytes,
upstream specification indexes, publication and independent human-approval proof. A status label
cannot replace those records. Missing content, permission failures and future versions retain
explicit errors; no fresh authority or evidence is invented.

The existing `source.bind` and `phase.prepare` operations require the repositories allocated to
the code phase. This also covers sources selected before planning and private drafts reopened
afterward. An incomplete or unknown selection returns `SPEC_REPOSITORY_BINDING_REQUIRED`, with
the required repository IDs and the `source.bind` operation prerequisites. It does not capture
application files or advance the shared Story. Draft publication rechecks the approved scope.
Access, source descriptors, current revisions and final conditional acceptance remain fresh checks.

Byte-backed source inspection uses each repository's projection. A source comment in `app` cannot
satisfy an obligation assigned to `service`. Its v4 delivery manifest carries a v2 clause observation
and the exact original plan reference. This is source traceability, not proof of passing tests or
application acceptance. Unqualified legacy multi-repository plans retain their existing explicit
`repository-qualified-claims` gap and earlier manifest versions.

## Boundaries and remaining work

Pure parsing and allocation live in `src/kernel/repository-plan.mjs`. The Node syntax binding
performs no I/O. Read-only namespace owners reopen retained plan/approval proof; SDA owns its
immutable bytes. SGOS observes physical source units. Surfaces do not select another authority.
No registry operation, raw Git site, shell renderer or provider prompt is added.

The package exports pure values through `@singularity-flow/engine-sdk/specifications` and the
explicit Node syntax binding through `@singularity-flow/engine-sdk/specifications/node`.
Installed package tests exercise both legacy and qualified plans in separate empty-PATH processes,
including independent approval, identical filenames, new physical checkouts and unchanged shared
receipts. Native Git publication remains the compatibility path.

Full application-delivery publication, repository-specific execution routing, acceptance linked to
actual executed witnesses, complete cross-agent Story execution, installed authority cutover and
final distribution/performance qualification remain open migration work. This contract does not
complete Phases 5, 7, 8 or 9.

## Mac qualification

This slice passes 332 distinct affected checks. The broader run had 295 passes and one outdated
future-version vector; the final 127-check run passes that corrected vector and the private-prefix
regression as well as the repository/approval, specification-publication and dependency guards.
Results are deduplicated across those runs and the installed package checks.

The packed core SDK passes 32 checks in 89.9 seconds. Its independently bounded source-portability
group passes three checks in 52.4 seconds, including two actual takeover journeys. All existing
assertions remain. The aggregate package parent initially exceeded its deadline; the source-origin
case now shares the portability group with repository plans. Both groups keep the original
120-second parent and 60-second child limits. Final groups have no failures, cancellations or skips.

Source validation passes 4,012 checks across 191 skills; VS Code typechecking, all 13 unchanged
bundle budgets and the 2,011-site Git ownership audit pass. The SDK has 60 registered operations,
216 owned modules and 2,335,106 output bytes. The gateway remains 852 modules / 6,912,047 bytes;
no ceiling is raised. Legacy-scope discovery reads only the exact publication and specification
metadata; qualified scope still reopens the original conditional publication and human proof.

All fixtures use isolated machine state and temporary directories. No Windows, hosted CI, live
provider, real Story mutation, install, merge or push ran. The work remains on the feature branch.
