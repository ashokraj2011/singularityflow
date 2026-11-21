---
name: requirements-writer
description: Turn a feature brief and answered clarifying questions into numbered functional and non-functional requirements with assumptions, out-of-scope items and open questions.
---

# Requirements Writer

Turns a feature brief and the answers to the clarifying questions into a requirements list that delivery and QA can work from. Requirements say what the system must do, never how.

## When to use

- After the clarifying questions for a feature have been answered (or explicitly assumed).
- When an existing requirements file must be extended for a change request.

## Inputs

- The feature brief.
- The answered clarifying questions, with assumed answers marked.
- Any existing requirements file for the same area (`docs/requirements/*.md`).

## Steps

1. Read the brief and the answers. List every distinct capability the user expects.
2. Write one functional requirement per capability:
   - ID `REQ-NNN`, continuing from the highest ID in the existing file.
   - Channel tag: `[web]`, `[android]`, `[backend]` or `[all]`.
   - The word "must" for mandatory behaviour, "should" for desirable behaviour.
   - One behaviour per requirement. Split anything joined by "and" that could pass or fail separately.
3. Write non-functional requirements `NFR-NNN` with a measurable target for each category that applies: performance, availability, accessibility (WCAG 2.2 AA), security, privacy, observability, localisation.
4. Check each requirement is testable: could a tester say pass or fail without asking anyone? Rewrite any that are not.
5. List assumptions (with `assumed` next to answers the user did not give), out-of-scope items and open questions.
6. Remove solution language: class names, endpoints, tables and library names belong in the design.

## Outputs

A Markdown section with:

- A requirements table: ID, channel, requirement.
- A non-functional requirements table: ID, category, requirement, target.
- Assumptions, out of scope, open questions.

## Example

Brief: "Let shoppers save items for later from the cart."

| ID | Channel | Requirement |
|----|---------|-------------|
| REQ-001 | [all] | A signed-in shopper must be able to move an item from the cart to a "Saved for later" list. |
| REQ-002 | [all] | A saved item must keep the size and colour the shopper chose. |
| REQ-003 | [all] | A shopper must be able to move a saved item back to the cart. |
| REQ-004 | [web] | A guest shopper should be asked to sign in when they choose "Save for later". |

| ID | Category | Requirement | Target |
|----|----------|-------------|--------|
| NFR-001 | Performance | Moving an item between the cart and the list must complete quickly. | p95 under 300 ms server time |
| NFR-002 | Accessibility | The "Save for later" control must be usable with a keyboard and a screen reader. | WCAG 2.2 AA |

Assumptions: the saved list has no size limit (assumed). Out of scope: sharing saved lists. Open question: do saved items expire?

## Quality checklist

- [ ] Every requirement has an ID, a channel tag and one behaviour.
- [ ] Every non-functional requirement has a measurable target.
- [ ] No solution language.
- [ ] Assumptions and open questions are listed, not buried.
