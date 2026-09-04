# GDP-M2 — Shadow Change Passport

Status: implemented as an opt-in, read-only diagnostic. It is not a delivery authority.

## What M2 adds

M2 registers the immutable v1 identities `proof-subject` and `change-passport` with MIG. It then
projects those two records in memory when an existing legacy delivery runtime has produced an exact
Candidate. No record is written to the repository, Git-common state, a state branch, or a cache.

The projection shows:

- the Story or outcome subject and exact Candidate digest;
- shadow completion-contract, effect-policy, proof-policy, and delivery-selection bindings;
- the selected comparison proof profile;
- reusable World Model identity when one is already available;
- legacy decision and publication evidence references;
- unavailable proof, Candidate, or World Model facts as explicit gaps;
- a closed, privacy-safe lifecycle-comparison category; and
- source and projection provenance as hashes, never checkout paths.

The policy and selection bindings are explicitly labelled `legacy-projection`. They are stable
comparison identities, not ratified GDP policy. M2 does not evaluate predicates and therefore never
creates or implies a Proof Summary.

## Use it

From the terminal:

```text
singularity-flow change show WRK-123 --shadow --json
```

Omit the Work ID only when the current governed branch identifies exactly one Story. The
`--proof-profile` option accepts `standard`, `high-assurance`, `regulated`, or `custom-registered`;
the choice remains labelled shadow-only and grants no authority.

From Copilot:

```text
/sf-inspect WRK-123 passport
```

From VS Code, open **Diagnostics**, then select the last tab, **Shadow Passport**. The tab is
intentionally not part of the primary Lifecycle view.

## Safety boundary

The M2 command is classified `read` and `modelPolicy: never`. Its result declares no file, state,
publication, or external-system effects. Its core module has no I/O, Git, lifecycle, model, AST,
World Model, clock, or random dependency. Existing Story, Auto, Ad Hoc, and SGOS records remain the
only authorities.

No gate, approval service, publisher, recovery service, or lifecycle writer imports the shadow
builder. Missing Candidate prevents record derivation and produces `GDP_CANDIDATE_UNAVAILABLE`.
Missing World Model produces `GDP_WORLD_MODEL_UNAVAILABLE`, but never blocks the diagnostic or any
ordinary work.

The output is bounded to 64 KiB, reference lists are deduplicated, sorted, and limited to 256, and
only digest provenance crosses the rendering boundary. The aggregate comparison helper retains only
category counts; it never retains paths, Work IDs, Git identities, Candidate IDs, or raw records.

## Rollback

Remove or disable the explicit shadow command and Diagnostics tab. There are no M2 projection files
or durable shadow instances to migrate or delete. The two v1 schema registrations remain readable
as reserved immutable identities, while existing delivery and lifecycle authorities continue
unchanged.
