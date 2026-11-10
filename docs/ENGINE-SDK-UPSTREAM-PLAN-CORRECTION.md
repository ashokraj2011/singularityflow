# Resolve upstream gaps with their accepted plan correction

The namespace implementation of `upstream.decide` now supports `plan-correction` through the
actual independently authorized correction receipts. The original issue stays with its producing
phase. The shared kernel requires the linked PRC, the same owner and the same linked issue when
the correction names one. An unrelated correction cannot satisfy the gap.

The new `sflow-namespace-upstream-plan-correction-source/v1` records the exact authenticated
correction inventory alongside the original upstream producer. Historical issue/accept-risk/
dismiss/artifact profiles retain their original inputs and wire meanings. A replay verifies
the original correction, authority and conditional transition without the old working checkout.
Real missing or permission errors remain real errors; no successful state flag replaces proof.

Only one issue disposition is recorded. Replaying its operation ID returns the original result;
a different ID cannot record another decision for the same already-decided issue. The current
phase, original plan, publication and approvals stay unchanged. Upstream `return` and `amend`
still require their separate accepted owners and are not inferred from a PRC.

On macOS arm64 with Node 26.12.0, 159 distinct affected checks pass without failures, skips or
cancellations. They include all three storage backends, missing/unrelated/wrong-owner corrections,
shared-only replay, original permission errors, actual artifact batches and native CLI/SDK parity.
Source validation passes 4,154 checks. Architecture/schema checks, VS Code types, the unchanged
2,011-site Git audit and all 13 original bundle ceilings pass. The original 34-check installed SDK
qualifier passes alone in 36 seconds within its unchanged 120/60-second bounds; gateway remains
850/852 modules. This adds one supported outcome; it does not complete the remaining Phase 5/7
owners or change installed Git authority.
