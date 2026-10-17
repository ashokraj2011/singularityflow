/** Agent catalog reads are independent of code generation and mutation handlers. */
import { repoRoot } from '../git.mjs';
import { discoverAgents, agentMappingStatus, agentStatus } from '../agents.mjs';
import { SingularityFlowError, optionBoolean, table } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  const action = positionals[1];
  if (!['list', 'mappings', 'status'].includes(action)) return (await import('./legacy.mjs')).run(argv);
  const root = repoRoot();
  const json = optionBoolean(options, 'json');
  if (action === 'list') {
    const agents = await discoverAgents(root);
    const notice = await import('../configuration-drafts.mjs').then(({ draftNotice }) => draftNotice(root, 'agent'));
    const rows = agents.map(agent => ({ id: agent.id, label: agent.label ?? agent.id, scope: agent.scope,
      source: agent.source, dependencies: agent.dependencies.length }));
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'agent-catalog', agents: rows, drafts: notice.entries }, null, 2));
    return console.log([rows.length ? table(rows, [
      { key: 'id', label: 'AGENT' }, { key: 'scope', label: 'SCOPE' },
      { key: 'source', label: 'SOURCE' }, { key: 'dependencies', label: 'REMOTE' }
    ]) : 'No repository or bundled agents found.', ...notice.lines].join('\n'));
  }
  if (action === 'mappings') {
    const result = await agentMappingStatus(root);
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(`Copilot agent mappings: ${result.path}${result.exists ? '' : ' (not created; same-name fallback only)'}`);
    return console.log(result.rows.length ? table(result.rows, [
      { key: 'copilotAgent', label: 'COPILOT AGENT' }, { key: 'agentId', label: 'FLOW AGENT' },
      { key: 'source', label: 'RESOLUTION' }
    ]) : 'No Copilot agents or Singularity Flow agents were discovered.');
  }
  const requested = positionals[2] ?? null;
  const rows = await agentStatus(root, requested);
  if (requested && !rows.length) throw new SingularityFlowError(`Unknown agent '${requested}'.`);
  if (json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No repository or bundled agents found.');
  console.log(table(rows.map(entry => ({ id: entry.id, scope: entry.scope, status: entry.status,
    source: entry.source, resources: entry.dependencies.length })), [
    { key: 'id', label: 'AGENT' }, { key: 'scope', label: 'SCOPE' }, { key: 'status', label: 'STATUS' },
    { key: 'resources', label: 'REMOTE' }, { key: 'source', label: 'SOURCE' }
  ]));
  for (const entry of rows) for (const dependency of entry.dependencies) {
    console.log(`  ${entry.id}/${dependency.id}\t${dependency.type}\t${dependency.status}\t${dependency.sha256?.slice(0, 12) ?? ''}`);
  }
}
