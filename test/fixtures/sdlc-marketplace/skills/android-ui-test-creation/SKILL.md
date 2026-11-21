---
name: android-ui-test-creation
description: Generate production-ready Android UI automation test code from natural language test steps, reusing existing page objects and test tags.
---

# Android UI Test Creation

Turns reviewed Android test cases into instrumented UI tests in Kotlin, using the app's existing page objects (screen robots) and test tags, for Jetpack Compose screens and older View-based screens.

## When to use

- Step "Test Automation" of the QA agent when the channel is android.

## Inputs

- The reviewed test cases (`TC-NNN`) marked `automate`.
- The UI test sources: `app/src/androidTest/java/.../`, page objects in its `pages/` (or `robots/`) package, the `TestTags` object, the Hilt test runner and test rules.

## Steps

1. **Map steps to page objects.** For each test step, find the page object method that performs it. List the steps that have no method.
2. **Find or add test tags.** Every element a step touches must have a tag in `TestTags` and `Modifier.testTag(TestTags.X)` on the composable. Add missing tags to both in the same change, and list them in the output.
3. **Extend page objects.** Add missing actions and checks to the existing page object for that screen. Page objects expose user actions (`saveForLater(item)`) and checks (`assertItemSaved(item)`), never raw finders.
4. **Choose the API.**
   - Compose screens: `createAndroidComposeRule<MainActivity>()`, `onNodeWithTag`, `performClick`, `assertIsDisplayed`; `waitUntil` with a timeout for async state.
   - View screens: Espresso `onView(withId(...))` with idling resources the app already registers.
5. **Test data.** Use the app's fake repositories or the mock server rule (for example `MockWebServer` with JSON fixtures in `androidTest/assets/`). Never call real backends.
6. **Write the tests.** One `@Test` per test case, named `tc011_signedInShopper_savesItemForLater`. Use `@HiltAndroidTest` and the project's rules if the app uses Hilt.
7. **No sleeps.** Never `Thread.sleep` or `SystemClock.sleep`.
8. **Run.** `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=<fully.qualified.TestClass>` on an emulator, or the managed device task if the build defines one.

## Outputs

The test class under `app/src/androidTest/.../<feature>/`, page object changes, any new test tags, all tests passing.

## Example

```kotlin
@HiltAndroidTest
class SaveForLaterTest {

    @get:Rule(order = 0) val hilt = HiltAndroidRule(this)
    @get:Rule(order = 1) val compose = createAndroidComposeRule<MainActivity>()

    private val cart = CartPage(compose)

    @Test
    fun tc011_signedInShopper_savesItemForLater() {
        cart.open()

        cart.saveForLater("Trail Runner 2")

        cart.assertItemNotInCart("Trail Runner 2")
        cart.assertItemSaved("Trail Runner 2", size = "9")
    }
}

class CartPage(private val rule: ComposeTestRule) {
    fun saveForLater(name: String) {
        rule.onNode(hasTestTag(TestTags.CART_ITEM) and hasText(name, substring = true))
            .onChildren().filterToOne(hasTestTag(TestTags.SAVE_FOR_LATER)).performClick()
    }
    // ...
}
```

## Rules

- Reuse before you add: page object methods, tags and fixtures.
- Tests are independent and leave no state behind.
- No real accounts, no real network.
