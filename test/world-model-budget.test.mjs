/**
 * The byte budgets, which were published as "hard" and never measured.
 *
 * `templates/worldmodel-builder.md` has always carried a table of per-document byte limits and
 * called them hard. `validateWorldModelDirectory` checks structure, JSON validity, manifest coverage
 * and file hashes, and never once looked at size — so the numbers existed only inside a prompt, and
 * a seven-view standard build came to roughly 120 KB by design.
 *
 * Only prose is counted. That is the substance of the rule rather than an exemption from it: derived
 * facts are compact and checkable, and a view that answers with a path and a line instead of a
 * paragraph about cohesion should not be charged for the answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateWorldModelDirectory } from '../src/grounding.mjs';
import { budgetFor, PROSE_BUDGETS, proseBytes } from '../src/world-model-selection.mjs';

async function model({ summaryProse = 'core summary.\n', viewProse = 'architecture view.\n' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-budget-'));
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'views'), { recursive: true });
  await mkdir(path.join(directory, 'index'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), `${JSON.stringify({ id: 'E-1', claim: 'observed' })}\n`);
  await writeFile(path.join(directory, 'core/summary.md'), summaryProse);
  await writeFile(path.join(directory, 'core/summary.brief.md'), 'brief core.\n');
  await writeFile(path.join(directory, 'core/model.json'), JSON.stringify({ schema_version: '2.0' }));
  await writeFile(path.join(directory, 'index/path-map.json'), JSON.stringify({ paths: [] }));
  await writeFile(path.join(directory, 'views/architecture.md'), viewProse);
  await writeFile(path.join(directory, 'views/architecture.brief.md'), 'brief architecture.\n');
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    schema_version: '2.0',
    repository_commit: 'a'.repeat(40),
    repository_branch: 'main',
    working_tree_clean: true,
    generated_at: new Date(0).toISOString(),
    generated_date: '01 January 1970',
    builder_version: '2.0',
    builder_prompt_sha256: `sha256:${'0'.repeat(64)}`,
    analysis_depth: 'quick',
    core: { summary: 'core/summary.md', brief: 'core/summary.brief.md', model: 'core/model.json' },
    path_index: { path: 'index/path-map.json' },
    views: { architecture: { path: 'views/architecture.md', brief_path: 'views/architecture.brief.md', generated: true } },
    domains: [],
    task_guides: [],
    evidence: { path: 'evidence/evidence.jsonl' }
  }));
  return directory;
}

test('each document is held to the budget its path implies', () => {
  assert.equal(budgetFor('core/summary.md').bytes, PROSE_BUDGETS.core_summary);
  assert.equal(budgetFor('core/summary.brief.md').bytes, PROSE_BUDGETS.core_brief);
  assert.equal(budgetFor('views/security.md').bytes, PROSE_BUDGETS.view);
  assert.equal(budgetFor('views/security.brief.md').bytes, PROSE_BUDGETS.view_brief);
  assert.equal(budgetFor('domains/payments.md').bytes, PROSE_BUDGETS.domain);
  assert.equal(budgetFor('task-guides/rename.md').bytes, PROSE_BUDGETS.task_guide);
  // Nothing governs the machine-readable files; they are not prose.
  assert.equal(budgetFor('core/model.json'), null);
  assert.equal(budgetFor('evidence/evidence.jsonl'), null);
});

test('fenced blocks are not prose', () => {
  const facts = ['```yaml', 'x'.repeat(5000), '```'].join('\n');
  assert.ok(proseBytes(`Short sentence.\n\n${facts}\n`) < 100,
    'a fact block was charged against the prose budget');
  assert.ok(proseBytes('x'.repeat(5000)) >= 5000);
});

test('a model within its budget validates', async () => {
  const directory = await model();
  const { manifest } = await validateWorldModelDirectory(directory, { requiredViews: ['architecture'] });
  assert.equal(manifest.schema_version, '2.0');
});

test('a view that runs long fails the build, and says by how much', async () => {
  const directory = await model({ viewProse: `${'The design is cohesive. '.repeat(600)}\n` });
  await assert.rejects(
    () => validateWorldModelDirectory(directory, { requiredViews: ['architecture'] }),
    (error) => {
      assert.match(error.message, /exceed their prose budget/);
      assert.match(error.message, /views\/architecture\.md \(\d+ bytes of prose, budget 8000\)/);
      // The remedy is named, because "too long" without a way out is not actionable.
      assert.match(error.message, /domain file|evidence ledger|fact block/);
      return true;
    }
  );
});

test('the same document passes when the length is facts rather than prose', async () => {
  // The point of the rule. A view may be long if what makes it long is checkable.
  const facts = ['```yaml', ...Array.from({ length: 400 }, (_, index) => `  - { path: src/file-${index}.js, line: ${index} }`), '```'].join('\n');
  const directory = await model({ viewProse: `A short judgement about boundaries.\n\n${facts}\n` });
  const { manifest } = await validateWorldModelDirectory(directory, { requiredViews: ['architecture'] });
  assert.ok(manifest);
});
