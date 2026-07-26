import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

const MAX_PLAN_FILE_BYTES = 1024 * 1024;
// A single governed read should never pull a lockfile-sized blob into the turn.
const MAX_READ_FILE_BYTES = 2 * 1024 * 1024;

function executableCandidates(env = process.env) {
  const configured = env.SINGULARITY_FLOW_COPILOT_PATH ? [env.SINGULARITY_FLOW_COPILOT_PATH] : [];
  const names = process.platform === 'win32' ? ['copilot.exe', 'copilot.cmd', 'copilot.bat'] : ['copilot'];
  const fromPath = String(env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap((directory) => names.map((name) => path.join(directory, name)));
  const conventional = process.platform === 'darwin'
    ? ['/opt/homebrew/bin/copilot', '/usr/local/bin/copilot']
    : process.platform === 'win32'
      ? []
      : ['/usr/local/bin/copilot', '/usr/bin/copilot'];
  return [...new Set([...configured, ...fromPath, ...conventional])];
}

export function findCopilotExecutable(env = process.env) {
  return executableCandidates(env).find((candidate) => existsSync(candidate)) ?? null;
}

export function copilotPlanningPreflight({ env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const executable = findCopilotExecutable(env);
  if (!executable) {
    return {
      ready: false,
      installed: false,
      acp: false,
      planMode: false,
      executable: null,
      version: null,
      message: 'GitHub Copilot CLI was not found. Install it and authenticate before starting Copilot Studio.'
    };
  }
  const versionResult = spawnSyncImpl(executable, ['--version'], { encoding: 'utf8', env });
  const helpResult = spawnSyncImpl(executable, ['--help'], { encoding: 'utf8', env });
  const help = `${helpResult.stdout ?? ''}\n${helpResult.stderr ?? ''}`;
  const acpAvailable = help.includes('--acp');
  const planAvailable = help.includes('--mode <mode>') || help.includes('--plan');
  const version = String(versionResult.stdout || versionResult.stderr || '').trim().split(/\r?\n/)[0] || null;
  return {
    ready: versionResult.status === 0 && acpAvailable && planAvailable,
    installed: versionResult.status === 0,
    acp: acpAvailable,
    planMode: planAvailable,
    executable,
    version,
    message: versionResult.status !== 0
      ? 'GitHub Copilot CLI could not be started.'
      : !acpAvailable
        ? 'This Copilot CLI does not expose the ACP server required by Copilot Studio. Update Copilot CLI.'
        : !planAvailable
          ? 'This Copilot CLI does not expose native Plan mode. Update Copilot CLI.'
          : 'Copilot ACP and native Plan mode are available.'
  };
}

function textContent(content) {
  return content?.type === 'text' ? content.text : '';
}

function planEntries(entries = []) {
  return entries.map((entry) => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`).join('\n');
}

function flattenedOptions(options = []) {
  return options.flatMap((option) => Array.isArray(option?.options) ? option.options : [option]);
}

export function modelConfiguration(configOptions = [], fallback = null) {
  const option = configOptions.find((candidate) => candidate?.type === 'select'
    && (candidate.category === 'model' || candidate.id === 'model' || candidate.name?.toLowerCase() === 'model'));
  if (!option) {
    return {
      configId: null,
      current: fallback,
      available: [],
      switchSupported: false
    };
  }
  return {
    configId: option.id,
    current: option.currentValue ?? fallback,
    available: flattenedOptions(option.options).filter((candidate) => candidate?.value).map((candidate) => ({
      value: candidate.value,
      label: candidate.name ?? candidate.value,
      description: candidate.description ?? null
    })),
    switchSupported: true
  };
}

async function planningFileUpdate(base, plan, repository) {
  const planId = plan?.planId ?? null;
  let absolute;
  try {
    absolute = fileURLToPath(plan?.uri);
  } catch {
    return { ...base, warning: 'Copilot returned an invalid file URL for its plan; it was not loaded.', planId };
  }
  if (!repository) return { ...base, warning: 'Copilot returned a plan file without an open repository boundary; it was not loaded.', planId };
  const relative = path.relative(repository, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ...base, warning: 'Copilot returned a plan file outside the open repository; it was not loaded.', planId };
  }
  try {
    const entry = await lstat(absolute);
    if (entry.isSymbolicLink()) {
      return { ...base, warning: 'Copilot returned a symbolic link as a plan file; it was not loaded.', planId };
    }
    if (!entry.isFile()) return { ...base, warning: 'Copilot returned a plan path that is not a regular file; it was not loaded.', planId };
    const [canonicalRepository, canonicalFile] = await Promise.all([realpath(repository), realpath(absolute)]);
    const canonicalRelative = path.relative(canonicalRepository, canonicalFile);
    if (canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
      return { ...base, warning: 'Copilot returned a plan file that resolves outside the open repository; it was not loaded.', planId };
    }
    if (entry.size > MAX_PLAN_FILE_BYTES) {
      return { ...base, warning: `Copilot plan file exceeds the ${MAX_PLAN_FILE_BYTES}-byte safety limit; it was not loaded.`, planId };
    }
    return { ...base, plan: await readFile(canonicalFile, 'utf8'), planPath: canonicalFile, planId };
  } catch (error) {
    return { ...base, warning: `Copilot plan file could not be loaded safely: ${error.message}`, planId };
  }
}

export async function normalizePlanningUpdate(update, { repository } = {}) {
  const base = { type: update.sessionUpdate, raw: update };
  if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(update.sessionUpdate)) {
    return { ...base, text: textContent(update.content), messageId: update.messageId ?? null };
  }
  if (update.sessionUpdate === 'plan') return { ...base, plan: planEntries(update.entries), entries: update.entries };
  if (update.sessionUpdate === 'plan_update') {
    if (update.plan?.type === 'markdown') return { ...base, plan: update.plan.content, planId: update.plan.planId };
    if (update.plan?.type === 'items') return { ...base, plan: planEntries(update.plan.entries), entries: update.plan.entries, planId: update.plan.planId };
    if (update.plan?.type === 'file') return planningFileUpdate(base, update.plan, repository);
  }
  if (update.sessionUpdate === 'plan_removed') return { ...base, planId: update.planId, removed: true };
  if (update.sessionUpdate === 'tool_call') {
    return { ...base, title: update.title, status: update.status ?? 'pending', kind: update.kind ?? null, toolCallId: update.toolCallId };
  }
  if (update.sessionUpdate === 'tool_call_update') {
    return { ...base, title: update.title ?? null, status: update.status ?? null, toolCallId: update.toolCallId };
  }
  if (update.sessionUpdate === 'usage_update') return { ...base, usage: update.usage ?? update };
  if (update.sessionUpdate === 'current_mode_update') return { ...base, mode: update.currentModeId ?? update.modeId ?? null };
  if (update.sessionUpdate === 'config_option_update') return { ...base, configOptions: update.configOptions ?? [] };
  if (update.sessionUpdate === 'available_commands_update') return { ...base, commands: update.availableCommands ?? [] };
  return base;
}

// Read-only means "cannot change anything", not "cannot look at anything". Denying reads as well
// as writes left Copilot able to emit text and nothing else: every turn ended within seconds at its
// first tool call, so no requirement could ever be grounded in the code it is meant to describe.
// ACP names the kinds, so the policy evaluates them instead of ignoring them.
const READ_ONLY_TOOL_KINDS = new Set(['read', 'search', 'think']);

// The title is prose written by the agent and must never decide anything; only the declared kind
// does. An absent or unrecognised kind is denied, so a new tool kind fails closed.
function isReadOnlyToolCall(toolCall) {
  return READ_ONLY_TOOL_KINDS.has(toolCall?.kind);
}

// Copilot names its read-only mode 'Plan' and gives it an id ending in '#plan'. Both are checked
// because either alone has been enough to miss it on some CLI versions.
function isPlanModeDescriptor(mode) {
  return String(mode?.name ?? '').toLowerCase() === 'plan' || String(mode?.id ?? '').endsWith('#plan');
}

function allowPermission(params) {
  const option = params.options.find((candidate) => candidate.kind === 'allow_once')
    ?? params.options.find((candidate) => candidate.kind === 'allow_always');
  // With no allow option offered, falling back to reject keeps the failure closed.
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : rejectPermission(params);
}

function rejectPermission(params) {
  const option = params.options.find((candidate) => candidate.kind === 'reject_once')
    ?? params.options.find((candidate) => candidate.kind === 'reject_always');
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

export class CopilotPlanningBridge {
  constructor({ repository, emit, env = process.env, spawnImpl = spawn } = {}) {
    this.repository = path.resolve(repository);
    this.emit = emit ?? (() => {});
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.process = null;
    this.connection = null;
    this.session = null;
    this.running = false;
    this.closed = false;
    this.questionCounter = 0;
    this.pendingQuestions = new Map();
    this.permissionCounter = 0;
    this.pendingPermissions = new Map();
    this.availableModes = [];
    this.currentModeId = null;
    this.configOptions = [];
    this.model = null;
    this.availableModels = [];
    this.modelConfigId = null;
    this.modelSwitchSupported = false;
  }

  /** The modes this session advertises, with the active one marked. */
  modeState() {
    return {
      current: this.currentModeId,
      currentName: this.availableModes.find((mode) => mode.id === this.currentModeId)?.name ?? null,
      available: this.availableModes.map((mode) => ({
        id: mode.id,
        name: mode.name ?? mode.id,
        description: mode.description ?? null,
        readOnly: isPlanModeDescriptor(mode)
      })),
      switchSupported: this.availableModes.length > 1
    };
  }

  /**
   * Whether the active mode is the read-only one.
   *
   * This decides the permission policy, so it is derived from the session's own mode descriptors
   * rather than from a remembered flag: a mode change that this process did not initiate still
   * moves the gate.
   */
  inPlanMode() {
    const mode = this.availableModes.find((candidate) => candidate.id === this.currentModeId);
    return mode ? isPlanModeDescriptor(mode) : true;
  }

  applyConfigOptions(configOptions = [], fallback = this.model) {
    this.configOptions = configOptions;
    const configuration = modelConfiguration(configOptions, fallback);
    this.model = configuration.current;
    this.availableModels = configuration.available;
    this.modelConfigId = configuration.configId;
    this.modelSwitchSupported = configuration.switchSupported;
    return configuration;
  }

  requestInput(params) {
    if (params.mode !== 'form') {
      this.emit({
        type: 'question-unsupported',
        message: params.message,
        mode: params.mode,
        detail: 'Copilot Studio supports inline form questions only; URL and custom elicitation were cancelled.'
      });
      return Promise.resolve({ action: 'cancel' });
    }
    const questionId = `question-${++this.questionCounter}`;
    this.emit({
      type: 'question',
      questionId,
      message: params.message,
      schema: params.requestedSchema,
      toolCallId: params.toolCallId ?? null
    });
    return new Promise((resolve) => {
      this.pendingQuestions.set(questionId, { resolve, message: params.message });
    });
  }

  /**
   * Decide a tool-permission request against the active mode.
   *
   * Read-only kinds are always allowed — that is what makes the session useful, and it is why
   * inspecting the repository never interrupts anyone. Everything else depends on the mode:
   *
   *   Plan  — refused outright. Nothing Copilot does may change the repository, and artifacts
   *           reach Git only through the governed promotion fence.
   *   other — put to the operator, one request at a time. Switching modes is a decision to
   *           supervise Copilot, not a decision to stop looking; a blanket allow would make the
   *           mode switch a bigger grant than anyone asked for.
   */
  decidePermission(params) {
    const toolCall = params.toolCall;
    const title = toolCall?.title ?? 'Copilot tool request';
    const kind = toolCall?.kind ?? null;
    if (isReadOnlyToolCall(toolCall)) {
      this.emit({ type: 'permission-allowed', title, kind });
      return allowPermission(params);
    }
    if (this.inPlanMode()) {
      this.emit({
        type: 'permission-denied',
        title,
        kind,
        detail: `Plan mode is read-only: a '${kind ?? 'unknown'}' tool call cannot change the repository. Promotion is the only write path — or switch the session mode to review these requests yourself.`
      });
      return rejectPermission(params);
    }
    const requestId = `permission-${++this.permissionCounter}`;
    this.emit({
      type: 'permission-request',
      requestId,
      title,
      kind,
      locations: (toolCall?.locations ?? []).map((location) => location?.path).filter(Boolean),
      mode: this.modeState().currentName
    });
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, params, title, kind });
    });
  }

  answerPermission(requestId, allow) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`Copilot permission request '${requestId}' is no longer awaiting a decision.`);
    this.pendingPermissions.delete(requestId);
    pending.resolve(allow ? allowPermission(pending.params) : rejectPermission(pending.params));
    this.emit({
      type: allow ? 'permission-allowed' : 'permission-denied',
      requestId,
      title: pending.title,
      kind: pending.kind,
      detail: allow ? 'Allowed by the operator.' : 'Refused by the operator.'
    });
    return { requestId, allowed: Boolean(allow) };
  }

  /** Refuse anything still waiting. Called when the turn is cancelled or the process goes away. */
  cancelPendingPermissions() {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve(rejectPermission(pending.params));
      this.emit({ type: 'permission-denied', requestId, title: pending.title, kind: pending.kind, detail: 'The session ended before this request was answered.' });
    }
    this.pendingPermissions.clear();
  }

  answerQuestion(questionId, { action = 'accept', content = null } = {}) {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) throw new Error(`Copilot question '${questionId}' is no longer awaiting an answer.`);
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new Error(`Unsupported Copilot question action '${action}'.`);
    this.pendingQuestions.delete(questionId);
    pending.resolve(action === 'accept' ? { action, content: content ?? {} } : { action });
    this.emit({ type: 'question-answered', questionId, action });
    return { accepted: true, questionId, action };
  }

  cancelPendingQuestions() {
    for (const [questionId, pending] of this.pendingQuestions) {
      pending.resolve({ action: 'cancel' });
      this.emit({ type: 'question-answered', questionId, action: 'cancel' });
    }
    this.pendingQuestions.clear();
  }

  async start({ prompt, model = null } = {}) {
    const preflight = copilotPlanningPreflight({ env: this.env });
    if (!preflight.ready) throw new Error(preflight.message);
    const args = ['--acp', '--stdio', '--mode=plan', '--disable-builtin-mcps'];
    if (model) args.push('--model', model);
    this.process = this.spawnImpl(preflight.executable, args, {
      cwd: this.repository,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (text) => this.emit({ type: 'diagnostic', text: String(text) }));
    this.process.on('exit', (code, signal) => {
      this.closed = true;
      this.running = false;
      this.cancelPendingQuestions();
    this.cancelPendingPermissions();
      this.emit({ type: 'process-exit', code, signal });
    });
    const processError = new Promise((_, reject) => this.process.once('error', reject));
    const stream = acp.ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout));
    const client = acp.client({ name: 'singularity-flow-planning-studio' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.decidePermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.readRepositoryFile(ctx.params))
      .onRequest(acp.methods.client.elicitation.create, (ctx) => this.requestInput(ctx.params));
    this.connection = client.connect(stream);
    const initialized = await Promise.race([
      this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: false },
          session: { configOptions: {} },
          plan: {},
          elicitation: { form: {} }
        }
      }),
      processError
    ]);
    this.session = await this.connection.agent.buildSession(this.repository).start();
    const modelState = this.applyConfigOptions(this.session.configOptions ?? [], model);
    // Every advertised mode is kept so the operator can switch later; the session still *starts*
    // in Plan, because a session that begins able to write is one nobody chose.
    this.availableModes = this.session.modes?.availableModes ?? [];
    const planMode = this.availableModes.find(isPlanModeDescriptor);
    if (!planMode) throw new Error('Copilot ACP did not advertise native Plan mode.');
    await this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId: this.session.sessionId, modeId: planMode.id });
    this.currentModeId = planMode.id;
    const modeState = this.modeState();
    this.emit({
      type: 'ready',
      sessionId: this.session.sessionId,
      version: preflight.version,
      protocolVersion: initialized.protocolVersion,
      modes: { ...(this.session.modes ?? {}), currentModeId: planMode.id },
      mode: modeState.currentName,
      modeId: modeState.current,
      availableModes: modeState.available,
      modeSwitchSupported: modeState.switchSupported,
      model: modelState.current,
      models: modelState.available,
      modelSwitchSupported: modelState.switchSupported
    });
    if (prompt) void this.prompt(prompt).catch(() => {});
    return {
      sessionId: this.session.sessionId,
      version: preflight.version,
      protocolVersion: initialized.protocolVersion,
      mode: modeState.currentName ?? 'plan',
      modeId: modeState.current,
      availableModes: modeState.available,
      modeSwitchSupported: modeState.switchSupported,
      model: modelState.current,
      models: modelState.available,
      modelSwitchSupported: modelState.switchSupported
    };
  }

  /**
   * Switch the session's mode.
   *
   * Mid-turn is refused for the same reason a model change is: the agent is already acting under
   * the policy it was given, and moving the gate underneath it decides nothing honestly.
   */
  async setMode(modeId) {
    if (!this.session || this.closed) throw new Error('Copilot planning session is not active.');
    if (this.running) throw new Error('Wait for the current Copilot turn to finish before changing its mode.');
    const requested = String(modeId ?? '').trim();
    if (!requested) throw new Error('Choose a Copilot mode before applying the change.');
    const target = this.availableModes.find((mode) => mode.id === requested);
    if (!target) throw new Error(`Copilot did not advertise mode '${requested}' for this session.`);
    await this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId: this.session.sessionId, modeId: target.id });
    this.currentModeId = target.id;
    const state = this.modeState();
    this.emit({
      type: 'mode-changed',
      message: state.currentName === null ? `Copilot mode changed to ${target.id}.` : `Copilot mode changed to ${state.currentName}.`,
      mode: state.currentName,
      modeId: state.current,
      readOnly: this.inPlanMode(),
      availableModes: state.available,
      modeSwitchSupported: state.switchSupported
    });
    return { mode: state.currentName, modeId: state.current, readOnly: this.inPlanMode(), availableModes: state.available, modeSwitchSupported: state.switchSupported };
  }

  async setModel(model) {
    if (!this.session || this.closed) throw new Error('Copilot planning session is not active.');
    if (this.running) throw new Error('Wait for the current Copilot planning turn to finish before changing its model.');
    if (!this.modelConfigId) {
      throw new Error('This Copilot ACP version does not advertise live model switching. Stop the backend, choose a model, and start it again.');
    }
    const requested = String(model ?? '').trim();
    if (!requested) throw new Error('Choose a Copilot model before applying the change.');
    if (this.availableModels.length && !this.availableModels.some((candidate) => candidate.value === requested)) {
      throw new Error(`Copilot did not advertise model '${requested}' for this session.`);
    }
    const result = await this.connection.agent.setSessionConfigOption({
      sessionId: this.session.sessionId,
      configId: this.modelConfigId,
      value: requested
    });
    const next = this.applyConfigOptions(result.configOptions ?? [], requested);
    this.emit({
      type: 'model-changed',
      message: `Copilot model changed to ${next.current}.`,
      model: next.current,
      models: next.available,
      modelSwitchSupported: next.switchSupported
    });
    return {
      model: next.current,
      models: next.available,
      modelSwitchSupported: next.switchSupported
    };
  }

  // Containment is decided on the REAL path, after symlinks resolve, so a link inside the repository
  // cannot be used to read ~/.ssh or anything else outside it. The repository root is resolved the
  // same way, because on macOS /tmp and /var are themselves symlinks and comparing unresolved paths
  // would reject legitimate reads while a resolved attacker path slipped through.
  async readRepositoryFile({ path: requested, line = null, limit = null }) {
    if (!requested || !path.isAbsolute(requested)) throw new Error('Copilot may only read absolute paths inside the repository.');
    const root = await realpath(this.repository);
    const resolved = await realpath(requested).catch(() => null);
    if (!resolved) throw new Error(`File not found: ${requested}`);
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      this.emit({ type: 'permission-denied', title: `Read outside the repository: ${requested}`, kind: 'read' });
      throw new Error('Copilot may only read files inside the open repository.');
    }
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error(`Not a readable file: ${requested}`);
    if (info.size > MAX_READ_FILE_BYTES) throw new Error(`File is too large to read: ${requested}`);
    const text = await readFile(resolved, 'utf8');
    if (line == null && limit == null) return { content: text };
    // ACP line numbers are 1-based.
    const lines = text.split('\n');
    const start = Math.max(0, (line ?? 1) - 1);
    return { content: lines.slice(start, limit == null ? undefined : start + limit).join('\n') };
  }

  async prompt(text) {
    if (!this.session || this.closed) throw new Error('Copilot planning session is not active.');
    if (this.running) throw new Error('Wait for the current Copilot planning turn to finish.');
    if (!text?.trim()) throw new Error('Planning follow-up cannot be empty.');
    this.running = true;
    this.emit({ type: 'turn-started', text });
    try {
      void this.session.prompt(text);
      for (;;) {
        const message = await this.session.nextUpdate();
        if (message.kind === 'stop') {
          this.emit({
            type: 'turn-complete',
            stopReason: message.stopReason,
            usage: message.response.usage ?? null,
            meta: message.response._meta ?? null
          });
          return message.response;
        }
        const update = await normalizePlanningUpdate(message.update, { repository: this.repository });
        if (update.type === 'config_option_update') {
          const next = this.applyConfigOptions(update.configOptions);
          this.emit({
            ...update,
            model: next.current,
            models: next.available,
            modelSwitchSupported: next.switchSupported
          });
        } else if (update.type === 'current_mode_update') {
          // Copilot can move its own mode. The permission gate reads the session's mode, so this
          // has to be recorded or the gate would answer for a mode the agent has already left.
          this.currentModeId = update.mode ?? this.currentModeId;
          const state = this.modeState();
          this.emit({ ...update, mode: state.currentName, modeId: state.current, readOnly: this.inPlanMode(), availableModes: state.available });
        } else {
          this.emit(update);
        }
      }
    } catch (error) {
      this.emit({ type: 'error', message: error?.message ?? String(error) });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async cancelCurrentTurn() {
    this.cancelPendingQuestions();
    this.cancelPendingPermissions();
    if (!this.session || this.closed || !this.running) return { cancelled: false };
    try {
      await this.connection?.agent.request(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId });
      return { cancelled: true };
    } catch {
      return { cancelled: false };
    }
  }

  async stop() {
    const warnings = [];
    this.cancelPendingQuestions();
    this.cancelPendingPermissions();
    if (this.session) {
      try { await this.cancelCurrentTurn(); } catch (error) { warnings.push(`turn cancellation failed: ${error.message}`); }
      try { this.session.dispose(); } catch (error) { warnings.push(`session disposal failed: ${error.message}`); }
    }
    try { this.connection?.close(); } catch (error) { warnings.push(`ACP connection close failed: ${error.message}`); }
    try {
      if (this.process && !this.process.killed) this.process.kill();
    } catch (error) {
      warnings.push(`Copilot process termination failed: ${error.message}`);
    }
    this.closed = true;
    this.running = false;
    this.session = null;
    this.connection = null;
    for (const warning of warnings) this.emit({ type: 'diagnostic', text: `Copilot cleanup warning: ${warning}` });
    return { stopped: true, warnings };
  }
}
