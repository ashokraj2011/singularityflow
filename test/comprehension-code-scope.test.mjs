/**
 * Code explanations explain application code only. Singularity Flow's own files (governed roots,
 * configured roots, agent definitions, machine-local state) are counted and never shown, in the
 * slice VS Code leases, in `explain code` and in `explain --subject change`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { applicationPathContext } from '../src/application-paths.mjs';
import {
  buildComprehensionChangeSet, comprehensionDiffOptions, isExplainedPath
} from '../src/comprehension/code-scope.mjs';
import { verifyRepositoryChangeSetIntegrity } from '../src/repository-change-set.mjs';
import { cliJson, comprehensionSlice, createChangeRepository, isolatedHome } from './helpers/xpl2-fixture.mjs';

const HIDDEN = [
  'singularity/work-items/S-1/STATUS.md',
  '.github/agents/reviewer.agent.md',
  '.singularity-flow/story-worktrees/w/src/cart.js',
  'records/S-1/notes.md'
];

/**
 * A governed repository whose work items live in a configured root, with code and record changes.
 * The agent file it adds is not a valid agent: a broken definition elsewhere must not cost the
 * configured root its governed status.
 */
async function governedChange(t) {
  const home = await isolatedHome(t);
  const repository = await createChangeRepository(t, {
    baseline: {
      'src/cart.js': 'export function total(items) {\n  return items.length;\n}\n',
      '.github/workflows/ci.yml': 'on: push\n'
    },
    prepare: async (root) => {
      assert.equal(cliJson(root, home, ['init']).status, 0);
      const file = path.join(root, 'singularity', 'workflow.yml');
      const definition = YAML.parse(await readFile(file, 'utf8'));
      definition.workItemRoot = 'records';
      await writeFile(file, YAML.stringify(definition));
    },
    change: {
      'src/cart.js': 'export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n',
      '.github/workflows/ci.yml': 'on: [push, pull_request]\n',
      ...Object.fromEntries(HIDDEN.map((file) => [file, `${file}\n`]))
    }
  });
  return { ...repository, home };
}

test('only application paths are explained; governed, agent and machine-local paths are not', () => {
  const context = applicationPathContext();
  for (const file of ['src/cart.js', '.github/workflows/ci.yml', 'README.md', 'singularity.md', 'src/singularity/x.js']) {
    assert.equal(isExplainedPath(file, context), true, file);
  }
  for (const file of ['singularity/workflow.yml', '.github/agents/qa.agent.md', '.singularity-flow/x', '.git/config']) {
    assert.equal(isExplainedPath(file, context), false, file);
  }
  assert.equal(isExplainedPath('records/S-1/x.md', applicationPathContext({ workItemRoot: 'records' })), false);
});

test('a comprehension change set keeps code, counts what it hid, and stays integrity-valid', async (t) => {
  const { root, base } = await governedChange(t);
  const { changeSet, hidden } = await buildComprehensionChangeSet(root, {
    baseCommit: base, subject: { kind: 'comprehension-observation' }
  });
  assert.deepEqual(changeSet.entries.map((entry) => entry.newPath).sort(), ['.github/workflows/ci.yml', 'src/cart.js']);
  assert.equal(hidden.entries, HIDDEN.length);
  assert.deepEqual(hidden.groups.map((group) => group.group),
    ['.github/agents', '.singularity-flow/story-worktrees', 'records/S-1', 'singularity/work-items']);
  assert.equal(verifyRepositoryChangeSetIntegrity(changeSet).valid, true);
  // Git is asked only for the kept tracked paths, so patch sections pair with entries again.
  assert.deepEqual(comprehensionDiffOptions(changeSet, hidden).paths.sort(), ['.github/workflows/ci.yml', 'src/cart.js']);
  assert.deepEqual(comprehensionDiffOptions(changeSet, { entries: 0 }), {});
});

test('explain code shows code units with real hunks and names the hidden Singularity Flow changes', async (t) => {
  const { root, home } = await governedChange(t);
  const result = cliJson(root, home, ['explain', 'code', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const explanation = result.json.data.explanation;
  const paths = explanation.whyEachChange.map((unit) => unit.location.pathAfter ?? unit.location.pathBefore);
  assert.deepEqual([...new Set(paths)].sort(), ['.github/workflows/ci.yml', 'src/cart.js']);
  assert.ok(explanation.whyEachChange.some((unit) => unit.unitKind === 'diff-hunk'
    && unit.location.pathAfter === 'src/cart.js'), 'the code change is a text hunk, not an opaque unit');
  assert.equal(explanation.scope.hiddenEntries, HIDDEN.length);
  assert.match(result.json.rendered?.headline ?? result.stdout, /4 Singularity Flow file change\(s\) are not code and are not shown/);
});

test('the change subject and the VS Code slice describe the same code-only capture', async (t) => {
  const { root, home } = await governedChange(t);
  const subject = cliJson(root, home, ['explain', '--subject', 'change', '--json']);
  assert.equal(subject.status, 0, subject.stderr);
  const statements = subject.json.data.explanation.statements;
  const hidden = statements.find((statement) => statement.template === 'xpl2.singularity-files-hidden@1');
  assert.equal(hidden?.arguments?.entries, HIDDEN.length);
  assert.equal(statements.some((statement) => JSON.stringify(statement.arguments ?? {}).includes('singularity/work-items')
    && statement.template !== 'xpl2.singularity-files-hidden@1'), false);
  const slice = await comprehensionSlice(root);
  assert.equal(slice.codeScope.hidden.entries, HIDDEN.length);
  assert.deepEqual(slice.manifest.regions.map((region) => region.location.pathAfter ?? region.location.pathBefore).sort(),
    ['.github/workflows/ci.yml', 'src/cart.js']);
  assert.equal(slice.diff.status, 'available');
});
