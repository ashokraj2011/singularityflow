# Accepted portable source-line origins

The existing registered `phase.source-control.retain` operation accepts a separate v2 provenance
contract. The opt-in Node Git reader selects it only when the host supplies both `baselineCommit`
(this generation) and `originCommit` (the first Story source). Omitting `originCommit` preserves
the v1 descriptor, capture, record, result and Git-call behavior. A v1 reader still refuses a v2
observation as unsupported; metadata-only evidence cannot establish exact line ownership.

## Proof and ownership

The v2 source-control observation records both original inventories, the actual tracked-path set
and zero-context hunk positions. It contains no patch text or source bodies. The Git adapter owns
Git framing, pinned local execution, object reads and final fresh capture. It reuses the existing
SGOS process owner; it cannot fetch, publish, approve or discover a Git installation.

The namespace reader independently resolves `sourceBindings.origins` through its accepted
`source.bind` operation. It requires the accepted byte archive for that original selection and
for the generation baseline when different. Archive identities, original conditional receipts,
repository descriptors and raw content hashes must agree. No synthetic Git commit, current HEAD
guess or caller-supplied approval substitutes for the original proof.

Kernel rules reconstruct line deltas from those verified original/current bytes and the retained
positions. Unchanged segments must match exactly. Completeness and tracking checks reject omitted
changes, and positions cannot invent source lines. Identical renames have no changed lines; binary
changes retain metadata without invented text hunks. Text forced into binary representation needs
an explicit supported normalization owner if its bytes cannot justify the observation.

The shared source-tag rule then applies native kind-specific patch selection, whitespace-normalized
net counts, exact added locations, carried identifiers and untracked-file handling. A tag moved
between locations stays carried. A line this Story introduced before the current generation's
baseline remains attributable to this Story. Source/test/configuration/document and private-input
roles keep their existing kernel owners.

## Acceptance, retry and takeover

Versioned namespace plans retain the original and baseline archive result/index bindings. Both
preparation and final acceptance condition on those versions together with the existing authority,
configuration, Story, source receipt, draft and control index. Reuse is scoped to an exact accepted
source proof traversal; current selection and final source/permission checks are still fresh.

An accepted v2 record reopens without its original checkout, Git binary, private draft or a new
timestamp. Historical receipt verification uses the actual accepted archive operation, not a
later mutable index selection. Real missing-content, permission and timeout errors retain their
original recovery semantics. Missing byte archives name `source.baseline.retain`; missing exact
line proof in delivery inspection names `phase.source-control.retain` and its prerequisites.

Delivery inspection closes `source-tag-origin` only with this exact accepted draft/source proof.
It does not establish application acceptance, run tests, grant human approval or remove the full
code-delivery publication owner. Its current consumer is the source-clause owner; AC-to-executed-test
witness binding remains part of complete application delivery. Repository-qualified plans, complete application publication,
cross-agent execution, migration/cutover and final qualification remain required by Phases 5, 7,
8 and 9. Local document/image bodies remain private.

## Mac qualification

The affected regressions and final acceptance group passed 354 distinct cases. Another 33 installed
SDK cases passed, including actual v2 archived-line replay in an empty-PATH consumer after removing
the original checkout. All 387 cases passed without cancellations or skips; repeated cases are not
added to the count. The installed package completed within the existing 120-second parent and
60-second child limits. No limit was raised.

Coverage includes all three namespace metadata backends, different first-Story/generation sources,
old/moved/whitespace/reworded tags, exact zero-context positions, Unicode/quoted paths, metadata-only
renames, binary observations, archive-version conditional reads, revoked permissions, source drift,
concurrency, fencing, lost acknowledgements and real retained-read errors. Self-consistent hashes
cannot replace missing changes, original source or verified line coordinates. Malformed nested
archive bindings and unknown future records have explicit errors. NodeNext preserves the inferred
v1 capability when `originCommit` is omitted and exposes v2 only through its explicit contract.

The optional package retains 60 registered operations, 213 owned modules and 2,312,160 JavaScript
bytes. Source validation passed 4,006 checks across 191 skills with the unchanged Git ownership
audit. VS Code types and all 13 original runtime bundle limits passed without increases; gateway
remains 852/852 modules and extension/Help/support/prewarm remain 152/135/111/23.

Fixtures, builds and offline installation used isolated machine state on this Mac. No
Windows, hosted CI, live provider, product installation, real Story mutation, merge, push or
installed-authority cutover was performed. These qualify the provenance boundary, not a completed
application Story or the remaining migration milestones.
