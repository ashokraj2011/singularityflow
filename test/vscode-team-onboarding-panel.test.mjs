import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (...parts) => path.join(packageRoot, 'apps', 'vscode', 'src', ...parts);
const panel = await readFile(source('views', 'team-onboarding-panel.ts'), 'utf8');
const extension = await readFile(source('extension.ts'), 'utf8');
const lazyPanels = await readFile(source('lazy-panels-runtime.ts'), 'utf8');
const packageJson = JSON.parse(await readFile(
  path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
const { TEAM_ONBOARDING_MESSAGE_TYPES } = await import(
  source('views', 'team-onboarding-page.ts'));

function methodBody(name) {
  const signature = new RegExp(`\\n  private (?:async )?${name}\\(`, 'u').exec(panel);
  const start = signature?.index ?? -1;
  assert.notEqual(start, -1, `${name} must remain an explicit host-boundary method`);
  const next = panel.indexOf('\n  private ', start + 1);
  return panel.slice(start, next === -1 ? panel.length : next);
}

test('team onboarding is contributed once and loaded through the lazy panel runtime', () => {
  const contributed = packageJson.contributes.commands.filter(
    (entry) => entry.command === 'singularityFlow.onboardTeam');
  assert.equal(contributed.length, 1);
  assert.match(contributed[0].title, /Onboard a Team/);
  assert.match(lazyPanels,
    /export \{ TeamOnboardingPanel \} from '\.\/views\/team-onboarding-panel\.ts';/);
  assert.match(extension,
    /registerCommand\(\s*'singularityFlow\.onboardTeam'/);
  assert.match(extension,
    /const \{ TeamOnboardingPanel \} = lazyPanels\(\);[\s\S]*TeamOnboardingPanel\.show\(/);
  assert.ok(packageJson.contributes.walkthroughs.some((walkthrough) =>
    walkthrough.steps.some((step) =>
      step.completionEvents?.includes('onCommand:singularityFlow.onboardTeam'))));
});

test('team onboarding webview messages are a closed contract resolved by the host', () => {
  const registration = /registerMessageRouter\('singularityFlow\.teamOnboarding', \{([\s\S]*?)\n  \}\);/u
    .exec(panel)?.[1];
  assert.ok(registration, 'the panel must register one closed router');
  const hostTypes = [...registration.matchAll(
    /^\s+(?:'([^']+)'|([A-Za-z][A-Za-z0-9-]*)):\s*\(/gmu
  )].map((match) => match[1] ?? match[2]).sort();
  assert.deepEqual(hostTypes, [...TEAM_ONBOARDING_MESSAGE_TYPES].sort(),
    'the document and privileged host must accept the same exact message set');
  assert.match(panel,
    /const navigation = navigationTarget\(raw\);[\s\S]*void this\.router\.route\(raw\)/,
    'messages must cross navigation validation or the closed router');
  assert.match(panel, /catalogSecrets = new Map<string, CatalogSecret>\(\)/,
    'provider selection references and locators stay in extension-host memory');
});

test('provider repositories are explicitly selected before their locator can be inspected', () => {
  const prepared = methodBody('preparedLocator');
  assert.match(prepared,
    /secret\.source === 'catalog'[\s\S]*if \(!secret\.selectionRef\)[\s\S]*incomplete or expired/,
    'catalog observations cannot fall back to an un-revalidated locator');
  assert.match(prepared,
    /'repositories', 'select', secret\.selectionRef, '--action', 'inspect',[\s\S]*'--surface', 'vscode', '--json'/);
  assert.match(prepared, /gitRemoteProblem\(locator, row\.nameWithOwner\)/,
    'the selected locator is revalidated before it reaches Git');

  const inspect = methodBody('inspectOne');
  const preparation = inspect.indexOf('await this.preparedLocator(row)');
  const repositoryInspection = inspect.indexOf("'capability', 'inspect-repository', locator");
  assert.ok(preparation >= 0 && repositoryInspection > preparation,
    'host-owned RDS selection must complete before capability inspection');
  assert.doesNotMatch(inspect, /selectionRef[^\n]*inspect-repository/,
    'an opaque provider reference is never passed to the capability command as a Git locator');
});

test('catalog reads are revision-fenced and cancelled before stale results can replace current state', () => {
  const begin = methodBody('beginCatalogRead');
  assert.match(begin, /catalogController\?\.abort\(\)/);
  assert.match(begin, /catalogRevision \+= 1/);
  const read = methodBody('catalogRun');
  assert.match(read, /controller\.signal\.aborted \|\| !this\.catalogReadIsCurrent\(revision\)/);
  assert.match(methodBody('refreshCatalog'), /beginCatalogRead\(\)[\s\S]*catalogReadIsCurrent\(revision\)/);
  assert.match(panel, /dispose\(\): void \{[\s\S]*catalogController\?\.abort\(\)/);
});

test('pasting a repository never silently appoints the first capability authority', () => {
  const paste = methodBody('pasteRepository');
  assert.match(paste, /source: 'paste'/);
  assert.match(paste, /Explicitly choose which selected repository will own the first capability-map authority/);
  assert.doesNotMatch(paste, /authorities:\s*\[|selectedAuthorityId:/,
    'authority assignment remains a separate explicit action');
  assert.match(methodBody('authorityFromSelection'),
    /await this\.preparedLocator\(row, controller\.signal\)[\s\S]*selectedAuthorityId: authority\.id/);
});

test('selected repository inspection is sequential, cancellable, and failure-isolated', () => {
  const selected = methodBody('inspectSelected');
  assert.match(selected,
    /for \(const rowId of selected\) \{[\s\S]*signal\.aborted\) break;[\s\S]*await this\.inspectOne\(rowId\)/,
    'the explicit queue is bounded and inspected one repository at a time');
  assert.doesNotMatch(selected, /Promise\.all|Promise\.allSettled/,
    'provider/Git checks must not become an implicit parallel batch');
  assert.match(methodBody('cancelInspection'),
    /inspectionController\?\.abort\(\)[\s\S]*cancelled: true/);
  assert.match(methodBody('inspectOne'),
    /catch \(error\)[\s\S]*status: 'left-out'/,
    'one failed repository is set aside instead of blocking later queue entries');
});

test('one map-team mutation feeds review activation and the existing workspace handoff', () => {
  const submit = methodBody('submitProposal');
  assert.match(submit, /request = mapTeamRequest\(this\.view\)/);
  assert.match(submit,
    /withTeamOnboardingRequestFile\(request,[\s\S]*\['capability', 'map-team', '--request', requestFile, '--json'\]/,
    'the extension keeps the potentially large team document out of Windows process argv');
  assert.doesNotMatch(submit, /'--member'|'--member-name'|'--lead'/,
    'the UI mutation transport never expands request fields back into argv');
  assert.equal((submit.match(/this\.run\(argv\)/g) ?? []).length, 1,
    'one click creates exactly one aggregate capability proposal');
  assert.match(submit, /status: 'review-required'/,
    'proposal creation does not silently bypass governed review');

  const review = methodBody('reviewProposal');
  assert.match(review,
    /this\.review\(authority\.leadUrl, branch, async \(\) => \{[\s\S]*status: 'active'[\s\S]*this\.populateWorkspacePreview\(\)/,
    'workspace setup unlocks only from the proposal activation callback');
  assert.match(methodBody('openWorkspace'),
    /proposal\.status !== 'active'[\s\S]*workspaceOpen\(this\.view\.teamId, authority\.leadUrl\)/);
  assert.match(extension,
    /async \(teamId, lead\) => \{[\s\S]*executeCommand\('singularityFlow\.createWorkspace', \{[\s\S]*capabilityId: teamId,[\s\S]*organisation: lead/,
    'step three reuses the governed multi-capability workspace form');
});
