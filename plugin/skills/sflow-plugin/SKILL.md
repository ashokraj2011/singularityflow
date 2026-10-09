---
name: sflow-plugin
description: Inspect, verify, install, or uninstall the packaged Singularity Flow Copilot plugin without touching governed repositories.
disable-model-invocation: true
argument-hint: "list|verify [--json]|path|install|uninstall"
---
# Manage the Copilot plugin

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

1. Run `singularity-flow plugin list`, `singularity-flow plugin verify --json`, or `singularity-flow plugin path` before changing installation state. Verification owns Copilot-version compatibility: it prefers the current flat plugin inventory plus one flat skill inventory, and uses legacy bounded scoped inventories only when the plugin inventory explicitly reports that JSON is unsupported.
2. For install or uninstall, show the exact plugin identity and target path and require an explicit request.
3. Run only the requested `singularity-flow plugin install|uninstall|verify` command and relay discovery, byte-integrity, or restart guidance. Every verification requires exact enabled identities and skills and byte-checks direct aliases. The current path-bearing inventory also requires exact direct paths and packaged sources, and rejects missing, stale, symlinked, or non-regular packaged skill files.
4. Never remove personal skills, edit a governed repository, or substitute a full reinstall unless the user asks for that broader operation.
