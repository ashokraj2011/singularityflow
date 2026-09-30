# GDP companion authority review — supporting documents in spec-driven work types — 2026-09-30

**Review boundary:** `feat/document-local-storage@38b6b81505f95f6afae284c54cfe8aee21333391` plus the patch reviewed below. The previous review is `COMPANION-LOCK-REVIEW-2026-09-30-STORY-DOCUMENT-IDENTITY.md`.

Exactly one GDP-locked companion changed. `workflow-configuration` names the phases in which the two spec-driven work types accept supporting documents. No phase, approval authority, artifact set, sequence gate or other work type changed. This is not a bulk hash refresh or a new approval authority.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `workflow-configuration` | `spec-driven-standard` and `reference-driven-build` gain `documents: { allowedPhases: [specification, planning] }`. The global list names only the classic phases (intake, requirements, design and the rest), so these work types resolved it to no phase at all: after Story start every upload fell back to the first phase, and planning, which checks the plan against the same sources, could not take a document without a soft-gate override. Now both phases the source review reads accept uploads without one; every later phase still asks for an audited override, as it did. Both work types' node digests move to history in `src/packaged-workflow-history.mjs`, so an unmodified copy of either earlier revision still upgrades as framework-owned. | `sha256:41dae1b036584215970e4aabf1407b6d0acb2b08f1409de42a924882619bcaf2` | `sha256:218c26a36350b07e40596c00038885830d13804c240df7ad2130a990969cb442` |

A Story already started keeps the document policy pinned in its `workflow.resolution`; only Stories started after the upgrade take the new list. The upload window adds no authority: a document is still hashed, attributed, committed and pushed through the same governed transaction, and is offered only to the phases chosen for it. Both digests were computed from the file bytes at the boundary and after the change, not copied from a failing assertion.

Validation at this boundary: the packaged provenance tests (with both new work type digests), the document upload phase tests, the document and Office-document tests, and the source review tests passed. The GDP companion-lock suite must pass against this exact accepted digest.
