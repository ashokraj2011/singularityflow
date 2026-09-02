---
name: sflow-capability-doctor
description: Diagnose workspace capability bindings, approved capability authority, stale proposal history, inherited policy, orphan state branch, ledger chain, and pinned cross-repository world-model context.
disable-model-invocation: true

---

# Singularity Flow capability doctor

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`.

This is a deterministic inspection skill. Do not infer capability ownership from
folder or branch names, and do not repair governed state by hand.

1. Run `singularity-flow capability leads --json`. Use the sole result; otherwise ask
   which lead URL. Never infer one from the current folder or chat history.
2. Run `singularity-flow capability fsck --lead <LEAD-URL> --json`. Report every failed
   workspace binding, stale state projection, and proposal-history finding with the exact
   remediation supplied by the engine. Do not mutate anything during this check.
3. If repository-local policy diagnostics were requested, run
   `singularity-flow workspace current --json`, change only to its verified
   `repositoryPath`, and run `singularity-flow capabilities doctor --json` there.
4. If the repository maps ambiguously, show the candidates and ask the contributor
   to rerun with `--capability <id>`.
5. Report the exact capability path, capability-map SHA-256, effective inherited
   policy, active break-glass leases, and lifecycle pin.
6. Report the configured orphan state branch and its publication mode. A warning
   is not a pass when publication is `required`.
7. Report ledger verification and every sibling-repository world-model snapshot.
8. For a failure, provide the deterministic repair command. Do not create a lease,
   initialize a state branch, rebuild a model, or change policy unless asked.

For an unrelated-history proposal, offer the two fsck-reported choices: recreate the
capability from current `sflow/config`, or run the guarded `capability discard-proposal`
command with the full current commit and a contributor-supplied reason. Never use raw
Git deletion, and never discard a valid proposal.

Use `singularity-flow capabilities doctor <ID> --offline --json` when network
access is intentionally unavailable. Offline verification must be labelled as
offline and must not be represented as remote publication proof.
