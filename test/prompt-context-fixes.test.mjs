import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { constitutionPromptContext } from '../src/constitution-prompt.mjs';
import { expandedOnDemandSkills } from '../src/retained-skill-instructions.mjs';
import { renderAutoAuthoringPrompt } from '../src/auto/auto-phase-contract.mjs';
import { withoutAttachedSkills, withoutTableSection } from '../src/skill-library.mjs';
import { stakeholderRequestDigests, stakeholderRequestDrift, STAKEHOLDER_PROMPT_RENDERER } from '../src/stakeholder-prompt-context.mjs';
import { turnBoundaryErrors } from '../scripts/skill-policy.mjs';
import { agentJson, agentOrIndentedJson } from '../src/agent-packet-presentation.mjs';

const CONSTITUTION = [
  '---',
  'articles:',
  '  - id: TST-001',
  '    type: judged',
  '    level: must',
  '    evidenceRequired: true',
  '  - id: TST-002',
  '    type: judged',
  '    level: should',
  '    evidenceRequired: false',
  '  - id: TST-003',
  '    type: judged',
  '    level: must',
  '    evidenceRequired: false',
  '    status: withdrawn',
  '---',
  '',
  '# Team constitution',
  '',
  '## [TST-001] Every change can be undone',
  '',
  'State how the change is reverted.',
  '<!-- singularity-flow:constitution:generated TST-001 -->',
  '',
  '## [TST-002] Prefer boring technology',
  '',
  'Say why when you choose otherwise.',
  '',
  '## [TST-003] Old rule',
  '',
  'Withdrawn.',
  ''
].join('\n');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const pinFor = (text, extra = {}) => ({ path: 'singularity/constitution.md', fileSha256: sha256(text), configurationCommit: null,
  articles: [{ id: 'TST-001', type: 'judged', status: 'active', level: 'must', evidenceRequired: true },
    { id: 'TST-002', type: 'judged', status: 'active', level: 'should', evidenceRequired: false },
    { id: 'TST-003', type: 'judged', status: 'withdrawn', level: 'must', evidenceRequired: false }], ...extra });
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test('the phase prompt carries exactly the pinned constitution, never a newer one', async (t) => {
  // Publication checks citations against the pin and review lists articles in scope, but the
  // composer never delivered the articles: an author was asked to cite rules it was never shown.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-constitution-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await constitutionPromptContext(root, { workItem: { id: 'C-1' }, resolution: {} }), { text: '', record: null });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Constitution Test');
  git(root, 'config', 'user.email', 'constitution@example.test');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/constitution.md'), CONSTITUTION);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'constitution');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const workflow = { workItem: { id: 'C-1', baseCommit }, resolution: { constitutionPin: pinFor(CONSTITUTION) } };

  const current = await constitutionPromptContext(root, workflow);
  assert.equal(current.record.from, 'checkout');
  assert.match(current.text, /^# Pinned constitution\n/u);
  assert.match(current.text, /## \[TST-001\] Every change can be undone \(judged, must, evidence required\)\n\nState how the change is reverted\./u);
  assert.match(current.text, /## \[TST-002\] Prefer boring technology \(judged, should\)/u);
  assert.doesNotMatch(current.text, /singularity-flow:constitution:generated/u, 'generated-block markers are not prose');
  assert.doesNotMatch(current.text, /## \[TST-003\]/u);
  assert.match(current.text, /Withdrawn, for reference only: TST-003\./u);

  // The constitution moved on after the Story started: the pinned copy comes from the base commit.
  await writeFile(path.join(root, 'singularity/constitution.md'), CONSTITUTION.replace('Prefer boring', 'Prefer exciting'));
  const moved = await constitutionPromptContext(root, workflow);
  assert.equal(moved.record.from, 'base-commit');
  assert.match(moved.text, /Prefer boring technology/u);
  assert.doesNotMatch(moved.text, /Prefer exciting/u);

  // No copy matches: identities only, and a plain warning not to use a newer version.
  const lost = await constitutionPromptContext(root, { workItem: { id: 'C-1', baseCommit: null },
    resolution: { constitutionPin: pinFor('different bytes') } });
  assert.equal(lost.record.available, false);
  assert.match(lost.text, /exact text is not available in this checkout/u);
  assert.match(lost.text, /- TST-001 \(judged, must, evidence required\)\n- TST-002 \(judged, should\)\n- TST-003 \(judged, must, withdrawn\)/u);
});

test('the persona section leaves out the skill tables the skills section already renders', () => {
  const agent = ['# Developer', '', 'Keep changes small.', '', '## Attached skills', '', '| Skill | Phases | When to use it |', '|---|---|---|',
    '| review | build | Before publishing |', '', '## Remote skills', '', '| ID | URL | Phases | Optional | Max bytes |', '|---|---|---|---|---|',
    '| lint | https://example.test/lint.md | build | false | 4096 |', '', '## Notes', '', 'Ask when unsure.'].join('\n');
  const persona = withoutTableSection(withoutAttachedSkills(agent), 'Remote skills');
  assert.doesNotMatch(persona, /Attached skills|Remote skills|example\.test/u);
  assert.match(persona, /# Developer\n\nKeep changes small\.\n\n## Notes\n\nAsk when unsure\./u);
  assert.equal(withoutTableSection('# Agent\n\nNothing to strip.', 'Remote skills'), '# Agent\n\nNothing to strip.');
});

test('a turn-boundary marker must name the mode the mutation guard enforces', () => {
  assert.deepEqual(turnBoundaryErrors('sflow-decide', '<!-- sflow-turn-boundary: decision-only -->'), []);
  assert.deepEqual(turnBoundaryErrors('sflow-approve', '<!-- sflow-turn-boundary: approval-only -->'), []);
  assert.deepEqual(turnBoundaryErrors('sflow-decide', '<!-- sflow-turn-boundary: approval-only -->'),
    ["sflow-decide: turn-boundary marker 'approval-only' differs from the enforced turn mode 'decision-only'"]);
  assert.deepEqual(turnBoundaryErrors('sflow-next', 'no marker here'), []);
});

test('Auto receives the on-demand skills it cannot fetch; other prompts are unchanged', () => {
  const skill = (id, loading, body) => ['---', `name: ${id}`, `description: ${id} procedure.`, 'metadata:', `  sflow-label: ${id} label`,
    `  sflow-loading: ${loading}`, '---', '', body, ''].join('\n');
  const context = { identity: { mode: 'workflow-snapshot' }, dependencies: [
    { source: 'library', inclusion: 'included', id: 'eager-one', phases: ['build'], text: skill('eager-one', 'eager', 'Always do this.') },
    { source: 'library', inclusion: 'included', id: 'late-one', phases: ['build'], use: 'When the build breaks', text: skill('late-one', 'on-demand', 'Bisect the failure.') },
    { source: 'library', inclusion: 'included', id: 'other-step', phases: ['ship'], text: skill('other-step', 'on-demand', 'Not this step.') }
  ] };
  const expanded = expandedOnDemandSkills({ id: 'build' }, context);
  assert.match(expanded, /^# On-demand skills, expanded for this run\n/u);
  assert.match(expanded, /## Skill: late-one label \(`late-one`\)\n\nWhen to use it: When the build breaks\n\nBisect the failure\./u);
  assert.doesNotMatch(expanded, /Always do this|Not this step/u);
  assert.equal(expandedOnDemandSkills({ id: 'build' }, { identity: { mode: 'legacy-live' }, dependencies: context.dependencies }), '');

  const base = { composed: '# Composed', flightId: 'F-1', attemptId: 'A-1', state: { counters: {}, story: { phase: 'build' }, evidence: {} },
    plan: { planId: 'P-1', planSha256: 'sha256:1', requirement: { text: 'Do it' }, proposal: { predictedPaths: [] } } };
  const without = renderAutoAuthoringPrompt(base);
  assert.equal(renderAutoAuthoringPrompt({ ...base, onDemandSkills: '' }), without, 'no on-demand skills: byte-identical prompt');
  const withSkills = renderAutoAuthoringPrompt({ ...base, onDemandSkills: expanded });
  assert.ok(withSkills.indexOf('# On-demand skills') > withSkills.indexOf('# Composed'));
  assert.ok(withSkills.indexOf('# On-demand skills') < withSkills.indexOf('# Ratified Auto execution boundary'));
});

test('a pending prompt is stale once a change request for its phase opens or closes', () => {
  const request = { id: 'CR-1', status: 'open', targetPhase: 'build', clauseIds: ['X:AC-001'], comment: 'Handle the empty case.' };
  const projection = { renderer: STAKEHOLDER_PROMPT_RENDERER, requests: stakeholderRequestDigests([request]) };
  assert.equal(stakeholderRequestDrift(projection, [request]), null);
  assert.equal(stakeholderRequestDrift(projection, []), 'open stakeholder change requests changed');
  assert.equal(stakeholderRequestDrift(projection, [request, { ...request, id: 'CR-2' }]), 'open stakeholder change requests changed');
  assert.equal(stakeholderRequestDrift(projection, [{ ...request, comment: 'Edited.' }]), 'open stakeholder change requests changed');
  assert.equal(stakeholderRequestDrift(null, [request]), null, 'a record from before requests were projected is left alone');
  assert.equal(stakeholderRequestDrift({ renderer: 'stakeholder-requests-v1', requests: [] }, [request]), null);
});

test('agent JSON stays compact but pages by line: one top-level field, or list element, per line', () => {
  const value = { ready: true, next: [{ id: 'a' }, { id: 'b', note: undefined }], context: { text: 'x\ny' }, empty: [], skipped: undefined, fn() {} };
  const text = agentJson(value);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(value)), 'the same data as JSON.stringify');
  assert.deepEqual(text.split('\n'), ['{', '"ready":true,', '"next":[', '{"id":"a"},', '{"id":"b"}', '],', '"context":{"text":"x\\ny"},', '"empty":[]', '}']);
  assert.equal(agentJson([1, 2]), '[1,2]');
  assert.equal(agentJson({}), '{}');
  assert.equal(agentOrIndentedJson(false, { a: 1 }), '{\n  "a": 1\n}', 'people keep the indented form');
});
