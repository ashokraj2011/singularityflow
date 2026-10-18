# Story Analytics phase flow

Open **Work tools → Story Analytics** to see every phase in the selected Story's
loaded lifecycle report. Cards follow the report's phase order; arrows do not
claim to show executed decision or repair routes. Each card shows its recorded
status. The current phase is highlighted, and selecting a card jumps to that
phase's existing timing row.

Custom phase names, skipped phases, waiting, rejection and stale states are
preserved. Completed Stories do not acquire an invented current phase. When the
matching workflow is available, its explicit current phase takes precedence over
the compatibility report's status-based fallback. A different Story's workflow
is never joined into the report.

The flow uses the existing snapshot, not new Git, network or CLI requests. It has
no diagram dependency or animation, supports keyboard navigation, and stacks
vertically in narrow editor groups. Status text remains visible in high-contrast
themes; color is not the only state indicator.

## Bundle review

The dedicated renderer adds one module to the on-demand panels bundle. The
measured candidate is 3,110,886 bytes and 253 modules on Node 22/macOS; the reviewed
panel ceiling is 3,120,000 bytes and 253 modules. The previous ceiling was
3,110,000 bytes and 252 modules. No startup, gateway, other entry or total-byte
ceiling changes. This is a size measurement, not a command-latency claim.

## Verification

- `test/vscode-dashboard-phase-flow.test.mjs`: phase order, exact arrow counts,
  current phase, timing links, custom and terminal states, HTML escaping and CSP
  integration.
- Existing dashboard/Copilot and lifecycle analytics tests remain applicable.
- VS Code typechecking, build and bundle budgets qualify the shipped extension.
