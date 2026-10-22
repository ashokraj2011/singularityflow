# {{work.id}} — Design Package Intake

## Export package

| Field | Value |
|---|---|
| Export label/version | TODO |
| Imported document IDs | TODO: list every DOC-nnn or a documented package range |
| Original design reference | TODO: file, project, or supplied URL |
| Exported at | TODO |
| Imported commit | TODO |

Confirm that the complete exported directory was imported with `singularity-flow documents upload <DIRECTORY> --kind figma-export --name "<NAME>"`. Record missing or intentionally excluded content.

The upload is the package reviewers read; it pins no Figma file version, so it is not a design
source. Publishing this step also needs one: save the Figma MCP `get_metadata` result for the
approved frames to a repository file, then record it with its file key and version before publishing:

```text
singularity-flow mcp record figma --kind design-source --tool get_metadata --phase design-intake --output <METADATA-XML-PATH> --file-key <FIGMA-FILE-KEY> --file-version <FIGMA-FILE-VERSION> --node <NODE-ID>
```

`singularity-flow phase prepublish design-intake` reports a missing design source. Without a Figma
MCP connection there is no design-source record to make; never name a tool that did not produce the file.

The committed, SHA-recorded PNG exports are the canonical design baseline for later visual-verification approval. A Figma URL may be recorded as convenient live context, but it can change after intake and never replaces the pinned exports.

## Mobile target

| Decision | Selection |
|---|---|
| Platform and framework | TODO: SwiftUI / Jetpack Compose / Flutter / React Native |
| Minimum OS/runtime | TODO |
| Phone/tablet support | TODO |
| Orientation | TODO |
| Reference device sizes | TODO |

The platform selection is immutable after this artifact is approved unless the workflow is rejected to design intake.

## User flows and delivery slices

| Flow ID | User outcome | Entry and exit screens | Priority | Included |
|---|---|---|---|---|
| FLOW-001 | TODO | TODO | TODO | yes/no |

## Package completeness

- Screens and state variants: TODO
- Assets and icons: TODO
- Colors, typography, spacing, and other tokens: TODO
- Components and variants: TODO
- Navigation or prototype behavior: TODO
- Fonts and licensing information: TODO
- Known gaps and questions: TODO

## Intake approval

TODO: State whether this package is sufficient for inventory, identify every assumption that still requires design confirmation, and confirm which DOC-nnn image hashes form the approval baseline.
