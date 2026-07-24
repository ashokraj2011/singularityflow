# Singularity Flow 0.9.0 — Epic-to-Stories Business Experience

## Outcome

Version 0.9.0 makes Epic planning the primary business journey while preserving
the complete configurable Story and initiative engines.

The new Business experience has three navigation destinations:

- Epics
- Reviews
- Help

The selected Epic stays on one five-stage page:

```text
Sources → Requirements → Planning → Stories → Complete
```

Planning visually combines Story decomposition and the high-level
specification. They remain separate hash-pinned governance phases underneath.

## Jira and local identity

Users can start by selecting an existing Jira Epic or by describing the work
without Jira. Local mode reserves the next Epic identity by committing and
pushing a dedicated reservation branch, preventing two planners from silently
claiming the same ID. Defaults are:

```yaml
identity:
  local:
    epicPrefix: SF-E
    storyPrefix: SF-S
    pad: 3
    scopeStoriesByEpic: true
```

`STORY-nnn` remains the immutable planning identity. Jira Stories use the key
returned by Jira. Local Stories use scoped IDs such as `SF-S-001-001`. The
authority selected at Epic creation is immutable.

Repository entries can independently route Stories to Jira projects/boards and
carry App IDs plus arbitrary scalar metadata. The entire repository registry is
snapshotted into the Epic resolution.

## Governed desktop actions

Each Epic stage displays its generated documents before any decision. Desktop
publish and approval actions call the same engine used by the CLI, bind the
decision to exact hashes, commit the result, and push it. Self-approval requires
an explicit acknowledgement and remains visibly non-independent.

The Epics home shows current stage, stage status, progress, elapsed waiting
time, identity authority, and approved-stage count from committed state. It is
not a separate database.

## Compatibility

- Existing Story workflows are unchanged.
- Existing initiative profiles remain available in Engineer mode.
- Existing Jira-backed Epics keep Jira authority.
- Existing repositories without initiative activity perform no new network
  access.
- Onboarding profiles without an experience value are migrated in memory:
  Product Owner, Business Analyst, Product Designer, and Delivery Manager use
  Business mode; other roles use Engineer mode.
- The visible repository control directory remains `singularity/`.

## Upgrade

Build and reinstall the package so the CLI, desktop, plugin, and marketplace
metadata all use 0.9.0:

```bash
git pull
npm ci
npm test
npm pack
npm install --global ./singularity-flow-0.9.0.tgz
singularity-flow plugin install
```
