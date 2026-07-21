# Migrating to Singularity Flow Lite 0.6

Version 0.6 moves repository definition from `.sdlc/config.json` to `.sdlc/workflow.yml` and introduces immutable work-type profiles, persona sessions, artifact templates, automatic publication, token usage, rejection cascades, and spec-to-code conformance.

## Before migrating

Commit or stash unrelated changes and ensure the normal Git remote is reachable. Upgrade the CLI, but do not delete the JSON configuration or rewrite work-item history.

```bash
npm install --global ./your-company-singularity-flow-0.6.0.tgz
singularity-flow migrate-config
```

The command:

- Creates `.sdlc/workflow.yml` from the legacy phase model.
- Installs editable templates and persona prompts.
- Upgrades compatible work-item runtime state to schema v2.
- Preserves `.sdlc/config.json` for audit.
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
git add .sdlc/workflow.yml .sdlc/templates .sdlc/personas .sdlc/work-items
git commit -m "Migrate Singularity Flow configuration"
git push
```

## Active work items

Migrated active work keeps its existing phase progression and Git history. On its next generation, submission, or decision, schema-v2 metadata is persisted through the normal atomic commit. New work receives a fully resolved immutable profile and template hash snapshot at `start`.

Because v0.6 publication is required by the starter configuration, ensure every work-item branch has an upstream remote. If a lifecycle push fails, run `singularity-flow sync`; do not amend or force-push the pending commit.

## Copilot and GitHub workflows

Reinstall the bundled personal Copilot plugin and replace old approval/validation workflows with the v0.6 examples:

```bash
singularity-flow plugin install --force
cp examples/singularity-flow-approve.yml .github/workflows/singularity-flow-approve.yml
cp examples/singularity-flow-validation.yml .github/workflows/singularity-flow-validation.yml
```

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
