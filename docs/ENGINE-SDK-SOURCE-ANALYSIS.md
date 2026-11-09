# Shared source and test analysis

The SDK and the native application use the same bounded lexical rules for source-comment
provenance, qualified clause tags, JavaScript test identities, assertion observations and
association gaps. These are syntax observations; a tag does not prove a requirement is met.

## Owners

`kernel/source-comments.mjs` owns JavaScript/TypeScript/JSX comment locations and the existing
polyglot source-tag rules. `kernel/javascript-declarations.mjs` owns the existing
`javascript-test-v2` declaration schema, logical identities, declaration hashes and gaps.
Acceptance-tag vocabulary stays in `kernel/verification-policy.mjs`.

The public `specifications` entry exposes `javascriptDeclarationPolicies(digests)`,
`scanSourceClauseTags`, comment provenance and tag helpers. The frozen digest capability is an
explicit SHA-256 UTF-8 value primitive. The optional `specifications/node` entry binds that
primitive without selecting a checkout, filesystem, cache, process, provider or authority.
Native adapters retain the original content cache and persisted verification-fact behavior.
The native persisted scanner fingerprint includes the extracted rule owners and Node binding,
so later rule changes invalidate old facts rather than following only the compatibility wrapper.

The independent native oracle was captured at `5ca5accb4` before extraction. Its 23 declaration
inputs and 12 source-comment inputs preserve native identities, ordering, limits and diagnostics.
It includes malformed source, aliases, dynamic titles/contexts, parameterized tests, duplicate
identities, skipped/focused tests, unattached/suite tags, JSX, regex/template text and polyglot
comments. It is not regenerated from the extracted rules.

## Analysis of retained bytes

The registered `phase.delivery.inspect` namespace reader returns
`sflow-delivery-evidence-inspection/v2`. Existing explicit v1 port facts remain readable under
their original v1 result contract. Unknown explicit profiles are refused.

The v2 `analysis` field is null when no current-draft source-retention receipt exists. Otherwise
it contains a `sflow-retained-source-analysis/v1` preview bound to that receipt's exact content
reference. The reader accepts only its own original, unchanged, verified retention proof. It
verifies repository manifests and reconstructs original retained chunks against their full file
hash and length. Analysis can read those archived bytes after the original checkout is removed.
The delivery query still requires current sources for its separate final freshness comparison.

Each file preview identifies its repository, path, change, existing source/configuration role,
source hash/length/mode, tags with line numbers, test identities, skip/focus state and association
gaps. The pinned test command selects the declaration profile. An unsupported language/profile
is a diagnostic, never a guessed JavaScript analysis. A suite tag remains a gap, not an exact test.
Qualified requirement, behavior, interface, constraint and acceptance IDs keep their native
meaning. Configuration retains its existing role; it is not reclassified as product source.

Previews have the requested file-entry budget, 64 KiB of file-row metadata, at most 100 tags,
declarations and gaps per displayed file, and 512 characters per diagnostic message. Full counts
and truncation disclosures remain. Zero display entries is valid. Text at the 16 MiB source
boundary is explicitly too large; the native JavaScript declaration limit also remains in force.
Binary or invalid UTF-8 source has no invented text associations. No source body, local root,
model prompt or raw test output is returned in this preview.

## Authority and remaining work

Source-comment associations, declarations and assertion shapes are distinct from retained test
execution and human acceptance. This reader starts no process, writes no record and grants no
publication, approval or requirement verdict. It preserves actual missing-content, permission,
timeout, cancellation and integrity failures. The final query still revalidates source state,
evidence indexes, private draft, authenticated access and Story authority.

The required code-delivery policy remains owed. Actual hunk/explanation bindings, claim coverage,
code publication proofs, the remaining policy owners and complete cross-agent application Story
execution are still required. This advances Phases 5 and 7 without completing either milestone;
existing-project cutover and final distribution/performance qualification remain Phases 8 and 9.

## Mac qualification

Qualification passed 342 distinct affected cases, with no failures, cancellations or skips:
190 shared-value, namespace, architecture, original/current archive and actual-check cases;
122 native cache, source-binding, code-delivery and verification cases; and 30 installed offline
SDK-package cases. The installed consumer compares the independent native oracle, reads actual
retained associations in another empty-PATH process and typechecks negative API examples with
NodeNext. No test timeout or bundle ceiling was increased.
The final cache/fingerprint rerun passed all 25 affected cases; its repeated cases are counted
once in the distinct total. That regression changes owner bytes only inside isolated child reads
and proves that the real fingerprint changes without modifying any checkout file.

Source validation passed 3,991 checks across 191 skills. VS Code typechecking, the existing Git
ownership audit and all 13 runtime bundle budgets passed. Gateway/extension module counts remain
852/152; Help/support/prewarm remain 135/111/23. The SDK retains 60 registered operations across
209 owned modules and 2,143,668 JavaScript bytes. No Windows, hosted CI, live model, product install,
real Story mutation or authority cutover ran.
