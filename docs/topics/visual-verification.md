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
version: 10
---
The figma-mobile work type pins the design file version itself: design-source records carry file key, version, nodes, and export hashes; a newer design version surfaces as a staleness warning, never silent drift; promotion requires exact-record confirmation and invalidates downstream approvals. Declared device profiles make coverage arithmetic — `sflow visual status` lists uncovered profiles and unclaimed artifacts as set operations, promotable from warning to gate. `sflow visual compare` produces a deterministic pixel diff (zero-dependency, honestly RGBA8-only) as evidence for the human decision — never an auto-verdict. The screenshot a reviewer approves is hash-bound into the record.

## Native captures and screen sizes that do not apply

- **Simulator, emulator or device screenshots.** A screenshot taken with `xcrun simctl io booted screenshot` or `adb exec-out screencap -p` comes from no MCP tool, so it is never recorded with `mcp record`. Record it as a native capture: `sflow visual record --phase VISUAL-STEP --profile-id ID --screen-id ID --state-id ID --file PNG --source simulator|emulator|device --device NAME [--os-version VERSION]`. Flow copies the PNG into the Story, binds its digest, reads its width and height from the PNG header and stores the source, device, who recorded it and when. It is refused (`VISUAL_CAPTURE_DIMENSIONS_MISMATCH`, naming expected and actual) unless the size is exactly the profile's width and height times its device scale factor, and coverage checks that again. `visual status` shows it as a native capture; no workflow change is needed to allow it.
- **When a capture counts.** A capture, native or from an MCP tool, is bound to the generation the visual step's next publication creates, and that publication commits it. `sflow phase prepublish VISUAL-STEP` names, and `sflow phase publish` refuses (`VISUAL_COVERAGE_FAILED`), an enforced profile with neither a capture nor a decision for that generation. A capture recorded after the step was published counts from the next generation, so submission, prepublish and `sflow nextsteps` route to publishing the step again rather than to capturing it again. Without a simulator, emulator, device or pinned MCP tool there is no capture to record, and no other image stands in for one.
- **Design sources.** The design-intake publication needs a design-source record: the Figma MCP `get_metadata` result recorded with `sflow mcp record figma --kind design-source --tool get_metadata --phase design-intake --output FILE --file-key KEY --file-version VERSION`. An uploaded export (`sflow documents upload DIR --kind figma-export`) is the package reviewers read and pins no file version, so it is not one; prepublish reports `DESIGN_SOURCE_REQUIRED` before publication refuses it.
- **Comparing by ID.** `sflow visual compare --expected REF --actual REF` takes a Story document ID (`DOC-nnn`), a native capture ID (`vnc-...`), an MCP record ID or a repository path.
- **A Story with no screens.** When the work type declares a surface with no screens, with app review's own profile (`applicationReview: { mode: off, surface: library }`, or `backend`, `cli` or `artifact`), visual coverage is not applicable: the visual step publishes and submits with no capture, nobody skips it or rules out a screen size, and `sflow visual status`, `sflow gate` and the Visual Assurance view say why. It is never guessed from the change: `web`, `auto` or no surface keeps the rule below, and a user-facing file a code step delivered (`.tsx`, `.vue`, `.html`, `.css`...) brings the screenshots back [CQF:REQ-035].
- **A visual criterion whose plan names no screenshot.** When a code step answers for a primary visual criterion and the plan names no evidence file, a person takes the screenshot with SFlow once the step has published. The sign-off on the Decide card (`/sf-decide WORK-ID`, or VS Code's Decide card and Decisions page) offers **Take the screenshot**, which runs `sflow decision screenshot WORK-ID --criterion AC-ID --slot SLOT` (also theirs to run in their own terminal; a chat turn never runs it). SFlow copies the files Git holds into a private folder (never anything untracked, such as a test run's `test-results/`), builds it, serves the static output on a loopback port and opens it in app review's pinned browser (`singularity-flow app-review browser install`) with an SFlow bar naming the criterion and the screen the plan says it shows. The person brings that screen up, since an app's first page is often another one, and clicks **Capture this screen**. When the criterion names several sizes ("at desktop and narrow viewports": 1280×800 and 390×844), or the Story pins more than one visual profile, SFlow captures that screen at each size and puts them side by side in the one screenshot, and the bar says which sizes. SFlow saves that screenshot in the Story's folder under `evidence/visual-sign-offs/` and closes the browser. Nobody capturing within 10 minutes, or closing the browser, takes nothing, and the card says so and offers it again. The person then looks at the screenshot and signs it off on the card, as any other file; that sign-off satisfies the criterion and the step's approval no longer waits for it. `--replace` replaces a screenshot that shows the wrong screen. A tracked application file changed here and not published stops it, named, until it is published or set aside; a tool's output never does. Its Copilot route is `/sf-decide WORK-ID` wherever it is offered. The build is the Story's pinned `applicationReview.preview` when it has one; otherwise SFlow infers only a `package.json` whose `build` script runs `vite build`, with a `package-lock.json`: `npm ci --no-audit --no-fund`, then `npm run build`, output `dist`, and says so on the card. When SFlow cannot build the app, the sign-off says why and names the file to save your own screenshot as (the card then asks you to sign it off), or a dated risk. A screenshot not yet signed off is SFlow's output, never a change to review; the sign-off's own publication commits it.
- **A screen size that does not apply to this Story.** When the workflow lists a profile the app does not target (a phone-only app and a tablet profile), a person who approves the visual step records why, on the Decide card (`/sf-decide WORK-ID`) or with `sflow decision visual-profile WORK-ID --phase VISUAL-STEP --profile PROFILE-ID --not-applicable --reason TEXT` in their own terminal. Coverage then lists the profile as not applicable with the reason, who decided and the decision ID (`VPD-NNN`), never as passed, and warns that it is an exception. A profile the step does not check, or the last one left to evidence, is refused. `--revoke VPD-NNN --reason TEXT` makes the profile required again. Copilot never runs the decision; a refusal for a missing profile names it beside the capture command.

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
