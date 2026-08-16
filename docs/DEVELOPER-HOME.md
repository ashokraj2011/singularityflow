# Developer Home and Story Return

Developer Home is the read-only front door for returning to governed work. It is
available in VS Code as **My Work** and from a terminal as:

```bash
sflow home
sflow home --json
sflow story return WORK-123
sflow story return WORK-123 --json
```

The old **Talk to SFlow** command ID remains hidden for compatibility with saved
links and keybindings. It opens My Work and never creates a second home surface.

## What Developer Home shows

The context banner identifies the active workspace, selected repository, current
branch and HEAD, local Git actor, active Story, and the time the local snapshot was
captured. The briefing then offers at most six currently reachable choices, ordered
with recovery and active work before less urgent actions. Every choice includes a
plain CLI fallback.

Choosing **Mark as checked** stores a presentation-only acknowledgement in VS Code
global state. It does not enter the repository. On the next visit, the panel compares
the acknowledged repository revision, Story phase/status, HEAD, and worktree
condition with the current snapshot and describes the bounded change as **Since you
last checked**. With no trustworthy acknowledgement it says **Current state**.

## Returning to a Story

`sflow story return WORK-123` resolves the Story through the repository subject
index. It reports:

- the current phase and generation;
- phase status, registered artifacts, and approval decisions;
- pinned configuration, specification, and plan revisions when present;
- branch, HEAD, and bounded local changed-file names;
- an incomplete publication that requires recovery; and
- the immediate legal next action.

The VS Code return view groups generated artifacts by phase. Selecting an artifact
opens the existing governed artifact viewer.

## Safety and freshness

Opening either view is local and read-only. It does not fetch, switch branches,
edit files, reconcile state, invoke a model, contact Jira, commit, or push. Only the
repositories declared by the active workspace are inspected.

Choices use opaque 15-minute handles bound to the current subject revision, target,
goal, Git actor, and VS Code panel session. Before navigation or an effect, the panel
re-reads the home result. A changed revision, actor, target, expired handle, or
different host session rejects the choice and asks the developer to refresh.

The JSON contracts are versioned with `schemaVersion: 1` and use result types
`developer-home` and `developer-return`. They intentionally omit raw absolute paths
and hidden work that is not visible to the active identity.

## Copilot use

Use `/sf-home` to read the same deterministic home envelope in Copilot. The skill
shows every current choice, asks for one explicit selection, follows only the mapped
`/sf-*` guided flow, and runs home again afterward so started or switched work is
immediately visible. The initial read remains model-independent and non-mutating.

CLI, Copilot, and VS Code do not share an in-memory singleton. They read the same
durable workspace, repository, lifecycle, and Git records and apply the same home
projection. Signed action handles, conversation history, navigation history, and the
VS Code acknowledgement remain local to their host and session.
