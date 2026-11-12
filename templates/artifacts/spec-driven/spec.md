# Specification — {{work.id}}

<!-- sflow:guidance
Scenarios come first, and general requirements come after them `[SPK:REQ-068]`. That ordering is the template's opinion: a requirement written before anyone has described the situation it serves tends to describe the system instead of the need, and nobody notices until verification.

Where the current Story evidence leaves something material unknown, say so with a marker rather than guessing. Use this syntax:

    [NEEDS CLARIFICATION: <one question grounded in the current Story evidence>]

Replace the angle-bracketed placeholder; never copy or ask it as written. The question must be one non-empty line and must arise from the pinned sources, approved upstream artifacts, repository world model, or a contradiction among them. Markers are extracted the same way clauses are, so a marker inside fenced or inline code is ignored `[SPK:REQ-063]`. This phase blocks publication while any marker is unresolved, and a marker is only resolved when a later generation removes it *and* records the answer `[SPK:REQ-067]` — deleting the text alone is an integrity failure, not an answer.
-->

<!-- sflow:guidance Keep every section of this template. When one does not fit this change (for example Permissions for a library or command-line tool with no roles), write `Not applicable: <reason>` under it rather than deleting it: later steps carry Actors, Failure and empty states, Permissions, Boundary conditions and the other sections forward, and stop when one is missing. -->

## Agent brief

<!-- sflow:guidance Summarize the approved intent for downstream agents in a compact, standalone form. Include the problem, intended outcome, principal actors, most important scenarios, hard constraints, and major exclusions. Do not introduce claims that are absent from the sections below. Exact requirements and boundary conditions are preserved separately by the governed projection. -->

TODO: Write the Agent brief here as visible text; text inside the comment above is not read.

## Actors

<!-- sflow:guidance Who uses this, and what authority does each hold? -->

TODO: Name each actor and the authority each one holds.

## User scenarios

<!-- sflow:guidance Prioritized. Each scenario leads with the situation, then its acceptance cases. -->

<!-- sflow:guidance Before drafting, split the pinned request and recorded answers into observable obligations for the actual interfaces (UI, API, event/message, batch/job, CLI, library or mixed). Keep the source -> REQ/AC -> assertion -> verification mapping in the existing sections. Existing ACs count; do not duplicate clauses or invent controls, endpoints, limits, errors or screenshot requirements. Self-check whether an implementation could meet this draft yet omit an explicit request. Repair clear omissions in this editable draft and recheck within the returned repair policy; preserve published inputs and settled answers. These are authoring instructions, not execution evidence. -->

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

<!-- sflow:guidance What happens the first time, with nothing there yet, and when each step fails. These are where specifications are usually silent and implementations usually improvise. -->

- **Empty:** <no records yet>
- **Failure:** <the dependency is unavailable>
- **Partial:** <some of it worked>

## Scenario coverage

<!-- sflow:guidance One row per behavior/acceptance clause; repeat rows for multiple outcomes. Every referenced S-number must have complete Given/When/Then acceptance cases above. Outcome is success, failure, boundary, or empty. Rejection/error requirements need distinct failure cases, not only happy-path prose. Use the pinned request and clarification answers; do not invent error text or new scope. -->

| Clause | Scenario | Outcome |
|---|---|---|
| `{{work.id}}:REQ-001` | S1 | TODO |
| `{{work.id}}:REQ-002` | S2 | TODO |
| `{{work.id}}:AC-001` | S1 | TODO |

## Permissions

<!-- sflow:guidance Who may do each thing, and what a reader without that authority sees instead. -->

TODO: Say who may do each thing, and what someone without that authority sees instead.

## Boundary conditions

<!-- sflow:guidance Limits, sizes, counts, timeouts, and what happens exactly at and beyond each one. -->

TODO: State each limit, size, count or timeout, and what happens at and beyond it.

## Requirements

<!-- sflow:guidance Numbered, testable, one obligation each. Cite the scenario each serves. -->

- <requirement>. *(S1)* [{{work.id}}:REQ-001]
- <requirement>. *(S1, S2)* [{{work.id}}:REQ-002]

<!-- sflow:guidance Acceptance criteria use the same stable, namespaced form: -->

- <observable acceptance outcome>. *(S1)* [{{work.id}}:AC-001]

## Verification intent

<!-- sflow:guidance One row per declared clause, including non-functional requirements. Methods: test, visual, inspection, or a comma-separated combination (all required). AC Criterion is its own ID. A visual/inspection requirement names the AC proving it; a test-only requirement may use -. An AC a requirement names lists every method that requirement lists: a `test, visual` requirement needs a `test, visual` AC. Choose from the pinned source, not from available tools. A screenshot is visual proof, not a test exemption. Planning must inherit these methods and cannot change them without an approved scope amendment. -->

| Clause | Methods | Criterion |
|---|---|---|
| `{{work.id}}:REQ-001` | TODO | - |
| `{{work.id}}:REQ-002` | TODO | - |
| `{{work.id}}:AC-001` | TODO | `{{work.id}}:AC-001` |

## Non-functional requirements

<!-- sflow:guidance Latency, throughput, availability, accessibility, privacy, retention. State the number and how it will be measured; "fast" is not a requirement. -->

<!-- sflow:guidance Use governed requirement anchors here too (for example `[{{work.id}}:REQ-003]`); `NFR-001` by itself is only a display label and is not a stable clause identity. -->

TODO: State each non-functional requirement with its number and how it is measured, or write None for this change.

## Constitution articles

<!-- sflow:guidance Cite the article IDs this specification is bound by `[SPK:REQ-100]`. The kernel validates that each cited ID exists at the pinned revision before publication `[SPK:REQ-101]`. -->

- <ART-…>

## Assumptions

<!-- sflow:guidance What this specification takes as true without proving. An assumption that turns out false is a change request, not a defect — which is only true if it was written down. -->

TODO: List what this specification takes as true without proving, or write None.

## Out of scope

<!-- sflow:guidance Named explicitly, so the boundary is reviewable rather than inferred. -->

TODO: Name what this change does not do.

## Sources

<!-- sflow:guidance Each supporting document this specification relies on, cited as `DOC-nnn — <name>`, and each one offered to this phase that could not be read or was not available here, named as a gap. Without supporting documents, say so. -->
