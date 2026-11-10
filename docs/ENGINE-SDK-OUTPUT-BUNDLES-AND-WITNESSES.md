# Namespace output bundles and human witnesses

This opt-in SDK delivery keeps member files, test results and human review as different facts.
It does not migrate installed Git authority. Native records and Code proof v1–v6 keep their meanings.

## Typed outputs

The approved phase names an existing artifact set. Its primary remains the phase document.
Members use exact portable paths relative to that document's directory; declared collections accept
files beneath their directory. Required collections must contain a file. Advisory members remain
optional and cannot supply human acceptance evidence.

Use `phase.artifact.attach` with `operationId`, `workId`, `phaseId`, the exact private
`expectedRevision`, declared `memberPath`, machine-local `content` reference and `reason`.
`phase.artifact.remove` has the same inputs without `content`. Both are explicit private mutations;
they neither publish files nor claim test execution. `phase.artifact.inspect` returns a bounded,
body-free inventory. `maximumEntries: 0` returns totals without member rows.

Publication reads the actual admitted member bytes and retains the complete bundle through
`artifact-set/v1` evidence. The catalog hashes each member and collection against its pinned
declaration. The same conditional transaction records the full output inventory. Submission checks
that exact inventory. Review resources distinguish identical bytes under different file paths;
both phase and Story document references resolve to the retained member. Approved bundles are
included in downstream phase input manifests and remain readable after takeover.

This explicit output operation is separate from `story.document.attach`. Uploaded input images
and documents remain in their declared device-local store; this delivery does not copy them into
shared evidence. Old private preparation v1 remains readable. Member metadata uses a separate v2
payload, and original primary-only records retain their original shapes.

## Actual human acceptance

Code proof v7 carries approved mixed verification contracts with actual structured test outcomes.
It can retain a Code publication while visual or inspection slots remain pending. Required primary
test slots still require genuine passing execution. Supporting slots cannot satisfy a criterion;
the shared kernel combines primary slots using the approved `all` or `any` rule.

`witness.context` takes one exact `clauseId`, `slotName` and published `file`. It returns the
original approved plan/contract binding, exact retained bytes, owner approval groups, current witness
status and candidate digest. It does not provide a human sign-off. `decision.witness` records only
an authenticated human with a configured owner authority, the exact `expectedContext` and
`expectedFile`, a reason and every approved checklist answer. Negative answers retain a failed
inspection. A completed signature cannot be duplicated under another operation ID.

Approval evaluates the complete verification contract using retained test results and authenticated
human records. File presence or passing tests cannot supply a missing visual signature. A recorded
reviewer return can proceed without pretending that its pending acceptance slots passed. A later
plan, candidate or evidence change makes the old witness stale. Original decisions and their exact
authority proofs replay from shared storage without the original working store or executor.

Native slot evaluation now delegates to one pure kernel owner; its compatibility facade supplies
the old optional clock. Accepted witness proof reuse is bounded to one invocation and the exact
captured storage ports. Mutable selection, current identity, authority and final conditional-write
checks remain fresh. A write boundary clears reuse, including a lost or failed write response.

## Scope

The [Phase 5/7 completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md) remains authoritative. Plan row and
evidence correction, other decision families, test recovery, targeted Code repair, live application
acceptance and remaining production policy/execution owners still require their implementations
and qualification. This delivery does not mark either phase complete or advance migration/cutover.

## Mac qualification

Qualification on macOS arm64 and Node 26.12.0 passed 282 distinct affected checks without failures,
skips or cancellations. These include the unchanged 34-check installed SDK qualifier, run alone in
34 seconds within its existing 120-second parent and 60-second child limits; a separate installed
output-bundle consumer and NodeNext type check; native CLI/SDK human-witness parity; genuine Node,
Jest and JUnit evidence compatibility; and filesystem, SQLite and application-storage journeys.
The journeys exercise conditional publication, independent approval, exact file reads, duplicate
refusal, permission failures and shared-only takeover. Binary test fixtures establish protocol
behavior, not an application's visual acceptance.

Source validation passed 4,144 checks across 191 skills, three agents and two extensions.
Architecture boundaries, schema ownership, VS Code types and the unchanged Git ownership audit
passed. All 13 original bundle ceilings passed without increases; the gateway has 846 modules
against its unchanged limit of 852. No Windows CI, live provider, user installation, real Story
mutation, authority migration or main merge was performed.
