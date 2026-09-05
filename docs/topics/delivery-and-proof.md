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
version: 2
---
Governed Delivery and Proof (GDP) projects the same Candidate and deterministic proof system across
Workflow mode and bounded Outcome mode. It is opt-in. Existing Stories keep their creation-pinned
workflow, approval, evidence, and publication rules.

## Purpose and prerequisites

Use GDP to recommend a delivery mode, inspect proof observations, or create an explicitly
developer-local signed test receipt. Run it only inside the selected governed repository. A local
runner additionally requires one reviewed `qualityCommands` entry whose command is an argv array
and whose `modelPolicy` is `never`. Missing AST, World Model, language adapters, or enterprise
providers remains explicit and does not block non-enrolled work.

## Use it from each surface

**Shell:** Run `singularity-flow delivery --help`, then use one exact `delivery` synopsis.

**Copilot:** Use `/sf-inspect` for read-only delivery, Passport, proof, and readiness explanations,
or `/sf-adhoc` for bounded Outcome authoring. Copilot never turns a recommendation into a selection
or submits a confirmation automatically.

**VS Code:** Open Diagnostics for shadow Passport and proof observations. Use the existing Ad Hoc,
Story, SGOS, approval, and publication views for authoritative transitions.

## Guided workflow

`singularity-flow delivery recommend --request-file <file> --json` reads a bounded, repository-local
request and recommends Workflow or Outcome mode. The recommendation is deterministic and changes
nothing. Outcome selection requires the exact returned digest through `delivery select`; risky,
multi-repository, credentialed, externally consequential, protected-path, architectural, public
contract, or migration work is routed to Workflow mode. Selection reuses the existing Ad Hoc
session and recoverable publication transaction rather than creating another commit or push path.

`delivery workflow-status <WORK-ID>` builds a read-only Passport projection for creation-pinned
Feature and Bugfix workflows. Other profiles remain explicitly unmapped. `delivery
execution-status <PROCESS-ID>` joins that projection to the existing SGOS process and checkpoints;
it is not another executor.

Outcome-to-Workflow promotion is a handoff. Preview binds the Ad Hoc session, baseline, branch,
HEAD, change set, target Work ID, and workflow profile. Apply requires that exact digest and records
only the existing promotion checkpoint. It does not start a Story, commit application bytes, push,
discard work, or weaken proof obligations. `delivery promotion-status` shows the recoverable next
argv array.

`delivery assurance-evaluate --evidence-file <file>` evaluates path-free SHA-256 references for
changed executable regions, test results, witnesses, and mutation observations. It executes no
product code, invokes no model, writes nothing, and never blocks ordinary work. Even complete local
evidence reports `authority: none`, `gateEligible: false`, and
`RUNNER_AUTHENTICATION_UNAVAILABLE` until an approved hermetic runner is configured.

For an opt-in, machine-local signed observation, use `delivery local-runner-create`,
`local-runner-plan`, `local-runner-run`, and `local-runner-verify`. This route executes only a
configured shell-free, model-free quality command. It creates a tamper-evident receipt but remains
non-gating because the developer and runner share one local user. See
`docs/GDP-LOCAL-SIGNED-RUNNER.md` for the complete procedure and assurance boundary.

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

## State and safety

All delivery diagnostics and local-runner operations are model-free. Files must be
repository-relative and bounded. A local receipt reports `authority: developer-local`,
`gateEligible: false`, and `consumedByLifecycle: false`; its signature detects later alteration but
does not create independent review. Proof-gap decisions still require exact human authority and
expiry. Existing Ad Hoc, Story, SGOS, approval, publication, and sync commands remain the only
authorities for their state transitions.

## Troubleshooting

If a plan is stale, regenerate and review it; never copy an earlier digest. If a command is refused,
confirm that it exists in `qualityCommands`, uses structured argv, has `modelPolicy: never`, and is
being run from the repository revision named by the plan. If signature verification fails, preserve
the receipt and signer state for diagnosis rather than recreating evidence. An unavailable provider
or runner is a visible gap, not a pass and not a reason to block ordinary unenrolled work.

## Related topics

Read `ad-hoc-work` for Outcome authoring, `governed-execution` for SGOS execution,
`evidence-and-ledger` for evidence boundaries, and `story-lifecycle` for authoritative phase
transitions. The detailed local procedure is in `docs/GDP-LOCAL-SIGNED-RUNNER.md`.
