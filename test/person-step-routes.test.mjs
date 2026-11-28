/**
 * Every step only a person takes has a place to take it with one press, or one plain line saying why it stays in their own
 * terminal [owner, 2026-11-28: terminal-only steps move to the card]. src/person-step-routes.mjs is that list; this keeps it
 * complete (one row per OWN_TERMINAL_STEPS entry) and true: a card row is one the Decide card records or runs, a page row is a
 * command the extension contributes.
 *
 * Before 2026-11-28 all 37 ran only in the person's own terminal from a chat, and about 27 had no screen either.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { OWN_TERMINAL_STEPS } from '../src/person-step-catalog.mjs';
import { OWN_STEP_ROUTES } from '../src/person-step-routes.mjs';
import { decideCardStep, modelFreeCommandForCommand, VSCODE_DECIDE_CARD } from '../src/model-free-commands.mjs';

const MAPPING = `sha256:${'a'.repeat(64)}`;
// One command form for each step the card takes: the card is its VS Code route, and /sf-decide its Copilot one.
const CARD_FORMS = {
  risk: 'singularity-flow decision risk PAY-1 --obligation OBL-001 --category evidence --expires 2099-01-01 --reason "Accepted until the lab returns."',
  'witness-exception-renewal': `singularity-flow decision witness-exception PAY-1 --phase build --mapping ${MAPPING} --expires 2099-01-01 --reason "The device lab is still down."`,
  'visual-screenshot': 'singularity-flow decision screenshot PAY-1 --criterion PAY-1:AC-001 --slot screen',
  'test-run-risk': 'singularity-flow decision finding-risk PAY-1 --phase build --finding F-0123456789abcdef --expires 2099-01-01 --reason "The nested branches mirror the table."',
  'test-command-decision': 'singularity-flow decision test-command PAY-1 --accept TCD-001',
  'decision-list-record': 'singularity-flow decisions record PAY-1',
  'refactor-behaviour': 'singularity-flow work behaviour accept --work-id PAY-1',
  'intent-amendment-decision': 'singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id PAY-1',
  'upstream-amendment-decision': 'singularity-flow upstream-issue decide-amendment FAM-001 --work-id PAY-1 --decision reject --reason "The approved plan already covers it." --confirm FAM-001'
};

test('every step only a person takes has its place, and one plain line why', () => {
  assert.deepEqual(Object.keys(OWN_STEP_ROUTES).sort(), OWN_TERMINAL_STEPS.map((step) => step.id).sort(), 'one row per own step, no more');
  for (const [id, route] of Object.entries(OWN_STEP_ROUTES)) {
    assert.ok(['card', 'page', 'terminal'].includes(route.where), id);
    // One plain line: a sentence, short enough to read beside a button.
    assert.match(route.why, /^[A-Z][^\n]{10,150}[.)]$/u, `${id}: ${route.why}`);
    assert.doesNotMatch(route.why, /\b(?:generation|digest|packet|ledger|kernel|retained|binding)s?\b/iu, `${id} reads as engine talk`);
    if (route.where === 'terminal') assert.ok(['for-good', 'until-row'].includes(route.kept), `${id} says whether it stays for good`);
  }
});

test('a card row is one the Decide card records or runs, and its chat route opens the card', () => {
  const onCard = Object.entries(OWN_STEP_ROUTES).filter(([, route]) => route.where === 'card').map(([id]) => id);
  assert.deepEqual(onCard.sort(), Object.keys(CARD_FORMS).sort(), 'every card row has its form here');
  for (const [id, command] of Object.entries(CARD_FORMS)) {
    assert.equal(modelFreeCommandForCommand(command), VSCODE_DECIDE_CARD, `${id}: ${command}`);
    // The step itself, as the catalog knows it, so the row and the guard name the same step.
    const words = command.split(/\s+/u).slice(1);
    const step = OWN_TERMINAL_STEPS.find((entry) => entry.matches(words.filter((word) => !word.startsWith('-') && !/^["']/u.test(word)).slice(0, 3),
      Object.fromEntries(words.flatMap((word, at) => (word.startsWith('--') ? [[word.slice(2), words[at + 1]?.startsWith('--') ? true : words[at + 1] ?? true]] : [])))));
    assert.equal(step?.id, id, command);
    if (id !== 'decision-list-record') assert.equal(decideCardStep(command.split(/\s+/u).slice(1)), true, `${id}: /sf-decide opens the card for it`);
  }
});

test('a page row is a command the extension contributes; what stays in a terminal is counted', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));
  for (const [id, route] of Object.entries(OWN_STEP_ROUTES).filter(([, entry]) => entry.where === 'page')) {
    assert.ok(commands.has(route.page), `${id}: ${route.page} is not a contributed command`);
  }
  const count = (where, kept) => Object.values(OWN_STEP_ROUTES).filter((route) => route.where === where && (!kept || route.kept === kept)).length;
  // 37 own steps: 9 on the Decide card, 14 on a page, 8 in the person's own terminal for good, 6 until a screen has a row.
  assert.deepEqual({ card: count('card'), page: count('page'), terminal: count('terminal', 'for-good'), later: count('terminal', 'until-row') },
    { card: 9, page: 14, terminal: 8, later: 6 });
});
