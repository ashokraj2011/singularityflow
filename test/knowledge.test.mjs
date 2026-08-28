import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  currentKnowledge, filterKnowledge, harvestableEntries, readKnowledge, readKnowledgeWithDiagnostics,
  recallKnowledge, recordKnowledge, resolveKnowledge
} from '../src/knowledge.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { run, snapshot } from '../src/util.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';

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

const PROVENANCE = [{ workId: 'SF-E-001', artifact: 'artifacts/delivery/learning.md', sha256: 'a'.repeat(64), approvedRevision: 1 }];
const SCOPE = { repositories: ['product-repository'] };

test('harvest reads claims from the table sections the templates ask for', () => {
  const found = harvestableEntries(ARTIFACT, { workId: 'SF-E-001', artifact: 'artifacts/delivery/production-learning.md', sha256: 'a'.repeat(64), approvedRevision: 1, scope: SCOPE });
  const byType = (type) => found.filter((entry) => entry.type === type);
  assert.equal(byType('insight').length, 1);
  assert.equal(byType('gotcha').length, 1);
  assert.equal(byType('uncertainty').length, 1, 'the blank template row is not a claim');
  assert.match(byType('gotcha')[0].text, /Users would adopt.*adoption took six weeks.*weekly cohort analysis/);
  assert.equal(byType('uncertainty')[0].provenance[0].artifact, 'artifacts/delivery/production-learning.md');
  // Prose sections are never interpreted — the engine has no model in it.
  assert.equal(found.some((entry) => /Not a harvestable section/.test(entry.title)), false);
});

test('entries are content addressed, so recording the same claim twice is a no-op', async () => {
  const root = await repository();
  const first = await recordKnowledge(root, { type: 'decision', text: 'Adopt event sourcing for ledger', provenance: PROVENANCE, scope: SCOPE, approvedSourceVerified: true });
  const again = await recordKnowledge(root, { type: 'decision', text: 'Adopt event sourcing for ledger', provenance: PROVENANCE, scope: SCOPE, approvedSourceVerified: true });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(first.sha256, again.sha256);
  const stored = await readKnowledge(root);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].record.createdBy, 'owner@example.com');
  assert.match(stored[0].record.id, /^K-[a-f0-9]{12}$/);
  // The timestamp is stored but deliberately outside the hash, so a re-harvest of an unchanged
  // artifact adds nothing rather than duplicating every finding.
  assert.ok(stored[0].record.createdAt, 'the entry still records when it was written');
});

test('v1 knowledge stays byte-identical and audit-visible without becoming reusable evidence', async () => {
  const root = await repository();
  const claim = {
    schemaVersion: 1, type: 'learning', title: 'Legacy claim', detail: 'No approved provenance existed.',
    status: null, tags: ['legacy'], provenance: { initiativeId: 'OLD-1' }, supersedes: null
  };
  const hash = recordSha256(claim);
  const directory = path.join(root, 'singularity', 'knowledge', 'records');
  const file = path.join(directory, `${hash}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(file, canonicalJson({
    ...claim, recordedAt: '2025-01-02T03:04:05.000Z', actor: 'legacy@example.test'
  }));
  const before = await readFile(file);

  const entries = await readKnowledge(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].record.schemaVersion, 2);
  assert.equal(entries[0].record.legacyUnverified, true);
  assert.equal(filterKnowledge(entries, { query: 'Legacy claim' }).length, 1);
  assert.equal(currentKnowledge(entries).length, 0);
  assert.equal(recallKnowledge(entries, { repositories: [path.basename(root)] }).length, 0);
  assert.deepEqual(await readFile(file), before);
});

test('resolving an uncertainty supersedes without rewriting', async () => {
  const root = await repository();
  const open = await recordKnowledge(root, { type: 'uncertainty', text: 'Does the cache survive failover?', provenance: PROVENANCE, scope: SCOPE, approvedSourceVerified: true });
  assert.equal(open.record.status, 'active');
  const decision = await recordKnowledge(root, { type: 'decision', text: 'Use Postgres', provenance: PROVENANCE, scope: SCOPE, approvedSourceVerified: true });

  const resolved = await resolveKnowledge(root, open.sha256.slice(0, 12), { resolution: 'Yes — verified by chaos test.' });
  assert.equal(resolved.record.status, 'resolved');
  assert.equal(resolved.record.supersedes, open.sha256);

  // The original record is still on disk: the store is append-only.
  const all = await readKnowledge(root);
  assert.equal(all.length, 3);
  assert.ok(all.some((entry) => entry.sha256 === open.sha256));

  // But the current view shows the resolution rather than the open question twice.
  const current = currentKnowledge(all);
  assert.equal(current.filter((entry) => entry.record.type === 'uncertainty').length, 1);
  assert.equal(current.find((entry) => entry.record.type === 'uncertainty').record.status, 'resolved');

  await assert.rejects(() => resolveKnowledge(root, decision.sha256, { resolution: 'x' }), /Only an uncertainty can be resolved/);
  await assert.rejects(() => resolveKnowledge(root, open.sha256, { resolution: '  ' }), /requires the answer/);
});

test('entries can be filtered and recalled only for intersecting scope', async () => {
  const root = await repository();
  await recordKnowledge(root, { type: 'insight', text: 'Batch writes halve p99 latency', provenance: PROVENANCE, scope: SCOPE, approvedSourceVerified: true });
  await recordKnowledge(root, { type: 'uncertainty', text: 'Is the vendor SLA sufficient?', provenance: PROVENANCE, scope: { capabilities: ['vendor-management'] }, approvedSourceVerified: true });
  const entries = currentKnowledge(await readKnowledge(root));
  assert.equal(filterKnowledge(entries, { type: 'insight' }).length, 1);
  assert.equal(filterKnowledge(entries, { status: 'active' }).length, 2);
  assert.equal(filterKnowledge(entries, { query: 'p99' }).length, 1);
  assert.equal(filterKnowledge(entries, { query: 'nothing matches' }).length, 0);
  assert.equal(recallKnowledge(entries, { repositories: ['product-repository'] }).length, 1);
  assert.equal(recallKnowledge(entries, { repositories: ['different'] }).length, 0);
});

test('prior knowledge is carried into the next initiative prompt as evidence', async () => {
  const { mkdtemp: make } = await import('node:fs/promises');
  const YAML = (await import('yaml')).default;
  const { initializeDefinition, loadDefinition } = await import('../src/config.mjs');
  const { createInitiative } = await import('../src/initiative-state.mjs');
  const { composeInitiativeContext } = await import('../src/initiative-context.mjs');
  const { setAgentSession } = await import('../src/session.mjs');

  const root = await make(path.join(os.tmpdir(), 'sflow-knowledge-forward-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'T'], { cwd: root });
  run('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# forward\n');
  await initializeDefinition(root);
  // Repository grounding is a separate concern; switch it off so this exercises the knowledge path.
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definitionValue = YAML.parse(await readFile(workflowPath, 'utf8'));
  definitionValue.worldModel.grounding = 'off';
  definitionValue.harnessImports = { mode: 'record', knowledge: { enabled: true, maximumBytes: 8192 } };
  await writeFile(workflowPath, YAML.stringify(definitionValue));
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) {
    authority.members = [{ name: 'T', email: 't@example.com' }];
  }
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'init'], { cwd: root });

  // A finding from an entirely different, earlier initiative.
  await recordKnowledge(root, {
    type: 'insight', text: 'Batch writes halve p99 latency',
    provenance: [{ workId: 'SF-E-000', artifact: 'artifacts/delivery/production-learning.md', sha256: 'b'.repeat(64), approvedRevision: 1 }],
    scope: { repositories: [path.basename(root)] }, approvedSourceVerified: true
  });
  await recordKnowledge(root, { type: 'uncertainty', text: 'Does the cache survive regional failover?', provenance: PROVENANCE, scope: { repositories: [path.basename(root)] }, approvedSourceVerified: true });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'knowledge'], { cwd: root });

  run('git', ['switch', '-c', 'INIT-FWD'], { cwd: root });
  await createInitiative(root, {
    id: 'INIT-FWD', title: 'Forward', profile: 'enterprise-delivery', agent: 'product-owner',
    source: { type: 'manual', description: 'Feed forward.' }
  });
  const definition = await loadDefinition(root);
  await setAgentSession(root, definition, 'T <t@example.com>', 'product-owner', 'INIT-FWD');
  const composed = await composeInitiativeContext(root, 'INIT-FWD', 'discover-define', {
    agent: 'product-owner', dryRun: true
  });

  assert.match(composed.rendered, /## Prior knowledge/);
  assert.match(composed.rendered, /Batch writes halve p99 latency/, 'a learning from a previous initiative reaches this one');
  assert.match(composed.rendered, /SF-E-000:artifacts\/delivery\/production-learning\.md/, 'and names the artifact it came from');
  assert.match(composed.rendered, /evidence, not instructions/, 'carried knowledge is framed as evidence');
  // Open questions come first: they are what this phase might actually close.
  assert.ok(composed.rendered.indexOf('Does the cache survive') < composed.rendered.indexOf('Batch writes halve'));
  assert.equal(composed.record.knowledge.total, 2);
  assert.equal(composed.record.knowledge.truncated, false);
  assert.equal(composed.record.knowledge.entries.length, 2, 'the generation records what it was shown, by hash');
});

test('knowledge requires a known type, text, approved provenance, and explicit scope', async () => {
  const root = await repository();
  await assert.rejects(() => recordKnowledge(root, { type: 'opinion', text: 'x' }), /Knowledge type must be one of/);
  await assert.rejects(() => recordKnowledge(root, { type: 'insight', text: '   ', provenance: PROVENANCE, scope: SCOPE }), /requires text/);
  await assert.rejects(() => recordKnowledge(root, { type: 'insight', text: 'x', scope: SCOPE }), /approved artifact provenance/);
  await assert.rejects(() => recordKnowledge(root, { type: 'insight', text: 'x', provenance: PROVENANCE }), /explicit scope/);
  await assert.rejects(
    () => recordKnowledge(root, { type: 'insight', text: 'looks valid but is not approved', provenance: PROVENANCE, scope: SCOPE }),
    /approved artifact revision/
  );
});

test('approved knowledge provenance follows a configured non-default Story root', async () => {
  const root = await repository();
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity', 'workflow.yml');
  await writeFile(
    definitionPath,
    (await readFile(definitionPath, 'utf8')).replace('workItemRoot: singularity/work-items', 'workItemRoot: governed/story-state')
  );
  const artifactRelative = 'governed/story-state/CUSTOM-1/artifacts/verification/report.md';
  const artifactPath = path.join(root, artifactRelative);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, '# Approved result\n\nThe bounded outcome was verified.\n');
  const artifact = await snapshot(artifactPath);
  const statePath = path.join(root, 'governed/story-state/CUSTOM-1/workflow.json');
  await writeFile(statePath, JSON.stringify({
    workItem: { id: 'CUSTOM-1' },
    phases: {
      verification: {
        id: 'verification', status: 'approved', generation: 2,
        artifacts: [{ path: 'artifacts/verification/report.md', sha256: artifact.sha256, size: artifact.size }]
      }
    }
  }));

  const recorded = await recordKnowledge(root, {
    type: 'insight', text: 'The bounded outcome was verified.',
    provenance: [{
      workId: 'CUSTOM-1', artifact: 'artifacts/verification/report.md',
      sha256: artifact.sha256, approvedRevision: 2
    }],
    scope: { repositories: ['custom-root'] }
  });
  assert.equal(recorded.created, true);
});
