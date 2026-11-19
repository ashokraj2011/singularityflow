/**
 * A person never composes a command (scripts/command-placeholder-check.mjs) [owner, 2026-11-19].
 *
 * Every route a person is handed, wherever it is built (refusal plans, next actions, act.do, nextAction
 * details, printed "Run:"/"Next:" lines, VS Code views), is whole: only their own words (a reason, an
 * answer, a title) stay open. Routes that still leave something to fill in are the committed baseline,
 * which only shrinks; TEMPORARY names the audit entries another branch fixes, until the branches merge.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_PATH, PERSON_WORDS, TEMPORARY, baselineOf, compare, isPersonWords, openPlaceholders, routeIn, routesOfSource, scan
} from '../scripts/command-placeholder-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE = 'node scripts/command-placeholder-check.mjs --update';
let scanned = null;
const scanOnce = () => (scanned ??= scan(root));

test('no route a person is handed gains a placeholder to fill in, and a filled one is locked in', async () => {
  const result = await scanOnce();
  const committed = JSON.parse(await readFile(path.join(root, BASELINE_PATH), 'utf8'));
  const { rose, fell } = compare(committed, baselineOf(result));
  const where = (key) => result.sources.find((entry) => `${entry.file}: ${entry.key}` === key);
  assert.deepEqual(rose.map((key) => (where(key) ? `${where(key).file}:${where(key).line} ${where(key).route}` : key)), [],
    'fill it in from what SFlow knows (the Story, its steps, the branches, the workspaces, the suggestions, the reviewed plan\'s short code), '
    + 'or name the screen that does it; only the person\'s own words stay open (PERSON_WORDS)');
  assert.deepEqual(fell, [], `fewer routes to fill in: lock the fall in with ${UPDATE}`);
});

test('each TEMPORARY entry still names a route, so the list empties as the other branch lands', async () => {
  const result = await scanOnce();
  assert.deepEqual(result.unusedTemporary.map((item) => `entry ${item.entry}: ${item.file} ${item.includes}`), [],
    'fixed: remove it from TEMPORARY in scripts/command-placeholder-check.mjs');
  for (const item of TEMPORARY) assert.ok(Number.isInteger(item.entry) && item.file && item.includes, JSON.stringify(item));
});

test('the reader finds the routes, so a broken reader cannot pass by finding nothing', async () => {
  const result = await scanOnce();
  // Measured 2026-11-19: 2684 source routes, 1454 plan routes. Each floor is about half.
  assert.ok(result.routeCount >= 1300, `found ${result.routeCount} source routes`);
  assert.ok(result.planRouteCount >= 700, `found ${result.planRouteCount} plan routes`);
});

test('a route is a command or a printed Run:/Next: line; usage and a person\'s own words are not open', () => {
  assert.equal(routeIn('singularity-flow start PAY-1 --from-branch main'), 'singularity-flow start PAY-1 --from-branch main');
  assert.equal(routeIn('  Run: `singularity-flow decisions PAY-1` next'), 'singularity-flow decisions PAY-1');
  assert.equal(routeIn('Next: /sf-decide PAY-1'), '/sf-decide PAY-1');
  assert.equal(routeIn('Usage: singularity-flow start <WORK-ID>'), null);
  assert.equal(routeIn('Read the plan before you approve it.'), null);
  assert.deepEqual(openPlaceholders('singularity-flow reject build --work-id W --to plan --reason "<REASON>"'), []);
  assert.deepEqual(openPlaceholders('singularity-flow reopen W --to release --reason "<why the exception is renewed>"'), []);
  assert.deepEqual(openPlaceholders('singularity-flow start <WORK-ID> --from-branch <BRANCH> --title "<TITLE>"'), ['<WORK-ID>', '<BRANCH>']);
  for (const placeholder of ['<REASON>', '<ANSWER>', '<TITLE>', '<NOTE>', '<why>', '<reason>']) assert.ok(isPersonWords(placeholder), placeholder);
  for (const [placeholder, why] of Object.entries(PERSON_WORDS)) assert.ok(why.length >= 8, `${placeholder}: say why it is the person's`);
  // A route built as an argv array, and a placeholder a slot falls back to, are read too.
  const routes = routesOfSource('src/example.mjs', `
    const a = route('risk', ['decision', 'test-risk', id, '--expires', '<YYYY-MM-DD>', '--reason', '<why>']);
    const b = \`singularity-flow decisions \${workId ?? '<WORK-ID>'}\`;
    const c = 'singularity-flow nextsteps --json';`);
  assert.deepEqual([...new Set(routes.flatMap((entry) => openPlaceholders(entry.route)))].sort(), ['<WORK-ID>', '<YYYY-MM-DD>']);
  assert.ok(routes.some((entry) => entry.route === 'singularity-flow nextsteps --json'));
});

test('the audit entries this branch fixed hand over whole commands [audit 2026-11-19, groups 4 and 5]', async () => {
  const result = await scanOnce();
  const open = new Set(result.sources.map((entry) => entry.file));
  // Approver refresh and risk revoke (10, 25), test-policy confirmations (11), workflow import, copy and delete (14),
  // configuration proposals (23), Spec Studio's start (24), base branches (12), workspaces (13).
  for (const file of ['src/story-approver-refresh.mjs', 'src/story-test-command-amendment.mjs', 'src/presence/story-verify.mjs',
    'src/commands/workflow-retire.mjs', 'src/workflow-transfer-resolution.mjs', 'src/configuration-proposal-list.mjs',
    'src/configuration-drafts.mjs', 'apps/vscode/src/views/spec-studio-model.ts', 'apps/vscode/src/views/spec-studio-page.ts',
    'src/spec-library/split.mjs', 'src/capability-start.mjs', 'src/story-start-inputs.mjs', 'src/commands/story-test-selection.mjs',
    'src/commands/workspace.mjs', 'src/cli-entry.mjs', 'apps/vscode/src/views/refusal.ts']) {
    assert.ok(!open.has(file), `${file} hands over a command with something to fill in`);
  }
  const remediation = result.sources.filter((entry) => entry.file === 'src/refusal-remediation.mjs').map((entry) => entry.route).join('\n');
  // Workspaces (13), clarification answers (9), suggested test commands (8), planned claims (26), the final step (28),
  // the Repository brief, a capability map and a new Story (31).
  assert.doesNotMatch(remediation, /<WORKSPACE>|<QUESTION>|<SUGGESTION-ID>|<PHASES>|<FINAL-STEP>|wm brief --phase <|<CAPABILITY-ID>|<LEAD-URL>|<BASE>/u);
});
