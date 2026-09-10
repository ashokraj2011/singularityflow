---
name: sflow-repositories
description: List or search repositories already known to SFlow, and guide an explicit GitHub provider search without cloning or mapping anything.
disable-model-invocation: true
argument-hint: "[QUERY] [--provider github --host HOST]"
---
# Find repositories

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Preserve source completeness and refusals, show only admitted bounded rows, and make every follow-up a user-reviewed choice.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

1. Run `singularity-flow repositories providers --json`. This is local and does not check authentication.
2. Unless the user explicitly supplied a provider and host, run `singularity-flow repositories list --scope known --audience model --surface copilot --limit 10 --json`. If a query was supplied, run `repositories search <QUERY>` with those same bounds. Do not run Git, scan directories, or inspect repositories.
3. Provider access is a separate explicit network and disclosure action. Require the exact provider and host from the user, state that private/internal repository names will be placed in this chat, and only after that explicit request run one bounded `repositories list|search --scope provider --provider github --host <HOST> --audience model --surface copilot --disclose-provider-results --limit 10 --json`. Never invent or silently fall back to a host/account.
4. Render the returned `enumeration`, every source state/reason, and safe repositories. State how many returned records are private/internal. Without the explicit disclosure flag, provider records are withheld; direct the user to the native **Choose repository** picker or the exact direct CLI command and do not recover names from caches, the filesystem, terminal history, or another tool.
5. Offer only these unexecuted follow-ups: next page, copy URL, inspect onboarding, map capability, or create workspace. Use returned cursors and opaque `selectionRef` values exactly, and preserve `--disclose-provider-results` on an explicitly disclosed next page. Never construct a locator from a repository name.
6. Stop after listing or preparing a selected action. Do not clone, map, propose, create a workspace, initialize, or mutate provider/SFlow state.
