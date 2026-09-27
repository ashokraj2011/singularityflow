import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as onboarding from '../apps/vscode/src/views/repository-onboarding-model.ts';
import { EMPTY_MAP_FORM, gitRemoteProblem, mapCapabilityHtml } from '../apps/vscode/src/views/map-capability-form.ts';
import { sameGitRepository } from '../apps/vscode/src/repository-refresh-model.ts';

const panelSource = await readFile(new URL('../apps/vscode/src/views/bootstrap-panel.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('bootstrap-panel.ts', panelSource, ts.ScriptTarget.Latest, true);
const panelClass = ast.statements.find((node) => ts.isClassDeclaration(node) && node.name?.text === 'BootstrapPanel');
const names = new Set(['abortInspectionRead', 'beginInspectionRead', 'runInspection', 'invalidateInspection',
  'previewRepositorySetup', 'continueRepositorySetup', 'inspectCapabilityMapping', 'receive', 'dispose']);
const methods = panelClass.members.filter((node) => ts.isMethodDeclaration(node) && names.has(node.name.getText(ast)));
assert.equal(methods.length, names.size);
// Exercise exact production method bodies with a narrow host double, not a second implementation.
const output = ts.transpileModule(`class BootstrapPanel { ${methods.map((node) => node.getText(ast)).join('\n')} }
  globalThis.ReadHarness = BootstrapPanel;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const context = vm.createContext({ ...onboarding, gitRemoteProblem, sameGitRepository,
  AbortController, Set, Map, commandGuidance: () => null, formatCliArgsForDisplay: (args) => args.join(' ') });
vm.runInContext(output, context);

const repositoryUrl = 'https://git.example/application.git';
function rawPlan(changes = {}) {
  const commit = 'a'.repeat(40);
  return {
    schemaVersion: 1, kind: 'repository-onboarding-plan/v1',
    repository: { url: repositoryUrl, identity: `sha256:${'c'.repeat(64)}` },
    mode: 'auto', status: 'ready', primaryAction: 'continue',
    state: { kind: 'configuration-mirror', branch: 'state', commit },
    configuration: { branch: 'sflow/config', commit, status: 'current', schemaVersion: 1, currentSchemaVersion: 1 },
    observedRefs: { 'refs/heads/state': commit, 'refs/heads/sflow/config': commit },
    effects: [], preserved: ['application branches'], omitted: [], choices: [], availableModes: [],
    routing: null, organisation: null, canApply: false, planId: `sha256:${'b'.repeat(64)}`,
    nextActions: { shell: `singularity-flow capability onboard ${repositoryUrl} --dry-run --json`, copilot: '/sf-capability-map' },
    dryRun: true, ...changes
  };
}

function harness(run) {
  const panel = new context.ReadHarness();
  Object.assign(panel, {
    disposed: false, inspectionRevision: 0, inspectionController: null, mapLoadRevision: 0,
    inspectedOrganisations: new Map(), activeMapController: null, disposables: [], repositorySetupResult: null,
    form: { ...EMPTY_MAP_FORM, leads: [], metadata: [], repositoryUrl }, run,
    render() {}, update(changes) { this.form = { ...this.form, ...changes }; this.render(); },
    panel: { dispose() {} }
  });
  return panel;
}

test('Continue is host-guarded while checking and renders a disabled action for both preview and applied result', async () => {
  const plan = onboarding.parseRepositoryOnboardingPlan(rawPlan());
  assert.ok(plan);
  const panel = harness(async () => { throw new Error('checking must not launch another read'); });
  Object.assign(panel.form, { repositorySetupPlan: plan, inspectionStatus: 'checking' });
  await panel.continueRepositorySetup();
  const previewHtml = mapCapabilityHtml(panel.form);
  assert.match(previewHtml, /data-repository-setup-primary="continueRepositorySetup"[^>]*disabled/);
  panel.form.repositorySetupResult = { status: 'ready', localCleanupWarnings: [], nextActions: {} };
  assert.match(mapCapabilityHtml(panel.form), /data-repository-setup-primary="continueRepositorySetup"[^>]*disabled/);
});

test('automatic continuation is limited to readonly ready previews and never confirms planned effects', async () => {
  for (const changes of [
    {}, { status: 'ready-to-restore', primaryAction: 'restore-and-continue', canApply: true },
    { status: 'update-available', primaryAction: 'migrate-and-continue', canApply: true },
    { mode: 'reset-local', status: 'ready', primaryAction: 'continue' }
  ]) {
    const plan = rawPlan(changes);
    assert.ok(onboarding.parseRepositoryOnboardingPlan(plan));
    const calls = [];
    const panel = harness(async (argv, signal) => {
      calls.push({ argv, signal });
      return { result: argv[1] === 'onboard' ? plan : { status: 'inconclusive' }, error: null };
    });
    await panel.previewRepositorySetup('auto');
    const readonlyReady = onboarding.repositoryOnboardingCanContinue(onboarding.parseRepositoryOnboardingPlan(plan));
    assert.equal(calls.length, readonlyReady ? 2 : 1);
    assert.ok(calls[0].argv.includes('--dry-run'));
    assert.ok(calls.every(({ argv }) => !argv.includes('--confirm-plan')));
    if (readonlyReady) assert.equal(calls[1].argv[1], 'inspect-repository');
  }
  const calls = [];
  const maintenance = harness(async (argv) => { calls.push(argv); return { result: rawPlan(), error: null }; });
  maintenance.form.repositorySetupMaintenance = true;
  await maintenance.previewRepositorySetup('auto');
  assert.equal(calls.length, 1, 'maintenance does not silently enter capability mapping');
});

test('superseding an inspection aborts its subscriber and old completion cannot clear the new controller or publish', async () => {
  const reads = [];
  const panel = harness((argv, signal) => new Promise((resolve) => reads.push({ argv, signal, resolve })));
  const first = panel.inspectCapabilityMapping(repositoryUrl);
  const second = panel.inspectCapabilityMapping(repositoryUrl);
  assert.equal(reads.length, 2);
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(reads[1].signal.aborted, false);
  const current = panel.inspectionController;
  reads[0].resolve({ result: { status: 'already-mapped' }, error: null });
  await first;
  assert.equal(panel.inspectionController, current);
  assert.equal(panel.form.inspectionStatus, 'checking');
  reads[1].resolve({ result: { status: 'inconclusive' }, error: null });
  await second;
  assert.equal(panel.inspectionController, null);
  assert.equal(panel.form.inspectionStatus, 'inconclusive');
});

test('input change and panel disposal abort outstanding read work and reject its late UI result', async () => {
  for (const action of ['input', 'authority', 'collection', 'dispose']) {
    let pending;
    const panel = harness((_argv, signal) => new Promise((resolve) => { pending = { resolve, signal }; }));
    const read = panel.inspectCapabilityMapping(repositoryUrl);
    if (action === 'input') await panel.receive({ type: 'field', field: 'repositoryUrl', value: 'https://git.example/other.git' });
    if (action === 'authority') await panel.receive({ type: 'field', field: 'inspectionLeadUrl', value: 'https://git.example/other.git' });
    if (action === 'collection') await panel.receive({ type: 'toggleCollectionWithoutRepository' });
    if (action === 'dispose') panel.dispose();
    assert.equal(pending.signal.aborted, true, action);
    const before = panel.form.inspectionStatus;
    pending.resolve({ result: { status: 'already-mapped' }, error: null });
    await read;
    assert.equal(panel.form.inspectionStatus, before, `${action}: stale result published`);
  }
});

test('Continue refuses a plan bound to a previous repository even when its displayed status is ready', async () => {
  const panel = harness(async () => { throw new Error('stale plan must not launch'); });
  panel.form.repositorySetupPlan = onboarding.parseRepositoryOnboardingPlan(rawPlan());
  panel.form.repositoryUrl = 'https://git.example/other.git';
  await panel.continueRepositorySetup();
});
