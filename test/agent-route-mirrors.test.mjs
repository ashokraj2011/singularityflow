import assert from 'node:assert/strict';
import test from 'node:test';
import { agentPacketPresentation } from '../src/agent-packet-presentation.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

// An action's routes, as the engine gives them: spread beside it and again in its own commandGuidance.
const routed = (argv, extra = {}) => {
  const guidance = safeCommandGuidance({ argv, skill: '/sf-phase' });
  return { id: argv.join('-'), timing: 'now', reason: 'Do it.', ...guidance, commandGuidance: guidance, ...extra };
};

test('an action keeps its routes once, in its commandGuidance, and act reads the same routes', () => {
  const full = { resultType: 'sflow-nextsteps', actions: [routed(['prepare', 'planning']),
    routed(['submit', 'planning'], { command: 'singularity-flow submit planning --work-id S-1' })],
  commandGuidance: { next: safeCommandGuidance({ argv: ['nextsteps'] }) } };
  const before = JSON.stringify(full);
  const view = agentPacketPresentation(full);
  assert.equal(JSON.stringify(full), before, 'the full result is never changed');
  const [prepare, submit] = view.actions;
  for (const key of ['command', 'argv', 'copilotCommand', 'skill', 'platformCommands', 'executable', 'copyable']) {
    assert.equal(Object.hasOwn(prepare, key), false, `${key} is said once, in commandGuidance`);
  }
  assert.deepEqual(Object.keys(prepare), ['id', 'timing', 'reason', 'commandGuidance']);
  assert.equal(prepare.commandGuidance.command, full.actions[0].commandGuidance.command);
  // A value that differs from its guidance is information, not a copy: it stays.
  assert.equal(submit.command, 'singularity-flow submit planning --work-id S-1');
  assert.equal(Object.hasOwn(submit, 'argv'), false);
  // A map of named guidance carries no single route of its own; nothing beside it is touched.
  assert.deepEqual(view.commandGuidance, agentPacketPresentation({ commandGuidance: full.commandGuidance }).commandGuidance);
  // act reads an action's routes from its commandGuidance first, so the view changes none of them.
  const act = agentAct(full);
  assert.ok(act?.do?.shell, JSON.stringify(act));
  assert.deepEqual(agentAct(view).do, act.do);
});
