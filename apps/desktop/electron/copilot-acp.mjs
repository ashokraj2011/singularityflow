import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';

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
      message: 'GitHub Copilot CLI was not found. Install it and authenticate before starting Planning Studio.'
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
        ? 'This Copilot CLI does not expose the ACP server required by Planning Studio. Update Copilot CLI.'
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

export async function normalizePlanningUpdate(update, { repository } = {}) {
  const base = { type: update.sessionUpdate, raw: update };
  if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(update.sessionUpdate)) {
    return { ...base, text: textContent(update.content), messageId: update.messageId ?? null };
  }
  if (update.sessionUpdate === 'plan') return { ...base, plan: planEntries(update.entries), entries: update.entries };
  if (update.sessionUpdate === 'plan_update') {
    if (update.plan.type === 'markdown') return { ...base, plan: update.plan.content, planId: update.plan.planId };
    if (update.plan.type === 'items') return { ...base, plan: planEntries(update.plan.entries), entries: update.plan.entries, planId: update.plan.planId };
    if (update.plan.type === 'file' && update.plan.uri?.startsWith('file:')) {
      const absolute = fileURLToPath(update.plan.uri);
      const relative = path.relative(repository, absolute);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        return { ...base, plan: await readFile(absolute, 'utf8'), planPath: absolute, planId: update.plan.planId };
      }
      return { ...base, warning: 'Copilot returned a plan file outside the open repository; it was not loaded.', planPath: absolute, planId: update.plan.planId };
    }
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
  if (update.sessionUpdate === 'available_commands_update') return { ...base, commands: update.availableCommands ?? [] };
  return base;
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
      this.emit({ type: 'process-exit', code, signal });
    });
    const processError = new Promise((_, reject) => this.process.once('error', reject));
    const stream = acp.ndJsonStream(Writable.toWeb(this.process.stdin), Readable.toWeb(this.process.stdout));
    const client = acp.client({ name: 'singularity-flow-planning-studio' })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        this.emit({
          type: 'permission-denied',
          title: ctx.params.toolCall?.title ?? 'Copilot tool request',
          detail: 'Planning Studio runs in read-only Plan mode and denied this permission request.'
        });
        return rejectPermission(ctx.params);
      });
    this.connection = client.connect(stream);
    const initialized = await Promise.race([
      this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          plan: {}
        }
      }),
      processError
    ]);
    this.session = await this.connection.agent.buildSession(this.repository).start();
    const planMode = this.session.modes?.availableModes?.find((mode) => mode.name?.toLowerCase() === 'plan')
      ?? this.session.modes?.availableModes?.find((mode) => String(mode.id).endsWith('#plan'));
    if (!planMode) throw new Error('Copilot ACP did not advertise native Plan mode.');
    await this.connection.agent.request(acp.methods.agent.session.setMode, { sessionId: this.session.sessionId, modeId: planMode.id });
    this.emit({
      type: 'ready',
      sessionId: this.session.sessionId,
      version: preflight.version,
      protocolVersion: initialized.protocolVersion,
      modes: { ...(this.session.modes ?? {}), currentModeId: planMode.id }
    });
    if (prompt) void this.prompt(prompt).catch(() => {});
    return {
      sessionId: this.session.sessionId,
      version: preflight.version,
      protocolVersion: initialized.protocolVersion,
      mode: 'plan'
    };
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
        this.emit(await normalizePlanningUpdate(message.update, { repository: this.repository }));
      }
    } catch (error) {
      this.emit({ type: 'error', message: error?.message ?? String(error) });
      throw error;
    } finally {
      this.running = false;
    }
  }

  async stop() {
    if (this.session) {
      try {
        await this.connection?.agent.request(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId });
      } catch {
        // The process may already have ended.
      }
      this.session.dispose();
    }
    this.connection?.close();
    if (this.process && !this.process.killed) this.process.kill();
    this.closed = true;
    return { stopped: true };
  }
}
