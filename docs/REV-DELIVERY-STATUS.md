# REV delivery status and activation boundary

The source specification is `SPEC-REV-Revision-Loop-Strong-v0.6.md`. Its decision owner and validator are still unset; it explicitly forbids default activation without its release gate. This document records the implemented slice and the remaining work without treating attachment intake as an executable Revision Loop.

## Available now

- `revision attachments capabilities|preview|register|list|status|remove-preview|remove` binds private feedback evidence to an exact Story, phase generation, HEAD, source tree, configuration, workflow, feedback digest, and repository identity. Registration and exclusion require separate exact confirmations. Exclusion is append-only; it does not erase historical proof.
- Shell selection supports up to five explicit files, one-based file selection, and bounded line ranges. The default local-file formats are `.txt`, `.md`, `.json`, `.csv`, and `.tsv`. CSV/TSV preserve selected-row provenance. Binary PDF/DOCX/image intake has a tested provider interface but no installed production scanner/extractor, so it fails closed.
- VS Code `@sflow /attachments` can preview 1–5 genuine local file URIs, selecting each whole file, and offer a one-use confirmation button for private registration. Native status and reviewed exclusion controls are available. It cannot ingest opaque Copilot upload bytes or editor ranges. The shell skill remains available for line-range selection.
- The deterministic route and packet kernel can validate exact attachment-set and retained-candidate bindings. The exposed runtime capability explicitly reports code-revision execution unavailable. No model invocation, revision interval, candidate publication, or Story lifecycle transition occurs through the attachment commands.
- A revoked set cannot be resurrected by replaying its registration key. Expired, unreferenced private preview plans are pruned on ordinary preview access. Attachment status reads bounded receipt/revocation metadata without rehashing every stored file and marks object integrity as not checked; a proof read verifies the selected bytes, while a full list verifies all registered objects.

## Not yet an activated REV loop

`REV_POC_SINGLE_REPO` and `REV_FULL_DEFAULT` are both disabled. Before any code-revision mutation can be offered, the engine needs a phase-bound durable loop head and interval journal, atomic candidate/head/precheck compare-and-swap, isolated execution with effect resolution and quiescence proof, and an exact selected-candidate Story publication gate. An executor must recheck attachment revocation and current routing under its own lock immediately before consuming bytes or committing effects. Existing SGOS/Auto candidate APIs do not jointly provide those guarantees.

The attachment preview currently stages a short-lived private plan; it is not a read-only operation as stated in the draft spec. The CLI reports `stateChanged` and `filesChanged` for that private staging and leaves the Story worktree and Git refs unchanged. Either the specification must explicitly permit this private-plan effect or the preview protocol must be redesigned and witnessed before claiming full conformance.

The default text intake has bounded UTF-8, type, secret, and provenance checks, but no installed organization-approved malware/content scanner. All binary intake and all REV execution therefore remain disabled; scanner and privacy clearance must be witnessed, not inferred from parser tests. Crash-orphan private bytes are recovered on the next append, but a timed quarantine expiry service is not installed.

Native chat selection is all supplied whole files; fine-grained line/row selection remains shell-only. A two-step register-then-revoke sequence can replace an attachment set, but it is not an atomic replacement.

## Release gate

Do not label this feature “REV complete” or enable a mutating `/sflow-revise` skill until the specification has a decision owner and validator, the applicable witness matrix passes on macOS, Linux, and Windows, and the exact active profile is included in a generated release manifest. The command capability response is the operational source of truth for the installed build.
