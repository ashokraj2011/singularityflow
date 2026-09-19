# Git Access Layer implementation status

**Source reviewed:** `SPEC-git-access-layer (1).md`, SHA-256 `de3e0df8db9fc00880fc58c14a3f7d047499b77250fc44f13002bef0a6d0f15a`

**Last reviewed:** 2026-09-19
**Status:** code-local work for caller migration, approved read-path cutovers, persistent-object
hardening, and acceptance traceability is complete. The full GAL specification is **not
release-complete** until the physical platform and office-network evidence is recorded.

The current increment strengthens existing Git owners without changing the authority model or
switching every caller to a new runtime. Do not describe a passing local test as Windows or office
qualification. The original specification's 44 acceptance cases remain the completion contract.

| Milestone | Current position | What remains before claiming completion |
| --- | --- | --- |
| G0 — contracts and baseline | Partial. A static production process-site baseline and check gate are recorded in `scripts/git-bypass-baseline.json`. A reproducible local read benchmark now separates cold discovery, reference batch, and warm worker timing. Existing environment, remote, publication, and object owners are preserved. | Complete descriptor/effect and owner inventory, including runtime probes for indirect Git execution; independently review benchmark profiles on the supported matrix. |
| G1 — facade and reference transport | The approved code-local read cutovers are complete. `src/git-access.mjs` now includes typed byte-preserving tree, refs, approved-config, metadata-only blob check, and exact-remote-ref observations, in addition to HEAD/ref, status/index, and exact raw blobs. Snapshot revision reads use the registered `repository.revision` query as their authoritative one-spawn path. Capability provenance now uses registered remote/branch/HEAD descriptors by default. Implicit Story status selection uses registered `repository.root` followed by the dedicated one-spawn `repository.branch` descriptor: two processes for complete selector-safe selection, while the branch projection remains one. The legacy capability reader remains available only through an explicit compatibility mode, while shadow mode compares both projections without changing authority. Repository discovery batches fixed metadata while keeping unframed path fields separate: three probes instead of five for a nonbare repository, two instead of four for a bare repository. The general-facade status trial remains reverted because it multiplied process count. | Platform qualification and any future owner-scoped descriptor expansion. Do not replace the checked root-plus-branch status reads with general repository discovery. |
| G2 — reuse and batching | Partial. Existing exact ref-tree reads use pinned tree OIDs and raw batch reads verify object hashes with count/byte caps. `RepoContext` now tracks instance/configuration/shared/worktree generations, mutation barriers, and discovered linked-worktree invalidation. | Apply the scoped barriers across all mutation owners, prove external-change/current-use witnesses and temporary-index isolation, and qualify cached/uncached parity across processes and platforms. |
| G3 — mutation and extension migration | Code-local authority and remote cutover complete; platform qualification pending. VS Code's root probe uses the published async descriptor and bounded runner. State, Candidate, rework, configuration refresh, capability proposal, ledger, World-Model, transport-intent, and configuration-history owners retain their existing authorization and journal boundaries while using exact direct-ref checks, expected-OID CAS, fetch-to-`FETCH_HEAD`, and exact pre/post remote observations. Configuration-history publication now freezes one raw push authority, rejects ambiguous and symbolic refs, and reconciles lost acknowledgement. Proposal retention uses a non-dereferencing absent-OID CAS. Ambient `GIT_DIR`/worktree selectors cannot redirect raw local remote identity. The remaining direct Git calls are implementation details inside these reviewed local transaction owners (index/tree/diff/commit/ancestry), not independent authority or network callers. | Prove exact CAS, unknown-outcome recovery, cancellation, and cleanup on physical supported platforms. Migrate an owner-internal local transaction only with an equivalent closed descriptor and parity evidence; a mechanical replacement is not a release requirement. |
| G4 — persistent object service | Code-local hardening complete; platform qualification pending. The explicitly selected FOS worker now executes a bounded no-object capability probe, prefers `cat-file --batch-command --buffer`, and deterministically falls back to the verified legacy `--batch` protocol only when the preferred grammar is unsupported, malformed, unavailable, or times out. Structured immutable evidence names every attempted probe outcome and the selected protocol; a preferred-protocol success deliberately has no unattempted legacy outcome. The worker verifies full-OID format and object hash, rejects replacement/lazy fetch, bounds frames and queue/pool, and retires changed profiles. `readBatch` validates ordered multi-frame responses across chunk boundaries and returns only an atomically verified batch. Code-local fixtures cover capability success/failure/malformed/timeout/fallback, portable Windows process options, multiple 128-object chunks, missing/wrong-type/oversized objects, SHA-1/SHA-256 parity, cancellation, worker failure, cleanup, linked worktrees, and a local partial clone. Profile discovery is bounded and asynchronous; a replacement cannot start after unverified cleanup. | Run the same cases on physical Windows/Linux/macOS and supported Node versions, including office Git, package/VSIX, cancellation, cleanup, and worktree-removal evidence. Persistent mode remains opt-in and is not a new default. |
| G5 — qualification and rollout | Code-local acceptance traceability is complete and the bounded local matrix runner covers its declared representative suite; external cells and the broader evidence-owner suites remain separate. `docs/contracts/gal/acceptance-matrix.json` names all 44 acceptance cases, their code-local evidence owners, and the cases that still require physical/provider evidence; its contract is deliberately `traceability-only`, not proof that one matrix cell executed every named owner file. `npm run test:gal:acceptance` validates that catalog, while `npm run test:platform:gal` records one bounded source-bound cell plus the 10-trial 500-object benchmark. Dirty sources cannot yield `local-pass`; every cell remains `releaseQualified: false`. Historical clean macOS Node 22 and development Node 25 observations remain performance evidence only. | Linux, macOS, Windows × Node 22/24 plus retained Node 20 compatibility; actual office credential/proxy/CA, linked-worktree/filesystem, installed package/VSIX and performance evidence; independent signed source/artifact review. A skipped required leg cannot count as qualified. |

### Production caller cutovers completed in this increment

| Owner | Registered read or closed mutation | Preserved boundary |
| --- | --- | --- |
| Snapshot coordinator | `repository.revision` | Fresh, one-spawn porcelain-v2 revision at each capture boundary; no cached branch/dirty state. |
| Story status selection | `repository.root`, then `repository.branch` | Two bounded processes for complete selection: selector-safe top-level resolution, then exact `refs/heads/` framing from `symbolic-ref --quiet HEAD`. The branch projection alone remains one process; linked-worktree identity, detached-HEAD refusal, and the absence of general repository discovery are preserved. |
| Capability provenance | `repository.remote-url`, `repository.branch`, and `repository.head` | Three registered bounded reads replace the three legacy processes without increasing spawn count. Missing remote, detached HEAD, and unborn HEAD remain explicit nulls; ambiguous remotes and malformed/error output now fail closed. |
| AST project binding | `repository.tracked-paths` | Existing-only `ls-files -z`, 32 MiB output ceiling, and unchanged NUL/UTF-8 projection. |
| SGOS authority trust | `sgos.configured-remotes` and `sgos.local-authority-heads` | Exact remote and authority-ref argv, offline/ambiguous trust rules, and original refusal diagnostics. |
| Workspace existing-checkout inspection | `repository.root` | Fresh Git top-level plus the existing canonical `realpath` root check; no origin-URL authority change. |
| Workspace adoption and capability catalog | `repository.branch` and `repository.object-format` | Fresh checkout branch and exact object-format observations; detached HEAD still refuses adoption. Remote authority and clone transport remain with their existing owners. |
| Workspace member verification | `repository.root` | Fresh top-level read followed by canonical-path comparison; origin identity remains an independent check. |
| Workspace impact snapshots | `repository.root`, `repository.head`, `repository.branch`, `repository.status` | The initial and final repository observations stay fresh; detached HEAD and untracked work remain visible. Sandbox checkout and model projection are unchanged. |
| State source hashing | `repository.object-format`, byte-aware `repository.index-detail`, and nested `repository.head` | Index stages and OIDs are parsed from NUL-framed bytes; non-UTF-8 paths fail closed instead of silently changing a source hash. |
| State rework baseline | Owner-private exact direct-ref observation and immutable `update-ref --no-deref` absent-OID CAS | A returned phase cannot replace a retained baseline or accept a symbolic alias, even when it resolves to the expected tree. |
| Publication rework recovery | Exact direct-ref capture and `update-ref --stdin --no-deref` | Recovery refuses symbolic aliases before changing governed files or refs; rollback cannot follow an unrelated branch. |
| Auto Candidate local immutable refs | Owner-private exact direct-ref observation and `update-ref --no-deref` expected-OID CAS | No dereferencing of symbolic aliases, no relaxed retry after lost acknowledgement, and existing immutable-authority conflict codes remain. Remote observations also require the requested full ref name, not only a matching OID. |
| Ledger state and source-pin CAS | Owner-private exact direct-ref observation and `update-ref --no-deref` expected-OID CAS | Bootstrap retention, concurrent-initializer reconciliation, local-only append, and local-only publication all lease the exact named direct state ref. Remote refresh first proves the source branch direct, fetches only into `FETCH_HEAD`, verifies the observed OID, then advances the direct tracking ref under its old-value lease. Bootstrap worktrees use unique private refs and remove only their unchanged exact object after Git proves the worktree is no longer registered; a locked or file-busy worktree retains its recovery directory and ref. Ledger authority discovery refuses symbolic or unavailable state refs rather than following their targets. Best-effort post-push synchronization never follows a symbolic tracking or local state ref. Source-pin fetch does not apply a configured refspec before its own lease, and pin repair rejects symbolic or invalid-object pins. |
| Configuration transport retention | Owner-private immutable direct-ref CAS | An existing same-object direct ref is an idempotent retry; symbolic or different-object refs cannot be overwritten or followed. |
| Configuration history publication | Frozen raw push authority, exact remote observations, and an absent-ref lease | Ambient URL rewrites and repository selectors cannot redefine authority; ambiguous or symbolic immutable refs fail before publication, and a lost acknowledgement succeeds only when a fresh exact observation proves the intended commit. |
| Configuration proposal retention | Registered branch/HEAD/remote reads plus owner-private direct-ref CAS | Raw local remote identity is distinct from transport rewrites; proposal recovery cannot overwrite or follow a symbolic retention ref, and a concurrent identical winner is reconciled without repeating the mutation. |
| Workspace configuration refresh | Exact direct configuration/state refs, direct remote-source observation, fetch-to-`FETCH_HEAD`, then expected-OID tracking-ref CAS | Configured fetch refspecs cannot mutate authority before the refresh lease; symbolic remote sources and local configuration, state, cache, or tracking refs fail closed, including cache-miss apply. Cache cleanup removes only a ref the operation proved it created. |
| Capability proposal recovery | Owner-private exact-object fetch and direct-ref CAS | A deleted proposal is fetched into `FETCH_HEAD`, validated against its reviewed authority, then installed under its exact private ref only if absent or identical. |
| Capability proposal discard | Exact remote direct-ref preflight, leased deletion, and exact post-observation | Symbolic proposals are refused without changing alias or target; a lost acknowledgement is accepted only when a fresh read proves the exact proposal ref absent, while moved and unknown outcomes stay blocked. |
| FOS pinned-authority refresh | `gal.remote-ref.v1` for a previously attached `origin` ref | The prior sealed attachment supplies the endpoint digest, exact full ref, and reviewed prior revision. Initial onboarding and non-origin discovery cannot manufacture that pin and remain with their multi-ref authority owner. Symbolic authorities and endpoint drift fail before the local attachment is rewritten. |
| Transport-intent remote publication | Existing `GitRemoteSession` asynchronous remote Git plus local tracking-ref CAS | Dry-run and publication preserve exact pre/post remote-ref observations and uncertainty handling without blocking the Node event loop on an unbounded remote command. |
| VS Code repository-root validation | Published async `repository.root` descriptor through the existing supervised runner | One local spawn with the existing deadline, cancellation, cleanup, and canonical filesystem check; no remote or credential behavior change. |
| Capability fsck and doctor | `repository.branch` | Fresh checkout branch; detached HEAD remains an explicit absence and is never inferred from a previous Story. Proposal and approved-map authority are unchanged. |
| Workspace bootstrap network doctor | Existing `GitRemoteSession` async probe, bounded by `gitWorkerCount` | Distinct URL-and-branch observations run concurrently within the configured worker limit; enterprise Git configuration, auth classification, cancellation and injected deterministic runner behavior are preserved. |
| World-Model authority refresh | Owner-private expected-OID ref deletion | Only the configured stale remote-tracking ref; unknown outcomes and races remain refused. |

These cutovers deliberately leave local index/tree/diff/commit/ancestry mechanics inside their
existing reviewed transaction owners. They are not public raw-Git escape hatches and they do not
select remote authority. The reviewed bypass baseline shrinks only for caller sites actually moved
to registered reads; a new direct process site still fails the build and needs explicit review.

The static bypass gate (`docs/git-bypass-audit.md`) freezes **new** production call sites; its
reviewed baseline is not a declaration that every legacy caller is safe or migrated. The new GAL
facade is foundational and is not yet a drop-in replacement for all public Git operations.
For the current change set, `npm run check` passes 1,694 static checks, the complete VS Code suite
passes 943/943 tests, the focused Git-owner suite passes 524/524 tests, and the machine-checked GAL
acceptance catalog passes 6/6 tests under Node 22. VS Code typecheck, build, bundle budget, VSIX
packaging, and the npm package dry-run also pass. The affected CLI shards and focused regressions
were rerun after the repository-context, lazy-loading, immutable-history observation, and bounded
test-harness corrections. These local results are implementation evidence, not physical Windows or
office-network qualification.

An earlier GDP companion-freeze test detected five companion hashes that were already different at
the clean starting commit: the packaged workflow template, WMB v4 document, publication unit of
work, migration registry, and initialization proposal. Those five authorities were subsequently
reviewed individually and are reconciled in
[`COMPANION-LOCK-REVIEW-2026-09-19.md`](contracts/gdp/COMPANION-LOCK-REVIEW-2026-09-19.md);
the M0 contract baseline remains unchanged. No local macOS run qualifies the release.
The reverted status cutover's ten processes were one executable version probe, five general
repository discovery probes, and four unborn-HEAD probes. Complete replacement selection uses two
bounded processes (`repository.root` then `repository.branch`); the branch-only descriptor remains
one and has linked-worktree, detached-HEAD, deadline-routing, malformed-output, and spawn-count
coverage. On this macOS development host, 30 warm branch-only reads measured a
4.62 ms median (136.63 ms total) and 30 registered reads measured a 3.93 ms median (117.66 ms
total). This local sample is regression evidence, not cross-platform qualification.
`remoteRef` verifies continuity of a caller-pinned origin URL; its `ownerPin` alone is not proof
that the revision was approved. The first production caller is therefore deliberately limited to
FOS refresh after a sealed attachment receipt has validated and issued the endpoint/ref/revision
pin. Initial onboarding and arbitrary remote reads do not enter that path.
The measurement boundary, exact-byte parity, and current local figures are in
[Git access read-path qualification](GIT-ACCESS-LAYER-READ-QUALIFICATION.md).

## Operator and release rule

Keep the reference behavior and current guarded publication/recovery owners enabled. Migrate one
closed read descriptor at a time with byte, effect, authority, and refusal parity; never shadow a
mutation by executing it twice. Do not enable persistent transport or immutable caching as a
default until the corresponding cross-platform acceptance evidence exists. A failing office Git
probe must retain a typed, redacted cause and must never be “fixed” by disabling TLS, replacing
credentials, force-pushing, or deleting governed branches.

Continue owner-by-owner descriptor work only where it removes duplicated reads or strengthens an
authority/effect boundary; do not rewrite stable local transaction owners merely to reduce a static
count. The physical Windows/office matrix and independent release approval remain separate gates.
Do not present the local acceptance catalog or matrix cell as a release-signing mechanism.
