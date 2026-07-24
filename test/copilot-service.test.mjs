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

class DelayedStartBridge extends FakeBridge {
  async start({ model }) {
    this.model = model;
    return new Promise((resolve) => {
      this.finishStart = () => {
        this.emit({
          type: 'ready',
          sessionId: 'acp-session-delayed',
          version: '1.0.73',
          modes: { currentModeId: 'plan' }
        });
        resolve({ sessionId: 'acp-session-delayed', version: '1.0.73', mode: 'plan' });
      };
    });
  }
}

class HoldingBridge extends FakeBridge {
  async prompt(text) {
    this.running = true;
    this.prompts.push(text);
    this.emit({ type: 'turn-started', text });
    return new Promise((resolve) => {
      this.finishPrompt = () => {
        this.running = false;
        this.emit({ type: 'turn-complete', stopReason: 'end_turn' });
        resolve({ stopReason: 'end_turn' });
      };
    });
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

test('concurrent Copilot starts share one initialization and do not expose a half-started backend', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-concurrent-start');
  const bridges = [];
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => {
      const bridge = new DelayedStartBridge(options);
      bridges.push(bridge);
      return bridge;
    }
  });
  const first = controller.start(repository);
  let secondResolved = false;
  const second = controller.start(repository).then((value) => {
    secondResolved = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridges.length, 1);
  assert.equal(secondResolved, false);
  bridges[0].finishStart();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);
  assert.equal(firstStatus.state, 'ready');
  assert.equal(secondStatus.state, 'ready');
  assert.equal(firstStatus.sessionId, secondStatus.sessionId);
});

test('planning prompts fail visibly instead of being accepted while a turn is still running', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-busy-prompt');
  let bridge;
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => {
      bridge = new HoldingBridge(options);
      return bridge;
    }
  });
  await controller.beginPlanning(repository, 'planning-busy', { prompt: 'Initial plan.' });
  assert.equal(bridge.running, true);
  assert.throws(() => controller.prompt(repository, 'planning-busy', 'Overlapping follow-up.'), /still finishing/);
  assert.throws(() => controller.prompt(repository, 'planning-busy', '   '), /cannot be empty/);
  bridge.finishPrompt();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridge.prompts, ['Initial plan.']);
});

test('a backend stop failure leaves an actionable error state instead of remaining stuck on stopping', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-stop-failure');
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => {
      const bridge = new FakeBridge(options);
      bridge.stop = async () => { throw new Error('process would not stop'); };
      return bridge;
    }
  });
  await controller.start(repository);
  await assert.rejects(() => controller.stop(repository), /process would not stop/);
  const status = controller.status(repository);
  assert.equal(status.state, 'error');
  assert.equal(status.running, false);
  assert.equal(status.canStop, true);
  assert.match(status.lastEvent.message, /could not be stopped cleanly/i);
});

test('release keeps the planning context attached when the active turn cannot be cancelled', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-release-failure');
  let bridge;
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => {
      bridge = new HoldingBridge(options);
      bridge.cancelCurrentTurn = async () => ({ cancelled: false });
      return bridge;
    }
  });
  await controller.beginPlanning(repository, 'planning-cancel-failure', { prompt: 'Long-running plan.' });
  await assert.rejects(
    () => controller.releasePlanning(repository, 'planning-cancel-failure'),
    /could not be cancelled/
  );
  assert.equal(controller.status(repository).activePlanningSessionId, 'planning-cancel-failure');
  assert.equal(bridge.running, true);
  bridge.finishPrompt();
});

test('stopping during startup cannot be overwritten when delayed initialization completes', async () => {
  const repository = path.join(os.tmpdir(), 'sflow-copilot-stop-during-start');
  let bridge;
  const controller = new CopilotBackendController({
    preflight: () => ({ ready: true, version: '1.0.73' }),
    bridgeFactory: (options) => {
      bridge = new DelayedStartBridge(options);
      return bridge;
    }
  });
  const starting = controller.start(repository);
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = await controller.stop(repository);
  assert.equal(stopped.state, 'stopped');
  bridge.finishStart();
  const completedStart = await starting;
  assert.equal(completedStart.state, 'stopped');
  assert.equal(controller.status(repository).state, 'stopped');
});
