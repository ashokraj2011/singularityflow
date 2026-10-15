/** Model-free discovery for the native Copilot authoring handoff. No implicit remote/root search. */
import { SingularityFlowError } from '../util.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';

export async function run(_argv, { positionals, options }) {
  const action = positionals[2];
  if (action === 'attachments') {
    if (positionals.length !== 3 || Object.entries(options).some(([key,value]) => !['file', 'folder', 'expected-source', 'id', 'json'].includes(key)
      || key === 'json' && value !== true || ['id','expected-source'].includes(key) && typeof value !== 'string')) throw new SingularityFlowError('Use workflow intent attachments --file FILE|--folder DIRECTORY [--expected-source SHA256] [--id ID] --json.');
    const { optionStrings } = await import('../util.mjs');
    if (options.id && !options['expected-source']) throw new SingularityFlowError('Exact attachment retrieval requires --expected-source from the capture.');
    const files = optionStrings(options, 'file'), folders = optionStrings(options, 'folder');
    const result = await (await import('../workflow-intent-attachments.mjs')).inspectWorkflowAttachments({ files, folders, expectedSource: options['expected-source'], id: options.id });
    result.readGuidance = safeCommandGuidance({ executable: 'singularity-flow', argv: ['workflow', 'intent', 'attachments',
      ...files.flatMap(file => ['--file', file]), ...folders.flatMap(folder => ['--folder', folder]), '--expected-source', result.sourceSha256, '--id', '<CAPTURE-ID>', '--json'] });
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    for (const item of result.items) console.log(`${item.name}: ${item.available ? item.classification.kind : 'withheld'} (${item.classification.confidence})`);
    return console.log(result.meaning);
  }
  if (!['catalog', 'show', 'example', 'preflight'].includes(action) || positionals.length !== (action === 'show' ? 5 : 3)) throw new SingularityFlowError('Use workflow intent catalog [--kind KIND] [--query TEXT], workflow intent show KIND ID --expected-source SHA256, workflow intent example, or workflow intent preflight. All accept --source approved|installed and --json.', { code: 'WORKFLOW_INTENT_USAGE' });
  const allowed = new Set(['source', 'expected-source', 'json', ...(action === 'catalog' ? ['kind', 'query', 'tag', 'cursor', 'limit'] : [])]);
  for (const [key, value] of Object.entries(options)) if (!allowed.has(key) || key === 'json' && value !== true || key !== 'json' && typeof value !== 'string') throw new SingularityFlowError('Unsupported, repeated or malformed workflow intent option.', { code: 'WORKFLOW_INTENT_USAGE' });
  if (action === 'show' && !options['expected-source'] || options.cursor && Number(options.cursor) > 0 && !options['expected-source']) throw new SingularityFlowError('Exact retrieval and later pages require --expected-source from the catalog you reviewed.', { code: 'WORKFLOW_INTENT_SOURCE_REQUIRED' });
  const source = options.source ?? 'approved';
  const root = source === 'installed' ? null : (await import('../git.mjs')).repoRoot();
  const api = await import('../workflow-intent-catalog.mjs');
  const result = await api.withWorkflowIntentCatalog(root, { source, expectedSource: options['expected-source'] }, async catalog => action === 'preflight'
    ? { schemaVersion: 1, resultType: 'workflow-intent-preflight', sourceSha256: catalog.sourceSha256,
      capabilities: await (await import('../workflow-intent-capabilities.mjs')).workflowIntentCapabilities(),
      catalog: api.queryWorkflowIntentCatalog(catalog, { limit: 8 }),
      approvalAuthorities: catalog.entries.filter(item => item.kind === 'approval-authority').map(({ id, label }) => ({ id, label })),
      permissionEffect: 'none', approvalRecorded: false }
    : action === 'example' ? api.workflowIntentExample(catalog) : action === 'show'
    ? { schemaVersion: 1, resultType: 'workflow-intent-asset', source: catalog.source, sourceSha256: catalog.sourceSha256,
      asset: api.workflowIntentAssetView(catalog, positionals[3], positionals[4]), permissionEffect: 'none', meaning: 'Candidate guidance only; no skill was executed or attached, and no approval or runtime authority was granted.' }
    : api.queryWorkflowIntentCatalog(catalog, { kind: options.kind, query: options.query, tags: options.tag ? [options.tag] : [], cursor: Number(options.cursor ?? 0), limit: Number(options.limit ?? 24) }));
  const selected = action === 'catalog' ? result.entries.find(item => item.available) : null;
  const next = selected ? ['workflow', 'intent', 'show', selected.kind, selected.id,
    '--source', source, '--expected-source', result.sourceSha256, '--json'] : ['workflow', 'markup', 'compile', '<FILE>', '--json'];
  result.commandGuidance = safeCommandGuidance({ executable: 'singularity-flow', argv: next });
  if (options.json) return console.log(JSON.stringify(result, null, 2));
  if (action === 'preflight') {
    console.log(`Designer protocol ${result.capabilities.protocol}; compiler ${result.capabilities.cli.compile ? 'available' : 'unavailable'}; engine ${result.capabilities.engine.sha256}.`);
    console.log(`${result.approvalAuthorities.length} configured approval groups. No membership or approval was granted.`);
    return;
  }
  console.log(`Intent catalog ${result.sourceSha256}; source ${source}. Discovery does not grant authority.`);
  if (action === 'example') console.log(result.source);
  else if (result.asset) console.log(JSON.stringify(result.asset, null, 2));
  else {
    for (const item of result.entries) console.log(`${item.kind} ${item.id} — ${item.description}\n  ${item.tags.join(', ')}${item.available ? '' : ' (unavailable)'}`);
    console.log(`${result.total} matches; next cursor ${result.nextCursor ?? 'none'}.`);
  }
  if (result.commandGuidance) {
    console.log(`Copilot: ${result.commandGuidance.copilotCommand ?? 'no verified equivalent'}`);
    console.log(`Shell: ${result.commandGuidance.command}`);
    console.log(`VS Code (model-free): ${result.commandGuidance.modelFreeCommand ?? 'not available for this action'}`);
  }
}
