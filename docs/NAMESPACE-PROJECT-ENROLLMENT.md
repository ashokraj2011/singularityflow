# Explicit namespace project enrollment

`project.enroll` is a version-1 SDK operation for establishing a new project's lifecycle
authority. It removes fixture-only authority seeding as a prerequisite for the future portable
runtime. The operation is exposed by the explicit `hosts/namespace-project` package entry.
Installed CLI, VS Code, Copilot, Git configuration and Story routing do not select this host.

The application chooses a namespace scope, qualified shared metadata and content ports, and an
authority ID at epoch one. Factory construction validates these bindings without reading or
writing project data. A request supplies only a stable logical operation ID. Project selection,
identity, permission, clock, epoch and store bindings are construction-time ports or fresh host
facts; they cannot be passed as request fields.

## Admission and coordination

The SDK registry owns the load, retained, prepare, commit and finish sequence. Pure kernel rules
validate the project binding, fresh access facts, canonical timestamp and returned acknowledgement.
The application owns `access.current`; it supplies a principal and the current `project.enroll`
permission for the exact project. Permission is checked before preparation and again before the
commit. A pending intent must resume under its original principal. This operation confers no
phase approval, visual witness, test pass or configuration approval.

The namespace host performs persistence through the qualified SDA ports. It does not discover a
repository, run a command, import provider code, use the current directory or select a machine's
installed configuration. It verifies and captures the supplied port methods and store identities.
The namespace lifecycle committer rejects project operations: enrollment cannot be relabelled as
a mutation of an existing Story body.

## Durable records and retries

The foundation owns the frozen v1 enrollment-intent and enrollment-manifest schema families.
An immutable `runtime/enrollment/prepared/<digest>` record precedes activation. It retains the
operation ID, exact parameter/store binding, principal, timestamp, requested authority and digest
of the original final transaction. A retry never replaces those values with current observations.
Future or malformed records are refused with their schema failure preserved.

The final conditional metadata transaction requires the authority and operation manifest to be
absent. It writes `state/authority/lifecycle`, an immutable
`evidence/enrollment/operations/<digest>` manifest, one `engine.project-enrolled` event and its
receipt atomically. The prepared intent has a separately verified transaction receipt. Both
record and transaction revisions remain opaque; receipt record order is immaterial.

Concurrent attempts for the same operation reconcile the first accepted intent, including its
original timestamp. Different intents cannot overwrite an existing authority. Permission loss
or principal changes leave the prepared intent intact. Unknown outcomes preserve the original
SDA error and require inspection through the same operation ID. A known accepted receipt is
acknowledged even if cancellation arrives after its commit. Replaying accepted enrollment is
read-only and does not require permission for a new effect.

Existing, fenced or differently bound authorities are never replaced or reactivated. Enrollment
does not adopt unrelated records or import an existing project. Verified export/import, old-writer
fencing, authority-epoch cutover and uncertain source-control effects remain Phase 8 work.

## Remaining runtime work

Enrollment establishes an authority only. It neither compiles nor approves workflow configuration
and cannot create or execute a Story. Production configuration validation, Story initialization,
local generation coordination and complete lifecycle ports remain required for Phase 7. The
independent storage tests and empty-PATH package consumer prove enrollment, not a complete
headless Story or human approval journey.

## Qualification

Mac qualification on Node 26.12.0 passed 396 tests across 22 files, with no failures,
cancellations or skips. Thirty-six enrollment cases exercise real filesystem, SQLite and
application-owned metadata stores. They cover fresh access checks, lost permissions, changed
principals, competing authorities, concurrent retries, scope isolation, immutable intent,
future records, receipt faults, cancellation and unknown prepare/commit acknowledgements.
For each backend, a separate empty-PATH process resumes the SDK's prepared intent without
obtaining a new timestamp; import hooks refuse Git, filesystem discovery and providers.

The actual SDK archive installs in a separate Node consumer. Two processes enroll and replay
through its public package entry with an empty PATH. NodeNext declaration checks require the
operation ID and reject caller-supplied identity. Existing native workflow journeys, CLI/SDK
publication parity, VS Code packaging, namespace conformance, crash/durability and terminal-state
checks passed in the same run.

Source validation passed 3,738 checks. VS Code typechecking, the Git ownership audit (2,011
sites), all 13 existing bundle budgets and whitespace checks passed. The gateway is 849 modules
and 6,802,642 bytes; no budget was raised. Tests use isolated repositories, stores and machine
state. No Windows, hosted CI, live provider, real-workspace change, installed-project migration,
product installation, push or merge was performed.
