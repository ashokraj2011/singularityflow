---
id: compact-phase-entry
title: Compact phase entry for Copilot
commands: [phase, nextsteps, inputs, review-source]
aliases: [phase-entry]
related: [artifacts-and-generation, approvals]
version: 3
---
# Compact phase entry for Copilot

`singularity-flow phase enter --for-agent --json` combines pause, selected checkout and agent
binding, accepted phase policy, recovery, clarification and reference verification. It is a
model-free read. Pause is checked before Git, workspace discovery or loading Story context.

`ready` describes the checkout/session binding, not publication, passing tests or approval.
Inspect the returned recovery actions and clarification status. Protected/unrelated changes,
required human confirmations and immutable-generation repair still use their exact existing routes.

After reviewing that entry packet, use:

```sh
singularity-flow phase enter PHASE --work-id WORK-ID --compose --for-agent --json
```

Composition is an explicit mutation of preparation context/audit only, through the existing
composer. It returns `context.text` once and reuses verified immutable prompts when unchanged.
It does not begin or prepare a generation, run tests, commit, push or advance a phase. A retained
publication is not implicitly replaced by a successor. A different Story must be attached first.

A current, verified source review requiring author correction returns
`status: successor-preparation-required`, `successor.targetGeneration` and the exact
`successor.preparation.command`. `/sf-phase` reviews recovery/diffs, executes that explicit
preparation once and refreshes entry before composing. Read-only entry, including `--compose`,
cannot reserve the successor or edit the retained publication. Submitted phases, pending human
dispositions, unverifiable bindings and consumed code intents keep their guarded routes.
This classification uses phase policy, not built-in phase names, including copied/custom workflows.

`/sf-code` and `/sf-phase` consume these packets instead of separate pause/session/status,
recovery, clarification and reference commands. Standalone agents retain a boundary fallback;
they reuse only a verified packet from the current invocation, never an earlier chat's selection.

`/sf-next` begins with `singularity-flow nextsteps --for-agent --json`. That read checks pause
before routing and returns the active binding plus the first enforced-input preview, without
searching skill directories or reading draft documents. Its delegated `/sf-inputs` action uses
that preview and runs `singularity-flow inputs PHASE --for-agent --json` once. Standalone
`/sf-inputs` first previews with `singularity-flow inputs --dry-run --for-agent --json`.

Recording still revalidates the active binding, approved hashes, sequence, agents and preparation
gates. The response identifies the exact audit and artifact paths, hashes and managed-block
verification. Input `generation` is the upcoming preparation generation; `phaseGeneration` is
the retained published generation. A smaller approved summary is labeled as a summary, not
truncation; exact source expansion remains available through its hash-bound reference.

Inputs and nextsteps use one prerequisite resolver. Full CLI guidance retains explicit grounding
composition. Compact guidance delegates composition to `/sf-phase` or `/sf-code` entry only;
custom drafting skills, integrity recovery and other prerequisites keep their explicit routes.
Use the returned continuation instead of another nextsteps or phase-show call. This does not
authorize another lifecycle action in the same turn. Repeated identical budget warnings print
once per CLI operation; different observations and later invocations retain their warnings.

Authoring skills use `phase prepublish PHASE --for-agent --json` once. Prepublish already runs
draft-check internally. Compact checks preserve all findings, correction/repair/risk choices,
fingerprints, warnings, exact commands and test requirements. Omitted verbose observations have
an explicit full-inspection command; the ordinary `--json` contract is unchanged. Required tests
still run freshly at the governed execution transition, not during these read-only checks.

No production token-reduction composer or unqualified cache policy is enabled by this change.
Existing approved-input briefs and exact clause capsules remain the context authority. Token and
Git-call savings depend on workflow content; fewer CLI calls are not a claim of fewer validators.

`/sf-review-source` starts review with `singularity-flow review-source context --for-agent --json`
(optionally name the current phase). The packet includes pause/session binding and every exact
source, approved clarification, upstream specification, published artifact, pinned reviewer,
schema and report template. The authoritative inventory appears once at `reportTemplate.binding`;
no review material is summarized or truncated. `reviewGuide.readOrder` avoids key-enumeration and
repeated inventory/hash lookups. The ordinary context JSON stays unchanged. Explicit status and
human decisions retain their pause/session checks; compact entry cannot make either decision.
