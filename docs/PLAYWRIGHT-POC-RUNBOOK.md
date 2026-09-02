# Playwright POC setup and rehearsal

This runbook prepares Playwright MCP for the packaged Singularity Flow **POC workflow**. Use it on
every machine that will run the demonstration. It complements the broader
[governed MCP guide](MCP-INTEGRATION.md) by focusing on a repeatable day-of-demo path.

The POC workflow uses Playwright in two different ways:

- The **Playwright MCP server** explores the authorized UI and captures browser evidence.
- The repository's **Playwright test runner** compiles and runs the generated TypeScript tests.

Both must be ready. A passing MCP smoke test does not prove that the repository test suite can run,
and a passing test suite does not establish permission to browse the POC target.

## What the workflow guarantees

The packaged workflow is:

```text
POC intent
  -> regression impact analysis
  -> governed UI exploration
  -> Playwright test generation
  -> Playwright validation and bounded repair
  -> publication and PR review
```

The runtime pins the browser origin supplied at Story intake. Browser evidence must come from the
live Playwright host, remain on that origin after redirects, and match the current host and policy
hashes. Product-source edits are outside the POC source boundary; generation and repair may change
only recognized test-automation paths and governed artifacts. Validation permits at most two
human-authorized repair generations. Publication requires independent quality and engineering
decisions.

## Prerequisites

Before configuring MCP, confirm:

- Node.js 20 or newer, Git, VS Code, GitHub Copilot CLI, and Singularity Flow are installed.
- The target repository is initialized and selected in the intended Singularity Flow workspace.
- The Git remote is reachable and the demo identities can create and push a Story branch.
- The exact development base branch is published remotely.
- The POC target is an explicitly authorized HTTPS URL. Loopback HTTP is accepted for local
  demonstrations; credentials must not appear in the URL.
- The repository installs TypeScript, `@playwright/test`, and its required browser binaries locally.
  The POC quality gate deliberately runs `npx --no-install`, so it never fetches a missing test
  dependency during approval.

Orient before making changes:

```bash
singularity-flow home
singularity-flow workspace current
singularity-flow doctor --offline
git status --short --branch
git ls-remote --exit-code origin
```

Stop if the selected workspace, repository, branch, identity, or remote is not the one intended for
the demonstration.

## 1. Install repository test dependencies

Use the repository's normal locked installation command. For an npm repository this is typically:

```bash
npm ci
npx --no-install playwright --version
npx --no-install tsc --version
```

Install the browser binary through the organization's approved Playwright mechanism before the
demo. Do not wait for a live governed phase to download a browser or resolve a package.

The POC validation phase runs these deterministic commands:

```bash
git diff --check
npx --no-install tsc --noEmit
npx --no-install playwright test --reporter=json
```

Run the repository's normal compile and Playwright smoke suite once during rehearsal.

## 2. Configure the Playwright MCP host

Singularity Flow owns policy and evidence rules; VS Code or Copilot owns the MCP process, trust, and
credentials. The host server ID must be exactly `playwright` on every surface.

### VS Code

From the target repository root, generate the release-managed host entry:

```bash
singularity-flow mcp scaffold playwright
```

This merge-safely adds `playwright` to `.vscode/mcp.json` without replacing unrelated servers. It
uses the exact package `@playwright/mcp@0.0.79` and the deterministic POC profile:

- isolated, headless browser;
- `1440x900` viewport;
- 10-second action and 30-second navigation timeouts;
- output under the repository's Git common-directory private sidecar (including linked worktrees);
- 5 MiB maximum output size.

If a `playwright` entry already exists and differs, the command refuses to overwrite it. Review the
existing entry first. Use `--replace-server` only when the generated entry is intentionally the
approved replacement.

Do not start the entry yet. Acquire and verify its exact package in step 3, optionally import login
state in step 4, and then review, trust, and start it in step 5.

### Copilot CLI

Copilot CLI reads `~/.copilot/mcp-config.json`, `.mcp.json`, and `.github/mcp.json`; it does not read
`.vscode/mcp.json`. Inspect existing configuration first:

```bash
copilot mcp list
copilot mcp get playwright
```

If no entry exists, add the same pinned deterministic profile:

```bash
copilot mcp add playwright -- \
  singularity-flow mcp serve playwright \
  --package @playwright/mcp@0.0.79 \
  --isolated \
  --headless \
  --output-dir .git/singularity-flow/mcp/playwright-output \
  --output-max-size 5242880 \
  --viewport-size 1440x900 \
  --timeout-action 10000 \
  --timeout-navigation 30000
```

Do not silently remove or replace a contributor's existing host entry. Compare it with the profile
above and resolve the difference explicitly. The `mcp serve` wrapper is intentional: it starts only
the verified Git-local package, supports linked worktrees, and binds managed auth only in memory.
A raw `npx` host bypasses those guarantees.

## 3. Prepare corporate npm or Artifactory access

The Playwright MCP process uses normal npm configuration. Verify that the exact pinned package is
available in the company registry before the demonstration:

```bash
npm view @playwright/mcp@0.0.79 version \
  --registry https://artifactory.company.example/api/npm/npm-virtual/
```

Prefer the existing `.npmrc`, proxy, certificate-authority, and credential setup. Never commit
registry credentials, disable TLS verification, or place tokens in `.vscode/mcp.json`.

Launch VS Code or Copilot from an environment that inherits the approved npm registry when the
company setup does not configure it globally:

```bash
NPM_CONFIG_REGISTRY=https://artifactory.company.example/api/npm/npm-virtual/ code .
```

Check registry reachability without installing anything or writing a readiness receipt:

```bash
singularity-flow mcp probe playwright --network --json
```

Then pre-warm the exact dependency while network access is known to work:

```bash
singularity-flow mcp warm playwright --network
```

This is an acquisition step, not another registry probe. It installs the exact release-managed
package beneath `.git/singularity-flow/mcp/packages`, retains the npm lock integrity, hashes the
bounded production dependency closure and resolved entry point, and completes a bounded MCP
initialization/tool-catalog handshake from that local entry point with npm offline. This disables
npm fetching; it is not a firewall for the MCP process. The closure is
rechecked before serving or live smoke, so a changed transitive file makes the proof stale. The
receipt is machine-local; no tracked file, host
configuration, credential, or browser authorization is changed. A later `mcp doctor` reports the
warm state separately as `not-warmed`, `valid`, or `stale`. Every phase that requires Playwright
requires a valid warm proof. To renew the proof later without any registry or endpoint access, run:

```bash
singularity-flow mcp verify-offline playwright
```

Live smoke starts only this verified local executable with npm offline; it never falls back to
`npx` or downloads a package.

## 4. Import an authenticated browser profile when required

Playwright storage state can contain cookies and local-storage values that impersonate the test
account. Never commit it, paste it into Copilot, or add its absolute path to `.vscode/mcp.json`.
Export it through an approved Playwright login setup, then preview a machine-local import:

```bash
singularity-flow mcp auth import playwright \
  --storage-state /secure/local/path/storage-state.json \
  --profile poc-test-account
```

The preview validates the bounded Playwright JSON shape, prints only the profile ID and a SHA-256,
and changes nothing. After reviewing the exact local source, repeat the same command with the exact
digest it printed:

```bash
singularity-flow mcp auth import playwright \
  --storage-state /secure/local/path/storage-state.json \
  --profile poc-test-account \
  --confirm sha256:<64-hex-digest>
```

The copied state is stored with private permissions under
`.git/singularity-flow/mcp/auth/playwright/`. SFlow derives that path and adds `--storage-state`
only to the in-memory Playwright launch; repository host files, receipts, logs, and status expose
only `poc-test-account` and its digest. The original export is not managed by SFlow and should be
removed through the organization's approved secure-file procedure after import.

Inspect or remove the active copy without exposing its contents:

```bash
singularity-flow mcp auth status playwright --json
singularity-flow mcp auth remove playwright \
  --profile poc-test-account \
  --confirm sha256:<active-storage-state-digest>
```

Importing different bytes or removing the active profile deliberately makes all prior host, warm,
and smoke receipts stale. Re-attest, re-warm, and rerun smoke. The same-origin redirect check remains
mandatory; an authentication profile never authorizes another origin.

On Windows, SFlow removes ACL inheritance and grants only the current user full control, then reads
the ACL back and fails closed if any inherited or additional principal remains. If Windows cannot
apply or verify that user-only ACL, use the organization's host-managed authentication instead. If
corrupt state prevents normal removal, preview and confirm the exact recovery inventory with `mcp
auth clear playwright`. After any profile change, renew the package proof before starting the host:

```bash
singularity-flow mcp auth clear playwright
singularity-flow mcp auth clear playwright --confirm sha256:<preview-digest>
singularity-flow mcp verify-offline playwright
```

## 5. Start, diagnose, review, and attest the host

Only after steps 3 and 4, open **MCP: List Servers** in VS Code, review the managed command, accept
the trust prompt, and start `playwright`. For Copilot CLI, inspect it with `copilot mcp get
playwright`, then start Copilot from this repository. Starting earlier fails closed because the
managed wrapper has no valid warm proof yet.

Static diagnosis does not contact the network or start the server:

```bash
singularity-flow mcp status
singularity-flow mcp doctor --server playwright --json
```

Expected readiness progresses from `needs-host-setup` to `ready` only after the exact package is
warmed and the host entry has been reviewed, trusted, started, and attested. To include an explicit
connectivity check, opt in with:

```bash
singularity-flow mcp doctor --server playwright --network --json
```

The network doctor only checks registry reachability for the exact pin. It does not acquire or
start the package; use `mcp warm` for that separately auditable operation.

After reviewing the exact host entry and governed policy, record the machine-local acknowledgement:

```bash
singularity-flow mcp attest playwright --confirm playwright
```

The attestation is stored outside Git and becomes invalid when the host entry or repository policy
changes. It proves what the developer reviewed; it does not replace the host's trust or login flow.

In Copilot, `/sf-mcp` presents the same readiness and guarded setup flow.

## 6. Start a POC Story with explicit boundaries

New Stories require an explicitly selected remote base branch and the exact authorized browser
target. Neither value is inferred or preselected:

```bash
singularity-flow workspace branches --json

singularity-flow start POC-101 \
  --from-branch develop \
  --work-type poc-workflow \
  --target-url https://staging.example.test \
  --title "Checkout regression POC" \
  --description "Generate governed regression coverage for the checkout journey"
```

Story start refreshes the selected remote branch, creates and publishes only `POC-101`, and records
the selected base branch, base commit, Story branch, destination ref, and authorized target origin.
It never pushes to the selected base branch.

In Copilot, use `/sf-start` or `/sf-story-start`. The skill must show every branch and workflow
choice, ask for the target URL, and pass the selected values explicitly.

## 7. Prove live browser readiness

Run a live smoke test before browser evidence is required:

```bash
singularity-flow mcp smoke playwright \
  --url https://staging.example.test/health \
  --phase poc-ui-exploration \
  --json
```

The smoke test proves the pinned package can start, negotiate MCP, expose the required tool catalog,
launch a browser, navigate to the authorized origin, capture an accessibility snapshot, and close
cleanly. It stores only hashes and the authorized origin, not query strings or credentials.

Run smoke again for every generation that collects browser evidence, including
`poc-ui-exploration` and `poc-validation`. A redirect to another origin fails. A manual claim that
`browser_navigate` ran cannot replace the live host receipt.

## 8. Capture governed evidence

Use only the tools allowed for the active agent and phase. The POC workflow expects:

| Phase | Required Playwright evidence |
|---|---|
| `poc-ui-exploration` | observed navigation, accessibility snapshot, screenshot |
| `poc-validation` | console messages, network requests, screenshot |

Record material output after the MCP host writes it to a local file:

```bash
singularity-flow mcp record playwright \
  --tool browser_take_screenshot \
  --phase poc-ui-exploration \
  --output path/to/checkout.png \
  --note "Checkout page at the authorized staging origin"
```

For `browser_snapshot`, the output must contain Playwright's observed `Page URL`; Singularity Flow
checks that its origin matches the Story authorization. Recorded outputs are copied and hashed under
`singularity/work-items/<WORK-ID>/context/mcp/` and become reviewable lifecycle evidence.

Never publish passwords, session cookies, authorization headers, customer data, or unreviewed
third-party content. MCP output is untrusted until a human reviews it.

## 9. Day-of-demo checklist

Run this checklist from the target repository, not the Singularity Flow product checkout:

- [ ] `singularity-flow --version` reports the intended build.
- [ ] `singularity-flow home` reports the intended workspace, repository, Story, and phase.
- [ ] `git status --short --branch` is clean and the selected Story branch tracks its upstream.
- [ ] `git ls-remote --exit-code origin` succeeds for both demo identities.
- [ ] The exact base branch is present in `singularity-flow workspace branches --json`.
- [ ] `copilot mcp list` or VS Code **MCP: List Servers** shows `playwright`.
- [ ] `singularity-flow mcp doctor --server playwright --json` reports `ready`.
- [ ] The host/policy acknowledgement is current.
- [ ] For an authenticated target, `mcp auth status playwright --json` reports the intended profile digest.
- [ ] The authorized target is reachable with the approved test account and test data.
- [ ] `mcp smoke` succeeds against the exact authorized origin.
- [ ] Local TypeScript compilation and the smallest Playwright test pass with `npx --no-install`.
- [ ] Quality and engineering approvers have distinct valid Git identities and remote write access.
- [ ] Copilot was started from a fresh terminal so repository-scoped telemetry is active when needed.
- [ ] A rollback or fallback recording is prepared in case the staging environment is unavailable.

Before demonstrating a product release candidate, also run from the Singularity Flow checkout:

```bash
npm run poc:release-gate
```

## Troubleshooting

### `Host entry 'playwright' is absent`

Run `singularity-flow mcp scaffold playwright`, then review, trust, and start the server in the host.
Remember that VS Code and Copilot CLI use different host configuration files.

### Playwright package is missing from Artifactory

Ask the registry owner to mirror the exact `@playwright/mcp@0.0.79` release and its transitive
dependencies. Do not change the host entry to `latest` or an approximate range.

### Attestation became stale

The host entry or governed policy changed. Review the new bytes, rerun MCP doctor, and explicitly
attest again. Do not copy another machine's readiness files.

### Smoke succeeds but publication refuses evidence

Check that the Story was started with the correct `--target-url`, the active phase and governed
agent allow the tool, the smoke receipt belongs to the current generation, required outputs exist,
and a snapshot's `Page URL` stays on the authorized origin.

### Test execution tries to download packages

The POC quality commands use `npx --no-install`. Install locked dependencies and browser binaries
during setup, then rerun the same command. Do not make approval depend on an unreviewed live package
download.

### Copilot does not show the MCP server

Run `copilot mcp list` and `copilot mcp get playwright`, then fully restart Copilot after changing
configuration. A VS Code `.vscode/mcp.json` entry alone is not a Copilot CLI entry.

### The target redirects to a login or another domain

Import an approved Playwright storage state with `mcp auth import playwright`, then re-attest,
re-warm, and rerun smoke. If the authenticated journey still finishes at another origin, use the
correctly authorized environment or restart the Story with the right origin. Do not weaken origin
validation to make a redirect pass.

## Related documentation

- [Configure and use MCP with Singularity Flow](MCP-INTEGRATION.md)
- [Verification and release checks](../VERIFICATION.md)
- [Local development runbook](../LOCAL-RUNBOOK.md)
- [Workflow authoring](topics/workflow-authoring.md)
- Run `singularity-flow explain mcp-integration` for the packaged offline help topic.
