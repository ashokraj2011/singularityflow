/**
 * SF Guard part 2, G4 [SPEC-SFG-v1 REQ-011, D3, AC-011]: Copilot work that belongs to no Story is
 * reconciled against the whole repository's declared set and shown by `guard report` (per agent,
 * skill and class, since a date) and `guard status`; and an agent file whose stamping hook was
 * removed or edited carries the drift label everywhere a label shows. Allow but label: nothing here
 * refuses, and a repository that never opted in reads exactly as before.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { recordObservedWrite } from '../src/comprehension/xpl2/observed-writes.mjs';
import { sfGuardStamp, sfGuardStampingHooks, writeSfGuardStampedAgents } from '../src/comprehension/xpl2/sf-guard-recorder.mjs';
import { agentFileDrift, agentStampDrift, readAgentDrift } from '../src/presence/agent-drift.mjs';
import {
  attributionBlock, attributionCardLines, attributionDigest, attributionGateWarnings, attributionLabels, sfGuardReport, sfGuardReportText
} from '../src/presence/attribution.mjs';
import { sfGuardDeclaredSet } from '../src/presence/declared-set.mjs';
import { reconcileChangeSet, workingTreeReader } from '../src/presence/reconcile.mjs';
import { sfGuardStampBlockText, withSfGuardStampBlock } from '../src/presence/stamp-block.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const CATALOG = [
  { id: 'developer', name: 'developer', file: '.github/agents/developer.agent.md', scope: 'repository', phases: ['implementation'], defaultFor: ['implementation'] },
  { id: 'product-owner', file: '.github/agents/product-owner.agent.md', scope: 'repository', phases: ['specification'], defaultFor: ['specification'] }
];
const ON = { folded: { enabled: true } };
const AGENT_TEXT = '---\nname: developer\ndescription: Builds.\n---\nBuild it.\n';
const stampedText = (agent = 'developer') => withSfGuardStampBlock(AGENT_TEXT, sfGuardStampBlockText(sfGuardStampingHooks(agent)));

async function fixture(t, { optIn = true } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sfg-g4-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Guard Tester'); git('config', 'user.email', 'guard@example.test');
  for (const name of ['plain', 'declared', 'mapped']) await writeFile(path.join(root, `src/${name}.js`), 'const a = 1;\nconst b = 2;\n');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  if (optIn) await writeFile(path.join(root, 'singularity/presence.json'), JSON.stringify({ schema: 'sflow-presence-chain@1', events: [{ seq: 0, kind: 'enable' }] }));
  await writeFile(path.join(root, 'singularity/agent-mappings.yml'), 'version: 1\nmappings:\n  enterprise-dev: developer\n');
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/developer.agent.md'), stampedText());
  git('add', '.'); git('commit', '-qm', 'baseline');
  const edit = async (sessionId, file, before, after) => {
    const decision = await repositoryToolGuard({ sessionId, cwd: root, toolName: 'edit', toolArgs: { path: path.join(root, file), old_str: before, new_str: after } });
    await writeFile(path.join(root, file), (await readFile(path.join(root, file), 'utf8')).replace(before, after));
    return decision;
  };
  const prompt = (sessionId, text) => recordRepositoryBoundaryTurn({ sessionId, timestamp: Date.now(), cwd: root, prompt: text });
  return { root, git, edit, prompt };
}

test('SFG AC-011 (pure): a stamp removed, edited or naming another agent is drift; the exact stamp, on any event, is not', async () => {
  const hooks = (agent, events) => sfGuardStampingHooks(agent, { events });
  assert.equal(agentStampDrift(hooks('developer', ['userPromptSubmitted']), 'developer', sfGuardStampingHooks), null);
  assert.equal(agentStampDrift(hooks('developer', ['userPromptSubmitted', 'subagentStart']), 'developer', sfGuardStampingHooks), null, 'D4: subagentStart too');
  assert.equal(agentStampDrift(null, 'developer', sfGuardStampingHooks), 'stamp-removed');
  assert.equal(agentStampDrift({ userPromptSubmitted: [{ type: 'command', command: 'echo hi' }] }, 'developer', sfGuardStampingHooks), 'stamp-removed', 'its own hooks only');
  const edited = hooks('developer', ['userPromptSubmitted']);
  edited.userPromptSubmitted[0] = { ...edited.userPromptSubmitted[0], timeoutSec: 1 };
  assert.equal(agentStampDrift(edited, 'developer', sfGuardStampingHooks), 'stamp-edited');
  assert.equal(agentStampDrift(hooks('qa', ['userPromptSubmitted']), 'developer', sfGuardStampingHooks), 'stamp-edited', 'stamping as another agent');
  assert.equal(agentStampDrift(hooks('developer', ['subagentStart']), 'developer', sfGuardStampingHooks), 'stamp-edited', 'the prompt stamp is gone');
  assert.equal(await agentFileDrift(stampedText(), 'developer'), null);
  assert.equal(await agentFileDrift(stampedText().replace('Build it.', 'Build it, carefully.'), 'developer'), null, 'other bytes: G2\'s "changed", not drift');
  assert.equal(await agentFileDrift(AGENT_TEXT, 'developer'), 'stamp-removed');
  assert.equal(await agentFileDrift(stampedText().replace('agent-stamp developer', 'agent-stamp product-owner'), 'developer'), 'stamp-edited');
  assert.equal(await agentFileDrift('no frontmatter', 'developer'), 'stamp-removed');
  assert.equal(await agentFileDrift(`${stampedText()}`.replace(/\n---\n/u, '\n'), 'developer'), 'stamp-edited', 'broken frontmatter still holding a stamp');
  assert.equal(await agentFileDrift(null, 'developer'), 'file-removed');
});

test('SFG AC-011: the drift label is sealed in the block and shows in its labels, card, summary and the final check — and refuses nothing', () => {
  const report = { lines: 3, files: 1, removed: 0, counts: { declared: 3 }, ranges: [], partial: null, scope: { base: 'abc' } };
  const plain = attributionBlock(report);
  assert.equal(plain.agentDrift, undefined, 'no drift, no field: earlier packets are unchanged');
  const drift = [{ id: 'developer', path: '.github/agents/developer.agent.md', drift: 'stamp-removed' }];
  const block = attributionBlock(report, { agentDrift: drift });
  assert.deepEqual(block.agentDrift, drift);
  assert.equal(block.sha256, attributionDigest(block));
  assert.notEqual(attributionDigest({ ...block, agentDrift: [] }), block.sha256, 'removing the label breaks its seal');
  const labels = attributionLabels(block);
  assert.ok(labels.includes('Agent file drift: developer (.github/agents/developer.agent.md) — stamping hook removed since it was stamped, so its stamps no longer prove which agent ran'), labels.join('\n'));
  assert.match(attributionCardLines(block)[0], /^SF Guard labels: 3 declared \(lines\) · agent file drift: developer$/u);
  const workflow = { phaseOrder: ['implementation'], phases: { implementation: { generation: 1 } },
    lineage: { submissions: [{ phase: 'implementation', generation: 1, projection: { attribution: block } }] } };
  assert.match(attributionGateWarnings(workflow)[0], /^SF Guard labels \(advisory\) for implementation: Agent file drift: developer/u);
  assert.deepEqual(attributionGateWarnings({ ...workflow, lineage: { submissions: [{ phase: 'implementation', generation: 1, projection: { attribution: plain } }] } }), []);
});

test('SFG REQ-011: a reconcile outside Stories leaves lines a Story\'s record explains to that Story', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'src/plain.js'), 'const a = 1;\nconst b = 3;\n');
  const writer = { kind: 'copilot-session', session: 's', turn: 't', skill: null, agent: null, attribution: { agent: null, agentSource: 'none', skill: null } };
  await recordObservedWrite(path.join(f.root, '.git'), { source: 'copilot-hook', tool: 'edit', writer, subject: { workId: 'STORY-1', phase: 'implementation', generation: null },
    files: [{ path: 'src/plain.js', verified: true, before: sha('const a = 1;\nconst b = 2;\n'), after: sha('const a = 1;\nconst b = 3;\n'), steps: [[2, 1, 2, 1]] }] });
  const files = [{ path: 'src/plain.js', added: [[2, 2]], removed: 1 }];
  const reader = workingTreeReader(f.root);
  const { readObservedWrites } = await import('../src/comprehension/xpl2/observed-writes.mjs');
  const writes = (await readObservedWrites(path.join(f.root, '.git'), { paths: ['src/plain.js'] })).records;
  const declared = sfGuardDeclaredSet({ agents: CATALOG });
  const everything = await reconcileChangeSet({ files, readCurrent: reader, writes, declared });
  assert.deepEqual([everything.lines, everything.counts['outside-workflow'], everything.inStories], [1, 1, undefined]);
  const outside = await reconcileChangeSet({ files, readCurrent: reader, writes, declared, skipSubject: (subject) => Boolean(subject?.workId) });
  assert.deepEqual([outside.lines, outside.inStories, outside.ranges.length], [0, 1, 0]);
});

test('SFG REQ-011/D3: guard report reconciles work outside any Story against the whole repository, per agent, skill and class, since a date', async (t) => {
  const f = await fixture(t);
  // Plain Copilot (D1); the stamped developer; a Copilot agent agent-mappings.yml maps onto the developer.
  await f.prompt('s-plain', 'Make b three.');
  assert.deepEqual(await f.edit('s-plain', 'src/plain.js', 'const b = 2;', 'const b = 3;'), {}, 'nothing refused');
  await f.prompt('s-plain', 'Thanks.');
  await f.prompt('s-dev', 'Make a ten.');
  await sfGuardStamp('developer', 'userPromptSubmitted', { sessionId: 's-dev', cwd: f.root, prompt: 'Make a ten.' });
  assert.deepEqual(await f.edit('s-dev', 'src/declared.js', 'const a = 1;', 'const a = 10;'), {});
  await f.prompt('s-dev', 'Thanks.');
  await f.prompt('s-map', 'Make a two.');
  await sfGuardStamp('enterprise-dev', 'userPromptSubmitted', { sessionId: 's-map', cwd: f.root, prompt: 'Make a two.' });
  assert.deepEqual(await f.edit('s-map', 'src/mapped.js', 'const a = 1;', 'const a = 2;'), {});
  await f.prompt('s-map', 'Thanks.');
  // A person in another editor: unattributed, never "person".
  await writeFile(path.join(f.root, 'src/person.js'), 'export const person = 1;\n');

  const report = await sfGuardReport(f.root, { definition: { agentCatalog: CATALOG }, policy: ON });
  const outside = report.subjects.find((subject) => subject.scope === 'repository');
  assert.deepEqual(outside.counts, { declared: 2, 'outside-workflow': 1, 'unknown-agent': 0, shell: 0, unattributed: 0, 'pre-guard': 0 });
  assert.ok(outside.groups.some((group) => group.classification === 'declared' && group.agent === 'enterprise-dev'), 'agent-mappings.yml counts');
  assert.equal(report.repository.status, 'complete');
  assert.deepEqual(report.repository.attribution.counts, { declared: 2, 'outside-workflow': 1, 'unknown-agent': 0, shell: 0, unattributed: 1, 'pre-guard': 0 });
  assert.ok(report.repository.labels.includes('Produced outside the workflow: agent none, skill none (1 line in 1 file)'), report.repository.labels.join('\n'));
  assert.deepEqual(report.agentDrift, []);
  const text = sfGuardReportText(report);
  assert.match(text, /Outside any Story:\n {4}outside-workflow: 1 edit — agent none, skill none\n {4}declared: 1 edit — agent developer, skill none/u);
  assert.match(text, /Lines changed here outside any Story \(uncommitted and unpushed, since HEAD\):\n {4}Declared ✓ \(2 lines\)\n {4}Produced outside the workflow: agent none, skill none \(1 line in 1 file\)\n {4}Unattributed \(1 line\)/u);
  // --since: the recorded calls are windowed; the lines are what is changed now.
  const later = await sfGuardReport(f.root, { definition: { agentCatalog: CATALOG }, policy: ON, since: new Date(Date.now() + 60_000).toISOString() });
  assert.deepEqual([later.subjects.length, later.repository.attribution.lines], [0, 4]);
  // guard status's summary reads no Git: lines: false.
  const quick = await sfGuardReport(f.root, { definition: { agentCatalog: CATALOG }, policy: ON, since: '7d', lines: false });
  assert.equal(quick.repository, undefined);
});

test('SFG AC-011: a stamped agent file whose hook is edited or removed shows as drift in guard report, and not before', async (t) => {
  const f = await fixture(t);
  const agentFile = path.join(f.root, '.github/agents/developer.agent.md');
  await writeSfGuardStampedAgents(f.root, [{ id: 'developer', path: '.github/agents/developer.agent.md', sha256: sha(await readFile(agentFile)) }]);
  assert.deepEqual(await readAgentDrift(f.root), []);
  await writeFile(agentFile, stampedText().replace('Build it.', 'Build it well.'));
  assert.deepEqual(await readAgentDrift(f.root), [], 'other bytes changed, stamp intact: guard status\'s "changed"');
  await writeFile(agentFile, stampedText().replace('timeoutSec: 10', 'timeoutSec: 1'));
  assert.deepEqual(await readAgentDrift(f.root), [{ id: 'developer', path: '.github/agents/developer.agent.md', drift: 'stamp-edited' }]);
  await writeFile(agentFile, AGENT_TEXT);
  const report = await sfGuardReport(f.root, { definition: { agentCatalog: CATALOG }, policy: ON });
  assert.deepEqual(report.agentDrift, [{ id: 'developer', path: '.github/agents/developer.agent.md', drift: 'stamp-removed' }]);
  assert.deepEqual(report.repository.attribution.agentDrift, report.agentDrift, 'the repository labels carry it too');
  assert.match(sfGuardReportText(report), /\n {2}Agent file drift: developer \(\.github\/agents\/developer\.agent\.md\) — stamping hook removed since it was stamped/u);
  await rm(agentFile);
  assert.equal((await readAgentDrift(f.root))[0].drift, 'file-removed');
});

test('SFG REQ-060: a repository that never opted in reports exactly as before', async (t) => {
  const f = await fixture(t, { optIn: false });
  await writeFile(path.join(f.root, 'src/plain.js'), 'const a = 1;\nconst b = 3;\n');
  await writeSfGuardStampedAgents(f.root, [{ id: 'developer', path: '.github/agents/developer.agent.md', sha256: sha('other') }]);
  const report = await sfGuardReport(f.root, { definition: { agentCatalog: CATALOG }, policy: { folded: { enabled: false } } });
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'resultType', 'sfGuard', 'recording', 'since', 'story', 'totals', 'subjects', 'storyLabels', 'gaps', 'lastGap']);
  assert.deepEqual([report.sfGuard, report.recording, report.subjects], ['off', 'off', []]);
  assert.doesNotMatch(sfGuardReportText(report), /outside any Story \(|Agent file drift/u);
});
