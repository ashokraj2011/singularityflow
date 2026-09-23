# Singularity Flow Team Onboarding

**Specification ID:** `TON-v1`  
**Status:** implementation baseline

## 1. Outcome

One native VS Code journey lets an authenticated GitHub or GitHub Enterprise user:

1. name a team and explicitly select the repositories it owns;
2. inspect each selected repository and review one atomic capability-map proposal; and
3. create a workspace from any approved capabilities, with clones and reused checkouts shown before
   materialization.

The screen composes existing Repository Discovery and Selection (RDS), capability authority, and
workspace services. It does not create a second source of truth.

## 2. Capability representation

- A team is a `collection` capability.
- Each newly onboarded repository is represented by a `delivery` child.
- An existing top-level delivery capability may be linked beneath the team only when the user
  selects that outcome and the capability has no different parent.
- A capability that already belongs to another collection is `Needs a choice`; team onboarding does
  not silently reparent it.
- Re-running team onboarding for an existing matching collection adds later children in a small new
  proposal. It does not recreate or replace the team.

No capability or portfolio schema change is required.

## 3. Repository discovery and inspection

The repository list is the RDS provider catalog returned by `repositories list` or
`repositories search` using the active `gh` identity. Listing remains read-only and does not imply
onboarding.

Before selection, every row is `Not checked yet`. The user may select at most 20 repositories.
Only selected repositories enter the inspection queue. The queue runs
`capability inspect-repository` as an individually attributable bounded operation for each URL.
Cancellation stops the remaining queue without discarding completed results.

| Label | Meaning | Proposal eligibility |
| --- | --- | --- |
| `Will add` | Complete inspection proves the repository is absent from the selected authority | New delivery child |
| `Will link` | Complete inspection proves one compatible existing top-level delivery capability | Explicit existing-child link |
| `Needs a choice` | Ambiguous authority, competing parent, pending proposal, incomplete coverage, or other unresolved fact | Excluded until resolved |
| `Left out` | Not selected, explicitly set aside, unreachable, or failed | Excluded |

One failed repository never becomes evidence of absence and never blocks eligible repositories.

## 4. Atomic proposal command

```text
singularity-flow capability map-team <TEAM-ID> \
  --lead <LEAD-URL> \
  --name <TEAM-NAME> \
  [--jira-project <KEY>] \
  [--member <CHILD-ID>=<CREDENTIAL-FREE-GIT-URL>]... \
  [--member-name <CHILD-ID>=<FRIENDLY-NAME>]... \
  [--link <EXISTING-CAPABILITY-ID>]... \
  --json
```

The command:

- accepts at most 20 combined new members and links;
- revalidates every URL and the exact approved authority at the mutation boundary;
- creates or reuses one matching collection;
- declares every new repository in `singularity/portfolio.yml`;
- writes every child/link into `singularity/capabilities.yml`;
- validates the complete resulting portfolio and map;
- creates exactly one review branch and proposal commit; and
- leaves approved configuration, application branches, state, and workspaces unchanged until normal
  proposal activation succeeds.

Safe hidden defaults for a new member are whole-repository source scope, `blobless` clone mode, no
sparse cone, and `refuse` fallback. The UI discloses these read-only values under a collapsed
`Advanced settings` summary; it does not imply per-repository overrides that `map-team` does not
support. A later change uses the normal reviewed capability edit flow unless and until explicit
`map-team` override fields are added. Repository content is never cloned merely to guess a source
root.

## 5. VS Code journey

### Step 1 — Team and repositories

- Team name, derived editable lower-kebab team ID, and optional Jira project.
- Exact selected capability-map authority.
- When no authority is registered, selecting or pasting a repository is not enough: the user must
  explicitly choose one selected repository to own the first reviewed authority.
- Known/provider repository catalog with refresh, search, pagination, visibility/access metadata,
  checkboxes, and a friendly capability name per selected repository.
- Provider disclosure is an explicit `Load GitHub/GHE repositories…` action; refresh then reuses the
  exact active host/account-bound RDS traversal.
- Paste-clone-URL fallback.
- A side panel that renders the exact proposed collection and children.

### Step 2 — Check and onboard

- Progress is shown per repository rather than as one spinner.
- Results use only the four labels in section 3.
- `Needs a choice` and failures can be set aside; eligible rows remain actionable.
- The confirmation page shows the exact team, children, links, authority, defaults, and excluded
  rows before running `map-team` once.
- The resulting proposal opens in the existing capability proposal review page. Protected branches
  retain their existing external pull-request/review path.

### Step 3 — Workspaces

- After activation, the existing workspace form opens with the new team selected.
- Users may also choose capabilities from other registered authorities.
- Before a workspace folder and target have been chosen, the team page labels new repository rows
  `Pending preflight`; it never guesses clone versus reuse. Linked existing capabilities are resolved
  from the activated approved map rather than reconstructed from the earlier inspection response.
- After the user names the workspace and chooses its folder, the existing workspace preflight lists
  every derived repository as `Clone into new workspace`, `Clone missing checkout`, or
  `Reuse/repair managed checkout` from the target and directory evidence available before
  materialization. The materializer revalidates each checkout immediately before mutation; the UI
  never calls directory existence alone proof of a valid reusable Git checkout.
- Workspace creation continues to use `workspace prepare` and the recoverable bootstrap path.

## 6. Safety invariants

1. Provider listing, filtering, and selection grant no governance authority.
2. No credential or provider token enters argv, output, cache, proposal files, or logs.
3. Inspection is explicit, bounded, cancellable, and never inferred from provider visibility.
4. A partial inspection result cannot enter the proposal.
5. One proposal is all-or-nothing for its eligible members.
6. Existing parents and repository identities are never overwritten implicitly.
7. The UI retains partial progress and exact remediation after a failure.
8. Every shell action has the Copilot route `/sf-capability-map`.

## 7. Acceptance criteria

- **TON:AC-001** — Six selected repositories from a 10,000-repository catalog cause exactly six
  inspections and never inspect an unselected result.
- **TON:AC-002** — One failed inspection is labelled `Left out` or `Needs a choice`, while five
  eligible repositories can proceed.
- **TON:AC-003** — The proposal adds one collection and all eligible delivery children in one commit.
- **TON:AC-004** — Any validation, push, or authority race creates no partial approved map.
- **TON:AC-005** — Re-running against the same approved team creates no duplicate collection and may
  add explicitly selected later children.
- **TON:AC-006** — An already-parented capability is refused as `Needs a choice` and is not moved.
- **TON:AC-007** — Workspace preview deduplicates repositories and distinguishes exact reuse from a
  required clone.
- **TON:AC-008** — npm and VSIX tests prove the journey works without source-tree imports.
- **TON:AC-009** — keyboard, screen-reader, cancellation, stale-result fencing, and Windows path
  behavior pass the existing supported-host test matrix.
