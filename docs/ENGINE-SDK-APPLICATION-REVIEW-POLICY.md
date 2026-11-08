# Portable application-review policy and record syntax

Application-review policy validation now belongs to the kernel's shared configuration rules.
The workflow compiler constructs it directly instead of accepting a native
`normalizeApplicationReview` callback. Its eight composition entries now include an explicit
record-byte syntax capability in that former callback's place. A caller cannot replace policy
admission with a function returning an accepted policy.

The kernel retains the original adoption modes, surfaces, preview paths, repair and capture
limits, inspection expectations and group-name syntax. The native code-delivery entry and
application-review policy facade expose the same functions and vocabulary. Launching an app,
capturing screenshots, recording evidence, proving group membership and receiving human
acceptance remain separate native/lifecycle responsibilities. Normalization grants none of them.

Code-delivery phase facts now share the existing phase-policy owner: test-scope selection,
code-generation projection, deterministic convergence, pinned authoring-skill selection and
the latest applicable delivered phase. User offers, Copilot commands and presentation wording
remain in the native code-delivery adapter.

## Record-format boundary

Foundation owns the unchanged application-review-policy v1 metadata and the JSON object reader.
The native schema registry consumes that metadata and delegates parsing to the same reader.
Its version admission, deterministic migration dispatch and returned migration history retain
their existing implementation. Stored records are never rewritten by this extraction.

The frozen `sflow-record-bytes/utf8-v1` capability has exactly `profile`, `isBytes` and `decodeUtf8`.
These are byte-value primitives, not record validation, backend selection or authority callbacks.
The native binding uses the original Buffer/Uint8Array classification and Buffer UTF-8 decoding;
there is no new decoder approximation. Foundation owns object cloning, JSON parsing, top-level
object checks and existing error/cause construction. Construction captures the functions without
calling primitives or accessing a function's `bind` property. Caches retain function bindings,
never parsed records, validation results or authority.

The shared schema keeps its original v1 readable range, unversioned-as-v1 behavior and immutable
record metadata. The exported ARA wire stamp now derives from that metadata; its value remains 1.
The native record module adds the internal `NODE_RECORD_BYTES` binding alongside its existing
UTF-8 digest binding. CLI/skill results, SDK operation names and persisted policy hashes do not
change.

## Compatibility evidence

The pre-edit baseline at `480cb42d1` records 54 policy outcomes (23 accepted and 31 exact failures),
17 phase facts and 24 record-reader outcomes. It includes all supported surfaces, finite-limit
boundaries, preview path errors, schema version failures, null-prototype objects, Buffer and
Uint8Array values, malformed UTF-8, BOMs, detached bytes and shared bytes. Nine rule bodies and
six constant definitions retain their original syntax; the sole policy-body substitution binds
the same schema admission to explicit parsing. The original native parser remains recorded in
the fixture, and deterministic migration dispatch retains its exact original body fingerprint.

The runtime and marketplace configuration dependencies, complete namespace-backed Story
execution, verified authority migration and final distribution/performance qualification remain
required milestones. This slice does not migrate installed Git authority or complete the SDK.

## Mac qualification

The affected suite passed 390 tests across 40 files with no failures, skips or cancellations.
It covers native record migration and golden history, all captured configuration/compiler
outcomes, application-review and human acceptance journeys, authoring and outcome continuation,
workflow intent and actual SDK/VS Code package consumers. A final nine-test policy run also
passed, including an additional child-process check: validation and byte parsing execute from
an empty directory with no Git executable on PATH and create no machine or checkout state.

Source validation passed 3,760 checks, VS Code typechecking passed and the Git-boundary audit
retains its 2,011 registered production sites. All thirteen existing bundle limits pass. The
extension has 152 modules and 1,288,167 bytes; prewarm has 23 modules and 104,331 bytes; the gateway
has 851 modules and 6,824,464 bytes. No bundle budget was raised. Windows CI, live providers,
installed-project migration and complete namespace runtime qualification were not run in this
Mac-only slice.
