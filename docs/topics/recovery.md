---
id: recovery
title: Recovery — nothing is ever lost
aliases: [sync, pending-publication, crash, lost-laptop]
commands: [sync, recover, doctor]
related: [checkpoints-pause-continue, sequence-gates]
---
Publication is a transaction: verified preconditions, one isolated commit of allowlisted paths, compare-and-swap branch advance, push without force, and journals under `.git/singularity-flow/`. A failed push leaves pending publication; `sflow sync` replays it exactly once. A branch-head race refuses rather than clobbering — reload and retry. A dead laptop costs nothing durable: clone and `sflow resume`. `sflow doctor` diagnoses; `sflow recover` regenerates derived files from canonical state and never invents transitions. Concurrent writes to the same work item are serialized by a subject lock and caught by a state fingerprint even when uncommitted.
