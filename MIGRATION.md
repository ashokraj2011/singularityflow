# Migrating Singularity Flow configuration

The canonical repository-owned control folder is now the visible `singularity/` directory. New repositories use it automatically. `singularity-flow migrate-config` moves either the former hidden `.singularity/` directory or the older `.sdlc/` directory without rewriting Git history.

## Before migrating

Commit or stash unrelated changes and ensure the normal Git remote is reachable. Upgrade the CLI, but do not delete the JSON configuration or rewrite work-item history.

```bash
npm install --global ./singularity-flow-0.8.0.tgz
singularity-flow migrate-config
```

The command:

- Atomically renames a detected `.singularity/` or `.sdlc/` control directory to `singularity/`.
- Rewrites repository-relative control paths inside YAML, JSON, and Markdown state.
- Refreshes immutable configuration hashes for work items and initiatives on the branch and records a migration entry in their runtime state.
- Creates `singularity/workflow.yml` from the legacy phase model.
- Installs editable templates and persona prompts.
- Upgrades compatible work-item runtime state to schema v2.
- Preserves `singularity/config.json` for audit.
- Does not commit, merge, rebase, or rewrite existing Git history.

Review the generated YAML, especially:

- `git.remote` and `git.publish`.
- Work-type phase sequences.
- Persona `mayApprove` capabilities.
- Phase approval thresholds and rejection targets.
- Template paths and quality commands.
- Protected governance paths.

Review and publish the rename on each active lifecycle branch that contains its own state:

```bash
git add -A
git commit -m "Move Singularity Flow files to visible folder"
git push
```

Git normally records this as a rename. If both `.singularity/` and `singularity/` already exist, migration stops rather than guessing how to combine them.

### Migrating from Flow Studio

Open the repository in Singularity Flow Desktop. When the app detects `.singularity/` or `.sdlc/`, it shows the source and destination and asks for confirmation. Choose **Migrate folder**, inspect the reopened repository and its working-tree changes, then select **Commit & push**. The desktop operation invokes the same CLI migration and never merges into the default branch.

## Active work items

Migrated active work keeps its existing phase progression and Git history. The explicit migration refreshes only repository-root path references and their pinned configuration hashes; phase content, generations, evidence, and approvals are not recreated. On its next generation, submission, or decision, metadata uses the visible path. New work receives a fully resolved immutable profile and template hash snapshot at `start`.

Because v0.6 publication is required by the starter configuration, ensure every work-item branch has an upstream remote. If a lifecycle push fails, run `singularity-flow sync`; do not amend or force-push the pending commit.

## Copilot and GitHub workflows

Reinstall the bundled personal Copilot plugin and replace old approval/validation workflows with the v0.6 examples:

```bash
singularity-flow plugin install
copilot skill list
cp examples/singularity-flow-approve.yml .github/workflows/singularity-flow-approve.yml
cp examples/singularity-flow-validation.yml .github/workflows/singularity-flow-validation.yml
```

Version 0.6.1 replaces generic Copilot skill names with collision-safe commands such as `/sflow-start`, `/sflow-phase`, and `/sflow-progress`. Version 0.6.2 also removes both the legacy direct plugin identity and any previous marketplace identity on every installation, leaving exactly one current `singularity-flow@singularity-flow` entry. Close existing Copilot sessions after reinstalling so the new skill registry is loaded.

Version 0.7 adds a Jira-or-manual intake picker before workflow-template selection, structured manual stories through `--story-file`, repeatable document and URL imports, a committed `USER-STORY.md` for both sources, and the read-only `/sflow-help` template guide.

Version 0.8.0 keeps existing repositories and in-flight work items compatible:

- Missing `inputsMode` resolves to `off`, so phase-input declarations have no runtime effect until enabled. New `singularity-flow init` repositories start in `record` mode.
- Existing schema-v2 work items without input fields resolve to `off`; their immutable configuration snapshot is not rewritten.
- Agents without the three dependency headings remain local-only and perform no network access.
- No live remote URLs ship with the bundled agent. Remote Markdown is used only after teams add table entries and make an interactive lock decision.
- Local templates continue to resolve normally. A remote template is selected only through an explicit `agent:<agent>/<resource>` reference in workflow YAML.

After upgrading an existing clone at the same package version, use the forced reinstall path so both the global CLI and Copilot plugin cache are replaced:

```bash
./install.sh
```

To adopt input recording deliberately, add `inputsMode: record`, declare profile-valid upstream inputs, validate, and commit the configuration on the base branch. Existing work items retain their previously pinned `off` mode; new work items receive the new snapshot.

GitHub decisions now require an explicit persona:

```text
/approve design as architect
/reject design as architect --to requirements --reason "Missing failure behavior"
```

Username role allowlists and local `--by` flags are obsolete. Persona capability supplies authority; authenticated identity supplies attribution and distinct-review counting.

## Verification

After migration:

```bash
singularity-flow validate --strict
npm test
npm run check
```

Start a disposable feature and bugfix on a test remote to verify interactive selection, publication, remote resume, rejection, and conformance before enabling the validation workflow as a required branch-protection check.
