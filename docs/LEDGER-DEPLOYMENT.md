# Ledger deployment validation

`sflow ledger deployment-check` validates whether the repository's configured
orphan state ledger can support the trust claim selected in `workflow.yml`. It is
read-only unless `--record` is passed.

```sh
sflow ledger deployment-check --offline --json
sflow ledger deployment-check --confirm-protected --confirm-push-policy \
  --confirm-pin-retention --record
```

The command verifies that the ledger is enabled, its Git remote and branch are
readable, its pin transport is reachable, and required commit-signing configuration
exists. Git cannot prove hosting-provider branch protection, force-push denial, or
retention policy through ordinary read-only commands. T2/T3 therefore require the
corresponding administrator confirmations; a confirmation records an operator's
assertion, not cryptographic proof.

Recorded results live at `singularity/deployment/ledger-validation.json` and enter
Git only through the normal reviewed publication path. Credentials and tokens are
never written to the record, and credentials embedded in a remote URL are redacted.
