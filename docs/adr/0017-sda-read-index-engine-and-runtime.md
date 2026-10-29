# ADR 0017 — SDA read index: no new storage engine in Phase A

- **Status:** Proposed (SDA M0 decision, `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` §6.3)
- **Date:** 2026-10-29
- **Baseline:** `main@c6a65e33b`
- **Decision owner:** Singularity Flow repository maintainers

## Context

SDA §6.3 leaves the engine for rebuildable read indexes to this record. The read path Phase A has to
change is described by the M0 baseline (`benchmarks/sda/m0-qualification.md`). That baseline
measured the advisory reads on a fixture with the ledger on, a local bare remote and Stories created
by `start`.

- With a fresh cache, the Story list, status, the intake catalog and the repository snapshot already
  answer with no remote contact. The Story list and status start no Git at all.
- What fails is an expired or invalidated cache when the remote is unreachable. The Story list refuses
  with `SESSION_STATE_REFRESH_UNAVAILABLE`, and the intake catalog refuses with
  `REMOTE_REMOTE_NOT_FOUND`. The catalog also refuses after `check`, which discards its cached result
  instead of marking it stale.

The gap is serving last-known state and coalescing refreshes. It is not query capability.

The projections those reads use already exist, and each is a versioned JSON file written atomically:

- the repository-check cache, per checkout Git directory (`singularity-flow/cache/repository-checks/`);
- the Story summaries, per shared Git directory (`story-summaries.json`);
- the session listings (`~/.singularity-flow/cache/session-listings/`);
- the machine-wide Story index (`story-index.json`).

Runtime facts measured or read for this decision:

| Runtime | Node | `node:sqlite` |
|---|---|---|
| Declared floor (`package.json` engines) | `>=20` | absent before Node 22.5 |
| Installer-bundled runtime (`runtime/node-runtime.lock`) | 26.12.0 | present |
| VS Code 1.143.1, measured (Electron 43.7.7) | 24.21.0 | present (`DatabaseSync`) |
| VS Code 1.90.0, the extension's declared minimum (`engines.vscode ^1.90.0`) | 20.9 (Electron 29, from its release notes; not measured here) | absent |

- `sql.js` is a dependency today. It keeps a database in memory and writes the whole file, it is
  externalized from the CLI bundle, and `test/lazy-startup-reads.test.mjs` keeps it out of startup.
- The eager closure of `commands/start.mjs` is at 9,255,327 bytes against a 9,260,000 ceiling.
- The cold hook-context and catalog bundle closures have about 4 KB of headroom each.

## Decision

1. **Phase A adds no storage engine.** M2's index is the existing JSON projections, extended:
   - each record carries its accepted revision, `checkedAt`, freshness and completeness;
   - a refresh that fails or is invalidated keeps the last verified record, marked `stale` or
     `refresh-failed`, instead of deleting it (this covers `check`'s invalidation of the intake catalog);
   - refreshes are coalesced across processes through a lease beside the projection, not only within
     one process.
2. **Locations stay where they are.** A new projection file is registered in
   `scripts/test-machine-state.mjs` and in the retention allow-list (SDA §12, SDA-AC-016).
3. **SQLite remains possible, not planned.** If a later milestone needs queries that JSON files cannot
   answer within budget (search across many Stories, dashboards), `node:sqlite` is the candidate. It
   may be used only:
   - behind a capability check, falling back to rebuilding from the JSON projections;
   - after the VS Code extension's `engines.vscode` floor is raised to a release on Node 22.5 or later
     (confirmed from that release's notes), or with VS Code reads routed through the CLI read worker;
   - with a lazy import that keeps it out of the eager and hook bundle closures.
4. **`sql.js` is not used for the read index.** It suits the bounded configuration read model it
   already serves. Its whole-file rewrite does not suit concurrent processes refreshing a shared index.

## Consequences

- M2 needs no dependency, runtime floor or bundle-ceiling change for storage. Its work is
  serve-last-known, cross-process coalescing, and invalidation that marks records stale instead of
  deleting them.
- The VS Code extension keeps its `^1.90.0` floor through Phase A.
- SDA §6.3's open question is answered, and §17's bundle budgets are untouched by the index.
- A future engine change is a new ADR with measured query needs, not an assumption in the spec.
