# GDP M7 — SGOS durable execution bridge

GDP does not run another executor. M7 binds a Delivery Selection and Completion Contract to the
existing SGOS durable Process runtime, which already owns checkpoints, leases, bounded stop,
quiescence, retry, recovery, and isolated Candidate handling.

Inspect an enrolled Feature/Bugfix Story and SGOS Process with:

```text
singularity-flow delivery execution-status <PROCESS-ID> --work-id <WORK-ID> --json
```

The result contains an exact Agent Execution Binding and an observation of the current SGOS
checkpoint. It reports active execution references, quiescence, and recovery state without changing
the Process. The returned pause, stop, and recover commands are the existing SGOS commands; they
retain SGOS confirmation, authority, locking, and recovery behavior.

Agent Steering Decisions can be derived only from an already-recorded SGOS control-event digest.
A proposed or model-generated action cannot become a steering decision. Missing Candidate,
Execution Unit manifest, or checkpoint identity is retained as a gap, never upgraded to success.

Enrollment remains explicit. Existing Auto sessions continue with their original protocol, and
GDP does not migrate them merely because the extension or CLI is upgraded.
