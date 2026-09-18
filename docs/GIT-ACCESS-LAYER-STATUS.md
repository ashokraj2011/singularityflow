# Git Access Layer implementation status

**Source reviewed:** `SPEC-git-access-layer (1).md`, SHA-256 `de3e0df8db9fc00880fc58c14a3f7d047499b77250fc44f13002bef0a6d0f15a`

**Last reviewed:** 2026-09-19
**Status:** incremental implementation; the full GAL specification is **not release-complete**.

The current increment strengthens existing Git owners without changing the authority model or
switching every caller to a new runtime. Do not describe a passing local test as Windows or office
qualification. The original specification's 44 acceptance cases remain the completion contract.

| Milestone | Current position | What remains before claiming completion |
| --- | --- | --- |
| G0 — contracts and baseline | Partial. A static production process-site baseline and check gate are recorded in `scripts/git-bypass-baseline.json`. A reproducible local read benchmark now separates cold discovery, reference batch, and warm worker timing. Existing environment, remote, publication, and object owners are preserved. | Complete descriptor/effect and owner inventory, including runtime probes for indirect Git execution; independently review benchmark profiles on the supported matrix. |
| G1 — facade and reference transport | Partial. `src/git-access.mjs` now includes typed byte-preserving tree, refs, approved-config, metadata-only blob check, and exact-remote-ref observations, in addition to HEAD/ref, status/index, and exact raw blobs. Snapshot revision reads now use the registered `repository.revision` query as their authoritative one-spawn path; the legacy query remains only as a shadow comparator. Repository discovery batches fixed metadata while keeping unframed path fields separate: three probes instead of five for a nonbare repository, two instead of four for a bare repository. Capability provenance and optional Story status branch comparison still use shadow mode. A default status-branch cutover was trialed and reverted: 30 local reads took 863–882 ms and 300 Git spawns through the typed path versus 88–90 ms and 30 spawns through the current path on this Mac before discovery batching. | Measure the revised discovery and status paths on clean supported-platform builds before an authoritative status cutover; complete owner-scoped descriptor contracts, further production read cutovers, and platform qualification. Snapshot's registered query is an authoritative cutover; the other shadow paths are not. |
| G2 — reuse and batching | Partial. Existing exact ref-tree reads use pinned tree OIDs and raw batch reads verify object hashes with count/byte caps. `RepoContext` now tracks instance/configuration/shared/worktree generations, mutation barriers, and discovered linked-worktree invalidation. | Apply the scoped barriers across all mutation owners, prove external-change/current-use witnesses and temporary-index isolation, and qualify cached/uncached parity across processes and platforms. |
| G3 — mutation and extension migration | Partial. VS Code's root probe uses a published, host-neutral async `repository.root` descriptor while its existing bounded CLI runner still owns cancellation and cleanup. Governed lifecycle publication's local branch CAS remains inside its journaled owner. Auto Candidate retention/recovery, rework-baseline retention, configuration retention, capability-proposal recovery, and ledger state/pin refs now use exact direct-ref checks and non-dereferencing expected-OID CAS. Proposal and pin recovery fetch into `FETCH_HEAD` before installing an independently validated local ref. Transport intents use supervised asynchronous remote Git with exact pre/post observations and tracking-ref CAS. Registered World-Model authority refresh clears only its configured stale tracking ref. Read-only ensure never mutates; the public GAL facade has no generic write escape hatch. | Migrate the remaining legacy callers owner by owner without duplicating effects. Prove exact CAS, unknown-outcome recovery, and process cleanup across supported platforms. |
| G4 — persistent object service | Partial. The FOS `cat-file` worker verifies full-OID format and object hash, rejects replacement/lazy fetch, bounds frames and queue/pool, and retires changed profiles. Identical in-flight OIDs share one worker write with at most eight subscribers per group; each subscriber has an independent deadline/cancellation, logical queue capacity still counts every subscriber, and result bytes are copied per caller. An explicit optional `readBatch` sends bounded OIDs in one write, validates ordered multi-frame responses across chunk boundaries, verifies every object before returning the atomic batch, and retires on cancellation, deadline or protocol failure. A shared reference/persistent fixture covers exact bytes, malformed frames, cancellation, cleanup, and a local partial clone. Profile discovery is bounded and asynchronous; a replacement cannot start after unverified cleanup. | Physical Windows/Linux cleanup, cancellation and worktree-removal evidence, explicit capability probes, and transport fallback qualification. Persistent mode is not a new default. |
| G5 — qualification and rollout | Partial local harness. `npm run test:platform:gal` records one bounded, source-bound platform cell and the 10-trial 500-object read benchmark. Dirty sources cannot yield `local-pass`; all results state `releaseQualified: false`. A clean macOS arm64 Node 22.14/Git 2.54 cell at `0f39a43c` passed 171/171 tests with no skips and observed four cold discovery spawns. A clean Node 25 development cell at `be7a65f5` also passed 171/171; Node 25 is not a supported-platform qualification. The sequential warm worker uses fewer Git spawns but is slower than the reference helper; an explicit multi-frame profile measured four warm writes and lower local median latency for the same 500 objects. Neither result establishes general speedup. | Linux, macOS, Windows × Node 22/24 plus retained Node 20 compatibility; Windows-equivalent cases for currently POSIX-only fixtures; actual office credential, proxy, linked-worktree, filesystem, package/VSIX and performance evidence; independent signed source/artifact review. A skipped required leg cannot count as qualified. |

### Production caller cutovers in progress

| Owner | Registered read or closed mutation | Preserved boundary |
| --- | --- | --- |
| Snapshot coordinator | `repository.revision` | Fresh, one-spawn porcelain-v2 revision at each capture boundary; no cached branch/dirty state. |
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
| Ledger state and source-pin CAS | Owner-private exact direct-ref observation and `update-ref --no-deref` expected-OID CAS | Local-only publication reconciles the exact post-CAS ref; best-effort post-push synchronization never follows a symbolic tracking or local state ref. Source-pin fetch does not apply a configured refspec before its own lease, and pin repair rejects symbolic or invalid-object pins. |
| Configuration transport retention | Owner-private immutable direct-ref CAS | An existing same-object direct ref is an idempotent retry; symbolic or different-object refs cannot be overwritten or followed. |
| Capability proposal recovery | Owner-private exact-object fetch and direct-ref CAS | A deleted proposal is fetched into `FETCH_HEAD`, validated against its reviewed authority, then installed under its exact private ref only if absent or identical. |
| Transport-intent remote publication | Existing `GitRemoteSession` asynchronous remote Git plus local tracking-ref CAS | Dry-run and publication preserve exact pre/post remote-ref observations and uncertainty handling without blocking the Node event loop on an unbounded remote command. |
| VS Code repository-root validation | Published async `repository.root` descriptor through the existing supervised runner | One local spawn with the existing deadline, cancellation, cleanup, and canonical filesystem check; no remote or credential behavior change. |
| Capability fsck and doctor | `repository.branch` | Fresh checkout branch; detached HEAD remains an explicit absence and is never inferred from a previous Story. Proposal and approved-map authority are unchanged. |
| Workspace bootstrap network doctor | Existing `GitRemoteSession` async probe, bounded by `gitWorkerCount` | Distinct URL-and-branch observations run concurrently within the configured worker limit; enterprise Git configuration, auth classification, cancellation and injected deterministic runner behavior are preserved. |
| World-Model authority refresh | Owner-private expected-OID ref deletion | Only the configured stale remote-tracking ref; unknown outcomes and races remain refused. |

These cutovers do **not** migrate the remaining direct Git operations in state, candidate,
ledger, workspace publication, organization/capability publication, or the VS Code runner. The
reviewed bypass baseline shrinks only for callers actually moved to registered reads; it does
not grant those remaining callers blanket approval.

The static bypass gate (`docs/git-bypass-audit.md`) freezes **new** production call sites; its
reviewed baseline is not a declaration that every legacy caller is safe or migrated. The new GAL
facade is foundational and is not yet a drop-in replacement for all public Git operations.
The current local `npm run check` passes, the VS Code suite passed 941/941 tests, and the focused
Git-owner matrix passed 591/591 tests under Node 22 with its supported TypeScript stripping flag.
The complete CLI shard nevertheless exceeded its 30-minute
deadline. Its GDP companion-freeze test also detected five companion hashes that were already
different at the clean starting commit: the packaged workflow template, WMB v4 document,
publication unit of work, migration registry, and initialization proposal. This increment updates
only the Auto Candidate companion hash it intentionally changed. The other five require their own
contract review; a mass hash refresh would conceal unrelated authority drift. Neither this CLI
run nor local macOS tests qualify the release.
The status cutover trial's ten processes were one executable version probe, five general repository
discovery probes, and four unborn-HEAD probes. Discovery is now three nonbare probes, but this
does not establish an end-to-end status speedup. A dedicated, fully checked branch-only observation
could reduce this further, but that path and its linked-worktree/deadline tests are not implemented.
Do not exchange a measured latency regression for a nominal cutover.
`remoteRef` verifies continuity of a caller-pinned origin URL; its `ownerPin` is not proof that
the revision was approved. An authority owner must validate and issue that pin before using an
observation for a governance decision. There is no production `remoteRef` cutover yet.
The measurement boundary, exact-byte parity, and current local figures are in
[Git access read-path qualification](GIT-ACCESS-LAYER-READ-QUALIFICATION.md).

## Operator and release rule

Keep the reference behavior and current guarded publication/recovery owners enabled. Migrate one
closed read descriptor at a time with byte, effect, authority, and refusal parity; never shadow a
mutation by executing it twice. Do not enable persistent transport or immutable caching as a
default until the corresponding cross-platform acceptance evidence exists. A failing office Git
probe must retain a typed, redacted cause and must never be “fixed” by disabling TLS, replacing
credentials, force-pushing, or deleting governed branches.

The snapshot revision read is the first production descriptor cutover with unchanged argv and
projection. Continue owner-by-owner migration, prioritizing state, candidate, ledger, workspace,
organization, and extension paths that still spawn Git directly. The physical Windows/office matrix and
independent release approval remain separate gates. Do not present the new local matrix cell as a
release-signing mechanism.
