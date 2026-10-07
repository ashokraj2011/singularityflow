---
id: compact-phase-entry
title: Compact phase entry for Copilot
commands: [phase]
aliases: [phase-entry]
related: [artifacts-and-generation, approvals]
version: 1
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

`/sf-code` and `/sf-phase` consume these packets instead of separate pause/session/status,
recovery, clarification and reference commands. Standalone agents retain a boundary fallback;
they reuse only a verified packet from the current invocation, never an earlier chat's selection.

Authoring skills use `phase prepublish PHASE --for-agent --json` once. Prepublish already runs
draft-check internally. Compact checks preserve all findings, correction/repair/risk choices,
fingerprints, warnings, exact commands and test requirements. Omitted verbose observations have
an explicit full-inspection command; the ordinary `--json` contract is unchanged. Required tests
still run freshly at the governed execution transition, not during these read-only checks.

No production token-reduction composer or unqualified cache policy is enabled by this change.
Existing approved-input briefs and exact clause capsules remain the context authority. Token and
Git-call savings depend on workflow content; fewer CLI calls are not a claim of fewer validators.
