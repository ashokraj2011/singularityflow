/**
 * Real Stories replayed through today's guard. fixtures/journeys holds what real runs called, scrubbed
 * to fixed placeholders by scripts/journey-extract.mjs, and what the guard said. So a call a correct
 * run needs stays allowed, a refusal stays a refusal, and a false one is on a list with its reason.
 *
 * It replays turn by turn on a fixture Story, so a call that depended on a real file's length or on a
 * moment in the real Story is not a fair question here: those are named in STATE_BOUND.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordRepositoryBoundaryTurn, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { readConfiguredPrivacyTerms } from '../scripts/documentation-privacy.mjs';
import { normalizeArguments, normalizeCommand, PLACEHOLDERS, registryWords, tokenAllowed, TOOL_NAME } from '../scripts/journey-extract.mjs';
import { refusalFromCompletion } from '../scripts/route-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOURNEYS = path.join(ROOT, 'test/fixtures/journeys');
const RATCHET = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/known-dead-ends.json'), 'utf8')).journeys;
const WORK = 'RPL-1';
// These answer the length of a real file, or a path SFlow issued in that very run.
const STATE_BOUND = new Set(['FILE_READ_TOO_LONG', 'FILE_READ_RANGE_INVALID', 'CLI_ISSUED_PATH_MISMATCH']);
const stateBound = (row) => STATE_BOUND.has(row.outcome) || /--selection-receipt|<ISSUED-STAGING>/u.test(JSON.stringify(row.args));

const STEPS = ['intake', 'specification', 'planning', 'implementation', 'convergence', 'verification', 'release'];
const DOCUMENT = { status: 'in_progress', generation: 0, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
const CODE = { status: 'in_progress', generation: 0, writeScope: 'source-and-artifact', generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } };

/**
 * The step a call stands on, so its own turn gets a fair answer: the one it names, or the code step for
 * an edit to application files. The logs keep what was called, not where the Story stood.
 */
function stepFor(row) {
  const named = String(row.args.command ?? '').split(' ').find((word) => STEPS.includes(word));
  const appFile = row.args.patch?.some((entry) => entry.path === '<REPO-PATH>') || (row.tool === 'edit' && row.args.path === '<REPO-PATH>');
  const id = appFile || row.turn === 'sf-code' ? 'implementation' : named ?? 'specification';
  return { id, ...(id === 'implementation' ? CODE : DOCUMENT),
    artifacts: [{ path: `singularity/work-items/${WORK}/artifacts/${id}/document.md`, required: true }] };
}

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-journey-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q'); git('config', 'user.name', 'Journey Tester'); git('config', 'user.email', 'journey@example.test');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const accepted = (row) => {
    const phase = stepFor(row);
    return { definition, workflow: { workItem: { id: WORK }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} } };
  };
  await mkdir(path.join(root, definition.workItemRoot, WORK), { recursive: true });
  await writeFile(path.join(root, definition.workItemRoot, WORK, 'workflow.json'), JSON.stringify(accepted({ turn: 'sf-code', args: {} }).workflow));
  git('add', '.'); git('commit', '-qm', 'fixture');
  const home = process.env.HOME ?? os.homedir();
  const values = { '<WORK-ID>': WORK, '<VALUE>': 'value', '<TEXT>': '"some words"', '<N>': '1', '<CHECKOUT>': root, '<REPO-PATH>': 'src/value.mjs',
    '<HOME-PATH>': path.join(home, 'elsewhere', 'file.txt'), '<SYSTEM-PATH>': '/opt/tool/bin/node', '<ISSUED-OUTPUT>': '.sflow/out/result.json',
    '<ISSUED-STAGING>': '.sflow/out/staging.json', '<PROGRAM>': 'some-tool', '<HEREDOC>': "<<'EOF'\nwords\nEOF", '<ENV>': 'SOME_VARIABLE' };
  const expand = (text) => text.replace(/<[A-Z-]+>/gu, (placeholder) => values[placeholder] ?? placeholder);
  const toolArguments = (row) => {
    values['<ARTIFACT-PATH>'] = stepFor(row).artifacts[0].path;
    if (row.args.patch) return `*** Begin Patch\n${row.args.patch.map((entry) => `*** ${entry.change} File: ${expand(entry.path)}\n+x`).join('\n')}\n*** End Patch\n`;
    const args = {};
    if (row.args.command) { args.command = expand(row.args.command); args.cwd = root; }
    if (row.args.path) args.path = path.resolve(root, expand(row.args.path));
    if (row.args.view_range) args.view_range = [1, 1];
    if (row.args.workId) args.workId = WORK;
    return args;
  };
  let session = 0;
  const enter = async (row) => {
    const payload = { cwd: root, sessionId: `replay-${++session}`, prompt: row.turn === 'plain' ? 'Go on with that.' : `/${row.turn}` };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (entry, record) => captureMutationTurn(entry, record, { resolveRoot: async () => root, load: async () => accepted(row) }) });
    return payload;
  };
  const ask = async (turnPayload, row) => {
    const answer = await repositoryToolGuard({ ...turnPayload, toolName: row.tool, toolArgs: toolArguments(row) });
    if (answer.permissionDecision !== 'deny') return 'allowed';
    return refusalFromCompletion({ success: false, error: { message: `Denied by preToolUse hook: ${answer.permissionDecisionReason}` } }, {}).code;
  };
  return { enter, ask };
}

// A refusal that was wrong then. Once the guard stops making it, its key moves here from the list.
const CORRECTED = new Set([]);
// Lowered as entries go. Raising it is a decision a reviewer sees.
const CEILING = 3;
const journeys = (await readdir(JOURNEYS)).filter((name) => name.endsWith('.json')).sort();
const keyOf = (journey, row) => `${journey} ${row.turn} ${row.tool} ${row.args.command ?? JSON.stringify(row.args)}`;

test('each real call gets the answer it got then, or its difference is on the list', async (t) => {
  const f = await fixture(t);
  const answers = new Map();
  let replayed = 0;
  for (const name of journeys) {
    const journey = name.replace(/\.json$/u, '');
    const { sessions } = JSON.parse(await readFile(path.join(JOURNEYS, name), 'utf8'));
    for (const row of sessions.flat()) {
      if (stateBound(row)) continue;
      const key = keyOf(journey, row);
      if (answers.has(key) && answers.get(key).then === row.outcome) continue;
      answers.set(key, { then: row.outcome, now: await f.ask(await f.enter(row), row) });
      replayed += 1;
    }
  }
  assert.ok(replayed > 100, `${replayed} calls replayed`);
  const listed = RATCHET;
  const wrongNow = [...answers].filter(([key, answer]) => answer.now !== (CORRECTED.has(key) ? 'allowed' : answer.then));
  const fresh = wrongNow.filter(([key]) => !listed[key] || listed[key].falseRefusal);
  assert.deepEqual(fresh.map(([key, answer]) => `${key}: then ${answer.then}, now ${answer.now}`), [],
    'a real call gets a different answer now: a correct run needs it, or a refusal was loosened. A false refusal fixed moves to CORRECTED.');
  const stale = Object.entries(listed).filter(([key, entry]) => !entry.falseRefusal && !wrongNow.some(([other]) => other === key)).map(([key]) => key);
  assert.deepEqual(stale, [], 'no longer differs, or no longer in a journey: remove it from known-dead-ends.json');
  for (const [key, entry] of Object.entries(listed)) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 20, `${key} needs its reason`);
    if (entry.falseRefusal) assert.equal(answers.get(key)?.now, entry.falseRefusal, `${key}: no longer refused, so move it to CORRECTED`);
  }
  assert.ok(Object.keys(listed).length <= CEILING, `${Object.keys(listed).length} listed, ceiling ${CEILING}`);
});

// Words that must never be in a fixture, whoever's machine this runs on. The identity terms are read
// here, never written down: the repository check refuses them in a test too.
const NEVER = [/\/Users\//u, /\/home\/[a-z]/u, /\/private\//u, /\/var\/folders/u, /[A-Za-z]:\\/u, /\/opt\/homebrew/u, /[\w.+-]+@[\w-]+\.[\w.-]+/u, /https?:\/\//u, /github\.com/iu, /git@/u,
  /\b[0-9a-f]{40}\b/u, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/u, /sha256:/u, /story-worktrees/u, /work-items\//u, /\.w-[0-9a-f]{6}/u];

test('the fixtures hold no path, login, name, email, URL or text from a real machine', async () => {
  const knownWords = await registryWords();
  const terms = [os.userInfo().username, path.basename(os.homedir()), ...readConfiguredPrivacyTerms(ROOT)].filter((term) => term && term.length >= 3).map((term) => String(term).toLowerCase());
  const files = [...journeys.map((name) => path.join(JOURNEYS, name)), path.join(ROOT, 'test/fixtures/known-dead-ends.json')];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const pattern of NEVER) assert.doesNotMatch(text, pattern, path.basename(file));
    for (const term of terms) assert.ok(!text.toLowerCase().includes(term), `${path.basename(file)} holds a term from this machine's identity`);
  }
  // Beyond any list of bad words: every token in a journey is on the list of what may be kept.
  for (const name of journeys) {
    const journey = JSON.parse(await readFile(path.join(JOURNEYS, name), 'utf8'));
    assert.deepEqual(Object.keys(journey).sort(), ['note', 'schemaVersion', 'sessions']);
    for (const row of journey.sessions.flat()) {
      assert.deepEqual(Object.keys(row).filter((key) => !['turn', 'tool', 'args', 'outcome', 'cli'].includes(key)), [], name);
      assert.match(row.turn, /^(?:plain|sf(?:low)?-[a-z-]+)$/u);
      assert.match(row.tool, TOOL_NAME);
      assert.match(row.outcome, /^(?:allowed|[A-Z][A-Z0-9_]{3,})$/u);
      if (row.cli) assert.match(row.cli, /^[A-Z][A-Z0-9_]{3,}$/u);
      assert.deepEqual(Object.keys(row.args).filter((key) => !['command', 'path', 'patch', 'view_range', 'workId'].includes(key)), [], name);
      for (const token of String(row.args.command ?? '').split(' ').filter(Boolean)) assert.ok(tokenAllowed(token, knownWords), `${name}: the token '${token}' is on no list`);
      for (const value of [row.args.path, row.args.workId, ...(row.args.patch ?? []).map((entry) => entry.path)]) if (value !== undefined) assert.ok(PLACEHOLDERS.includes(value), `${name}: ${value}`);
    }
  }
});

test('the extractor keeps only what is on its lists, whatever a real command held', async () => {
  const knownWords = await registryWords();
  const context = { workId: 'STORY-9', knownWords, checkout: '/somewhere/private-repo/.singularity-flow/story-worktrees/.w-abc123', home: '/somewhere/private-person' };
  const scrub = (command) => normalizeCommand(command, context);
  const SECRETS = /private|secret|acme|hunter2|Calculator|widget/iu;
  const cases = [
    ['singularity-flow appeal prepare --add-supporting .nvmrc=build-configuration --reason "my secret reason" --phase implementation --json',
      'singularity-flow appeal prepare --add-supporting <VALUE> --reason <TEXT> --phase implementation --json'],
    ['cat /somewhere/private-person/acme/secret.txt', 'cat <HOME-PATH>'],
    ['ls -l /opt/private/node@22/bin/node', 'ls -l <SYSTEM-PATH>'],
    ['cd /somewhere/private-repo/.singularity-flow/story-worktrees/.w-abc123 && npm test', 'cd <CHECKOUT> && npm test'],
    ['git commit -m "Calculator secret message"', 'git commit -m <TEXT>'],
    ['curl https://example.test/acme/private-repo.git', '<PROGRAM> <REPO-PATH>'],
    ['node -e "console.log(\'secret\')"', 'node -e <VALUE>'],
    ['TOKEN=hunter2 ./private-script.sh widget', '<ENV>=<VALUE> <REPO-PATH> <VALUE>'],
    ['PATH="/opt/private/bin:$PATH" singularity-flow phase prepublish implementation --work-id STORY-9', 'PATH=<SYSTEM-PATH> singularity-flow phase prepublish implementation --work-id <WORK-ID>'],
    ["cat <<'EOF' > notes.md\nsecret words\nEOF", 'cat <HEREDOC>'],
    ['rg "Calculator" src/widget.jsx | head -5', 'rg <VALUE> <REPO-PATH> | head <VALUE>'],
    ['singularity-flow decision plan STORY-9 --add-location STORY-9:AC-001=src/widget.jsx --reason "a secret"', 'singularity-flow decision plan <WORK-ID> --add-location <REPO-PATH> --reason <TEXT>']
  ];
  for (const [command, expected] of cases) {
    const saved = scrub(command);
    assert.equal(saved, expected, command);
    assert.doesNotMatch(saved, SECRETS, command);
    for (const token of saved.split(' ')) assert.ok(tokenAllowed(token, knownWords), `${command}: ${token}`);
  }
  // A tool's arguments keep what the guard reads, never its contents.
  const patch = normalizeArguments('apply_patch', '*** Begin Patch\n*** Update File: /somewhere/private-repo/.singularity-flow/story-worktrees/.w-abc123/src/widget.jsx\n+secret code\n*** End Patch\n', context);
  assert.deepEqual(patch, { patch: [{ change: 'Update', path: '<REPO-PATH>' }] });
  assert.deepEqual(normalizeArguments('view', { path: '/somewhere/private-person/secret.txt', view_range: [1, 2], note: 'a secret' }, context), { path: '<HOME-PATH>', view_range: true });
  assert.deepEqual(normalizeArguments('rg', { pattern: 'secret', path: 'src' }, context), { path: '<REPO-PATH>' });
  assert.equal(tokenAllowed('secret-word', knownWords), false);
  assert.equal(tokenAllowed('/somewhere/private-person', knownWords), false);
});
