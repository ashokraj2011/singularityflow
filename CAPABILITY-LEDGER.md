# Singularity Flow Capability Ledger

The capability ledger is an optional, tamper-evident record of important Story and
Initiative lifecycle events. It lives on the orphan branch
`state`, which shares no ancestry with application branches.

It is deliberately disabled by default. Existing repositories and work items behave
exactly as before until `ledger.enabled` is set to `true`.

## Enable it

In `singularity/workflow.yml`:

```yaml
ledger:
  enabled: true
  branch: state
  remote: origin
  publication: warn
  behind: warn
  enforcement: shadow
  signing: off
  trustTier: T0
  maxRetries: 4
  pinTransport: refs
  retentionDays: 2555
```

`publication` is `off`, `warn`, or `required`. `warn` keeps local work usable and
reports a state-publish failure; `required` fails the governing operation when the
orphan branch cannot be updated. The selected value is validated and ships as
`warn` in new repositories.

Initialize the unrelated history once:

```bash
singularity-flow ledger init
singularity-flow ledger doctor
singularity-flow ledger verify
```

`ledger init` uses an isolated temporary worktree. It does not switch or modify the
application checkout. A normal merge refuses the unrelated histories, but Git's
`--allow-unrelated-histories` override still exists. Preventing any ledger-to-main
merge therefore requires a hosting-provider rule or server-side hook.

## Publication and recovery

Before a lifecycle commit is created, Flow writes a canonical durable intent under
the relevant Story or Initiative:

```text
singularity/work-items/<WORK-ID>/context/ledger-intents/<event-id>.json
singularity/initiatives/<EPIC-ID>/context/ledger-intents/<event-id>.json
```

The intent is included in the normal code-branch commit. After that commit is pushed,
Flow appends a content-addressed entry to the ledger. This ordering means that a fresh
clone can recover a missing append even if the first machine is lost.

```bash
singularity-flow ledger status
singularity-flow ledger reconcile WORK-123
singularity-flow ledger reconcile
singularity-flow ledger archive --out ./archives/ledger.bundle
```

The `.git/singularity-flow/ledger-outbox/` directory is only a local retry cache. It
is never the durable source of recovery.

## Ledger layout

```text
ledger/head.json
ledger/entries/<capability-id>/<sha256>.json
ledger/idempotency/<sha256-of-stable-operation-key>.json
ledger/events/<event-id>.json
```

Entry files contain canonical JSON with recursively sorted object keys. The SHA-256
of those exact bytes is the filename. `head.json` records the current entry and
sequence. Every entry records its parent entry hash, forming one serialized chain.

Each entry carries a stable operation key made from Work ID, event type, phase,
generation, and the full published source commit. Event IDs provide correlation while
the operation key makes retries and independent-machine recovery idempotent.
Semantic details such as phase, generation,
actor, authority group, working lens, and publication commit remain separate fields;
working lenses never grant approval authority.

## Verification

```bash
singularity-flow ledger verify
singularity-flow ledger verify --offline
singularity-flow ledger log --limit 50
singularity-flow ledger show <ENTRY-HASH-OR-EVENT-ID>
```

Verification checks entry hashes, the reachable parent chain, sequence length,
idempotency indexes, source-pin reachability and equality, and the current ledger commit signature when
`signing: commit` is configured.

`ledger archive` produces a verified Git bundle plus a canonical SHA-256 manifest.
Add `--sign` to create a detached GPG signature for the manifest. Archiving never
deletes ledger history or source pins; retention expiry must be recorded separately
as a `retention-expired` ledger event before a missing pin is treated as expected.

Commit signing proves the ledger publisher. It does not prove every actor claimed
inside a batched payload. Deployments needing actor-level proof must add signed event
envelopes or enforce one actor per signed commit.

## Trust tiers

| Tier | Expected deployment |
|---|---|
| T0 | Content-addressed chain and pins |
| T1 | T0 plus protected ledger branch and authority-derived review ownership |
| T2 | T1 plus verified signed ledger publication commits |
| T3 | T2 plus an enforced server validator such as a pre-receive hook or mandatory merge-queue validator |

No tier protects against compromise of its declared trust boundary. Provider audit
receipts are evidence, not enforcement unless a mandatory validator uses them.

## Capability policy

`singularity/capabilities.yml` defines a single-root tree. Inspect the effective
stricter-child policy with:

```bash
singularity-flow capabilities list
singularity-flow capabilities show product
singularity-flow capabilities lease grant product \
  --expires 2027-01-01T00:00:00Z \
  --reason "Approved incident response" \
  --policy '{"gateSeverity":"warn"}' \
  --confirm product
singularity-flow capabilities lease revoke product <LEASE-ID> \
  --reason "Incident closed" \
  --confirm product
```

Missing values inherit. Allowlists intersect, required obligations accumulate,
approval minimums increase, byte/token ceilings decrease, and blocking severity can
only increase toward a leaf. A break-glass lease is a separately authorized,
time-bounded ledger event; it never weakens the stored capability tree.

The capability map is not only descriptive. Story and Initiative creation pins the
owning capability, map hash, full inherited policy and active leases into runtime
state. The effective policy tightens the selected workflow's phases, write scopes,
checks, approval authorities and minimums, self-approval rule, byte/token ceilings,
and world-model requirements. Lifecycle ledger events use the real capability ID,
not a synthetic Story/Initiative placeholder.

For a capability delivered by several repositories, Flow copies the relevant
sibling world-model summary and active-phase views into the Story or Initiative
context. Sources are resolved from `state` first, then the working tree, and every
copied file, repository commit, manifest and capability-map hash is recorded. Prompt
composition verifies these pins and injects only the active phase's views.

Run the combined diagnostic at any point:

```bash
singularity-flow capabilities doctor [CAPABILITY-ID]
singularity-flow capabilities doctor [CAPABILITY-ID] --offline --json
```

The same check is available as `/sf-capability-doctor` and is included in the VS
Code **Singularity Flow: Diagnostics** report.

## Recommended branch controls

Protect both `main` and `state`: disable force pushes and deletion,
restrict publishers, require reviewed changes and T2/T3 signatures, and reject
introduction of ledger ancestry into application branches. The last control requires
a server-side or mandatory provider validator; CODEOWNERS alone cannot make an
orphan branch mathematically unmergeable.
