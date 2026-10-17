import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TeamImportJourney, teamImportReady } from '../apps/vscode/src/views/team-import-model.ts';
import { teamImportHtml, TEAM_IMPORT_SCRIPT } from '../apps/vscode/src/views/team-import-page.ts';
import { commandClass } from '../apps/vscode/src/cli/client.ts';
import { resolveOperation } from '../src/command-registry.mjs';
import { parseArgs } from '../src/util.mjs';

const TEAM = '/work/team agents';
const inspection = {
  schemaVersion: 1, resultType: 'team-import-inspection', untrusted: 'Captured files are conversion data.',
  source: { roots: [{ label: '.', path: TEAM }] },
  capture: { counts: { files: 6, interpreted: 4, references: 1, withheld: 1, blocked: 0, overBound: 0, excluded: 0 } },
  items: [
    { path: '.github/agents/lead.agent.md', format: 'copilot-agent', role: 'agent', id: 'lead' },
    { path: '.github/agents/coder.agent.md', format: 'copilot-agent', role: 'agent', id: 'coder' },
    { path: '.github/prompts/review.prompt.md', format: 'copilot-prompt', role: 'procedure', id: 'review' },
    { path: 'other/review.prompt.md', format: 'copilot-prompt', role: 'procedure', id: 'review' }
  ],
  withheld: [{ path: '.env', screening: 'withheld' }],
  entry: { status: 'choose', selected: [], selectedBy: null, candidates: [
    { id: 'lead', path: '.github/agents/lead.agent.md', reasons: ['refers to 2 other agents', 'describes ordered steps'] },
    { id: 'review', path: 'other/review.prompt.md', reasons: ['describes ordered steps'] }
  ] },
  session: null, closure: [], candidate: null
};
const session = { id: 'tis-0123456789abcdef', createdAt: 't0', updatedAt: 't1', expiresAt: 't9', source: TEAM,
  entry: [{ id: 'lead', path: '.github/agents/lead.agent.md' }], state: 'awaiting-candidate', bundle: null, bundleSha256: null };
const compiled = (state, extra = {}) => ({
  schemaVersion: 1, resultType: 'team-import-compile', session: { id: session.id }, state, bundleSha256: 'sha256:' + 'a'.repeat(64),
  workflow: { id: 'team-delivery', label: 'Team delivery', phases: [{ id: 'build', label: 'Build', agent: 'team-coder', code: true }], decisions: [] },
  counts: { agents: 2 }, dispositions: [], destinationPolicy: [{ sourceItem: 'lead', target: 'approval', reason: 'never stated' }],
  prerequisites: [], questions: [], answers: [], coverage: null, findings: [], routeSimulation: { status: 'passed' },
  freshImport: { status: 'passed' }, destination: null, repair: { attempt: 0, limit: 3, unchanged: false, stop: false }, output: null,
  meaning: 'Ready means the bundle passed every deterministic check. It is not approved, activated, executed, tested or reviewed.',
  ...extra
});
const question = { id: 'quality-command', question: 'Which command runs the tests?', choices: ['npm test', 'make check'], blocking: true };

function fixture(overrides = {}) {
  const calls = [], chats = [], studio = [], copied = [];
  let state = compiled('needs-decision', { questions: [question] });
  const host = {
    run: async argv => {
      calls.push(argv);
      if (argv[2] === 'status') return { schemaVersion: 1, resultType: 'team-import-status', sessions: [{ ...session }] };
      if (argv[2] === 'inspect') return structuredClone(inspection);
      if (argv[2] === 'compile') {
        if (argv.includes('--answer')) state = compiled('portable-ready', { answers: [{ id: question.id, question: question.question, choice: 'npm test' }] });
        if (argv.includes('--out')) return { ...state, output: { path: argv[argv.indexOf('--out') + 1], bundleSha256: state.bundleSha256, ready: true } };
        return structuredClone(state);
      }
      throw new Error(`Unexpected command: ${argv}`);
    },
    pickFolder: async () => TEAM,
    pickBundle: async suggested => suggested,
    openChat: async query => { chats.push(query); return 'opened'; },
    copy: async text => { copied.push(text); },
    openInStudio: async file => { studio.push(file); },
    repository: () => ({ root: '/work/app', label: 'calc · app' }),
    ...overrides
  };
  return { journey: new TeamImportJourney(host, () => {}), calls, chats, studio, copied };
}

test('Import a team workflow is a contributed, early, repository-independent command with Studio and Configuration Center entries', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(command => command.command === 'singularityFlow.importTeamWorkflow'));
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const handler = extension.indexOf("'singularityFlow.importTeamWorkflow', async");
  assert.ok(handler > 0 && handler < extension.indexOf("if ('reason' in resolved)"), 'registered before a repository resolves');
  const registration = extension.slice(handler, extension.indexOf('repository: repositoryLabel', handler));
  assert.match(registration, /getConfiguration\('chat'\)\.get<boolean>\('disableAIFeatures', false\)/,
    'only VS Code AI features turned off keep chat from opening');
  assert.doesNotMatch(registration, /getExtension\(/,
    'the built-in Copilot extension loads only after sign-in, so its presence says nothing about the Chat view');
  assert.match(extension, /importBundle/);
  const lazy = await readFile(new URL('../apps/vscode/src/lazy-panels-runtime.ts', import.meta.url), 'utf8');
  assert.match(lazy, /export \{ TeamImportPanel \} from '\.\/views\/team-import-panel\.ts';/);
  const studio = await readFile(new URL('../apps/vscode/src/views/workflow-studio-page.ts', import.meta.url), 'utf8');
  assert.match(studio, /studio\.importTeam/);
  assert.match(studio, /studio\.importRequested/);
});

test('import-team commands are classified like the CLI: inspect, status and checks read; only a written bundle mutates', () => {
  for (const argv of [
    ['workflow', 'import-team', 'status', '--json'],
    ['workflow', 'import-team', 'inspect', TEAM, '--json'],
    ['workflow', 'import-team', 'compile', '--session', session.id, '--dry-run', '--json'],
    ['workflow', 'import-team', 'compile', '--session', session.id, '--dry-run', '--answer', 'q=a', '--json'],
    ['workflow', 'import-team', 'compile', '--session', session.id, '--out', '/x/b.json', '--json']
  ]) assert.equal(commandClass(argv), resolveOperation({ requestedCommand: argv[0], ...parseArgs(argv) }).classification, argv.join(' '));
  assert.equal(commandClass(['workflow', 'import-team', 'compile', '--session', session.id, '--out', '/x/b.json', '--json']), 'mutation');
});

test('choosing a folder inspects it without a model; the entry is checked against what inspect found', async () => {
  const f = fixture();
  await f.journey.load();
  await f.journey.pick();
  assert.deepEqual(f.calls.map(argv => argv.slice(0, 4)), [
    ['workflow', 'import-team', 'status', '--json'], ['workflow', 'import-team', 'inspect', TEAM], ['workflow', 'import-team', 'status', '--json']]);
  assert.equal(f.journey.view.entry, '.github/agents/lead.agent.md', 'the strongest suggestion is preselected');
  f.journey.chooseEntry('/etc/passwd');
  assert.equal(f.journey.view.entry, '.github/agents/lead.agent.md', 'a path inspect did not return is ignored');
  f.journey.chooseEntry('.github/agents/coder.agent.md');
  assert.equal(f.journey.view.entry, '.github/agents/coder.agent.md');
  const html = teamImportHtml(f.journey.view);
  assert.match(html, /Withheld \(never read or returned\): <code>\.env<\/code>/);
  assert.match(html, /<optgroup label="Suggested">/);
  assert.match(html, /preview the import into <strong>calc · app<\/strong>/, 'the destination is named, its root kept for the CLI');
  assert.ok(!f.calls.some(argv => argv.includes('compile')), 'nothing is checked before a session exists');
});

test('Convert with Copilot types the skill command into chat, quoting the directory and naming an ambiguous entry by path', async () => {
  const f = fixture();
  await f.journey.pick();
  await f.journey.convert();
  assert.deepEqual(f.chats, ['/sf-import-team "/work/team agents" --entry lead']);
  f.journey.chooseEntry('other/review.prompt.md');
  f.journey.setDestination(true);
  await f.journey.convert();
  assert.equal(f.chats[1], '/sf-import-team "/work/team agents" --entry other/review.prompt.md --destination /work/app',
    'two prompts are called review, so the path picks one');
  assert.match(f.journey.view.notice, /Send it there/);
  assert.equal(f.calls.filter(argv => argv[2] === 'inspect').length, 1, 'converting runs no CLI command itself');
  assert.match(teamImportHtml(f.journey.view), /<pre class="command"><code>\/sf-import-team &quot;\/work\/team agents&quot;/, 'the command stays visible');
  await f.journey.copyCommand();
  assert.deepEqual(f.copied, [f.chats[1]]);
});

test('with VS Code AI features or SFlow model features off, nothing claims chat opened and the command is offered to copy', async () => {
  for (const [opened, wording] of [['no-chat', /AI features are turned off in this VS Code/], ['model-off', /Model features are turned off/]]) {
    const f = fixture({ openChat: async () => opened });
    await f.journey.pick();
    await f.journey.convert();
    assert.match(f.journey.view.notice, wording);
    assert.doesNotMatch(f.journey.view.notice, /has the command/);
    assert.match(teamImportHtml(f.journey.view), /data-team-action="copy"/);
  }
});

test('the panel follows the newest session for the directory until the person chooses one', async () => {
  let sessions = [{ ...session }];
  const f = fixture({ run: async argv => {
    if (argv[2] === 'status') return { resultType: 'team-import-status', sessions: structuredClone(sessions) };
    if (argv[2] === 'inspect') return structuredClone(inspection);
    throw new Error('unexpected');
  } });
  await f.journey.pick();
  assert.equal(f.journey.view.session, session.id);
  sessions = [{ ...session, id: 'tis-fedcba9876543210', updatedAt: 't2', state: 'needs-decision' }, { ...session },
    { ...session, id: 'tis-0000000000000001', updatedAt: 't0', state: 'portable-ready' }];
  await f.journey.refreshSessions();
  assert.equal(f.journey.view.session, 'tis-fedcba9876543210', 'Copilot\'s newer session replaces the one inspect opened');
  assert.deepEqual(f.journey.view.sessions.map(entry => entry.id), ['tis-fedcba9876543210', 'tis-0000000000000001'],
    'the superseded session still waiting for a candidate is hidden');
  f.journey.selectSession(session.id);
  assert.equal(f.journey.view.session, 'tis-fedcba9876543210', 'a hidden session cannot be chosen');
  f.journey.selectSession('tis-0000000000000001');
  await f.journey.refreshSessions();
  assert.equal(f.journey.view.session, 'tis-0000000000000001', 'a chosen session stays chosen');
  // Coming back later: a re-inspect opens an empty session, but the finished conversion is shown.
  sessions = [{ ...session, id: 'tis-1111111111111111', updatedAt: 't3' }, { ...session, id: 'tis-0000000000000001', updatedAt: 't0', state: 'portable-ready' }];
  await f.journey.pick();
  assert.equal(f.journey.view.session, 'tis-0000000000000001');
});

test('the check names the open repository it previewed the import into', () => {
  const repository = { root: '/ws/.singularity-flow/story-worktrees/.w-1', label: 'calc · app' };
  const view = { directory: TEAM, inspection: null, entry: null, command: null, sessions: [{ ...session }], session: session.id,
    check: compiled('ready-for-destination', { destination: { root: repository.root, status: 'ready' } }),
    written: null, repository, useDestination: true, busy: null, error: null, notice: null };
  const html = teamImportHtml(view);
  assert.match(html, /import into <strong>calc · app<\/strong>: ready/);
  assert.doesNotMatch(html, /story-worktrees\/\.w-1<\/code>/);
});

test('a session is checked, answered with an offered choice only, written beside the team directory and handed to Studio', async () => {
  const f = fixture();
  await f.journey.pick();
  await f.journey.load();
  assert.equal(f.journey.view.session, session.id, 'the session for the inspected directory is selected');
  await f.journey.write();
  assert.ok(!f.calls.some(argv => argv.includes('--out')), 'nothing is written before a ready check');
  await f.journey.check();
  assert.deepEqual(f.calls.at(-2), ['workflow', 'import-team', 'compile', '--session', session.id, '--dry-run', '--json']);
  assert.equal(f.journey.view.check.state, 'needs-decision');
  assert.match(teamImportHtml(f.journey.view), /data-team-answer="quality-command" data-team-choice="npm test"/);
  const before = f.calls.length;
  await f.journey.answer('quality-command', 'rm -rf /');
  await f.journey.answer('other-question', 'npm test');
  assert.equal(f.calls.length, before, 'a choice or question the check did not offer runs nothing');
  await f.journey.answer('quality-command', 'npm test');
  assert.ok(f.calls.some(argv => argv.join(' ') === `workflow import-team compile --session ${session.id} --dry-run --answer quality-command=npm test --json`));
  assert.equal(teamImportReady(f.journey.view.check), true);
  await f.journey.write();
  assert.ok(f.calls.some(argv => argv.join(' ') === `workflow import-team compile --session ${session.id} --out /work/team-delivery.sflow-workflows.json --json`),
    'the default file sits beside the team directory, named for the workflow');
  assert.equal(f.journey.view.written.path, '/work/team-delivery.sflow-workflows.json');
  await f.journey.openInStudio();
  assert.deepEqual(f.studio, ['/work/team-delivery.sflow-workflows.json']);
});

test('the destination preview is offered only with a governed repository open; Studio is not opened without one', async () => {
  const f = fixture({ repository: () => null });
  await f.journey.load();
  f.journey.setDestination(true);
  assert.equal(f.journey.view.useDestination, false);
  assert.doesNotMatch(teamImportHtml(f.journey.view), /data-team-destination/);
  f.journey.view.written = { path: '/work/b.json', bundleSha256: 'x' };
  await f.journey.openInStudio();
  assert.deepEqual(f.studio, []);
  assert.match(f.journey.view.error, /Open the repository/);
});

test('a CLI refusal is shown in the panel and keeps the journey usable', async () => {
  const f = fixture({ run: async argv => {
    if (argv[2] === 'status') return { resultType: 'team-import-status', sessions: [{ ...session }] };
    throw new Error(`No candidate yet: write it to /state/${session.id}/candidate.json, then compile again.`);
  } });
  await f.journey.load();
  f.journey.selectSession(session.id);
  await f.journey.check();
  assert.match(f.journey.view.error, /No candidate yet/);
  assert.equal(f.journey.view.busy, null);
  assert.match(teamImportHtml(f.journey.view), /Action needs attention/);
});

test('the page escapes everything the CLI returns and its script posts only ids and offered values', () => {
  const view = {
    directory: '<img src=x>', inspection: { ...inspection, items: [{ path: '<b>p</b>', format: 'x', id: '"><script>' }],
      entry: { ...inspection.entry, candidates: [] } },
    entry: null, sessions: [], session: null, check: null, written: null, repository: null, useDestination: false,
    busy: null, error: '<script>alert(1)</script>', notice: null
  };
  const html = teamImportHtml(view);
  assert.ok(!html.includes('<img src=x>') && !html.includes('<script>') && !html.includes('<b>p</b>'));
  assert.doesNotThrow(() => new Function(TEAM_IMPORT_SCRIPT));
  assert.doesNotMatch(TEAM_IMPORT_SCRIPT, /innerHTML|eval\(/);
});
