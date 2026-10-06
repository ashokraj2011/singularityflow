/**
 * Every screen that collects input offers a way back out of it: Cancel, Back, Close or Clear.
 * A form with only a Submit button leaves a person who changed their mind with nothing to press, and
 * a screen that silently drops typed input on navigation is the same failure from the other side.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = (name) => path.join(root, 'apps/vscode/src/views', name);
const source = (relative) => readFile(path.join(root, 'apps/vscode/src', relative), 'utf8');

const { startWizardProgress } = await import(views('start-wizard.ts'));
const { NAV_SCRIPT, navigationTarget, GUIDED_COMMANDS } = await import(views('webview.ts'));
const { EMPTY_INTAKE_FORM, intakeHasInput, intakeHtml } = await import(views('intake-form.ts'));
const { EMPTY_WORKSPACE_FORM, workspaceFormHasInput, workspaceFormHtml } = await import(views('workspace-form.ts'));
const { EMPTY_MAP_FORM, mapFormHasInput, mapCapabilityHtml } = await import(views('map-capability-form.ts'));

test('the guided start rail offers Back from its later steps and Exit from every step', () => {
  const first = startWizardProgress({ step: 'capability' });
  assert.doesNotMatch(first, /data-guided="back"/, 'the first step has nowhere to go back to');
  assert.match(first, /<button type="button" class="secondary" data-guided="exit">Exit guided start<\/button>/);
  assert.match(startWizardProgress({ step: 'workspace' }), /data-guided="back">← Back to Map capability<\/button>/);
  assert.match(startWizardProgress({ step: 'work' }), /data-guided="back">← Back to Create workspace<\/button>/);
  assert.equal(startWizardProgress(null), '', 'outside the guided start there is no rail');

  // The shared page script carries the click to the host, which maps it to exactly two commands.
  assert.match(NAV_SCRIPT, /closest\('\[data-guided\]'\)[\s\S]*to: 'guided-' \+ guided\.dataset\.guided/);
  assert.equal(navigationTarget({ type: 'navigate', to: 'guided-back' }), 'singularityFlow.guidedStartBack');
  assert.equal(navigationTarget({ type: 'navigate', to: 'guided-exit' }), 'singularityFlow.guidedStartExit');
  assert.equal(navigationTarget({ type: 'navigate', to: 'guided-anything' }), null);
  assert.deepEqual(Object.keys(GUIDED_COMMANDS).sort(), ['guided-back', 'guided-exit']);
});

test('the host registers guided Back and Exit, and Back keeps what earlier steps made', async () => {
  const extension = await source('extension.ts');
  const back = extension.slice(extension.indexOf("registerCommand('singularityFlow.guidedStartBack'"));
  assert.match(back, /if \(prior\.step === 'work'\)[\s\S]*startWizardState\('workspace'[\s\S]*singularityFlow\.createWorkspace/);
  assert.match(back, /startWizardState\('capability'\)[\s\S]*singularityFlow\.startWizard/);
  assert.match(extension, /registerCommand\('singularityFlow\.guidedStartExit'[\s\S]{0,200}START_WIZARD_KEY, undefined/,
    'Exit forgets the journey');
});

test('Start Work, Create workspace and Map capability each have Cancel, and ask only when something was entered', async () => {
  const intake = intakeHtml({ ...EMPTY_INTAKE_FORM, shape: 'story' });
  assert.match(intake, /<button type="button" class="secondary" data-intake-cancel >Cancel<\/button>/);
  assert.equal(intakeHasInput(EMPTY_INTAKE_FORM), false);
  assert.equal(intakeHasInput({ ...EMPTY_INTAKE_FORM, title: 'Retry a charge' }), true);
  assert.equal(intakeHasInput({ ...EMPTY_INTAKE_FORM, storyAttachments: [{ name: 'brief.md' }, null] }), true);

  assert.match(workspaceFormHtml({ ...EMPTY_WORKSPACE_FORM }), /data-workspace-cancel >Cancel<\/button>/);
  assert.equal(workspaceFormHasInput(EMPTY_WORKSPACE_FORM), false);
  assert.equal(workspaceFormHasInput({ ...EMPTY_WORKSPACE_FORM, id: 'payments' }), true);

  assert.match(mapCapabilityHtml({ ...EMPTY_MAP_FORM }), /data-map-close >Cancel<\/button>/);
  assert.equal(mapFormHasInput(EMPTY_MAP_FORM), false);
  assert.equal(mapFormHasInput({ ...EMPTY_MAP_FORM, repositoryUrl: 'https://example.test/app.git' }), true);

  for (const [file, check] of [
    ['views/intake-panel.ts', /cancel: async \(\) => \{[\s\S]*intakeHasInput\(this\.form\)[\s\S]*showCompactWarningMessage[\s\S]*this\.dispose\(\);/],
    ['views/workspace-panel.ts', /cancel: async \(\) => \{[\s\S]*workspaceFormHasInput\(this\.form\)[\s\S]*this\.dispose\(\);/],
    ['views/bootstrap-panel.ts', /message\?\.type === 'closeForm'[\s\S]*mapFormHasInput\(this\.form\)[\s\S]*this\.dispose\(\);/]
  ]) assert.match(await source(file), check, `${file} closes only after asking about entered input`);
});

test('editors with Save also offer Discard, and switching away from unsaved edits asks first', async () => {
  const capabilityPage = await source('views/capability-page.ts');
  assert.match(capabilityPage, /data-discard="\$\{escape\(detail\.id\)\}">Discard changes<\/button>/);
  assert.match(capabilityPage, /vscode\.postMessage\(\{ type: 'select', id: data\.select, dirty \}\)/);
  const capabilities = await source('views/capabilities.ts');
  assert.match(capabilities, /message\.dirty === true && id !== this\.selected[\s\S]*showCompactWarningMessage\('Discard the changes you have not saved\?'/);
  assert.match(capabilities, /if \(this\.dirty\) this\.renderHeld = true; else this\.render\(\);/,
    'a background refresh does not redraw the form over unsaved edits');

  const centerPage = await source('views/configuration-center-page.ts');
  assert.equal((centerPage.match(/data-action="discard-edits">Discard changes<\/button>/g) ?? []).length, 3,
    'Auto policy, world model and profile each offer Discard');
  const center = await source('views/configuration-center.ts');
  assert.match(center, /const leaving = message\.type === 'tab' \|\| message\.type === 'select-authority' \|\| message\.type === 'select-mcp' \|\| message\.type === 'select-test-target';\s*if \(leaving && this\.dirty && !await this\.discardEdits\(\)\) return;/);
});

test('the remaining screens have a way out: proposal review, team onboarding, copy workspace, SGOS, forms', async () => {
  assert.match(await source('views/capability-proposal.ts'), /data-action="close"[\s\S]*if \(message\.type === 'close'\) \{ if \(!this\.busy\) this\.panel\.dispose\(\); return; \}/);
  assert.match(await source('views/team-onboarding-page.ts'), /data-team-action="close"[^>]*>Cancel<\/button>/);
  const workspaces = await source('views/workspaces-page.ts');
  assert.match(workspaces, /data-copy-clear="1"[^>]*>Clear<\/button>/);
  const sgos = await source('sgos-workflow-create.ts');
  assert.doesNotMatch(sgos, /nav: false/, 'the SGOS creator carries the shared footer');
  assert.match(sgos, /const navigation = navigationTarget\(message\);\s*if \(navigation\) return void navigateTo\(navigation\);/);
  assert.match(await source('views/sgos-workflow-create-page.ts'), /data-sgos-close="1"[^>]*>Close<\/button>/);
  const form = await source('views/form-panel.ts');
  assert.match(form, /'sflow\.form\.discard': \(\) => \{[\s\S]*saveDraft\(request\.schemaId, \{\}\);/);
  assert.match(form, /'sflow\.form\.cancel': \(\) => \{ panel\?\.dispose\(\); \}/);
  for (const file of ['views/goals.ts', 'views/fault-repairs.ts', 'views/visual-assurance-page.ts']) {
    assert.match(await source(file), /<button type="reset" class="secondary">Clear<\/button>/, `${file} offers Clear`);
  }
  assert.match(await source('views/local-reset.ts'), /data-message="cancel-preview">Cancel<\/button>[\s\S]*'cancel-preview': \(\) => \{ this\.plan = null;/);
});
