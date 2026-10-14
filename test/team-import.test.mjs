import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { captureTeamDirectory } from '../src/team-import/capture.mjs';
import { recognizeFormat } from '../src/team-import/formats.mjs';
import { inspectTeamDirectory } from '../src/team-import/inspect.mjs';
import { compileTeamImport } from '../src/team-import/compile.mjs';
import { listTeamImportSessions, pruneTeamImportSessions, readTeamImportSession } from '../src/team-import/session.mjs';
import { applyWorkflowImport, compileWorkflowBundle, importResolutionOptions, planWorkflowImport, readWorkflowBundle } from '../src/workflow-transfer.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { fixtureCandidate, teamFixture, writeCandidate } from './helpers/team-import-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function inspected(t, options = {}) {
  const f = await teamFixture(t, options.files);
  const inspection = await inspectTeamDirectory(f.team, { env: f.env, issue: f.issue, entries: options.entries ?? [] });
  return { ...f, inspection };
}

async function compiled(t, edit, options = {}) {
  const f = await inspected(t);
  await writeCandidate(f.inspection, fixtureCandidate(f.inspection, edit));
  const result = await compileTeamImport(f.inspection.session.id, { env: f.env, dryRun: true, ...options });
  return { ...f, result };
}

test('each supported source format is recognised by path, and the hidden-tool layout by shape alone [TAWI:AC-022]', () => {
  const tools = new Set(['acme']);
  const cases = {
    '.github/agents/plan.agent.md': 'copilot-agent', 'team/x.agent.md': 'copilot-agent',
    '.github/chatmodes/a.chatmode.md': 'copilot-chatmode', '.github/instructions/api.instructions.md': 'scoped-instructions',
    '.github/copilot-instructions.md': 'repository-instructions', '.github/prompts/p.prompt.md': 'prompt-file',
    'skills/s/SKILL.md': 'skill', '.acme/skills/s/SKILL.md': 'skill', 'AGENTS.md': 'agents-md', 'sub/AGENTS.md': 'agents-md',
    '.acme/agents/rev.md': 'tool-agent', 'ACME.md': 'tool-instructions', '.acme/ACME.md': 'tool-instructions',
    'README.md': null, 'OTHER.md': null, 'sub/ACME.md': null, '.acme/agents/sub/x.md': null, 'SKILL.md': null
  };
  for (const [file, format] of Object.entries(cases)) assert.equal(recognizeFormat(file, tools), format, file);
  assert.equal(recognizeFormat('ACME.md', new Set()), null, 'an upper-case file is a tool instruction file only beside its directory');
});

test('capture screens secrets, never opens blocked paths, and resolves references deterministically [TAWI:AC-021]', async (t) => {
  const f = await teamFixture(t, { 'docs/uses-notes.md': 'See [notes](notes.md) and [web](https://example.com/x) and [up](../../outside.md).\n',
    '.github/agents/linker.agent.md': '---\nname: linker\ndescription: Links.\n---\nRead [usage](../../docs/uses-notes.md) and [gone](missing.md).\n' });
  const { capture, contents } = await captureTeamDirectory(f.team);
  const byPath = new Map(capture.files.map((file) => [file.path, file]));
  assert.equal(byPath.get('docs/notes.md').screening, 'withheld');
  assert.ok(byPath.get('docs/notes.md').findings.length);
  assert.equal(contents.has('docs/notes.md'), false, 'a withheld file is never returned');
  assert.equal(byPath.get('docs/tokens.md').screening, 'blocked');
  assert.equal(byPath.get('docs/tokens.md').sha256, undefined, 'a blocked file is never opened');
  const statusOf = (written) => capture.references.find((reference) => reference.written === written);
  assert.equal(statusOf('notes.md').status, 'excluded');
  assert.match(statusOf('notes.md').reason, /secret scan/u);
  assert.equal(statusOf('https://example.com/x').status, 'unsupported');
  assert.equal(statusOf('../../outside.md').status, 'excluded');
  assert.equal(statusOf('missing.md').status, 'missing');
  assert.equal(statusOf('@reviewer').target, '.acme/agents/reviewer.md', 'names resolve across formats');
  assert.deepEqual(capture.entryCandidates.map((candidate) => candidate.id), ['delivery-lead']);
  const again = await captureTeamDirectory(f.team);
  assert.equal(again.capture.sha256, capture.sha256, 'the same directory captures to the same digest');
});

test('capture never follows a symbolic link and skips build directories', { skip: process.platform === 'win32' }, async (t) => {
  const f = await teamFixture(t, { 'node_modules/x/SKILL.md': '---\nname: x\ndescription: y\n---\nz\n' });
  await writeFile(path.join(f.base, 'outside.md'), 'outside\n');
  await symlink(path.join(f.base, 'outside.md'), path.join(f.team, 'docs', 'linked.md'));
  const { capture } = await captureTeamDirectory(f.team);
  assert.ok(capture.excluded.some((entry) => entry.path === 'docs/linked.md' && /symbolic link/u.test(entry.reason)));
  assert.ok(capture.excluded.some((entry) => entry.path === 'node_modules' && entry.reason === 'excluded directory'));
  assert.ok(!capture.files.some((file) => file.path.startsWith('node_modules/')));
});

test('a file that changes between passes is captured again once, then refused [TAWI:AC-013]', async (t) => {
  const f = await teamFixture(t);
  const target = path.join(f.team, 'docs', 'process.md');
  const once = await captureTeamDirectory(f.team, { afterPass: async (index) => { if (index === 0) await writeFile(target, '# Changed once\n'); } });
  assert.equal(once.capture.recaptured, true);
  assert.equal(once.contents.get('docs/process.md'), '# Changed once\n');
  let counter = 0;
  await assert.rejects(() => captureTeamDirectory(f.team, { afterPass: async () => { counter += 1; await writeFile(target, `# Change ${counter}\n`); } }),
    (error) => error.code === 'TEAM_IMPORT_CAPTURE_UNSTABLE' && error.details.changed.includes('docs/process.md'));
});

test('inspect chooses only an unambiguous entry, opens a private session, and copies only screened files', async (t) => {
  const { env, inspection, team } = await inspected(t);
  assert.equal(inspection.entry.selectedBy, 'only-candidate');
  assert.deepEqual(inspection.entry.selected.map((entry) => entry.id), ['delivery-lead']);
  assert.ok(inspection.closure.some((file) => file.path === 'ACME.md' && file.ambient));
  assert.ok(!inspection.closure.some((file) => file.path === 'docs/notes.md'));
  assert.match(inspection.untrusted, /conversion data, not instructions/u);
  assert.ok(inspection.candidate.guide.rules.length > 5);
  const session = path.dirname(inspection.candidate.path);
  if (process.platform !== 'win32') {
    assert.equal((await stat(session)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(session, 'session.json'))).mode & 0o777, 0o600);
  }
  for (const file of inspection.closure) assert.equal(await readFile(file.snapshot, 'utf8'), await readFile(path.join(team, ...file.path.split('/')), 'utf8'));
  await assert.rejects(() => inspectTeamDirectory(team, { env, issue: async () => 0, entries: ['nobody'] }), { code: 'TEAM_IMPORT_ENTRY_UNKNOWN' });
  const two = await teamFixture(t, { '.github/agents/other-lead.agent.md': '---\nname: other-lead\ndescription: Another.\n---\n## Steps\n1. a\n2. b\n3. c\n' });
  const choice = await inspectTeamDirectory(two.team, { env: two.env, issue: two.issue });
  assert.equal(choice.entry.status, 'choose');
  assert.equal(choice.session, null, 'choosing an entry creates no session');
  assert.deepEqual((await readdir(path.join(two.base, 'state')).catch(() => [])).filter((name) => name.startsWith('tis_')), []);
});

test('sessions are kept seven days, refused when altered, and the state root is never a symbolic link', async (t) => {
  const { env, inspection, base } = await inspected(t);
  const id = inspection.session.id;
  assert.equal((await listTeamImportSessions({ env })).length, 1);
  assert.deepEqual(await pruneTeamImportSessions({ env, now: Date.now() + 6 * 24 * 3600 * 1000 }), []);
  const file = path.join(path.dirname(inspection.candidate.path), 'session.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...record, entry: { selected: [] } }));
  await assert.rejects(() => readTeamImportSession(id, { env }), { code: 'TEAM_IMPORT_SESSION_CORRUPT' });
  await writeFile(file, JSON.stringify(record));
  assert.deepEqual(await pruneTeamImportSessions({ env, now: Date.now() + 8 * 24 * 3600 * 1000 }), [id]);
  await assert.rejects(() => readTeamImportSession(id, { env }), { code: 'TEAM_IMPORT_SESSION_MISSING' });
  if (process.platform !== 'win32') {
    await mkdir(path.join(base, 'real-state'));
    await symlink(path.join(base, 'real-state'), path.join(base, 'linked-state'));
    await assert.rejects(() => listTeamImportSessions({ env: { ...env, SINGULARITY_FLOW_TEAM_IMPORT_STATE: path.join(base, 'linked-state') } }),
      { code: 'TEAM_IMPORT_STATE_UNSAFE' });
  }
});

test('a careful candidate compiles portable-ready, byte-identical every time, and imports into a fresh repository [TAWI:AC-001 AC-002 AC-003 AC-007 AC-018 AC-026]', async (t) => {
  const { env, inspection, base, result } = await compiled(t);
  assert.equal(result.state, 'portable-ready', JSON.stringify(result.findings, null, 2));
  assert.deepEqual(result.workflow.phases.map((phase) => [phase.id, phase.agent, phase.code]),
    [['delivery-plan', 'delivery-planner', false], ['delivery-build', 'delivery-builder', true], ['delivery-review', 'delivery-reviewer', false]]);
  assert.equal(result.routeSimulation.status, 'passed');
  assert.deepEqual(result.routeSimulation.counts, { pass: 1, route: 1, repair: 1, exhausted: 1, 'unavailable-evidence': 1, rejection: 1 });
  assert.equal(result.freshImport.status, 'passed');
  assert.equal(result.destination, null, 'no destination was checked, so the state is never destination-qualified');
  assert.ok(result.dispositions.some((entry) => entry.disposition === 'approximated' && /applyTo/u.test(entry.reason)));
  assert.equal(result.destinationPolicy.length, 2);
  const first = path.join(base, 'out', 'first.sflow-workflows.json');
  const second = path.join(base, 'out', 'second.sflow-workflows.json');
  const written = await compileTeamImport(inspection.session.id, { env, out: first });
  await compileTeamImport(inspection.session.id, { env, out: second });
  assert.equal(written.output.bundleSha256, result.bundleSha256);
  assert.equal(await readFile(first, 'utf8'), await readFile(second, 'utf8'));
  const bundle = await readWorkflowBundle(first);
  const skill = bundle.assets.find((asset) => asset.kind === 'skill');
  assert.match(skill.content, /<instruction>delivery-api-compat<\/instruction>/u, 'the instruction stays placed at its point of use');
  assert.ok(bundle.assets.some((asset) => asset.kind === 'instruction' && asset.id === 'delivery-api-compat'));
  assert.ok(!JSON.stringify(bundle).includes(base), 'no source-machine path enters the bundle');
});

test('a code phase keeps its checks and only it writes source; planning stays artifact-only [TAWI:AC-006 AC-008 AC-028]', async (t) => {
  const planner = await compiled(t, (candidate) => { candidate.phases[0].writeScope = 'source-and-artifact'; });
  assert.equal(planner.result.state, 'invalid');
  assert.ok(planner.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_CODE_SCOPE'));
  const unchecked = await compiled(t, (candidate) => { delete candidate.phases[1].qualityCommands; });
  assert.equal(unchecked.result.state, 'needs-decision');
  assert.ok(unchecked.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_QUALITY_COMMAND_MISSING' && finding.owner === 'person'));
  const invented = await compiled(t, (candidate) => { candidate.phases[1].qualityCommands[0].evidence = []; });
  assert.ok(invented.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_EVIDENCE_MISSING'));
});

test('open questions hold the state at needs-decision until a person answers with one of their choices [TAWI:AC-009 AC-023]', async (t) => {
  const { env, inspection, result } = await compiled(t, (candidate) => {
    candidate.decisionsNeeded = [{ id: 'retry-bound', question: 'How many test rounds before the lead decides?', choices: ['3', '5'], blocking: true }];
    candidate.mappings.push({ sourceItem: 'retry-bound-choice', evidence: [candidate.phases[1].qualityCommands[0].evidence[0]], target: 'decision:delivery-tests', disposition: 'mapped',
      kind: 'inferred', material: true, decision: 'retry-bound' });
  });
  assert.equal(result.state, 'needs-decision');
  assert.deepEqual(result.questions.map((question) => question.id), ['retry-bound']);
  await assert.rejects(() => compileTeamImport(inspection.session.id, { env, dryRun: true, answers: ['retry-bound=7'] }), { code: 'TEAM_IMPORT_ANSWER_INVALID' });
  const answered = await compileTeamImport(inspection.session.id, { env, dryRun: true, answers: ['retry-bound=3'] });
  assert.equal(answered.state, 'portable-ready');
  assert.equal((await compileTeamImport(inspection.session.id, { env, dryRun: true })).state, 'portable-ready', 'answers stay recorded in the session');
});

test('unrepresentable behaviour is unsupported, never relabelled [TAWI:AC-010 AC-024]', async (t) => {
  const { result } = await compiled(t, (candidate) => {
    candidate.prerequisites = [{ id: 'deploy-script', kind: 'script', description: 'scripts/deploy.sh runs after review.', evidence: [] }];
    candidate.mappings.push({ sourceItem: 'auto-escalate', evidence: [{ ...candidate.mappings[0].evidence[0], startLine: 12, endLine: 12 }],
      target: 'none', disposition: 'unsupported', kind: 'explicit', reason: 'The source escalates automatically when retries run out; SFlow always pauses for the by group.' });
  });
  assert.equal(result.state, 'unsupported');
  assert.deepEqual(result.prerequisites.map((entry) => entry.kind), ['script']);
});

test('IDs never collide: case-insensitively inside the candidate, or with any SFlow baseline [TAWI:AC-012 AC-020]', async (t) => {
  const clash = await compiled(t, (candidate) => { candidate.agents.push({ ...candidate.agents[0], id: 'delivery-planner'.toUpperCase().toLowerCase() }); });
  assert.ok(clash.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_CANDIDATE_ID_COLLISION'));
  assert.equal(clash.result.state, 'invalid');
  const baseline = await compiled(t, (candidate) => {
    // Namespace "demo" walks into the packaged demo workflows' own IDs.
    candidate.namespace = 'demo';
    const text = JSON.stringify(candidate).replace(/"delivery-([a-z-]+)"/gu, '"demo-$1"').replace(/"delivery\/([a-z-]+\.md)"/gu, '"demo/$1"')
      .replace(/<instruction>delivery-/gu, '<instruction>demo-');
    Object.assign(candidate, JSON.parse(text));
    candidate.phases[0].id = 'demo-check';
    candidate.workflow.phases[0] = 'demo-check';
    candidate.phases[1].inputs = ['demo-check'];
    candidate.phases[2].inputs = ['demo-check', 'demo-build'];
  });
  assert.ok(baseline.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_ID_COLLISION' && finding.at === 'phase:demo-check'));
});

test('independence is never invented by renaming the author [TAWI:AC-025]', async (t) => {
  const { result } = await compiled(t, (candidate) => {
    candidate.workflow.sourceReview = { phases: ['delivery-plan'], reviewerAgent: 'delivery-planner' };
  });
  assert.ok(result.findings.some((finding) => finding.code === 'TEAM_IMPORT_REVIEWER_NOT_INDEPENDENT' && finding.owner === 'person'));
});

test('stale evidence, an unknown field and a changed source are refused, with the paths named [TAWI:AC-015]', async (t) => {
  const stale = await compiled(t, (candidate) => { candidate.mappings[1].evidence[0].sha256 = `sha256:${'0'.repeat(64)}`; candidate.extra = true; });
  assert.ok(stale.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_EVIDENCE_STALE'));
  assert.ok(stale.result.findings.some((finding) => finding.code === 'TEAM_IMPORT_CANDIDATE_FIELD_UNKNOWN' && finding.at === '$.extra'));
  const f = await inspected(t);
  await writeCandidate(f.inspection, fixtureCandidate(f.inspection));
  await writeFile(path.join(f.team, '.github', 'agents', 'planner.agent.md'), '---\nname: planner\ndescription: Changed.\n---\nChanged.\n');
  const changed = await compileTeamImport(f.inspection.session.id, { env: f.env, dryRun: true });
  assert.equal(changed.state, 'invalid');
  assert.match(changed.findings.find((finding) => finding.code === 'TEAM_IMPORT_SOURCE_CHANGED').message, /planner\.agent\.md/u);
});

test('the bundle is written only when ready, never over a file, never into configuration or the source [TAWI:AC-014]', async (t) => {
  const f = await inspected(t);
  await writeCandidate(f.inspection, fixtureCandidate(f.inspection, (candidate) => { delete candidate.phases[1].qualityCommands; }));
  const out = path.join(f.base, 'out', 'team.sflow-workflows.json');
  await assert.rejects(() => compileTeamImport(f.inspection.session.id, { env: f.env, out }), { code: 'TEAM_IMPORT_NOT_READY' });
  await assert.rejects(() => lstat(out), { code: 'ENOENT' });
  const labelled = await compileTeamImport(f.inspection.session.id, { env: f.env, out, allowNotReady: true });
  assert.equal(labelled.output.ready, false);
  await writeCandidate(f.inspection, fixtureCandidate(f.inspection));
  const before = await readFile(out, 'utf8');
  await assert.rejects(() => compileTeamImport(f.inspection.session.id, { env: f.env, out }), { code: 'WORKFLOW_EXPORT_OUTPUT_EXISTS' });
  assert.equal(await readFile(out, 'utf8'), before);
  await assert.rejects(() => compileTeamImport(f.inspection.session.id, { env: f.env, out: path.join(f.team, 'bundle.json') }), { code: 'TEAM_IMPORT_OUTPUT_UNSAFE' });
  const repository = path.join(f.base, 'repository');
  await mkdir(path.join(repository, '.git'), { recursive: true });
  await assert.rejects(() => compileTeamImport(f.inspection.session.id, { env: f.env, out: path.join(repository, 'singularity', 'x.json') }), { code: 'TEAM_IMPORT_OUTPUT_UNSAFE' });
});

test('a destination preview binds the plan; a destination that changes is refused at import [TAWI:AC-016 AC-017 AC-019]', async (t) => {
  const f = await inspected(t);
  await writeCandidate(f.inspection, fixtureCandidate(f.inspection));
  const destination = path.join(f.base, 'destination');
  await mkdir(destination);
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: destination, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  await initializeDefinition(destination);
  git('add', '-A');
  git('-c', 'user.name=Import Tester', '-c', 'user.email=import@example.invalid', 'commit', '-qm', 'init');
  const missing = await compileTeamImport(f.inspection.session.id, { env: f.env, dryRun: true, destination: path.join(f.base, 'nowhere') });
  assert.equal(missing.state, 'needs-decision', 'a destination that cannot be previewed is the person\'s to fix, not a candidate defect');
  assert.equal(missing.destination.status, 'unavailable');
  const result = await compileTeamImport(f.inspection.session.id, { env: f.env, dryRun: true, destination });
  assert.equal(result.state, 'ready-for-destination');
  assert.match(result.destination.planSha256, /^sha256:/u);
  assert.equal(result.destination.bundleSha256, result.bundleSha256);
  const out = path.join(f.base, 'delivery.sflow-workflows.json');
  await compileTeamImport(f.inspection.session.id, { env: f.env, out });
  const bundle = await readWorkflowBundle(out);
  const plan = await planWorkflowImport(destination, bundle, importResolutionOptions([], 'suggested'));
  const file = path.join(destination, 'singularity', 'workflow.yml');
  const original = await readFile(file, 'utf8');
  await writeFile(file, original.replace(/^version: 2$/mu, 'version: 2\n# changed'));
  await assert.rejects(() => applyWorkflowImport(destination, bundle, { expectedPlanSha256: plan.planSha256, ...importResolutionOptions([], 'suggested') }),
    { code: 'WORKFLOW_TRANSFER_PLAN_STALE' });
  await writeFile(file, original);
  const fresh = await planWorkflowImport(destination, bundle, importResolutionOptions([], 'suggested'));
  await applyWorkflowImport(destination, bundle, { expectedPlanSha256: fresh.planSha256, ...importResolutionOptions([], 'suggested') });
  // Round trip: export the imported workflow again; importing that bundle is all reuse.
  const exported = await compileWorkflowBundle(destination, ['delivery-flow']);
  const again = await planWorkflowImport(destination, exported, importResolutionOptions([], 'suggested'));
  assert.equal(again.status, 'ready');
  assert.equal(again.counts.add, 0, JSON.stringify(again.operations?.add ?? []));
});

test('the CLI runs inspect, compile and status with closed options and machine-local state', async (t) => {
  const f = await teamFixture(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), 'workflow', 'import-team', ...args], {
    cwd: f.base, encoding: 'utf8', env: { ...f.env, HOME: path.join(f.base, 'home'), USERPROFILE: path.join(f.base, 'home'), NODE_ENV: 'test',
      SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(f.base, 'home', 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'home', 'active.json') }
  });
  const inspection = run('inspect', 'team', '--json');
  assert.equal(inspection.status, 0, inspection.stderr);
  const value = JSON.parse(inspection.stdout);
  assert.equal(value.entry.selected[0].id, 'delivery-lead');
  await writeCandidate(value, fixtureCandidate(value));
  const compile = run('compile', '--session', value.session.id, '--out', 'delivery.sflow-workflows.json', '--json');
  assert.equal(compile.status, 0, compile.stderr || compile.stdout);
  assert.equal(JSON.parse(compile.stdout).state, 'portable-ready');
  assert.ok((await stat(path.join(f.base, 'delivery.sflow-workflows.json'))).isFile(), '--out resolves where the person ran it');
  const status = run('status', '--json');
  assert.equal(JSON.parse(status.stdout).sessions[0].state, 'portable-ready');
  const unknown = run('inspect', 'team', '--force');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /does not take --force/u);
  assert.match(run('apply').stderr, /no subcommand 'apply'/u);
});

test('the mistakes a live conversion made are all reported in one compile, with the shapes that fix them', async (t) => {
  // From a real Copilot run: a loop with phase/goal-text/by-string, omits as plain text, and a
  // source reviewer that also authors a phase and reviews the code step. Each used to cost one
  // repair round; the budget ran out before the candidate loaded.
  const { result, inspection } = await compiled(t, (candidate) => {
    candidate.workflow.decisions = [{ id: 'delivery-tests', kind: 'loop', phase: 'delivery-build', goal: 'npm test passes',
      back: 'delivery-build', maxRounds: 3, by: 'delivery-leads' }];
    candidate.workflow.omits = ['The team rules have no procedure.'];
    candidate.workflow.sourceReview = { phases: ['delivery-plan', 'delivery-build'], reviewerAgent: 'delivery-reviewer' };
  });
  const codes = result.findings.map((finding) => `${finding.code}@${finding.at}`);
  for (const expected of ['TEAM_IMPORT_DECISION_SHAPE@$.workflow.decisions[0].phase', 'TEAM_IMPORT_DECISION_SHAPE@$.workflow.decisions[0].after',
    'TEAM_IMPORT_DECISION_SHAPE@$.workflow.decisions[0].goal', 'TEAM_IMPORT_DECISION_SHAPE@$.workflow.decisions[0].by',
    'TEAM_IMPORT_DECISION_SHAPE@$.workflow.decisions[0].inputs', 'TEAM_IMPORT_DECISION_SHAPE@$.workflow.decisions[0].label',
    'TEAM_IMPORT_OMIT_SHAPE@$.workflow.omits[0]']) {
    assert.ok(codes.includes(expected), `${expected} in ${codes.join(', ')}`);
  }
  assert.equal(result.state, 'invalid');
  assert.ok(inspection.candidate.guide.examples.decisions.some((decision) => decision.kind === 'loop' && decision.goal && decision.inputs));
  const reviewer = await compiled(t, (candidate) => {
    candidate.workflow.sourceReview = { phases: ['delivery-plan', 'delivery-build'], reviewerAgent: 'delivery-reviewer' };
  });
  const reviewCodes = reviewer.result.findings.map((finding) => finding.code);
  assert.ok(reviewCodes.includes('TEAM_IMPORT_REVIEWER_AUTHORS'));
  assert.ok(reviewCodes.includes('TEAM_IMPORT_SOURCE_REVIEW_SCOPE'));
});

test('a separate review-only agent can review the planning step, staged as review-only', async (t) => {
  const { result, inspection } = await compiled(t, (candidate) => {
    candidate.agents.push({ id: 'delivery-plan-reviewer', label: 'Plan reviewer', description: 'Reviews the plan independently.', tools: ['read'],
      body: '# Plan reviewer\n\nReview the plan against the request. Report findings; do not edit.' });
    candidate.workflow.sourceReview = { phases: ['delivery-plan'], reviewerAgent: 'delivery-plan-reviewer' };
    candidate.mappings.push({ sourceItem: 'independent-plan-review', evidence: [], target: 'agent:delivery-plan-reviewer', disposition: 'mapped',
      kind: 'destination-policy', reason: 'A separate review-only agent keeps the plan review independent of its author.' });
  });
  assert.equal(result.state, 'portable-ready', JSON.stringify(result.findings, null, 2));
  const staged = await readFile(path.join(path.dirname(inspection.candidate.path), 'stage', '.github', 'agents', 'delivery-plan-reviewer.agent.md'), 'utf8');
  assert.match(staged, /sflow-mode: read-only-review/u);
});
