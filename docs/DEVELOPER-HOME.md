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

Human replies use the local Git identity's display name once as a greeting. The JSON
contract exposes this separately as `personalization.displayName` and
`personalization.replyName`. It is presentation only: authorization and signed
handles continue to bind to the stable Git email or login, and SFlow never guesses a
name from an email address, request text, or conversation memory.

Choosing **Mark as checked** stores a presentation-only acknowledgement in VS Code
global state. It does not enter the repository. On the next visit, the panel compares
the acknowledged repository revision, Story phase/status, HEAD, and worktree
condition with the current snapshot and describes the bounded change as **Since you
last checked**. With no trustworthy acknowledgement it says **Current state**.

## Returning to a Story

`sflow story return WORK-123` resolves the Story through the same gateway record
reader as Home. It reports:

- the current phase, status, and lifecycle rail;
- branch, HEAD, and bounded local changed-file names;
- an incomplete publication that requires recovery; and
- reconciliation evidence and the immediate legal next action.

An acknowledgement timestamp is not treated as a Git baseline. Unless a report was
actually computed from the acknowledged snapshot, Return labels the result **Current
state**, covers the complete governed interval, and discloses that boundary. The My
Work acknowledgement card can still show its separately bounded snapshot delta.

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

Both JSON commands return the gateway's `sflow-result` v2 envelope directly. There is
no parallel `developer-home` or `developer-return` projection. Results intentionally
omit raw absolute paths and hidden work that is not visible to the active identity.

## Copilot use

Use `/sf-home` to read the same deterministic home envelope in Copilot. The skill
shows every current choice, asks for one explicit selection, follows only the mapped
`/sf-*` guided flow, and runs home again afterward so started or switched work is
immediately visible. The initial read remains model-independent and non-mutating.

CLI, Copilot, and VS Code do not share an in-memory singleton. They read the same
durable workspace, repository, lifecycle, and Git records and apply the same home
projection. Signed action handles, conversation history, navigation history, and the
VS Code acknowledgement remain local to their host and session.
