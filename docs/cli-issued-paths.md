# CLI-issued paths across skills and phases

SFlow distinguishes a command's working directory from a returned file location. In a linked Story
checkout, `.git` is a pointer file; private staging and captured output can live in the parent
repository's `.git/worktrees/<name>/singularity-flow/` directory. Joining that suffix to the Story
checkout creates a different, nonexistent path. The review packet is not missing merely because a
read of that reconstructed path fails.

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
This change does not stage, retain, approve or modify the user's actual review file.

## Qualification

Regression coverage includes all 179 skill classes, 31 bundled/template agents, Studio-created
agents, all six standard responsibilities and custom repair/intake phases; linked worktrees;
private review and clarification staging; POSIX, Windows drive and UNC path bytes; spaces, Unicode,
file URIs, native read aliases, bounded output and genuine missing-file errors. Native macOS and
Windows results are recorded after qualification.
