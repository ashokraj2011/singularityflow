# GDP M8 — promotion and product UX

Preview an Outcome-to-Workflow handoff without changing state:

```text
singularity-flow delivery promotion-preview <AHS-SESSION> --workflow feature --work-id <WORK-ID> --json
```

After saving and reviewing the plan, apply only its exact digest:

```text
singularity-flow delivery promotion-apply --plan <PLAN-FILE> --confirm-plan sha256:<DIGEST> --json
```

Apply creates the existing Ad Hoc promotion checkpoint plus an immutable, machine-local transition
record. It does not start the target Story, commit, push, or discard application changes. The result
contains an argv array for the ordinary `singularity-flow start` boundary. The human remains in
control of that consequential step.

If the command is interrupted, inspect:

```text
singularity-flow delivery promotion-status <AHS-SESSION> --json
```

If the reviewed plan is stale because the session, branch, HEAD, or effect digest changed, preview
again. The old plan cannot be applied.

VS Code Diagnostics now includes **Delivery & Proof**, a read-only view for mapped Feature/Bugfix
Stories. It shows exact identities and checkpoint gaps without invoking a model, rebuilding the
World Model, requiring AST, or mutating lifecycle state.
