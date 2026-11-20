# GDP companion authority review — the ceremony landing — 2026-11-20

Review boundary: `1272d7ee6f0e6ee743ce5fb7b17eb25071690352` (`landing-6`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-19-OFFICE-SCANNER.md`.

One GDP-locked companion differs from its accepted bytes: `workflow-configuration` (`templates/workflow.yml`). Two of the branches this landing merges changed it, each by an owner decision of 2026-11-19 ("Yes, all 13"; the design notes are `approvals.md` and `turns_context.md`). Neither branch ran `test/gdp-contract-freeze.test.mjs`, and the landing's full run found the drift. This review records what changed, read from the merged file. The file does not change here, and this is not a bulk hash refresh. Unlike most reviews here, the first change does change who approves some shipped steps, so it is named as an approval change below. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- **Approve twice (ceremony-approvals).** Shipped workflows mark some steps `approval: { automatic: when-ready }`. Each such step keeps `mode: required` with the same groups, minimum and send-back targets. Right after it is submitted, SFlow approves it in its own commit, but only when its reviewer said ready, every check passed and nothing is open for it on the decision list. The approval runs the same check a person's approval runs (`evaluateApproval`, its `automatic` stage), and the approval gate replays the record (`gate.approval.automatic-invalid`).
  - **Steps marked:**
    - `feature`: intake, requirements, design and conformance;
    - `bugfix`: intake, reproduction, fix-design and conformance;
    - `chore`, `spec-code-test-loop`: conformance;
    - `findings-remediation`: findings-intake and conformance;
    - `figma-mobile`: design-inventory, component-mapping and conformance;
    - `classic-delivery`: testing and conformance;
    - `spec-driven-standard`, `reference-driven-build`: specification and release.
  - **Always a person's:** configuration refuses the key (`AUTOMATIC_APPROVAL_NOT_ALLOWED`) on the plan and on any step that may change source files. It also refuses it on convergence, the Figma design-capture step and a rework loop's start.
  - **Back to its people at run time:** a step that needs a second approver, someone other than its author, a signature (SF Guard) or a workflow rule after it goes back to its people, and its submission says why (`AUTOMATIC_APPROVAL_NOT_APPLICABLE`).
  - **The next person's approval:** it shows and binds the steps SFlow approved since the last one.
  - This is the one approval change here. It adds no group or member, and it lowers no minimum.
- **Clarification asked at intake only (ceremony-turns, cut 4).** Nine shared step definitions move from `mode: required` to `mode: when-needed`: requirements, design, implementation-spec, reproduction, fix-design, fix-spec, design-inventory, component-mapping and mobile-spec. Each type's first step (its intake) stays `required`. A comment above `phases:` says so.
- **Comments only:** the approve-twice note above each work type's overrides; the convergence step's note now cites SPK:REQ-032 (a person's approval advances it) beside E2G-001.
- **What this does not change:** no workflow or step is added or removed; no approval group, member, minimum, send-back target, write scope, input or quality command changes; convergence stays a person's approval. `contextPolicy.onApproval` stays `new`.
- **Upgrades:** each changed node's previous digest is registered in `src/packaged-workflow-history.mjs`, so an untouched repository copy is moved and an edited one is kept; the merged nodes all match the current registry.
- **Checked by:** `test/approve-twice.test.mjs`, `test/ceremony-turns.test.mjs`, `test/packaged-provenance-registry.test.mjs`, `test/classic-delivery-workflow.test.mjs`, `test/workflow-step-people.test.mjs`, the journeys (`test/journey-stories.test.mjs`) and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | Approve twice marks the listed steps automatic when ready, on the same groups, minimums and send-back targets; nine shared steps ask only when needed; comments | `sha256:bfa39c3fb714d62999b11b107b8b8393eba6e8f24770e2bb4123ba2979371816` | `sha256:58f70922173ad2efdb6f253e32600c671769a8f8dd29f8fbf76c3c8d5bca25a3` |
