# Capability-map Git robustness plan

- **Status:** code-local implementation complete; physical office/Windows release evidence pending
- **Scope:** CLI and VS Code capability discovery, proposal creation, review recovery, and local acceleration
- **Safety invariant:** capability mapping may create only governed configuration/proposal refs; it never writes an application branch

## Outcome

Capability mapping behaves as a recoverable distributed transaction even when Git credentials,
hooks, proxies, branch rules, the network, VS Code, or local cache maintenance fail at awkward
times. A retry discovers the authoritative remote result before authoring anything new. The
operator receives a stable outcome, an exact next action, and a statement of what was preserved.

The implementation and deterministic test fixtures described below are complete in this source
tree. That proves the code paths and safety invariants; it does not substitute for release evidence
from a physical office laptop, its Git Credential Manager/SSO/proxy/CA stack, and the actual server
rules used by the organisation.

## Transaction model

Every mapping follows one state machine:

1. **Prepared** — validate bounded input and a credential-free repository identity.
2. **Authority observed** — read the exact `sflow/config` and matching proposal refs.
3. **Proposal authored** — create one immutable proposal commit with an explicit Git-configured
   author identity. An operating-system username or `unknown@invalid` is never accepted as governed
   authorship.
4. **Push attempted** — publish with exact leases and, where required, atomic ref updates.
5. **Remote result observed** — accept Git's successful push receipt, or independently read the
   exact proposal ref after any failed, timed-out, or otherwise uncertain transport result.
6. **Completed** — report the remote proposal commit; local cache and temporary cleanup are only
   acceleration/housekeeping and cannot reverse this outcome.

No error path claims “nothing changed” unless the remote ref was authoritatively observed to be
absent. An unreachable remote after an ambiguous push is reported as **outcome unknown**. Its
checkout, expected commit, guarded ref, exact `git ls-remote` inspection argv, and exact leased retry
argv are retained. Recovery never reconstructs or continues a partially remembered mutation from
edited form fields.

## Delivery plan

### M0 — identity and bounded inputs (P0) — implemented

- Capture explicit `user.name` and `user.email` before the enterprise Git sandbox hides ambient
  config; remove ambient `GIT_DIR`, `GIT_WORK_TREE`, and similar process selectors first.
- Pass identity explicitly to scratch-repository commits; never fall back to
  `unknown@invalid` for a user-authored proposal.
- Fail before a remote write when either identity field is missing or malformed, with exact
  `git config --global user.name` and `git config --global user.email` remediation commands.
- Bound capability IDs, labels, map fields, collections, and encoded request size before Git work.
- Keep credentials out of stored remotes, diagnostics, commands, and audit records.

### M1 — exact uncertain-push recovery (P0) — implemented

- After a failed, timed-out, or disconnected push, re-read the exact proposal and authority refs.
- Treat `proposal ref == expected commit` as recovered success.
- Treat an absent proposal ref as a confirmed failure that can be retried.
- Treat a different proposal commit or advanced authority as a conflict.
- Treat an unreadable remote as an unknown outcome and retain exact, machine-readable inspect and
  retry argv bound to the authored commit and leased refs.
- Preserve exact-SHA, force-with-lease, and no-application-branch invariants.

### M2 — first-map recovery (P1) — implemented

- Make the two-ref bootstrap explicit and recoverable: an initialized but mapless
  `sflow/config` is a valid intermediate authority, never a corrupt workspace.
- If proposal publication fails after authority creation, identify the intermediate state and
  return an exact read-only authority inspection. The caller retains and replays the complete
  original request; the engine never fabricates a shortened map command that could drop fields.
- A retry reuses the approved bootstrap commit and creates at most one proposal.
- Never publish unreviewed capability bytes to `sflow/config` or `state`.

### M3 — separate durable success from local housekeeping (P1) — implemented

- Temporary-directory cleanup and lead-cache writes run after the remote result is fixed.
- Cleanup/cache failures are warnings with remediation; they cannot turn confirmed remote success
  into a failed Map operation.
- Keep failed scratch paths private and expiry-bounded: an opaque machine-local record marks the
  exact checkout and guarded Git argv expired after seven days, and later capability mutations
  safely sweep expired records only after a matching private checkout marker is verified. There is
  no background cleanup daemon. Public
  diagnostics expose only the opaque recovery ID and expiry; no checkout path, Git argv, or
  repository content appears there.

### M4 — bounded proposal authority at scale (P1) — implemented

- Prioritize proposal refs bound to the currently advertised `sflow/config` commit, then scan in
  bounded pages. Already-merged history does not consume the 64 active/unreadable-proposal budget.
- Bound every explicit fetch page independently at 64 refspecs and 24 KiB of conservatively encoded
  Windows UTF-16 argv. Long valid refs therefore reduce page size instead of crossing the
  CreateProcessW command-line boundary.
- Apply an absolute ceiling of 4,096 advertised proposal refs per authority. This is a deliberate
  resource-safety boundary, not an assertion that a larger namespace was fully inspected.
- Report `partial` coverage when the absolute ceiling or active proposal budget prevents complete
  inspection. Partial coverage never authorizes a new mapping.
- Within the ceiling, retained merged branches cannot hide a current-base pending proposal merely
  because it sorts after the first page.

### M5 — durable VS Code operation experience (P1) — implemented

- Persist a bounded operation identity and the exact validated CLI argv before starting Map.
- **Cancel safely** stops the CLI process tree but deliberately changes the result to
  `needs-inspection`; closing/reopening an active panel does the same.
- **Inspect remote outcome** reads pending proposals and approved configuration. It opens an
  existing same-ID proposal, stops when the capability is already active, and enables retry only
  after neither exists.
- **Retry exact request** replays the stored argv, never a newly reconstructed partial command. The
  engine re-observes authority/proposal refs at its mutation boundary, so a late competing change
  becomes an existing-proposal or stale-authority conflict rather than an overwrite.
- Unsafe, unreadable, ambiguous, or incompatible inspection remains `needs-inspection`; the UI does
  not turn uncertainty into permission to retry.

### M6 — enterprise compatibility and release proof (P1/P2) — code-local complete

- Noninteractive credential, proxy/TLS, Git availability, repository-policy, and atomic-push
  failures have stable classifications and sanitized hash/size evidence. SFlow does not weaken Git
  security or silently downgrade the atomic multi-ref boundary.
- Explicit TLS, repository-policy, and atomic-capability diagnostics take precedence over generic
  disconnect or supervisor-timeout wording. The timeout remains recorded as evidence, while the
  actionable provider diagnosis determines remediation.
- Deterministic fixtures cover hook rejection, accepted-then-disconnected reconciliation, process
  cancellation, cleanup failure, an unwritable cache, stale authority, and retained proposal
  history beyond one page.
- Code-local CLI, organisation, Git-execution, VS Code, packaging, portability, static, and
  conformance suites are the release gate.
- Physical macOS/Linux/Windows and office-network evidence remains a release activity, listed
  explicitly below.

## Code-local completion and external evidence

| Area | Current status | Evidence boundary |
| --- | --- | --- |
| Explicit author identity and bounded request admission | Implemented and fixture-tested | Real enterprise identity/signing policy still needs office validation. |
| Exact leases, uncertain-push ref reconciliation, and retained inspect/retry argv | Implemented and fixture-tested | Actual provider disconnect-after-accept behavior still needs a controlled integration run. |
| First-map intermediate authority and retry | Implemented and fixture-tested | Validate against the organisation's branch creation rules. |
| Cleanup/cache failure after remote success | Implemented and fixture-tested | Validate antivirus/file-lock behavior on the target Windows image. |
| Proposal paging, Windows argv bound, and 4,096-ref hard ceiling | Implemented and fixture-tested | Measure latency against a representative large office repository. |
| VS Code persisted operation, safe cancel, inspection, existing-proposal recovery, and exact replay | Implemented and extension-host tested | Run the packaged VSIX in the supported office VS Code build. |
| Provider policy and atomic-capability classification | Implemented and fixture-tested | Verify wording from the actual Git host, hooks, signed-commit rules, SSO, proxy, and corporate CA. |

The remaining entries are evidence collection, not permission to weaken a failed policy. A physical
failure that produces an unclassified diagnostic becomes a new compatibility fixture before the
release is called complete.

## Failure contract

Every proposal refusal or failure returns, when applicable to that stage:

- stable error code and stage;
- whether the result is `not-published`, `published`, `conflict`, or `outcome-unknown`;
- sanitized lead URL and content-free diagnostic evidence;
- exact proposal branch/commit plus structured read-only inspection and leased retry argv for an
  unknown push outcome;
- an exact safe next action for a proven refusal, stale authority, duplicate proposal, or first-map
  intermediate state;
- preserved authorities and application branches;
- local-only warnings separately from the durable Git outcome.

## Acceptance criteria

- An explicitly configured Git name/email remains the proposal commit identity while enterprise
  transport config remains isolated; missing identity refuses before Git observation or mutation.
- An accepted remote push followed by a broken response is reported as success after exact-ref
  observation and never creates a second proposal.
- A truly rejected push reports the hook/provider diagnostic in sanitized form and no false
  success.
- First-map failure between authority bootstrap and proposal publication is idempotently
  recoverable.
- Confirmed remote success survives temporary cleanup and local lead-registry failures.
- A pending current-base proposal remains discoverable after more than 64 retained merged branches;
  long ref names produce smaller fetch pages, and more than 4,096 advertised refs is reported as
  partial rather than silently treated as complete.
- VS Code cancel/reopen/retry cannot blindly replay, duplicate, or overwrite a proposal; it retains
  the exact request and requires authoritative inspection first.
- No mapping path modifies `main`, another application branch, an existing proposal, or a newer
  `sflow/config` revision.

## Explicit exclusions

- SFlow does not bypass TLS, proxy, credentials, hooks, reviews, branch protection, or signed-commit
  policy.
- It does not store credentials or invent Git identities.
- It does not infer a governed author from the operating-system username.
- It does not automatically merge or activate a proposal.
- It does not reconstruct or continue a partially remembered mutation.
- It does not downgrade an atomic push to sequential ref updates when a provider lacks support.
- It does not delete retained proposal history as a performance shortcut.
