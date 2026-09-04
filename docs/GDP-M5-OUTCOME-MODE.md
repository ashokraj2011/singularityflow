# GDP M5 — bounded Outcome mode

GDP M5 adds an opt-in, model-free delivery decision in front of the existing Ad Hoc landing path.
It does not replace Story workflows and it does not add another publisher.

## Use

Create a reviewed, repository-relative JSON request using the closed `delivery-request` v1 shape,
then run:

```text
singularity-flow delivery recommend --request-file <FILE> --json
```

Save and review the result. Start the bounded pilot only with its exact recommendation digest:

```text
singularity-flow delivery select --plan <PLAN-FILE> --mode outcome --confirm-plan sha256:<DIGEST> --json
```

The request and plan inputs must not make the working tree dirty. Keep them in an ignored local
path or commit the request before recommendation. Selection creates only a private Git-common-dir
Ad Hoc session. Application changes still happen afterward.

Use the ordinary Ad Hoc commands to inspect effects, confirm intent, claim resources, preview the
landing packet, and publish. Publication writes the application change, Ad Hoc authority records,
and exact GDP records in one existing recoverable lifecycle transaction.

## Boundaries

Outcome mode is refused when work predicts multiple repositories, high/critical risk, protected
paths, external effects, credentials, architecture decisions, public contract changes, database
migrations, or more than 40 resources. The returned action is the existing Workflow-mode Story
start command. Missing acceptance clauses require a human choice and never become inferred proof.

Recommendation and selection never invoke a model. World Model and AST availability are not
preconditions. Disabling Outcome enrollment leaves existing Workflow behavior unchanged; an
already selected Outcome session can finish or close through existing Ad Hoc recovery.
