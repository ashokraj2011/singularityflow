# SKP implementation status

This tracks implementation of *SPEC-SKP v0.2 — Skill Phases and Bring-Your-Own Workflows*. It is an evidence ledger, not a feature-enable switch. A locally inspected skill is untrusted data; its hash establishes byte identity, not authority or host containment.

| Milestone | Current status | Evidence and boundary |
|---|---|---|
| M0 — compatibility and closed readers | Protective guard implemented; milestone incomplete | Version-2 workflow validation and direct work-type resolution refuse skill-producer fields instead of silently treating them as template phases. No SKP durable writer or reader is registered yet. `test/skp-compatibility.test.mjs`. |
| M1 — inspection and contract compilation | Safe foundations implemented; milestone incomplete | `skill inspect` reads one explicit local directory without Git, network, model, or execution, captures bounded exact bytes, and returns candidate-only findings. A pure compiler checks a purported exact confirmation and lowers a complete contract without writing it. WCA must still prove the human confirmation and candidate-catalog provenance. The current path-based directory scanner is not a native isolation boundary against a malicious concurrent ancestor-directory swap; do not use it as an approved asset writer without closing that race. `test/skp-inspect.test.mjs`, `test/skp-package.test.mjs`, `test/skp-contract.test.mjs`, `test/skp-cli.test.mjs`. |
| M2 — retained Story execution and evidence | Not implemented | Add a versioned approved-configuration asset and WFA skill-package closure, exact accepted-Story reader, input/output and receipt bindings, code-delivery checks, and amendment handling before any executable skill phase is enabled. |
| M3 — BYO and mixed-workflow recipes | Not implemented | Resolve producer eligibility, planned-claim roles, code and non-code recipes, and workflow transfer through the existing owners. |
| M4 — guided shared authoring | Not implemented | Depends on WCA's authenticated shared draft, autosave, revision/confirmation, deletion fence, and Show path. A local `skill inspect` result is not a substitute. |
| M5 — host/platform qualification | Not implemented | `src/skp-host-admission.mjs` checks structured operation-bound enforcement evidence but is **not connected to a qualified host adapter** and cannot establish a sandbox itself. Real pre-effect read/write/tool/egress/control/process enforcement and delivery acknowledgement must be tested on supported installed hosts before launch. |
| M6 — pilot/promotion | Not started | Requires actual end-to-end approved Story runs and measured release evidence. |

The active version-2 phase engine remains template-backed. No current CLI or Copilot command authorizes, installs, launches, publishes, or approves an imported skill as a phase. Do not interpret this status as SKP pilot readiness.

Next implementation order: register closed package/binding schemas and complete approved configuration transport; retain exact bytes in WFA Story snapshots; integrate the existing publication, checks, code-delivery, and approval owners; then connect WCA shared-draft confirmation and a genuinely qualified host adapter. Preserve the template-only guard until all of those paths have executable regression and native-host evidence.
