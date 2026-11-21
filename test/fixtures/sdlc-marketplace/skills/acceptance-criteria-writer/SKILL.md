---
name: acceptance-criteria-writer
description: Write testable Given/When/Then acceptance criteria for each user story, covering the happy path, edge cases, errors and accessibility, traced to requirement IDs.
---

# Acceptance Criteria Writer

Writes acceptance criteria that a tester can run and a developer can build against, one behaviour per criterion, each traced to the requirements its story covers.

## When to use

- After user stories have been split from approved requirements.
- When a story is changed and its criteria must be updated.

## Inputs

- The user stories (`US-NNN`) with the requirement IDs each covers.
- The approved requirements and non-functional requirements.

## Steps

1. For each story, list the behaviours it must show: the happy path first, then edge cases, validation errors, system errors, permissions, and accessibility.
2. Write one criterion per behaviour in Given/When/Then form:
   - **Given** the starting state, with concrete data.
   - **When** one user action or one system event.
   - **Then** the observable result. Add **And** lines only for results of the same action.
3. Number criteria `AC-NNN`, unique across the feature, and tag each with the requirement IDs it proves.
4. Use concrete, synthetic data ("a cart with 2 items", "the item 'Trail Runner 2, size 9'"), never "some" or "valid".
5. Add at least one accessibility criterion for every story with UI (keyboard, focus, screen reader announcement).
6. Read each criterion as a tester: if it could be read two ways, rewrite it.

## Outputs

For each story, a list of criteria, and a coverage line: `REQ-001: AC-001, AC-002`.

## Example

US-001 As a signed-in shopper, I want to save a cart item for later, so that I can buy it another time. Covers REQ-001, REQ-002.

- AC-001 (REQ-001) Given a signed-in shopper with "Trail Runner 2, size 9" in the cart, When they choose "Save for later" on that item, Then the item leaves the cart And appears in "Saved for later" And the cart total is updated.
- AC-002 (REQ-002) Given the item was saved in size 9, When the shopper opens "Saved for later", Then the item shows size 9.
- AC-003 (REQ-001) Given the network request fails, When the shopper chooses "Save for later", Then the item stays in the cart And the message "We couldn't save this item. Try again." is shown.
- AC-004 (NFR-002) Given a keyboard-only shopper on the cart page, When they tab to an item, Then "Save for later" is reachable And its result is announced by the screen reader.

## Quality checklist

- [ ] One behaviour per criterion; one action per When.
- [ ] Every story has happy path, error and (for UI) accessibility criteria.
- [ ] Every criterion traces to a requirement ID.
- [ ] Data is concrete and synthetic.
