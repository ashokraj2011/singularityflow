# Shared source change-record identities

The SDK's pure `changes` entry exposes `createRepositoryChangeSetCodec` with explicit
`sflow-repository-change-set-values/v1` digest and UTF-8 comparison primitives. The kernel owns
provider-neutral entry ordering, canonical entry identities, whole-record digests and integrity
checks. The native source-control adapter uses those same function instances.

Git execution, raw-wire decoding, index/worktree/untracked discovery, file-kind observations and
source baselines remain in the native adapter. No Git program, repository, credentials, physical
root or filesystem is discovered by the codec. Logical paths remain exactly the supplied data;
host path normalization is an adapter responsibility.

## Binding and meaning

```js
import { createHash } from 'node:crypto';
import {
  createRepositoryChangeSetCodec, REPOSITORY_CHANGE_SET_VALUES
} from '@singularity-flow/engine-sdk/changes';

const changes = createRepositoryChangeSetCodec(Object.freeze({
  profile: REPOSITORY_CHANGE_SET_VALUES,
  sha256Text: text => 'sha256:' + createHash('sha256').update(text).digest('hex'),
  compareUtf8: (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))
}));
const entry = changes.withEntryIdentity(observedEntry);
const digest = changes.repositoryChangeSetDigest({ ...observedChangeSet, entries: [entry] });
```

The primitives are trusted construction-time capabilities. Construction validates and captures
their frozen own-data binding without invoking either function. Accessors, missing methods,
unknown fields and future profiles are refused. A primitive's real error propagates unchanged.
The rules themselves import no Node, filesystem, Git, process, provider or storage implementation.

Repository identities use UTF-8 byte order, preserving the existing native ordering across
process locales. Canonical record hashes, excluded digest/entry-identity fields and legacy error
outcomes retain their current meaning. Native Git command arguments, baseline selection,
protected-path rules, record versions and publication authority remain unchanged.

The integrity result covers the supplied bytes and entry identities. Execution provenance,
current-source matching, approved plan coverage and publication permission require their own
accepted records and checks. The codec neither issues an evidence receipt nor authorizes a
publication. All existing code-delivery v2 requirements remain enabled.

## Compatibility evidence

The independent oracle was captured from `23190d234`. It retains 649 raw Git decoder outcomes,
225 native UTF-8 comparisons and 240 native digest/integrity outcomes captured before extraction.
Eight additional malformed-record outcomes come from the same immutable original function bodies.
Five original function-body fingerprints verify the decoder/path logic remains in its adapter
and the entry identity/order bodies retain their meaning in the kernel. Actual isolated Git
fixtures cover committed renames, staged and worktree changes, deletions, untracked files,
executable modes and materialized-tree captures.

The offline installed SDK consumer imports and executes `changes` with infrastructure imports
blocked. Its declarations require callable value capabilities and expose no Git decoder. This
is a prerequisite for connecting retained source-control observations to application delivery.
Full application policy/publication integration, existing-project migration/cutover and final
distribution/performance qualification still belong to the open Phase 5, 7, 8 and 9 milestones.

## Mac qualification

Node 26.12.0 passed 180 affected native regression cases covering actual change-set capture,
automatic candidates, configuration authority/publication, source-clause mapping, diff/review
consumers and work-interval reconciliation. A further 87 source/test/identity policy and architecture
cases passed, including the independent native oracles. The offline installed SDK tarball passed
25 checks, with blocked infrastructure imports, separate host processes and NodeNext declarations.
These final suites had no failures, cancellations or skips.

An initial empty-home fixture correctly refused Story creation because its approval group was
empty. The repository's standard isolated test environment supplies its own fixture Git identity;
the full 57-case configuration suite and the final native batch then passed. The failing assertion
now includes both stderr and the structured stdout, preserving the actual refusal diagnostic.
No production authority or approval rule was relaxed.

Source validation passed 3,931 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 unchanged bundle budgets passed. The gateway remains
at 852 modules; extension/Help/support/prewarm remain 152/135/111/23. An intermediate placement
exceeded the gateway budget by one module; the final source-policy placement preserves the
existing ceiling. No budget was raised.

The isolated SDK contains 56 registered operations, 174 owned modules and 1,721,452 JavaScript
bytes. No Windows, hosted CI, live provider, product installation, existing Story mutation or
authority migration was performed. This qualification covers the shared identity boundary;
full application publication and the remaining migration milestones are still required.
