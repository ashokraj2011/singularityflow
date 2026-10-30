/**
 * Every clone in src/ is listed with its reason (SDA-AC-013, §10, §17; decision D3).
 *
 * Ordinary configuration editing, and listing or inspecting workflow proposals, read exact objects
 * and create no clone or checkout. What still clones is listed below. Two shapes are read from src/
 * as syntax trees, as in test/governed-push-lease.test.mjs:
 *
 * - a Git argument list (an array whose verb is `clone`, after any `-c key=value` pairs), keyed
 *   `file#function`;
 * - a call of a helper that borrows a configuration checkout, keyed `file#function>helper`:
 *   `withLeadCheckout` without `objectProjection: true`, `withCapabilityProposalCheckout`,
 *   `cloneCapabilityConfiguration`, and `withWorkflowProposalCheckout` or
 *   `prepareConfigurationObjectCheckout` without `checkout: false`. A projected edit that still
 *   passes `fullHistory` clones when it needs history, and is keyed `...>withLeadCheckout(history)`.
 *
 * The test fails when a site appears that is not listed, and when a listed site disappears. Add a
 * clone only with its reason. When you remove one, remove its entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const APPLICATION = 'An application repository checkout, not configuration (source control, §10).';

/** Each clone that remains, and why. */
const CLONES = Object.freeze({
  // Source control: checkouts people and Auto work in, outside SDA-AC-013.
  'auto/auto-checkpoint.mjs#ensureManagedRecoveryCheckout': `${APPLICATION} Auto recovery's own Story checkout.`,
  'auto/auto-checkpoint.mjs#bootstrapRecoveryCheckout': `${APPLICATION} Auto recovery when this checkout lacks the Story branch.`,
  'bootstrap.mjs#bootstrapRepository': `${APPLICATION} \`bootstrap\` creates the working checkout.`,
  'commands/story.mjs#storyFetchCommand': `${APPLICATION} \`story fetch --directory\` into a new directory.`,
  'epic-review.mjs#prepareReviewClone': `${APPLICATION} The Epic review checkout, away from the person's tree.`,
  'initiative-repositories.mjs#cloneManagedRepository': `${APPLICATION} An Initiative's managed clone, made once.`,
  'workspace-branch-checkout.mjs#prepareWorkspaceBranch': `${APPLICATION} A workspace's Story branch checkout.`,
  'workspace.mjs#cloneOnce': `${APPLICATION} A workspace member's working checkout.`,
  'workspace-impact.mjs#materializeSandbox': `${APPLICATION} A sandbox copy the impact analysis cannot write through.`,
  'sgos/candidate-lifecycle.mjs#verifySgosCandidate': `${APPLICATION} A separate object store, so a verifier cannot change application refs.`,
  'organisation.mjs#authorGovernanceProposal': 'A local shared clone of the application commit: the first governance proposal, without touching the worktree.',
  'session-remote-url-discovery.mjs#cloneBloblessBranch': 'Story discovery reads the ledger state branch when this checkout lacks it; blobless, no source.',
  'cli.mjs#stageTrustedFreshInstallSource': 'A product install: the admitted product commit, frozen into a private copy.',
  'first-run-guide.mjs#runFirstRunGuide': 'The offline guide makes a local bare origin for its demo repository.',

  // Configuration: governed writes, which commit and push from a checkout.
  'capability-configuration-checkout.mjs#cloneCapabilityConfiguration':
    'Capability review, repair, activation and rebase, and a remap with history: the checkout they commit and push from.',
  'configuration-object-store.mjs#prepareConfigurationObjectCheckout':
    'A local shared clone of the object pool, for a governed write that needs a checkout; reads take the pool in place.',
  'configuration-proposal.mjs#withWorkflowProposalCheckout':
    'Workflow activation, and an inspection whose object pool declined: blobless, no checkout.',
  'configuration-recreate-sync.mjs#recreateAndSyncConfiguration':
    'Recreate and sync replays every pending proposal onto approved history and pushes the result.',
  'configuration-proposal-cleanup.mjs#cleanupActivatedConfigurationProposal':
    'Retiring an activated proposal proves its ancestry here when no checkout was handed over.',
  'organisation.mjs#publishOrganisationCapabilityMap': 'Publishing the state mirror from the approved definition.',
  'capability-authority-link.mjs#cloneOneBranch': 'Retiring a stale authority link commits on the exact reviewed state commit.',
  'workspace-configuration-refresh.mjs#cloneConfiguration': 'Configuration refresh builds and migrates its candidate in a checkout, then pushes it.',
  'workspace-configuration-refresh.mjs#retainRefreshPlanCache': 'A local copy of the validated refresh preview, so apply needs no second remote clone.',
  'configuration-branch.mjs#cloneWorkspaceConfiguration':
    'A local shared clone of the workspace\'s own objects: Story start\'s configuration-only checkout for its enrollment commit.',

  // Configuration: one-time creation of an authority.
  'configuration-branch.mjs#ensureConfigurationBranch': 'Creating `sflow/config` imports the application branch\'s configuration once.',
  'workspace-configuration-refresh.mjs#prepareBootstrapInspectionCandidate':
    'The would-be first authority of a repository with none, so preview and apply bind the same bytes.',

  // Configuration reads not yet moved to exact objects (open after B6).
  'configuration-proposal.mjs#listWorkflowConfigurationProposals':
    'Only when the configuration object pool declines (busy, over budget, unqualified or off): blobless, no checkout.',
  'organisation.mjs#listCapabilityProposals':
    'Only when the configuration object pool declines; the pool path itself still borrows a checkout (listed below).',
  'configuration-proposal.mjs#configurationProposalCommitStatus':
    'Proposal status proves a merge by ancestry over full history; it could read the object pool instead.',
  'configuration-branch.mjs#cloneConfiguration':
    'Approved configuration read without the object cache (Story start, `inspectApprovedConfiguration`), or after every exact-object path declined.',
  'configuration-branch.mjs#copyVerifiedStateConfiguration': 'Reading a verified state mirror when there is no `sflow/config`.',
  'configuration-branch.mjs#legacyMirrorRetainedHistoryMatches':
    'A legacy state mirror with no repository binding proves ownership through its retained history.',
  'organisation.mjs#loadCapabilityStateSnapshot': 'Verifying a state mirror on a custom-named ledger branch.',
  'organisation.mjs#readOrganisation': 'Reading the capability map on a cache miss or `--refresh`.',
  'repository-onboarding.mjs#cloneFilteredSnapshot': 'Onboarding\'s bounded snapshot of a state, configuration or application branch.',
  'repository-onboarding.mjs#activateRepositoryOnboardingProposal':
    'A repeated setup activation whose proposal is gone proves it was already merged.',
  'workspace.mjs#workspaceRemoteCapabilities': 'Reading a lead\'s capability map and portfolio for `workspace capabilities`.'
});

/** Each route into a configuration checkout that remains, and why. */
const CHECKOUT_ROUTES = Object.freeze({
  'organisation.mjs#withLeadCheckout>cloneCapabilityConfiguration': 'The clone path of a capability edit that is not projected.',
  'organisation.mjs#withCapabilityProposalCheckout>cloneCapabilityConfiguration': 'The capability proposal checkout.',
  'capability-configuration-checkout.mjs#cloneCapabilityConfiguration>prepareConfigurationObjectCheckout':
    'A capability checkout with history borrows the complete-object pool, dissociated.',
  'organisation.mjs#rebaseCapabilityProposal>withLeadCheckout':
    'Rebase writes a proposal with its source as a second parent, which needs history.',
  'organisation.mjs#mapCapability>withLeadCheckout(history)':
    'A remap with a retained same-ID proposal classifies it against history; other maps are projected.',
  'organisation.mjs#mapCapabilityTeam>withLeadCheckout(history)':
    'A team remap with a retained same-team proposal, as for a map.',
  'organisation.mjs#activateCapabilityProposal>withCapabilityProposalCheckout':
    'Activation\'s review checkout, where the ledger audit and proposal cleanup run.',
  'organisation.mjs#repairCapabilityProposal>withCapabilityProposalCheckout':
    'Repair commits a packaged-compatibility change on top of the proposal and pushes it.',
  'organisation.mjs#inspectCapabilityProposal>withCapabilityProposalCheckout':
    'Capability proposal inspection: a read, not yet moved to the object pool.',
  'organisation.mjs#inspectCapabilityRebase>withCapabilityProposalCheckout':
    'The rebase preview reads base, source and target at once; a read, not yet moved.',
  'organisation.mjs#listCapabilityProposals>prepareConfigurationObjectCheckout':
    'The capability inbox validates each proposal in a worktree made from this checkout; not yet moved.',
  'configuration-proposal.mjs#withWorkflowProposalCheckout>prepareConfigurationObjectCheckout':
    'Workflow activation\'s checkout, from the object pool.',
  'configuration-proposal.mjs#activateWorkflowConfigurationProposal>withWorkflowProposalCheckout':
    'Workflow activation prepares, commits and pushes its transaction in a checkout.'
});

/** The routes that must stay without a clone or checkout. */
const EXACT_OBJECT_ROUTES = Object.freeze([
  'configuration-proposal.mjs#inspectWorkflowConfigurationProposal>withWorkflowProposalCheckout',
  'configuration-proposal.mjs#listWorkflowConfigurationProposals>prepareConfigurationObjectCheckout',
  'configuration-proposal.mjs#withWorkflowProposalCheckout>prepareConfigurationObjectCheckout',
  'organisation.mjs#addCapabilityRepository>withLeadCheckout',
  'organisation.mjs#adoptManagedCapabilityMap>withLeadCheckout',
  'organisation.mjs#editCapabilityInOrganisation>withLeadCheckout',
  'organisation.mjs#mapCapability>withLeadCheckout',
  'organisation.mjs#mapCapabilityTeam>withLeadCheckout',
  'organisation.mjs#proposeProgressiveCapabilityChange>withLeadCheckout'
]);

/** Helper name → index of its options argument. */
const CHECKOUT_HELPERS = Object.freeze({
  withLeadCheckout: 4,
  withCapabilityProposalCheckout: 3,
  cloneCapabilityConfiguration: 1,
  withWorkflowProposalCheckout: 3,
  prepareConfigurationObjectCheckout: 2
});

async function sourceFiles(directory, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await sourceFiles(absolute, output);
    else if (entry.name.endsWith('.mjs')) output.push(absolute);
  }
  return output;
}

function stringValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

/** Whether the array is a Git argument list whose verb is `clone` (`-c key=value` pairs may lead). */
function isCloneArgv(array) {
  for (let index = 0; index < array.elements.length; index += 2) {
    const value = stringValue(array.elements[index]);
    if (value === 'clone') return true;
    if (value !== '-c') return false;
  }
  return false;
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
  }
  return '<module>';
}

/** The literal value of `name` in an object-literal argument, `undefined` when absent or not literal. */
function option(node, name) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.getText() === name);
  if (!property) return undefined;
  if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
  return 'dynamic';
}

export async function cloneBoundarySites(sourceRoot = path.join(root, 'src')) {
  const sites = [];
  for (const file of await sourceFiles(sourceRoot)) {
    const text = await readFile(file, 'utf8');
    if (!/'clone'|Checkout\(|cloneCapabilityConfiguration/u.test(text)) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
    const line = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const visit = (node) => {
      if (ts.isArrayLiteralExpression(node) && (ts.isCallExpression(node.parent) || ts.isVariableDeclaration(node.parent))
          && isCloneArgv(node)) {
        sites.push({ key: `${relative}#${enclosingFunction(node)}`, line: line(node), kind: 'clone' });
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && Object.hasOwn(CHECKOUT_HELPERS, node.expression.text)) {
        const helper = node.expression.text;
        const options = node.arguments[CHECKOUT_HELPERS[helper]];
        const key = `${relative}#${enclosingFunction(node)}>${helper}`;
        let kind = 'checkout';
        if (helper === 'withLeadCheckout' && option(options, 'objectProjection') === true) {
          kind = option(options, 'fullHistory') === undefined || option(options, 'fullHistory') === false
            ? 'exact-objects' : 'history';
        } else if (['withWorkflowProposalCheckout', 'prepareConfigurationObjectCheckout'].includes(helper)
            && option(options, 'checkout') === false) kind = 'exact-objects';
        sites.push({ key: kind === 'history' ? `${key}(history)` : key, line: line(node), kind });
        if (kind === 'history') sites.push({ key, line: line(node), kind: 'exact-objects' });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites;
}

const keys = (sites, kinds) => [...new Set(sites.filter((site) => kinds.includes(site.kind)).map((site) => site.key))].sort();

test('every clone in src/ is listed with its reason, and the list changes only on purpose (SDA-AC-013)', async () => {
  const sites = await cloneBoundarySites();
  assert.deepEqual(keys(sites, ['clone']), Object.keys(CLONES).sort(),
    'a new clone is listed here with its reason; a clone that is gone is removed from the list');
  assert.deepEqual(keys(sites, ['checkout', 'history']), Object.keys(CHECKOUT_ROUTES).sort(),
    'a new route into a configuration checkout is listed with its reason; one that is gone is removed');
});

test('ordinary configuration editing and workflow proposal reads stay on exact objects (SDA-AC-013)', async () => {
  const sites = await cloneBoundarySites();
  assert.deepEqual(keys(sites, ['exact-objects']), [...EXACT_OBJECT_ROUTES].sort(),
    'these build or read from exact objects; dropping `objectProjection` or `checkout: false` makes them clone');
});

test('the scan tells a clone and a checkout route from an exact-object route', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-clone-boundary-'));
  try {
    await writeFile(path.join(directory, 'fixture.mjs'), [
      "async function plain() { return runRemoteGitAsync(['clone', '--quiet', remote, target]); }",
      "async function configured() { return run('git', ['-c', 'core.autocrlf=false', 'clone', '--shared', source, target]); }",
      "async function named() { const args = ['clone', remote, target]; return run('git', args); }",
      "const VERBS = new Set(['clone', 'fetch']);",
      "async function notClone() { return run('git', ['fetch', 'clone']); }",
      "async function edit() { return withLeadCheckout(url, 'm', 'p', mutate, { objectProjection: true }); }",
      "async function remap() { return withLeadCheckout(url, 'm', 'p', mutate, { fullHistory: refs.length > 0, objectProjection: true }); }",
      "async function rebase() { return withLeadCheckout(url, 'm', 'p', mutate, { fullHistory: true }); }",
      "async function list() { return prepareConfigurationObjectCheckout(root, null, { remote, checkout: false }); }",
      "async function activate() { return prepareConfigurationObjectCheckout(root, scratch, pool); }",
      "async function review() { return withCapabilityProposalCheckout(url, branch, operation, { expectedCommit }); }"
    ].join('\n'));
    const sites = await cloneBoundarySites(directory);
    assert.deepEqual(sites.map((site) => [site.key, site.kind]), [
      ['fixture.mjs#plain', 'clone'], ['fixture.mjs#configured', 'clone'], ['fixture.mjs#named', 'clone'],
      ['fixture.mjs#edit>withLeadCheckout', 'exact-objects'],
      ['fixture.mjs#remap>withLeadCheckout(history)', 'history'], ['fixture.mjs#remap>withLeadCheckout', 'exact-objects'],
      ['fixture.mjs#rebase>withLeadCheckout', 'checkout'],
      ['fixture.mjs#list>prepareConfigurationObjectCheckout', 'exact-objects'],
      ['fixture.mjs#activate>prepareConfigurationObjectCheckout', 'checkout'],
      ['fixture.mjs#review>withCapabilityProposalCheckout', 'checkout']
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
