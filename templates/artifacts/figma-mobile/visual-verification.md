# {{work.id}} — Mobile Visual Comparison

## Approved references and implementation

{{inputs}}

## Verification environment

| Field | Value |
|---|---|
| Source commit/tree hash | TODO |
| Platform/framework | TODO |
| Build configuration | TODO |
| Simulator/emulator devices | TODO |
| Locale, theme, text scale | TODO |
| Capture and comparison commands | TODO |
| Pixel/visual difference | TODO: cite each `singularity-flow visual compare` result (comparison ID, differing-pixel ratio and status), or write `not measured: <reason>`; never estimate a percentage |

## Screen comparison

| Screen/state | Design reference | App screenshot | Overlay/diff | Functional result | Visual result | Verdict |
|---|---|---|---|---|---|---|
| SCREEN-001 | DOC-nnn / path | TODO | TODO | pass/fail | TODO | matched/partial/missing/deviated |

Store implementation screenshots as PNG files inside `artifacts/visual-verification/evidence/`,
with descriptive names such as `checkout-actual.png`. Publishing commits the files under this phase
directory, but a file there is not visual coverage. This workflow enforces coverage: the step is
refused until every configured verification profile has a current capture record, or a person has
recorded that the profile does not apply to this Story. Record each capture, taken at that
profile's exact pixel size, with one of:

```text
singularity-flow mcp record <SERVER> --kind visual-artifact --tool <TOOL> --phase visual-verification --profile-id <PROFILE-ID> --screen-id <SCREEN-ID> --state-id <STATE-ID> --output <PNG-PATH>
singularity-flow visual record --phase visual-verification --profile-id <PROFILE-ID> --screen-id <SCREEN-ID> --state-id <STATE-ID> --file <PNG-PATH> --source simulator|emulator|device --device "<DEVICE>" [--os-version <VERSION>]
singularity-flow visual status
singularity-flow visual compare --expected <RECORD-OR-PATH> --actual <RECORD-OR-PATH> --profile <PROFILE-ID>
```

Use `mcp record` for an image a pinned MCP tool produced: `<SERVER>` and `<TOOL>` are that server
and tool (`singularity-flow mcp list` shows what this step allows). A screenshot taken on an iOS
Simulator, Android emulator or device (for example with `xcrun simctl io booted screenshot` or
`adb exec-out screencap -p`) is recorded with `visual record` as a native capture naming its
source and device, never an MCP tool; it is refused unless its pixel size is exactly the profile's.
`<PNG-PATH>` is repository-relative. A capture needs a simulator, emulator, device or pinned MCP
tool that shows the app at that size; without one there is no capture to record, and no other image
may be recorded in its place.

When a configured profile does not apply to this app (a phone-only app has no tablet layout), a
person who approves this step records why with
`singularity-flow decision visual-profile {{work.id}} --phase visual-verification --profile <PROFILE-ID> --not-applicable --reason "<why>"`.
Coverage then lists that profile as not applicable, with the reason and who decided, never as
passed; at least one profile must still have a capture.

`visual status` lists every profile still uncovered; resolve each one before publishing:
`phase prepublish visual-verification` and `phase publish` refuse while one is missing, because a
capture is committed by, and counts for, the publication after it is recorded. A capture recorded
after this step was published counts from the next generation, so publish the step again before
submitting it. Every profile needs its own capture: never record one image under another profile's
ID, and never name a tool that did not produce the image. Measure each difference with
`visual compare` and cite the comparison it writes and, when it makes one, its diff image;
`--expected` and `--actual` take a design document ID (`DOC-nnn`), a capture record ID (`vnc-...`
or an MCP record ID) or a repository path.

The VS Code Inbox and artifact viewer present the pinned design export,
implementation screenshot, and diff evidence together. Approval is always against
the registered pinned hashes, not the live Figma URL.

## Design-system and accessibility checks

| Check | Command/method | Result | Evidence |
|---|---|---|---|
| Component/token reuse | TODO | pass/fail | TODO |
| Semantic accessibility | TODO | pass/fail | TODO |
| Text scaling/localization | TODO | pass/fail | TODO |
| Keyboard/insets/orientation | TODO | pass/fail | TODO |

## Differences and dispositions

| Difference ID | Screen/spec | Observation | Severity | Fix/deviation | Approver |
|---|---|---|---|---|---|
| DIFF-001 | TODO | TODO | TODO | TODO | TODO |

## Conclusion

TODO: State which flows are visually and functionally ready, which remain partial or blocked, and whether designer and QA approval is recommended.
