# Git Access Layer implementation status

**Source reviewed:** `SPEC-git-access-layer (1).md`, SHA-256 `de3e0df8db9fc00880fc58c14a3f7d047499b77250fc44f13002bef0a6d0f15a`

**Last reviewed:** 2026-09-18
**Status:** incremental implementation; the full GAL specification is **not release-complete**.

The current increment strengthens existing Git owners without changing the authority model or
switching every caller to a new runtime. Do not describe a passing local test as Windows or office
qualification. The original specification's 44 acceptance cases remain the completion contract.

| Milestone | Current position | What remains before claiming completion |
| --- | --- | --- |
| G0 — contracts and baseline | Partial. A static production process-site baseline and check gate are recorded in `scripts/git-bypass-baseline.json`. A reproducible local read benchmark now separates cold discovery, reference batch, and warm worker timing. Existing environment, remote, publication, and object owners are preserved. | Complete descriptor/effect and owner inventory, including runtime probes for indirect Git execution; independently review benchmark profiles on the supported matrix. |
| G1 — facade and reference transport | Partial. `src/git-access.mjs` now includes typed byte-preserving tree, refs, and approved-config reads, in addition to HEAD/ref, status/index, and exact raw blobs. A capability provenance path uses the facade in shadow mode while retaining its existing reference result. | Remote and authorized-mutation descriptor contracts, more production read cutovers, and supported-platform qualification. Shadow mode is not an authoritative cutover. |
| G2 — reuse and batching | Partial. Existing exact ref-tree reads use pinned tree OIDs and raw batch reads verify object hashes with count/byte caps. `RepoContext` now tracks instance/configuration/shared/worktree generations, mutation barriers, and discovered linked-worktree invalidation. | Apply the scoped barriers across all mutation owners, prove external-change/current-use witnesses and temporary-index isolation, and qualify cached/uncached parity across processes and platforms. |
| G3 — mutation and extension migration | Partial. VS Code's remaining early Git probes now use its bounded asynchronous CLI adapter; the public GAL facade has no generic write escape hatch. | Migrate existing state, candidate, ledger, workspace, organization, and extension mutation/observation callers under closed authorized descriptors without duplicating effects. Preserve exact CAS and unknown-outcome recovery. |
| G4 — persistent object service | Partial. The FOS `cat-file` worker verifies full-OID format and object hash, rejects replacement/lazy fetch, bounds frames and queue/pool, and retires changed profiles. A shared reference/persistent fixture covers exact bytes, malformed frames, cancellation, cleanup, and a local partial clone. Profile discovery is now bounded and asynchronous; a replacement cannot start after unverified cleanup. | Physical Windows/Linux cleanup, cancellation and worktree-removal evidence, explicit capability probes, valid multi-frame batch/coalesced-subscriber support, and transport fallback qualification. Persistent mode is not a new default. |
| G5 — qualification and rollout | Partial local harness. `npm run test:platform:gal` records one bounded, source-bound platform cell and the 10-trial 500-object read benchmark. Dirty sources cannot yield `local-pass`; all results state `releaseQualified: false`. Local development evidence is macOS arm64, Node 25, Git 2.54. The warm worker uses fewer Git spawns but is slower than the reference helper, so no speedup is claimed. | Linux, macOS, Windows × Node 22/24 plus retained Node 20 compatibility; Windows-equivalent cases for currently POSIX-only fixtures; actual office credential, proxy, linked-worktree, filesystem, package/VSIX and performance evidence; independent signed source/artifact review. A skipped required leg cannot count as qualified. |

The static bypass gate (`docs/git-bypass-audit.md`) freezes **new** production call sites; its
reviewed baseline is not a declaration that every legacy caller is safe or migrated. The new GAL
facade is foundational and is not yet a drop-in replacement for all public Git operations.
The measurement boundary, exact-byte parity, and current local figures are in
[Git access read-path qualification](GIT-ACCESS-LAYER-READ-QUALIFICATION.md).

## Operator and release rule

Keep the reference behavior and current guarded publication/recovery owners enabled. Migrate one
closed read descriptor at a time with byte, effect, authority, and refusal parity; never shadow a
mutation by executing it twice. Do not enable persistent transport or immutable caching as a
default until the corresponding cross-platform acceptance evidence exists. A failing office Git
probe must retain a typed, redacted cause and must never be “fixed” by disabling TLS, replacing
credentials, force-pushing, or deleting governed branches.

The next priority is completing one production read cutover with exact semantic parity, then
closed mutation descriptors and owner-by-owner migration. The physical Windows/office matrix and
independent release approval remain separate gates. Do not present the new local matrix cell as a
release-signing mechanism.
