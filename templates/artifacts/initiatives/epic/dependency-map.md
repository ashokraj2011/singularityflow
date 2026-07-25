# Dependency and Sequencing Map — {{workId}}

The narrative companion to `story-plan.yml`. The executable edges live there and
drive the merge order; this document explains *why* those edges exist, what
crosses a repository boundary, and where the delivery risk concentrates.

Keep the two consistent. If a dependency is described here it must exist in the
Story plan, or it will not be enforced.

## Delivery sequence

Order Stories by the point at which they can start, not by preference. A Story
whose dependency has not reached its `requiredPhase` cannot begin.

| Order | Story | Repository | Blocking | Depends on | Required phase of dependency | Can start when |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | STORY-001 | | Yes | — | — | Immediately |

## Dependency graph

```mermaid
flowchart LR
  STORY001["STORY-001"] --> STORY002["STORY-002"]
```

## Critical path

The longest chain of dependent Stories — the sequence that sets the Epic's floor
duration. Shortening anything off this path does not make the Epic finish sooner.

| Position | Story | Why it is on the critical path |
| --- | --- | --- |
| 1 | | |

## Repository boundaries

Where work crosses repositories, sequencing becomes a coordination problem rather
than a scheduling one.

| Boundary | Producing Story | Consuming Story | What crosses | Coordination needed |
| --- | --- | --- | --- | --- |
| | | | API / Event / Schema / Shared library | |

## Interface contracts

Every contract consumed across a Story boundary must be versioned before the
consumer starts, otherwise the consumer is coding against an assumption.

| Contract ID | Version | Producer Story | Consumer Stories | Compatibility | Agreed |
| --- | --- | --- | --- | --- | --- |
| | | | | Backward compatible / Breaking | Yes / No |

## Integration and merge strategy

Stories in the Epic's own repository branch from the Epic branch and merge back
into it in dependency order; Stories in other repositories branch from their own
default branch. After each merge into the Epic branch, remaining Story branches
must sync from it before continuing.

- Integration points and what is verified at each:
- Stories that must merge together rather than independently:
- Expected conflict areas and who resolves them:

## External dependencies

Work outside this Epic that the sequence relies on.

| ID | Dependency | Party | Needed by | Confirmed | Fallback if late |
| --- | --- | --- | --- | --- | --- |
| EXT-001 | | | | Yes / No | |

## Sequencing risks

| ID | Risk | Affected Stories | Impact on the sequence | Mitigation |
| --- | --- | --- | --- | --- |
| SEQ-001 | | | | |

## Parallelization opportunities

Stories with no dependency relationship that can proceed simultaneously, and the
team capacity that assumes.

-
