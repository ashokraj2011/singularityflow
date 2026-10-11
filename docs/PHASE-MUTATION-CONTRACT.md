# Phase mutation contracts and three-surface continuation

The implementation derives permissions from each Story's pinned phase policy. It does not
infer that a phase called Planning is read-only, or that every source-writing phase generates code.
Custom and future workflow phases use the same derivation.

## Permissions

| Turn / phase | Direct file edits | Permitted kernel work |
| --- | --- | --- |
| Artifact-only author | This phase's draft folder and exact configured required artifact | Existing phase preparation, checks and publication gates |
| Code author | Artifacts plus application paths, only with the exact open generation | Existing generation, ownership, tests and publication checks |
| Non-code source-and-artifact author | Existing source boundary; without an approved upstream code owner, supporting changes only | No invented generation intent for verification/test authoring |
| Independent source reviewer | Only the exact Git-private report staging file issued by review context | Context/check/retention, never artifact or source authoring |
| Approval/rejection | None, including after the phase advances | Exact scoped decision and its selection receipt; inspection thereafter |
| Session or kernel action | No application edits; no generic external staging wildcard | Existing authorized CLI operations |
| Native chat or pause | Unchanged | No mutation contract enforcement |

Protected process paths, governed state, Git metadata, other repositories and other Stories
are not direct-edit targets. New files validate existing ancestors. Moves validate both ends.
Symlink/hardlink targets are refused. Issued private staging is exact, not directory-wide.

## Turn binding

`boundary-turn` writes a session/turn-specific machine-local record in `copilot-boundaries`,
beside the Copilot mode preference. It is not published Story authority. Its corruption digest,
phase-policy binding, checkout HEAD/ref stamps and 30-minute expiry protect against accidental
staleness; missing/stale explicit permissions never silently authorize edits. They are **not**
protection against a malicious process running as the same OS user.

Kernel CLI operations refresh active records after execution without replaying the operation.
A phase transition cannot promote an existing author/reviewer turn into the next phase. Success
or failure ends an approval turn's decision permission. A new native prompt, pause change, or
session end clears/disables the explicit boundary.

Setup and session attachment remain possible before a Story exists, through their registered
CLI commands and existing human authority checks. This grants no permission to edit arbitrary
files or bypass a phase gate.

## Interception and its limits

The shipped pre-tool hook covers structured file edits and patches, including batched targets
and moves. Its cache validation requires no Git process. The post-terminal hook compares
content fingerprints, not only porcelain path/status, so another edit to an already-dirty or
untracked file is detectable. It preserves bytes and points at recovery rather than deleting work.
Kernel-only commands use their existing lifecycle boundaries; ordinary native turns short-circuit.

The Copilot “Hooks reference” documentation
defines pre-tool denial and post-tool `additionalContext`. Post-tool detection therefore emits
a preserved-work warning and latches the next file/raw-shell restriction; it cannot veto an
already-executed command or force the whole host to stop. Host hook timeouts can fail open.

This is **not an OS sandbox**. Author shell commands, child processes, ignored paths and tools
outside the configured hook coverage are not guaranteed prevention. A shell failure/unsupported
host still needs lifecycle inspection; a background process can change bytes after a post-hook.
Large dirty trees incur fingerprinting cost. Do not claim complete shell containment.
Delegation is denied in approval/session/review turns. Author-delegated child sessions still need
their own verified hook binding; coverage is not inferred for unbound child tools.

`doctor` reports hook assurance as **host qualification required**, not `prevented` just because
the plugin is installed. Fixtures test guard decisions and native/pause behavior; a real installed
Copilot host still needs a safe tool-family/denial probe before prevention can be claimed. VS Code
native chat without effective hooks remains advisory/detected by lifecycle checks.

## Approval and next actions

Tool execution and command display use separate validation. A standalone approval command may
carry one syntactically valid private `--selection-receipt`; the hook does not authenticate it.
The CLI still validates the receipt's phase, Story, reviewed packet, identity, expiry and one-time
consumption. Receipt-bearing commands are never reusable guidance or model-free replay commands,
and durable argument logs redact the receipt. Do not remove the receipt or add `--yes` to bypass
a tool refusal. Tests exercise the serialized hook and actual receipt-backed CLI together.

`approve ... --for-agent --json` changes presentation only. It keeps the decision, retained review
bindings, commit/push status, self-approval warning and final verdict, without printing documents
or next-phase authoring context again. It instructs the model to end the turn. Re-approving an
approved phase yields `PHASE_ALREADY_APPROVED`, not a next-phase coding instruction.

Every shared next-action renderer and every packaged skill presents these surfaces in order:

1. Copilot command.
2. `singularity-flow` shell command.
3. VS Code model-free `@sflow` command, **only** when the existing exact crosswalk supports it;
   otherwise, `not available for this action`.

Unsupported selectors, arbitrary flags or authority-bearing routes are never translated into an
invented model-free command. Readiness, consent, tests, independent review and approval still apply.

## Validation

Regression fixtures cover arbitrary phase names and policy combinations, private reviewer staging,
new-file and rename targets, expired/corrupt records, concurrent author/approval turns, checkout
changes, already-dirty content, approval refusal/success handoffs, native/pause reset and unsupported
model-free alternatives. Existing phase-entry and sequence simulations, command-result schema,
skill policy audit, and VS Code build/type-check remain part of validation.

Install the updated CLI **and** plugin/skills (and VS Code extension for UI presentation). Older
installed hook configurations do not acquire these protections merely because main changed.
