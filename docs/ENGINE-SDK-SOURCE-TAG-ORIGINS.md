# Shared source-tag origin rules

Source-tag ownership distinguishes an identifier already carried by a generation's baseline from
an exact line added since the Story's first source reference. These are different observations.
A later code phase can carry an identifier at its own baseline while the line still belongs to
work this Story delivered earlier.

## Pure value owner

`sourceTagOriginPolicies(paths, roots)` lives in `kernel/code-delivery-evidence.mjs`. Its explicit
`sflow-source-tag-origin-values/v1` profile returns two generators:

- `carriedTagIdsReplay` consumes an opaque generation-baseline reference, observed path changes
  and current occurrences. It requests the prior text of the selected regular paths and their
  comment observations, then returns the identifiers already carried.
- `storyTagLinesReplay` consumes an opaque first-Story source reference, current occurrences,
  tag kind and logical application-path context. It requests exact added/removed-line facts,
  tracked-path membership and the text of requested untracked files. It returns exact
  `(path, line)` keys newly introduced by the Story.

The reference is not required to be a Git commit. A host resolves its explicit source references
through its own admitted observation ports. The value owner discovers no repository, file,
credential, command or model. It never records evidence, approves a phase or grants permission.
Original permission and timeout failures propagate unchanged through the request checkpoint.

Line ownership uses both exact added locations and normalized net line counts. Moving an old tag,
including between files or with whitespace changes, does not make it new evidence. A positive net
count elsewhere does not claim an old untouched line. Rewording a tag can introduce a genuinely
new line. Documentation, configuration, private inputs and test/source roles keep their original
selection rules. A missing reference yields unknown Story-line ownership; the legacy adapter
retains its existing interpretation, while a portable publication owner must require its actual
source proof rather than treating absence as an approval.

## Native compatibility and SDK

The native adapter still selects the original first work-interval reference and generation
baseline, runs the same bounded Git reads and reads the same requested untracked paths. Git's
zero-context patch syntax is decoded in `git-status-detail.mjs`; that adapter does not decide
which paths or lines count. The kernel receives portable line changes. Neither native record
versions, source-binding hashes, provider failure details nor Git/approval authority changes.

The SDK `specifications` entry exports the pure factory. The optional `specifications/node`
entry binds the existing explicit path values and application roots. Typed requests distinguish
raw source text, comment observations, line changes and tracked membership; readiness and approval
booleans cannot substitute for these facts. The installed consumer can replay actual observations
with an empty PATH and all infrastructure imports denied.

## Independent evidence and remaining integration

The 34-case oracle was captured from the original native helpers at `301c382c3` before extraction.
It retains their source hashes, raw Git patches, exact reads, original outputs and real missing-file
errors. Cases include source and acceptance tags, staged/untracked additions, duplicates, moved
lines, renames, spaces/quotes/Unicode in paths, private inputs and multiple work intervals. The
oracle is not generated from the extracted rules. Native public source binding is also compared
against its original captured outcomes.

The subsequent [portable line-origin delivery](ENGINE-SDK-PORTABLE-SOURCE-ORIGINS.md) connects these
rules to separately versioned v2 observations and accepted archive/receipt proofs. Namespace
source-control v1 retains its original file-metadata meaning and cannot satisfy `source-tag-origin`.
Delivery inspection requires the actual first-Story/generation archives, positions and accepted
conditional evidence before closing that owner.

Repository-qualified plan ownership, complete application publication and cross-agent Story
execution, existing-project migration/cutover and final distribution/performance qualification
also remain required. Phases 5, 7, 8 and 9 retain their full scope.

## Mac qualification

The final affected groups passed 337 distinct cases without failures, cancellations or skips:
207 core/architecture, source-control and value cases; 98 native source/plan/delivery cases; and
32 installed offline package cases. The 37 origin-value cases were rerun after preserving the
exact native untracked-path assembly and are not counted twice. The installed consumer replays
the original 34-case oracle through both pure and explicit Node bindings. Its pure run denies
infrastructure imports and has an empty PATH. NodeNext accepts actual text, line and membership
replies and rejects readiness/approval shortcuts.

Source validation passed 4,003 checks across 191 skills, including the unchanged Git ownership
audit. VS Code types and all 13 existing runtime bundle limits passed without increases. Gateway
remains 852/852 modules; extension/Help/support/prewarm remain 152/135/111/23. The optional SDK
retains 60 operations across 212 owned modules and 2,279,114 JavaScript bytes. No timeout was raised.
All fixtures used isolated Mac machine state; no Windows, hosted CI, live provider, product install,
real Story mutation, merge, push or installed-authority cutover was performed.
