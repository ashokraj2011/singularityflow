# REV delivery status and activation boundary

The source specification is `SPEC-REV-Revision-Loop-Strong-v0.6.md`. Its decision owner and validator are still unset; it explicitly forbids default activation without its release gate. This document records the implemented slice and the remaining work without treating attachment intake as an executable Revision Loop.

Check the installed execution boundary with `singularity-flow revision capabilities --json`; run `singularity-flow revision activation --json` from a repository to see its exact pilot prerequisites. Both commands are read-only. A result of `activationProfile: "disabled"` means there is no safe command or configuration toggle to start a code revision loop in that build.

## Available now

- `revision attachments capabilities|preview|register|list|status|remove-preview|remove` binds private feedback evidence to an exact Story, phase generation, HEAD, source tree, configuration, workflow, feedback digest, and repository identity. Registration and exclusion require separate exact confirmations. Exclusion is append-only; it does not erase historical proof.
- Shell selection supports up to five explicit files, one-based file selection, and bounded line ranges. The default local-file formats are `.txt`, `.md`, `.json`, `.csv`, and `.tsv`. CSV/TSV preserve selected-row provenance. Binary PDF/DOCX/image intake has a tested provider interface but no installed production scanner/extractor, so it fails closed.
- VS Code `@sflow /attachments` can preview 1–5 genuine local file URIs, selecting each whole file, and offer a one-use confirmation button for private registration. Native status and reviewed exclusion controls are available. It cannot ingest opaque Copilot upload bytes or editor ranges. The shell skill remains available for line-range selection.
- The deterministic route and packet kernel can validate exact attachment-set and retained-candidate bindings. The exposed runtime capability explicitly reports code-revision execution unavailable. No model invocation, revision interval, candidate publication, or Story lifecycle transition occurs through the attachment commands.
- A revoked set cannot be resurrected by replaying its registration key. Expired, unreferenced private preview plans are pruned on ordinary preview access. Attachment status reads bounded receipt/revocation metadata without rehashing every stored file and marks object integrity as not checked; a proof read verifies the selected bytes, while a full list verifies all registered objects.

## Internal foundations, not an activated REV loop

The implementation now has an append-only, machine-local loop journal with selected-head CAS and precheck binding; a pure head-bound precheck; exact application-tree publication selection; private isolated declarative attempt and immutable child-candidate freeze; a manual-capture planner; and candidate-bound Code-check planning, probe, and result projection. Story publication has a disabled-by-default internal opt-in that checks the selected head before Story-owned writes, checks the admitted application tree, and records a private local commit attestation. If the attestation write fails after the ref advances, both remote and local-only modes retain an exact pending marker; sync completes that attestation before pushing or clearing the marker. These are tested primitives, not a `/sflow-revise` execution route.

The Code-check probe deliberately returns `observed-unverified`, even when an injected executor exits successfully. It is not a trusted isolated test runner, a verified result receipt, a Testing/Verification phase verdict, or publication authority. The context reader likewise refuses CLI-only use when it cannot establish the editor's unsaved-buffer state. A self-hashed receipt or user assertion is not substituted for that observation.

A fixed-worker broker can now execute bounded declarative write/delete/wait operations and return non-promoting exact bytes after cleanup. It does not run model agents, shell commands, or tests, cannot itself admit a retained Candidate, and cannot satisfy the pilot Code-check or witness requirements. The pilot activation inspector names those gaps rather than inviting a flag-only override.

`REV_POC_SINGLE_REPO` and `REV_FULL_DEFAULT` remain disabled. The REV trace manifest in this working tree names the disabled loop profile, advertises no loop-execution or Code-result mutations, and explicitly defers their applicable criteria. Feedback-attachment intake is a separately available, confirmed mutation and is not certified by this disabled loop trace. Release packaging checks the manifest even when the full test suite is skipped. Changing a flag alone cannot activate the pilot.

## Remaining activation work

- Install a trusted editor-buffer observation adapter and approved-intent/route/proof binding readers for the current Story Code phase. The raw CLI cannot see unsaved VS Code/Copilot buffers; it must refuse until a trusted host proves they were saved or captured.
- Install an isolated model/code executor with process-tree quiescence, denial of agent Git mutations, bounded effects, and recovery for uncertain external effects. The present declarative edit driver cannot run an arbitrary agent or project test command.
- Align the approved quality-command definition, candidate-tree test-body hash, adapter identity, and signed/durable Code-check receipt. Then add a separate, explicit `revision.checks.run` operation and show real results without merging them into the later Testing/Verification verdict.
- Wire route, packet, manual capture, interval CAS, precheck, and selected-candidate publication into one guarded user-facing pilot command and skill. Add compare/discard/restore UX and an explain chain before advertising the loop.
- Complete the closed `REV_POC_SINGLE_REPO` criterion-to-test witness map and macOS/Linux/Windows fault tests. Default activation additionally requires the specification's decision owner and validator, the full applicable gate, and a current release manifest.

An executor must recheck attachment revocation and current routing under its own lock immediately before consuming bytes or committing effects. No public command currently joins all of the above primitives into that safety boundary.

The attachment preview currently stages a short-lived private plan; it is not a read-only operation as stated in the draft spec. The CLI reports `stateChanged` and `filesChanged` for that private staging and leaves the Story worktree and Git refs unchanged. Either the specification must explicitly permit this private-plan effect or the preview protocol must be redesigned and witnessed before claiming full conformance.

The default text intake has bounded UTF-8, type, secret, and provenance checks, but no installed organization-approved malware/content scanner. All binary intake and all REV execution therefore remain disabled; scanner and privacy clearance must be witnessed, not inferred from parser tests. Crash-orphan private bytes are recovered on the next append, but a timed quarantine expiry service is not installed.

Native chat selection is all supplied whole files; fine-grained line/row selection remains shell-only. A two-step register-then-revoke sequence can replace an attachment set, but it is not an atomic replacement.

## Release gate

Do not label this feature “REV complete” or enable a mutating `/sflow-revise` skill until the applicable witness matrix passes on macOS, Linux, and Windows and the exact active profile is included in a generated release manifest. Default activation also requires the specification's decision owner and validator. The command capability response is the operational source of truth for the installed build.
