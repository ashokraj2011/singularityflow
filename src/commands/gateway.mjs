/**
 * `sflow gateway` — the five-tool gateway as a local process. `[INT:IFC-062]` `[INT:REQ-031]` `[INT:REQ-141]`
 *
 * - `serve --transport stdio`: an MCP server over stdin/stdout for Copilot CLI and other approved
 *   hosts. Same tools, same kernel, same results as the editor `[INT:CON-020]`; stdout carries only
 *   protocol messages, and diagnostics go to stderr.
 * - `tools [--json]`: the five serialized schemas and their measured size, for the release report.
 * - `events [--json]`: recent gateway events on this machine, filtered.
 */
import { randomUUID } from 'node:crypto';

import { optionBoolean, optionNumber, optionString, SingularityFlowError } from '../util.mjs';

async function gatewayHost(options, capabilities) {
  const [{ createHostGateway }, { gatewayPlanners }, { cliMutationExecutors }, { auditedKernel }, { homeRepository }] = await Promise.all([
    import('../gateway/host.mjs'), import('../gateway/planners/index.mjs'), import('../gateway/planners/executors.mjs'),
    import('../gateway/audit.mjs'), import('../gateway/home-context.mjs')
  ]);
  const selection = await homeRepository(optionString(options, 'workspace'), { allowMissing: true }).catch(() => null);
  let root = selection?.root ?? null;
  if (!root) {
    const { repoRoot } = await import('../git.mjs');
    try { root = repoRoot(); } catch { root = null; }
  }
  const context = selection?.context ?? null;
  const { kernel } = createHostGateway({
    root,
    hostSessionId: `mcp_${randomUUID()}`,
    workspaceId: context?.workspaceId ?? null,
    planners: gatewayPlanners(),
    // Plans are carried out only when the client can confirm in its own UI `[INT:CON-133]`.
    mutationExecutors: cliMutationExecutors(),
    readOnly: capabilities.confirmationChannel !== 'native',
    hostCapabilities: capabilities,
    plannerContext: {
      workspace: context?.workspaceId ? { id: context.workspaceId, name: context.workspaceName } : null,
      repositoryId: selection?.selected?.id ?? null,
      storyId: context?.storyId ?? null,
      workId: context?.storyId ?? null,
      workKind: context?.storyId ? 'story' : null
    }
  });
  return auditedKernel(kernel, { host: 'mcp', modelSelected: true });
}

export async function run(_argv, { positionals = [], options = {} } = {}) {
  const action = positionals[1] ?? 'tools';
  if (action === 'serve') {
    const transport = optionString(options, 'transport', 'stdio');
    if (transport !== 'stdio') {
      throw new SingularityFlowError(`The gateway serves over stdio only, not '${transport}'.`, { code: 'GATEWAY_TRANSPORT_UNSUPPORTED' });
    }
    const [{ serveMcp }, { VERSION }] = await Promise.all([import('../gateway/mcp-stdio.mjs'), import('../version.mjs')]);
    await serveMcp({
      input: process.stdin, output: process.stdout,
      serverInfo: { name: 'singularity-flow', version: VERSION },
      createKernel: (capabilities) => gatewayHost(options, capabilities),
      log: (line) => process.stderr.write(`${line}\n`)
    });
    return {};
  }
  if (action === 'tools') {
    const { SFLOW_TOOLS, toolSchemaMeasurement } = await import('../gateway/tools.mjs');
    const report = { tools: SFLOW_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })), measurement: toolSchemaMeasurement() };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
    else {
      for (const tool of report.tools) console.log(`${tool.name}  ${tool.description}`);
      const m = report.measurement;
      console.log(`\n${m.tools} tools · ${m.bytes} bytes (${m.serialization}) · ${m.tokens} tokens (${m.tokenizer}) · budget ${m.budget}`);
    }
    return {};
  }
  if (action === 'events') {
    const { readGatewayEvents } = await import('../gateway/audit.mjs');
    const modelRouting = optionString(options, 'model-routing');
    const events = await readGatewayEvents({
      subject: optionString(options, 'subject'), host: optionString(options, 'host'), operation: optionString(options, 'operation'),
      outcome: optionString(options, 'outcome'), reason: optionString(options, 'reason'),
      modelSelected: modelRouting == null ? null : modelRouting === 'yes', correlationId: optionString(options, 'correlation'),
      limit: optionNumber(options, 'limit') ?? 200
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify({ events }, null, 2));
    else if (!events.length) console.log('No gateway events match.');
    else for (const event of events) console.log(`${event.at}  ${event.host}  ${event.tool}  ${event.operation ?? '-'}  ${event.outcome ?? '-'}${event.reason ? ` (${event.reason})` : ''}  ${event.correlationId}`);
    return {};
  }
  if (action === 'session') return guideSession(positionals[2] ?? 'show', options);
  throw new SingularityFlowError(`'gateway ${action}' is not a gateway action. Use serve, tools, events or session.`, {
    code: 'GATEWAY_ACTION_UNKNOWN', details: { nextAction: 'singularity-flow gateway tools' }
  });
}

/**
 * `gateway session [show|reset]`: the guide session for this person and workspace. `[INT:CON-100]` `[INT:REQ-101]`
 *
 * `show` prints what the conversation remembers — never anything that can act. `reset` forgets it
 * and nothing else: work, pending plans, the selected workspace and every lifecycle record stay
 * exactly as they were, which is why an agent turn may run it.
 */
async function guideSession(subaction, options) {
  if (!['show', 'reset'].includes(subaction)) {
    throw new SingularityFlowError(`'gateway session ${subaction}' is not a session action. Use show or reset.`, {
      code: 'GATEWAY_SESSION_ACTION_UNKNOWN', details: { nextAction: 'singularity-flow gateway session show' }
    });
  }
  const [{ guideSessionScope, readGuideSession, resetGuideSession }, { homeRepository }, { repoRoot }, { bindingActorId }] = await Promise.all([
    import('../gateway/local-store.mjs'), import('../gateway/home-context.mjs'), import('../git.mjs'), import('../gateway/host.mjs')
  ]);
  const selection = await homeRepository(optionString(options, 'workspace'), { allowMissing: true }).catch(() => null);
  let root = selection?.root ?? null;
  if (!root) { try { root = repoRoot(); } catch { root = null; } }
  // The same actor the editor's host binding names, so both surfaces read and reset one entry.
  const owner = {
    actorId: bindingActorId(root),
    scope: guideSessionScope({ workspaceId: selection?.context?.workspaceId ?? null, root })
  };
  const json = optionBoolean(options, 'json');
  if (subaction === 'show') {
    const session = await readGuideSession(owner);
    if (json) console.log(JSON.stringify({ scope: owner.scope, session }, null, 2));
    else if (!session) console.log('No conversational context is remembered for this workspace.');
    else {
      console.log(`Conversational context for ${owner.scope} (expires ${session.expiresAt}):`);
      console.log(`  subject: ${session.subject ? `${session.subject.kind}:${session.subject.id}` : 'none'}`);
      console.log(`  on screen: ${session.visibleSubjects.map((entry) => entry.id).join(', ') || 'nothing'}`);
      console.log(`  last menu: ${session.lastMenu.join(', ') || 'none'}`);
      console.log('  None of this can approve, confirm or carry out anything.');
    }
    return {};
  }
  const { cleared } = await resetGuideSession(owner);
  const preserved = ['work', 'pending plans', 'selected workspace', 'lifecycle records'];
  if (json) console.log(JSON.stringify({ reset: true, cleared, scope: owner.scope, preserved }, null, 2));
  else console.log(`${cleared ? 'Conversational context was reset' : 'There was no conversational context to reset'}. `
    + 'Your work, pending plans and selected workspace are unchanged.');
  return {};
}
