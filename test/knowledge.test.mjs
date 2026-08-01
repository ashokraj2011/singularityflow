import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  currentKnowledge, filterKnowledge, harvestableEntries, readKnowledge, recordKnowledge, resolveKnowledge
} from '../src/knowledge.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-knowledge-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Knowledge Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# knowledge\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init'], { cwd: root });
  return root;
}

const ARTIFACT = `# SF-E-001 — Production learning

## Measured result

| Measure | Target | Actual | Verdict |
|---|---|---|---|
| Checkout completion | 80% | 71% | missed |

## What we got wrong

| Assumption | What actually happened | How we know | Consequence |
|---|---|---|---|
| Users would adopt the new flow immediately | adoption took six weeks | weekly cohort analysis | roadmap slipped |

## Still unknown

| Question | Why it matters | How it could be answered |
|---|---|---|
| Does the cache survive regional failover? | potential data loss | chaos test in staging |
| | | |

## Evidence

Not a harvestable section.
`;

test('harvest reads claims from the table sections the templates ask for', () => {
  const found = harvestableEntries(ARTIFACT, { initiativeId: 'SF-E-001', phase: 'delivery', output: 'production-learning' });
  const byType = (type) => found.filter((entry) => entry.type === type);
  assert.equal(byType('result').length, 1);
  assert.equal(byType('learning').length, 1);
  assert.equal(byType('uncertainty').length, 1, 'the blank template row is not a claim');
  assert.equal(byType('learning')[0].title, 'Users would adopt the new flow immediately');
  // Remaining cells become the detail, so the author's own words survive the lift.
  assert.match(byType('learning')[0].detail, /adoption took six weeks · weekly cohort analysis/);
  assert.equal(byType('uncertainty')[0].provenance.section, 'Still unknown');
  assert.equal(byType('uncertainty')[0].provenance.output, 'production-learning');
  // Prose sections are never interpreted — the engine has no model in it.
  assert.equal(found.some((entry) => /Not a harvestable section/.test(entry.title)), false);
});

test('entries are content addressed, so recording the same claim twice is a no-op', async () => {
  const root = await repository();
  const first = await recordKnowledge(root, { type: 'decision', title: 'Adopt event sourcing for ledger' });
  const again = await recordKnowledge(root, { type: 'decision', title: 'Adopt event sourcing for ledger' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(first.sha256, again.sha256);
  const stored = await readKnowledge(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].record.actor, 'owner@example.com');
  // The timestamp is stored but deliberately outside the hash, so a re-harvest of an unchanged
  // artifact adds nothing rather than duplicating every finding.
  assert.ok(stored[0].record.recordedAt, 'the entry still records when it was written');
});

test('only an uncertainty carries a status, and resolving supersedes without rewriting', async () => {
  const root = await repository();
  const open = await recordKnowledge(root, { type: 'uncertainty', title: 'Does the cache survive failover?' });
  assert.equal(open.record.status, 'open');
  const decision = await recordKnowledge(root, { type: 'decision', title: 'Use Postgres' });
  assert.equal(decision.record.status, null, 'a decision is superseded, not closed');

  const resolved = await resolveKnowledge(root, open.sha256.slice(0, 12), { resolution: 'Yes — verified by chaos test.' });
  assert.equal(resolved.record.status, 'resolved');
  assert.equal(resolved.record.supersedes, open.sha256);

  // The original record is still on disk: the store is append-only.
  const all = await readKnowledge(root);
  assert.equal(all.length, 3);
  assert.ok(all.some((entry) => entry.sha256 === open.sha256));

  // But the current view shows the resolution rather than the open question twice.
  const current = currentKnowledge(all);
  assert.equal(current.filter((entry) => entry.record.title === 'Does the cache survive failover?').length, 1);
  assert.equal(current.find((entry) => entry.record.title === 'Does the cache survive failover?').record.status, 'resolved');

  await assert.rejects(() => resolveKnowledge(root, decision.sha256, { resolution: 'x' }), /Only an uncertainty can be resolved/);
  await assert.rejects(() => resolveKnowledge(root, open.sha256, { resolution: '  ' }), /requires the answer/);
});

test('entries can be filtered by type, status, tag and text', async () => {
  const root = await repository();
  await recordKnowledge(root, { type: 'learning', title: 'Batch writes halve p99 latency', tags: ['performance'] });
  await recordKnowledge(root, { type: 'uncertainty', title: 'Is the vendor SLA sufficient?', tags: ['vendor'] });
  const entries = currentKnowledge(await readKnowledge(root));
  assert.equal(filterKnowledge(entries, { type: 'learning' }).length, 1);
  assert.equal(filterKnowledge(entries, { status: 'open' }).length, 1);
  assert.equal(filterKnowledge(entries, { tag: 'performance' }).length, 1);
  assert.equal(filterKnowledge(entries, { query: 'p99' }).length, 1);
  assert.equal(filterKnowledge(entries, { query: 'nothing matches' }).length, 0);
});

test('a knowledge entry requires a known type and a title', async () => {
  const root = await repository();
  await assert.rejects(() => recordKnowledge(root, { type: 'opinion', title: 'x' }), /Knowledge type must be one of/);
  await assert.rejects(() => recordKnowledge(root, { type: 'learning', title: '   ' }), /requires a title/);
});
