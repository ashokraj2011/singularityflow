---
name: sflow-capability-doctor
description: Diagnose the active Singularity capability binding, inherited policy, orphan state branch, ledger chain, and pinned cross-repository world-model context.
disable-model-invocation: true

---

# Singularity Flow capability doctor

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

This is a deterministic inspection skill. Do not infer capability ownership from
folder or branch names, and do not repair governed state by hand.

1. Run `singularity-flow capabilities doctor --json` from the active repository.
2. If the repository maps ambiguously, show the candidates and ask the contributor
   to rerun with `--capability <id>`.
3. Report the exact capability path, capability-map SHA-256, effective inherited
   policy, active break-glass leases, and lifecycle pin.
4. Report the configured orphan state branch and its publication mode. A warning
   is not a pass when publication is `required`.
5. Report ledger verification and every sibling-repository world-model snapshot.
6. For a failure, provide the deterministic repair command. Do not create a lease,
   initialize a state branch, rebuild a model, or change policy unless asked.

Use `singularity-flow capabilities doctor <ID> --offline --json` when network
access is intentionally unavailable. Offline verification must be labelled as
offline and must not be represented as remote publication proof.
