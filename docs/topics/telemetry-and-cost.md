---
id: telemetry-and-cost
title: Telemetry, tokens, and cost
aliases: [tokens, cost, cache]
commands: [telemetry]
related: [impact-framework, model-independence, reference-previews]
---
Token accounting is exact where the host supplies it and labeled `unavailable` where it doesn't — never estimated. The session's fixed cost is the conversational skill index: eight model-invocable skills whose descriptions are capped at 15 estimated tokens each, about 113 estimated tokens in total. Everything else loads on invocation and scales with governed work, not with sessions. `sflow telemetry status` shows recorded usage; `sflow telemetry reconcile` compares it against a phase. Per-contributor reporting is not a command — the CLI has no `me` view, and the machine-local activity log read through `sflow logs` is the closest thing to one.
