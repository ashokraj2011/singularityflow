# Semantic next-step planning

`story.next` is a registered read operation. Its `storyNext.load` port supplies an accepted Story
aggregate and a bounded observation object. `kernel/next-plan.mjs` chooses the ordered actions;
the SDK returns a `sflow-next-steps/v1` manifest. It neither invokes those actions nor admits a
future mutation. Authority, final binding, test execution and advancement remain unestablished.

The shared planner covers publication retry, recovery, archived/completed Stories, pending human
routing choices, applicability, current-phase authoring, source review, after-step delivery, MCP
readiness, visual coverage, model-free producers, required inputs, approval holds and subsequent
phases. It replaces semantic approval or completing-submission actions when owner decisions are
owed. These rules no longer identify business actions by matching rendered shell strings.

External observations use counts, flags and references to captured host facts. They cannot contain
injected action arrays, commands, prompt text or authority claims. The model mode is explicit.
The port binds the requested Story; malformed observations, cancellation and original native
read failures remain distinct. A failed read is not converted to a successful empty manifest.

Actions expose their kind, timing, subject, phase and relevant prerequisites. Extracted operations
also carry registry-derived operation IDs, inputs and port names. A null operation means the
effect has no extracted executor yet; it does not license an SDK consumer to invent a shell
command. Host-specific approval, setup and visual routes refer to the captured observation by
index. They remain host responsibilities until their semantic operation is extracted.

## Native compatibility

`engine-compatibility/git-nextsteps.mjs` captures the existing native observations once. It accepts
the already-loaded execution context used by CLI and agent entry, or explicitly resolves it for
the in-process API. The native CLI projects the actual `story.next` result through `nextsteps.mjs`.
Current Copilot/Shell/VS Code wording, ordering, pending-decision routing and host overlays stay
unchanged. Context resets, local attachment re-upload and local task progress retain their
existing explicit host handling; this query does not make those local records shared authority.

Guide, source-review and governance-hold presentation now have one native owner in
`phase-transition-routes.mjs`. The original modules remain identity-preserving compatibility
exports. Deferred native reads have a compatibility owner rather than importing command handlers.

The executable registry stores handler identifiers as data. The general SDK composition binds
every existing coordinator; the private native next-step composition binds the exact same read
coordinator to the same dispatcher. It is not another operation implementation or a public
feature-specific SDK. Its unbound operations still fail explicitly.

Kernel package metadata declares side-effect-free initialization for bundling. Architecture tests
check this promise: no side-effect-only imports, executable top-level statements, arbitrary
initialization calls, assignments or host capabilities are admitted. Together with the narrow
composition, this keeps native query planning from retaining unrelated write coordinators and
native domains. It does not claim that unbundled ESM imports load only one operation's source.

## Verification and scope

The compatibility fixture was captured from `63ba8a1e9` before production edits. It binds 50
complete native snapshots and rendered text, including custom phases, repair/readiness holds,
manual/deterministic paths and remote landing policies. Additional checks compare the complete
and narrow SDK compositions, refuse injected or oversized observations and mismatched subjects,
preserve real error/cancellation identities, and execute without infrastructure imports or PATH.
The real CLI parity case captures its actual SDK receipt, projects that exact plan and compares
the bundled CLI, while checking the accepted aggregate and source commit remain unchanged.

This advances Phase 5. It does not complete the remaining native policy extraction, portable
lifecycle writers, namespace-backed full Story execution, authority migration or distribution
qualification. Existing Git authority and all human approval gates remain unchanged.

Mac qualification on Node 26.12.0 passed 354 checks across 44 files, with no failures, skips or
cancellations. It includes the registered query and real source/bundled CLI receipt projection,
all engine coordinator unit suites, native publication/submission/approval/rejection journeys,
the installed SDK archive and dependency guards. Source validation passed 3,702 checks, VS Code
typechecking passed, and the Git ownership audit found no new bypasses among 2,011 sites. All 13
unchanged runtime bundle budgets passed; the gateway remains 852 modules / 6,785,039 bytes. The
registry has 42 operations. No Windows, hosted CI, provider, installation, push, merge, real Story
or existing-project storage-authority change was performed.

After removing the duplicate presentation observation pass, the final focused rerun passed 65
checks across seven files, again with no failures, skips or cancellations. It includes a regression
that refuses repeated fact reads during rendering and verifies publication/recovery priority.
The final source check and all bundle budgets were repeated successfully.
