# Epic Branch Lineage, Merge Sequence, and Story Pull Requests

This `0.9.0` delivery closes the single-repository Epic case: Story branches now
descend from the Epic branch, merge in dependency order, and land the Epic
through one final pull request.

## Shipped

- **Epic-parented Story branches.** A Story in the Epic's own repository is cut
  from `origin/<EPIC-ID>` instead of the default branch. The seed records
  `story.parentBranch` and `story.baseCommit`, and `singularity-flow start`
  follows `parentBranch` so a fresh clone forks from the same commit. Stories in
  other repositories are unchanged, and an Epic branch is never created in a
  repository that does not already have one.
- **Dependency-ordered merge sequence.** `singularity-flow epic merge-plan`
  topologically sorts the `dependsOn` graph already committed in `breakdown.yml`
  and reports each Story as `merged`, `ready`, `blocked` (naming its blockers),
  or `in-progress`, plus the next Story to merge and whether the Epic may land.
  It observes Git and mutates nothing.
- **Story pull requests.** `singularity-flow pr` builds the pull request from
  committed governed state only — identity, lineage, acceptance criteria,
  approved artifacts with approval-time hashes, required checks, and merge
  position. Preview is the default; `--create` requires typing the exact Work ID,
  refuses a Story whose dependencies have not merged, reports an existing pull
  request rather than opening a duplicate, honours `branchCompletionPolicy`, and
  prints the body when the GitHub CLI is unavailable.
- **Grounded impact map.** Publishing the planning phase validates the repository
  map against committed state: every named repository must exist in
  `portfolio.repositories` and every referenced world-model view must exist in the
  committed manifest. Carried by the `impact-grounded` checklist item; blocking
  under `grounding: enforce`, warning otherwise.
- **World model at Epic start.** Starting an Epic reports a missing, uncommitted,
  or stale world model instead of failing, and Flow Studio offers to build it on
  the Epic branch. `singularity-flow wm build --local` commits without pushing.
- **Initiative template self-healing.** Starting an initiative and preparing a
  phase install any packaged template the repository lacks — into the templates
  root the portfolio declares — and commit what they installed. A profile that
  references templates which are neither present nor packaged now reports every
  one of them in a single error instead of failing on the first.

## Fixed

- Story seeds in a single-repository Epic cited approved artifacts by path and
  hash that did not exist on the Story branch, because the branch was cut from
  the default branch. The approved specification was neither readable nor
  verifiable from the Story.
- Repositories initialized before the `initiatives/` template subtree shipped
  could not start an initiative: directory-level template installation skips a
  templates directory that already exists, so later package additions never
  reached them, and the self-heal ran only during desktop portfolio bootstrap.
- Self-healed templates were left unstaged, so the next command failed on an
  unclean working tree.
- `git commit` and `git push` progress was written to standard output ahead of
  CLI JSON, so the desktop reported invalid data.

## Compatibility

- Multi-repository initiatives are unchanged: Story branches outside the Epic's
  own repository still base on that repository's `defaultBranch`.
- Existing seeds without `parentBranch` fall back to the configured default base
  branch; an explicit `--base` still wins.
- The immutable resolution is preserved. A restored template is compared against
  the hash recorded at creation, so an altered template still fails.
- Package, plugin, marketplace, and desktop versions remain `0.9.0`.

## Security and trust

- Opening a pull request is an outward action: preview is the default and
  creation requires explicit confirmation of the exact Work ID.
- Pull-request bodies are assembled only from committed state; no content is
  generated or inferred.
- Self-healing installs only templates packaged with Singularity Flow, never
  overwrites an existing file, and commits what it installs.
