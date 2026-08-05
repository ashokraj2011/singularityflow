# Governed execution

Singularity Flow separates an AI recommendation from permission to change lifecycle state. Copilot
may inspect context and propose work, but the Node engine owns sequencing, identity checks, artifact
hashes, publication, and recovery.

## Five intent routers

| Intent | Copilot skill | Purpose |
|---|---|---|
| Continue | `/sf-continue` | Review a revision-bound action plan, select one current action, then execute it through the engine |
| Inspect | `/sf-inspect` | Read status, artifacts, progress, and prompt composition without changing state |
| Review | `/sf-inbox` and approval skills | Review exact artifacts and the submitted review-packet hash before deciding |
| Recover | `/sf-nextsteps`, `/sf-sync`, and doctor skills | Diagnose pending publication or stale state and follow the engine's recovery action |
| Administer | `/sf-admin` | Run explicit configuration and diagnostic operations; never inferred from ordinary conversation |

The public `/sf-*` names are generated aliases. Their canonical plugin sources remain under
`plugin/skills/sflow-*/SKILL.md`.

## Action-plan protocol

`singularity-flow action plan --json` produces a content-addressed plan under
`.git/singularity-flow/action-plans/`. A plan contains ordered actions and is bound to:

- the current branch and full HEAD SHA;
- the complete worktree status hash;
- the deterministic lifecycle snapshot hash; and
- a short expiry time.

`singularity-flow action execute <PLAN-ID> --action <ACTION-ID> --confirm <KERNEL-VALUE>` reloads the plan and rejects it if
any binding changed. It executes argv directly through the Node CLI; it does not invoke a shell and
does not accept shell composition. Results are recorded under `.git/singularity-flow/action-results/`
so a successful action is not replayed accidentally.

The VS Code **Continue safely** action is a review interface for this same protocol. It does not
recalculate the next lifecycle action in TypeScript.

## Publication boundary

Governed publication uses a temporary Git index:

1. verify the expected branch, HEAD, state hash, and pending-publication status;
2. write state and projections;
3. run deterministic invariants;
4. stage only the declared governed paths in an isolated index;
5. create one commit object and compare-and-swap the branch ref;
6. refresh only those paths in the developer's real index;
7. push without force; on failure, retain the local commit and write a recovery marker under
   `.git/singularity-flow/pending-publication/`.

Unrelated staged changes are preserved and cannot leak into the lifecycle commit. If a governed
path is already staged, publication stops before creating a commit. Arbitrary repository hooks are
not the governance boundary: deterministic Singularity Flow validators run before the isolated
commit, while user hooks remain outside this controlled transaction.

## Review binding

Submission produces a content-addressed review packet. Approval selection receipts include the
packet hash and submitted source commit. Approval/rejection records retain the review-packet hash,
the human Git identity, selected governed agent, authority group, and originating action-plan
context when one exists. VS Code shows the full packet hash in the Inbox before a decision.

## Containment boundary

This protocol governs Singularity Flow lifecycle mutations. It does not claim to sandbox every
shell command an AI or person could run. Repository source edits remain ordinary development work;
state transitions and their Git publication must pass through the engine.
