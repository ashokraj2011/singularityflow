# Registered upstream issues and forward amendments

The Phase 5 extension puts upstream coordination behind `engine.run(operation, inputs)`. The CLI
retains its existing flags, text, JSON envelopes and recovery guidance. It no longer loads an
accepted Story, resolves identity, reads author documents or starts a transaction itself.

## Vocabulary

Every input can include `workId`. It cannot supply a checkout, workflow, configuration, actor,
authority group, callback, approval record or publication token.

| Operation | Additional inputs | Permission |
|---|---|---|
| `upstream.list` | `open` | Read the accepted Story, including a closed Story |
| `upstream.raise` | `phaseId`, `about`, `problem`, `assumption`, `impact`, `proposed`, `authored`, `supersedes`; or `fromArtifact` | An author can raise an issue; this is not approval |
| `upstream.decide` | `issueId`, `outcome`, `reason`, `link`, `expires` | Existing approvers of the issue's owning phase |
| `forward-amendment.propose` | `phaseId`, `reason`, `file`, `upstreamIssue` | An author can propose corrected bytes |
| `forward-amendment.decide` | `amendmentId`, `decision`, `reason`, `confirmation` | Existing approvers of the amended phase; confirmation must name the exact amendment |
| `forward-amendment.revalidate` | `phaseId`, `amendmentId`, `outcome`, `reason` | Existing approvers of the phase being revalidated |

```js
const proposed = await sflow.run('forward-amendment.propose', {
  workId: 'STORY-1', phaseId: 'team-plan', file: 'drafts/corrected-plan.md',
  reason: 'The plan needs the cache duration already required by the approved specification.'
});
// An authorized human separately reviews the retained proposal and confirms its exact identifier.
```

Proposal filenames remain local repository inputs to the Git compatibility port. They are not
portable backend addresses. `fromArtifact` reads the current phase's documents and resolves only
explicit earlier owners; no owning phase is guessed. Unowned items are semantic data in the SDK;
the CLI adds the existing explanation and command guidance.

## Coordination and results

The pure registry coordinator uses a trusted `upstream` port with `load`, `resolve`, `commit` and
`finish`. It captures Story, current phase, upstream owner, generation and approval-group bindings
before awaiting resolution. The resolver cannot substitute a manual request or redirect a
decision by mutating its native context. The port performs existing record validation, identity
resolution, presence checks, conditional publication and retained recovery.

`upstream.list` returns `status: observed`, `issues`, and no committed effect. Mutations return
their native `records`, `publications` containing opaque revisions and push acknowledgements,
the resulting `currentPhase`, and the pending amendment `revalidate` phases and `refreshed` phase.
The original records are detached, bounded JSON. Filing no new artifact items returns
`status: unchanged`, no revision and no publication. The SDK never claims that an issue or
proposal is a phase approval.

Each issue still has its own native transaction. Artifact filing validates the entire candidate
batch before its first write, but does not claim cross-issue atomicity. If a later write fails or
is cancelled, the original error object, code, cause and recovery details are preserved. Its
`engineUpstreamEffects` identifies the accepted prefix, any returned write awaiting result
validation, and the remaining requests. An unknown native publication is not retried. Cancellation
after a final accepted write does not report that write as undone; cancellation before the next
write stops the remaining batch. A failed after-state read retains the accepted publication facts.

## Preserved native behavior and remaining work

`native-upstream-decisions.mjs` remains the shared writer used by standalone and combined decision
operations. Its old helper exports keep their original return shapes; additional transaction
helpers expose the actual native publication token to the registry. `native-forward-amendments.mjs`
owns the extracted CLI transaction descriptions, including proposal rollback paths, return change
requests and generation publication finalization. Their underlying transitions remain in the
installed aggregate until the remaining kernel extraction.

The Git port preserves accepted execution lookup without switching checkout, generation and input
hash formats, one-issue append behavior, signed human decisions, self-approval restrictions,
multi-approver refusal, exact proposal bytes and all pending-publication checks. Approval of an
amendment installs only the amended phase's next generation; later approved phases retain their
approvals and owe the same revalidation. A return uses the existing change-request transaction.
None of these operations migrate authority or create a generic storage transaction.

The artifact reader retains the installed discovery bounds and file-read behavior. Replacing its
legacy missing/unreadable-file handling is separate from this compatibility extraction; existing
native errors that are raised pass through unchanged.

Architecture guards reserve concrete port composition to `git-publication.mjs`, keep the new
native owners independent of command handlers, and keep all kernel/SDK imports free of host I/O.
The new owners participate in development build identity and cold bundle ownership. Mac tests use
temporary repositories and local bare remotes; no real Story, installation or remote service is
changed.
