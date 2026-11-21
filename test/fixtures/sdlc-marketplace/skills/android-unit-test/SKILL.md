---
name: android-unit-test
description: Write JUnit and MockK unit tests for Android ViewModels, use cases and repositories, with coroutine test dispatchers and Turbine for flows.
---

# Android Unit Test

Writes local JVM unit tests for the Android app's logic below the UI: ViewModels, use cases, repositories and mappers.

## When to use

- A behaviour can only be checked below the UI, for example a ViewModel state transition or a retry rule.
- New or changed logic in `app/src/main` has no unit test.

## Inputs

- The class under test and the acceptance criteria it serves.
- The existing test setup: `app/src/test/`, the `MainDispatcherRule` (or equivalent), fakes and test data builders.

## Steps

1. List the behaviours: each state the ViewModel can emit, each branch in the use case, each error path.
2. Prefer fakes the project already has (`FakeCartRepository`). Use MockK only for collaborators without a fake.
3. Set the main dispatcher with the project's `MainDispatcherRule` and run coroutines in `runTest`.
4. Test `StateFlow` and `Flow` emissions with Turbine: `viewModel.uiState.test { ... }`, asserting each emitted state in order, then `cancelAndIgnoreRemainingEvents()`.
5. Name tests with backticks describing the behaviour: `` `save for later moves item and emits Saved state` ``.
6. Assert with the project's assertion library (Truth, AssertJ or kotlin.test).
7. Run: `./gradlew :app:testDebugUnitTest --tests '<fully.qualified.TestClass>'`.

## Outputs

Test classes under `app/src/test/.../`, mirroring the package of the class under test, all passing.

## Example

```kotlin
class CartViewModelTest {

    @get:Rule val mainDispatcher = MainDispatcherRule()

    private val repository = FakeCartRepository(items = listOf(trailRunnerSize9))
    private val viewModel = CartViewModel(SaveForLaterUseCase(repository))

    @Test
    fun `save for later moves item and emits Saved state`() = runTest {
        viewModel.uiState.test {
            assertThat(awaitItem().cartItems).contains(trailRunnerSize9)

            viewModel.onSaveForLater(trailRunnerSize9.id)

            val state = awaitItem()
            assertThat(state.cartItems).doesNotContain(trailRunnerSize9)
            assertThat(state.savedItems.single().size).isEqualTo("9")
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

## Rules

- No Robolectric unless the module already uses it.
- No `Thread.sleep`; control time with the test dispatcher.
