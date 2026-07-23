import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CopilotBackendController } from '../apps/desktop/electron/copilot-service.mjs';

class FakeBridge {
  constructor({ emit }) {
    this.emit = emit;
    this.running = false;
    this.process = { pid: 4242 };
    this.prompts = [];
    this.cancelled = 0;
    this.stopped = 0;
  }

  async start({ model }) {
    this.model = model;
    this.emit({
      type: 'ready',
      sessionId: 'acp-session-1',
      version: '1.0.73',
      modes: { currentModeId: 'plan' }
    });
    return { sessionId: 'acp-session-1', version: '1.0.73', mode: 'plan' };
  }

  async prompt(text) {
    this.running = true;
    this.prompts.push(text);
    this.emit({ type: 'turn-started', text });
    this.emit({ type: 'agent_message_chunk', text: 'Governed proposal' });
    this.running = false;
    this.emit({ type: 'turn-complete', stopReason: 'end_turn', usage: { totalTokens: 42 } });
    return { stopReason: 'end_turn' };
  }

  answerQuestion(questionId, answer) {
    return { accepted: true, questionId, answer };
  }

  async cancelCurrentTurn() {
    this.cancelled += 1;
    this.running = false;
    return { cancelled: true };
  }

  async stop() {
    this.stopped += 1;
    this.running = false;
    return { stopped: true };
  }
}

test('Copilot backend starts once, routes planning events, releases context, and stops explicitly', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-service');
  const events = [];
  const bridges = [];
  let tick = 0;
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73', message: 'ready' }),
    bridgeFactory: (options) => {
      const bridge = new FakeBridge(options);
      bridges.push(bridge);
      return bridge;
    },
    emit: (channel, payload) => events.push({ channel, payload }),
    now: () => `2026-07-24T00:00:${String(tick++).padStart(2, '0')}.000Z`
  });

  const started = await controller.start(repository, { model: 'claude-sonnet' });
  assert.equal(started.running, true);
  assert.equal(started.state, 'ready');
  assert.equal(started.processId, 4242);
  assert.equal(bridges.length, 1);
  assert.equal(bridges[0].model, 'claude-sonnet');
  await controller.start(repository);
  assert.equal(bridges.length, 1);

  const planning = await controller.beginPlanning(repository, 'planning-1', { prompt: 'Read the governed context.' });
  assert.equal(planning.reusedBackend, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridges[0].prompts, ['Read the governed context.']);
  assert.ok(events.some((event) => event.channel === 'planning:event' && event.payload.planningSessionId === 'planning-1' && event.payload.type === 'agent_message_chunk'));
  assert.equal(controller.status(repository).state, 'ready');
  await assert.rejects(
    () => controller.beginPlanning(repository, 'planning-2', { prompt: 'Competing context.' }),
    /already attached/
  );

  const answer = controller.answer(repository, 'planning-1', 'question-1', { content: { repository: 'mobile' } });
  assert.equal(answer.accepted, true);
  const released = await controller.releasePlanning(repository, 'planning-1');
  assert.equal(released.released, true);
  assert.equal(released.service.running, true);
  assert.equal(released.service.activePlanningSessionId, null);
  assert.equal(bridges[0].cancelled, 1);
  assert.ok(controller.logs(repository).some((entry) => entry.type === 'planning-released'));

  const stopped = await controller.stop(repository);
  assert.equal(stopped.running, false);
  assert.equal(stopped.state, 'stopped');
  assert.equal(bridges[0].stopped, 1);
  assert.ok(controller.logs(repository).some((entry) => entry.type === 'service-stopped'));
});

test('stopping the Copilot backend notifies an attached planning UI and preflight blocks launch', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-stop');
  const events = [];
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => new FakeBridge(options),
    emit: (channel, payload) => events.push({ channel, payload })
  });
  await controller.beginPlanning(repository, 'planning-active', { prompt: 'Plan.' });
  await new Promise((resolve) => setImmediate(resolve));
  await controller.stop(repository);
  assert.ok(events.some((event) => event.channel === 'planning:event'
    && event.payload.planningSessionId === 'planning-active'
    && event.payload.type === 'process-exit'
    && event.payload.signal === 'service-stop'));

  const exitEvents = [];
  let exitBridge;
  const unexpected = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => {
      exitBridge = new FakeBridge(options);
      return exitBridge;
    },
    emit: (channel, payload) => exitEvents.push({ channel, payload })
  });
  await unexpected.beginPlanning(repository, 'planning-unexpected', { prompt: 'Plan.' });
  await new Promise((resolve) => setImmediate(resolve));
  exitBridge.emit({ type: 'process-exit', code: 7, signal: null });
  assert.ok(exitEvents.some((event) => event.channel === 'planning:event'
    && event.payload.planningSessionId === 'planning-unexpected'
    && event.payload.type === 'process-exit'
    && event.payload.code === 7));
  assert.equal(unexpected.status(repository).state, 'stopped');

  const unavailable = new CopilotBackendController({
    preflight: () => ({ ready: false, message: 'Install GitHub Copilot CLI with ACP support.' }),
    bridgeFactory: () => { throw new Error('must not launch'); }
  });
  assert.equal(unavailable.status(repository).preflight.ready, false);
  await assert.rejects(() => unavailable.start(repository), /ACP support/);
});
