---
name: sflow-capabilities
description: Explain the effective repository capability, ownership, scope, and approvals without requiring a configured hierarchy.
disable-model-invocation: true

---

# Singularity Flow capabilities

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow capability show [PATH] --json`. Omit `PATH` for the repository root.
2. Relay the deterministic owner, permitted Story scope, required people, reason, and resolution digest.
3. Do not ask for a capability selection when the result is the implicit `repository-root`; call it **This repository**.
4. Do not calculate ownership, policy, or approvals yourself and do not invoke a model.
5. Never edit `singularity/capabilities.yml`. For a requested distinction, use the corresponding
   `/sf-capability-add`, `/sf-capability-protect`, or `/sf-capability-depend` skill. Those commands
   create review proposals and do not activate them.

Use `singularity-flow capability organisation <LEAD-URL> --json` only when the contributor explicitly
asks for the organisation-wide advanced view.
