# Ad hoc work and governed landing

Singularity Flow ad hoc mode lets a developer begin a small change without first
creating a Story, then apply an exact safety check before committing and pushing
the result. It records the intent as **discovered at landing**; it does not claim
that a specification existed before the work began.

Use this path for bounded, low-risk work in one initialized Git repository. Use a
normal governed Story when the work touches protected process files, spans
repositories, needs several verification strategies, has external side effects,
or needs independent approval.

## Quick start

### Start before editing

```bash
cd /path/to/repository
singularity-flow adhoc start "Correct the tax rounding edge case"

# Edit and test normally, then inspect the exact observed change.
singularity-flow land
```

### Adopt work that already exists

```bash
cd /path/to/repository
singularity-flow land
```

If existing changes are present, SFlow reports them and requires an explicit
choice. It never silently adopts a dirty working tree. Start a session that
deliberately includes the reviewed changes with:

```bash
singularity-flow adhoc start "Correct the tax rounding edge case" --include-existing
```

The initial note is only a human orientation aid. It is not the confirmed intent
used to authorize landing.

## Complete landing sequence

Every mutating boundary uses the identifiers and SHA-256 values returned by the
previous command. Do not reuse example values from this guide.

1. Review the session and current effects:

   ```bash
   singularity-flow adhoc status --json
   singularity-flow adhoc diff --json
   singularity-flow adhoc effects --json
   ```

2. Confirm the objective and at least one observable success criterion. Replace
   `<SESSION-ID>` and `<CHANGE-SET-SHA256>` with the current values:

   ```bash
   singularity-flow adhoc intent confirm <SESSION-ID> \
     --objective "Correct tax rounding for half-cent inputs" \
     --success "The configured test proves half-cent values round correctly" \
     --confirm <CHANGE-SET-SHA256> \
     --json
   ```

3. Bind every changed resource to the confirmed success criterion:

   ```bash
   singularity-flow adhoc claim --all \
     --clause ADH-INTENT:SC-001 \
     --session <SESSION-ID> \
     --json
   ```

4. Preview the exact landing packet. SFlow runs one configured, allowlisted,
   deterministic test command and reports either an eligible packet or explicit
   reasons to promote the work to a Story:

   ```bash
   singularity-flow adhoc landing preview <SESSION-ID> --json
   ```

5. Review the packet, then publish using its exact digest:

   ```bash
   singularity-flow adhoc publish <SESSION-ID> \
     --confirm <PACKET-SHA256> \
     --json
   ```

Before publication SFlow rechecks HEAD, every changed byte, Git identity, branch
policy, protected paths, dispositions, and the required test. If anything changed
after preview, the packet becomes stale and must be regenerated and reviewed.

## Copilot

Use:

```text
/sf-adhoc
```

The skill resolves the current repository through the registered workspace,
shows deterministic CLI records, and asks for missing human decisions. It does
not invent intent, claims, test selection, or confirmation hashes. It does not
auto-submit a proposed mutation: the user must select and authorize it.

Example requests include:

- `/sf-adhoc start a small local fix`
- `/sf-adhoc show what changed`
- `/sf-adhoc prepare this existing work for landing`
- `/sf-adhoc explain why this work requires promotion`

An active Story is not required. If a Story is active, use the Story workflow for
Story-owned changes instead of using ad hoc mode to bypass its phase boundaries.

## VS Code

Open the Singularity Flow view and use **Favorites → Ad hoc work**. The view
provides the same observe, start, status, and guide paths backed by the CLI. Exact
intent and packet confirmations remain guarded operations; opening a card or
guide never publishes work.

The Help Center also answers natural-language questions such as:

- “How do I work without creating a Story?”
- “How do I safely land code I already changed?”
- “Why does this ad hoc change require promotion?”

## Pause, resume, promote, or close

```bash
singularity-flow adhoc pause <SESSION-ID> --json
singularity-flow adhoc resume <SESSION-ID> --json
singularity-flow adhoc promote <SESSION-ID> --json
singularity-flow adhoc close <SESSION-ID> --local-only --json
```

- **Pause** preserves the session and source bytes but stops progression.
- **Resume** refreshes observation against the current repository state.
- **Promote** creates a deterministic handoff checkpoint for a normal governed
  Story; it does not discard or rewrite application changes.
- **Close `--local-only`** closes the local operational session without claiming
  that the work was governed or published.

If a push fails after the governed commit exists, use the ordinary exact-commit
publication recovery reported by SFlow. Do not create a replacement commit or
push an arbitrary newer HEAD.

## What is allowed in the thin pilot

The current pilot supports:

- one initialized Git repository;
- a local human or Copilot-assisted edit;
- an unprotected work branch;
- at most 20 changed resources by default;
- no protected governance paths;
- one configured `spec.testCommands` entry;
- complete resource-to-criterion claims;
- exact human confirmation of the landing packet; and
- direct landing through the ordinary governed commit and push transaction.

The pilot deliberately refuses agent-run execution, partial split landing,
automatic discard/revert, protected-path landing, and multi-repository landing.
Those cases preserve the current bytes and require promotion to a Story. A refusal
is a safety outcome, not permission to bypass the guard with a manual SFlow
authority record.

## Records and privacy

Operational session records are machine-local under:

```text
$GIT_COMMON_DIR/singularity-flow/adhoc/AHS-*
```

Linked worktrees therefore see the same session. Successful publication writes
authority records under:

```text
singularity/adhoc-work/<WORK-ID>/
```

Publication uses an isolated temporary Git index, so unrelated staged work is not
borrowed. Verification records retain bounded hashes, exit status, and byte
counts; raw test output is not turned into durable governance evidence.

## Common refusals

| Code or condition | Meaning | Safe response |
|---|---|---|
| `ADH_DIRTY_START_CHOICE_REQUIRED` | Existing changes were found. | Review them, then explicitly use `--include-existing` or start after cleaning the tree. |
| `ADH_CHANGE_UNCLAIMED` | One or more resources have no success-criterion disposition. | Claim each resource or promote the work. |
| `ADH_PACKET_STALE` | HEAD or source bytes changed after preview. | Generate and review a new landing packet. |
| `ADH_PROMOTION_REQUIRED` | The work exceeds the direct-landing safety envelope. | Run `adhoc promote`; continue through a governed Story. |
| Protected path or branch | Direct landing would alter governance authority. | Promote; do not force the ad hoc publication. |
| Test unavailable or failing | The configured proof cannot be produced. | Correct the test/configuration or promote for broader verification. |

## Does this bypass governance?

No. Ad hoc mode moves the governance boundary to landing for a deliberately small
class of work. The receipt records `workflowExecuted: false`, the confirmed intent
is labeled `discovered-at-landing`, and the exact change, test, identity, decision,
commit, and push remain bound together. Work outside that envelope must enter the
normal Story lifecycle.

## Related documentation

- [Main README](./README.md)
- [Documentation map](./docs/README.md)
- [Help reference](./HELP.md)
- [Help Center topic](./docs/topics/ad-hoc-work.md)
- [Governed work intervals](./docs/GOVERNED-WORK-INTERVALS.md)
