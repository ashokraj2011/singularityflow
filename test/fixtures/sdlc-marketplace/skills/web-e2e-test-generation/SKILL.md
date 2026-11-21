---
name: web-e2e-test-generation
description: Generate Playwright end-to-end tests in TypeScript from natural language test steps, reusing existing page objects and accessible locators.
---

# Web E2E Test Generation

Turns test cases written in plain language into Playwright tests for the Acme Retail web storefront, built on the page objects that already exist.

## When to use

- After the web test cases are reviewed and marked `automate`.
- When a web journey changes and its tests must follow.

## Inputs

- The reviewed test cases (`TC-NNN`) with steps, test data and expected results.
- The Playwright setup: `playwright.config.ts`, `web/tests/e2e/`, page objects in `web/tests/e2e/pages/`, fixtures in `web/tests/e2e/fixtures/`.

## Steps

1. **Map steps to page objects.** For each test step, find the page object method that does it. List the steps with no method.
2. **Extend page objects.** Add the missing methods to the existing page object for that page. Create a new page object only for a page that has none. Locators, in order of preference: `getByRole` with name, `getByLabel`, `getByText` for static non-translated text, `getByTestId` as a last resort.
3. **Test data.** Use the fixtures to create synthetic data through the API (for example a signed-in shopper with a cart), not through the UI, unless the UI step is what is being tested.
4. **Write the tests.** One `test()` per test case, titled `TC-NNN <title>`, grouped in a `test.describe` per story. Each expected result is a web-first assertion (`await expect(locator).toBeVisible()`, `toHaveText`, `toHaveURL`).
5. **No waits.** Never `waitForTimeout`. Wait on locators, responses (`page.waitForResponse`) or URL changes.
6. **Tags.** Add `@smoke` or `@regression` in the title as the test case's priority says.
7. **Run.** `npx playwright test <spec file> --reporter=list` on Chromium; then the project list in the config if the case requires more browsers.

## Outputs

A spec file `web/tests/e2e/<feature>/<story>.spec.ts` and any page object changes, all tests passing.

## Example

Test case TC-004: signed-in shopper saves an item for later.

```ts
import { test, expect } from '../fixtures';
import { CartPage } from '../pages/cart-page';

test.describe('ACME-1234 Save for later', () => {
  test('TC-004 signed-in shopper saves an item for later @smoke', async ({ page, shopperWithCart }) => {
    const cart = new CartPage(page);
    await cart.open();

    await cart.saveForLater('Trail Runner 2');

    await expect(cart.item('Trail Runner 2')).toBeHidden();
    await expect(cart.savedItem('Trail Runner 2')).toBeVisible();
    await expect(cart.savedItemSize('Trail Runner 2')).toHaveText('Size 9');
  });
});
```

## Rules

- One test case per test; tests do not depend on each other's order.
- No CSS or XPath locators.
- No real customer data; fixtures create everything the test needs.
