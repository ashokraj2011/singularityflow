# {{work.id}} — POC intent and environment

## Objective and scope

State the user-visible behavior this proof of concept must validate, the reason it matters, the
expected demonstration outcome, and explicit exclusions. Separate confirmed intent from
assumptions. This workflow automates regression evidence; it does not authorize product changes,
environment changes, or production traffic.

{{inputs}}

## Repository and branch context

| Field | Governed value |
|---|---|
| Workspace / repository | Record the selected governed workspace and required repositories |
| Remote and selected base | Record the remote base branch chosen during Story start |
| Pinned base commit | Record the exact refreshed remote commit |
| Isolated Story branch | Record the Story branch; it must differ from the selected base |
| Existing test framework | Record the detected Playwright configuration, test roots, and commands |
| Language and compile check | Record the existing Playwright language and its exact local compile check; the seeded gate runs TypeScript `npx --no-install tsc --noEmit` |
| Playwright validation | Record approved overrides; the seeded gate runs `npx --no-install playwright test --reporter=json` |

Do not accept a local-only base branch or silently choose a default. The normal Story-start
preflight owns remote access, ancestry, branch creation, and publication of the isolated Story ref.

## Target environment

| Field | Approved value |
|---|---|
| Environment name | Record dev, test, staging, or another approved non-production target |
| Base URL / allowed origins | Record the exact authorized HTTPS origin(s), or loopback HTTP (`localhost`, `127.0.0.1`) for a local target |
| Browsers and viewports | Record the required browser projects and deterministic sizes |
| Test-data boundary | Record reusable fixtures/accounts and cleanup requirements |
| Access method | Name a secret reference or host-managed login; never record a secret value |
| MCP readiness | Record scaffold, attestation, and live-smoke receipt status for this exact origin |

Intake records readiness only; the intake agent never browses the target. Before intake is
approved, the contributor runs these host checks on their own machine, and this intake records the
status they report:

```text
singularity-flow mcp scaffold playwright
singularity-flow mcp attest playwright --confirm playwright
singularity-flow mcp smoke playwright --url <AUTHORIZED-URL>
```

The smoke receipt is machine-local and becomes stale whenever the host entry or governed MCP policy
changes. If the repository's Playwright suite is not TypeScript, or uses a nonstandard compile or
Playwright command, record it here as a blocker: the POC phase quality commands change through
governed configuration before starting the Story. Never silently skip either executable gate.

## Test intent and acceptance criteria

Create stable acceptance criteria such as `[POC:AC-001]` from the contributor's actual request.
Each criterion must name an observable journey, state, or quality property and its expected result.
Include positive, negative, accessibility, visual, and boundary behavior only when applicable; do
not manufacture scenarios merely to fill categories.

| Authoritative clause | Observable journey or property | Expected result | In scope |
|---|---|---|---|
| [POC:AC-001] | TODO: replace with the approved observable journey or quality property | TODO: replace with its measurable expected result | yes/no |

Add, remove, and renumber rows to match the approved POC intent. Keep every anchor fully qualified
as `POC:AC-nnn`; later exploration, generated tests, validation, and review must cite these exact IDs.

## Safety and access

- Confirm the target is authorized for automated interaction and identify prohibited actions.
- Keep host approvals enabled for browser and repository tools.
- Do not collect or publish credentials, personal data, session tokens, or unrestricted traces.
- Do not write the selected base branch or use GitHub MCP file mutation as a shortcut.
- Record unresolved access, environment, or product decisions as blockers before approval.
