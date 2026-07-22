# Migrating to Singularity Flow Lite 0.6

Version 0.6 consolidates the previous repository-state directory under the Singularity brand at `.singularity/`, moves repository definition from JSON to `.singularity/workflow.yml`, and introduces immutable work-type profiles, persona sessions, artifact templates, automatic publication, token usage, rejection cascades, and spec-to-code conformance.

## Before migrating

Commit or stash unrelated changes and ensure the normal Git remote is reachable. Upgrade the CLI, but do not delete the JSON configuration or rewrite work-item history.

```bash
npm install --global ./singularity-flow-0.8.0.tgz
singularity-flow migrate-config
```

The command:

- Atomically moves a detected pre-brand state directory to `.singularity/`.
- Creates `.singularity/workflow.yml` from the legacy phase model.
- Installs editable templates and persona prompts.
- Upgrades compatible work-item runtime state to schema v2.
- Preserves `.singularity/config.json` for audit.
- Does not commit, rebase, or rewrite existing Git history.

Review the generated YAML, especially:

- `git.remote` and `git.publish`.
- Work-type phase sequences.
- Persona `mayApprove` capabilities.
- Phase approval thresholds and rejection targets.
- Template paths and quality commands.
- Protected governance paths.

Then publish the migration normally:

```bash
git add .singularity/workflow.yml .singularity/templates .singularity/personas .singularity/work-items
git commit -m "Migrate Singularity Flow configuration"
git push
```

## Active work items

Migrated active work keeps its existing phase progression and Git history. On its next generation, submission, or decision, schema-v2 metadata is persisted through the normal atomic commit. New work receives a fully resolved immutable profile and template hash snapshot at `start`.

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
