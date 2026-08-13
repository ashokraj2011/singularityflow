# Windows Git Bash installation compatibility

Status: implemented

Release line: `0.9.0`

Implementation commits: `4498852`, `2856241`

Merged to `main`: `958f37d`, `9120245`

## Problem

Installing Singularity Flow from Git Bash on Windows produced hundreds of test failures. The first useful failures reported that governed agents such as `sflow-utility` had no description even though their Markdown files contained one.

The defect was caused by line-ending assumptions in the Markdown frontmatter parsers. Git for Windows commonly checks text files out with CRLF (`\r\n`) line endings, while the parsers required LF (`\n`) at exact delimiter positions. Some Windows editors may also add a UTF-8 byte-order mark (BOM).

When parsing failed, the agent frontmatter was treated as absent. Required fields such as `description` were therefore missing, causing agent discovery, agent mapping, hooks, direct skills, and dependent tests to fail. The npm registry and Artifactory were not the cause of these failures.

## Corrective changes

### Agent Markdown parser

`src/agents.mjs` now:

- Accepts both LF and CRLF around YAML frontmatter delimiters.
- Accepts and removes an optional UTF-8 BOM before parsing.
- Locates the closing delimiter without assuming a specific operating-system newline.
- Preserves the prompt body after the frontmatter.
- Continues to reject unclosed or non-object YAML frontmatter.

This makes agent discovery independent of the user's `core.autocrlf` setting.

### Direct skill renderer

`src/direct-skills.mjs` now:

- Reads and replaces `name:` fields ending in LF or CRLF.
- Accepts an optional UTF-8 BOM.
- Finds YAML frontmatter delimiters with either newline convention.
- Preserves the source newline convention when inserting the Singularity-managed marker.
- Continues to verify that a skill declares the same name as its directory.

### Guarded Windows installer

The new `install-windows-git-bash.sh` wrapper provides one supported source-install command for Git Bash. It:

1. Resolves the Singularity Flow checkout from the script location.
2. Checks for Git Bash and verifies `bash`, `git`, `node`, and `npm`.
3. Requires Node.js 20 or newer.
4. Requires Copilot CLI unless `--cli-only` is selected.
5. Refuses to install from a dirty checkout.
6. Updates the checkout using `git pull --ff-only`.
7. Verifies that the CRLF-safe agent parser is present before the long build and test stages.
8. Delegates installation to the canonical `install.sh`.
9. Passes through the selected npm registry, CLI-only mode, and telemetry choice.

The wrapper can be run from any directory because it resolves its own checkout path.

## Safety boundaries

The fix deliberately does not:

- Change global or repository `core.autocrlf` settings.
- Run `dos2unix` or rewrite tracked Markdown files.
- Store registry credentials in command-line URLs.
- Bypass the canonical installer validation or test suite.
- Reset, clean, force-update, or otherwise rewrite Git history.

Registry credentials remain in the user's `.npmrc` or the organization's approved npm credential mechanism.

## Public usage

From Git Bash in a clean checkout:

```bash
git switch main
git pull --ff-only
bash ./install-windows-git-bash.sh
```

With a corporate npm registry or Artifactory:

```bash
bash ./install-windows-git-bash.sh \
  --registry "https://artifactory.company.example/api/npm/npm-virtual/"
```

CLI-only installation:

```bash
bash ./install-windows-git-bash.sh --cli-only
```

The npm alias is:

```bash
npm run install:windows
```

## Failure behavior

The wrapper stops before the expensive installer stages when:

- A required executable is unavailable.
- Node.js is older than version 20.
- Copilot CLI is absent and `--cli-only` was not requested.
- The checkout contains uncommitted changes.
- The current branch cannot be updated by fast-forward.
- The checkout predates the Windows CRLF parser fix.

Each refusal identifies the corrective action. It does not attempt an automatic destructive repair.

## Regression coverage

Automated tests cover:

- Agent frontmatter using Windows CRLF.
- Agent frontmatter containing a UTF-8 BOM.
- Direct skills using CRLF and a BOM.
- Preservation of CRLF when inserting the managed direct-skill marker.
- Installer executability and Node.js version guard.
- Fast-forward-only checkout update.
- CRLF-fix detection before canonical installation.
- Corporate registry, CLI-only, and telemetry arguments.
- Rejection of global Git line-ending changes and file-rewriting utilities.

Validation at delivery completed with deterministic checks passing and 1,433 Node tests passing with zero failures.

## Acceptance criteria

The correction is accepted when:

- The same tracked agent and skill Markdown files parse on macOS, Linux, and Windows Git Bash checkouts.
- Agent descriptions and mappings remain available under CRLF.
- A Windows source installation uses the canonical validated installation path.
- Corporate registry selection reaches npm without embedding credentials in the URL.
- No Git line-ending policy or repository content is rewritten by the wrapper.
- Existing LF behavior and validation errors remain unchanged.
