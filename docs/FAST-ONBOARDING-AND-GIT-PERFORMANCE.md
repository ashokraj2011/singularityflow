# Fast onboarding and safe Git performance

Fast onboarding (FOS) attaches an existing checkout to one reviewed Singularity Flow
configuration authority. It does not clone the application repository, create policy, scan source,
build AST or a World Model, invoke a model, or commit to the application branch.

## First-day commands

```bash
# One configured remote: it is selected only when unambiguous.
singularity-flow onboard /absolute/path/to/repository

# Multiple remotes: name the authority route explicitly.
singularity-flow onboard /absolute/path/to/repository --remote company

# A deliberately local repository with an existing reviewed sflow/config or state authority.
singularity-flow onboard /absolute/path/to/repository --authority-local

# Re-observe the previously recorded route and advance its exact pin.
singularity-flow authority refresh /absolute/path/to/repository

# Explicitly initialize an unmanaged local-only repository. This never claims organization scope.
singularity-flow onboard /absolute/path/to/repository \
  --bootstrap --policy unmanaged-local-v1 --authority-local

# Reuse complete retained bytes when the pinned authority policy permits bounded offline use.
singularity-flow onboard /absolute/path/to/repository --offline
```

Repeated `onboard` is idempotent. It returns the existing receipt and does not contact the remote
or silently advance policy. Use `authority refresh` when the reviewed authority changed. Changing
from one remote to another, or between remote and local authority, is a rebind and is refused by
`onboard`; use the normal reviewed configuration-authority process for that decision.

An ordinary reused pin is deliberately reported as `pinned-local` with `current: false` and
`latest: false`: it is valid recorded evidence, not a claim that the remote was just checked.
Only an explicit successful refresh reports `observed-online`, `current: true`, and `latest: true`.

The attachment descriptor and receipt are machine-local under Git's reported common directory.
They contain full object identities and content digests, but never credentials. Story start may
reuse this verified pin, including from a checkout whose working branch has no `workflow.yml`.
Story start never launches AST work in the foreground or background. When structural cache warming
is useful, its result includes the explicit, optional command
`singularity-flow wm ast build --all`; work can continue without running it.

The shared FOS publication boundary uses one full candidate commit, one exact expected remote OID
(or expected absence), and `--force-with-lease` against the full branch ref. It revalidates actor,
policy epoch, approvals, inputs, evidence, parent and target authority immediately before the push.
If Git accepts the push and the process is interrupted before its receipt is written, the same
operation ID reconciles the exact remote candidate from its authorized journal; it never pushes a
second time. Different payload reuse, an unexplained candidate, or a moved remote ref is refused.

For a diagnostic reference run, add `--no-cache`. It disables only the invocation-local
`RepoContext` reuse and leaves authority, receipts, policy, and durable derived caches unchanged:

```bash
singularity-flow onboard /absolute/path/to/repository --no-cache
```

## VS Code

Open the Command Palette and run one of:

- **Singularity Flow: Fast Onboard Existing Repository**
- **Singularity Flow: Refresh Repository Authority Pin**
- **Singularity Flow: Create Local-Only Configuration Authority**
- **Singularity Flow: Use Approved Offline Authority Pin**
- **Singularity Flow: Inspect or Enable Safe Git Acceleration**
- **Singularity Flow: Clear Disposable Derived Cache**

The editor collects the repository and, when necessary, the remote choice. The CLI still owns
validation, locking, receipts, recovery, and every mutation. These commands are registered even
when the open folder is not initialized, because onboarding is the action that establishes that
binding.

## Optional acceleration

Inspection is read-only:

```bash
singularity-flow doctor --git-speed --json
```

Enable only settings you reviewed. They are repository-local, verified after write, and recorded
in a receipt. Existing custom values are preserved.

```bash
singularity-flow doctor --git-speed --apply \
  --enable fsmonitor \
  --enable untracked-cache \
  --json
```

Derived cache records are disposable and non-authoritative. Clearing them never removes authority
pins, journals, receipts, evidence, Story state, or Story-switch recovery:

```bash
singularity-flow cache clear --derived --repo /absolute/path/to/repository --json
```

## Recovery and diagnosis

| State | Meaning | Safe next action |
|---|---|---|
| `already-attached` | The exact route is already bound | Continue, or explicitly refresh if authority changed |
| `AUTHORITY_ROUTE_AMBIGUOUS` | More than one remote exists | Re-run with `--remote <name>` |
| `AUTHORITY_REBIND_REQUIRED` | The requested route differs from the recorded route | Use reviewed configuration-authority rebind; do not delete the receipt |
| `AUTHORITY_CONFLICT` | The remote locator or local attachment changed | Restore the recorded route or review a rebind |
| `AUTHORITY_NOT_CONFIGURED` | The selected route advertises neither reviewed configuration nor verified state | Publish/refresh approved configuration through the normal workflow |
| network/auth/TLS/proxy code | Git could not read the selected authority | Repair approved Git access, then retry the same command |
| `AUTHORITY_PIN_INVALID` | Local pin/receipt integrity or schema validation failed | Run `singularity-flow doctor --json`; do not hand-edit the record |
| `cache-unavailable` | Optional cache storage failed | Continue uncached; repair disk/permissions separately |

Local-only bootstrap is available only as the explicit package-approved `unmanaged-local-v1`
preset. It creates `sflow/config` without changing the application branch, records its operation,
and labels the result unmanaged/local-only. It cannot create organization membership or remote
authority. Remote bootstrap requires `--publish` plus a separately installed trusted policy
provider and fresh governance-kernel grant; without those, it refuses before creating authority.

Offline reuse is enabled by approved authority bytes, not a machine setting. The pinned
`singularity/fos.yml` must permit the `onboard` operation, bind the pinned workflow policy digest,
set a finite `maxAgeSeconds` and `notAfter`, and not be revoked or require a live check. The atomic
attachment stores a digest-bound bounded snapshot (maximum 32 MiB). Missing or altered bytes,
expiry, incompatible policy, and required-live policy all refuse without network or bootstrap.

## Optional experience and automation features

Every Track B feature is independent and defaults to off:

| Feature | Current contract |
|---|---|
| Reusable defaults | Local, expiring, revocable, provenance-bound, never authoritative |
| Interpretation cards | At most three related questions; missing evidence remains missing |
| Template prefill | Deterministic facts only, with field-level provenance |
| Evidence drop/paste | Local bounded untrusted bytes; always `attached/unverified` |
| Story switching | Dirty buffers require consent and durable recovery outside caches |
| Policy pre-authorization | Only a bound governance-kernel result can grant it |
| Approval routing | Durable outbox delivery is not approval or delegation |
| PR-check adoption | Advisory is non-authoritative; enforced mode requires certified server controls |

The last three automation features remain disabled until real identity, notification, trusted
server-gate, and workflow-import adapters have been certified. Deterministic local adapter tests
prove refusal and binding behavior; they do not impersonate that external authority.

## Input and cache integrity

FOS now separates convenient status observations from authorization inputs. Status carries its
observation time, worktree identity, HEAD and mutable epoch, and is explicitly labelled
`observational`. Editor watcher overflow and machine resume advance that epoch.

Code that needs an authorization input can seal explicit worktree or index paths with
`sealFosInputs`. The seal hashes the bytes actually read, includes ignored or untracked paths when
they are explicitly named, distinguishes index bytes from worktree bytes, and detects a live read
race. `verifyFosSealedInputs` re-reads the same sources before use and refuses changed bytes.

Persistent derived-cache callers must include every relevant parser, configuration, membership,
sparse-checkout, ignore-policy and path-resolution digest. Missing Git objects are not cached as a
negative result, and the shared object reader verifies that the full returned OID is exactly the
one requested. These caches remain non-authoritative optimizations.

## Performance evidence

The checked-in FOS benchmark manifest distinguishes first feedback, local completion, network
completion, Git service time, logical requests, process spawns, and peak memory. Performance claims
are not authorized until the named macOS/Linux/Windows and office-network runners publish the
required raw samples. Safe functionality does not depend on meeting a marketing latency number.

Run the content-free local comparator without writing into the repository:

```bash
npm run benchmark:fos -- --samples=3 --out=/absolute/private/fos-benchmark.json
```

It compares cached and `--no-cache` repository projections, verifies linked-worktree identity,
and reports request counts. Its report
sets `claimsAuthorized: false` and lists every platform/network lane it did not measure.

The executable witness inventory maps each present `FOS:AC-NNN` test to its exact source line and
test-body digest. Inventory mode never claims that tests ran; execution mode fails until all 50
acceptance rows have real, non-skipped witnesses:

```bash
npm run evidence:fos
npm run evidence:fos:execute -- --out=/absolute/private/fos-evidence.json
```

Evidence output is refused inside the repository to avoid a self-referential commit binding.
Run it from a clean exact release commit when producing a hash-bound report.
Tests named `FOS:PARTIAL-AC-NNN` and `FOS:DEFERRED-AC-NNN` are listed separately and never count
toward completion; they preserve useful code-local evidence without pretending an external or
unfinished acceptance row has passed.
