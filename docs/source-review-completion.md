# Resuming a source review

`/sf-review-source <phase>` owns reading the pinned inputs, writing the independent report,
checking it and retaining it. Reading the inputs alone leaves the review unfinished.
This applies to steps with specification or planning responsibilities, including copied and
custom-named steps.

The context reports the next step from the actual files and retained evidence:

| Progress | Action |
| --- | --- |
| `author-report` | Author the report at the exact issued staging path. |
| `repair-report` | Preserve the existing draft, correct its JSON/citations/mappings and check the changed packet. |
| `retain-report` | Retain the validated report using the returned command. |
| `retained` | Show the existing review and its next action; do not retain a duplicate. |
| `read-error` | Show the original file error and preserve the existing bytes. |
| `reload-context` | Resolve the changed input binding before reviewing again. |

A new invocation uses a fresh binding and resumes the existing generation's private draft.
It does not recreate the Story or copy judgments into changed inputs. An admitted context
returns its current authoring/repair/retention step. `afterRetention` is future guidance until
retention completes.

In hosts supporting `agentStop`, SFlow requests one continuation when an admitted full review
ends without a retained report. The continuation reuses the current entry and reads. It does
not start another model, change the author, make a human decision, approve, publish an artifact
or advance the Story. The existing final fresh-binding and independent-reviewer checks remain.

The hook uses the current turn's private checkpoint and native file stamps; it does not scan
branches, traverse Git history or spawn Git. Paused/native turns, cancellation, expired or
changed bindings, real tool/permission failures and an already continued stop are left alone.
Explicit `stage`, `check`, `submit`, `status` and decision requests remain single operations.
An honest retained review with correction-required findings is a completed review, not approval.

The checkpoint is local to the chat's existing private boundary record. The staged report and
retained evidence remain the sources for resume; a missing or corrupt advisory checkpoint grants
no permissions. A host without this stop hook still receives the same resumable context.

Omitted output fields report their formatted-file byte size and safe inclusive `read` ranges.
Use those ranges exactly. `agentOutput.complete: false` means the display is bounded; it does
not declare whether the review is complete.
