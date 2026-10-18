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

On Windows, SFlow's Git children receive `core.longpaths=true` so nested retained snapshot paths
can be indexed. This is process-local configuration; installation does not change global Git
settings or the repository's saved Git configuration.

The usual 30-minute advisory cache settings remain unchanged. Context scope coalescing is only for
one invocation; mutations still run their existing fresh identity, lifecycle and authorization gates.
