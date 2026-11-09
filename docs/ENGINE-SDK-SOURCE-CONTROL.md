# Explicit source-control observations

The optional SDK exposes the pure `source-control` contract and the Node `sources/git` adapter.
This supplies the Git-origin input needed by application delivery without making Git a dependency
of the engine core, SDA contracts or workflow rules. Installed Git lifecycle authority is unchanged.

## Binding

```js
import {createNodeGitSourceControlReader} from '@singularity-flow/engine-sdk/sources/git';

const reader = await createNodeGitSourceControlReader({
  id: 'application-git',
  root: verifiedCheckout,
  source: selectedSource.descriptor,
  baselineCommit: exactBaselineCommit,
  git: {executable: verifiedGitBinary, executableSha256: reviewedBinarySha256,
    environment: approvedGitEnvironment},
  authorizeCapture: (descriptor, subject) => authorizeLocalObservation(descriptor, subject)
});
const observed = await reader.capture({workId, phase, generation, generationIntentId}, {signal});
```

The application supplies the absolute checkout, selected filesystem source descriptor, exact full
Git commit, regular pinned executable, captured environment and authorization callback. The adapter
does not discover an installation, identity, repository, credential helper or CLI. Its constructor
reuses SGOS's existing bounded filesystem root binding. Existing SourceUnit and SourceSnapshot v1
shapes remain unchanged; content access and source-control access are separate capabilities.

The descriptor binds the source selection, profile, baseline, executable digest, environment digest
and limits. Request identity includes the Story, phase, generation and generation-intent identity.
Closed JSON validation refuses unknown fields, accessors, cycles, unsupported versions and oversized
observations. Physical roots, environment values and source file bodies are absent from results.

## Actual observations

The Git profile reads the committed baseline, HEAD, index/worktree differences, untracked paths,
merge stages, hidden index flags and path-comparison mode. Its raw decoder is the same adapter
factory used by native change-set capture. Shared pure rules preserve canonical entry identities,
ordering and record digests; Git wire decoding remains outside the kernel.

Baseline members come from real Git blobs. Their original Git object identities are verified before
SHA-256 metadata is emitted. Current members come from actual bounded filesystem captures. A
missing historical object never borrows current source bytes. Ordinary files are supported; selected
symlinks and gitlinks require another explicit profile. Changes crossing an excluded source boundary
are refused. Excluded file content and path details do not appear in the observation.

Before returning, the reader repeats the current source capture and verifies HEAD/baseline identities,
selected raw changes, untracked paths, merge stages, hidden flags and path-comparison mode. Source,
tracking or object movement cannot reuse the earlier positive observation. The immutable baseline's
verified metadata is cached within that reader instance; every capture still checks current facts.

The adapter calls fixed local read commands through SGOS's existing pinned process supervisor. It
does not call fetch, pull, push, checkout, commit or a lifecycle writer. Git remains a trusted host
program reading repository-local configuration; this adapter is not an operating-system sandbox.
Applications authorize that program and checkout explicitly. System/global configuration, ambient
Git selectors, lazy fetching, replacement objects, optional locks and interactive prompts are disabled.
Caller-supplied `GIT_*` overrides are refused. No new raw process-launch site is introduced.

## Failures and acceptance

Cancellation, authorization refusal, executable drift, deadline expiry, source drift, hidden changes,
unmerged stages and unavailable objects keep separate error codes. Git failures retain the actual
stage, exit status, signal, stderr text/hash and deadline facts. A timeout does not establish a DNS
failure. An authorization answer arriving after cancellation or expiry cannot launch Git. Launched
children remain owned by the shared supervisor until close/quiescence; a failed termination cannot
be turned into successful evidence.

An observation is candidate data. It is not an accepted evidence record, publication readiness,
human acceptance, phase approval or a lifecycle transition. Namespace-backed conditional acceptance,
proof reading, complete code/claim/constitution/artifact-set integration and a full application Story
remain required Phase 7 work. Remaining Phase 5 extraction, Phase 8 migration/fencing/reconciliation
and Phase 9 cleanup/distribution/performance qualification also remain open.

## Qualification

Mac qualification covers real committed renames, staged and worktree changes, deletion, modes,
untracked files, exact native identities, immutable baseline reuse, excluded paths, missing blobs,
symlinks, source/HEAD/tracking/configuration drift, hidden index flags, actual merge conflicts,
authorization, cancellation and deadlines. Independent native decoder/hash oracles retain their
original outcomes and function-body fingerprints. The installed offline SDK consumer also runs
real Git observations with an empty `PATH` and an explicit binary, while the pure contract imports
successfully with infrastructure imports blocked. Native Windows and live-provider qualification
are outside this Mac-only extraction.

Node 26.12.0 passed the final 41-case reader/native-decoder/filesystem suite, including real linked
worktrees and SHA-256 Git repositories with binary content. The additional 84 affected execution,
source-archive and delivery-inspection cases passed in the broader regression run. All 68
architecture cases and all 26 installed offline SDK-package checks passed. These final affected
groups contain no failures, cancellations or skips.

The missing-object regression first exposed that `ls-tree --long` reports an unreadable object as
`BAD`. The final diagnostic preserves that actual response and reports object unavailability without
inventing its cause. A missing foundation module-manifest entry was also corrected without relaxing
the dependency guard. Earlier failing attempts are not counted as successful qualification.

Source validation passed 3,936 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 unchanged bundle budgets passed. Gateway/extension/Help/
support/prewarm remain 852/152/135/111/23 modules. The optional SDK has 56 registered operations,
179 owned modules and 1,750,583 JavaScript bytes. Baseline reuse removes the two immutable-baseline
Git reads on the second ordinary capture while retaining every final current-binding check.
These are component results, not complete-Story latency or full application-runtime qualification.
