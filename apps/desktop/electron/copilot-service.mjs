import path from 'node:path';

function publicEvent(event) {
  const { raw: _raw, ...safe } = event ?? {};
  if (typeof safe.text === 'string') safe.text = safe.text.slice(-8_000);
  if (typeof safe.detail === 'string') safe.detail = safe.detail.slice(-8_000);
  return safe;
}

const TOKEN_FIELDS = ['totalTokens', 'inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens'];

function tokenValue(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function reportedModel(event) {
  return event?.model
    ?? event?.meta?.model
    ?? event?.meta?.responseModel
    ?? event?.meta?.['gen_ai.response.model']
    ?? event?.usage?._meta?.model
    ?? null;
}

function usageModel(event, service) {
  return reportedModel(event)
    ?? service.model
    ?? service.requestedModel
    ?? 'Copilot auto';
}

function emptyUsage() {
  return {
    turns: 0,
    exactTurns: 0,
    unavailableTurns: 0,
    totals: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])),
    seen: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, false])),
    lastCumulative: null,
    byModel: new Map()
  };
}

function serializedUsage(usage) {
  const values = Object.fromEntries(TOKEN_FIELDS.map((field) => [
    field,
    usage.seen[field] ? usage.totals[field] : null
  ]));
  return {
    status: usage.exactTurns
      ? usage.unavailableTurns ? 'partial' : 'exact'
      : 'unavailable',
    turns: usage.turns,
    exactTurns: usage.exactTurns,
    unavailableTurns: usage.unavailableTurns,
    ...values,
    byModel: [...usage.byModel.values()]
      .map((entry) => ({
        model: entry.model,
        turns: entry.turns,
        ...Object.fromEntries(TOKEN_FIELDS.map((field) => [
          field,
          entry.seen[field] ? entry.totals[field] : null
        ]))
      }))
      .sort((left, right) => (right.totalTokens ?? 0) - (left.totalTokens ?? 0) || left.model.localeCompare(right.model))
  };
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
    if (event.type === 'ready' && !service.stopRequested) {
      service.state = 'ready';
      service.version = event.version ?? service.version;
      service.mode = event.modes?.currentModeId ?? 'plan';
      service.sessionId = event.sessionId ?? service.sessionId;
      service.connectedAt ??= normalized.at;
      service.model = event.model ?? service.model ?? service.requestedModel;
      service.availableModels = event.models ?? service.availableModels;
      service.modelSwitchSupported = event.modelSwitchSupported ?? service.modelSwitchSupported;
    }
    if (['model-changed', 'config_option_update'].includes(event.type)) {
      service.model = event.model ?? service.model;
      service.availableModels = event.models ?? service.availableModels;
      service.modelSwitchSupported = event.modelSwitchSupported ?? service.modelSwitchSupported;
    }
    if (event.type === 'turn-started' && !service.stopRequested) service.state = 'busy';
    if (event.type === 'turn-complete') this.#recordUsage(service, event);
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

  #recordUsage(service, event) {
    const usage = service.usage;
    usage.turns += 1;
    const snapshot = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, tokenValue(event.usage?.[field])]));
    if (!TOKEN_FIELDS.some((field) => snapshot[field] !== null)) {
      usage.unavailableTurns += 1;
      return;
    }
    usage.exactTurns += 1;
    const previous = usage.lastCumulative;
    const reset = previous && snapshot.totalTokens !== null && previous.totalTokens !== null
      && snapshot.totalTokens < previous.totalTokens;
    const delta = {};
    for (const field of TOKEN_FIELDS) {
      if (snapshot[field] === null) {
        delta[field] = null;
        continue;
      }
      const prior = reset ? null : previous?.[field];
      delta[field] = prior === null || prior === undefined
        ? snapshot[field]
        : Math.max(0, snapshot[field] - prior);
      usage.totals[field] += delta[field];
      usage.seen[field] = true;
    }
    usage.lastCumulative = snapshot;
    const resolvedModel = reportedModel(event);
    if (resolvedModel) service.model = resolvedModel;
    const model = usageModel(event, service);
    const aggregate = usage.byModel.get(model) ?? {
      model,
      turns: 0,
      totals: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])),
      seen: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, false]))
    };
    aggregate.turns += 1;
    for (const field of TOKEN_FIELDS) {
      if (delta[field] === null) continue;
      aggregate.totals[field] += delta[field];
      aggregate.seen[field] = true;
    }
    usage.byModel.set(model, aggregate);
  }

  #statusValue(service) {
    if (!service) return {
      state: 'stopped', running: false, startedAt: null, connectedAt: null, stoppedAt: null,
      version: null, mode: null, processId: null, activePlanningSessionId: null,
      model: null, requestedModel: null, availableModels: [], modelSwitchSupported: false,
      usage: serializedUsage(emptyUsage()), lastEvent: null, canStop: false
    };
    return {
      state: service.state,
      running: ['starting', 'ready', 'busy', 'stopping'].includes(service.state),
      startedAt: service.startedAt,
      connectedAt: service.connectedAt ?? null,
      stoppedAt: service.stoppedAt ?? null,
      version: service.version ?? null,
      mode: service.mode ?? null,
      model: service.model ?? service.requestedModel ?? null,
      requestedModel: service.requestedModel ?? null,
      availableModels: service.availableModels ?? [],
      modelSwitchSupported: Boolean(service.modelSwitchSupported),
      usage: serializedUsage(service.usage ?? emptyUsage()),
      processId: service.bridge?.process?.pid ?? null,
      activePlanningSessionId: service.activePlanningSessionId ?? null,
      lastEvent: service.lastEvent ?? null,
      canStop: Boolean(service.bridge && service.state !== 'stopped')
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
    if (current?.startPromise) return current.startPromise;
    if (current && ['ready', 'busy'].includes(current.state)) {
      if (model && model !== current.model) return this.setModel(key, model);
      return this.status(key);
    }
    if (current?.state === 'stopping') throw new Error('Copilot backend is still stopping. Wait for it to finish before starting again.');
    if (current?.state === 'error' && current.bridge) {
      throw new Error('The previous Copilot backend did not stop cleanly. Retry Stop or restart Singularity Desktop before starting another backend.');
    }
    const check = this.preflight();
    if (!check.ready) throw new Error(check.message);
    const service = {
      repository: key,
      state: 'starting',
      startedAt: this.now(),
      connectedAt: null,
      stoppedAt: null,
      version: check.version,
      mode: 'plan',
      requestedModel: model,
      model: model,
      availableModels: [],
      modelSwitchSupported: false,
      usage: emptyUsage(),
      sessionId: null,
      activePlanningSessionId: null,
      lastEvent: null,
      logs: current?.logs ?? [],
      bridge: null,
      startPromise: null,
      stopRequested: false
    };
    const bridge = this.bridgeFactory({
      repository: key,
      emit: (event) => this.#record(key, event)
    });
    service.bridge = bridge;
    this.services.set(key, service);
    this.#record(key, { type: 'service-starting', message: 'Starting Copilot ACP in native Plan mode.' });
    service.startPromise = (async () => {
      try {
        const result = await bridge.start({ model });
        if (service.stopRequested) return this.status(key);
        service.state = 'ready';
        service.version = result.version ?? service.version;
        service.mode = result.mode ?? 'plan';
        service.sessionId = result.sessionId ?? service.sessionId;
        service.connectedAt ??= this.now();
        service.model = result.model ?? service.model;
        service.availableModels = result.models ?? service.availableModels;
        service.modelSwitchSupported = result.modelSwitchSupported ?? service.modelSwitchSupported;
        return this.status(key);
      } catch (error) {
        if (service.stopRequested) return this.status(key);
        service.state = 'error';
        this.#record(key, { type: 'service-start-error', message: `Copilot backend could not start: ${error.message}` });
        try {
          await bridge.stop();
          service.bridge = null;
        } catch (cleanupError) {
          this.#record(key, { type: 'service-cleanup-error', message: `Copilot startup cleanup failed: ${cleanupError.message}` });
        }
        throw error;
      }
    })();
    try {
      return await service.startPromise;
    } finally {
      service.startPromise = null;
    }
  }

  async setModel(repository, model) {
    const key = this.#key(repository);
    const service = this.services.get(key);
    if (!service?.bridge || !['ready', 'busy'].includes(service.state)) {
      throw new Error('Start the Copilot backend before changing its active model.');
    }
    if (service.state === 'busy' || service.activePlanningSessionId) {
      throw new Error('Finish or release the active planning turn before changing the Copilot model.');
    }
    const result = await service.bridge.setModel(model);
    service.model = result.model ?? model;
    service.requestedModel = model;
    service.availableModels = result.models ?? service.availableModels;
    service.modelSwitchSupported = result.modelSwitchSupported ?? service.modelSwitchSupported;
    return this.status(key);
  }

  async beginPlanning(repository, planningSessionId, { prompt, model = null } = {}) {
    const key = this.#key(repository);
    await this.start(key, { model });
    const service = this.services.get(key);
    if (service.activePlanningSessionId && service.activePlanningSessionId !== planningSessionId) {
      throw new Error(`Copilot is already attached to planning session ${service.activePlanningSessionId}. Stop or finish it before starting another.`);
    }
    if (!prompt?.trim()) throw new Error('The initial planning prompt cannot be empty.');
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
    if (!text?.trim()) throw new Error('Planning follow-up cannot be empty.');
    if (service.bridge.running) throw new Error('Copilot is still finishing the previous planning turn. Wait for it to become ready.');
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
    const cancellation = await service.bridge.cancelCurrentTurn();
    if (service.bridge.running && !cancellation?.cancelled) {
      throw new Error('The active Copilot planning turn could not be cancelled. Wait for it to finish or stop the backend before releasing this context.');
    }
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
    service.stopRequested = true;
    service.state = 'stopping';
    this.#record(key, { type: 'service-stopping', message: 'Stopping Copilot ACP backend.' });
    try {
      await service.bridge.stop();
    } catch (error) {
      service.state = 'error';
      this.#record(key, { type: 'service-stop-error', message: `Copilot backend could not be stopped cleanly: ${error.message}` });
      if (activePlanningSessionId) {
        this.emit('planning:event', {
          planningSessionId: activePlanningSessionId,
          type: 'error',
          message: `Copilot backend could not be stopped cleanly: ${error.message}`
        });
      }
      throw error;
    }
    service.activePlanningSessionId = null;
    service.state = 'stopped';
    service.stoppedAt = this.now();
    if (activePlanningSessionId) {
      this.emit('planning:event', {
        planningSessionId: activePlanningSessionId,
        type: 'process-exit',
        code: null,
        signal: 'service-stop',
        message: 'The Copilot backend was stopped from the desktop service control.'
      });
    }
    this.#record(key, { type: 'service-stopped', message: 'Copilot ACP backend stopped.' });
    return this.status(key);
  }

  async stopAll() {
    await Promise.all([...this.services.keys()].map((repository) => this.stop(repository).catch(() => null)));
  }
}
