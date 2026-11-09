/**
 * No form refuses a person in silence. [every VS Code page with a form]
 *
 * A browser checks every required field of a form, hidden or not. A required or minlength field inside a
 * block the page hides, or inside a closed <details>, stops the submit with nothing on screen: Chrome only
 * logs "An invalid form control is not focusable". The decisions card did exactly that whenever an item had
 * two options that each ask for a reason, until it disabled the fields of the options not chosen.
 *
 * So, on every page that builds a form with such fields: while a person can see a form's submit button,
 * every required or minlength field the browser will check is one they can see. A field of a block that is
 * not chosen is disabled, so it is neither checked nor sent.
 *
 * Each page is drawn as its panel draws it, with its own script, in a real browser, and every choice on it
 * is tried in turn. It runs where the pinned review browser is installed, as the Spec Studio page test does,
 * and says so where it is not. Which pages it covers is not a list to remember: a source file that builds a
 * form with such fields and has no page here fails the last test.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { register } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { codeOnly } from './source-text.mjs';

// Some pages live beside their panel, which imports 'vscode' at load; drawing a page needs none of it.
const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  export const window = {}; export const workspace = {}; export const commands = {}; export const env = {};
  export const Uri = { file: (fsPath) => ({ fsPath }), parse: (value) => ({ toString: () => value }) };
  export const ViewColumn = { Active: -1, Beside: -2, One: 1 };
  export class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
  export class Disposable { constructor(dispose) { this.dispose = dispose; } static from() { return new Disposable(() => {}); } }
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'apps', 'vscode', 'src');
const { page } = await import('../apps/vscode/src/views/webview.ts');
const view = (name) => import(`../apps/vscode/src/views/${name}`);

// --- The pages, drawn as their panels draw them -------------------------------------------------------------

const W = 'GUARD-1';
const DIGEST = `sha256:${'8'.repeat(64)}`;

async function decisionsPage() {
  const [{ decisionListHtml, DECISION_LIST_SCRIPT, DECISION_LIST_STYLE }, { buildDecisionListView }] = await Promise.all([
    view('decision-list-page.ts'), view('decision-list-model.ts')]);
  const reason = (text) => ({ default: text, minimum: 20, maximum: 1000 });
  const yours = { groups: ['engineering-reviewers'], labels: ['Engineering reviewers'], allowed: true, words: 'You may decide this.' };
  const theirs = { groups: ['quality-reviewers'], labels: ['Quality reviewers'], allowed: false, words: 'The Quality reviewers decide this.', share: `/sf-decide ${W}` };
  const issue = (id, outcome) => ({ kind: 'upstream-issue-decision', issue: id, issuePhase: 'implementation', outcome });
  // Two options that each ask for a reason: the shape that refused in silence.
  const options = (who, id) => [
    { id: 'accept-risk', label: 'Accept it as a risk until a date', recommended: false, words: 'It needs a decision again after the date.',
      effects: [issue(id, 'accept-risk')], needs: { expires: { default: '2026-11-18', latest: '2027-01-16' }, reason: reason('Accepted as a risk until the date, as reported.') }, decidedBy: who },
    { id: 'dismiss', label: 'Dismiss it: it is not a real problem', recommended: false, words: 'The report stays in the history with your reason.',
      effects: [issue(id, 'dismiss')], needs: { reason: reason('Dismissed: it is delivered completely.') }, decidedBy: who }
  ];
  const packet = {
    schemaVersion: 1, resultType: 'sflow-decisions', revision: 'decision-list-v1', workId: W, phase: 'conformance', phaseLabel: 'Code checking',
    status: 'decisions-needed', headline: "Code checking can't be approved yet: 2 decisions needed.", rule: 'Keep the honest verdict.',
    items: [
      { id: 'd1', kind: 'upstream-issue', title: 'AC-001: a problem reported in Code', why: 'Code checking reported a problem.', options: options(yours, 'UPI-001'), decidedBy: yours },
      // An item the person may not decide still draws its blocks, hidden.
      { id: 'd2', kind: 'upstream-issue', title: 'AC-002: a problem reported in Testing', why: 'Testing decides it.', options: options(theirs, 'UPI-002'), decidedBy: theirs }
    ],
    packetSha256: DIGEST,
    record: { form: `singularity-flow decisions record ${W} --choose <ITEM>=<OPTION> --confirm ${DIGEST}`, recommended: null,
      interactive: `singularity-flow decisions record ${W}`, share: `/sf-decide ${W}` }
  };
  return { name: 'the decision list', html: page(`Decisions · ${W}`, decisionListHtml(buildDecisionListView(packet)), '', 'guard', DECISION_LIST_SCRIPT, { styles: DECISION_LIST_STYLE }) };
}

async function faultRepairsPages() {
  const { faultRepairsBody, SCRIPT } = await view('fault-repairs.ts');
  const fault = { faultId: 'FLT-1', severity: 'medium', status: 'recorded', failure: { type: 'unit-test', message: 'A test failed.' }, story: W };
  const repair = { repairId: 'RPR-1', faultId: 'FLT-1', status: 'planned', attempts: [], planGeneration: 1,
    plan: { allowedPaths: ['src/a.js'], verification: [{ argv: ['npm', 'test'] }], budgets: { maxAttempts: 2 }, integrity: { sha256: 'f'.repeat(64) } } };
  const draw = (tab) => page('Faults & Repairs', faultRepairsBody({ tab, faults: [fault], repairs: [repair], fault, repair, preview: null, error: null }), '', 'guard', SCRIPT);
  return [{ name: 'the faults tab', html: draw('faults') }, { name: 'the repairs tab', html: draw('repairs') }];
}

async function goalsPages() {
  const { goalsBody, SCRIPT } = await view('goals.ts');
  const goal = { id: 'GOAL-1', statement: 'No form refuses in silence', status: 'active', successCriteria: ['Every submit says why'], links: [] };
  const governed = { id: 'GEX-1', statement: 'No form refuses in silence', status: 'planned', planGeneration: 1 };
  const detail = { goal: governed, contract: { criteria: [{ id: 'C1', statement: 'Every submit says why', oracle: { type: 'test' } }] },
    state: { status: 'planned' }, plan: { generation: 1, planSha256: 'a'.repeat(64), steps: [{ id: 'S1', subject: { id: W } }] } };
  const body = goalsBody({ goals: [goal], state: { activeGoalId: goal.id } }, { goal, links: [] }, [{ id: W, title: 'A Story', status: 'in_progress', kind: 'story' }],
    null, { goals: [governed] }, detail);
  return [{ name: 'a personal Goal and a repository Goal with a plan to approve', html: page('Goals', body, '', 'guard', SCRIPT) }];
}

async function journalPages() {
  const { journalBody, SCRIPT } = await view('journal.ts');
  const day = { date: '2026-11-08', totalEvents: 1, summaries: [{ workId: W, text: 'Decided two items', at: '10:00' }], attention: [] };
  const body = journalBody(day, { mode: 'sflow-only', paused: false, retentionDays: 30, timeZone: 'UTC' }, { healthy: true, findings: [] }, '# 2026-11-08', null);
  return [{ name: 'a day with an export preview', html: page('Local Journal', body, '', 'guard', SCRIPT, { nav: 'journal' }) }];
}

async function localResetPages() {
  const { localResetBody, SCRIPT } = await view('local-reset.ts');
  const plan = { schemaVersion: 1, mode: 'forget-only', confirmation: 'forget-local-1', workspaces: [{ id: 'w1', name: 'Workspace', path: '/tmp/w1', disposition: 'preserved' }],
    remove: ['~/.singularity-flow/registry.json'], preserve: ['Every clone'], machineTargets: [] };
  return [{ name: 'a forget-only preview', html: page('Local Data & Reset', localResetBody(plan, null), '', 'guard', SCRIPT) }];
}

async function reviewConfirmationPages() {
  const { reviewConfirmationBody, REVIEW_CONFIRMATION_SCRIPT, REVIEW_CONFIRMATION_STYLE } = await view('review-confirmation-page.ts');
  const request = { title: 'Review upgrade', summary: 'One exact reviewed change', detail: 'Preserve application code and Story history.', confirmLabel: 'Apply reviewed upgrade', expected: 'upgrade-1' };
  return [{ name: 'a typed confirmation', html: page(request.title, `<style nonce="guard">${REVIEW_CONFIRMATION_STYLE}</style>${reviewConfirmationBody(request)}`, '', 'guard', REVIEW_CONFIRMATION_SCRIPT) }];
}

async function visualAssurancePages() {
  const [{ visualAssuranceHtml, VISUAL_ASSURANCE_SCRIPT }, { buildVisualAssuranceView }] = await Promise.all([view('visual-assurance-page.ts'), view('visual-assurance-model.ts')]);
  const hash = (letter) => letter.repeat(64);
  const snapshot = {
    workItems: [], initiatives: [], selectedWorkId: W, selectedInitiativeId: null, initiative: null, workflow: null,
    mcp: { servers: [{ id: 'figma', label: 'Figma', hostReference: 'figma', agents: [], phases: [], tools: ['get_file'], required: true, approval: 'confirm', configured: true,
      readiness: 'needs-attestation', readinessReasons: ['Host readiness has not been attested on this machine.'], sources: ['workspace'] }], inventory: [], errors: [], warnings: [] },
    visualAssurance: {
      schemaVersion: 1, configured: true, workId: W, phase: 'visual-verification', itemDirectory: `singularity/work-items/${W}`, policy: {},
      designSources: { approvedSet: { setSha256: hash('a'), phase: 'design-intake', generation: 1, records: [{ recordId: 'design-1' }] }, candidates: [], stale: [], errors: [], warnings: [], passes: [] },
      evidence: { errors: [], warnings: [], passes: [], records: [{ id: 'design-1', kind: 'design-source', server: 'figma', tool: 'get_file', phase: 'design-intake', targetGeneration: 1,
        fileVersion: '17', outputSha256: hash('d'), output: { path: 'context/mcp/design.png', sha256: hash('d'), mediaType: 'image/png' } }] },
      coverage: { status: 'pass', mode: 'enforce', phase: 'visual-verification', generation: 1, profiles: [{ id: 'mobile', label: 'Mobile', width: 390, height: 844, deviceScaleFactor: 3 }],
        covered: [], uncovered: [], stale: [], duplicates: [], warnings: [], errors: [] },
      comparisons: [], readiness: { status: 'ready', errors: [], warnings: [], passes: [] }
    }
  };
  return [{ name: 'a Story with a design source and an MCP server', html: page('Visual Assurance', visualAssuranceHtml(buildVisualAssuranceView(snapshot), null, null), '', 'guard', VISUAL_ASSURANCE_SCRIPT) }];
}

async function approvalReviewPages() {
  const { approvalReviewBody, REVIEW_SCRIPT, REVIEW_STYLE } = await view('approval-review.ts');
  const request = {
    title: 'Approve Verification', expected: 'verification', workId: W, phaseId: 'verification', phaseLabel: 'Verification', generation: 1,
    artifact: { path: `singularity/work-items/${W}/verification.md`, sha256: `sha256:${'a'.repeat(64)}` }, findings: [], witnessedClauses: null,
    articles: [{ id: 'clarity', title: 'Clarity', question: 'Is every clause testable?' }, { id: 'scope', title: 'Scope', question: 'Is the scope bounded?' }],
    witnessMappings: [{ mappingSha256: `sha256:${'c'.repeat(64)}`, clauseId: `${W}:AC-001`, clauseText: 'The value is shown.',
      clauseFields: { behavior: 'shows the value', observable: 'the value' }, clauseStatus: 'current',
      sourcePath: 'test/value.test.mjs', logicalTestId: 'value shows', sourceDeclarationSha256: `sha256:${'b'.repeat(64)}` }],
    // Decisions answered in the approval: each option shows only the fields it needs.
    inApproval: { digest: DIGEST, items: [{ id: 'd1', title: 'AC-001: a problem reported in Code', why: 'Code checking reported a problem.', options: [
      { id: 'accept-risk', label: 'Accept it as a risk until a date', needs: { expires: { default: '2026-11-25', latest: '2027-01-24' }, reason: { default: 'Accepted until the date.' } } },
      { id: 'dismiss', label: 'Dismiss it', recommended: true, needs: { reason: { default: 'Not a defect.' } } },
      { id: 'proceed', label: 'Proceed without the tests', needs: { cause: { default: 'The runner is down.' }, reason: { default: 'Covered by review.' } } }] }] },
    pendingDecisions: { count: 1, headline: 'Verification has 1 decision holding its approval.' },
    priorExceptions: [], selfApproval: false
  };
  return [{ name: 'checklist, witness mapping and a decision in the approval',
    html: page(request.title, `<style nonce="guard">${REVIEW_STYLE}</style>${approvalReviewBody(request)}`, '', 'guard', REVIEW_SCRIPT) }];
}

/**
 * A view that strip-only TypeScript cannot load (its panel class uses parameter properties), compiled
 * by TypeScript as the oap approval tests compile theirs. Its imports are the modules themselves.
 */
async function compiledView(name) {
  const { default: ts } = await import('typescript');
  const file = path.join(SOURCE, 'views', name);
  const output = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const modules = {};
  for (const [, specifier] of output.matchAll(/require\("([^"]+)"\)/gu)) {
    modules[specifier] ??= await import(specifier === 'vscode' ? 'vscode' : pathToFileURL(path.resolve(path.dirname(file), specifier)).href);
  }
  const exports = {};
  new Function('exports', 'require', output)(exports, (specifier) => modules[specifier]);
  return exports;
}

async function astIntelligencePages() {
  const [{ astIntelligenceBody, SCRIPT }, { astPolicyView, astRepositoryScopeView }] = await Promise.all([compiledView('ast-intelligence.ts'), view('ast-intelligence-model.ts')]);
  const policy = astPolicyView({ definition: { ast: { mode: 'auto', budgets: { maxFiles: 300, maxBytes: 10_000_000, maxFileBytes: 1_000_000 },
    languages: { typescript: { mode: 'auto', minimumAssurance: 'text' } } } } });
  const scope = astRepositoryScopeView({ root: '/tmp/guard/repo', workspaceId: 'guard', workspaceName: 'Guard workspace', repositoryId: 'repo', origin: 'active workspace' });
  const inventory = { workspaceId: 'guard', workspaceName: 'Guard workspace', workspacePath: '/tmp/guard', selectedRepositoryId: 'repo',
    repositories: [{ id: 'repo', role: 'lead', state: 'ready' }, { id: 'other', role: 'member', state: 'ready' }] };
  const doctor = { cache: { files: 2, bytes: 2048 }, adapters: [], optionalPacks: [], languages: [{ language: 'typescript', selectedFiles: 3, maximumAssurance: 'text' }],
    projects: { bindingCount: 1, bindings: [{ projectKind: 'maven', root: '.', complete: true }] } };
  const cache = { action: 'clear', bytes: 2048, targets: ['.git/singularity-flow/ast/cache'] };
  const warm = { operation: 'ast-semantic-warm', provider: 'sflow-java', project: 'maven:.', profile: 'default', ready: true, confirmation: 'WARM maven:.',
    effects: { repositoryWrites: false, network: 'none' }, commands: [{ executable: 'java', arguments: ['-version'], cwd: '.' }] };
  const draw = (preview, warmPreview) => page('AST Intelligence',
    astIntelligenceBody(policy, doctor, null, preview, warmPreview, null, null, scope, inventory, null), '', 'guard', SCRIPT, { nav: 'configuration' });
  return [{ name: 'the settings with no preview', html: draw(null, null) },
    { name: 'a cache cleanup and a semantic warm-up waiting for their typed confirmations', html: draw(cache, warm) }];
}

async function configurationCenterPages() {
  const [{ configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT }, { configurationCenterView }, { testSetupTargets }] = await Promise.all([
    view('configuration-center-page.ts'), view('configuration-center-model.ts'), view('test-setup-model.ts')]);
  const snapshot = {
    identities: { git: { name: 'Developer Dev', email: 'developer@example.com', login: 'fixturedev' }, github: 'fixturedev' },
    definition: { phases: { implementation: { label: 'Code' } } }, agents: [], mcp: { servers: [], errors: [], warnings: [] }
  };
  const command = { id: 'unit', kind: 'test', modelPolicy: 'never', argv: ['node', '--test'], workingDirectory: '.', affectedRoots: ['.'],
    env: { CI: '1' }, result: { adapter: 'node-tap', path: '.sflow/results/unit.tap' } };
  const definition = { version: 2, phases: { implementation: { label: 'Code', approval: { authority: 'human' }, qualityCommands: ['npm run lint', command] } },
    workTypes: { feature: { phases: ['implementation'] } } };
  const targets = testSetupTargets(definition);
  const inspection = { repositoryPath: '/tmp/guard/repo', sourceRoots: ['.'], diagnostics: [], suggestions: [{ ...command, id: 'suggested' }], instructionCandidates: [] };
  return [{ name: 'test setup with a chosen workflow phase and its command rows',
    html: page('Configuration Center', configurationCenterHtml(configurationCenterView(snapshot), 'tests', null, null, null, [], null,
      { targets, selected: targets.find((target) => target.phaseId === 'implementation' && target.workType === null).id, inspection, testScope: { enabled: false, reviews: false } }),
      '', 'guard', CONFIGURATION_CENTER_SCRIPT, { nav: 'configuration' }) }];
}

async function specStudioPages() {
  const [{ specStudioHtml, SPEC_STUDIO_SCRIPT, SPEC_STUDIO_STYLE }, { SPEC_STUDIO_SPLIT_SCRIPT, SPEC_STUDIO_SPLIT_STYLE }, { statusFrom }] = await Promise.all([
    view('spec-studio-page.ts'), view('spec-studio-split.ts'), view('spec-studio-model.ts')]);
  const SPEC = 'SPEC-GUARD-001';
  const openGap = { id: 'GAP-001', kind: 'open-question', status: 'open', question: 'Which reason wins?', evidence: [], clauses: [],
    options: [{ id: 'O1', wording: 'The chosen option\'s', changesCode: false }, { id: 'O2', wording: 'The first one typed', changesCode: true }] };
  const decided = { ...openGap, id: 'GAP-002', status: 'decided', question: 'Is a hidden field checked?',
    decision: { option: 'O1', choice: 'No', reason: 'Disabled.', by: { name: 'A person', email: null }, at: '2026-11-08T00:00:00.000Z' } };
  const status = statusFrom({ resultType: 'sflow-spec-author', action: 'status', specId: SPEC, title: 'A guarded page', kind: 'business', sequence: 3,
    spec: '# A guarded page\n\nWords.\n', areas: ['src'], gaps: [openGap, decided], researchItems: [],
    counts: { d: { passed: 0, total: 0 }, a: { status: 'not-run', pending: 0 }, h: { open: 1, deferred: 0 } },
    proposals: [], findings: [], sources: [], origins: [], rules: [], articles: [], clauseIds: [], blocking: [] });
  const state = (step, selectedGap = null) => ({ target: { specId: SPEC, revision: null, clauses: null, step: null }, step, library: null, status, revision: null,
    coverage: null, split: null, splitDraft: null, selectedGap, impact: null, notice: null, error: null, busy: null, copilot: { available: true, tool: true } });
  const draw = (pageState) => page('Spec Studio', specStudioHtml(pageState), '', 'guard', `${SPEC_STUDIO_SCRIPT}${SPEC_STUDIO_SPLIT_SCRIPT}`,
    { styles: `${SPEC_STUDIO_STYLE}${SPEC_STUDIO_SPLIT_STYLE}` });
  return [
    { name: 'writing, with an open question to confirm', html: draw(state('draft')) },
    { name: 'research, with a person\'s fact to add', html: draw(state('research')) },
    { name: 'questions, with a new gap to open', html: draw(state('gaps')) },
    { name: 'a decided question to reopen', html: draw(state('gaps', 'GAP-002')) }
  ];
}

async function schemaFormPages() {
  const [{ formPanelBody, FORM_SCRIPT }, { formModel, terminalEquivalent }] = await Promise.all([view('form-panel.ts'), import('../src/gateway/form-model.mjs')]);
  const draw = (schemaId, title, command) => {
    const model = formModel(schemaId);
    assert.ok(model, `${schemaId} is a registered form`);
    return { name: `the ${schemaId} form`, html: page(title, formPanelBody(title, model, 'guard', { terminal: terminalEquivalent(command, {}) }), '', 'guard', FORM_SCRIPT) };
  };
  return [draw('ast-query-v1', 'Query the structure', 'singularity-flow ast query'),
    draw('problem-investigate-v1', 'Investigate a problem', 'singularity-flow problem investigate')];
}

/** Each source file that builds a form with required or minlength fields, and the pages it draws. */

/** Each source file that builds a form with required or minlength fields, and the pages it draws. */
const PAGES = {
  'views/approval-review.ts': approvalReviewPages,
  'views/ast-intelligence.ts': astIntelligencePages,
  'views/configuration-center-page.ts': configurationCenterPages,
  'views/decision-list-page.ts': async () => [await decisionsPage()],
  'views/fault-repairs.ts': faultRepairsPages,
  'views/form-page.ts': schemaFormPages,
  'views/goals.ts': goalsPages,
  'views/journal.ts': journalPages,
  'views/local-reset.ts': localResetPages,
  'views/review-confirmation-page.ts': reviewConfirmationPages,
  'views/spec-studio-page.ts': specStudioPages,
  'views/visual-assurance-page.ts': visualAssurancePages
};

// --- The browser --------------------------------------------------------------------------------------------

let chromium;
try { ({ chromium } = await import('playwright-core')); } catch { chromium = null; }
let launched = null;
function browser() {
  launched ??= chromium ? chromium.launch({ headless: true }).catch((error) => ({ error })) : Promise.resolve({ error: new Error('playwright-core is not installed here.') });
  return launched;
}
test.after(async () => { const opened = await launched; if (opened && !opened.error) await opened.close(); });

async function open(t, html) {
  const opened = await browser();
  if (opened.error) return t.skip(`No browser is installed here, so no page was drawn: ${String(opened.error.message).split('\n')[0]}`), null;
  const tab = await opened.newPage();
  t.after(() => tab.close());
  const errors = [];
  const refused = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  tab.on('console', (message) => { if (/is not focusable/u.test(message.text())) refused.push(message.text()); });
  t.after(() => assert.deepEqual(errors, [], 'the page script threw'));
  await tab.goto('about:blank');
  await tab.evaluate(() => {
    let state;
    window.__sfMessages = [];
    window.__sfVscode = { postMessage: (message) => window.__sfMessages.push(message), getState: () => state, setState: (next) => { state = next; } };
  });
  await tab.setContent(html);
  return Object.assign(tab, { refused });
}

/**
 * Every choice on the page, one after another, and after each one every form whose submit button shows: the
 * required and minlength fields it checks that cannot be seen. Choices are what a person changes without
 * leaving the page: lists, radio buttons, check boxes, pressed buttons, and closed sections they open.
 */
function tryEveryChoice() {
  return (async () => {
    const seen = (element) => element.isConnected && element.checkVisibility({ checkVisibilityCSS: true });
    const named = (element) => {
      const tag = element.tagName.toLowerCase();
      const name = element.getAttribute('name') || element.dataset.field || element.id || element.getAttribute('aria-label')
        || (tag === 'form' && element.className) || Object.entries(element.dataset).map(([key, value]) => `${key}=${value}`).join(' ')
        || element.className;
      return `<${tag}${name ? ` ${name}` : ''}>`;
    };
    const checked = new Set();
    const steps = [];
    const look = (step) => {
      const hidden = [];
      for (const form of document.forms) {
        // A submit still disabled counts: typing in the fields a person can see enables it, and leaves a hidden one as it was.
        const submits = Array.from(form.elements).filter((element) => element.type === 'submit' && seen(element));
        if (!submits.length) continue;
        for (const field of form.elements) {
          if (!['INPUT', 'SELECT', 'TEXTAREA'].includes(field.tagName) || !field.willValidate) continue;
          if (!field.hasAttribute('required') && !field.hasAttribute('minlength')) continue;
          if (seen(field)) checked.add(field); else hidden.push(`${named(form)} ${named(field)}`);
        }
      }
      if (hidden.length) steps.push({ step, hidden });
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    look('as drawn');
    const choices = Array.from(document.querySelectorAll('select, input[type=radio], input[type=checkbox], button[aria-pressed]'));
    for (const choice of choices) {
      if (!choice.isConnected || choice.disabled || !seen(choice) || choice.type === 'submit') continue;
      const what = named(choice);
      if (choice.tagName === 'SELECT') {
        for (const option of Array.from(choice.options)) {
          if (option.disabled) continue;
          choice.value = option.value;
          choice.dispatchEvent(new Event('input', { bubbles: true }));
          choice.dispatchEvent(new Event('change', { bubbles: true }));
          await settle(); look(`${what} set to "${option.value}"`);
        }
      } else {
        for (const turn of choice.type === 'checkbox' ? ['on', 'off'] : ['pressed']) {
          if (!choice.isConnected || choice.disabled) break;
          choice.click();
          await settle(); look(`${what} ${turn}`);
        }
      }
    }
    // A closed section a person opens: the forms inside it can be submitted only then.
    for (const section of Array.from(document.querySelectorAll('details:not([open])'))) {
      const summary = section.querySelector(':scope > summary');
      if (!section.isConnected || !summary || !seen(summary)) continue;
      summary.click();
      await settle(); look(`${named(section)} opened`);
    }
    return { steps, checked: checked.size };
  })();
}

for (const [file, draw] of Object.entries(PAGES)) {
  test(`${file}: no form with its submit button showing checks a required field a person cannot see`, async (t) => {
    for (const { name, html } of await draw()) {
      const tab = await open(t, html); if (!tab) return;
      const { steps, checked } = await tab.evaluate(tryEveryChoice);
      assert.deepEqual(steps, [], `${name}: a submit would be refused in silence by a field the person cannot see`);
      assert.ok(checked > 0, `${name}: the page drew no form with a required field, so it checked nothing`);
    }
  });
}

test('the decision list: one option chosen and its own reason given, Review sends it, with the other option\'s fields left empty', async (t) => {
  const tab = await open(t, (await decisionsPage()).html); if (!tab) return;
  const item = tab.locator('.dl-item[data-item="d1"]');
  await item.locator('[data-option="dismiss"]').click();
  await item.locator('[data-needs-for="dismiss"] [data-field="reason"]').fill('Dismissed: the gap is delivered completely by Code.');
  await tab.locator('[data-action="review"]').click();
  await tab.waitForTimeout(50);
  assert.deepEqual(tab.refused, [], 'the browser refused the submit over a field the person could not see');
  const sent = await tab.evaluate(() => window.__sfMessages.filter((message) => message.type === 'decisions.review'));
  assert.deepEqual(sent.map((message) => message.choices), [[{ item: 'd1', option: 'dismiss', reason: 'Dismissed: the gap is delivered completely by Code.' }]]);
});

// --- Which pages ---------------------------------------------------------------------------------------------

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith('.ts') ? [full] : [];
  }));
  return files.flat();
}

test('every source file that builds a form with a required or minlength field has its pages drawn here', async () => {
  const builds = [];
  for (const file of await sources(SOURCE)) {
    const code = codeOnly(await readFile(file, 'utf8'));
    const form = /<form\b|createElement\(\s*['"`]form['"`]\s*\)/u.test(code);
    const constrained = /\s(?:required|minlength)(?=[\s>"'`\\$=])|\.(?:required|minLength)\s*=/u.test(code);
    if (form && constrained) builds.push(path.relative(SOURCE, file).split(path.sep).join('/'));
  }
  assert.deepEqual(builds.sort(), Object.keys(PAGES).sort(),
    'draw each new page here (and drop a page whose form is gone), so its forms are checked in a browser');
});
