# Registered Story status observations

`engine.run('story.status', { workId })` returns a body-free record observation. The optional
`workId` is the canonical logical Story ID. It is not a branch, checkout path, session ID or
authorization token. The operation has one `storyStatus` port, with `load` and `read` stages.

The manifest carries the observed Story status, current phase, ordered phase IDs and generations,
recorded evidence counts, source kind/revision, and retained-publication state. Phase names come
from the record; custom workflows need no named-phase dispatch. The kernel owns the recorded
counts used by both this query and native next-step planning. Invalidated approvals are omitted
from those counts. A counted approval, including a self-approval, does not prove an independent
review, approval quorum or clause acceptance. A recorded check does not run a test.

Incomplete legacy phase/evidence inventories remain explicit diagnostics, with
`inventoryComplete: false` and unknown phase values represented by `null`. They are not silently
converted into a complete zero-count inventory. Source, artifact, prompt and history bodies stay
outside the manifest. The result cannot establish authoring admission or mutation authority:
`authorityVerified`, `finalBindingChecked` and `acceptanceChecked` are all false.

Publication states are distinct:

- `pending`: a retained local transition still needs reconciliation/publication;
- `unreadable`: its acceptance is unknown, with the original failure code, message, details and
  cause available in diagnostics; the native error object remains private to the host;
- `not-retained`: no marker was returned by the existing reader, without claiming remote acceptance.

The native compatibility observer owns repository selection and publication-record reads. CLI
branch/Jira aliases and an already-selected record are trusted host composition options, not new
SDK input fields. Ordinary JSON, human and `--git-shadow` status paths enter the same registry
operation. Their original native JSON and recovery commands remain adapter presentation. Warm
workers use that observer directly instead of importing the status command handler. Existing
read scopes and registered one-spawn repository/branch selectors are preserved; the query does
not add accepted-configuration, submission, session, remote or Git-history checks.

The packaged pure SDK can execute this operation with an application-supplied snapshot port,
without Git, a filesystem or implicit discovery. The existing namespace document-read projection
does not contain a complete lifecycle aggregate, so it is not presented as a status or approval
authority. A production namespace lifecycle/status port remains part of Phase 7.

This slice extracts observations and one shared counting rule. Native next-action routing,
submission-readiness checks, progress/report queries and remaining lifecycle rules still need
their own registered boundaries. No installed project, storage authority or workflow policy is
changed by this query.

Mac qualification on Node 26.12.0 passed 90 checks across the status, source/bundled CLI, worker,
next-step, SDK package and architecture suites, with no failures, skips or cancellations. The
installed archive executed a custom-phase status port with infrastructure imports refused and an
empty executable path. All 13 unchanged runtime bundle budgets, VS Code typechecking, 3,688
source checks and the Git ownership audit passed. No Windows, hosted CI or provider run was used.
The bundle guard now names the current native inspection/checkpoint owners instead of the
obsolete `completePhaseEntry` compatibility wrapper, which is removed by tree shaking.
