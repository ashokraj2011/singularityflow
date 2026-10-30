# SDA M4: the subject branch behind the lifecycle authority adapter

Specification: `docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md` (§6.2, §6.4, §7, §20 M4).
Authority: ADR 0018 option A. Each subject's own branch stays lifecycle authority; M4 adds no
namespace and migrates nothing.
Engine: `main@804e00ee4` plus this change.

M4's exit condition: all workflow families keep their final fresh binding and existing governance tests.

## What landed

| Deliverable | Where | Checked by |
|---|---|---|
| Lifecycle authority contract | `src/sda/lifecycle-authority-contract.mjs` | `test/sda-lifecycle-conformance.test.mjs` |
| Production adapter: the subject branch | `src/sda/story-branch-authority.mjs` | the same suite, against a real bare remote |
| Every transition and authority observation routed through it | 6 publishing families and 11 observation sites (below) | `test/sda-lifecycle-boundary.test.mjs` |
| Final fresh binding with a fresh advisory index | `commitAndPublish` through the adapter | `test/sda-lifecycle-final-binding.test.mjs` |
| Lifecycle refusals in the §7.1 vocabulary | `src/outcome-classes.mjs`, `src/publication-unit-of-work.mjs` | the conformance suite and the final-binding test |

## The contract

`sda-lifecycle-authority/draft-1`. An adapter has:
- a descriptor, with `production` or `test-only` qualification;
- four capabilities: `exact-observation`, `conditional-transition`, `pending-recovery` and `cancellation`.

Its operations:
- **`observe({ branch, remote })`** reads the authority's exact revision. The answer is `present`,
  `absent`, `unreachable` or `malformed`.
- **`publish(transition)`** makes one lifecycle change. The change is bound to the revision it extends
  (`expectedRemoteSha`), or it states an `unleased` reason (SDA-AC-025).
- **`pending(subject)`** returns the transition retained for recovery, or null.

Refusals read through `lifecycleAuthorityOutcome`:
- `REVISION_CONFLICT`;
- `OUTCOME_UNKNOWN`;
- `pending-recovery`;
- `retained-locally`: committed here and refused by the authority for another reason;
- `cancelled`, `unsupported` or `failed`.

`selectLifecycleAuthority` refuses:
- a test-only adapter;
- another contract's adapter;
- an adapter missing a capability.

M1's descriptor and selection helpers are shared, and M1's codes keep their meaning.

## The production adapter

`src/sda/story-branch-authority.mjs`, id `subject-branch`, is a wrapper and adds no store.

- **A transition is the publication unit of work, unchanged.** That covers:
  - the subject lock;
  - the publication journal and preimage;
  - the commit;
  - the atomic push of branch, ledger entry and pin under exact leases;
  - signing;
  - the pending record a failed push leaves.
- **The unit of work loads on the first transition only.** A command that only observes never loads
  the publication writer. Recovery, test-recovery admission and promotion are such commands.
- **An observation is one exact `ls-remote`,** or the same question already asked at command start
  where the Story publication used it before.
- **Cancellation** is honoured before an operation starts and passed to the observation's `ls-remote`.
  Once a push may have reached the remote, the outcome is the push's.

### What now goes through it

- **Transitions:**
  - Story (`story-publication-service.mjs`);
  - Initiative (`initiative-state.mjs`);
  - Initiative repository seeds (`initiative-repositories.mjs`);
  - Goal (`governed-goals.mjs`);
  - ad hoc landing (`adhoc/landing.mjs`);
  - local identity (`local-identity.mjs`).
- **Authority observations:**
  - the Story final fresh binding;
  - the Initiative publication binding;
  - pending-publication recovery for the root, sibling and capability publications (`state.mjs`,
    `initiative-state.mjs`, `publication-pending.mjs`);
  - test-recovery admission and runtime;
  - TRP delivery selection and documents;
  - step-action recovery;
  - Story promotion (`story-lineage.mjs`).

`test/sda-lifecycle-boundary.test.mjs` fails if any module but the adapter builds the unit of work or
observes a remote branch. Three direct observations remain, and none of them is a lifecycle subject:
- the shared configuration drafts branch (`wca-git-drafts.mjs`);
- SGOS Candidate publication onto an operator-chosen branch, under its own confirmed plan
  (`sgos/candidate-lifecycle.mjs`, two sites);
- the SGOS authority store branch (`sgos/authority-git-transport.mjs`).

## The exit condition

**Final fresh binding.** A governed Story transition reads the live Story branch through the adapter
as it publishes. `test/sda-lifecycle-final-binding.test.mjs` shows this with the read index just
refreshed (`index refresh`):
- another clone advances the Story branch;
- `phase publish` refuses with `STORY_PUBLICATION_REMOTE_DIVERGED`, class `REVISION_CONFLICT`;
- HEAD, the working tree and the remote are unchanged;
- no pending record is written.

**Conformance.** The subject-branch adapter and a test-only in-memory adapter
(`test/helpers/sda-lifecycle-memory-adapter.mjs`) pass one suite:
- an exact observation: absent before the first transition, its revision after;
- a transition bound to a revision another writer moved never lands, and that writer's revision
  stands;
- a lost response:
  - it is `OUTCOME_UNKNOWN`;
  - the authority holds the commit, and `pending()` names it with `transport-indeterminate`;
  - the next transition is refused as `pending-recovery`.
- a transition naming no expected revision is refused before any change;
- a cancelled observation, transition or pending read changes nothing.

For the Git adapter, the lost response comes from a Git wrapper that lets receive-pack accept the push,
then reports a lost connection.

**Existing governance tests.**
- The 120 lifecycle, publication, recovery, TRP and family test files pass with the slow lane: 1,130
  tests. Thirteen `vscode-*` and `apps/vscode`-importing files run only under the suite runner, which
  loads TypeScript.
- After the last change, the 21 core lifecycle and SDA files pass: 348 tests.
- **The full suite with the slow lane passes 12,688 of 12,707 tests.**
  - One shard passed on its own: 934 tests, after it exceeded its 30-minute deadline under load. The new
    test files had moved the heaviest files into it.
  - `cab-architecture.test.mjs` failed on the removed export and is fixed (below).
  - `workspace-run-runtime.test.mjs` missed a 5-second readiness deadline under load, and passes alone.
  - Two `install-build-outputs.test.mjs` cases fail identically on `main@804e00ee4`. They depend on an
    `fs.watch` event arriving during cleanup. They are not caused by M4.

## Fixed on the way

- **Observing a remote by name.** `exactRemoteBranchObservationAsync` freezes its transport to one
  exact URL, so a configured remote's name was read as a URL. The answer was always `unreachable`.
  - Affected: test-recovery admission and runtime, and TRP delivery selection and documents. They
    passed `config.git?.remote ?? 'origin'`, so their `remoteAcknowledgedCommit` was always null on a
    published repository, since 2026-10-02.
  - The adapter resolves a configured name to its exact fetch URL.
- **Lifecycle refusals had no class.** Three now map to `REVISION_CONFLICT`:
  `PUBLICATION_LOCAL_PARENT_CHANGED`, `PUBLICATION_REMOTE_LEASE_PARENT_MISMATCH` and
  `STORY_PUBLICATION_REMOTE_DIVERGED`.
  - A retained commit whose push failed carries `OUTCOME_UNKNOWN` (transport indeterminate) or
    `REVISION_CONFLICT` (a moved lease), and its `pushOutcome`.
  - The pending-publication refusal carries `PUBLICATION_PENDING`, the code `state-planes.mjs` already
    reports for that condition.
- **The `publishLifecycleChange` export is removed.** No source or test used it once the families
  went through the adapter. CAB's design contract (`docs/contracts/cab/architecture-v0.2.json`) bound
  its `publication` fact to that export. It now names `GitPublicationUnitOfWork`, the same authority in
  the same module.

The unit of work and the CAB contract are GDP-locked companions: see
`docs/contracts/gdp/COMPANION-LOCK-REVIEW-2026-10-30-SDA-LIFECYCLE-AUTHORITY.md`.

## Budgets

Raised with measured values. The growth is the adapter and its contract,
`src/sda/shared-state-contract.mjs` included, in closures that observe the authority. The unit of work
they wrap loads only on a transition.

| Budget | Ceiling | Measured |
|---|---|---|
| `commands/start.mjs` modules | 461 | 461 |
| Submit files | 466 | 466 |
| Session current | 3,985,000 | 3,980,217 |
| Narrow-reads chunk | 4,560,000 | 4,557,115 |
| Hook-context chunk | 7,610,000 | 7,605,711 |
| Catalog chunk | 5,395,000 | 5,392,641 |
| VS Code `gateway-runtime.cjs` modules | 791 | 791 |

The unit of work joins the cold bundle's `publication` family, because it is now imported dynamically.

## New names (SDA-AC-023)

`test/sda-names.test.mjs` lists them with their owning modules. M4 adds no command, configuration key or
machine location.
- **Contract:** `sda-lifecycle-authority/draft-1`.
- **Capabilities:** `exact-observation`, `conditional-transition`.
- **Outcomes:** `pending-recovery`, `retained-locally`.
- **Adapter id:** `subject-branch`. `story-branch` already names a mutation scope.
- **An existing code with one meaning:** `PUBLICATION_PENDING`, now also thrown by the unit of work.

## Open after M4

- **Cancellation mid-transition.** The unit of work takes no signal, so a transition is cancelled only
  before it starts (§7.3 asks for propagation to the underlying operation).
- **Recovery** (`sync`, `recover`) stays with the existing commands. The contract exposes the pending
  record, not a reconcile operation.
- **Lifecycle state is still read from the checkout.** Under option A the Story's state lives on its
  branch, so local reads of `workflow.json` are source-control reads, as the ADR accepts.
- **Still open from earlier milestones:** the Windows measurements, and the clones listed after M3.
