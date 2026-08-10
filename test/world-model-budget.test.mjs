/**
 * Advisory byte budgets for generated world-model Markdown.
 *
 * `templates/worldmodel-builder.md` has always carried a table of per-document byte limits and
 * called them hard. `validateWorldModelDirectory` checks structure, JSON validity, manifest coverage
 * and file hashes, and never once looked at size — so the numbers existed only inside a prompt, and
 * a seven-view standard build came to roughly 120 KB by design.
 *
 * Every Markdown byte is counted, including fenced content, because a fence is not proof that its
 * contents are compact facts. Overruns must be observable without blocking otherwise valid work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateWorldModelDirectory } from '../src/grounding.mjs';
import {
  budgetFor, PROSE_BUDGETS, TOTAL_DOCUMENT_BUDGETS, proseBytes
} from '../src/world-model-selection.mjs';

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
  assert.equal(budgetFor('core/summary.md').totalBytes, TOTAL_DOCUMENT_BUDGETS.core_summary);
  assert.equal(budgetFor('core/summary.brief.md').bytes, PROSE_BUDGETS.core_brief);
  assert.equal(budgetFor('views/security.md').bytes, PROSE_BUDGETS.view);
  assert.equal(budgetFor('views/security.brief.md').bytes, PROSE_BUDGETS.view_brief);
  assert.equal(budgetFor('domains/payments.md').bytes, PROSE_BUDGETS.domain);
  assert.equal(budgetFor('task-guides/rename.md').bytes, PROSE_BUDGETS.task_guide);
  // Nothing governs the machine-readable files; they are not prose.
  assert.equal(budgetFor('core/model.json'), null);
  assert.equal(budgetFor('evidence/evidence.jsonl'), null);
});

test('fenced blocks count toward the advisory budget', () => {
  const facts = ['```yaml', 'x'.repeat(5000), '```'].join('\n');
  assert.ok(proseBytes(`Short sentence.\n\n${facts}\n`) > 5000,
    'a fenced block bypassed the advisory budget');
  assert.ok(proseBytes('x'.repeat(5000)) >= 5000);
});

test('a model within its budget validates', async () => {
  const directory = await model();
  const { manifest } = await validateWorldModelDirectory(directory, { requiredViews: ['architecture'] });
  assert.equal(manifest.schema_version, '2.0');
});

test('a view that runs long warns but does not fail the build', async () => {
  const directory = await model({ viewProse: `${'The design is cohesive. '.repeat(600)}\n` });
  const { manifest, warnings } = await validateWorldModelDirectory(directory, { requiredViews: ['architecture'] });
  assert.equal(manifest.schema_version, '2.0');
  assert.ok(warnings.some((warning) => /views\/architecture\.md/.test(warning)));
  assert.ok(warnings.some((warning) => /advisory budget 8000/.test(warning)));
});

test('a fenced runaway document cannot bypass the independent total ceiling', async () => {
  const facts = ['```text', 'x'.repeat(280_000), '```'].join('\n');
  const directory = await model({ viewProse: `A short judgement about boundaries.\n\n${facts}\n` });
  const { manifest, warnings } = await validateWorldModelDirectory(directory, { requiredViews: ['architecture'] });
  assert.ok(manifest);
  assert.ok(warnings.some((warning) => /advisory ceiling 32000/.test(warning)));
});
