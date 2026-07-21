# Verification record

## Scope

The implementation was verified as a standalone npm package and skills-only Copilot plugin. No real Jira tenant or authenticated Copilot installation was available in the execution environment, so external authentication and client rendering remain local acceptance tests for the installing organization.

## Automated checks

Run from the package root:

```bash
npm test
npm run check
npm pack --dry-run
```

The automated suite verifies:

- CLI argument parsing.
- Repeated option handling.
- Jira Atlassian Document Format conversion.
- Jira issue normalization.
- Full user-story formatting, including acceptance criteria, story points, sprint, subtasks, links, and attachment metadata.
- Direct Jira issue and JQL endpoint request construction using mocked `fetch`.
- Jira custom-field discovery.
- Creation of a human-readable `USER-STORY.md` snapshot for Jira-backed workflows.
- Skills-only plugin manifest.
- Every skill directory and frontmatter name.
- Manual-only approval skill configuration.
- Exact branch creation from a work ID.
- Workflow initialization.
- Placeholder blocking.
- Artifact registration and hashing.
- Submission state.
- Approval snapshot creation.
- Approval commit message.
- Phase advancement.
- Clean working tree after an approval commit.
- JavaScript syntax for every `.mjs` file.
- JSON parsing for package, plugin, schemas, and examples.
- Absence of Python, MCP configuration, hooks, and Copilot JavaScript extensions.

The final local run completed **16 Node.js tests with 16 passes and 0 failures**. The package checker completed **36 structural and syntax checks across 15 skills**.

## Direct Jira pull smoke test

A local HTTP server emulated the Jira Cloud endpoints used by Singularity Flow. The packaged source command was exercised end to end with Basic-auth headers and configured custom fields:

```text
singularity-flow jira pull PAY-142
singularity-flow jira fields --query acceptance
singularity-flow start PAY-142 --jira
```

The test verified:

- `GET /rest/api/3/issue/PAY-142` was called.
- `GET /rest/api/3/field` returned the acceptance-criteria field ID.
- The rendered story contained description, acceptance criteria, story points, sprint, subtask, linked issue, and attachment metadata.
- The exact Git branch `PAY-142` was created.
- `source.json` and `USER-STORY.md` were written under `.sdlc/work-items/PAY-142/`.

## Full lifecycle smoke test

A temporary Git repository was initialized with a `main` branch and configured test identity. The workflow was then exercised through:

```text
requirements → design → implementation → verification → review → release → complete
```

For each phase, the required artifact was created, scanned, submitted, approved, and committed. The resulting commit subjects were:

```text
DEMO-101 approve requirements
DEMO-101 approve design
DEMO-101 approve implementation
DEMO-101 approve verification
DEMO-101 approve review
DEMO-101 approve release
```

Final validation returned:

```text
Singularity Flow workflow is valid.
```

The final repository had no uncommitted changes.

## Packaged-install smoke test

The generated npm tarball was installed into an isolated temporary global npm prefix. The installed executable was then used—not the source-tree entry point—to verify:

```text
singularity-flow --version                    → 0.4.0
sflow --version                               → 0.4.0
singularity-flow plugin path                  → packaged plugin/plugin.json found
singularity-flow start DEMO-900               → exact branch DEMO-900 created
singularity-flow status DEMO-900 --json       → requirements / in_progress
.sdlc/work-items/DEMO-900/workflow.json → created
```

This smoke test made no changes to the machine's real global npm installation or Copilot profile.

## External acceptance tests to run locally

### Copilot CLI

```bash
npm install --global ./your-company-singularity-flow-0.4.0.tgz
singularity-flow plugin install
copilot plugin list
copilot
```

Inside the session:

```text
/skills list
/singularity-flow:start DEMO-201 --title "Plugin acceptance test"
/singularity-flow:status
```

### VS Code

1. Use the same npm and plugin installation commands.
2. Reload VS Code.
3. Confirm `singularity-flow` in **Agent Plugins - Installed**.
4. Confirm `/singularity-flow:start` appears in Copilot Chat.
5. Run it in a disposable Git repository.

### Jira

With a dedicated test user and issue:

```bash
export JIRA_BASE_URL="https://tenant.atlassian.net"
export JIRA_EMAIL="test-user@example.com"
export JIRA_API_TOKEN="..."
singularity-flow jira pull TEST-123
singularity-flow jira list --project TEST
singularity-flow jira fields --query acceptance
```

Then run `singularity-flow start TEST-123 --jira` in a disposable repository and review `source.json` plus `USER-STORY.md`. Remove the test token from the environment after testing.

## Known boundaries

- The package does not install Git hooks.
- It does not push or merge.
- It does not create pull requests.
- It does not write to Jira.
- It does not secure environment variables; credential handling is delegated to the organization's approved local-secret practice.
- It does not implement backward migrations for future workflow schema versions yet.
