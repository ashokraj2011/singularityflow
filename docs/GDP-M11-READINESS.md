# GDP-M11 readiness and support report

Run the read-only readiness report in a governed repository:

```text
singularity-flow delivery readiness --json
```

To include a reviewed provider descriptor:

```text
singularity-flow delivery readiness --provider-file <repository-relative-provider.json> --json
```

The report separates implemented product surfaces from external release evidence. M0–M8 are
implemented. M9 is a non-gating local observation profile. M10 supplies provider-neutral contracts
but no installed verifier. M11 currently supplies the report itself; it does not grant GA status.

The support matrix records current claims for Delivery modes, Workflow mappings, assurance
profiles, adapters, CI providers, npm, and VSIX. The current OS, architecture, and Node version are
only runtime labels. They are not clean-checkout release receipts and cannot fill another platform
cell.

The report remains `status: not-ready`, `gaReady: false`, and `authority: report-only` while any of
these remain open:

- authenticated hermetic-runner isolation and trust evidence;
- approved provider pilots, including outage, replay, revocation, privacy, and retention;
- exact macOS, Linux, Windows, Node, npm, and VSIX release receipts;
- upgrade, downgrade, old-state, interruption, and recovery exercises;
- the agreed no-critical-mismatch observation window;
- proof that duplicate readers and writers are unused before sunset.

No existing reader or writer is removed by this milestone. A local passing test run, a configured
provider name, or a self-reviewed report cannot change readiness to true.
