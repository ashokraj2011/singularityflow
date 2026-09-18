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
| G1 — facade and reference transport | Partial. `src/git-access.mjs` separates executable and repository discovery, models HEAD/ref outcomes, verifies exact raw blobs through bounded asynchronous transport, and offers explicit invocation capture/disposal. Typed, byte-preserving status and index reads are now bound to the verified repository and pinned Git executable. | Complete typed tree, config, remote, and authorized-mutation APIs and their descriptor contracts; qualify the new asynchronous transport against the supported platform matrix. |
| G2 — reuse and batching | Partial. Existing exact ref-tree reads use pinned tree OIDs, raw batch reads verify object hashes and have count/byte chunks, and repository-context invalidation is conservative. | Complete dependency-specific epochs and barriers across mutation owners, object-domain cache keys, external-change/current-use witnesses, and reference-versus-cached parity. |
| G3 — mutation and extension migration | Partial. VS Code's remaining early Git probes now use its bounded asynchronous CLI adapter; the public GAL facade has no generic write escape hatch. | Migrate existing state, candidate, ledger, workspace, organization, and extension mutation/observation callers under closed authorized descriptors without duplicating effects. Preserve exact CAS and unknown-outcome recovery. |
| G4 — persistent object service | Partial. The existing FOS `cat-file` worker now verifies full-OID format and returned object hash, rejects replacement/lazy fetch, bounds frames and queue/pool, and retires changed profiles. | Shared reference/persistent conformance suite, physical Windows cleanup and cancellation evidence, explicit capability probes, and transport fallback parity. Persistent mode is not a new default. |
| G5 — qualification and rollout | Pending. Local focused tests, broad onboarding/ledger tests, project check, VS Code compilation, and the provisional macOS read measurement provide code-local evidence. The measured warm worker used fewer Git spawns but was slower than the reference helper, so no speedup is claimed. | Linux, macOS, Windows × Node 22/24 plus retained Node 20 compatibility; actual Git/office credential, proxy, linked-worktree, partial-clone, filesystem, package, VSIX, and performance evidence. A skipped required leg cannot count as qualified. |

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

The next priority is facade use by a selected read-heavy production path, followed by the
reference/persistent parity corpus. Mutation migration
and the physical Windows/office qualification matrix remain separate release gates.
