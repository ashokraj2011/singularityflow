---
name: web-xray-creation
description: Document web test cases in Xray manual test format, with preconditions, browser coverage, numbered steps, test data and expected results, traced to acceptance criteria.
---

# Web Xray Test Case Creation

Writes the web test cases for a story as Xray manual tests: readable by a person, importable into the test management tool, and ready to be automated.

## When to use

- Step "Test Case Creation" of the QA agent when the channel is web.

## Inputs

- The story key and its acceptance criteria (`AC-NNN`).
- The supported browsers from `playwright.config.ts` or the team's support matrix.
- The Xray project key (default `ACME`).

## Steps

1. For each acceptance criterion, write at least one test case. Add negative cases for validation errors and failures, and one accessibility case per screen.
2. Give each case:
   - ID `TC-NNN` and a title that starts with the user and the action ("Signed-in shopper saves an item for later").
   - Priority: `P1` (smoke), `P2` (regression), `P3` (extended).
   - Preconditions: account state, cart contents, toggles, browser.
   - Steps: numbered, one action each, with the test data used in that step and the expected result of that step.
   - Labels: `web`, the story key, `automate` or `manual-only`.
3. Browser coverage: P1 cases on Chromium, Firefox and WebKit; others on Chromium unless the story touches browser-specific behaviour.
4. Produce the Markdown table for review and the Xray JSON for import.

## Outputs

- A Markdown table: ID, title, AC, priority, automate or manual-only.
- `tests/xray/<story-key>-web.json` in the Xray test import format.

## Example

```json
[
  {
    "testtype": "Manual",
    "fields": {
      "summary": "TC-004 Signed-in shopper saves an item for later",
      "project": { "key": "ACME" },
      "labels": ["web", "ACME-1234", "automate", "P1"]
    },
    "steps": [
      { "action": "Sign in as the shopper and open the cart", "data": "shopper: test-shopper-01; cart: Trail Runner 2, size 9", "result": "The cart shows Trail Runner 2, size 9" },
      { "action": "Choose 'Save for later' on Trail Runner 2", "data": "", "result": "The item leaves the cart and appears under 'Saved for later' with size 9" }
    ]
  }
]
```

## Rules

- One action per step. Expected results are observable, never "works correctly".
- Test data is synthetic.
