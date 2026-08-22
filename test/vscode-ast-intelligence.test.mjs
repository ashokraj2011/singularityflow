import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const {
  astPolicyView, astRepositoryScopeView, astWorkspaceRepositoryInventory,
  parseAstLanguageRows, parseAstPredicateRows, updateAstPolicyYaml, validateAstPolicyDraft
} = await import(source('ast-intelligence-model.ts'));

const policy = {
  mode: 'auto', fallback: 'host-and-text', evidence: { mode: 'identified', store: 'local-directory' }, generatedRoots: ['generated/types'],
  budgets: { maxFiles: 300, maxBytes: 10_000_000, maxFileBytes: 1_000_000 },
  languages: [{ language: 'typescript', mode: 'auto', minimumAssurance: 'text', syntaxProvider: null, semanticProvider: null, semanticProfile: null }],
  predicates: [{ id: 'payment-entry', mode: 'advisory', type: 'symbol-exists', target: 'Payment', minimumAssurance: 'text' }]
};

test('the AST settings view projects every repository policy field with bounded defaults', () => {
  assert.deepEqual(astPolicyView({ definition: { ast: {
    mode: 'off', fallback: 'text-only', evidence: { mode: 'replayable', store: 'local-directory' }, generatedRoots: ['generated'],
    budgets: { maxFiles: 12, maxBytes: 1000, maxFileBytes: 100 },
    languages: { kotlin: { mode: 'off', minimumAssurance: 'syntax' } },
    predicates: [{ id: 'api', mode: 'required', type: 'path-exists', path: 'src/api', minimumAssurance: 'text' }]
  } } }), {
    mode: 'off', fallback: 'text-only', evidence: { mode: 'replayable', store: 'local-directory' }, generatedRoots: ['generated'],
    budgets: { maxFiles: 12, maxBytes: 1000, maxFileBytes: 100 },
    languages: [{ language: 'kotlin', mode: 'off', minimumAssurance: 'syntax', syntaxProvider: null, semanticProvider: null, semanticProfile: null }],
    predicates: [{ id: 'api', mode: 'required', type: 'path-exists', target: 'src/api', minimumAssurance: 'text' }]
  });
  assert.deepEqual(astPolicyView({}), {
    mode: 'auto', fallback: 'host-and-text', evidence: { mode: 'identified', store: 'local-directory' }, generatedRoots: [],
    budgets: { maxFiles: 500, maxBytes: 20 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 },
    languages: [], predicates: []
  });
});

test('the AST settings view names and binds the shared active repository context', () => {
  const first = astRepositoryScopeView({
    root: '/work/ccre/repos/payment-adapter', workspaceId: 'ccre', workspaceName: 'CCRE',
    repositoryId: 'payment-adapter', origin: 'the selected repository of your active workspace, CCRE'
  });
  assert.equal(first.workspace, 'CCRE');
  assert.equal(first.repository, 'payment-adapter');
  assert.equal(first.root, path.resolve('/work/ccre/repos/payment-adapter'));
  assert.match(first.origin, /active workspace/);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.notEqual(first.key, astRepositoryScopeView({
    root: '/work/ccre/repos/rules', workspaceId: 'ccre', workspaceName: 'CCRE',
    repositoryId: 'rules', origin: 'the selected repository of your active workspace, CCRE'
  }).key, 'a different repository invalidates a form rendered for the previous one');
});

test('the AST settings view offers every repository in the active workspace', () => {
  assert.deepEqual(astWorkspaceRepositoryInventory({
    active: true, workspaceId: 'ccre', workspaceName: 'CCRE', workspacePath: '/work/ccre',
    repositoryId: 'rules'
  }, { repositories: [
    { id: 'web', state: 'missing' },
    { id: 'rules', role: 'member', state: 'ready' },
    { id: 'api', role: 'lead', state: 'ready' }
  ] }), {
    workspaceId: 'ccre', workspaceName: 'CCRE', workspacePath: '/work/ccre',
    selectedRepositoryId: 'rules',
    repositories: [
      { id: 'api', role: 'lead', state: 'ready' },
      { id: 'rules', role: 'member', state: 'ready' },
      { id: 'web', role: null, state: 'missing' }
    ]
  });
  assert.equal(astWorkspaceRepositoryInventory({ active: false }, { repositories: [] }), null);
});

test('guided AST edits preserve unrelated workflow configuration', () => {
  const original = `version: 2\n# keep this comment\nworkTypes: {}\nworldModel:\n  grounding: warn\nast:\n  mode: off\n`;
  const updated = updateAstPolicyYaml(original, policy);
  const parsed = YAML.parse(updated);
  assert.equal(parsed.ast.evidence.store, undefined, 'the workspace-local default needs no YAML setting');
  assert.equal(parsed.version, 2);
  assert.equal(parsed.worldModel.grounding, 'warn');
  assert.match(updated, /# keep this comment/);
  assert.deepEqual(parsed.ast, {
    mode: 'auto', fallback: 'host-and-text', evidence: { mode: 'identified' }, generatedRoots: ['generated/types'],
    budgets: { maxFiles: 300, maxBytes: 10_000_000, maxFileBytes: 1_000_000 },
    languages: { typescript: { mode: 'auto', minimumAssurance: 'text' } },
    predicates: [{ id: 'payment-entry', mode: 'advisory', type: 'symbol-exists', symbol: 'Payment', minimumAssurance: 'text' }]
  });
});

test('the AST form rejects unsafe roots, duplicate language rows, and disabling required gates', () => {
  const invalid = {
    ...policy, mode: 'off', generatedRoots: ['../secret'],
    languages: [
      { language: 'typescript', mode: 'auto', minimumAssurance: 'text' },
      { language: 'typescript', mode: 'auto', minimumAssurance: 'text' }
    ],
    predicates: [{ id: 'must-exist', mode: 'required', type: 'path-exists', target: 'src', minimumAssurance: 'text' }]
  };
  const errors = validateAstPolicyDraft(invalid).join(' ');
  assert.match(errors, /repository-relative/);
  assert.match(errors, /duplicated/);
  assert.match(errors, /cannot be off/);
  assert.deepEqual(parseAstLanguageRows('typescript | auto | text\nkotlin | off | syntax'), [
    { language: 'typescript', mode: 'auto', minimumAssurance: 'text', syntaxProvider: null, semanticProvider: null, semanticProfile: null },
    { language: 'kotlin', mode: 'off', minimumAssurance: 'syntax', syntaxProvider: null, semanticProvider: null, semanticProfile: null }
  ]);
  assert.deepEqual(parseAstPredicateRows('api | required | path-exists | src/api | text'), [
    { id: 'api', mode: 'required', type: 'path-exists', target: 'src/api', minimumAssurance: 'text' }
  ]);
  assert.deepEqual(validateAstPolicyDraft({
    ...policy,
    predicates: [{ id: 'Legacy_Predicate:1', mode: 'advisory', type: 'symbol-exists', target: 'Payment', minimumAssurance: 'text' }]
  }), []);
  assert.match(validateAstPolicyDraft({
    ...policy,
    predicates: [{ id: 'must-symbol', mode: 'required', type: 'symbol-exists', target: 'Payment', minimumAssurance: 'text' }]
  }).join(' '), /syntax or semantic/);
  const rich = parseAstPredicateRows('boundary | required | import-boundary | src/api | syntax | java,kotlin | * | forbidden.internal');
  assert.deepEqual(rich, [{
    id: 'boundary', mode: 'required', type: 'import-boundary', target: 'src/api',
    minimumAssurance: 'syntax', languages: ['java', 'kotlin'], profiles: ['*'], secondary: 'forbidden.internal'
  }]);
  assert.deepEqual(validateAstPolicyDraft({ ...policy, evidence: { mode: 'replayable', store: 'local-directory' }, predicates: rich }), []);
  const richYaml = YAML.parse(updateAstPolicyYaml('version: 2\n', {
    ...policy, evidence: { mode: 'replayable', store: 'local-directory' }, predicates: rich
  }));
  assert.deepEqual(richYaml.ast.predicates[0], {
    id: 'boundary', mode: 'required', type: 'import-boundary', path: 'src/api', target: 'forbidden.internal',
    minimumAssurance: 'syntax', languages: ['java', 'kotlin'], profiles: ['*']
  });
});

test('the VS Code AST page exposes every policy source and keeps evidence and resume handles out of HTML', async () => {
  const panel = await readFile(source('ast-intelligence.ts'), 'utf8');
  for (const label of ['Repository policy', 'Machine preference', 'VS Code environment', 'Operation default']) assert.match(panel, new RegExp(label));
  for (const field of ['evidenceMode', 'evidenceStore', 'generatedRoots', 'maxFiles', 'maxBytes', 'maxFileBytes', 'languages', 'predicates']) assert.ok(panel.includes(`name="${field}"`), field);
  assert.match(panel, /CLEAR AST CACHE/);
  assert.match(panel, /escape\(adapter\.id/);
  assert.match(panel, /Facts and source bodies are not rendered/);
  assert.match(panel, /lifecycle gate/);
  assert.match(panel, /cache\.hits/);
  assert.match(panel, /structured arguments, bounded JSON input\/output, no shell/);
  assert.match(panel, /Language and project readiness/);
  assert.match(panel, /bundled Java, Python, Kotlin, and Swift scanner supplies text-assured declaration previews only/);
  assert.match(panel, /syntax gates require a reviewed parser-backed provider/);
  assert.match(panel, /entry\.selectedProviders\?\.syntax/);
  assert.match(panel, /existing project binding\(s\) discovered without running a build/);
  assert.match(panel, /handles are deliberately not embedded in webview HTML/);
  assert.doesNotMatch(panel, /escape\(result\.resumeHandle/);
  assert.match(panel, /Current repository scope/);
  assert.match(panel, /Switch workspace/);
  assert.match(panel, /Off — disable for \$\{repository\}/);
  assert.match(panel, /data-repository-scope/);
  assert.match(panel, /active repository changed after this screen was rendered/i);
  assert.match(panel, /executeCommand\('singularityFlow\.openWorkspaces'\)/);
  assert.match(panel, /id="ast-repository-form"/);
  assert.match(panel, /type: 'select-repository'/);
  assert.match(panel, /switchWorkspaceRepository/);
  assert.match(panel, /shared active repository for My Work, Lifecycle, Configuration, Copilot, and the terminal/);
  assert.match(panel, /Semantic project warm-up/);
  assert.match(panel, /Workspace-local/);
  assert.match(panel, /\.singularity-flow\/ast-evidence-store/);
  assert.match(panel, /reviewed optional semantic provider/);
  assert.match(panel, /id="ast-warm-form"/);
  assert.match(panel, /Project binding<select name="project" required>/);
  assert.match(panel, /Choose a discovered project/);
  assert.match(panel, /binding\.projectKind/);
  assert.doesNotMatch(panel, /name="project" required placeholder=/);
  assert.match(panel, /type: 'preview-warm'/);
  assert.match(panel, /type: 'execute-warm'/);
  assert.match(panel, /wm', 'ast', 'warm', '--semantic'/);
  assert.match(panel, /confirmation !== preview\.confirmation/);
});

test('AST Intelligence is contributed, navigable, favorite-capable, and exact-confirmation bound', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.configureAstIntelligence'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.switchWorkspaceRepository'));
  const sidebar = await readFile(source('sidebar.ts'), 'utf8');
  const center = await readFile(source('configuration-center-page.ts'), 'utf8');
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  const panel = await readFile(source('ast-intelligence.ts'), 'utf8');
  assert.match(sidebar, /ast-intelligence.*configureAstIntelligence/s);
  assert.match(center, /AST intelligence.*ast-intelligence/s);
  assert.match(extension, /'singularityFlow\.configureAstIntelligence': async/);
  assert.match(extension, /'singularityFlow\.switchWorkspaceRepository'/);
  assert.match(extension, /'workspace', 'use', target,[\s\S]*'--repository', repositoryId/);
  assert.match(panel, /CLEAR AST CACHE/);
  assert.match(panel, /PRUNE AST CACHE/);
  assert.match(panel, /configuration', 'save'.*--expected-sha256/s);
  assert.match(panel, /openHelp', \{ id: 'help:world-model' \}/);
  assert.doesNotMatch(panel, /exec\(|spawn\(|createTerminal/);
});
