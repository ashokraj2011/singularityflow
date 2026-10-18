# CLI-issued paths across skills and phases

SFlow distinguishes a command's working directory from a returned file location. In a linked Story
checkout, `.git` is a pointer file; private staging and captured output can live in the parent
repository's `.git/worktrees/<name>/singularity-flow/` directory. Joining that suffix to the Story
checkout creates a different, nonexistent path. The review packet is not missing merely because a
read of that reconstructed path fails.

The CLI already supplied the correct absolute staging path. Conflicting guidance existed at more
than one layer: standalone agent boundaries, the session hook's claim that output paths were
relative, and the composed phase prompt's instruction to resolve every named path under the
checkout. All of these handoffs now distinguish command cwd from exact returned file locations.

## One maintained rule

Every packaged skill and every bundled or template agent carries the shared `CLI_PATH_CONTRACT`.
Workflow Studio-created agents inherit it from the canonical agent boundary. Phase entry tool
protocols, composed phase prompts, source-review staging protocols, and the first `act` field of
bounded agent results repeat the same rule. It applies to seeded, renamed, imported and future
custom phases without inferring permissions from a phase name.

- Copy a CLI-issued absolute file path verbatim, including Git-private components, spaces and
  Unicode. Do not prepend `repositoryPath`, strip `.git/worktrees`, or replace it with a basename.
- `repositoryPath` is the command working directory. Repository-relative artifact paths retain
  their declared repository/work-item basis; they are not aliases for private staging paths.
- Exact issued private/external files are exceptions to the discovery fence, not permission to
  enumerate their parents, read unrelated files, modify Git metadata or edit another Story.
- Returned paths do not grant write authority. Existing phase, generation, lifecycle, linked-file,
  protected-path and explicit-staging checks continue to govern mutations.
- A failed exact read preserves its real error. Do not silently move, copy or recreate a review,
  discard a draft, search the disk, repeat human answers or prepare a new phase.

## Recoverable tool-target mistakes

In a live bound SFlow turn, an intercepted native file read using an issued staging suffix rebuilt
under the checkout receives `PHASE_MUTATION_STAGING_PATH_MISMATCH` and `pathCorrections`: attempted
path, exact issued path and operation. The operation is denied, not retargeted or executed. Correct
only the file-tool target in the same turn. There is no prepare/review restart route.

Generated context and output files use the same contract, not just writable staging. The bounded
JSON/text emitters register the exact complete JSON file and every externalized text file, including
phase context, reviewer guidance, source text, artifacts, catalogs, refusals and diagnostic text.
A reconstructed read receives `CLI_ISSUED_PATH_MISMATCH` with the exact issued path. It never grants
write permission or automatically opens, moves, copies, regenerates or retargets a file.

Read references are integrity-checked, per-file records scoped to a live turn and its verified
checkout. Parallel CLI results cannot overwrite each other's records. Turn replacement/end removes
the private hint cache; normal output retention still owns generated files. No directory scan or
Git subprocess is added to read interception. Setup turns without a selected Story work too.

The read correction is deliberately narrow. A same-basename document elsewhere, an unknown file,
an exact path whose file has not been written yet, and native reads after the SFlow turn ends keep
their existing behavior and errors. Ordinary file reads retain the existing no-policy-load path;
the correction adds no Git subprocess or repository discovery. Write near-miss diagnostics continue
to return the issued path without authorizing the guessed location.

## Upgrade and retained work

Update the CLI and Copilot/VS Code integration together so the skills, agents, prompt and hook agree.
Old package-managed agent digests remain registered for safe refresh; customized agents are not
overwritten or silently re-pinned. Existing Stories retain their approved inputs and authority.
Runtime prompt/tool guidance supplies the path rule without rewriting approved artifacts or reviews.
Cached prompt bytes and recorded clarification answers are not invalidated just to change path
guidance. Fresh agent bodies adapt only known legacy path-boundary sentences; complete fresh/cached
prompts end with the current runtime override without rewriting embedded source evidence. Pinned role policy, agent hashes, canonical prompt
receipts and approved documents remain intact. Review packets preserve original `instructions`
and supply `effectiveInstructions` separately, clearly identifying the delivery-only overlay.
Current CLI tool protocols provide the exact-file exception and output/staging corrections.
This change does not stage, retain, approve or modify the user's actual review file.

## Qualification

Regression coverage includes all 179 packaged skills, 31 bundled/template agents, Studio-created
agents, all six standard responsibilities and custom repair/intake phases; linked worktrees;
private review and clarification staging; POSIX, Windows drive and UNC path bytes; spaces, Unicode,
file URIs, native read aliases, bounded output and genuine missing-file errors. Native macOS and
Windows qualification used Node 22 with isolated fixtures, not a production Story or a model call.

Broad qualification `39136961250` exercised source/test revision `6a61cf8a`:

| Group | macOS passed | Windows passed | Windows skipped |
| --- | ---: | ---: | ---: |
| Skill, agent, phase, mutation and provenance contracts | 234 | 233 | 1 |
| Real CLI phase entry, captured output and custom roots | 73 | 73 | 0 |
| Independent review and native CLI lifecycle | 72 | 72 | 0 |

The one Windows skip is the existing POSIX pause-file symlink case, exercised on macOS. No new path
case was skipped. A prior qualification found a test invoking `/bin/sh` on Windows; that test now
executes its native PowerShell renderer instead of omitting argument-quoting assertions. Unrelated
full-host jobs in the broad run were superseded by focused host qualification, not counted as passes.

After removing the remaining session-hook and composer conflicts, follow-up `39138069650` exercised
runtime revision `a906fe90`: 28 hook/path checks and 13 composition/clarification replay checks passed
on each host. Its 14 built-host/parity cases all passed on macOS. Windows passed 13; the remaining
publication case completed its assertions but teardown hit an `EBUSY` fixture-directory lock.
Revision `1daa9181` deactivates that test host, disposes its subscriptions and uses the existing bounded
fixture-removal helper. Run `39139098506` then passed the unchanged publication assertions and cleanup
on both hosts, with no skips. No production permission or test assertion was weakened.

These CI revisions differ from their corresponding source/test revisions only by the temporary
qualification workflow. Both hosts also passed VS Code typechecking, build and unchanged bundle
limits. Local checks passed 2,752 install/release checks, including the generated skill catalog and
package upgrade provenance. Shared path guidance has separately accounted fixed overhead; existing
domain-specific skill caps are unchanged. The temporary workflows are never merged into production.

Latest main was refreshed before merging and integrated through `330a6bde`, preserving its Windows
maintenance-path spelling, Copilot rebind observation and test-machine isolation changes. Integration
qualification `39139519543` exercised revision `f970b165`: both hosts passed 14 path/isolation tests
and three built-host publication, Copilot rebind and maintenance-routing cases, with no failures or
skips. The incoming POSIX case-distinction assertion now resolves its expected paths using the native
host syntax, retaining both distinct keys instead of skipping the test on Windows. Both hosts also
passed typechecking, build and unchanged bundle budgets. Local install/release checking passed
2,754 checks after this integration. The CI revision `da67555f` differs only by its temporary workflow;
closing documentation does not change the qualified runtime or assertions.
