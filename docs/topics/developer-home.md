---
id: developer-home
title: Developer Home and returning to work
aliases: [home, return-to-work, talk-to-sflow]
commands: [home]
related: [starting-work, story-lifecycle, nextsteps]
---
`sflow home` is the read-only front door for a developer. It resolves the active workspace and repository, reports the current Story and repository freshness, and offers no more than six deterministic next choices. It never fetches, checks out a branch, mutates lifecycle state, or invokes a model. In VS Code, **Talk to SFlow** opens the same briefing with local acknowledgement history and safe navigation.

Use `sflow story return <WORK-ID>` when resuming a known Story. The return briefing shows its current phase, pinned configuration and specification revisions, approvals, checks, evidence gaps, recovery state, and local worktree changes before you choose an action. Choice handles are short-lived and bound to the exact repository revision, actor, goal, and host session; if state changes, refresh the briefing rather than reusing an old choice.
