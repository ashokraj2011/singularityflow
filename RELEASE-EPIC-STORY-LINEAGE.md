# Epic-to-Story Planning and Lifecycle Lineage

This 0.8.0 delivery adds an opt-in Epic experience above the existing Story and
initiative engines without changing existing work items.

## Shipped

- Default four-phase `epic-planning` profile with editable intake,
  requirements, Story-plan, Jira-plan, and materialization templates.
- Secure source adapter contract for Jira attachments, Artifactory,
  SharePoint, S3/AWS SSO, and public HTTPS references.
- Hash-pinned local source cache and source-aware governed Copilot prompts.
- `REQ-nnn`/`AC-nnn` source traceability and Story allocation validation.
- Story plan schema version 2 with immutable temporary plan IDs, Jira numeric
  issue IDs, returned Jira keys, aliases, canonical Work IDs, and repository
  policies.
- Explicit canonical/child branch registration, fast-forward-only direct
  promotion, and PR/either completion policies.
- Hash-bound review packets and isolated cross-repository Product Owner review.
- Exact-SHA GitHub Actions and PR evidence through the authenticated `gh` CLI.
- Timestamped Jira drift observations with explicit adopt or restore-plan
  choices.
- Focused CLI commands, seven Copilot skills, and an Epic desktop workspace for
  Sources, Requirements, Planning, Stories, Review, and Configuration.

## Compatibility

- Existing Story workflows and schema-v1 initiative breakdowns are unchanged.
- Repositories without an active Epic profile do not use source adapters or
  perform new Epic network access.
- Existing canonical Work-ID branches remain valid.
- Package, plugin, marketplace, and desktop versions remain `0.8.0`.

## Security and trust

- Source and Jira credentials never enter Git or Copilot prompt records.
- Electron stores Artifactory/SharePoint tokens through OS-backed
  `safeStorage`; S3 uses the AWS default credential chain.
- Git identity remains `configured-local`; Jira and GitHub identities are
  displayed independently.
- No lifecycle operation force-pushes or automatically overwrites Jira from Git
  (or Git from Jira).
