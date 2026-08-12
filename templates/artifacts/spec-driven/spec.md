# Specification — {{WORK_ID}}

<!--
Scenarios come first, and general requirements come after them `[SPK:REQ-068]`. That ordering is the
template's opinion: a requirement written before anyone has described the situation it serves tends
to describe the system instead of the need, and nobody notices until verification.

Where you do not know something, say so with a marker rather than guessing:

    [NEEDS CLARIFICATION: which roles may retry a failed payment?]

The question must be one non-empty line. Markers are extracted the same way clauses are, so a marker
inside fenced or inline code is ignored `[SPK:REQ-063]`. This phase blocks publication while any
marker is unresolved, and a marker is only resolved when a later generation removes it *and* records
the answer `[SPK:REQ-067]` — deleting the text alone is an integrity failure, not an answer.
-->

## Actors

Who uses this, and what authority does each hold?

## User scenarios

Prioritized. Each scenario leads with the situation, then its acceptance cases.

### S1 — <the most important situation, in the user's words>

**Priority:** P1
**Actor:** <role>
**Context:** <what is true before this begins>

- **Given** <the starting state>
  **When** <the actor does this>
  **Then** <the observable outcome>

- **Given** <a variation worth stating>
  **When** <…>
  **Then** <…>

### S2 — <the next situation>

**Priority:** P2

- **Given** … **When** … **Then** …

## Failure and empty states

What happens the first time, with nothing there yet, and when each step fails. These are where
specifications are usually silent and implementations usually improvise.

- **Empty:** <no records yet>
- **Failure:** <the dependency is unavailable>
- **Partial:** <some of it worked>

## Permissions

Who may do each thing, and what a reader without that authority sees instead.

## Boundary conditions

Limits, sizes, counts, timeouts, and what happens exactly at and beyond each one.

## Requirements

Numbered, testable, one obligation each. Cite the scenario each serves.

- **REQ-001** — <requirement>. *(S1)*
- **REQ-002** — <requirement>. *(S1, S2)*

## Non-functional requirements

Latency, throughput, availability, accessibility, privacy, retention. State the number and how it
will be measured; "fast" is not a requirement.

## Constitution articles

Cite the article IDs this specification is bound by `[SPK:REQ-100]`. The kernel validates that each
cited ID exists at the pinned revision before publication `[SPK:REQ-101]`.

- <ART-…>

## Assumptions

What this specification takes as true without proving. An assumption that turns out false is a
change request, not a defect — which is only true if it was written down.

## Out of scope

Named explicitly, so the boundary is reviewable rather than inferred.
