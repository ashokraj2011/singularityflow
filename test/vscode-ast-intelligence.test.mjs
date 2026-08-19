import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
const {
  astPolicyView, parseAstLanguageRows, parseAstPredicateRows, updateAstPolicyYaml, validateAstPolicyDraft
} = await import(source('ast-intelligence-model.ts'));

const policy = {
  mode: 'auto', fallback: 'host-and-text', generatedRoots: ['generated/types'],
  budgets: { maxFiles: 300, maxBytes: 10_000_000, maxFileBytes: 1_000_000 },
  languages: [{ language: 'typescript', mode: 'auto', minimumAssurance: 'text' }],
  predicates: [{ id: 'payment-entry', mode: 'advisory', type: 'symbol-exists', target: 'Payment', minimumAssurance: 'text' }]
};

test('the AST settings view projects every repository policy field with bounded defaults', () => {
  assert.deepEqual(astPolicyView({ definition: { ast: {
    mode: 'off', fallback: 'text-only', generatedRoots: ['generated'],
    budgets: { maxFiles: 12, maxBytes: 1000, maxFileBytes: 100 },
    languages: { kotlin: { mode: 'off', minimumAssurance: 'syntax' } },
    predicates: [{ id: 'api', mode: 'required', type: 'path-exists', path: 'src/api', minimumAssurance: 'text' }]
  } } }), {
    mode: 'off', fallback: 'text-only', generatedRoots: ['generated'],
    budgets: { maxFiles: 12, maxBytes: 1000, maxFileBytes: 100 },
    languages: [{ language: 'kotlin', mode: 'off', minimumAssurance: 'syntax' }],
    predicates: [{ id: 'api', mode: 'required', type: 'path-exists', target: 'src/api', minimumAssurance: 'text' }]
  });
  assert.deepEqual(astPolicyView({}), {
    mode: 'auto', fallback: 'host-and-text', generatedRoots: [],
    budgets: { maxFiles: 500, maxBytes: 20 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024 },
    languages: [], predicates: []
  });
});

test('guided AST edits preserve unrelated workflow configuration', () => {
  const original = `version: 2\n# keep this comment\nworkTypes: {}\nworldModel:\n  grounding: warn\nast:\n  mode: off\n`;
  const updated = updateAstPolicyYaml(original, policy);
  const parsed = YAML.parse(updated);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.worldModel.grounding, 'warn');
  assert.match(updated, /# keep this comment/);
  assert.deepEqual(parsed.ast, {
    mode: 'auto', fallback: 'host-and-text', generatedRoots: ['generated/types'],
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
    { language: 'typescript', mode: 'auto', minimumAssurance: 'text' },
    { language: 'kotlin', mode: 'off', minimumAssurance: 'syntax' }
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
});

test('the VS Code AST page exposes every policy source and keeps evidence and resume handles out of HTML', async () => {
  const panel = await readFile(source('ast-intelligence.ts'), 'utf8');
  for (const label of ['Repository policy', 'Machine preference', 'VS Code environment', 'Operation default']) assert.match(panel, new RegExp(label));
  for (const field of ['generatedRoots', 'maxFiles', 'maxBytes', 'maxFileBytes', 'languages', 'predicates']) assert.ok(panel.includes(`name="${field}"`), field);
  assert.match(panel, /CLEAR AST CACHE/);
  assert.match(panel, /escape\(adapter\.id/);
  assert.match(panel, /Facts and source bodies are not rendered/);
  assert.match(panel, /lifecycle gate/);
  assert.match(panel, /cache\.hits/);
  assert.match(panel, /structured arguments, bounded JSON input\/output, no shell/);
  assert.match(panel, /handles are deliberately not embedded in webview HTML/);
  assert.doesNotMatch(panel, /escape\(result\.resumeHandle/);
});

test('AST Intelligence is contributed, navigable, favorite-capable, and exact-confirmation bound', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.configureAstIntelligence'));
  const sidebar = await readFile(source('sidebar.ts'), 'utf8');
  const center = await readFile(source('configuration-center-page.ts'), 'utf8');
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  const panel = await readFile(source('ast-intelligence.ts'), 'utf8');
  assert.match(sidebar, /ast-intelligence.*configureAstIntelligence/s);
  assert.match(center, /AST intelligence.*ast-intelligence/s);
  assert.match(extension, /'singularityFlow\.configureAstIntelligence': async/);
  assert.match(panel, /CLEAR AST CACHE/);
  assert.match(panel, /PRUNE AST CACHE/);
  assert.match(panel, /configuration', 'save'.*--expected-sha256/s);
  assert.match(panel, /openHelp', \{ id: 'help:world-model' \}/);
  assert.doesNotMatch(panel, /exec\(|spawn\(|createTerminal/);
});
