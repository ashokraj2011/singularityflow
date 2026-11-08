# GDP companion authority review — Seeded findings-remediation workflow (CQF M6) — 2026-11-08

Review boundary: `0145cb3d51db47c037bffc6fae4b4c811c4a5c85` (`cqf-m6` before this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-06-CONVERGENCE-V6.md`.

One GDP-locked companion changes: `workflow-configuration`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- **What changed:** one new work type, `findings-remediation` (Security and TLM remediation), and two new steps, `findings-intake` and `remediation-plan`, with comments. No existing key changes.
- **The work type:** `[findings-intake, remediation-plan, implementation, verification, conformance]`. The last three are the shared steps, with the same per-work-type `inputs` and `rejectTo` lists the other packaged code workflows give them. Its verification is the shared step, so `repositoryTests: run` runs the repository's own tests; `findings start` also starts the Story with `--test-execution-mode all-configured` (decision 22).
- **Planned claims:** required, clauses from `findings-intake`, the code step owned by `remediation-plan`, as Bug fix's `fix-spec` owns its code step.
- **The steps:** `findings-intake` (artifact kind `requirements`, approved by the existing `engineering-reviewers`, minimum 1) lists the picked register items, one clause each. `remediation-plan` (kind `implementation-spec`, approved by the existing `architecture-reviewers`, minimum 1) states the fix per item and lists every major upgrade for a person; its template says a major upgrade is never made by itself. Their starter templates are `findings-remediation/intake.md` and `findings-remediation/remediation-plan.md`.
- **Agents:** no new agent. The seeded `product-owner` writes `findings-intake` and the seeded `architect` writes `remediation-plan` (their `sflow-phases` and `sflow-default-for` gain the step). Their previous digests stay known in the release registry, so a refresh replaces an unedited copy.
- **Protection:** being a packaged work type, `seededWorkflowProtection` protects it and both new steps like every other seeded workflow.
- **Release registry:** the two templates and the two agents' new digests are in `CURRENT_PACKAGED_ASSET_SHA256`; the work type and steps are in `CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256`.

Who approves anything is unchanged. Approval authorities, minimums, existing `rejectTo` lists, sequence gates and code-delivery policy are untouched.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | The `findings-remediation` work type and its `findings-intake` and `remediation-plan` steps. | `sha256:953603a000e11c357a01bb7aaf3fc719174d64bee034e0f1049b1349ec23d200` | `sha256:d6aa8fcd6e918cd2d015f92bd5c3982bc5ef04e3bbdffcd794e593f0360832ee` |
