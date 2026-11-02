/**
 * SF Guard M4: the CI recipe for the required remote check (SPEC-PSS-v1 REQ-030), a GitHub Actions
 * workflow a person adds to the repository in a reviewed change. SF Guard prints it
 * (`singularity-flow guard remote-check --recipe`); it never writes, commits or pushes it, and never
 * changes branch protection.
 *
 * Three choices make it hard to bypass:
 * - `pull_request_target` runs the workflow file as the default branch has it, so a pull request
 *   cannot edit what checks it. The pull request's files are read as data; none of its code runs.
 * - SFlow comes from the release the person pins, checked by SHA-256, never from the repository, so a
 *   patched copy in a change is never the one that verifies it.
 * - Branch protection makes the job a required status check: deleting the workflow leaves the check
 *   pending, which holds the merge rather than passing it.
 */
import { CHECKOUT_ACTION } from '../apm-install.mjs';

export const SF_GUARD_CHECK_NAME = 'sf-guard-verify';
export const SF_GUARD_CHECK_PATH = '.github/workflows/sf-guard-verify.yml';
const PLACEHOLDER_URL = 'REPLACE-WITH-THE-SINGULARITY-FLOW-RELEASE-TARBALL-URL';
const PLACEHOLDER_SHA = 'REPLACE-WITH-ITS-SHA-256';

/**
 * The workflow's text. `checkName` is the status check's name (the job name), `branch` the default
 * branch, and `packageUrl`/`packageSha256` the SFlow release it installs; left out, they are clearly
 * marked placeholders the person fills in before committing.
 */
export function sfGuardVerifyWorkflowText({ checkName = SF_GUARD_CHECK_NAME, branch = 'main', packageUrl = null, packageSha256 = null } = {}) {
  const job = String(checkName).replace(/[^A-Za-z0-9_-]/gu, '-');
  return [
    '# SF Guard\'s required remote check (SPEC-PSS-v1 REQ-030), printed by singularity-flow guard remote-check.',
    '# An unmodified SFlow, installed from the release pinned below and checked by SHA-256, verifies every',
    '# pull request and every push to the default branch: each person record against its pinned keys, the',
    '# policy file\'s history, new key events against GitHub, and each new Story\'s creation against the opt-in.',
    `# Make "${checkName}" a required status check of ${branch} (Settings > Branches). pull_request_target runs`,
    '# this file as the default branch has it, so a pull request cannot change what checks it; it reads the',
    '# pull request\'s files as data and runs none of its code.',
    'name: SF Guard',
    'on:',
    '  pull_request_target:',
    '  push:',
    `    branches: [${JSON.stringify(branch)}]`,
    'permissions:',
    '  contents: read',
    '  pull-requests: read',
    'jobs:',
    `  ${job}:`,
    `    name: ${checkName}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    `      - uses: ${CHECKOUT_ACTION}`,
    '        with:',
    '          # The change as it would land: the pull request merged into its base.',
    "          ref: ${{ github.event_name == 'pull_request_target' && format('refs/pull/{0}/merge', github.event.pull_request.number) || github.sha }}",
    '          fetch-depth: 0',
    '          persist-credentials: false',
    '      # SFlow needs Node 22 or later. Pin this action to the full commit SHA your organisation reviews.',
    '      - uses: actions/setup-node@v4',
    '        with:',
    "          node-version: '22'",
    '      - name: Install the pinned SFlow release',
    '        env:',
    `          SFLOW_PACKAGE_URL: ${JSON.stringify(packageUrl ?? PLACEHOLDER_URL)}`,
    `          SFLOW_PACKAGE_SHA256: ${JSON.stringify(packageSha256 ?? PLACEHOLDER_SHA)}`,
    '        run: |',
    '          curl --fail --silent --show-error --location "$SFLOW_PACKAGE_URL" --output "$RUNNER_TEMP/sflow.tgz"',
    '          echo "$SFLOW_PACKAGE_SHA256  $RUNNER_TEMP/sflow.tgz" | sha256sum --check --strict -',
    '          npm install --global --ignore-scripts "$RUNNER_TEMP/sflow.tgz"',
    '      - name: Verify person records',
    '        env:',
    '          GITHUB_TOKEN: ${{ github.token }}',
    "          SF_GUARD_BASE: ${{ github.event.pull_request.base.sha || github.event.before }}",
    "          SF_GUARD_PULL_REQUEST: ${{ github.event.pull_request.number }}",
    '        run: |',
    '          set --',
    '          case "$SF_GUARD_BASE" in ""|0000000000000000000000000000000000000000) ;; *) set -- "$@" --base "$SF_GUARD_BASE" ;; esac',
    '          if [ -n "$SF_GUARD_PULL_REQUEST" ]; then set -- "$@" --pull-request "$SF_GUARD_PULL_REQUEST"; fi',
    '          singularity-flow governance verify --presence "$@"',
    ''
  ].join('\n');
}

/** Whether the recipe still carries a placeholder the person must fill in. */
export function sfGuardRecipeIncomplete(text) {
  return text.includes(PLACEHOLDER_URL) || text.includes(PLACEHOLDER_SHA);
}
