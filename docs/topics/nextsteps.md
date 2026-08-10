---
id: nextsteps
title: Guidance — nextsteps and the narration contract
aliases: [guidance, now-then, no-dead-ends]
commands: [nextsteps, guide]
related: [getting-started, sequence-gates]
---
`sflow nextsteps` computes the ordered, valid next actions from pinned state — NOW, THEN, and alternatives, each with a reason and a runnable command. Command results follow the same narration contract: outputs explain why you are seeing them (which state, which pin, which rule) and end with a next action or an explicit rest state. Refusals name each unmet condition, its evidence, and the repair command — a gate is never "no," it is "not yet, and here is the path."
