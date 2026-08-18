# Singularity Flow Capability Ledger

The capability ledger is an optional, tamper-evident record of important Story and
Initiative lifecycle events. It lives on the orphan branch
`state`, which shares no ancestry with application branches.

It is deliberately disabled by default. Existing repositories and work items behave
exactly as before until `ledger.enabled` is set to `true`.

Governed capability configuration enables the ledger and records each successful
proposal activation as `capability-configuration-activated`. The event binds the
proposer and approver, proposal branch and commit, target before and after commits,
changed files, and the result of the exact target-ref protection probe. If the remote
permits a direct `sflow/config` update, activation additionally records the actor's
explicit unprotected-branch acknowledgement.

Use `sflow explain evidence-and-ledger` and `sflow explain capability-management` for the current packaged tutorials.

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

`ledger init` also installs the custom-ref fetch configuration and safely repairs the
local pin cache when it joins an existing ledger. It never invents a pin and never
publishes a missing remote pin as part of initialization.

## Pin diagnosis and bounded self-healing

An unreachable pin can mean four different things: the clone lacks its custom-ref
fetch rule, the remote cannot be reached with the current credentials, the Git host
hides or rejects custom refs, or the exact retained ref is missing. Diagnose them
without changing refs:

```bash
singularity-flow ledger repair --dry-run
```

Safe local healing installs the configured refspec and fetches only a pin whose commit
matches the content-addressed ledger:

```bash
singularity-flow ledger repair
git remote add authority <authoritative-ledger-remote>
singularity-flow ledger repair --source-remote authority
```

The alternate source must already be a configured Git remote. A URL supplied ad hoc is
not accepted. If the configured publication remote has genuinely lost a pin, preview
the remote restoration and use the complete hash-bound phrase it prints:

```bash
singularity-flow ledger repair --restore-remote --dry-run
singularity-flow ledger repair --restore-remote \
  --confirm "RESTORE LEDGER PINS <FULL-PLAN-SHA256>"
```

Remote repair is explicit and fail-closed. It validates the recorded commit and pinned
configuration, performs a dry-run push, uses exact `<commit>:<pin-ref>` refspecs, and
never force-pushes or replaces a mismatched ref. Multiple refs use an atomic push. If
the exact source object cannot be proven, an authority must restore it before Flow can
continue. Switching `pinTransport` to `branches` prevents future custom-ref compatibility
problems but does not rewrite historical entries.

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
actor, authority group, governed agent, and publication commit remain separate fields;
agents never grant approval authority.

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

## VS Code capability experience

Capability configuration lives under **Configuration**, not beneath the local
workspace selector. The designer distinguishes the organisation-defined `kind`
from the closed `type` (`business` or `tech`), lists valid parent capabilities,
and connects delivery repositories through the governed portfolio rather than
free-form local paths.

The Inbox portfolio dashboard is a projection over the map and current lifecycle
branches. It shows root capabilities, delivery descendants, repositories, Jira
routes, open work, approvals, diagnostics, and world-model health. The dashboard
does not read operational state from the orphan ledger and does not become a new
authority plane.

## Recommended branch controls

Protect `sflow/config`, `main`, and `state`: disable force pushes and deletion,
restrict publishers, require reviewed changes and T2/T3 signatures, and reject
introduction of ledger ancestry into application branches. The last control requires
a server-side or mandatory provider validator; CODEOWNERS alone cannot make an
orphan branch mathematically unmergeable.
