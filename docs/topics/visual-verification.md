---
id: visual-verification
title: Visual verification for mobile
aliases:
  - visual
  - pixel-compare
  - device-profiles
  - figma-mobile
commands:
  - visual
related:
  - mcp-integration
  - approvals
version: 5
---
The figma-mobile work type pins the design file version itself: design-source records carry file key, version, nodes, and export hashes; a newer design version surfaces as a staleness warning, never silent drift; promotion requires exact-record confirmation and invalidates downstream approvals. Declared device profiles make coverage arithmetic — `sflow visual status` lists uncovered profiles and unclaimed artifacts as set operations, promotable from warning to gate. `sflow visual compare` produces a deterministic pixel diff (zero-dependency, honestly RGBA8-only) as evidence for the human decision — never an auto-verdict. The screenshot a reviewer approves is hash-bound into the record.

## Native captures and screen sizes that do not apply

- **Simulator, emulator or device screenshots.** A screenshot taken with `xcrun simctl io booted screenshot` or `adb exec-out screencap -p` comes from no MCP tool, so it is never recorded with `mcp record`. Record it as a native capture: `sflow visual record --phase VISUAL-STEP --profile-id ID --screen-id ID --state-id ID --file PNG --source simulator|emulator|device --device NAME [--os-version VERSION]`. Flow copies the PNG into the Story, binds its digest, reads its width and height from the PNG header and stores the source, device, who recorded it and when. It is refused (`VISUAL_CAPTURE_DIMENSIONS_MISMATCH`, naming expected and actual) unless the size is exactly the profile's width and height times its device scale factor, and coverage checks that again. `visual status` shows it as a native capture; no workflow change is needed to allow it.
- **When a capture counts.** A capture, native or from an MCP tool, is bound to the generation the visual step's next publication creates, and that publication commits it. `sflow phase prepublish VISUAL-STEP` names, and `sflow phase publish` refuses (`VISUAL_COVERAGE_FAILED`), an enforced profile with neither a capture nor a decision for that generation. A capture recorded after the step was published counts from the next generation, so submission, prepublish and `sflow nextsteps` route to publishing the step again rather than to capturing it again. Without a simulator, emulator, device or pinned MCP tool there is no capture to record, and no other image stands in for one.
- **Design sources.** The design-intake publication needs a design-source record: the Figma MCP `get_metadata` result recorded with `sflow mcp record figma --kind design-source --tool get_metadata --phase design-intake --output FILE --file-key KEY --file-version VERSION`. An uploaded export (`sflow documents upload DIR --kind figma-export`) is the package reviewers read and pins no file version, so it is not one; prepublish reports `DESIGN_SOURCE_REQUIRED` before publication refuses it.
- **Comparing by ID.** `sflow visual compare --expected REF --actual REF` takes a Story document ID (`DOC-nnn`), a native capture ID (`vnc-...`), an MCP record ID or a repository path.
- **A screen size that does not apply to this Story.** When the workflow lists a profile the app does not target (a phone-only app and a tablet profile), a person who approves the visual step records why: `sflow decision visual-profile WORK-ID --phase VISUAL-STEP --profile PROFILE-ID --not-applicable --reason TEXT`. Coverage then lists the profile as not applicable with the reason, who decided and the decision ID (`VPD-NNN`), never as passed, and warns that it is an exception. A profile the step does not check, or the last one left to evidence, is refused. `--revoke VPD-NNN --reason TEXT` makes the profile required again. Copilot never runs the decision; a refusal for a missing profile names it beside the capture command.

## Purpose and prerequisites

Use this topic when the current goal matches **visual verification**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow visual`. Run `singularity-flow visual --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before it changes anything.
- **VS Code:** open Singularity Flow **Visual Assurance**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can change repository or machine-local state: `visual`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain mcp-integration`, `sflow explain approvals`.
