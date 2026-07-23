import path from 'node:path';

function publicEvent(event) {
  const { raw: _raw, ...safe } = event ?? {};
  if (typeof safe.text === 'string') safe.text = safe.text.slice(-8_000);
  if (typeof safe.detail === 'string') safe.detail = safe.detail.slice(-8_000);
  return safe;
}

export class CopilotBackendController {
  constructor({
    bridgeFactory,
    preflight,
    emit = () => {},
    now = () => new Date().toISOString(),
    maxLogs = 300
  } = {}) {
    this.bridgeFactory = bridgeFactory;
    this.preflight = preflight;
    this.emit = emit;
    this.now = now;
    this.maxLogs = maxLogs;
    this.services = new Map();
  }

  #key(repository) { return path.resolve(repository); }

  #record(repository, event) {
    const key = this.#key(repository);
    const service = this.services.get(key);
    if (!service) return;
    const planningSessionId = service.activePlanningSessionId;
    const normalized = { at: this.now(), ...publicEvent(event) };
    service.logs.push(normalized);
    service.logs = service.logs.slice(-this.maxLogs);
    service.lastEvent = normalized;
    if (event.type === 'ready') {
      service.state = 'ready';
      service.version = event.version ?? service.version;
      service.mode = event.modes?.currentModeId ?? 'plan';
      service.sessionId = event.sessionId ?? service.sessionId;
    }
    if (event.type === 'turn-started') service.state = 'busy';
    if (event.type === 'turn-complete' || event.type === 'error') service.state = 'ready';
    if (event.type === 'process-exit') {
      service.state = 'stopped';
      service.stoppedAt = this.now();
      service.activePlanningSessionId = null;
    }
    this.emit('copilot-service:event', { repository: key, ...normalized, service: this.#statusValue(service) });
    if (planningSessionId) {
      this.emit('planning:event', { planningSessionId, ...normalized });
    }
  }

  #statusValue(service) {
    if (!service) return {
      state: 'stopped', running: false, startedAt: null, stoppedAt: null,
      version: null, mode: null, processId: null, activePlanningSessionId: null,
      lastEvent: null
    };
    return {
      state: service.state,
      running: ['starting', 'ready', 'busy', 'stopping'].includes(service.state),
      startedAt: service.startedAt,
      stoppedAt: service.stoppedAt ?? null,
      version: service.version ?? null,
      mode: service.mode ?? null,
      processId: service.bridge?.process?.pid ?? null,
      activePlanningSessionId: service.activePlanningSessionId ?? null,
      lastEvent: service.lastEvent ?? null
    };
  }

  status(repository) {
    const key = this.#key(repository);
    return { ...this.#statusValue(this.services.get(key)), preflight: this.preflight() };
  }

  logs(repository) {
    const key = this.#key(repository);
    return [...(this.services.get(key)?.logs ?? [])];
  }

  async start(repository, { model = null } = {}) {
    const key = this.#key(repository);
    const current = this.services.get(key);
    if (current && ['starting', 'ready', 'busy'].includes(current.state)) return this.status(key);
    if (current?.state === 'stopping') throw new Error('Copilot backend is still stopping. Wait for it to finish before starting again.');
    const check = this.preflight();
    if (!check.ready) throw new Error(check.message);
    const service = {
      repository: key,
      state: 'starting',
      startedAt: this.now(),
      stoppedAt: null,
      version: check.version,
      mode: 'plan',
      sessionId: null,
      activePlanningSessionId: null,
      lastEvent: null,
      logs: current?.logs ?? [],
      bridge: null
    };
    const bridge = this.bridgeFactory({
      repository: key,
      emit: (event) => this.#record(key, event)
    });
    service.bridge = bridge;
    this.services.set(key, service);
    this.#record(key, { type: 'service-starting', message: 'Starting Copilot ACP in native Plan mode.' });
    try {
      const result = await bridge.start({ model });
      service.state = 'ready';
      service.version = result.version ?? service.version;
      service.mode = result.mode ?? 'plan';
      service.sessionId = result.sessionId ?? service.sessionId;
      return this.status(key);
    } catch (error) {
      service.state = 'error';
      service.lastEvent = { at: this.now(), type: 'error', message: error.message };
      try { await bridge.stop(); } catch {}
      throw error;
    }
  }

  async beginPlanning(repository, planningSessionId, { prompt, model = null } = {}) {
    const key = this.#key(repository);
    await this.start(key, { model });
    const service = this.services.get(key);
    if (service.activePlanningSessionId && service.activePlanningSessionId !== planningSessionId) {
      throw new Error(`Copilot is already attached to planning session ${service.activePlanningSessionId}. Stop or finish it before starting another.`);
    }
    if (service.bridge.running) throw new Error('Copilot is still finishing the previous planning turn. Wait for it to become ready.');
    service.activePlanningSessionId = planningSessionId;
    this.emit('planning:event', {
      planningSessionId,
      type: 'ready',
      sessionId: service.sessionId,
      version: service.version,
      modes: { currentModeId: service.mode },
      reusedBackend: true
    });
    void service.bridge.prompt(prompt).catch(() => {});
    return { ...this.status(key), planningSessionId, sessionId: service.sessionId, reusedBackend: true };
  }

  prompt(repository, planningSessionId, text) {
    const key = this.#key(repository);
    const service = this.services.get(key);
    if (!service?.bridge || ['stopped', 'stopping', 'error'].includes(service.state)) throw new Error('Copilot backend service is not running.');
    if (service.activePlanningSessionId !== planningSessionId) throw new Error('This planning context is not attached to the active Copilot backend.');
    void service.bridge.prompt(text).catch(() => {});
    return { accepted: true };
  }

  answer(repository, planningSessionId, questionId, answer) {
    const service = this.services.get(this.#key(repository));
    if (!service?.bridge || service.activePlanningSessionId !== planningSessionId) throw new Error('This planning context is not attached to the active Copilot backend.');
    return service.bridge.answerQuestion(questionId, answer);
  }

  async releasePlanning(repository, planningSessionId) {
    const service = this.services.get(this.#key(repository));
    if (!service?.bridge || service.activePlanningSessionId !== planningSessionId) return { released: false, service: this.status(repository) };
    await service.bridge.cancelCurrentTurn();
    service.activePlanningSessionId = null;
    if (service.state !== 'stopped') service.state = 'ready';
    this.#record(repository, { type: 'planning-released', message: `Released planning context ${planningSessionId}; backend remains ready.` });
    return { released: true, service: this.status(repository) };
  }

  async stop(repository) {
    const key = this.#key(repository);
    const service = this.services.get(key);
    if (!service?.bridge || service.state === 'stopped') return this.status(key);
    const activePlanningSessionId = service.activePlanningSessionId;
    service.state = 'stopping';
    this.#record(key, { type: 'service-stopping', message: 'Stopping Copilot ACP backend.' });
    if (activePlanningSessionId) {
      this.emit('planning:event', {
        planningSessionId: activePlanningSessionId,
        type: 'process-exit',
        code: null,
        signal: 'service-stop',
        message: 'The Copilot backend was stopped from the desktop service control.'
      });
    }
    service.activePlanningSessionId = null;
    await service.bridge.stop();
    service.state = 'stopped';
    service.stoppedAt = this.now();
    this.#record(key, { type: 'service-stopped', message: 'Copilot ACP backend stopped.' });
    return this.status(key);
  }

  async stopAll() {
    await Promise.all([...this.services.keys()].map((repository) => this.stop(repository).catch(() => null)));
  }
}
