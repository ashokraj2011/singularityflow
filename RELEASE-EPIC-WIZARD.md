# Epic Lifecycle Wizard

This `0.8.0` delivery turns the existing Git-native Epic capabilities into one
guided desktop journey without introducing a second workflow state model.

## General flow

```text
Jira Epic
→ pinned source intake
→ approved REQ/AC requirements
→ reviewed generated User Stories
→ approved high-level solution specification
→ selected artifacts + Stories published to Jira
→ canonical repository Story delivery
→ exact-SHA Product Owner review
→ committed Epic completion
```

## Shipped

- A seven-step Electron Epic wizard with direct Jira Epic selection.
- A generated-Story review board showing repository ownership, requirements,
  acceptance criteria, dependencies, and blocking status before publication.
- A distinct, configurable `epic-spec` phase and high-level specification
  template for repository boundaries, interfaces, security, observability,
  test expectations, and final comparison instructions.
- Explicit Jira artifact selection. The reviewed write plan pins each file,
  target, byte count, MIME type, and SHA-256 before upload.
- Retry-safe Jira attachments with hash-stamped filenames and append-only
  receipts.
- A final Product Owner gate that requires complete canonical blocking Stories,
  approved conformance, a submitted review packet, and passing exact-SHA
  evidence.
- A content-addressed completion record and
  `artifacts/delivery/spec-to-code-completion.md`, committed and pushed.

## Compatibility

- Existing active Epics keep their immutable four-phase resolution and remain
  usable; the wizard hides the new phase when it is absent.
- New `epic-planning` Epics use the five-phase profile.
- Existing Story workflows and version-1 breakdowns are unchanged.
- Jira attachments are opt-in per reviewed write plan and require
  `attach-artifact` in the pinned Jira write policy.
- Package, plugin, marketplace, and desktop versions remain `0.8.0`.
