# ADR 0003: Source pins, transport, and retention

- Status: accepted and current; deployment validation required
- Date: 2026-07-31

This record is maintained as the current source-pin and retention contract. Current validation and
deployment guidance is incorporated here rather than treated as historical release context.

## Decision

Every governed ledger entry pins its exact published source commit. The portable
default is `pinTransport: refs`, using `refs/singularity/pins/*`; `ledger init`
installs the matching fetch refspec in the clone. Deployments whose Git server rejects
custom refs use `pinTransport: branches`, under `singularity/pins/*`. `none` is
available only for shadow experiments and lowers the assurance claim.

The configured `retentionDays` is recorded on each entry. Expiry never silently
deletes a pin. A future deletion must first produce a verified bundle archive and a
`retention-expired` ledger event.

## Deployment spike

Before enabling enforcement, run `singularity-flow ledger doctor` and test the chosen
transport against the actual corporate remote: create/fetch/delete permission,
retention, branch protection, signed commits, and the available PR/merge/pre-receive
mechanism. Record the result in the repository's deployment documentation.

## Consequences

A normal clone does not fetch custom refs without the installed refspec. Fresh-clone
verification therefore depends on `ledger init`, bounded `ledger repair`, or
organization-wide Git refspec configuration. Flow classifies an unreachable pin as
missing, mismatched, unavailable, timed out, network-disabled, or locally uncached
rather than collapsing every case into one failure.

Local self-healing may install the refspec and fetch only the commit already recorded
by the ledger. Remote restoration is a different trust decision: it requires an exact
plan-hash confirmation, source/configuration proof, a dry-run, and a non-force explicit
refspec. A remote mismatch is never overwritten. Changing transport applies only to
new entries and cannot make a historical pin reachable.
