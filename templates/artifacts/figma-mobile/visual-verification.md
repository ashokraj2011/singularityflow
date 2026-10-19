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
refused until every configured verification profile has a current visual-artifact record. Record
each capture, taken at that profile's exact pixel size, with:

```text
singularity-flow mcp record <SERVER> --kind visual-artifact --tool <TOOL> --phase visual-verification --profile-id <PROFILE-ID> --screen-id <SCREEN-ID> --state-id <STATE-ID> --output <PNG-PATH>
singularity-flow visual status
singularity-flow visual compare --expected <RECORD-OR-PATH> --actual <RECORD-OR-PATH> --profile <PROFILE-ID>
```

`<SERVER>` and `<TOOL>` are the pinned MCP server and tool that produced the image
(`singularity-flow mcp list` shows what this step allows); `<PNG-PATH>` is repository-relative.
`visual status` lists every profile still uncovered; resolve each one before publishing. Every
profile needs its own capture: never record one image under another profile's ID, and never name a
tool that did not produce the image. When a capture came from a tool this step does not pin, or a
configured profile does not fit this app, record it under Differences and dispositions and ask the
workflow owner to change the reviewed workflow configuration. Measure each difference with
`visual compare` and cite the comparison it writes and, when it makes one, its diff image.

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
