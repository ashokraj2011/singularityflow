/**
 * `--json` is one object on stdout, on every branch of a command.
 *
 * `story advance --confirm <digest> --for-agent --json` printed the submission's text: its preview
 * answered in JSON, but the confirmed branch went through `submit`, whose success path never passed
 * `--json` to its result. The same held for `submit --json` itself, `reject` and `agent`; `approve
 * --json` printed its review before its result, and `pr --json` printed "Preview only" after it.
 * `cancel`, `reopen`, `artifact add|scan`, `story branch` and the initiative's Jira, materialize and
 * contract writes printed only words, and a publication's tail printed its route on stdout.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { completeAgentResult } from '../src/agent-output.mjs';
import { submittedResult } from '../src/commands/submit-if-ready.mjs';
import { CLI, implementationPlan, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const at = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(at));
    else if (entry.name.endsWith('.mjs')) found.push(at);
  }
  return found;
}

test('every command result is told whether the caller asked for JSON', async () => {
  // The output boundary prints words unless `json` says otherwise, so a call that leaves it out answers
  // `--json` with text: that was `submit`'s success path, and through it `story advance --confirm`.
  const missing = [];
  for (const file of await sources(path.join(root, 'src'))) {
    const relative = path.relative(root, file);
    if (relative.startsWith(`src${path.sep}narration${path.sep}`)) continue;
    const text = await readFile(file, 'utf8');
    if (!text.includes('emitCommandResult(')) continue;
    const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'emitCommandResult') {
        // `{ json }`, `{ json: … }`, or a helper that builds them, such as governance.mjs's `json(options)`.
        const named = /\bjson\b/u.test(node.arguments[1]?.getText(source) ?? '');
        if (!named) missing.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, [], 'pass { json: optionBoolean(options, \'json\') } to emitCommandResult');
});

/**
 * The words a command prints to stdout where no JSON decision covers them: not under an if, ?: or &&/|| that reads
 * --json (or `quiet`, approve's name for it), and not after an `if (<json>) … return` beside it. A JSON.stringify
 * print and a route written elsewhere (`write:`) are the result or not stdout. Callbacks count where they are written.
 */
function unguardedPrints(relative, text, functionName, branch = null) {
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const decides = (node) => /\bjson\b|'json'|\bquiet\b/u.test(node.getText(source));
  const exits = (node) => /\breturn\b|\bthrow\b/u.test(node.getText(source));
  // The function's body, or every branch of it with this condition (initiative sync has two).
  const starts = [];
  const find = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      if (!branch) return void starts.push(node.body);
      const inner = (child) => {
        if (ts.isIfStatement(child) && child.expression.getText(source) === branch) starts.push(child.thenStatement);
        ts.forEachChild(child, inner);
      };
      return void inner(node.body);
    }
    ts.forEachChild(node, find);
  };
  find(source);
  if (!starts.length) return [`${relative}: no ${functionName}${branch ? ` branch ${branch}` : ''}`];
  const found = [];
  const walk = (node, guarded) => {
    if (guarded) return;
    if (ts.isIfStatement(node) && decides(node.expression)) return;
    if (ts.isConditionalExpression(node) && decides(node.condition)) return;
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)
        && decides(node.left)) return;
    if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      let covered = false;
      for (const statement of node.statements) {
        walk(statement, covered);
        if (ts.isIfStatement(statement) && decides(statement.expression) && exits(statement.thenStatement)) covered = true;
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const options = node.arguments.at(-1)?.getText(source) ?? '';
      if (/^(?:console\.log|process\.stdout\.write|print[A-Z]\w*)$/u.test(callee)
          && !/JSON\.stringify/u.test(node.arguments[0]?.getText(source) ?? '') && !/\bwrite:/u.test(options)) {
        found.push(`${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${functionName}${branch ? ` (${branch})` : ''}: ${node.getText(source).slice(0, 70)}`);
      }
    }
    ts.forEachChild(node, (child) => walk(child, false));
  };
  for (const start of starts) walk(start, false);
  return found;
}

test('every branch of a command that answers --json answers it with its result alone', async () => {
  // One row per command: each printed its words on a branch its --json never reached (found 2026-11-16).
  const handlers = [
    ['src/commands/submit.mjs', 'runSubmitCommand'], ['src/commands/approve.mjs', 'approveCommand'],
    ['src/cli.mjs', 'pullRequestCommand'], ['src/cli.mjs', 'rejectCommand'], ['src/cli.mjs', 'agentCommand'],
    ['src/cli.mjs', 'reopenCommand'], ['src/cli.mjs', 'cancelCommand'], ['src/cli.mjs', 'artifactCommand'],
    ['src/cli.mjs', 'epicCommand', "subcommand === 'pr'"],
    ...['jira-adopt', 'jira-plan', 'jira-apply', 'materialize', 'sync', 'contracts']
      .map((name) => ['src/cli.mjs', 'initiativeCommand', `subcommand === '${name}'`]),
    ['src/commands/story.mjs', 'storyCommand', "subcommand === 'branch'"], ['src/commands/story.mjs', 'storyCommand', "action === 'acknowledge'"],
    // A publication's tail warns on stderr, beside its warning: stdout is the command's own result.
    ['src/commands/shared/post-publication-step.mjs', 'postPublicationStep']
  ];
  const texts = new Map();
  const found = [];
  for (const [relative, name, branch] of handlers) {
    if (!texts.has(relative)) texts.set(relative, await readFile(path.join(root, relative), 'utf8'));
    found.push(...unguardedPrints(relative, texts.get(relative), name, branch));
  }
  assert.deepEqual(found, [], 'print it only when --json was not asked for, or return the JSON result before it');
});

test('a submission ready to attempt reports its step, version and push, never a commit or digest', () => {
  const value = { operation: { id: 'submit' }, outcome: { messageId: 'submit.succeeded', slots: { phase: 'planning' } },
    data: { commit: 'a'.repeat(40), pushed: true, pushedTo: 'origin/W-1', generation: 2, reviewPacket: `sha256:${'b'.repeat(64)}` } };
  assert.deepEqual(submittedResult(value), { phase: 'planning', generation: 2, status: 'submitted', committed: true, pushedTo: 'origin/W-1' });
  const completed = { ...value, outcome: { messageId: 'submit.completed', slots: { phase: 'code' } }, data: { commit: 'c'.repeat(40), pushed: false, pushedTo: null, generation: 1 } };
  assert.deepEqual(submittedResult(completed), { phase: 'code', generation: 1, status: 'completed', committed: true, pushedTo: null });
  assert.doesNotMatch(JSON.stringify(submittedResult(value)), /a{40}|sha256:/u);
});

test('a Story walked with --json answers each step with one object, its convergence advance too', slowLane({ timeout: 480_000 }), async (t) => {
  const WORK = 'JSON-1';
  const { root: repository, item, cli } = await startedSpecificationStory(t, WORK);
  const json = (...args) => {
    const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: repository, encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester' } });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    let value;
    assert.doesNotThrow(() => { value = JSON.parse(result.stdout); }, `${args.join(' ')} printed more than one JSON object:\n${result.stdout.slice(0, 600)}`);
    return completeAgentResult(value);
  };
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(repository, relative)), { recursive: true });
    await writeFile(path.join(repository, relative), text);
  };

  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  const scanned = json('artifact', 'scan', '--phase', 'specification', '--json');
  assert.equal(scanned.resultType, 'sflow-artifact-registration');
  assert.ok(scanned.artifacts.some((entry) => entry.path.endsWith('artifacts/specification/spec.md')), JSON.stringify(scanned));
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  const submitted = json('submit', 'specification', '--skip-checks', '--json');
  assert.equal(submitted.operation.id, 'submit');
  assert.equal(submitted.outcome.slots.phase, 'specification');
  assert.equal(submitted.data.generation, 1);
  assert.equal(submitted.data.pushedTo, `origin/${WORK}`);
  const approved = json('approve', 'specification', '--yes', '--json');
  assert.equal(approved.operation.id, 'approve');
  assert.equal(approved.outcome.slots.phase, 'specification');
  assert.equal(json('pr', '--json').workId, WORK, 'the pull request preview is the plan alone, without "Preview only"');
  assert.equal(typeof json('story', 'interval', 'acknowledge', '--json').acknowledged, 'boolean', 'nothing to acknowledge is said in JSON too');

  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await write('src/value.mjs', `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.equal(value, 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value and proves it.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value, and nothing else changes for anyone who reads it.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation'); cli('approve', 'implementation', '--yes');
  cli('prepare', 'convergence');
  cli('phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator');

  const preview = json('story', 'advance', '--work-id', WORK, '--json');
  assert.equal(preview.status, 'ready-to-confirm');
  // The exact command an agent runs: confirmed, for an agent, as JSON.
  const advanced = json('story', 'advance', '--work-id', WORK, '--confirm', preview.confirmationDigest, '--for-agent', '--json');
  assert.equal(advanced.operation.id, 'submit');
  assert.equal(advanced.outcome.status, 'succeeded');
  assert.equal(advanced.outcome.slots.phase, 'convergence');
  assert.equal(advanced.data.pushedTo, `origin/${WORK}`);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  // Approve twice (step intents Stage 7): a clean convergence is approved by SFlow as it is submitted.
  assert.equal(workflow.phases.convergence.status, 'approved', 'the confirmed advance submitted convergence');
  assert.equal(workflow.phases.convergence.automaticApproval?.generation, workflow.phases.convergence.generation, 'SFlow approved it');

  const cancelled = json('cancel', WORK, '--confirm', WORK, '--reason', 'The walk ends here.', '--json');
  assert.equal(cancelled.resultType, 'sflow-story-cancelled');
  assert.equal(cancelled.phase, workflow.currentPhase);
  assert.equal(cancelled.pushed, true);
});
