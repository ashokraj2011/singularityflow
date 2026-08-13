---
# EXAMPLE ONLY. Copying this file to singularity/constitution.md is what makes it real
# [SPK:REQ-099] — installing the distribution never activates these articles.
example: true
articles:
  - id: EXAMPLE-001
    type: enforced
    policy: phases.specification.approval.minimum
    rendererVersion: 1
  - id: EXAMPLE-002
    type: judged
    level: must
    evidenceRequired: true
  - id: EXAMPLE-003
    type: judged
    level: should
    evidenceRequired: false
---

# Example constitution

Three articles, one of each shape worth understanding. Copy this to `singularity/constitution.md`,
replace the IDs and text with your own, then run `singularity-flow constitution generate` — the
enforced article's body and hashes are filled in from your approved policy.

Nothing here is active policy. The `example: true` marker is checked, and the kernel refuses to load
this file as a real constitution.

## [EXAMPLE-001] A specification needs an independent approval

Enforced. Its body is generated from the configuration and must not be edited by hand: the whole
point of an enforced article is that it cannot say something different from what the kernel does.
Change the policy through the configuration-authority workflow and regenerate.

The generated block appears here after `singularity-flow constitution generate`.

## [EXAMPLE-002] Every change can be undone

Judged, `must`, evidence required. No policy can check this — a rollback plan is a claim about the
world, not a setting — so a human records the verdict at conformance, and the article's job is to
make sure they are asked. Because evidence is required, this article is carried into implementation
prompts, convergence and conformance even when no artifact cites it.

State how the change is reverted, who can do it, and how long it takes. "It is behind a flag" is a
rollback plan; "we would fix forward" is not.

## [EXAMPLE-003] Prefer boring technology

Judged, `should`, no evidence required. A `should` is a real rule that a reviewer may knowingly
set aside — which is what an exception is for, and why an exception records a reason, a scope and an
authority rather than a checkbox.

Choosing something unfamiliar is sometimes right. Saying why, at the time, is the requirement.
