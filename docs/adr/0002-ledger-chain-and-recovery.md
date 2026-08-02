# ADR 0002: Serialized ledger chain and recoverable publication

- Status: accepted
- Date: 2026-07-31

## Decision

The ledger uses one canonical head on the orphan branch `state`.
Content-addressed entry filenames contain no mutable sequence number. `head.json`
records sequence and the current entry hash.

Publication is:

1. Write a durable intent into the Story or Initiative tree.
2. Commit and push the normal work branch.
3. Fetch the ledger head.
4. Build an entry whose parent is that head and whose stable idempotency key is
   `workId · eventType · phase · generation · sourceCommit`.
5. Pin the source commit, append the entry, and push with `--force-with-lease`.
6. On rejection, fetch, recompute, and retry within the configured bound.

The local outbox is a retry cache only. A fresh clone discovers intents from remote
work branches and can reconcile them without the originating machine.

## Consequences

The chain serializes low-frequency governance events. If write volume later requires
a DAG, the layout can evolve to multiple parent hashes without renaming entry files.
Mutations using ledger-first bindings fail closed when required ledger state cannot be
verified; read-only views may disclose stale cached state.
