import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { invokeCliProcess, validateRepositoryDirectory } from '../apps/desktop/electron/cli-runner.mjs';
import {
  assertWorkspaceEpicIssue,
  assertWorkspaceEpicKey,
  jiraIssueKeyFromReference,
  summarizeWorkspaceEpicProjects,
  workspaceJiraRouting,
  workspacePortfolioConfiguration
} from '../apps/desktop/electron/workspace-epic.mjs';
import { workspaceLandingPage } from '../apps/desktop/src/workspace-routing.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Electron repository validation explains invalid and uninitialized selections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-repository-'));
  await assert.rejects(() => validateRepositoryDirectory(root), /not a Git repository/);
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  await assert.rejects(() => validateRepositoryDirectory(root), /not initialized with Singularity Flow/);
  await mkdir(path.join(root, '.singularity'));
  await writeFile(path.join(root, '.singularity', 'workflow.yml'), 'version: 1\n');
  await assert.rejects(
    () => validateRepositoryDirectory(root),
    (error) => error.code === 'SINGULARITY_FLOW_LEGACY_CONTROL_ROOT' && error.legacyRoot === '.singularity'
  );
  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
  assert.equal(await validateRepositoryDirectory(root), await realpath(root));
});

test('Electron repository validation canonicalizes aliases and rejects fake Git or symlinked control paths', async () => {
  const fake = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-fake-git-'));
  await mkdir(path.join(fake, '.git'));
  await mkdir(path.join(fake, 'singularity'));
  await writeFile(path.join(fake, 'singularity', 'workflow.yml'), 'version: 1\n');
  await assert.rejects(() => validateRepositoryDirectory(fake), /not a valid Git working tree/);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-canonical-'));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  const external = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-external-'));
  await writeFile(path.join(external, 'workflow.yml'), 'version: 1\n');
  await symlink(external, path.join(root, 'singularity'), 'dir');
  await assert.rejects(() => validateRepositoryDirectory(root), /control directory cannot be a symbolic link/);

  const safe = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-safe-'));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: safe }).status, 0);
  await mkdir(path.join(safe, 'singularity'));
  await writeFile(path.join(safe, 'singularity', 'workflow.yml'), 'version: 1\n');
  const alias = `${safe}-alias`;
  await symlink(safe, alias, 'dir');
  assert.equal(await validateRepositoryDirectory(alias), await realpath(safe));
});

test('Electron CLI runner returns JSON and bounds a stuck child process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-electron-runner-'));
  const fixture = path.join(root, 'fixture.mjs');
  await writeFile(fixture, `
if (process.argv[2] === 'wait') setInterval(() => {}, 1000);
else process.stdout.write(JSON.stringify({ opened: process.cwd() }));
`);
  const opened = await invokeCliProcess({ executable: process.execPath, cli: fixture, repository: root, args: ['open'], env: process.env, timeoutMs: 1000 });
  assert.equal(await realpath(opened.opened), await realpath(root));
  await assert.rejects(
    () => invokeCliProcess({ executable: process.execPath, cli: fixture, repository: root, args: ['wait'], env: process.env, timeoutMs: 50 }),
    /did not finish within 1 seconds/
  );
});

test('Electron welcome screen opens the workspace boundary and preserves loading feedback', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  assert.match(source, /Opening workspace…/);
  assert.match(source, /Open project workspace/);
  assert.match(source, /workspace carries every repository and its Jira routing/);
  assert.match(source, /Opening the selected project context/);
  assert.match(source, /Open or create workspace/);
  assert.match(source, /Workspace configuration/);
  assert.match(source, /\['workspaces', 'Workspace configuration'\]/);
  assert.match(source, /acceptOpened\(result, workspaceLandingPage\(result\)\)/);
  assert.match(source, /if \(result\.profile\.workspacePath\) await openWorkspace\(result\.profile\.workspacePath\)/);
  assert.doesNotMatch(source, /firstRepository/);
  assert.match(source, /defaultBaseDirectory=\{data\.workspaceSetup\?\.baseDirectory/);
  assert.match(source, /if \(!data\).*<Toast toast=\{toast\}/s);
  assert.doesNotMatch(source, /finally \{ setBusy\(false\); setTimeout\(\(\) => setToast\(null\)/);
});

test('Electron routes new workspace selections to configuration before Epic intake', () => {
  assert.equal(workspaceLandingPage({ workspaceSetup: { mode: 'create' } }), 'workspaces');
  assert.equal(workspaceLandingPage({ workspaceSetup: { mode: 'saved-needs-repair' } }), 'workspaces');
  // One experience: an established workspace always lands on Epics, whatever the role.
  assert.equal(workspaceLandingPage({ workspace: { workspace: { id: 'existing' } } }), 'epics');
});

test('workspace Epic intake scopes Jira and derives portfolio configuration from the selected workspace', () => {
  const workspace = {
    leadRepository: 'lead',
    repositories: {
      lead: {
        url: 'https://github.com/company/lead.git',
        defaultBranch: 'main',
        required: true,
        jira: { board: 'KAN' },
        metadata: { name: 'Lead', appId: 'APP-1' }
      },
      mobile: {
        url: 'https://github.com/company/mobile.git',
        defaultBranch: 'main',
        required: true,
        jira: { board: 'MOB' },
        metadata: { name: 'Mobile', appId: 'APP-2' }
      }
    }
  };
  const credentials = {
    connected: true,
    connection: {
      name: 'corporate-jira',
      deployment: 'cloud',
      baseUrl: 'https://company.atlassian.net'
    }
  };
  const routing = workspaceJiraRouting(workspace, credentials);
  assert.deepEqual(routing.projectKeys, ['KAN', 'MOB']);
  assert.equal(routing.leadProjectKey, 'KAN');
  assert.equal(assertWorkspaceEpicKey(routing, 'kan-8'), 'KAN-8');
  assert.equal(assertWorkspaceEpicKey(routing, 'https://company.atlassian.net/browse/KAN-8'), 'KAN-8');
  assert.equal(assertWorkspaceEpicKey(routing, '10042'), '10042');
  assert.equal(jiraIssueKeyFromReference('https://company.atlassian.net/browse/MOB-42'), 'MOB-42');
  assert.equal(assertWorkspaceEpicIssue(routing, { key: 'KAN-8' }).key, 'KAN-8');
  assert.throws(() => assertWorkspaceEpicIssue(routing, { key: 'OTHER-2' }), /outside this workspace/);
  assert.throws(() => assertWorkspaceEpicKey(routing, 'OTHER-2'), /outside this workspace/);
  const configuration = workspacePortfolioConfiguration(workspace, credentials);
  assert.deepEqual(Object.keys(configuration.repositories), ['lead', 'mobile']);
  assert.deepEqual(configuration.jira.allowedProjects, ['KAN', 'MOB']);
  assert.equal(configuration.jira.projectKey, 'KAN');
  assert.equal(configuration.jira.writeMode, 'approved');
});

test('workspace Epic listing keeps valid projects when another Jira route is invalid', () => {
  const result = summarizeWorkspaceEpicProjects([
    {
      projectKey: 'KAN',
      repositoryIds: ['lead'],
      epics: [
        { key: 'KAN-8', title: 'Newest', updatedAt: '2026-07-24T12:00:00.000Z' },
        { key: 'KAN-7', title: 'Older', updatedAt: '2026-07-23T12:00:00.000Z' }
      ]
    },
    {
      projectKey: 'KAB',
      repositoryIds: ['mobile'],
      error: new Error("Jira request failed (404): No project could be found with id or key 'KAB'.")
    },
    {
      projectKey: 'KAN',
      repositoryIds: ['duplicate-route'],
      epics: [{ key: 'KAN-8', title: 'Duplicate', updatedAt: '2026-07-22T12:00:00.000Z' }]
    }
  ]);
  assert.deepEqual(result.epics.map((epic) => epic.key), ['KAN-8', 'KAN-7']);
  assert.deepEqual(result.warnings, [{
    projectKey: 'KAB',
    repositoryIds: ['mobile'],
    message: "Jira request failed (404): No project could be found with id or key 'KAB'."
  }]);
});

test('Electron Epic start remains usable without an existing portfolio and renderer failures stay recoverable', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const entrypoint = await readFile(path.join(packageRoot, 'apps/desktop/src/main.jsx'), 'utf8');
  assert.match(source, /data\.portfolio\?\.initiativeProfiles \?\? \{/);
  assert.match(source, /Epic planning initialized from the repository defaults/);
  assert.match(source, /Initialize governed Epic planning/);
  assert.match(source, /No separate portfolio setup is required/);
  assert.match(source, /Local Epic creation starts from a clean/);
  assert.doesNotMatch(source, /Object\.entries\(data\.portfolio\.initiativeProfiles\)/);
  assert.match(entrypoint, /class DesktopErrorBoundary extends React\.Component/);
  assert.match(entrypoint, /This screen could not finish loading/);
  assert.match(entrypoint, /window\.location\.reload\(\)/);
});

test('Electron onboarding fails closed with a recoverable retry screen', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const main = await readFile(path.join(packageRoot, 'apps/desktop/electron/main.mjs'), 'utf8');
  assert.match(source, /function OnboardingLoadFailure/);
  assert.match(source, /We stopped before opening your workspace/);
  assert.match(source, /No repository, Jira, or Git state was changed/);
  assert.match(source, /The secure desktop bridge is unavailable/);
  assert.match(source, /setOnboardingAttempt\(\(current\) => current \+ 1\)/);
  assert.match(source, /Advanced setup remains available later/);
  assert.match(source, /Local workspaces/);
  assert.match(source, /Jira connection/);
  assert.match(source, /result\.notices\?\.length/);
  assert.doesNotMatch(source, /if \(saved\) setDraft\(\(current\) => \(\{ \.\.\.current, step: nextStep \}\)\)/);
  assert.match(main, /prepareOnboardingProfile/);
  assert.match(main, /notices: prepared\.notices/);
  assert.doesNotMatch(source, /setOnboarding\(\{ profile: \{ completed: true \}/);
});

test('Electron desktop exposes guided workflow and portable repository configuration controls', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const navigation = source.slice(source.indexOf('const engineerNavSections'), source.indexOf('const onboardingRoles'));
  const styles = await readFile(path.join(packageRoot, 'apps/desktop/src/styles.css'), 'utf8');
  const preload = await readFile(path.join(packageRoot, 'apps/desktop/electron/preload.cjs'), 'utf8');
  const main = await readFile(path.join(packageRoot, 'apps/desktop/electron/main.mjs'), 'utf8');
  const indexHtml = await readFile(path.join(packageRoot, 'apps/desktop/index.html'), 'utf8');
  const artifactBuilder = await readFile(path.join(packageRoot, 'apps/desktop/src/artifact-builder.mjs'), 'utf8');
  assert.match(source, />＋ Workflow</);
  assert.match(source, />＋ New stage</);
  assert.match(source, /Artifact path/);
  assert.match(source, /Inputs from earlier stages/);
  assert.match(source, /Copilot session policy/);
  assert.match(source, /Block mutating tools until both selections complete/);
  assert.match(source, /Create artifact template/);
  assert.match(source, /Create persona and prompt/);
  assert.match(source, /Create repository skill/);
  assert.match(source, /Repository-owned world model/);
  assert.match(source, /Editable builder prompt/);
  assert.match(source, /World-model views/);
  assert.match(source, /referenced view cannot be removed/i);
  assert.match(styles, /Avenir Next/);
  assert.match(styles, /Iowan Old Style/);
  assert.match(styles, /color-scheme: light/);
  assert.match(styles, /--navy-950/);
  assert.match(styles, /background: #181817/);
  assert.match(styles, /border-radius: 999px/);
  assert.match(styles, /body \{[^}]*font-size: 15px/s);
  assert.match(source, /fontSize: 14/);
  assert.doesNotMatch(source, /className="publish-scope-notice"/);
  assert.doesNotMatch(styles, /\.publish-scope-notice/);
  assert.match(source, />Download config</);
  assert.match(source, /Approval inbox/);
  assert.match(source, /Initiative orchestration/);
  assert.match(source, /Advanced governance/);
  assert.match(source, /Cross-repository control plane/);
  assert.match(source, /Set up your Epic workspace/);
  assert.doesNotMatch(source, /if \(!portfolio\) return <div className="page"><PortfolioSetup/);
  assert.match(source, /workspaceJiraContext/);
  assert.match(source, /workspaceJiraEpics/);
  assert.match(source, /workspaceJiraEpic/);
  assert.match(source, /bootstrapWorkspacePortfolio/);
  assert.match(source, /Select an Epic from Jira/);
  assert.match(source, /Fetch selected Epic/);
  assert.match(source, /Enter an Epic key, URL, or numeric Jira ID instead/);
  assert.match(source, /Some configured Jira projects could not be loaded/);
  assert.match(source, /correctWorkspaceJiraRoute/);
  assert.match(source, /disabled=\{!connected \|\| !selectedEpicKey\}/);
  // Was copy from the deleted second Requirements screen; the surviving workspace owns artifacts.
  assert.match(source, /Artifacts/);
  // Was EpicRequirementsView — a second Requirements screen for the same phase, reached from the
  // journey rail while the sidebar reached PhaseWorkspace. Only the workspace survives.
  assert.match(source, /function PhaseWorkspace/);
  assert.doesNotMatch(source, /function EpicRequirementsView/);
  assert.match(styles, /\.requirements-output-map/);
  assert.match(source, /Create & validate governance/);
  assert.match(source, /Set your working perspective/);
  assert.match(source, /Advanced setup/);
  assert.match(source, /Local workspace/);
  assert.match(source, /Workspace repositories/);
  assert.match(source, /Lead and participating repositories/);
  assert.match(source, /Jira connection/);
  assert.match(source, /Continue to Flow/);
  assert.match(source, /Local setup recovered/);
  assert.match(source, /Application ID/);
  assert.match(source, /Additional metadata/);
  assert.match(source, /Add a participating repository/);
  assert.match(source, /Add to YAML draft/);
  assert.match(source, /No credentials are stored in Git/);
  assert.match(source, /Assurance & freshness/);
  assert.match(source, /Repository delivery graph/);
  assert.match(source, /Epic-level story progress/);
  // Was 'Epic lifecycle wizard' — that rail was a duplicate of the engine-driven journey rail.
  assert.match(source, /Epic journey progress/);
  assert.match(source, /Turn an Epic into delivery-ready Stories/);
  assert.match(source, /className="epic-start-intro-copy"/);
  assert.match(source, /aria-label="Epic planning workflow"/);
  assert.match(source, /const epicJourneySteps = \['Sources', 'Requirements', 'Planning', 'Stories', 'Complete'\]/);
  assert.match(source, /function EpicJourneyDiagram\(\{ activeStep = 0 \}\)/);
  assert.match(source, /<EpicJourneyDiagram activeStep=\{businessStage\.activeStep\} \/>/);
  assert.match(source, /activeStep: 1/);
  assert.match(source, /activeStep: 2/);
  // The wizard nav is gone; an epic-planning workspace now renders no second nav at all, and the
  // non-epic-planning profiles keep their own tab strip.
  assert.match(source, /selected\?\.state\.initiative\.profile !== 'epic-planning' && <nav className="epic-workspace-nav"/);
  assert.match(source, /Bring from Jira/);
  assert.match(source, /Set up Jira →/);
  assert.match(source, /Connect Jira to bring in Epics/);
  assert.match(source, /Save Jira policy & continue/);
  assert.match(source, /function JiraPolicySetup/);
  assert.match(source, /Save policy & enter credentials/);
  assert.match(source, /Initialize governed Jira access/);
  assert.match(source, /Configure governed Jira access/);
  assert.match(source, /singularity:setup-jira/);
  assert.match(source, /className="jira-setup-overlay"/);
  assert.doesNotMatch(source, /disabled=\{!data\.portfolio\?\.jira\?\.enabled\}/);
  assert.match(source, /Describe the work/);
  assert.match(source, /const navSections/);
  assert.match(source, /\['epics', 'Epics'\]/);
  assert.match(source, /\['inbox', 'Approval inbox'\]/);
  assert.match(source, /Sources/);
  assert.match(source, /PhaseGovernance/);
  assert.match(source, /generated User Stories/);
  assert.match(source, /High-level solution specification/);
  assert.match(source, /Select what Jira receives/);
  assert.match(source, /Spec-to-code completion/);
  assert.match(source, /Pinned source versions/);
  assert.match(source, /Exact Jira Story and artifact plan/);
  assert.match(source, /Story review inbox/);
  assert.match(source, /Run and record exact-SHA checks/);
  assert.match(source, /Local role/);
  assert.match(source, /Jira account/);
  assert.match(source, /Git identity/);
  assert.match(source, /GitHub login/);
  assert.match(preload, /epicSources:/);
  assert.match(preload, /connectEpicSharePoint:/);
  assert.match(preload, /epicReview:/);
  assert.match(preload, /runEpicChecks:/);
  assert.match(preload, /decideEpicReview:/);
  assert.match(preload, /completeEpicDelivery:/);
  assert.match(preload, /startEpicWizard:/);
  assert.match(preload, /startLocalEpic:/);
  // The experience split is gone, so the bridge that persisted the chosen mode is gone with it.
  assert.doesNotMatch(preload, /setExperienceMode:/);
  assert.match(preload, /openInitiative:/);
  assert.match(preload, /publishInitiativePhase:/);
  assert.match(preload, /approveInitiativePhase:/);
  assert.match(main, /epic:sources-upload/);
  assert.match(main, /epic:review-inbox/);
  assert.match(main, /epic:checks/);
  assert.match(main, /epic:decision/);
  assert.match(main, /epic:complete/);
  assert.match(main, /epic:start/);
  assert.match(main, /epic:start-local/);
  assert.doesNotMatch(main, /onboarding:experience/);
  assert.match(main, /initiative:open/);
  assert.match(main, /initiative:phase-publish/);
  assert.match(main, /initiative:phase-approve/);
  assert.match(main, /StorageCredentialStore/);
  assert.match(main, /authorizeSharePoint/);
  assert.match(source, /Sign in with Microsoft/);
  assert.match(source, /Approve exact packet/);
  assert.match(source, /Self-approval warning/);
  assert.match(source, /Story Work ID/);
  assert.match(source, /Create Jira & Git stories/);
  assert.match(source, /Question from Copilot/);
  assert.match(source, /Copilot logs/);
  assert.match(source, /Copilot backend/);
  assert.match(source, /Token usage by model/);
  assert.match(source, /Total tokens/);
  assert.match(source, /Apply model/);
  assert.match(source, /Connected/);
  assert.match(source, /Start backend/);
  assert.match(source, /Stop backend/);
  assert.match(source, /Planning context released; the Copilot backend remains ready/);
  assert.match(source, /Epic decomposition analysis/);
  assert.match(source, /Interface contracts/);
  assert.match(source, /Branches stay isolated/);
  assert.match(source, /never merges them into a default branch automatically/);
  assert.match(source, /No workspace selected/);
  assert.match(source, /lead repository/);
  assert.match(source, /Pending approvals/);
  assert.match(source, /Fetch remote inbox/);
  assert.match(source, /Model usage & cost/);
  assert.match(source, /Cost by phase/);
  assert.match(source, /Cost by model/);
  assert.match(source, /Cost needs telemetry or pricing/);
  assert.match(source, /Workflow time/);
  assert.match(source, /Total elapsed/);
  assert.match(source, /Approval waiting/);
  assert.match(source, /Copilot capture inactive/);
  assert.match(source, /Telemetry setup is outdated/);
  assert.match(source, /Waiting for Copilot export/);
  assert.match(source, /pending export/);
  assert.match(source, /No estimate shown/);
  assert.match(source, /Recent workspaces/);
  assert.match(source, /Workspace configuration/);
  assert.match(source, /Jira project key/);
  assert.match(source, /KAN from KAN-8/);
  assert.match(source, /Epic-level artifacts are committed here/);
  assert.match(source, /Review save plan/);
  assert.match(source, /Save workspace now/);
  assert.match(source, /Complete: \$\{missingWorkspaceFields\.join\(', '\)\}/);
  assert.match(styles, /\.workspace-save-callout/);
  assert.doesNotMatch(navigation, /Initiative governance/);
  assert.doesNotMatch(navigation, /Jira connection/);
  assert.match(source, /Staged — not governed/);
  assert.match(source, /not separate setup steps/);
  assert.match(source, /Save workspace/);
  assert.match(source, /Preview ready — not saved yet/);
  assert.match(source, /Save workspace now/);
  assert.match(source, /confirmation: workspaceId\.trim\(\)/);
  assert.doesNotMatch(source, /placeholder=\{`Type \$\{workspaceId\}`\}/);
  assert.match(source, /Workspace configuration saved/);
  assert.match(styles, /\.workspace-save-result/);
  assert.match(source, /Isolated project contexts/);
  assert.doesNotMatch(source, /<RecentRepositories/);
  assert.doesNotMatch(source, /Open another repository/);
  assert.doesNotMatch(source, />Open repository</);
  assert.match(source, /Start with your/);
  assert.match(source, /label: 'Delivery'/);
  assert.match(source, /label: 'Decisions'/);
  assert.match(source, /label: 'Configuration'/);
  assert.match(source, /label: 'Learn'/);
  assert.match(source, /label: 'Epic planning'/);
  // 'Advanced' held only Workspace configuration; it now sits under Configuration with the
  // rest of the setup surfaces, so every destination is one grouping deep.
  assert.doesNotMatch(source, /label: 'Advanced'/);
  assert.match(source, /\['workspaces', 'Workspace configuration'\]/);
  assert.match(source, /\['business-requirements', 'Requirements'\]/);
  assert.match(source, /\['business-planning', 'Planning'\]/);
  assert.match(source, /\['templates', 'Artifact templates'\]/);
  assert.match(source, /\['business-stories', 'Create Stories'\]/);
  assert.doesNotMatch(source, /\['planning', 'Copilot Studio'\]/);
  assert.match(source, /function EpicPlanningPage/);
  assert.match(source, /focus=\{\{ phase: 'epic-plan', target: PHASE_SCOPE \}\}/);
  // Requirements is no longer a tab of the Epic workspace: sources, the Copilot conversation, and
  // the artifacts it produces are one phase, so they are one screen.
  assert.doesNotMatch(source, /entryTab="requirements"/);
  // Asserted on the tag, not on prop order — adding a prop is not a regression.
  assert.match(source, /<PhaseWorkspace [^>]*data=\{data\}/);
  assert.match(preload, /listPlanningSessions:/);
  assert.match(preload, /resumePlanningSession:/);
  assert.match(main, /planningSessionRegistryPath/);
  assert.match(main, /planning:sessions/);
  assert.match(main, /planning:resume/);
  assert.match(main, /attachPlanning/);
  // Planning is no longer a tab of the Epic workspace either: it uses the same sources /
  // conversation / artifacts workspace as Requirements.
  assert.doesNotMatch(source, /entryTab="planning"/);
  assert.match(source, /entryTab="publish"/);
  assert.match(source, /Approved Story plan/);
  assert.match(source, /Jira Story key/);
  assert.match(source, /Canonical Git branch/);
  // One publish control for every page now that the experiences are merged: the Business-only
  // 'Commit templates' wording is gone and 'Commit & push' covers templates too.
  assert.doesNotMatch(source, /Commit templates/);
  assert.match(source, /Commit &amp; push/);
  assert.match(source, /Artifact builder/);
  assert.match(source, /Section library/);
  assert.match(source, /Drag into artifact/);
  assert.match(artifactBuilder, /Approved inputs/);
  assert.match(source, /Import from URL/);
  assert.match(source, /Fetch & preview/);
  assert.match(source, /Jira Story key/);
  assert.match(source, /context=\{data\.workspace \? data\.workspace\.workspace\.anchor\.key : 'Workspace'\}/);
  assert.match(source, /function FlowBrand/);
  assert.match(source, /className="flow-brand-parent">Singularity/);
  assert.match(source, /className="flow-brand-product">Flow/);
  assert.match(source, /aria-label=\{`Singularity Flow/);
  assert.match(indexHtml, /<title>Singularity Flow<\/title>/);
  assert.match(source, /singularity\.sidebar\.collapsed/);
  assert.match(source, /sidebar-collapsed/);
  assert.match(source, /sidebar-edge-toggle/);
  assert.match(source, /aria-controls="primary-navigation"/);
  assert.match(source, /function TopbarWorkspace/);
  assert.match(source, /function WorkspaceSelector/);
  assert.match(source, /aria-label="Select current workspace"/);
  assert.match(source, /No workspace selected — choose one/);
  assert.match(source, /load its repositories, Jira routing, and complete project context/);
  assert.match(source, /Open or create workspace…/);
  // One shell for every role: the sidebar is unconditional and the split experiences are gone.
  assert.match(source, /<aside className="sidebar">/);
  assert.doesNotMatch(source, /experienceMode/);
  assert.doesNotMatch(source, /businessNavSections|BusinessNavigation/);
  assert.match(source, /<TopbarWorkspace data=\{data\}/);
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(source, /event\.key\.toLowerCase\(\) !== 'b'/);
  assert.match(source, /className="page-stage"/);
  assert.match(source, /function NavIcon/);
  assert.match(source, /Artifact Studio/);
  assert.match(source, /Requirement workspace/);
  assert.match(source, /VisualComparisonReview/);
  assert.match(source, /Live design — may differ from the pinned intake/);
  assert.match(source, /Open in Figma/);
  assert.match(source, /Impact Analysis Studio/);
  assert.match(source, /Singularity intelligence/);
  assert.match(source, /Singularity analysis/);
  assert.doesNotMatch(source, /SDLC Planner/);
  assert.match(styles, /\.cost-dashboard/);
  assert.match(styles, /\.timing-dashboard/);
  assert.match(styles, /\.timing-row/);
  assert.match(styles, /\.cost-breakdown-grid/);
  assert.match(styles, /\.recent-repositories/);
  assert.match(styles, /\.workspace-health-grid/);
  assert.match(styles, /\.workspace-operation-list/);
  assert.match(styles, /\.initiative-flow/);
  assert.match(styles, /\.initiative-lanes/);
  assert.match(styles, /\.initiative-metrics/);
  assert.match(styles, /\.epic-progress-list/);
  assert.match(styles, /\.business-stage-intro/);
  assert.match(styles, /\.business-lineage-handoff/);
  assert.match(styles, /\.business-stage-intro \{ min-height: 112px/);
  assert.match(styles, /\.business-stage-intro h2/);
  assert.match(styles, /\.epic-start-intro \{ min-height: 128px/);
  assert.match(styles, /\.epic-start-flow span i/);
  assert.match(styles, /\.epic-start-flow span\.active i/);
  assert.match(styles, /\.epic-origin-choice button\.needs-setup/);
  assert.match(styles, /\.jira-setup-overlay/);
  assert.match(styles, /\.artifact-builder/);
  assert.match(styles, /\.artifact-section-palette/);
  assert.match(styles, /\.artifact-builder-canvas/);
  assert.match(styles, /\.artifact-section-card/);
  assert.match(styles, /\.artifact-drop-zone/);
  assert.match(styles, /\.remote-template-preview/);
  assert.match(styles, /\.copilot-question-card/);
  assert.match(styles, /\.planning-console/);
  assert.match(styles, /\.portfolio-setup/);
  assert.match(styles, /\.onboarding-shell/);
  assert.match(styles, /\.onboarding-progress/);
  assert.match(styles, /\.onboarding-ready-summary/);
  assert.match(styles, /\.onboarding-recovery/);
  assert.match(styles, /\.onboarding-failure/);
  assert.match(styles, /\.copilot-service-control/);
  assert.match(styles, /\.copilot-service-log/);
  assert.match(styles, /\.copilot-service-trigger\.stopped \{/);
  assert.match(styles, /\.copilot-service-trigger\.stopped \.copilot-service-orb/);
  assert.match(styles, /\.copilot-service-trigger\.stopped > i/);
  assert.match(styles, /\.repository-menu/);
  assert.match(styles, /\.studio-flow-track/);
  assert.match(styles, /\.requirement-layout/);
  assert.match(styles, /\.visual-comparison-review/);
  assert.match(styles, /\.comparison-slider/);
  assert.match(styles, /\.media-lightbox/);
  assert.match(styles, /\.pinned-media-strip/);
  assert.match(styles, /\.impact-graph/);
  assert.match(styles, /\.welcome-visual/);
  assert.match(styles, /\.flow-brand-mark/);
  assert.match(styles, /@keyframes flowOrbitPulse/);
  assert.match(styles, /\.flow-brand-parent/);
  assert.match(styles, /\.flow-brand-product/);
  assert.match(styles, /Avenir Next/);
  assert.match(styles, /--evergreen-950: #092d20/);
  assert.match(styles, /\.sidebar-edge-toggle/);
  assert.match(styles, /\.shell\.sidebar-collapsed \{ grid-template-columns: 72px/);
  assert.match(styles, /\.workspace-quick-selector/);
  assert.match(styles, /\.workspace-quick-control/);
  // The unified shell drops the business-only chrome and moves the workspace into the top bar.
  assert.doesNotMatch(styles, /business-shell|business-navigation|business-project-switcher/);
  assert.match(styles, /\.topbar-workspace-button/);
  assert.match(styles, /\.topbar-workspace \.repository-menu \{ top: calc\(100% \+ 9px\); right: 0/);
  assert.match(styles, /Operational enterprise workspace/);
  assert.match(styles, /\.topbar-title/);
  assert.match(source, /className="topbar-title"/);
  assert.match(styles, /\.sidebar \{[\s\S]*background: #fff/);
  assert.match(styles, /\.workspace-command,[\s\S]*border: 1\.5px solid #65b783/);
  assert.match(styles, /Modern typography calibration/);
  assert.match(styles, /\.page-heading h1,[\s\S]*font-weight: 600/);
  assert.match(styles, /\.inbox-header,[\s\S]*font-weight: 540/);
  assert.doesNotMatch(styles, /#712ae2/i);
  assert.match(styles, /\.shell\.sidebar-collapsed/);
  assert.match(styles, /\.workflow-layout > \.design-pane/);
  assert.match(styles, /@keyframes page-arrive/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(preload, /recentRepositories/);
  assert.match(preload, /saveOnboarding/);
  assert.match(preload, /chooseOnboardingWorkspace/);
  assert.match(preload, /connectOnboardingJira/);
  assert.match(preload, /resetJiraCredentials/);
  assert.match(preload, /openRepository/);
  assert.match(preload, /forgetRepository/);
  assert.match(preload, /recentWorkspaces/);
  assert.match(preload, /previewWorkspaceConfiguration/);
  assert.match(preload, /previewTemplateUrl/);
  assert.match(preload, /createWorkspaceConfiguration/);
  assert.match(preload, /chooseWorkspaceRepositories/);
  assert.match(preload, /previewWorkspace/);
  assert.match(preload, /jiraWorkspaceAnchors/);
  assert.match(main, /repository:recent/);
  assert.match(main, /onboarding:get/);
  assert.match(main, /onboarding:save/);
  assert.match(main, /onboarding:jira-connect/);
  assert.match(main, /jira:reset-credentials/);
  assert.match(main, /function trustedHandle/);
  assert.equal((main.match(/\bipcMain\.handle\(/g) ?? []).length, 1);
  assert.match(main, /safeExternalUrl/);
  assert.match(main, /repository:open/);
  assert.match(main, /repository:forget/);
  assert.match(main, /workspace:create/);
  assert.match(main, /workspace:configuration-preview/);
  assert.match(main, /configuration:template-url-preview/);
  assert.match(main, /fetchRemoteMarkdown/);
  assert.match(main, /workspace:configuration-create/);
  assert.match(main, /saveWorkspaceConfiguration/);
  assert.match(main, /Workspace configuration saved/);
  assert.match(main, /openWorkspaceStatus/);
  assert.match(main, /workspace:repository-choose/);
  assert.match(main, /inspectWorkspaceSelection/);
  assert.match(main, /openWorkspaceSetup/);
  assert.match(main, /Choose the specific workspace folder/);
  assert.match(main, /workspace:documents-stage/);
  assert.match(main, /workspace:documents-promote/);
  assert.match(main, /staged-not-governed are excluded/);
  assert.match(main, /jira:workspace-anchors/);
  assert.match(preload, /promoteWorkspaceDocument/);
  assert.match(main, /copilotBackend\.stop\(activeRepository\)/);
  assert.match(main, /Migrate folder/);
  assert.match(main, /\['migrate-config'\]/);
  assert.match(main, /does not commit, push, merge, or rewrite Git history/);
  assert.match(preload, /deleteTemplate/);
  assert.match(preload, /refreshInbox/);
  assert.match(preload, /attachInboxItem/);
  assert.match(preload, /downloadFile/);
  assert.match(preload, /importFile/);
  assert.match(preload, /exportBundle/);
  assert.match(preload, /initiativeId/);
  assert.match(preload, /answerPlanningQuestion/);
  assert.match(preload, /bootstrapPortfolio/);
  assert.match(preload, /bootstrapWorkspacePortfolio/);
  assert.match(preload, /workspaceJiraContext/);
  assert.match(preload, /workspaceJiraEpics/);
  assert.match(preload, /correctWorkspaceJiraRoute/);
  assert.match(preload, /workspaceJiraEpic/);
  assert.match(preload, /connectWorkspaceJira/);
  assert.match(preload, /updateWorkspaceConfiguration/);
  assert.match(preload, /archiveWorkspace/);
  assert.match(preload, /restoreWorkspace/);
  assert.match(preload, /startCopilotService/);
  assert.match(preload, /setCopilotServiceModel/);
  assert.match(preload, /stopCopilotService/);
  assert.match(preload, /onCopilotServiceEvent/);
  assert.match(preload, /materializeInitiative/);
  assert.match(preload, /syncInitiative/);
  assert.match(main, /--initiative/);
  assert.match(main, /planning:answer/);
  assert.match(main, /configuration:bootstrap-portfolio/);
  assert.match(main, /configuration:bootstrap-workspace-portfolio/);
  assert.match(main, /workspace:jira-context/);
  assert.match(main, /workspace:jira-epics/);
  assert.match(main, /workspace:jira-route-correct/);
  assert.match(main, /workspace:jira-epic/);
  assert.match(main, /workspace:jira-connect/);
  assert.match(main, /workspace:configuration-update/);
  assert.match(main, /workspace:archive/);
  assert.match(main, /workspace:restore/);
  assert.match(main, /copilot-service:start/);
  assert.match(main, /copilot-service:model/);
  assert.match(await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'copilot-acp.mjs'), 'utf8'), /session:\s*\{\s*configOptions:\s*\{\}\s*\}/);
  assert.match(main, /copilot-service:stop/);
  assert.match(main, /initiative:materialize/);
  assert.match(main, /\['documents', 'preview'/);
  assert.match(main, /Only HTTPS document links can be opened/);
  assert.match(source, /openDocument=\{openRequirementWorkspace\}/);
  assert.match(source, /Open in default app/);
  assert.doesNotMatch(source, /onClick=\{\(\) => document\.path \? downloadFile\(document\.path\) : openWorkspace\(\)\}/);
  assert.doesNotMatch(main, /figma\.com\/embed/);
  assert.doesNotMatch(main, /<webview>/);
});

test('epic start requires world-model generation before requirements', async () => {
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const main = await readFile(path.join(packageRoot, 'apps/desktop/electron/main.mjs'), 'utf8');
  // epic:start reports the world-model status; it never runs the builder itself.
  assert.match(main, /worldModelRebuildReason/);
  assert.match(main, /worldModel = \{ reason, ready: reason === null \}/);
  // The renderer offers generation and does not provide a bypass: requirements must be grounded.
  assert.match(source, /worldModelOffer/);
  assert.match(source, /Generate world model/);
  assert.doesNotMatch(source, /Skip for now/);
  assert.doesNotMatch(source, /onDismiss=\{\(\) => setWorldModelDismissed/);
  // Generation is pushed with the epic branch, so it must not use the local-only path.
  assert.match(source, /generateWorldModel\(data\.repository\.root, false\)/);

  // The builder is declared inside App. EpicStartWizard is a sibling component, so it can only
  // reach it through a prop — and calling it without one is a ReferenceError inside a floating
  // promise, which is how 'Generate world model' came to do nothing whatsoever when clicked.
  // Asserting the call exists is what let that through, so assert the callee is reachable.
  assert.match(source, /function EpicStartWizard\(\{[^}]*\bgenerateWorldModel\b/);
  const renders = source.match(/<EpicStartWizard\b[^>]*\/>/g) ?? [];
  assert.ok(renders.length >= 3, `expected every EpicStartWizard render site, found ${renders.length}`);
  for (const render of renders) assert.match(render, /generateWorldModel=\{generateWorldModel\}/);
  // And the failure is shown on the card rather than swallowed, because this is the only way on.
  assert.match(source, /setWorldModelError/);
});

test('every Epic is reachable and states where its work stands', async () => {
  // KAN-8 is an enterprise-delivery Epic. The top-bar Epic selector filtered to epic-planning, so
  // the only control that switches Epics could not switch to it; and the journey was withheld from
  // its profile, so the workspace never said which phase it was in or what came next. Open, and
  // no way to tell where you were or how to carry on.
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  assert.doesNotMatch(source, /data\.initiatives\.filter\(\(item\) => item\.profile === 'epic-planning'\)/);
  assert.match(source, /aria-label="Epic"[\s\S]{0,400}\{data\.initiatives\.map/);
  // The Epic list itself filtered the same way, so this Epic was in no list anywhere: the page
  // showed its empty state and offered to start work that already existed.
  assert.match(source, /const epics = data\.initiatives;/);

  const desktop = await readFile(path.join(packageRoot, 'src', 'desktop.mjs'), 'utf8');
  assert.doesNotMatch(desktop, /journey: initiative\.resolution\.profile === 'epic-planning'/);
  assert.match(desktop, /journey: epicJourney\(initiative, nextActions\)/);

  // A stage named after one of this initiative's own phases opens that phase's workspace; setting
  // a tab that does not exist is the dead-button pattern again.
  const studio = source.slice(source.indexOf('function InitiativeStudio('));
  assert.match(studio, /selected\?\.state\.phaseOrder\?\.includes\(stage\)\) return void openPlanning\?\.\(stage\)/);
  assert.match(studio, /!epicStage && selected\?\.state\.phaseOrder\?\.includes\(phaseId\)\) return void openPlanning\?\.\(phaseId\)/);

  // ...and that workspace is the phase's own. Requirements, Planning and Create Stories are pages
  // about the Epic-planning phases — EpicPlanningPage is hard-wired to epic-plan, heading and
  // 'locked until Requirements is approved' notice included — so routing 'discover-define' there
  // opened Planning for a phase the Epic does not have.
  const openStudio = source.slice(source.indexOf('function openStudio('), source.indexOf('function acceptPortfolioBootstrap('));
  assert.match(openStudio, /phase && !phase\.startsWith\('epic-'\) \? 'phase' : 'business-planning'/);
  assert.match(source, /page === 'phase' && \(data\.initiative && planningFocus\?\.phase/);
  assert.match(source, /<PhaseWorkspace requestedPhaseId=\{planningFocus\.phase\}/);
});

test('an Epic that already exists is opened from the wizard, not started again', async () => {
  // Selecting an Epic that already had a branch called epic:start, which fails with "KAN-8 already
  // exists. Use singularity-flow initiative resume KAN-8." — a CLI command the desktop has no way
  // to run, printed as a raw IPC error. The resume path already existed as initiative:open; the
  // wizard simply never offered it.
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const wizard = source.slice(source.indexOf('function EpicStartWizard('), source.indexOf('function InitiativeStudio('));
  assert.match(wizard, /const startedEpics = new Map\(\(data\.initiatives \?\? \[\]\)\.map/);
  // The start action is withheld, so the engine's refusal is never reached from here.
  assert.match(wizard, /&& !alreadyStarted/);
  assert.match(wizard, /alreadyStarted \? <button className="primary" onClick=\{\(\) => openEpic\(alreadyStarted\.id\)\}>Open \{alreadyStarted\.id\}<\/button>/);
  // openEpic is declared in App, so it reaches the wizard as a prop or not at all.
  assert.match(source, /function EpicStartWizard\(\{[^}]*\bopenEpic\b/);
  for (const render of source.match(/<EpicStartWizard\b[^>]*\/>/g) ?? []) assert.match(render, /openEpic=\{openEpic\}/);
});

test('no DOM handler is bound bare to a function whose first argument crosses IPC', async () => {
  // `onClick={handler}` hands the handler a React SyntheticEvent. When that handler's first
  // parameter is a repository path or a file list rather than an event, the event travels to
  // ipcRenderer.invoke and dies in structured clone as 'An object could not be cloned.' — a
  // message that names neither the button nor the argument. It cost two buttons: 'Generate world
  // model' (reported as a world-model build failure at 0m00s) and '＋ Add source'.
  const source = await readFile(path.join(packageRoot, 'apps/desktop/src/App.jsx'), 'utf8');
  const eventNames = new Set(['event', 'e', '_event', '_']);
  // Resolve each handler inside its own component. Two components declare a `loadEpics`, and a
  // prop can share a name with a function declared in App; matching the first declaration in the
  // file flags both as offenders and the guard becomes noise nobody keeps.
  const components = [...source.matchAll(/^(?:export default )?function [A-Za-z]/gm)].map((match) => match.index);
  const blockOf = (index) => {
    const start = components.filter((position) => position <= index).pop() ?? 0;
    const end = components.find((position) => position > index) ?? source.length;
    return source.slice(start, end);
  };
  const offenders = [];
  for (const match of source.matchAll(/on(Click|Change|Submit|Input|KeyDown|Blur|Focus)=\{([A-Za-z_$][\w$]*)\}/g)) {
    const [, prop, name] = match;
    const declaration = blockOf(match.index).match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)|const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(([^)]*)\\)\\s*=>`));
    if (!declaration) continue; // A prop: it defends itself where it is defined.
    const first = (declaration[1] ?? declaration[2] ?? '').split(',')[0].trim().split(/[=\s]/)[0];
    if (first && !eventNames.has(first)) offenders.push(`on${prop}={${name}} → ${name}(${first}, …)`);
  }
  assert.deepEqual(offenders, [], `bind these with an arrow that passes no event: ${offenders.join(', ')}`);

  // Defence at the definitions too, since a future call site can reintroduce it.
  assert.match(source, /const filePaths = Array\.isArray\(paths\) \? paths : null/);
  assert.match(source, /typeof repositoryOrLocal === 'boolean' \? repositoryOrLocal : true/);
});

test('Copilot Studio releases the previous session when the governed context is rebuilt', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const build = source.slice(source.indexOf('async function buildContext()'), source.indexOf('async function startCopilot()'));

  // Rebuilding mints a new sessionId. If the connection state survives it, 'Start Copilot Plan
  // mode' stays disabled (it is gated on started), the Frame stays locked, and the session-id
  // guard drops every event — the studio reads 'connected' and does nothing at all.
  assert.match(build, /stopPlanningSession/);
  assert.match(build, /setStarted\(false\)/);
  assert.match(build, /setRunning\(false\)/);

  // Switching the selected work item must clear running too: it gates the build button, so a
  // turn in flight at that moment would otherwise lock every control on the page.
  const switchEffect = source.slice(source.indexOf("const selectedPhase = selected.phases.find"), source.indexOf('[data.selectedWorkId, data.selectedInitiativeId]'));
  assert.match(switchEffect, /resetSession\(\)/);
  assert.doesNotMatch(switchEffect, /setStarted\(false\);\s*\}/);
});

test('a hand-off frames Copilot Studio on the phase it came from, and the sidebar does not', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');

  // The studio serves every phase, so arriving from a phase screen must carry that phase across.
  assert.match(source, /function openStudio\(phase = null, target = null\)/);
  assert.match(source, /setPlanningFocus\(phase \? \{ phase, target \} : null\)/);
  assert.match(source, /focus=\{planningFocus\}/);
  // Requirements and Planning both own the shared workspace, framed on whatever phase the
  // initiative is actually on, rather than handing off to the studio.
  assert.match(source, /focus: \{ phase: activePhaseId \}/);
  assert.match(source, /openPlanning\('epic-plan'\)/);
  assert.match(source, /openPlanning\('epic-plan'\)/);
  assert.match(source, /openPlanning\(phases\[0\]\)/);

  // Reaching the studio from the sidebar clears a previous hand-off instead of re-framing it.
  assert.match(source, /id === 'planning' \? openStudio\(\) :/);

  // The work-selection effect also runs on mount, so it must resolve the focused phase rather
  // than currentPhase — otherwise it immediately overwrites the framing the caller asked for.
  const effect = source.slice(source.indexOf('const available = data.planning?.targets'), source.indexOf('[data.selectedWorkId, data.selectedInitiativeId]'));
  assert.match(effect, /focusPhase \?\? selected\.currentPhase/);

  // A stale link must not frame a phase this group does not have.
  assert.match(source, /defaultGroup\?\.phases\.some\(\(item\) => item\.id === focus\.phase\)/);

  // Buttons must pass a phase, never the click event.
  assert.doesNotMatch(source, /onClick=\{openPlanning\}/);
});

test('the Epic workspace can reach the Epic list, and an imported Jira Epic is visible', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');

  // Selecting an Epic replaces EpicsHome with the workspace, so the list, "Fetch latest" and the
  // start wizard were only reachable by blanking the top-bar Epic selector.
  assert.match(source, /function showAllEpics\(intent = null\)/);
  assert.match(source, /onAllEpics=\{showAllEpics\}/);
  assert.match(source, /← All Epics/);
  assert.match(source, /＋ New Epic/);
  // "New Epic" must land on the wizard, not the list.
  assert.match(source, /startNew=\{epicIntent === 'new'\}/);
  assert.match(source, /useState\(Boolean\(startNew\)\)/);
  // The old prop was passed but never accepted by EpicsHome.
  assert.doesNotMatch(source, /startEpic=\{/);

  // epic:start pins the whole Jira issue into initiative state; nothing rendered it, so an Epic
  // imported from Jira appeared empty in the app while its content sat in governed state.
  assert.match(source, /function ImportedEpicView/);
  assert.match(source, /source\.type !== 'jira'/);
  assert.match(source, /source\.description/);
  assert.match(source, /source\.acceptanceCriteria/);
  assert.match(source, /is not refreshed automatically/);
  // Intake shows it inline; the Requirements workspace keeps it collapsed above the panes, since
  // requirements are derived from it and deleting the old screen would otherwise have lost it.
  assert.equal(source.split('<ImportedEpicView selected={selected} />').length - 1, 2);
});

test('Requirements is a dedicated phase page and explains sequence locks', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const workspace = source.slice(source.indexOf('function PhaseWorkspace('), source.indexOf('function PhaseGovernance('));

  // Requirements owns one phase; it must not silently switch to Intake or Planning based on the
  // currently selected Epic.
  assert.match(workspace, /requestedPhaseId = null/);
  assert.match(workspace, /const activePhaseId = requestedPhaseId \?\? selected\.state\.currentPhase \?\? 'epic-intake'/);
  assert.match(workspace, /focus: \{ phase: activePhaseId \}/);
  assert.match(source, /<PhaseWorkspace requestedPhaseId="epic-requirements"/);
  assert.match(workspace, /phaseIsCurrent/);
  assert.match(workspace, /phase-lock notice/);

  // A blocking checklist item stops the phase advancing, so it belongs on the screen rather than
  // in the error of whatever command the user tries next.
  assert.match(workspace, /blockingChecks/);
  assert.match(workspace, /check\.requirement === 'must' && check\.status !== 'satisfied'/);
  assert.match(workspace, /cannot be approved yet/);
});

test('publication waits on required outputs only, and says which ones', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const governance = source.slice(source.indexOf('function PhaseGovernance('), source.indexOf('function EpicsHome('));

  // The engine reports a missing output only when definition.required, so demanding every output
  // here made the button stricter than the gate it represents.
  assert.match(governance, /const requiredOutputs = outputs\.filter\(\(output\) => output\.required !== false\)/);
  assert.match(governance, /requiredOutputs\.every\(\(output\) => output\.sha256 && output\.status === 'draft'\)/);

  // A disabled primary action must say what it is waiting for; "not active" with no reason is the
  // complaint that prompted this.
  assert.match(governance, /pendingRequired/);
  assert.match(governance, /Waiting on \$\{pendingRequired\.length\}/);
  assert.match(governance, /title=\{!persona \? 'Select a persona first\.'/);
});

test('a blocked approval says which field is missing, and the strip does not mislabel navigation', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const governance = source.slice(source.indexOf('function PhaseGovernance('), source.indexOf('function EpicsHome('));

  // A disabled primary button with its reason in help text above reads as "nothing works". Publish
  // already explained itself; approval did not, which is what made intake look broken.
  assert.match(governance, /const approvalBlocker =/);
  assert.match(governance, /Select your review persona first/);
  assert.match(governance, /in the confirmation field to approve this exact document set/);
  // A typo and an empty field are different user problems and must not share one message.
  assert.match(governance, /The confirmation phrase does not match/);
  assert.match(governance, /disabled=\{Boolean\(approvalBlocker\)\}/);
  assert.match(governance, /title=\{approvalBlocker \?\? undefined\}/);
  assert.match(governance, /className="field-error"/);

  // The strip's approve and evidence actions scroll to the governance panel; labelling them
  // "Approve" claimed they decided something.
  assert.match(source, /\[NEXT_ACTIONS\.APPROVE\]: 'Go to approval'/);
  assert.match(source, /\[NEXT_ACTIONS\.EVIDENCE\]: 'Go to evidence'/);
});

test('journey actions dispatch on one vocabulary, and an unmapped action is reported', async () => {
  const source = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');

  // The dispatch compared a mix of canonical and legacy names, so 'approve-phase' matched no branch
  // and fell through to a fallback that navigated to the current stage — a clickable button that
  // changed nothing. Every id is now normalized once before any comparison.
  assert.match(source, /const actionId = normalizeNextActionId\(next\.action \?\? next\.id\)/);
  assert.doesNotMatch(source, /actionId === 'prepare'/);
  assert.doesNotMatch(source, /actionId === 'author-and-publish'/);

  // The fallthrough must surface an unwired action instead of absorbing it.
  const journey = source.slice(source.indexOf('function continueEpicJourney('), source.indexOf('function continueEpicJourney(') + 1400);
  assert.match(journey, /No action is wired for/);
  assert.match(journey, /Nothing was changed/);
  assert.doesNotMatch(journey, /next\?\.id === 'materialize'/);
});

test('the confirmation placeholder never impersonates the value it is asking for', async () => {
  // A placeholder equal to the required phrase makes an empty field look correctly filled: the
  // reviewer sees `epic-intake:phase` sitting in the box, believes the step is done, and reads the
  // disabled button as a broken app. The phrase belongs in the help text only.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const placeholders = [...app.matchAll(/placeholder=\{`\$\{phaseId\}:phase`\}/g)];
  assert.equal(placeholders.length, 0, 'the confirmation placeholder must not echo the required phrase');
  // ...and the phrase must still be shown somewhere, or it is unguessable.
  assert.match(app, /Enter <code>\{phaseId\}:phase<\/code>/);
});

test('the reason a phase cannot be approved renders beside the field it refers to', async () => {
  // The blocker used to render in a column to the right of the button, far from the input it names.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const field = app.indexOf('Type the confirmation phrase');
  const blocker = app.indexOf('field-error', field);
  assert.ok(blocker > field && blocker - field < 800, 'blocker must render inside the confirmation label');
});

test('the Epic journey is drawn once, from the engine resolution', async () => {
  // Three components each rendered Intake → Requirements → Planning, two of them re-deriving phase
  // status inline. That is how the same stage came to be called "Intake" in one rail and "Sources"
  // in the next. Only EpicJourneyRail, fed by the engine's own journey, survives.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.doesNotMatch(app, /epic-lifecycle-wizard/);
  assert.doesNotMatch(app, /requirements-output-map/);
  assert.doesNotMatch(app, /wizardSteps/);
  assert.equal([...app.matchAll(/<EpicJourneyRail/g)].length, 2, 'one rail per workspace, no more');
  // Removing the wizard removed the only route to Configuration; it must still be reachable.
  assert.match(app, /⚙ Configuration/);
});

test('the Epic workspace rail dispatches on the same vocabulary as the phase workspace', async () => {
  // This was a second copy of the dispatch defect: it compared legacy ids, so canonical 'publish'
  // and 'approve' matched nothing and fell through to a fallback that navigated to the stage
  // already open — a button that changed nothing, exactly as before.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const fn = app.slice(app.indexOf('function continueJourney('), app.indexOf('function continueJourney(') + 1400);
  assert.match(fn, /normalizeNextActionId\(next\?\.action \?\? next\?\.id\)/);
  assert.doesNotMatch(fn, /'author-and-publish'/);
  assert.doesNotMatch(fn, /'prepare'/);
  assert.match(fn, /No action is wired for/);
});

test('the phase workbench shows what the phase owes before any session starts', async () => {
  // outputs came only from a built context pack, so the artifacts pane read "nothing to produce"
  // until Copilot had already been engaged. The phase resolution knows them from the start.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /contextPack\?\.outputs\s*\n\s*\?\? selected\.state\.resolution\?\.phases/);
  // Cards are grouped by the states the engine records, never by an invented one.
  assert.match(app, /const artifactGroups = useMemo/);
  for (const label of ['Proposed in this session', 'Draft', 'Approved', 'Not generated yet']) {
    assert.ok(app.includes(label), `artifact group '${label}' must exist`);
  }
});

test('the composer honours the shortcut it advertises', async () => {
  // A hint that says "Shift + Enter for a new line" is a lie unless plain Enter actually sends.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /Shift \+ Enter for a new line/);
  assert.match(app, /if \(event\.key !== 'Enter' \|\| event\.shiftKey\) return;/);
  assert.match(app, /if \(started && !running && followup\.trim\(\)\) void sendFollowup\(\);/);
});

test('icon tiles use a short type tag, not truncated prose', async () => {
  // documentKind returns "Markdown", which truncates to "Mar"; an output's kind is a type name and
  // not a file name, so neither source works on its own.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /function kindTag\(/);
  // The tiles themselves must go through kindTag; kindTag's own last-resort truncation is fine.
  assert.match(app, /className="source-icon"[^>]*>\{kindTag\(/);
  assert.match(app, /className="artifact-icon"[^>]*>\{kindTag\(/);
  assert.equal([...app.matchAll(/documentKind\([^)]*\)\.slice\(0, 3\)/g)].length, 1, 'only kindTag may truncate');
});

test('the governed contract is sent to Copilot, not pointed at', async () => {
  // Plan mode declares fs.readTextFile: false and denies every session/requestPermission, so a
  // prompt saying "read the contract at <path>" asked Copilot for the one thing the client forbids.
  // The observable symptom was a copilot.permission-denied for "Read governed planning contract"
  // and a turn that ran with no contract, no pinned sources and no world model.
  const main = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'main.mjs'), 'utf8');
  assert.doesNotMatch(main, /Read and follow the complete governed planning contract at/);
  assert.match(main, /await readFile\(pack\.contextPath, 'utf8'\)/);
  assert.match(main, /Follow the governed planning contract above/);

  // The guarantee that matters is that Copilot cannot change anything of its own accord. Reads
  // were later allowed deliberately — see 'read-only Plan mode denies writes, not reads' — and a
  // mode switch was added later still, but the client never writes, and Plan mode still refuses.
  const acp = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'copilot-acp.mjs'), 'utf8');
  assert.match(acp, /writeTextFile: false/);
  const decide = acp.slice(acp.indexOf('decidePermission(params) {'), acp.indexOf('answerPermission(requestId'));
  assert.match(decide, /if \(this\.inPlanMode\(\)\) \{[\s\S]*?return rejectPermission\(params\);/);
});

test('a human-approved check can be attested from the app', async () => {
  // material-questions-resolved is human-approved only and had no recording path anywhere in the
  // desktop: no IPC channel, no control. The phase could never be approved without the CLI.
  const preload = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'preload.cjs'), 'utf8');
  assert.match(preload, /recordInitiativeEvidence:/);
  assert.match(preload, /'initiative:evidence-record'/);

  const main = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'main.mjs'), 'utf8');
  const handler = main.slice(main.indexOf("trustedHandle('initiative:evidence-record'"));
  // Same shape as `initiative evidence add`: register, reload, commit append-only.
  assert.match(handler.slice(0, 1800), /assurance: 'human-approved'/);
  assert.match(handler.slice(0, 1800), /appendOnly: true/);
  // Authorization belongs to the engine; the handler must not decide who may attest.
  assert.doesNotMatch(handler.slice(0, 1800), /isAuthorized|allowSelfApproval/);
});

test('only checks that accept a human judgement are offered for attestation', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // acceptedAssurance lives on the pinned per-initiative resolution, not the phase-state
  // projection; reading it from state would have meant a second, drifting source of truth.
  assert.match(app, /selected\.state\.resolution\?\.phases\?\.find\(\(item\) => item\.id === phaseId\)\?\.checklist/);
  assert.match(app, /acceptedAssurance\?\.includes\('human-approved'\)/);
  // An attestation with no reasoning is not evidence.
  assert.match(app, /disabled=\{!attestation\.trim\(\)\}/);
  // The phase guard must run before anything dereferences phase.checklist.
  assert.ok(app.indexOf('if (!phase) return null;') < app.indexOf('Object.values(phase.checklist'),
    'the !phase guard must precede the checklist read');
});

test('required artifacts are never labelled optional', async () => {
  // A planning context pack's outputs carry only id/label/kind/path. Reading `required` off them
  // printed "Optional" for a required artifact — the phase resolution is the authority.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /const requiredOutputIds = useMemo/);
  assert.match(app, /requiredOutputIds\.has\(output\.id\) \? 'Required/);
  assert.doesNotMatch(app, /output\.required \? 'Required/);
});

test('read-only Plan mode denies writes, not reads', async () => {
  // The handler used to reject every session/requestPermission without inspecting it, and declare
  // fs.readTextFile: false. Copilot could emit text and nothing else: every turn ended within
  // seconds at its first tool call, so no requirement could be grounded in the code it describes.
  const acp = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'copilot-acp.mjs'), 'utf8');
  assert.match(acp, /const READ_ONLY_TOOL_KINDS = new Set\(\['read', 'search', 'think'\]\)/);
  assert.match(acp, /if \(isReadOnlyToolCall\(toolCall\)\)/);
  // Writing stays impossible; promotion remains the only write path.
  assert.match(acp, /fs: \{ readTextFile: true, writeTextFile: false \}/);
  // The agent's own prose must never decide policy — only the declared kind does.
  assert.match(acp, /return READ_ONLY_TOOL_KINDS\.has\(toolCall\?\.kind\)/);
});

test('a governed read cannot escape the repository', async () => {
  // Containment is decided on the real path so a symlink inside the repository cannot be used to
  // reach ~/.ssh. Verified behaviourally below; this pins the implementation choice.
  const acp = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'copilot-acp.mjs'), 'utf8');
  const fn = acp.slice(acp.indexOf('async readRepositoryFile('), acp.indexOf('async readRepositoryFile(') + 1400);
  assert.match(fn, /const root = await realpath\(this\.repository\)/);
  assert.match(fn, /const resolved = await realpath\(requested\)/);
  assert.match(fn, /relative\.startsWith\('\.\.'\)/);
  assert.match(fn, /path\.isAbsolute\(requested\)/);

  const { CopilotPlanningBridge } = await import(pathToFileURL(path.join(packageRoot, 'apps', 'desktop', 'electron', 'copilot-acp.mjs')).href);
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'acp-fs-'));
  await mkdir(path.join(base, 'repo', 'sub'), { recursive: true });
  await mkdir(path.join(base, 'outside'), { recursive: true });
  await writeFile(path.join(base, 'repo', 'sub', 'ok.txt'), 'inside');
  await writeFile(path.join(base, 'outside', 'secret.txt'), 'SECRET');
  await symlink(path.join(base, 'outside', 'secret.txt'), path.join(base, 'repo', 'escape.txt'));
  const bridge = new CopilotPlanningBridge({ repository: path.join(base, 'repo'), emit: () => {} });

  assert.equal((await bridge.readRepositoryFile({ path: path.join(base, 'repo', 'sub', 'ok.txt') })).content, 'inside');
  for (const escape of [
    path.join(base, 'repo', 'escape.txt'),
    path.join(base, 'repo', '..', 'outside', 'secret.txt'),
    path.join(base, 'outside', 'secret.txt')
  ]) {
    await assert.rejects(() => bridge.readRepositoryFile({ path: escape }), /only read files inside the open repository/);
  }
  await assert.rejects(() => bridge.readRepositoryFile({ path: 'sub/ok.txt' }), /only read absolute paths/);
});

test('starting a session and sending a message are not both called Send', async () => {
  // Two buttons labelled "Send" sat on one screen: one handed the governed context over and started
  // the session, the other was an ordinary chat send. The chat pair was also rendered disabled
  // before a session existed, so the screen offered a Stop with nothing to stop.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Was "Start Copilot with this context" — the second of two start buttons, now collapsed into one.
  assert.match(app, /Start with Copilot/);
  assert.doesNotMatch(app, />Send to Copilot</);
  // The chat controls exist only once there is a session to talk to, and Stop now halts the turn
  // rather than discarding the session — those are different intents with different buttons.
  assert.match(app, /\{started && <div className="row">/);
  assert.match(app, /onClick=\{interruptTurn\} title="Halt the current turn; the conversation stays">Stop</);
  assert.match(app, /onClick=\{stopCopilot\} title="Discard this session and release Copilot">End session</);
  // And the inert box says what to do instead of inviting typing that goes nowhere.
  assert.match(app, /Start Copilot above to begin the conversation/);
  assert.match(app, /Start Copilot with the governed context first/);
});

test('initiative-scoped actions do not clear the selected work item', async () => {
  // reload(null, id) cleared data.selectedWorkId, which the session hook watches; the reset wiped
  // contextPack, messages, plan and questions. So approving an artifact, pinning a source or
  // publishing destroyed the conversation that produced them.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  const workspace = app.slice(app.indexOf('function PhaseWorkspace('), app.indexOf('function PhaseGovernance('));
  assert.doesNotMatch(workspace, /reload\(null,/);
  const governance = app.slice(app.indexOf('function PhaseGovernance('), app.indexOf('function EpicsHome('));
  assert.doesNotMatch(governance, /reload\(null,/);
});

test('a planning context whose repository moved says so before promotion fails', async () => {
  // Promotion refuses a pack whose HEAD has moved, and pinning a source or recording evidence both
  // commit — so the conversation was silently unpromotable, discovered only after the work was done.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /const contextStale = Boolean\(contextPack && data\.repository\.head/);
  assert.match(app, /This context is out of date/);
  assert.match(app, /Rebuild context/);
  // The comparison needs HEAD on the snapshot, which it did not carry.
  const desktop = await readFile(path.join(packageRoot, 'src', 'desktop.mjs'), 'utf8');
  assert.match(desktop, /head: head\(root\)/);
});

test('shared planning constants stay free of node built-ins', async () => {
  // Importing src/planning.mjs into the renderer pulled node:crypto into the browser bundle; the
  // production build passed and it broke only at runtime. The renderer shares the constants through
  // a module with no imports at all.
  const scope = await readFile(path.join(packageRoot, 'src', 'planning-scope.mjs'), 'utf8');
  assert.doesNotMatch(scope, /^import /m);
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /from '\.\.\/\.\.\/\.\.\/src\/planning-scope\.mjs'/);
  assert.doesNotMatch(app, /from '\.\.\/\.\.\/\.\.\/src\/planning\.mjs'/);
});

test('the evidence pane can attach, open and count what is citable', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Files could only arrive through an OS dialog; nothing accepted a drop.
  assert.match(app, /onDrop=\{dropSources\}/);
  assert.match(app, /window\.singularity\?\.pathForFile/);
  // A pinned source was a dead card — no way to see what had been attached.
  assert.match(app, /onOpen=\{\(\) => openSource\(source\.sourceId\)\}/);
  // The rail counted uploads only, so it read "nothing pinned" while the contract told Copilot to
  // cite the imported Epic. The snapshot is now shown with the id traceability accepts.
  assert.match(app, /\{citableCount\} citable/);
  assert.match(app, /jiraSnapshot && <SourceCard/);
  // "Pin one above" had no control behind it.
  assert.match(app, /Pin all as evidence/);

  const main = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'main.mjs'), 'utf8');
  // One commit for a whole selection: every commit moves HEAD, and a moved HEAD invalidates any
  // planning context already built.
  const upload = main.slice(main.indexOf("trustedHandle('epic:sources-upload'"), main.indexOf("trustedHandle('epic:sources-pin-jira'"));
  assert.equal([...upload.matchAll(/commitInitiativeChange\(/g)].length, 1, 'a multi-file upload must be one commit');
  assert.match(upload, /mimeTypeForFile\(filePath, mimeType\)/);
  // Reading a source must be contained exactly as the ACP reader is.
  const preview = main.slice(main.indexOf("trustedHandle('epic:sources-preview'"));
  assert.match(preview.slice(0, 2200), /Refusing to read a source outside the governed cache/);
  assert.match(preview.slice(0, 2200), /realpath/);
});

test('a stray file drop cannot navigate the app away', async () => {
  // Electron replaces the renderer with a dropped file's contents, losing every bit of in-memory
  // state. Adding a drop target makes a near-miss much more likely.
  const main = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'main.jsx'), 'utf8');
  assert.match(main, /for \(const type of \['dragover', 'drop'\]\)/);
  assert.match(main, /closest\('\[data-accepts-drop\]'\)/);
});

test('the contract says what Copilot can actually read', async () => {
  // A pinned binary was described as "read the exact cached file", which Copilot does as UTF-8 —
  // so it read mojibake and could invent from it. Each source now states whether it is readable,
  // and an unreadable one is explicitly not to be guessed at.
  const context = await readFile(path.join(packageRoot, 'src', 'initiative-context.mjs'), 'utf8');
  assert.match(context, /Readable text/);
  assert.match(context, /\*\*not readable as text\*\*/);
  assert.match(context, /Record what you need from it as an open question rather than inventing a requirement/);
  assert.match(context, /export const TEXT_RENDITION_SUFFIX/);

  // The engine must not grow a document parser: it has one dependency and the gate asserts so.
  const enginePackage = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(enginePackage.dependencies ?? {}), ['yaml']);
  const extractor = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'source-text.mjs'), 'utf8');
  assert.match(extractor, /from 'node:zlib'/);
  assert.doesNotMatch(extractor, /require\(|from '(?!node:)/);

  // The rendition is derived once, at pin time, beside the cached bytes.
  const main = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'main.mjs'), 'utf8');
  assert.match(main, /await writeSourceRenditions\(root, initiativeId, records\)/);
});

test('the conversation is readable, anchored, and shows its own diagnostics', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Copilot's replies were raw <pre>; the renderer already had a markdown renderer used elsewhere.
  assert.match(app, /\? <TemplatePreview content=\{visible\.text\} \/>/);
  // A whole fenced specification inside the transcript buries the reasoning it exists to capture.
  assert.match(app, /function stripArtifactFences/);
  assert.match(app, /artifacts? proposed — review them in Artifacts|artifact\{visible\.stripped === 1/);
  // Streamed text scrolled out of view and never came back; anchoring must yield to a reader.
  assert.match(app, /stickToBottom\.current = node\.scrollHeight - node\.scrollTop - node\.clientHeight < 40/);
  // The turn-complete fallback told the user to open a log panel this screen did not render.
  assert.match(app, /usage, logs, setLogs,/);
  assert.match(app, /Copilot activity \(\{logs\.length\}\)/);
});

test('chat styling is not defeated by the rules it replaced', async () => {
  const styles = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'styles.css'), 'utf8');
  // .requirements-messages > div (0,1,1) out-specified .chat-turn (0,1,0), so every turn rendered
  // as a grid and the avatar stacked above the bubble.
  assert.doesNotMatch(styles, /\.requirements-messages > div \{/);
  // The role-label rule, unscoped, turned every bold word in a rendered message into a block.
  assert.doesNotMatch(styles, /^\.chat-bubble strong \{ display: block/m);
  assert.match(styles, /\.chat-bubble > header strong \{ display: block/);
  // .requirements-workspace{height:100%} against an auto-height parent resolved to auto, so the
  // panes never scrolled independently.
  assert.match(styles, /\.page-stage:has\(> \.requirements-workspace\) \{ height: 100%; \}/);
});

test('a proposed artifact can be read in full, edited, and diffed before it is written', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Review was a 300px monospace box inside a 330px column — unusable for a specification.
  assert.match(app, /Open full size · review &amp; edit/);
  // The edited copy is what gets promoted; `proposed` is derived from the transcript and cannot be
  // the thing you edit.
  assert.match(app, /for \(const \[id, value\] of Object\.entries\(edits\)\) if \(merged\.has\(id\) && value\.trim\(\)\) merged\.set\(id, value\)/);
  // A new proposal supersedes edits made against the previous one.
  assert.match(app, /useEffect\(\(\) => \{ setEdits\(\{\}\); setReviewed\(false\); \}, \[plan\]\)/);
  // Writing and pushing is not something to do by reflex.
  assert.match(app, /disabled=\{!proposed\.size \|\| !reviewed \|\| promoting \|\| running\}/);
  // A diff needs a committed generation to compare against; the snapshot already carries its text,
  // so no extra IPC was added for it.
  assert.match(app, /committed\?\.content\s*\n\s*\? <DiffEditor/);
  assert.match(app, /import Editor, \{ DiffEditor \} from '@monaco-editor\/react'/);
});

test('one Requirements screen, reachable the same way from either route', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Which UI you got depended on how you arrived: the journey rail set a tab and opened
  // EpicRequirementsView, while the sidebar opened PhaseWorkspace — same phase, unrelated screens.
  assert.doesNotMatch(app, /EpicRequirementsView/);
  assert.match(app, /if \(onStagePage && \['requirements', 'planning', 'stories'\]\.includes\(stage\)\) return void onStagePage\(stage\)/);
  assert.match(app, /onStagePage=\{openEpicJourneyStage\}/);
  // Nothing the deleted screen uniquely offered may be lost: the full source surface and the
  // imported Jira Epic both survive in the workspace.
  assert.match(app, /Manage providers, credentials and URL sources/);
  assert.match(app, /<EpicSourcesView data=\{data\} selected=\{selected\} action=\{action\} reload=\{reload\} \/>\s*<\/details>/);
  assert.match(app, /Imported Jira Epic — the source these requirements derive from/);
});

test('the Requirements workspace layout does not depend on how many children it has', async () => {
  // It was a two-row grid rendering six children, so everything after the second landed in an
  // implicit row. That was invisible while height:100% resolved to auto against an auto-height
  // parent; closing the height chain made the rows collapse and draw over one another — the rail,
  // the next-action strip and the gate all overlapped. A column cannot regress that way.
  const styles = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'styles.css'), 'utf8');
  assert.match(styles, /\.requirements-workspace \{ display: flex; flex-direction: column;/);
  assert.doesNotMatch(styles, /\.requirements-workspace \{ display: grid; grid-template-rows/);
  assert.match(styles, /\.requirements-workspace > \.requirements-panes \{ flex: 1 1 auto; min-height:/);
});

test('every surface that starts Copilot work warns when Copilot cannot run it', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Preflight was read separately by each component and only at mount, so Copilot dying while the
  // app was open went unnoticed. One check, refreshed when the window regains focus.
  assert.match(app, /const refreshCopilotHealth = React\.useCallback/);
  assert.match(app, /window\.addEventListener\('focus', onFocus\)/);

  // The world-model build shells out to `copilot` for minutes and never consulted preflight at all;
  // it failed at the end for a reason knowable at the start.
  const generate = app.slice(app.indexOf('async function generateWorldModel(repositoryOrLocal'));
  assert.match(generate.slice(0, 1200), /const health = await refreshCopilotHealth\(\)/);
  assert.match(generate.slice(0, 1200), /Copilot is not available/);

  // One banner, worded once, on each surface where Copilot work can start.
  assert.match(app, /function CopilotUnavailable\(/);
  assert.equal([...app.matchAll(/<CopilotUnavailable/g)].length, 4);
  // It distinguishes "not installed" from "installed but the wrong build" instead of one vague line.
  assert.match(app, /health\.installed === false/);
  assert.match(app, /health\.acp === false \|\| health\.planMode === false/);
});

test('a Copilot session that dies mid-turn says so', async () => {
  // process-exit set started=false and said nothing, so the screen reverted to "Not started" with
  // no reason and no way to tell it from never having begun.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /Copilot stopped unexpectedly \(exit/);
  assert.match(app, /The conversation is kept; start again to continue/);
  assert.match(app, /onCopilotLost\?\.\(\)/);
});

test('starting a Copilot session is one action', async () => {
  // Building the context and starting the session were two clicks on two differently-named buttons
  // in two places, and the second appeared above the first after the first was pressed. Nothing
  // useful happened between them.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /async function beginSession\(\)/);
  assert.match(app, /const pack = await buildContext\(\);/);
  assert.doesNotMatch(app, /Start Copilot with this context/);
  // buildContext returned nothing, so a caller had to wait a render for contextPack.
  assert.match(app, /\s+return result;\n  \}/);
});

test('the journey rail does not offer the screen the user is standing on', async () => {
  // It rendered "Open Requirements workspace" inside the Requirements workspace, duplicating the
  // next-action strip directly beneath it.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /const ownedHere = Boolean\(ownsPhase && journey\.nextAction\?\.phaseId === ownsPhase\)/);
  assert.match(app, /ownedHere \? `You are here/);
  assert.match(app, /ownsPhase=\{phaseId\}/);
});

test('a question from Copilot takes over, and answering always releases it', async () => {
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // Inline in a scrolling transcript, the one thing blocking the turn was the easiest to miss.
  assert.match(app, /className="modal-backdrop copilot-ask"/);
  assert.match(app, /Copilot needs an answer to continue/);
  const workspace = app.slice(app.indexOf('function PhaseWorkspace('), app.indexOf('function PhaseGovernance('));
  assert.doesNotMatch(workspace, /className="copilot-question-stack"/);
  // The native branch left status pending and waited for a question-answered event. As a blocking
  // modal, a dropped event would leave an un-dismissable dialog over the whole screen.
  const answer = app.slice(app.indexOf('async function answerQuestion('), app.indexOf('async function dismissQuestion('));
  assert.match(answer, /item\.id === question\.id \? \{ \.\.\.item, status: 'accept' \}/);
});

test('the composer offers the work this phase actually asks for', async () => {
  // A blank box meant every turn began by inventing wording for work the phase contract already
  // describes; the command names the artifacts this phase owes rather than a generic list.
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /function phaseCommands\(outputs = \[\]\)/);
  for (const id of ['draft', 'gaps', 'trace', 'challenge', 'tighten']) {
    assert.ok(app.includes(`id: '${id}'`), `command '${id}' missing`);
  }
  // Choosing one fills the box so it can be edited, rather than firing text the user never read.
  assert.match(app, /onClick=\{\(\) => \{ setFollowup\(command\.prompt\); \}\}/);
});

test('a context that carries no world model says so', async () => {
  // Grounding "off" returned an empty string and no warning, so Copilot was asked to write
  // requirements about a repository it had been told nothing about — and then reached for shell
  // tools to look, which read-only Plan mode denies. The denial was the symptom; the silence was
  // the defect.
  const context = await readFile(path.join(packageRoot, 'src', 'initiative-context.mjs'), 'utf8');
  assert.match(context, /world-model grounding is off for this initiative/);
  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  assert.match(app, /className="context-warnings"/);
  assert.match(app, /contextPack\.warnings\.map/);
});

test('the app can ask the world-model builder for the views its phases need', async () => {
  // `wm build` has always accepted --views. The desktop passed only --local, so a rebuild from the
  // app could only produce whatever `views: auto` routed to — with no task, core plus development —
  // and the business, architecture and security views the phases reference were never generated
  // however many times the user pressed the button.
  const main = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'main.mjs'), 'utf8');
  assert.match(main, /\.\.\.\(requested\.length \? \['--views', requested\.join\(','\)\] : \[\]\)/);
  // A view id reaches a command line, so it is validated rather than trusted.
  assert.match(main, /\/\^\[a-z\]\[a-z0-9-\]\*\$\/\.test\(view\)/);

  const preload = await readFile(path.join(packageRoot, 'apps', 'desktop', 'electron', 'preload.cjs'), 'utf8');
  assert.match(preload, /generateWorldModel: \(repository, local = true, views = null\)/);

  const app = await readFile(path.join(packageRoot, 'apps', 'desktop', 'src', 'App.jsx'), 'utf8');
  // The default selection is what the repository is actually asked for, not everything or nothing.
  assert.match(app, /data\.worldModel\.views\.filter\(\(view\) => \(view\.structuredReferences \?\? \[\]\)\.length\)/);
  assert.match(app, /generateWorldModel\?\.\(undefined, undefined, buildViews\)/);
});
