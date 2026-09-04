# GDP-M3 deterministic proof observation

GDP-M3 adds a bounded, deterministic proof kernel on top of the GDP-M2 shadow Proof Subject. It is
an observe-only diagnostic: it cannot approve, reject, submit, publish, reopen, or otherwise change
a Story. It does not invoke a model, require AST, or rebuild a World Model.

## What it evaluates

The kernel accepts only registered predicate specifications and exact content identities. A
Predicate Result has one of four total outcomes:

| Result | Meaning |
|---|---|
| `pass` | Every exact input required by the registered deterministic algorithm was satisfied. |
| `fail` | The algorithm found a bound counterexample. |
| `unavailable` | Required evidence or capability is missing, stale, contradictory, malformed, exhausted, or outside a bound. |
| `not-applicable` | The selected proof profile explicitly excludes the predicate. |

The accepted GDP contract uses `not-applicable` as the fourth value. Earlier roadmap prose said
`inconclusive`; M3 corrects that stale label rather than introducing an incompatible fifth value.

Signals are observations, not predicates. They always carry `authority: none` and
`gateEligible: false`, and they cannot make a Proof Summary pass.

## Inspect it

```sh
singularity-flow proof status WRK-123 --json
singularity-flow proof explain WRK-123 pfc.candidate-binding --json
singularity-flow proof gaps WRK-123 --json
singularity-flow proof signals WRK-123 --json
```

From Copilot, use `/sf-inspect WRK-123 proof`. In VS Code, open **Diagnostics**, select **Shadow
Passport**, and review the **Deterministic proof observation** section.

Every surface is read-only. Missing policy authority or World Model identity remains an explicit,
non-blocking gap.

## Identity and storage

Semantic records exclude timestamps, latency, cache status, and storage handles. Identical semantic
inputs therefore reproduce identical hashes across process restarts, checkout directories, and
supported operating systems. Evaluation timing lives in a separate operational receipt.

M3 registers immutable v1 schemas for profile selection, predicate specification and result,
evaluation receipt, Signal observation, Proof Summary, invalidation, Gap item, and Gap register.
Repository records are content-addressed under:

```text
singularity/work-items/<WORK-ID>/gdp/subjects/
singularity/work-items/<WORK-ID>/gdp/evidence/
singularity/work-items/<WORK-ID>/gdp/decisions/
```

Operational evaluation receipts remain in private Git-common state. The append service uses the
existing subject lock and preimage journal: a partial repository append rolls back, an identical
retry converges, and immutable historical records are retained. M3's public commands do not persist
the observation; the store is the reviewed foundation for later enrolled milestones.

## Safety bounds

The kernel admits at most 64 predicates, 256 inputs per predicate, 1 MiB of canonical input data,
16 levels of structural depth, fan-out of 256, 100,000 fuel steps, a 10-second declared deadline,
and 64 KiB per output record. Deadline or fuel exhaustion returns `unavailable`, never `pass`.
Changed input identities transitively invalidate dependent Predicate Results and Proof Summaries.

## What M3 deliberately does not do

- It does not change existing workflows, gates, approvals, recovery, or publication.
- It does not accept gaps; gap authorization belongs to a later milestone.
- It does not treat a model response, heuristic, telemetry sample, or Signal as proof.
- It does not require World Model or AST availability for ordinary work.
- It does not yet implement language/framework-specific exact test adapters; those begin in M4.

To remove M3 from an installation, stop exposing the read-only command and UI section. Its immutable
records remain readable through the migration registry, while existing lifecycle authority and
publication behavior remain unchanged.
