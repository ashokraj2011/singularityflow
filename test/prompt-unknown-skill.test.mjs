/**
 * A typed `/sf-<word>` no SFlow skill has is said back to the person with the nearest names, never run as a turn under the
 * typo's name [owner, 2026-11-20, VS Code, hardening C]: `/sf-mext` (for /sf-next) started a read turn, "SFlow turn
 * boundary (sf-mext)", and the model went to the gateway, whose answer then refused for its size.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { explicitSflowSkill, unknownSkillReason } from '../src/copilot-repository-boundary.mjs';
import { copilotTurn, journeyRepository } from './helpers/route-follower.mjs';

const reason = (prompt) => unknownSkillReason(prompt, explicitSflowSkill(prompt));

test('an unknown /sf- word names the nearest skills; a known one, an alias and a host-expanded skill are turns as before', () => {
  assert.equal(reason('/sf-mext'), 'No SFlow command /sf-mext. Did you mean /sf-next? Type it again with the right name; nothing was run.');
  assert.equal(reason('/sf-aprove planning'), 'No SFlow command /sf-aprove. Did you mean /sf-approve? Type it again with the right name; nothing was run.');
  assert.equal(reason('/sf-zzzzqq'), 'No SFlow command /sf-zzzzqq. /sf-help lists them. Type it again with the right name; nothing was run.');
  for (const prompt of ['/sf-next', '/sf-next W-1', '/sflow-code', '/sf-decide W-1', '<skill-context name="sf-mext">x</skill-context>', 'plain words /sf-mext']) {
    assert.equal(reason(prompt), null, prompt);
  }
});

test('when the installed skills cannot be listed, nothing is refused', async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'sflow-no-skills-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal(unknownSkillReason('/sf-mext', 'sf-mext', { skillsRoot: path.join(empty, 'missing') }), null);
  await mkdir(path.join(empty, 'skills'));
  assert.equal(unknownSkillReason('/sf-mext', 'sf-mext', { skillsRoot: path.join(empty, 'skills') }), null);
});

test('through the real prompt hook: /sf-mext is held with the nearest name and starts no turn; /sf-next starts its turn', { timeout: 300_000 }, async (t) => {
  const story = await journeyRepository(t);
  for (const host of ['copilot-cli', 'vscode']) {
    const turn = copilotTurn(story, `unknown-skill-${host}`, { host });
    const held = turn.prompt('/sf-mext');
    assert.equal(held.decision, 'block', JSON.stringify(held));
    assert.equal(held.reason, 'No SFlow command /sf-mext. Did you mean /sf-next? Type it again with the right name; nothing was run.');
    assert.doesNotMatch(JSON.stringify(held), /SFlow turn boundary \(sf-mext\)/u);
    const next = turn.prompt('/sf-next');
    assert.notEqual(next.decision, 'block', JSON.stringify(next));
  }
});
