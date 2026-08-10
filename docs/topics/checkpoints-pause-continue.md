---
id: checkpoints-pause-continue
title: Checkpoints, pause, and continue
aliases: [resume, handoff, checkpoint]
commands: [story]
related: [work-intervals, recovery]
---
`sflow story checkpoint -m "note"` marks where you are (local — may be dirty; the record states plainly that uncommitted bytes are not durable elsewhere). `--published` requires a clean tree and verifies the commit is reachable from the remote before claiming cross-machine durability. `sflow story pause --publish --detach` records a stop or handoff.

`sflow story continue <ID>` rebuilds context on any machine: the continuation packet separates PINNED (true at start), SINCE YOU LEFT (observed changes), and STALE — so you never mix contract with drift. A colleague or a loaner laptop runs the same command and gets the same truth.
