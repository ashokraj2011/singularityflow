# Configuration State Service

Configuration proposals now have database-style entity and revision identities, semantic
transactions, a durable recovery journal and a rebuildable SQLite read model. This is the first
configuration/proposal slice, not a replacement for every Story, evidence or World Model store.

## Authority and persistence

- Approved `sflow/config` remains shared authority. A proposal/cache/journal never grants approval.
- Each activated transaction appends a validated receipt to
  `singularity/configuration-transactions.json` in the same commit as its assets. Receipt identities
  bind the exact proposal, authority base, actor and before/after asset hashes and modes.
- The private Git-common `singularity-flow/configuration-service/<remote-fingerprint>/transactions`
  directory reuses SGOS's immutable, fsynced event journal, writer locks and compare-and-swap.
- `read-model.sqlite` in the same authority directory is a disposable indexed projection with
  separate proposal entities and revisions. Every read requires a fresh remote advertisement
  matching the exact authority commit, requested proposal commits and running build. Missing/corrupt caches miss
  and rebuild; mutations do not read the database as authority.
- SQLite runs through pinned, pure-JavaScript sql.js, including Node 20 without native add-ons or
  platform-specific SQLite installation. The dependency is bundled with the normal package.

## Proposal and activation semantics

One logical operation/subject has a stable authority-scoped proposal ID. Each changed save has an
immutable base/tree-qualified revision branch; repeating the same bytes on the same base reuses
that revision. Existing proposal branches remain readable. The Studio groups versions by entity
identity, retaining older versions and keeping equal-time alternatives explicit.

Activation confirms an exact proposal commit and retains the direct-push acknowledgement and all
server branch-protection controls. The adapter applies semantic base/proposed/current differences:
unchanged values retain the current authority; unrelated changed settings survive; incompatible
concurrent edits produce `CONFIGURATION_ENTITY_CONFLICT` with exact file/JSON pointers. It does not
run `git merge`, silently overwrite a competing value, or choose a human risk disposition.

Full configuration/agent/skill/instruction validation precedes publication. Only admitted
configuration blobs are materialized. Exact asset bytes enter the index without application
worktree staging or clean filters. The commit retains both approved and reviewed lineage, but its
tree is constructed by the semantic transaction, not a textual Git merge. A leased remote ref
update commits the complete configuration/receipt together; a fresh observation verifies success.

The receipt file is kernel-owned: proposals and recreation cannot supply replacements for it.
Malformed shared receipts are an integrity refusal, not a disposable-cache repair.

## Interruption and recovery

The local operation is `prepared` before push. Stable candidate construction reconstructs the same
commit after pre-push interruption. A failed/lost acknowledgement is never inferred as success.
After observing the exact remote candidate, the journal records `committed`, then `synced` or
`sync-pending` depending on workspace-reference refresh. Later stale observers cannot downgrade a
confirmed effect. A later journal write failure is disclosed with an exact reconciliation route;
it does not turn an observed shared commit into a claim that activation failed. Linked Story pins,
source files and the user's index are preserved.

Inspect local retained transactions, including while the remote is unavailable:

```sh
singularity-flow configuration transactions --json
```

Reconcile a retained transaction:

```sh
singularity-flow configuration reconcile <CFT-ID> --json
```

Copilot: `/sf-configuration transactions` and `/sf-configuration reconcile <CFT-ID>`.

Reconciliation checks the exact shared receipt, prepared candidate and reviewed ancestry. It never retries a push;
when installation is not confirmed it returns the original exact review/activation route. Once
confirmed it can finish reference sync and best-effort retirement of the exact review branch.
Cleanup failure is not activation failure; retained branches and pending references are disclosed.
When a different reviewer installs the same exact proposal/base/asset delta, the uncommitted local
attempt can resolve as `superseded`, naming the installed transaction. It is never labelled as its
own committed approval, and unrelated or differently rebased transactions do not satisfy this proof.

## Explicit reset compatibility and rollout boundaries

Recreate & sync remains an explicitly authorized bulk intent replacement with archive tags and
atomic retirement. It cannot replace the kernel receipt registry. It is not automatic conflict
resolution or a waiver of a required review. External Git review/merge paths remain supported and
are distinguished from receipt-bound engine transactions.

Existing Stories are not rewritten. Story transitions, evidence/approval storage, World Model
state, general configuration draft storage, and all legacy publication entry points still need
separate consolidation before this can be described as a product-wide state-service migration.
The SQLite projection is not an independent writable database on each laptop or a substitute for
remote availability. A remote outage remains a disclosed, recoverable pending operation.

## Verification

Tests cover stable identities, immutable revisions, adjacent unrelated edits, exact field
conflicts, checksum/lineage validation, symlink refusal, disposable cache reconstruction, local
CAS races, preservation of dirty app/index bytes, server refusals, and process loss immediately
before/after the leased push. Native Windows qualification remains a separate run; process-kill
integration probes are POSIX-specific.
