/**
 * Golden Repository briefs and the World Model v5 quality bar (M5), on the knowledge fixtures: brief
 * size per phase, every statement cited, at most one "Not known" line, rule linking and docs
 * statement precision, impact recall on a synthetic Story change, the Story's lines first, and no
 * kept polish sentence that changes a value or adds a name (with a recorded model answer).
 *
 * The goldens are the fixed wording, byte for byte. After an intended change to the brief, rewrite
 * them with SINGULARITY_FLOW_WRITE_GOLDEN_BRIEFS=1 and review the diff.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { benchmarkTable, measureRepository, QUALITY_BAR } from '../scripts/world-model-v5-benchmark.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const briefs = path.join(root, 'test', 'fixtures', 'knowledge', 'briefs');
const write = process.env.SINGULARITY_FLOW_WRITE_GOLDEN_BRIEFS === '1';
// A fixed author and date, so the commit (named in each brief) is the same on every machine.
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

async function repositoryFor(t, spec) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-golden-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repository = path.join(parent, spec.name);
  await mkdir(repository);
  await cp(path.join(root, 'test', 'fixtures', 'knowledge', spec.fixture), repository, { recursive: true });
  for (const [file, text] of Object.entries(spec.overlay ?? {})) await writeFile(path.join(repository, file), text);
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'Fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: repository, env, encoding: 'utf8' }).status, 0, args.join(' '));
  }
  // The Story's change: working-tree edits against HEAD, as a Story branch has before it commits.
  for (const edit of spec.change?.edits ?? []) {
    const file = path.join(repository, edit.file);
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes(edit.find), `${spec.name}: ${edit.find}`);
    await writeFile(file, text.replace(edit.find, edit.replace));
  }
  return repository;
}

const specs = (await readdir(briefs)).filter((file) => file.endsWith('.json') && !file.endsWith('.polish.json')).sort();
const results = [];

for (const file of specs) {
  const spec = JSON.parse(await readFile(path.join(briefs, file), 'utf8'));
  test(`${spec.name}: golden briefs and the quality bar`, async (t) => {
    const repository = await repositoryFor(t, spec);
    const polishFile = path.join(briefs, `${spec.name}.polish.json`);
    const polishAnswer = existsSync(polishFile) ? JSON.parse(await readFile(polishFile, 'utf8')) : null;
    const result = await measureRepository(repository, spec, { polishAnswer });
    results.push(result);
    for (const phase of spec.golden) {
      const golden = path.join(briefs, `${spec.name}.${phase}.md`);
      if (write) await writeFile(golden, `${result.briefs[phase].text}\n`);
      assert.equal(`${result.briefs[phase].text}\n`, await readFile(golden, 'utf8'), `${spec.name} ${phase} brief changed`);
    }
    for (const [phase, brief] of Object.entries(result.briefs)) {
      assert.ok(brief.bytes <= Math.min(brief.budget, QUALITY_BAR.maximumBytes), `${spec.name} ${phase}: ${brief.bytes} bytes`);
      assert.equal(brief.cited, brief.statements, `${spec.name} ${phase}: uncited ${brief.uncited.join(' | ')}`);
      assert.ok(brief.notKnownLines <= QUALITY_BAR.notKnownLines, `${spec.name} ${phase}`);
    }
    if (result.linking.links) assert.ok(result.linking.precision >= QUALITY_BAR.linkPrecision, `${spec.name} links: ${result.linking.wrong.join(' | ')}`);
    if (result.statements.extracted) assert.ok(result.statements.precision >= QUALITY_BAR.statementPrecision, `${spec.name} statements: ${result.statements.other.join(' | ')}`);
    if (result.impact.expected) assert.ok(result.impact.recall >= QUALITY_BAR.impactRecall, `${spec.name} impact missed ${result.impact.missed.join(', ')}`);
    if (result.polish) assert.equal(result.polish.violations, QUALITY_BAR.polishViolations, `${spec.name}: a kept sentence changed a value or added a name`);
  });
}

test('the measurements, as the docs record them', { skip: !process.env.SINGULARITY_FLOW_PRINT_BRIEF_BENCHMARK }, () => {
  console.log(benchmarkTable(results));
});
