# {{work.id}} — Playwright validation and bounded repair

## Validation scope

{{inputs}}

<!-- sflow:guidance Name the Story commit/tree, generated test paths, approved environment, browser projects, viewports, and acceptance/risk items covered. Say explicitly what this run does not validate. -->

TODO: Name the Story commit and tree, the tests, environment, browsers and viewports covered, and what this run does not validate.

## Commands and environment

| Order | Exact argv / command | Working directory | Exit code | Duration | Result |
|---|---|---|---|---|---|
| 1 | Record the repository-native compile/lint/test command | exact path | integer | elapsed time | passed/failed/not-run |

<!-- sflow:guidance The seeded contract executes `git diff --check`, `npx --no-install tsc --noEmit`, and `npx --no-install playwright test --reporter=json`. Record commands actually executed, not recommended commands. Include dependency, browser, runtime, and relevant configuration versions without copying tokens or machine secrets. -->

## Scenario results

| Scenario / AC | Browser / viewport | Result | Assertion or failure | Evidence |
|---|---|---|---|---|
| `[{{work.id}}:AC-nnn]` | exact project | passed/failed/not-run/blocked | exact outcome | report/trace/screenshot/log path |

<!-- sflow:guidance Never infer a pass from generated code, a screenshot, or another scenario. -->

## Evidence inventory

<!-- sflow:guidance List JSON/HTML reports, traces, screenshots, videos, console messages, network summaries, and MCP records with repository-relative paths and hashes. Redact personal data and secrets. Explain missing artifacts and distinguish unavailable evidence from passing evidence. -->

<!-- sflow:guidance Submission is blocked unless the current generation contains durable Playwright console, network, and screenshot MCP records plus a live, host-observed navigation receipt from `mcp smoke playwright --url <EXACT-APPROVED-URL>`. A failed executable check is reviewable but cannot be approved; a human rejection is the only transition that authorizes and consumes a repair attempt. -->

TODO: List each report, trace, screenshot, log and MCP record with its repository-relative path and hash.

## Repair attempts

| Attempt | Human authorization | Failure class | Evidence-backed change | Re-run result |
|---|---|---|---|---|
| 1 or 2 | approval/decision reference | product / generated-test / environment / infrastructure | exact paths and rationale | exact result |

<!-- sflow:guidance The repair budget is **maximum two human-authorized attempts**. Do not retry automatically. Repair only generated test code or locator strategy supported by fresh evidence; never modify product code, weaken an assertion, hide a failed scenario, or convert an environment failure into a pass. After two unsuccessful attempts, stop with a blocked verdict and request human direction. -->

## Final verdict

<!-- sflow:guidance State `passed`, `failed`, or `blocked`; enumerate failed and not-run scenarios; give the consumed repair count and residual risk. Only a fully evidenced pass may be recommended for publication review, and the quality reviewer—not the agent—makes that advancement decision. -->

TODO: State passed, failed or blocked, with the failed and not-run scenarios, the repairs used and the residual risk.
