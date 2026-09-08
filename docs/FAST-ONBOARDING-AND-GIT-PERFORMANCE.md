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
```

Repeated `onboard` is idempotent. It returns the existing receipt and does not contact the remote
or silently advance policy. Use `authority refresh` when the reviewed authority changed. Changing
from one remote to another, or between remote and local authority, is a rebind and is refused by
`onboard`; use the normal reviewed configuration-authority process for that decision.

The attachment descriptor and receipt are machine-local under Git's reported common directory.
They contain full object identities and content digests, but never credentials. Story start may
reuse this verified pin, including from a checkout whose working branch has no `workflow.yml`.
Story start never launches AST work in the foreground or background. When structural cache warming
is useful, its result includes the explicit, optional command
`singularity-flow wm ast build --all`; work can continue without running it.

## VS Code

Open the Command Palette and run one of:

- **Singularity Flow: Fast Onboard Existing Repository**
- **Singularity Flow: Refresh Repository Authority Pin**
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

`--bootstrap`, `--publish`, and offline attachment are intentionally refused in this release.
They require separate approved bootstrap and offline-freshness policy rather than a performance
shortcut.

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

## Performance evidence

The checked-in FOS benchmark manifest distinguishes first feedback, local completion, network
completion, Git service time, logical requests, process spawns, and peak memory. Performance claims
are not authorized until the named macOS/Linux/Windows and office-network runners publish the
required raw samples. Safe functionality does not depend on meeting a marketing latency number.
