---
id: delivery-and-proof
title: Governed Delivery and Proof
aliases:
  - delivery-mode
  - outcome-mode
  - change-passport
  - proof-readiness
commands:
  - delivery
related:
  - ad-hoc-work
  - governed-execution
  - evidence-and-ledger
  - story-lifecycle
version: 1
---
Governed Delivery and Proof (GDP) projects the same Candidate and deterministic proof system across
Workflow mode and bounded Outcome mode. It is opt-in. Existing Stories keep their creation-pinned
workflow, approval, evidence, and publication rules.

## Choose delivery without granting authority

`singularity-flow delivery recommend --request-file <file> --json` reads a bounded, repository-local
request and recommends Workflow or Outcome mode. The recommendation is deterministic and changes
nothing. Outcome selection requires the exact returned digest through `delivery select`; risky,
multi-repository, credentialed, externally consequential, protected-path, architectural, public
contract, or migration work is routed to Workflow mode. Selection reuses the existing Ad Hoc
session and recoverable publication transaction rather than creating another commit or push path.

Use `/sf-inspect` in Copilot for read-only delivery, Passport, proof, and readiness explanations.
Use `/sf-adhoc` for the existing bounded Outcome authoring and landing journey. Copilot does not
turn a recommendation into a selection or run a confirmation automatically.

## Inspect Workflow, execution, and promotion

`delivery workflow-status <WORK-ID>` builds a read-only Passport projection for creation-pinned
Feature and Bugfix workflows. Other profiles remain explicitly unmapped. `delivery
execution-status <PROCESS-ID>` joins that projection to the existing SGOS process and checkpoints;
it is not another executor.

Outcome-to-Workflow promotion is a handoff. Preview binds the Ad Hoc session, baseline, branch,
HEAD, change set, target Work ID, and workflow profile. Apply requires that exact digest and records
only the existing promotion checkpoint. It does not start a Story, commit application bytes, push,
discard work, or weaken proof obligations. `delivery promotion-status` shows the recoverable next
argv array.

## High-assurance observations

`delivery assurance-evaluate --evidence-file <file>` evaluates path-free SHA-256 references for
changed executable regions, test results, witnesses, and mutation observations. It executes no
product code, invokes no model, writes nothing, and never blocks ordinary work. Even complete local
evidence reports `authority: none`, `gateEligible: false`, and
`RUNNER_AUTHENTICATION_UNAVAILABLE` until an approved hermetic runner is configured.

Missing AST, World Model, language adapters, runners, or exact evidence remains `unavailable`; it
does not become a pass and does not block non-enrolled work. Proof-gap decisions require exact
human authority and expiry, and no automatic gap-acceptance writer is exposed.

## Provider provenance and GA readiness

`delivery provenance-status` reports no provider configured by default. Supplying a reviewed,
repository-relative provider descriptor still reports unavailable because the shipped product does
not contain an enterprise trust root or cryptographic verifier. The descriptor contains only IDs
and digests, never credentials. Signed build, environment, deployment, runtime identity, and
production observation envelopes remain unusable as authority until an approved verifier is
injected.

`delivery readiness` is an honest support and blocker report. It always reports `gaReady: false` in
this release. It lists missing authenticated-runner evidence, provider pilots, platform/package
release receipts, migration exercises, the observation window, and duplicate-path dependency
proof. The current OS and Node labels are diagnostic labels, not cross-platform release evidence.

## Safety and recovery

All delivery diagnostics are model-free. Files must be repository-relative and bounded. Exact
confirmation plans become stale when their bound repository, configuration, session, Candidate,
or change set changes. Retry by regenerating and reviewing the plan; never copy a stale digest.
Existing Ad Hoc, Story, SGOS, approval, publication, and sync commands remain the only authorities
for their state transitions. GDP projections do not bypass those systems.
