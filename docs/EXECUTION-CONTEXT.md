# Shared execution context

SFlow has one execution-context contract, not one machine-wide current Story. Git owns clone and
worktree identity; approved configuration owns repository definitions; a Story branch owns its
lifecycle and configuration pin. Local selection and cached projections never authorize a write.

## Entities and owners

| Entity | Identity and authority |
|---|---|
| Workspace | Local `workspace.json` and registration; no approvals or phase state |
| Repository | Approved credential-free remote fingerprint and portable configured repository ID |
| Clone | Existing `RepoContext.repositoryInstanceId`, from the canonical Git common directory |
| Worktree | Existing `RepoContext.worktreeInstanceId`, private Git directory, own HEAD/index/branch |
| Story | Accepted lifecycle aggregate; ID is independent of its canonical or child branch names |
| Story–repository binding | Repository, Story ref, base ref/commit when retained, and observed checkout |
| Surface | Explicit window/chat/command selection; profile selection is a default, not an override |

`src/execution-context.mjs` exposes immutable projections. `execution-context-scope.mjs` owns cheap
per-invocation selection and coalescing without loading lifecycle code on ordinary commands.
`workspace-membership.mjs` proves actual clone membership independently of the last profile selection.
No new mutable lifecycle database or duplicate checkout registry is introduced.

## Commands and surfaces

All repository-scoped commands accept `--context-root <ABSOLUTE-CHECKOUT>` before their existing
option validation. A missing location or a path that is not its own worktree root is a refusal,
never permission to operate on another workspace. Clone/worktree identity is observed from Git;
selection alone does not attest that a checkout is unchanged. Repository-independent commands
retain their explicit targets.

VS Code clients send the same location selector using `SINGULARITY_FLOW_SURFACE_CONTEXT`; internal
CLI steps rebind it only to their kernel-returned execution location. Each window persists its own
explicit selection. Another window or terminal changing the profile does not retarget it. A window
without an explicit binding first uses its opened folder, then the profile default.

`workspace context --json` and `snapshot --include executionContext --json` expose the same model.
VS Code's core snapshot includes it. The Command Palette offers Inspect Current Execution Context,
Inspect Workspace Clones and Worktrees, Synchronize and Take Over Story, and Clean Up Verified
Unused Clones. Raw context snapshots are inspection data, not human approval.

## Open, synchronize, and take over

- `session open <ID> --json` opens retained local work without silently fetching over drafts.
- `session open <ID> --refresh --json` explicitly synchronizes; a remote failure stays a failure.
- `session takeover <ID> --workspace <PATH> --repository <ID> --json` attaches the exact published
  Story into an isolated checkout where possible, restores pinned reference repositories, and
  synchronizes required delivery repositories from the pinned capability/portfolio. Each sibling
  gets a linked Story worktree rather than switching an unrelated checkout.

Takeover preserves earlier completed synchronization if a later repository fails and reports those
paths. It refuses unavailable local-only documents; it cannot recover unpushed work from a laptop.
It does not transfer credentials, private receipts, conversation history, approval authority or
exclusive ownership. Git fast-forward checks remain the cross-machine publication boundary.

## Checkout lifecycle

`workspace checkouts <WORKSPACE> --json` derives clones and dependent worktrees from the manifest,
verified branch receipts and Git's registry. Automatic branch downloads honor the approved partial/
sparse clone policy. Unknown directories and failed attempts lacking ownership proof are retained.

`workspace cleanup <WORKSPACE> --json` previews recoverable retirement. Repeat with `--apply
--confirm <DIGEST>` to quarantine exact candidates. Add `--purge` to both preview and application to
permanently remove verified unused clones. The two modes have different confirmation digests.

Only unselected, owned branch clones with no dependent worktrees, hidden changes, ignored files,
unpublished refs/reflogs, private document bytes or recovery state may qualify. Canonical/adopted
checkouts and active branch pointers are retained. Cleanup reuses the capability-drop proof and
serializes with SFlow worktree preparation. Purge re-verifies the retired clone before deletion;
branch-checkout receipt/pointer publication shares that fence too. Uncertain or locked retirements
stay recoverable. External Git/editing processes must not modify a cleanup target concurrently.
No remote branch or Story history is deleted.

## Automatic retention

Automatic maintenance defaults to seven days for completed Stories, seven days for cancelled
Stories, and seven days after an owned superseded clone is first observed unused. The default
scan interval is 1,440 minutes (daily). Settings are local to each workspace/laptop, not approved
workflow policy. Zero days explicitly allows immediate eligibility; it never bypasses safety.

```sh
singularity-flow workspace retention <WORKSPACE> --json
singularity-flow workspace retention <WORKSPACE> --completed-days 14 --cancelled-days 7 --unused-clone-days 7 --interval-minutes 1440 --json
singularity-flow workspace retention <WORKSPACE> --enabled false --json
singularity-flow workspace cleanup <WORKSPACE> --automatic --refresh --json
```

VS Code offers Configure Automatic Workspace Cleanup and Run Retention Cleanup Now. Window
heartbeats protect their opened checkout and request interval-gated background maintenance.
`workspace use` and `session open` also request a bounded background pass. There is no installed
OS daemon: a closed application/unused CLI does not run maintenance. Publication and approval
never wait for cleanup. `SINGULARITY_FLOW_AUTOMATIC_CLEANUP=off` stops background launches.

A Story worktree must have accepted `closed` or `cancelled` state, an elapsed terminal retention,
and an exact current remote Story tip matching its local HEAD. Unknown/legacy ownership,
unpublished commits, dirty/hidden/ignored files (including dependency folders), active operations,
private refs, pending publication or unresolved recovery preserve the checkout. Remote failure
also preserves it; a deleted remote Story branch is not proof of safe cleanup.

Normal private session/audit metadata is copied and verified into
`<WORKSPACE>/.singularity-flow/retained-worktree-metadata/` before a no-force Git worktree removal.
These small archives are retained for inspection, not automatically purged. Worktree cleanup does
not delete local or remote Story branches. Canonical/adopted clones and selected branch pointers
remain protected. Unused-clone deletion reuses the manual cleanup proof and leases.
Final worktree removal also holds the ordinary Story subject lease, fencing reopen/publication.

Policy lives in `.singularity-flow/retention-policy.json`; last-pass removals, preservation reasons,
and unused clocks live in `cleanup-state.json`. A background failure is recorded in
`cleanup-error.json`. Invalid records suspend cleanup rather than becoming permission to delete.
Maintenance is bounded to 128 worktree inspections and 32 clone candidates per pass, with a
two-minute between-item budget and bounded individual Git stages. Earlier verified removals remain
reported if a later candidate fails. Worktree batches rotate so a protected first page cannot starve
later completed Stories. Do not run external Git/file writers on a cleanup target.

On Windows, SFlow's Git children receive `core.longpaths=true` so nested retained snapshot paths
can be indexed. This is process-local configuration; installation does not change global Git
settings or the repository's saved Git configuration.

The usual 30-minute advisory cache settings remain unchanged. Context scope coalescing is only for
one invocation; mutations still run their existing fresh identity, lifecycle and authorization gates.

## Qualification

Native macOS and Windows qualification run `39092914507`
passed on Node 22 after integrating main through `78f7ba5b`. It covers all 17 shared-context cases,
window selection and attachment diagnostics, Git child configuration, takeover, cleanup, and the
latest session/refusal integration. macOS passed 86 tests with one Windows-only case skipped;
Windows passed 78 with three POSIX cloud-placeholder cases skipped. The macOS run exercises those
cloud-placeholder cases. Both hosts also passed VS Code typechecking and build.

Local Mac qualification additionally passed the 44 phase-entry tests, attachment durability and
platform suites, 72 latest-main integration tests, and all 2,726 repository checks. Fixtures use
isolated remotes and workspaces: no real Story was approved or advanced and no user clone was
deleted. This is automated integration qualification, not a claim of complete native Copilot Story
latency measurements or execution of every repository test.
