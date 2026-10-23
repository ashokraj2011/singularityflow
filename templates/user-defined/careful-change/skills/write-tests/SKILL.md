---
name: write-tests
description: Add focused tests that prove the new behaviour and would fail without the change.
---
# Write the tests

- Put tests where this repository already keeps them, in its own style and framework.
- One behaviour per test, named for that behaviour.
- Cover the ordinary case, one edge case (empty, boundary or unusual input) and, where the request
  defines one, the failure case with its observable error.
- A test must fail when the change is removed. If you cannot make it fail, it is not testing the change.
- Run the repository's test command. Report the real counts; never claim a pass you did not see.
