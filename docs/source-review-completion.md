# Resuming a source review

This is the review specialization of the shared [workflow task-completion contract](workflow-task-completion.md),
which also covers document/code authoring and custom workflow phases.

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
| `review-changed-inputs` | Use the fresh context to independently re-review; the old draft is preserved at `previousDraftPath`. |
| `read-error` | Show the original file error and preserve the existing bytes. |
| `reload-context` | A check observed changed inputs; load fresh context once, then use its current report template. |

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

## Current task and reader qualification

The generalized workflow-task and native-reader update was tested on this Mac, including the full
Story journey, real CLI publication, custom phases and dedicated/legacy hooks. Native Windows tests
were not rerun for this update; the following results describe the earlier review-only feature.

## Earlier source-review qualification

The original source-review checkpoint, stale-draft preservation and portable hook tests ran natively on macOS
and Windows with Node 22.23.4 and 26.13.0. Both macOS cells passed 85 tests without skips.
Both Windows cells passed 76 tests; nine shell-specific cases were skipped there and executed
on macOS. All four cells passed CLI building, VS Code typechecking and the 3,406 product checks.
The earlier full review matrix also exercised publication, fresh retention bindings, citations
and independent-reviewer provenance; its two Windows fixture assumptions were corrected and
rechecked in the final matrix.

Existing main debt remains separate: nine skill-wording assertions fail in the broader plugin
suite, and the gateway bundle has 824 modules against its 817 limit. This change adds no gateway
modules and raises no limits. This feature qualification does not grant release approval.
