---
name: android-xray-creation
description: Document Android test cases in Xray manual test format, with preconditions, device and OS coverage, numbered steps, test data and expected results, traced to acceptance criteria.
---

# Android Xray Test Case Creation

Writes the Android test cases for a story as Xray manual tests, covering the devices and OS versions the app supports, ready for review and for automation.

## When to use

- Step "Test Case Creation" of the QA agent when the channel is android.

## Inputs

- The story key and its acceptance criteria (`AC-NNN`).
- The app's `minSdk` and `targetSdk` from `app/build.gradle.kts`, and the team's device matrix.
- The Xray project key (default `ACME`).

## Steps

1. For each acceptance criterion, write at least one test case. Add negative cases (no network, server error, invalid input) and Android-specific cases where they apply:
   - rotation and process death (state restored),
   - back navigation and deep links,
   - runtime permissions (granted, denied, denied permanently),
   - TalkBack and font scaling to 200%,
   - dark theme.
2. Give each case:
   - ID `TC-NNN`, a title starting with the user and the action.
   - Priority `P1`, `P2` or `P3`.
   - Preconditions: account state, app build flavour, feature toggles, device and OS.
   - Numbered steps, one action each, with test data and the expected result for that step.
   - Labels: `android`, the story key, `automate` or `manual-only`.
3. Device coverage: P1 cases on the lowest supported OS and the latest OS, on a phone and on a large screen; others on the latest OS phone.
4. Produce the Markdown table for review and the Xray JSON for import.

## Outputs

- A Markdown table: ID, title, AC, priority, devices, automate or manual-only.
- `tests/xray/<story-key>-android.json` in the Xray test import format.

## Example

| ID | Title | AC | Priority | Devices | Automate |
|----|-------|----|----------|---------|----------|
| TC-011 | Signed-in shopper saves an item for later | AC-001 | P1 | API 26 phone, API 35 phone, API 35 tablet | automate |
| TC-012 | Saved item survives rotation | AC-002 | P2 | API 35 phone | automate |
| TC-013 | TalkBack announces the saved item | AC-004 | P2 | API 35 phone | manual-only (screen reader output) |

```json
[
  {
    "testtype": "Manual",
    "fields": {
      "summary": "TC-011 Signed-in shopper saves an item for later",
      "project": { "key": "ACME" },
      "labels": ["android", "ACME-1234", "automate", "P1"]
    },
    "steps": [
      { "action": "Open the app signed in and go to Cart", "data": "shopper: test-shopper-01; cart: Trail Runner 2, size 9", "result": "Cart shows Trail Runner 2, size 9" },
      { "action": "Tap 'Save for later' on Trail Runner 2", "data": "", "result": "Item moves to 'Saved for later' with size 9; a snackbar confirms it" }
    ]
  }
]
```

## Rules

- One action per step. Expected results are observable.
- Mark a case `manual-only` only with a reason (for example, screen reader speech output).
